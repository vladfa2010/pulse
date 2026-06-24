/**
 * =============================================================================
 * PULSE — IMOEX 5-min adapter via MOEX ISS API
 * =============================================================================
 *
 * MOEX ISS не отдаёт 5-минутные свечи напрямую, поэтому:
 *   1. Запрашиваем 1-минутные свечи IMOEX (board SNDX).
 *   2. Агрегируем в 5-минутные самостоятельно.
 *   3. Заполняем пропуски (неторговое время) последним close — flat line.
 */

export interface ImoexCandle {
  time: string // ISO UTC
  open: number
  high: number
  low: number
  close: number
}

const BASE_URL = 'https://iss.moex.com/iss/engines/stock/markets/index/boards/SNDX/securities/IMOEX/candles.json';
const CHUNK_MINUTES = 500; // максимум свечей за запрос

function getMoscowDayBounds(now: Date = new Date()) {
  const mskOffset = 3 * 60 * 60 * 1000;
  const mskTime = new Date(now.getTime() + mskOffset);
  const y = mskTime.getUTCFullYear();
  const m = mskTime.getUTCMonth();
  const d = mskTime.getUTCDate();
  const start = new Date(Date.UTC(y, m, d) - mskOffset);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function parseMskDate(mskString: string): Date {
  // begin/end приходят как '2026-06-24 10:00:00' в московском времени
  return new Date(mskString.replace(' ', 'T') + '+03:00');
}

function formatMskLocal(date: Date): string {
  const msk = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const d = String(msk.getUTCDate()).padStart(2, '0');
  const h = String(msk.getUTCHours()).padStart(2, '0');
  const min = String(msk.getUTCMinutes()).padStart(2, '0');
  const s = String(msk.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

async function fetchChunk(from: Date, till: Date): Promise<any[]> {
  const url = new URL(BASE_URL);
  url.searchParams.set('from', formatMskLocal(from));
  url.searchParams.set('till', formatMskLocal(till));
  url.searchParams.set('interval', '1');
  url.searchParams.set('iss.meta', 'off');

  const res = await fetch(url.toString(), { timeout: 30000 } as any);
  if (!res.ok) {
    throw new Error(`MOEX ISS error: ${res.status}`);
  }
  const json = await res.json();
  const candles = json.candles;
  if (!candles || !Array.isArray(candles.data) || candles.data.length === 0) {
    return [];
  }
  const columns: string[] = candles.columns;
  const idx: Record<string, number> = {};
  columns.forEach((c, i) => (idx[c] = i));

  return candles.data.map((row: any[]) => ({
    open: parseFloat(row[idx.open]),
    close: parseFloat(row[idx.close]),
    high: parseFloat(row[idx.high]),
    low: parseFloat(row[idx.low]),
    begin: row[idx.begin] as string,
    end: row[idx.end] as string,
  }));
}

/**
 * Запросить 1-минутные свечи IMOEX за период с пагинацией.
 */
export async function fetchImoex1minCandles(from: Date, till: Date): Promise<ImoexCandle[]> {
  const all: ImoexCandle[] = [];
  let current = new Date(from);

  while (current < till) {
    const chunkEnd = new Date(Math.min(current.getTime() + CHUNK_MINUTES * 60 * 1000, till.getTime()));
    const chunk = await fetchChunk(current, chunkEnd);
    if (chunk.length === 0) {
      current = chunkEnd;
      continue;
    }
    for (const c of chunk) {
      all.push({
        time: parseMskDate(c.begin).toISOString(),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      });
    }
    const lastTime = parseMskDate(chunk[chunk.length - 1].end);
    current = new Date(lastTime.getTime() + 1000);
  }

  return all;
}

/**
 * Агрегировать 1-минутные свечи в 5-минутные.
 */
export function aggregateTo5min(candles: ImoexCandle[]): ImoexCandle[] {
  const buckets = new Map<number, ImoexCandle[]>();

  for (const c of candles) {
    const t = new Date(c.time);
    const min = Math.floor(t.getUTCMinutes() / 5) * 5;
    const bucketTime = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(), min, 0, 0);
    const arr = buckets.get(bucketTime) || [];
    arr.push(c);
    buckets.set(bucketTime, arr);
  }

  const result: ImoexCandle[] = [];
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const arr = buckets.get(key)!;
    result.push({
      time: new Date(key).toISOString(),
      open: arr[0].open,
      high: Math.max(...arr.map(x => x.high)),
      low: Math.min(...arr.map(x => x.low)),
      close: arr[arr.length - 1].close,
    });
  }
  return result;
}

/**
 * Заполнить пропуски между 5-минутными свечами последним close (flat line).
 */
export function extendWithFlatLine(candles: ImoexCandle[], from: Date, till: Date): ImoexCandle[] {
  if (candles.length === 0) return [];

  const result: ImoexCandle[] = [];
  const map = new Map(candles.map(c => [new Date(c.time).getTime(), c]));

  let lastClose = candles[0].close;
  const step = 5 * 60 * 1000;
  const startMs = Math.floor(from.getTime() / step) * step;
  const endMs = till.getTime();

  for (let t = startMs; t < endMs; t += step) {
    const c = map.get(t);
    if (c) {
      lastClose = c.close;
      result.push(c);
    } else {
      result.push({
        time: new Date(t).toISOString(),
        open: lastClose,
        high: lastClose,
        low: lastClose,
        close: lastClose,
      });
    }
  }

  return result;
}

/**
 * Получить 5-минутные свечи IMOEX за текущий день по МСК с flat line.
 */
export async function getImoex5minForDay(date: Date = new Date()): Promise<ImoexCandle[]> {
  const { start, end } = getMoscowDayBounds(date);
  const raw1min = await fetchImoex1minCandles(start, end);
  if (raw1min.length === 0) return [];
  const agg = aggregateTo5min(raw1min);
  return extendWithFlatLine(agg, start, end);
}
