/**
 * =============================================================================
 * PULSE — Сервис саммари бакетов «Пока вас не было» (ТЗ-218)
 * =============================================================================
 *
 * Единая точка входа для роута GET /api/news (ленивый fallback) и cron'а
 * (прегенерация на границах). Источник истины — таблица bucket_summaries,
 * память (Map) — read-through прослойка, переживает рестарты только БД.
 *
 * Отклонение от ТЗ-218 (согласовано при ревью): ленивый путь НЕ блокирует
 * роут. При промахе кэша возвращаем null немедленно (фронт показывает
 * буллеты из top_news) и запускаем фоновую генерацию; следующий refetch
 * карусели (2 мин) подхватит готовое саммари. Так убрано противоречие
 * «блокирующий 30 с» vs «без блокирующего спиннера».
 *
 * Ключ кэша: 'bucket' — sha1(sorted tagIds|range_start|range_end); 'older' —
 * sha1(sorted tagIds|'older'|MSK-дата генерации) — окно плавает (now-24h),
 * ключ от плавающего окна был бы уникальным на каждый запрос и дёргал бы LLM
 * на каждый refetch (2 мин у UnreadNewsCarousel).
 *
 * top_news для 'older' НЕ кэшируется — хвост стареет в плавающее окно после
 * генерации; роут считает его живым запросом. Сервис отдаёт summary/model/
 * generated_at; top_news из БД корректен только для 'bucket'.
 */

import { createHash } from 'crypto';
import axios from 'axios';
import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const KIMI_API_KEY = process.env.KIMI_API_KEY || '';
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6'; // конвенция проекта (cron.ts, tagManager.ts, match.ts)
const LLM_TIMEOUT_MS = 30_000;
const TOP_N_PROMPT = 30;

const BUCKET_LABEL: Record<string, string> = {
  night: 'за ночь (00:00–06:00)',
  morning: 'за утро (06:00–12:00)',
  day: 'за день (12:00–18:00)',
  evening: 'за вечер (18:00–24:00)',
};

export interface BucketSummaryResult {
  summary: string;
  generated_at: string;
  model: string;
}

// in-memory read-through (паттерн summaryCache, src/routes/user.ts)
const memCache = new Map<string, { result: BucketSummaryResult; expiresAt: number }>();
const inflight = new Map<string, Promise<void>>();
const MEM_TTL_BUCKET_MS = 24 * 3600 * 1000;
const MEM_TTL_OLDER_MS = 60 * 60 * 1000;

/** sha1 от сортированного набора тегов + квантованных границ ключа. */
export function bucketTagsHash(
  tagIds: string[],
  variant: 'bucket' | 'older',
  rangeStart: Date,
  rangeEnd: Date,
  mskDate: string
): string {
  const sorted = [...tagIds].sort().join('|');
  const basis =
    variant === 'bucket'
      ? `${sorted}|${rangeStart.toISOString()}|${rangeEnd.toISOString()}`
      : `${sorted}|older|${mskDate}`;
  return createHash('sha1').update(basis).digest('hex');
}

function validBucketRow(row: any): boolean {
  if (!row) return false;
  if (row.variant === 'older') {
    return Date.now() - new Date(row.generated_at).getTime() < MEM_TTL_BUCKET_MS;
  }
  return new Date(row.range_end).getTime() + 24 * 3600 * 1000 > Date.now();
}

function memGet(key: string, variant: string): BucketSummaryResult | null {
  const hit = memCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    memCache.delete(key);
    return null;
  }
  return hit.result;
}

function memSet(key: string, result: BucketSummaryResult, variant: string): void {
  if (memCache.size > 2000) memCache.clear(); // защита от раздувания
  memCache.set(key, {
    result,
    expiresAt: Date.now() + (variant === 'older' ? MEM_TTL_OLDER_MS : MEM_TTL_BUCKET_MS),
  });
}

async function dbGet(userId: string, key: string, variant: string): Promise<BucketSummaryResult | null> {
  const res = await query(
    `SELECT summary, generated_at, model FROM bucket_summaries WHERE user_id = $1 AND tags_hash = $2`,
    [userId, key]
  );
  const row = res.rows[0];
  if (!validBucketRow(row)) return null;
  const result: BucketSummaryResult = {
    summary: row.summary,
    generated_at: new Date(row.generated_at).toISOString(),
    model: row.model,
  };
  memSet(key, result, variant);
  return result;
}

/**
 * Топ-30 новостей окна для промпта: те же условия тегов/окна, что и count.
 * Условие тегов — PG `&&` / SQLite LIKE-цепочка (зеркалим news.ts).
 */
async function selectTopNewsForPrompt(
  tagIds: string[],
  rangeStart: Date | null,
  rangeEnd: Date
): Promise<Array<{ id: string; slug: string; title: string; source: string; source_count: number }>> {
  const tagConds: string[] = [];
  const params: unknown[] = [];
  const ph = () => (USE_SQLITE ? '?' : `$${params.length + 1}`);
  if (USE_SQLITE) {
    for (const t of tagIds) {
      tagConds.push(`matched_tags LIKE ${ph()}`);
      params.push(`%"${t}"%`);
    }
  } else {
    tagConds.push(`matched_tags && ${ph()}::text[]`);
    params.push(tagIds);
  }
  // (start, end] — новость ровно на границе принадлежит предыдущему бакету
  const timeConds: string[] = [];
  if (rangeStart) {
    timeConds.push(USE_SQLITE ? `published_at > ?` : `published_at > ${ph()}`);
    params.push(USE_SQLITE ? rangeStart.toISOString().replace('T', ' ').slice(0, 19) : rangeStart.toISOString());
  }
  timeConds.push(USE_SQLITE ? `published_at <= ?` : `published_at <= ${ph()}`);
  params.push(USE_SQLITE ? rangeEnd.toISOString().replace('T', ' ').slice(0, 19) : rangeEnd.toISOString());
  const nullsLast = USE_SQLITE ? '' : ' NULLS LAST';
  // условия тегов соединяются OR (overlap — как PG && и зеркало newsBuckets);
  // AND здесь дал бы пустую выборку почти всегда
  const res = await query(
    `SELECT id, slug, COALESCE(title_ru, title_original) AS title, source, source_count
     FROM news
     WHERE (${tagConds.join(' OR ')}) AND ${timeConds.join(' AND ')}
     ORDER BY source_count DESC, sentiment_score DESC${nullsLast}
     LIMIT ${TOP_N_PROMPT}`,
    params
  );
  return res.rows;
}

function buildPrompt(variant: 'bucket' | 'older', bucketKeyName: string | null, articles: Array<{ title: string; source: string }>): string {
  const windowText = variant === 'bucket' && bucketKeyName
    ? BUCKET_LABEL[bucketKeyName] || 'за период'
    : 'за прошедшие дни';
  const lines = articles
    .slice(0, 20)
    .map((a, i) => `${i + 1}. «${a.title}»${a.source ? ` (${a.source})` : ''}`)
    .join('\n');
  const grouping = variant === 'older'
    ? '\nСгруппируй текст по дням: начни абзацы с «Понедельник:», «Вторник:» и т.д. (только дни, за которые есть события).'
    : '';
  return (
    `Ты — инвестиционный аналитик PULSE. Ниже заголовки новостей пользователя ${windowText}. ` +
    `Напиши краткое саммари на русском: 80–150 слов, плавный текст без markdown-заголовков и списков, ` +
    `только самое важное для инвестора. Не выдумывай фактов, опирайся только на заголовки.${grouping}\n\n${lines}`
  );
}

async function callLlm(prompt: string): Promise<string | null> {
  if (!KIMI_API_KEY) {
    console.log('[BucketSummary] no LLM key');
    return null;
  }
  try {
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        // ТЗ-218: kimi-k2.6 (reasoning) принимает ТОЛЬКО temperature 0.6 —
        // иначе 400 "invalid temperature" (проверено на проде)
        temperature: KIMI_MODEL.startsWith('kimi-k2.6') ? 0.6 : KIMI_MODEL.startsWith('kimi-k') ? 0.3 : 0.1,
        max_tokens: 500,
        thinking: KIMI_MODEL.startsWith('kimi-k') ? { type: 'disabled' } : undefined,
      },
      {
        headers: { Authorization: `Bearer ${KIMI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: LLM_TIMEOUT_MS,
      }
    );
    return response.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (err: any) {
    console.warn(`[BucketSummary] LLM-ошибка: ${err.message?.slice(0, 120)}`);
    return null;
  }
}

/**
 * Генерация + запись в БД. Вызывается из фонового lazy-пути и cron'а.
 * Для 'bucket' в БД пишем top_news (набор фиксирован); для 'older' — '[]'
 * (top_news считается живым запросом роутом).
 */
async function generateAndStore(
  userId: string,
  tagIds: string[],
  tagsHash: string,
  rangeStart: Date | null,
  rangeEnd: Date,
  variant: 'bucket' | 'older',
  bucketKeyName: string | null,
  mskDate: string
): Promise<void> {
  const articles = await selectTopNewsForPrompt(tagIds, rangeStart, rangeEnd);
  if (articles.length === 0) return;
  const summary = await callLlm(buildPrompt(variant, bucketKeyName, articles));
  if (!summary) return;

  const topNews = variant === 'bucket'
    ? JSON.stringify(articles.slice(0, 4).map((a) => ({ id: a.id, title: a.title, source: a.source })))
    : '[]';
  const rs = (rangeStart || new Date(0)).toISOString();
  const re = rangeEnd.toISOString();
  await query(
    USE_SQLITE
      ? `INSERT INTO bucket_summaries (user_id, tags_hash, range_start, range_end, variant, summary, top_news, model, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (user_id, tags_hash) DO UPDATE SET
           range_start = excluded.range_start,
           range_end = excluded.range_end,
           variant = excluded.variant,
           summary = excluded.summary,
           top_news = excluded.top_news,
           model = excluded.model,
           generated_at = datetime('now')`
      : `INSERT INTO bucket_summaries (user_id, tags_hash, range_start, range_end, variant, summary, top_news, model, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (user_id, tags_hash) DO UPDATE SET
           range_start = EXCLUDED.range_start,
           range_end = EXCLUDED.range_end,
           variant = EXCLUDED.variant,
           summary = EXCLUDED.summary,
           top_news = EXCLUDED.top_news,
           model = EXCLUDED.model,
           generated_at = NOW()`,
    USE_SQLITE
      ? [userId, tagsHash, rs, re, variant, summary, topNews, 'kimi']
      : [userId, tagsHash, rs, re, variant, summary, topNews, 'kimi']
  );
  memSet(tagsHash, { summary, generated_at: new Date().toISOString(), model: 'kimi' }, variant);
}

/**
 * Единая точка входа (роут + cron). НЕБЛОКИРУЮЩИЙ: при промахе кэша
 * возвращает null и запускает фоновую генерацию (одна на ключ — inflight).
 */
export async function getOrGenerateBucketSummary(
  userId: string,
  tagIds: string[],
  rangeStart: Date | null,
  rangeEnd: Date,
  variant: 'bucket' | 'older',
  bucketKeyName: string | null = null
): Promise<BucketSummaryResult | null> {
  if (tagIds.length === 0) return null;
  const nowMsk = new Date(Date.now() + 3 * 3600 * 1000);
  const mskDate = nowMsk.toISOString().slice(0, 10);
  const key = bucketTagsHash(tagIds, variant, rangeStart || new Date(0), rangeEnd, mskDate);

  const mem = memGet(key, variant);
  if (mem) return mem;
  try {
    const db = await dbGet(userId, key, variant);
    if (db) return db;
  } catch (err: any) {
    console.error('[BucketSummary] db read error:', err.message);
  }

  // промах — фоновая генерация, ответ null (фронт покажет буллеты)
  if (!inflight.has(key)) {
    const job = generateAndStore(userId, tagIds, key, rangeStart, rangeEnd, variant, bucketKeyName, mskDate)
      .catch((err: any) => console.error('[BucketSummary] lazy generate error:', err.message))
      .finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return null;
}

// ═══ Cron-прегенерация (Задача 4а) ═════════════════════════════════════════

function mskDateStr(d: Date = new Date()): string {
  return new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * Прегенерация для только что закрытого бакета: активные за 7 дней юзеры
 * с непрочитанными в окне под свои теги. Одинаковый набор тегов = один
 * вызов LLM, строка пишется каждому юзеру группы.
 */
export async function pregenBucketSummaries(
  rangeStart: Date,
  rangeEnd: Date,
  variant: 'bucket' | 'older',
  bucketKeyName: string | null = null
): Promise<void> {
  const sinceIso = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  let usersRes;
  try {
    usersRes = await query(
      `SELECT u.id AS user_id, p.tag_id
       FROM users u
       JOIN portfolios p ON p.user_id = u.id AND p.is_frozen = FALSE
       WHERE u.last_login_at > $1
       GROUP BY u.id, p.tag_id`,
      [sinceIso]
    );
  } catch (err: any) {
    console.error('[Cron] bucket pregen: users select failed:', err.message);
    return;
  }

  const byUser = new Map<string, string[]>();
  for (const row of usersRes.rows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id)!.push(row.tag_id);
  }

  const mskDate = mskDateStr();
  const groups = new Map<string, { tagIds: string[]; userIds: string[] }>();
  for (const [userId, tagIds] of byUser) {
    // ключ группы = ключ чтения/записи (для 'bucket' — от реальных границ бакета)
    const hash = bucketTagsHash(tagIds, variant, rangeStart || new Date(0), rangeEnd, mskDate);
    if (!groups.has(hash)) groups.set(hash, { tagIds, userIds: [] });
    groups.get(hash)!.userIds.push(userId);
  }

  let done = 0;
  let failed = 0;
  for (const group of groups.values()) {
    try {
      const articles = await selectTopNewsForPrompt(group.tagIds, variant === 'bucket' ? rangeStart : null, rangeEnd);
      if (articles.length === 0) continue;
      const summary = await callLlm(buildPrompt(variant, bucketKeyName, articles));
      if (!summary) { failed++; continue; }
      const topNews = variant === 'bucket'
        ? JSON.stringify(articles.slice(0, 4).map((a) => ({ id: a.id, title: a.title, source: a.source })))
        : '[]';
      const rs = (variant === 'bucket' ? rangeStart : new Date(0)).toISOString();
      const re = rangeEnd.toISOString();
      // одна строка каждому юзеру группы (ключ = квантованный hash группы,
      // совпадает с ключом чтения: bucket — от реальных границ, older — от MSK-даты)
      const groupHash = bucketTagsHash(group.tagIds, variant, rangeStart || new Date(0), rangeEnd, mskDate);
      for (const userId of group.userIds) {
        await query(
          USE_SQLITE
            ? `INSERT INTO bucket_summaries (user_id, tags_hash, range_start, range_end, variant, summary, top_news, model, generated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT (user_id, tags_hash) DO UPDATE SET
                 range_start = excluded.range_start, range_end = excluded.range_end,
                 variant = excluded.variant, summary = excluded.summary,
                 top_news = excluded.top_news, model = excluded.model, generated_at = datetime('now')`
            : `INSERT INTO bucket_summaries (user_id, tags_hash, range_start, range_end, variant, summary, top_news, model, generated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
               ON CONFLICT (user_id, tags_hash) DO UPDATE SET
                 range_start = EXCLUDED.range_start, range_end = EXCLUDED.range_end,
                 variant = EXCLUDED.variant, summary = EXCLUDED.summary,
                 top_news = EXCLUDED.top_news, model = EXCLUDED.model, generated_at = NOW()`,
          USE_SQLITE
            ? [userId, groupHash, rs, re, variant, summary, topNews, 'kimi']
            : [userId, groupHash, rs, re, variant, summary, topNews, 'kimi']
        );
      }
      done++;
    } catch (err: any) {
      failed++;
      console.error(`[Cron] bucket pregen group failed: ${err.message?.slice(0, 120)}`);
    }
  }
  console.log(`[Cron] bucket pregen (${variant}): ${byUser.size} users, ${groups.size} tag-groups, ${done} done, ${failed} failed`);
}

/** Плановая уборка мусора: всё, что протухло более суток назад. */
export async function cleanupBucketSummaries(): Promise<void> {
  try {
    // Вариантно-зависимая валидность: 'bucket' — range_end + 24ч; 'older' —
    // generated_at + 24ч (его range_end = T_gen−24ч плавает, иначе cleanup
    // убивал бы валидные older-строки за ~6ч → лишние LLM-вызовы каждый час)
    const res = await query(
      USE_SQLITE
        ? `DELETE FROM bucket_summaries
           WHERE (variant = 'bucket' AND range_end < datetime('now', '-24 hours'))
              OR (variant = 'older' AND generated_at < datetime('now', '-24 hours'))`
        : `DELETE FROM bucket_summaries
           WHERE (variant = 'bucket' AND range_end < NOW() - INTERVAL '24 hours')
              OR (variant = 'older' AND generated_at < NOW() - INTERVAL '24 hours')`,
      []
    );
    if (res.rows.length > 0 || (res.rowCount ?? 0) > 0) {
      console.log(`[Cron] bucket summaries cleanup: deleted=${res.rowCount ?? res.rows.length}`);
    }
  } catch (err: any) {
    console.error('[Cron] bucket cleanup error:', err.message);
  }
}
