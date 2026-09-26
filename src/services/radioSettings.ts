/**
 * =============================================================================
 * PULSE — Radio Settings Service (ТЗ-45)
 * =============================================================================
 *
 * Runtime-флаги радио хранятся в БД (таблица `_radio_settings`, key/value)
 * вместо code-defaults ТЗ-42. Сервис — единая точка чтения/записи:
 *
 *   getRadioFlags()  — эффективные значения (БД + дефолты на недостающие),
 *                      кэш в памяти TTL 60 с (флаги читаются каждым заходом
 *                      на /radio — БД не дёргаем на каждый запрос).
 *   setRadioFlag()   — whitelist ключей + валидация значений, upsert,
 *                      инвалидация кэша, запись в activityLog.
 *   resetRadioFlags()— удалить все строки (дефолты применятся сами).
 *
 * Паттерн — `calendar_settings` (src/services/calendar.ts): ensure-миграция
 * из кода, два диалекта upsert (SQLite INSERT OR REPLACE / PG ON CONFLICT).
 *
 * Ключи в БД — БЕЗ префикса `radio_`; префикс добавляет роут
 * /api/radio/config (контракт ТЗ-42 не меняется).
 */

import { query } from '../config/db';
import { logAdminRadioFlagChanged } from './activityLog';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export interface RadioFlags {
  /** Kill-switch всего сервиса радио (админ). Авточтение — юзерская настройка,
   * сюда она больше не относится (ТЗ-46). */
  service_enabled: boolean;
  voice_provider: 'browser' | 'minimax';
  minimax_host_voice: string;
  minimax_guest_voice: string;
  default_mode: 'text' | 'reflect' | 'podcast';
}

export const RADIO_FLAG_DEFAULTS: RadioFlags = {
  service_enabled: true,
  voice_provider: 'browser',
  minimax_host_voice: 'presenter_male',
  minimax_guest_voice: 'presenter_female',
  default_mode: 'reflect',
};

// Белый список голосов — единый источник в config/radio (ТЗ-66-lite).
// Свободный ввод id запрещён — опечатка уронит TTS; переименование голоса
// Minimax лечится мини-коммитом с обновлением списка в config/radio.ts.
export { MINIMAX_VOICE_IDS } from '../config/radio';
import { MINIMAX_VOICE_IDS } from '../config/radio';

const VOICE_PROVIDERS = ['browser', 'minimax'] as const;
const DEFAULT_MODES = ['text', 'reflect', 'podcast'] as const;

const FLAGS_CACHE_TTL_MS = 60_000;
let flagsCache: { flags: RadioFlags; at: number } | null = null;

function invalidateCache(): void {
  flagsCache = null;
}

// 400 при невалидном ключе/значении — роуты мапят в HTTP 400.
export class RadioFlagError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RadioFlagError';
  }
}

// ─── Миграция (по образцу calendar.ts) ──────────────────────────────────────

async function ensureRadioSettingsTablePostgres(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS _radio_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
}

async function ensureRadioSettingsTableSQLite(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS _radio_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
}

export async function runRadioMigrations(): Promise<void> {
  if (USE_SQLITE) {
    await ensureRadioSettingsTableSQLite();
  } else {
    await ensureRadioSettingsTablePostgres();
  }
}

// ─── Чтение ─────────────────────────────────────────────────────────────────

// Сид дефолтов при первом обращении (таблица пуста). Идемпотентен:
// INSERT по PK + OR REPLACE/ON CONFLICT, конкурентные сиды безопасны (ТЗ-45 §4).
async function seedDefaultsIfEmpty(): Promise<void> {
  const result = await query(`SELECT COUNT(*) AS c FROM _radio_settings`);
  if (Number(result.rows[0]?.c || 0) > 0) return;

  for (const [key, value] of Object.entries(RADIO_FLAG_DEFAULTS)) {
    const serialized = key === 'auto_read_enabled' ? String(value) : (value as string);
    if (USE_SQLITE) {
      await query(`INSERT OR REPLACE INTO _radio_settings (key, value) VALUES (?, ?)`, [key, serialized]);
    } else {
      await query(
        `INSERT INTO _radio_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, serialized]
      );
    }
  }
  console.log('[RadioSettings] Seeded 5 default flags into _radio_settings');
}

export async function getRadioFlags(): Promise<RadioFlags> {
  if (flagsCache && Date.now() - flagsCache.at < FLAGS_CACHE_TTL_MS) {
    return flagsCache.flags;
  }

  await seedDefaultsIfEmpty();

  const result = await query(`SELECT key, value FROM _radio_settings`);
  const dbValues = new Map<string, string>();
  for (const row of result.rows as any[]) {
    if (row.key != null) dbValues.set(String(row.key), row.value == null ? '' : String(row.value));
  }

  // Дефолты применяются к отсутствующим ключам — частично заполненная
  // таблица (после ручной правки/reset) не роняет ответ.
  const flags: RadioFlags = {
    service_enabled: dbValues.get('service_enabled') === undefined
      ? RADIO_FLAG_DEFAULTS.service_enabled
      : dbValues.get('service_enabled') === 'true',
    voice_provider: (dbValues.get('voice_provider') ?? RADIO_FLAG_DEFAULTS.voice_provider) as RadioFlags['voice_provider'],
    minimax_host_voice: dbValues.get('minimax_host_voice') ?? RADIO_FLAG_DEFAULTS.minimax_host_voice,
    minimax_guest_voice: dbValues.get('minimax_guest_voice') ?? RADIO_FLAG_DEFAULTS.minimax_guest_voice,
    default_mode: (dbValues.get('default_mode') ?? RADIO_FLAG_DEFAULTS.default_mode) as RadioFlags['default_mode'],
  };

  flagsCache = { flags, at: Date.now() };
  return flags;
}

// ─── Запись ─────────────────────────────────────────────────────────────────

// Возвращает сериализованные old/new для activityLog.
export async function setRadioFlag(
  key: string,
  value: unknown,
  changedBy: string
): Promise<{ oldValue: string; newValue: string }> {
  if (!Object.prototype.hasOwnProperty.call(RADIO_FLAG_DEFAULTS, key)) {
    throw new RadioFlagError(`unknown key: ${key}`);
  }

  const flagKey = key as keyof RadioFlags;
  let serialized: string;
  switch (flagKey) {
    case 'service_enabled':
      if (typeof value !== 'boolean') {
        throw new RadioFlagError('service_enabled must be a boolean');
      }
      serialized = String(value);
      break;
    case 'voice_provider':
      if (typeof value !== 'string' || !(VOICE_PROVIDERS as readonly string[]).includes(value)) {
        throw new RadioFlagError(`voice_provider must be one of: ${VOICE_PROVIDERS.join(', ')}`);
      }
      serialized = value;
      break;
    case 'minimax_host_voice':
    case 'minimax_guest_voice':
      if (typeof value !== 'string' || !MINIMAX_VOICE_IDS.includes(value)) {
        throw new RadioFlagError(`${flagKey} must be one of the allowed Minimax voice ids`);
      }
      serialized = value;
      break;
    case 'default_mode':
      if (typeof value !== 'string' || !(DEFAULT_MODES as readonly string[]).includes(value)) {
        throw new RadioFlagError(`default_mode must be one of: ${DEFAULT_MODES.join(', ')}`);
      }
      serialized = value;
      break;
    default:
      throw new RadioFlagError(`unknown key: ${key}`);
  }

  const current = await getRadioFlags();
  const oldValue = flagKey === 'service_enabled'
    ? String(current.service_enabled)
    : String(current[flagKey]);

  if (USE_SQLITE) {
    await query(`INSERT OR REPLACE INTO _radio_settings (key, value) VALUES (?, ?)`, [key, serialized]);
  } else {
    await query(
      `INSERT INTO _radio_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
      [key, serialized]
    );
  }
  invalidateCache();

  // Лог не ломает основной flow (activityLog сам в try/catch)
  await logAdminRadioFlagChanged(changedBy, key, oldValue, serialized);

  return { oldValue, newValue: serialized };
}

export async function resetRadioFlags(changedBy: string): Promise<void> {
  await query(`DELETE FROM _radio_settings`);
  invalidateCache();
  await logAdminRadioFlagChanged(changedBy, '*', '(custom)', '(defaults)');
}
