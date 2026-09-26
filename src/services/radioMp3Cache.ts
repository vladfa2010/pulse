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
 * TTL = 24ч (аудит кеша F4) — ключ точный текст, длинный TTL бесплатен
 * (потолок памяти LRU), повышает hit rate на повторяющихся текстах.
 */

import { MINIMAX_TTS_MODEL } from '../config/radio';

// Re-export для backward compat: раньше модель экспортировалась из этого
// модуля (ТЗ-63); единый источник — config/radio.ts (ТЗ-66-lite).
export { MINIMAX_TTS_MODEL };

interface CacheEntry {
  buffer: Buffer;
  expiresAt: number;
  size: number;
}

// Аудит кеша F4: TTL 24ч вместо 6ч. Ключ — точный текст, старые записи
// безвредны (перестают запрашиваться, вытесняются LRU); потолок памяти всё
// равно 80 МБ. Длинный TTL повышает hit rate для повторяющихся текстов
// (приветствия, диалог при раннем recreate). Раньше было «6ч вровень с
// диалогом» — но связь не нужна: несовпадение текста = новый ключ само по себе.
const TTL_MS = 24 * 60 * 60 * 1000;       // 24ч
const MAX_ENTRIES = 256;                   // ~256 сегментов
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;  // 80 МБ ≈ 14 диалогов (9 сегм × 2 голоса × ~300 КБ)

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<Buffer>>();
// ТЗ-65, блок 4: счётчик hit'ов по ключу для top-keys в админке.
// Растёт с числом уникальных текстов (~500-2000/день, риск Р2 ТЗ-65),
// сбрасывается в clearRadioMp3Cache() и при recreate.
const topKeys = new Map<string, number>();
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
  // ТЗ-65: инкремент счётчика для top-keys в админке
  topKeys.set(key, (topKeys.get(key) ?? 0) + 1);
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
  topKeys.clear(); // ТЗ-65
  currentSize = 0;
}

/**
 * ТЗ-65, блок 4: top-N ключей по числу hit'ов (для админ-дашборда).
 * bytes берётся из живого кэша — для вытесненных записей 0.
 */
export function getTopKeys(limit = 10): { key: string; hits: number; bytes: number }[] {
  const result: { key: string; hits: number; bytes: number }[] = [];
  for (const [key, hits] of topKeys) {
    const entry = cache.get(key);
    result.push({ key, hits, bytes: entry?.size ?? 0 });
  }
  result.sort((a, b) => b.hits - a.hits);
  return result.slice(0, limit);
}

/** Сброс счётчиков top-keys (при clear кеша счётчики тоже сбрасываются). */
export function resetTopKeys(): void {
  topKeys.clear();
}
