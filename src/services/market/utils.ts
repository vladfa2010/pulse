/**
 * =============================================================================
 * PULSE — Market data utilities (MOEX ISS / timezone helpers)
 * =============================================================================
 */

export interface MarketCandle {
  time: string // ISO UTC
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

export function getMoscowDayBounds(now: Date = new Date()): { start: Date; end: Date } {
  const mskTime = new Date(now.getTime() + MSK_OFFSET_MS);
  const y = mskTime.getUTCFullYear();
  const m = mskTime.getUTCMonth();
  const d = mskTime.getUTCDate();
  const start = new Date(Date.UTC(y, m, d) - MSK_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function parseMskDate(mskString: string): Date {
  // begin/end come as '2026-07-28 10:00:00' in Moscow time
  return new Date(mskString.replace(' ', 'T') + '+03:00');
}

export function formatMskLocal(date: Date): string {
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const d = String(msk.getUTCDate()).padStart(2, '0');
  const h = String(msk.getUTCHours()).padStart(2, '0');
  const min = String(msk.getUTCMinutes()).padStart(2, '0');
  const s = String(msk.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

export function formatMskDate(date: Date): string {
  const msk = new Date(date.getTime() + MSK_OFFSET_MS);
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const d = String(msk.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function aggregateTo5min(candles: MarketCandle[]): MarketCandle[] {
  const buckets = new Map<number, MarketCandle[]>();

  for (const c of candles) {
    const t = new Date(c.time);
    const min = Math.floor(t.getUTCMinutes() / 5) * 5;
    const bucketTime = Date.UTC(
      t.getUTCFullYear(),
      t.getUTCMonth(),
      t.getUTCDate(),
      t.getUTCHours(),
      min,
      0,
      0
    );
    const arr = buckets.get(bucketTime) || [];
    arr.push(c);
    buckets.set(bucketTime, arr);
  }

  const result: MarketCandle[] = [];
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const arr = buckets.get(key)!;
    const volumes = arr.map((x) => x.volume ?? 0);
    result.push({
      time: new Date(key).toISOString(),
      open: arr[0].open,
      high: Math.max(...arr.map((x) => x.high)),
      low: Math.min(...arr.map((x) => x.low)),
      close: arr[arr.length - 1].close,
      volume: volumes.reduce((a, b) => a + b, 0),
    });
  }
  return result;
}
