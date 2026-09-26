/**
 * =============================================================================
 * PULSE — Метрики TTS-прокси радио (ТЗ-42, ревью п.7)
 * =============================================================================
 *
 * success/error counts + p95 latency для POST /api/radio/tts.
 * In-memory с момента старта процесса (воркер один; потеря при рестарте —
 * осознанное упрощение v1). Читаются админкой: GET /api/admin/metrics?section=radio
 * (adminMetrics.ts). Эксплуатационный summary пишется в лог каждый 100-й запрос.
 */

export type TtsSource = 'hit' | 'miss' | 'unknown';

export interface RadioTtsMetrics {
  since: string;
  total: number;          // попытки синтеза (ok + 502 + 503)
  ok: number;
  err_502: number;        // ошибки апстрима (HTTP, timeout, невалидный ответ)
  err_503: number;        // MINIMAX_API_KEY не задан
  cache_hit: number;      // ТЗ-63: отдано из backend mp3-кеша
  cache_miss: number;     // ТЗ-63: дёрнут Minimax T2A
  rate_502_pct: number;   // доля 502 от total, %
  rate_503_pct: number;   // доля 503 от total, %
  p95_latency_ms: number | null;   // p95 по окну последних LATENCY_WINDOW попыток
  avg_latency_ms: number | null;
}

const LATENCY_WINDOW = 500;
const startedAt = new Date().toISOString();
const counters = { total: 0, ok: 0, err_502: 0, err_503: 0, cache_hit: 0, cache_miss: 0 };
const latencies: number[] = [];

function percentile(p: number): number | null {
  if (latencies.length === 0) return null;
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function recordTtsResult(
  outcome: 'ok' | '502' | '503',
  latencyMs?: number,
  source: TtsSource = 'unknown',
): void {
  counters.total++;
  if (outcome === 'ok') counters.ok++;
  else if (outcome === '502') counters.err_502++;
  else counters.err_503++;
  if (source === 'hit') counters.cache_hit++;
  else if (source === 'miss') counters.cache_miss++;

  if (latencyMs !== undefined) {
    latencies.push(latencyMs);
    if (latencies.length > LATENCY_WINDOW) latencies.shift();
  }

  // Эксплуатационный summary — каждый 100-й запрос, виден в docker logs
  if (counters.total % 100 === 0) {
    console.log(
      `[RadioTTS] stats: total=${counters.total} ok=${counters.ok} ` +
      `cache(hit/miss)=${counters.cache_hit}/${counters.cache_miss} ` +
      `502=${counters.err_502} (${((counters.err_502 / counters.total) * 100).toFixed(1)}%) ` +
      `503=${counters.err_503} p95=${percentile(95)}ms`
    );
  }
}

export function getRadioTtsMetrics(): RadioTtsMetrics {
  const p95 = percentile(95);
  const avg = latencies.length > 0
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
    : null;
  return {
    since: startedAt,
    total: counters.total,
    ok: counters.ok,
    err_502: counters.err_502,
    err_503: counters.err_503,
    cache_hit: counters.cache_hit,
    cache_miss: counters.cache_miss,
    rate_502_pct: counters.total > 0 ? Math.round((counters.err_502 / counters.total) * 1000) / 10 : 0,
    rate_503_pct: counters.total > 0 ? Math.round((counters.err_503 / counters.total) * 1000) / 10 : 0,
    p95_latency_ms: p95,
    avg_latency_ms: avg,
  };
}
