/**
 * =============================================================================
 * PULSE — История метрик MP3-кэша радио (ТЗ-65, блок 3/7)
 * =============================================================================
 *
 * Ring buffer 1440 snapshot'ов (24ч × 60 мин) для графиков в админ-табе
 * «Радио». Каждую минуту пишется снимок состояния кеша и TTS-метрик.
 *
 * In-memory per-process (1 инстанс VDS) — при рестарте buffer пустой.
 * Без БД и миграций; setInterval, а не node-cron (per-process, локи не нужны).
 * Долгосрочная история — отдельный ТЗ (Д1/Д2).
 */

import { getRadioTtsMetrics } from './radioMetrics';
import { getRadioMp3CacheStats } from './radioMp3Cache';

export interface CacheSnapshot {
  ts: number;             // Date.now()
  entries: number;
  bytes: number;
  cache_hit: number;      // cumulative since boot
  cache_miss: number;     // cumulative since boot
  hitRate: number;        // delta-based за последнюю минуту, %
  inflight: number;
}

const RING_SIZE = 1440; // 24ч × 60 точек/час
const ring: CacheSnapshot[] = [];
let lastCounters = { hit: 0, miss: 0 };

export function recordSnapshot(): CacheSnapshot {
  const tts = getRadioTtsMetrics();
  const cache = getRadioMp3CacheStats();

  // delta-based hit rate за интервал с прошлого snapshot'а
  const hitDelta = tts.cache_hit - lastCounters.hit;
  const missDelta = tts.cache_miss - lastCounters.miss;
  const totalDelta = hitDelta + missDelta;
  const hitRate = totalDelta > 0
    ? Math.round((hitDelta / totalDelta) * 1000) / 10
    : 0;

  lastCounters = { hit: tts.cache_hit, miss: tts.cache_miss };

  const snap: CacheSnapshot = {
    ts: Date.now(),
    entries: cache.entries,
    bytes: cache.bytes,
    cache_hit: tts.cache_hit,
    cache_miss: tts.cache_miss,
    hitRate,
    inflight: cache.inflight,
  };

  ring.push(snap);
  if (ring.length > RING_SIZE) ring.shift();
  return snap;
}

/** Копия буфера (внешним мутированием ring не испортить). */
export function getHistory(): CacheSnapshot[] {
  return [...ring];
}

/** Сброс буфера (для verify-скрипта). */
export function clearHistory(): void {
  ring.length = 0;
  lastCounters = { hit: 0, miss: 0 };
}

export function startHistoryCron(): void {
  recordSnapshot(); // первый snapshot сразу — график не пустой первую минуту
  setInterval(() => {
    try { recordSnapshot(); } catch (e: any) {
      console.error('[Mp3CacheHistory] snapshot failed:', e.message);
    }
  }, 60_000);
  console.log('[Mp3CacheHistory] Started — snapshot every 60s, ring buffer 1440 (24h)');
}
