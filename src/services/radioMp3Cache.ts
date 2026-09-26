/**
 * =============================================================================
 * PULSE — Радио: backend-side mp3-кеш для T2A (ТЗ-63 + аудит 2026-09-26)
 * =============================================================================
 *
 * Назначение: один и тот же сегмент озвучки со всех юзеров генерируется Minimax
 * один раз за TTL, а не на каждый запрос (деньги + TTFB). Prerequisite для
 * ТЗ-64 (публичный эфир гостей).
 *
 * Scope: per-process in-memory (1 инстанс на VDS Beget, Redis не нужен).
 * Только радио: ни таблиц БД, ни миграций, ни чужих роутов не затрагивает.
 *
 * Ключ = `${MODEL}\x00${text.trim()}\x00${voice_id}\x00${speed}\x00${pitch}`.
 * MODEL в ключе (аудит замечание 3): страховка от hot-swap MINIMAX_TTS_MODEL —
 * mp3 старой модели не будут отдаваться под новой (голос/тембр могут отличаться).
 *
 * Алгоритм:
 *  - cacheGet — проверка TTL, lazy eviction протухших, LRU-touch.
 *  - cacheSet — FIFO eviction при превышении MAX_ENTRIES или MAX_TOTAL_BYTES.
 *  - inflight Map — single-flight: N параллельных запросов с одним ключом
 *    = 1 upstream-вызов.
 *  - На upstream error — пробрасываем, кэш НЕ пишем (чтобы не отравить).
 *
 * Контракт fetcher (аудит замечание 2): shared fetch НЕ отменяется по disconnect
 * отдельных ждущих — abort одного caller'а завалил бы всех, кто делит promise.
 * Fetcher создаёт свой AbortController + timeout внутри; отключение клиента
 * во время T2A (1–3 с) upstream не рубит — результат дописывается в кэш.
 * Единственный предохранитель — таймаут 30 с внутри fetcher'а.
 *
 * TTL = 6ч — синхронизирован с TTL radioPodcast-диалога и globalSummary.
 */

// Единый источник модели TTS (ТЗ-61): radio.ts импортирует эту константу,
// дефолт не дублируется. Смена модели = recreate контейнера = кэш пуст,
// плюс MODEL участвует в ключе — двойная защита от рассинхрона голосов.
export const MINIMAX_TTS_MODEL = process.env.MINIMAX_TTS_MODEL ?? 'speech-2.8-hd';

interface CacheEntry {
  buffer: Buffer;
  expiresAt: number;
  size: number;
}

const TTL_MS = 6 * 60 * 60 * 1000;        // 6ч — как у radioPodcast/globalSummary
const MAX_ENTRIES = 256;                   // ~256 сегментов
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;  // 80 МБ ≈ 14 диалогов (9 сегм × 2 голоса × ~300 КБ)

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Buffer>>();
let currentSize = 0;

function makeKey(text: string, voiceId: string, speed: number, pitch: number): string {
  return `${MINIMAX_TTS_MODEL}\x00${text.trim()}\x00${voiceId}\x00${speed}\x00${pitch}`;
}

function evictIfNeeded(): void {
  while (
    (cache.size >= MAX_ENTRIES || currentSize > MAX_TOTAL_BYTES) &&
    cache.size > 0
  ) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) break;
    const entry = cache.get(firstKey);
    if (entry) currentSize -= entry.size;
    cache.delete(firstKey);
  }
}

function cacheGet(key: string): Buffer | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    currentSize -= hit.size;
    cache.delete(key);
    return null;
  }
  // LRU touch — переставить в конец Map (insertion order = порядок вытеснения).
  cache.delete(key);
  cache.set(key, hit);
  return hit.buffer;
}

function cacheSet(key: string, buffer: Buffer): void {
  if (cache.has(key)) {
    const old = cache.get(key)!;
    currentSize -= old.size;
    cache.delete(key);
  }
  cache.set(key, {
    buffer,
    expiresAt: Date.now() + TTL_MS,
    size: buffer.length,
  });
  currentSize += buffer.length;
  evictIfNeeded();
}

/**
 * Главная функция. Возвращает mp3-буфер (из кэша или после upstream).
 * Параллельные вызовы с одним ключом делят один upstream-запрос (single-flight).
 * На upstream error — пробрасывает, кэш НЕ пишет.
 */
export async function getOrFetchMp3(
  text: string,
  voiceId: string,
  speed: number,
  pitch: number,
  fetcher: () => Promise<Buffer>,
): Promise<{ buffer: Buffer; hit: boolean }> {
  const key = makeKey(text, voiceId, speed, pitch);

  const hit = cacheGet(key);
  if (hit) return { buffer: hit, hit: true };

  const existing = inflight.get(key);
  if (existing) {
    const buffer = await existing;
    return { buffer, hit: false };
  }

  const promise = (async () => {
    try {
      const buffer = await fetcher();
      cacheSet(key, buffer);
      return buffer;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);
  const buffer = await promise;
  return { buffer, hit: false };
}

/** Прямой cacheGet для handler'а: проверка cache hit без запуска fetcher'а. */
export function cacheGetPublic(text: string, voiceId: string, speed: number, pitch: number): Buffer | null {
  return cacheGet(makeKey(text, voiceId, speed, pitch));
}

/** Метрики для админки (подключение к admin — отдельная задача, Д4). */
export function getRadioMp3CacheStats(): {
  entries: number;
  bytes: number;
  maxEntries: number;
  maxBytes: number;
  inflight: number;
  ttlMs: number;
} {
  return {
    entries: cache.size,
    bytes: currentSize,
    maxEntries: MAX_ENTRIES,
    maxBytes: MAX_TOTAL_BYTES,
    inflight: inflight.size,
    ttlMs: TTL_MS,
  };
}

/** Для verify-скрипта и будущего admin-reset (Д2). */
export function clearRadioMp3Cache(): void {
  cache.clear();
  inflight.clear();
  currentSize = 0;
}
