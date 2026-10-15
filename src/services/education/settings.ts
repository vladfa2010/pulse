/**
 * =============================================================================
 * PULSE — LMS «Образование»: рантайм-настройки (ТЗ-172)
 * =============================================================================
 *
 * Key-value таблица `_education_settings` (паттерн radioSettings.ts): значения
 * в БД, а не в env — меняются из админки без редеплоя и переживают рестарт.
 * Чтение с in-memory кэшем 30 с (RANK дёргает настройку на каждый прогон
 * мэтчинга — без кэша лишний SQL на каждую новость).
 *
 * Ключи:
 *   match_llm_enabled ('true' по умолчанию) — выключатель LLM-ранкера
 *   мэтчинга курсов↔новости. Выключает ТОЛЬКО этап RANK: RECALL (теги +
 *   эмбеддинги), ретроскан и cron-страховка продолжают работать — suggestions
 *   приходят по тег-матчу со score=NULL (fail-closed путь llmRankBatch).
 *   Мастер-флаг EDUCATION_MATCH_ENABLED (env) выключен — мэтчинг мёртв
 *   целиком, это настройка значения не имеет.
 *
 * Таблица создаётся лениво при первом обращении (CREATE IF NOT EXISTS —
 * дёшево в PG, отдельная точка вызова миграции не нужна).
 */

import { query } from '../../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

const CACHE_TTL_MS = 30_000;
let cache: { value: boolean; at: number } | null = null;

function invalidateCache(): void {
  cache = null;
}

async function ensureTable(): Promise<void> {
  // DDL идентичен в обоих диалектах (как у _radio_settings)
  await query(`CREATE TABLE IF NOT EXISTS _education_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
}

async function readDbValue(): Promise<boolean> {
  await ensureTable();
  const r = await query(`SELECT value FROM _education_settings WHERE key = 'match_llm_enabled'`);
  if (r.rows.length === 0) {
    // Сид дефолта при первом обращении; идемпотентен (INSERT по PK)
    if (USE_SQLITE) {
      await query(`INSERT OR IGNORE INTO _education_settings (key, value) VALUES (?, ?)`, ['match_llm_enabled', 'true']);
    } else {
      await query(
        `INSERT INTO _education_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        ['match_llm_enabled', 'true'],
      );
    }
    return true;
  }
  return String(r.rows[0].value) === 'true';
}

/** Эффективное значение выключателя LLM-ранкера (БД + дефолт true), кэш 30 с. */
export async function isMatchLlmEnabled(): Promise<boolean> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  const value = await readDbValue();
  cache = { value, at: Date.now() };
  return value;
}

/** Upsert нового значения + сброс кэша (следующее чтение — из БД). */
export async function setMatchLlmEnabled(value: boolean): Promise<void> {
  await ensureTable();
  const serialized = String(value);
  if (USE_SQLITE) {
    await query(`INSERT OR REPLACE INTO _education_settings (key, value) VALUES (?, ?)`, ['match_llm_enabled', serialized]);
  } else {
    await query(
      `INSERT INTO _education_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      ['match_llm_enabled', serialized],
    );
  }
  invalidateCache();
}
