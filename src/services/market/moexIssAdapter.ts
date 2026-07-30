/**
 * =============================================================================
 * PULSE — MOEX ISS market data adapter
 * =============================================================================
 *
 * Generalised over imoexAdapter.ts: works for any ticker traded on MOEX.
 *
 * Capabilities:
 *   - resolve ticker → engine / market / board / secid via /iss/securities
 *   - daily candles (interval=24)
 *   - 5-minute intraday candles aggregated from 1-minute MOEX ISS candles
 *
 * Time handling: MOEX returns Moscow time strings without timezone; we parse
 * them as UTC+3.
 */

import axios from 'axios';
import {
  MarketCandle,
  getMoscowDayBounds,
  parseMskDate,
  formatMskLocal,
  formatMskDate,
  aggregateTo5min,
} from './utils';

const BASE_URL = 'https://iss.moex.com/iss';
const REQUEST_TIMEOUT_MS = 15000;
const INTRADAY_CHUNK_MINUTES = 500; // max candles per ISS request for 1-min interval

const AXIOS_HEADERS = {
  'User-Agent': 'Pulse-Admin/1.0 (contact@inside-trade.ru)',
  'Accept': 'application/json',
};

interface TickerBoard {
  secid: string;
  engine: string;
  market: string;
  board: string;
}

// In-memory caches
const resolveCache = new Map<string, TickerBoard | null>();
const dailyCache = new Map<string, { data: MarketCandle[]; expiresAt: number }>();
const intradayCache = new Map<string, { data: MarketCandle[]; expiresAt: number }>();
const currentPriceCache = new Map<string, { price: number | null; expiresAt: number }>();


function nowMs() {
  return Date.now();
}

function cacheKey(ticker: string, suffix: string) {
  return `${ticker.toUpperCase()}|${suffix}`;
}

export async function resolveTicker(ticker: string): Promise<TickerBoard> {
  const key = ticker.toUpperCase();
  if (resolveCache.has(key)) {
    const cached = resolveCache.get(key);
    if (cached) return cached;
    throw new Error(`Ticker not found: ${ticker}`);
  }

  try {
    const res = await axios.get(`${BASE_URL}/securities/${encodeURIComponent(key)}.json`, {
      params: { 'iss.meta': 'off' },
      headers: AXIOS_HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
    });

    const boards = res.data?.boards;
    if (!boards || !Array.isArray(boards.data) || boards.data.length === 0) {
      resolveCache.set(key, null);
      throw new Error(`Ticker not found: ${ticker}`);
    }

    const columns: string[] = boards.columns;
    const idx: Record<string, number> = {};
    columns.forEach((c, i) => (idx[c] = i));

    const primary = boards.data.find((row: any[]) => row[idx.is_primary] === 1 || row[idx.is_primary] === '1');
    const traded = boards.data.find((row: any[]) => row[idx.is_traded] === 1 || row[idx.is_traded] === '1');
    const row = primary || traded || boards.data[0];

    if (!row) {
      resolveCache.set(key, null);
      throw new Error(`Ticker not found: ${ticker}`);
    }

    const result: TickerBoard = {
      secid: row[idx.secid] || key,
      engine: row[idx.engine],
      market: row[idx.market],
      board: row[idx.boardid] || row[idx.board],
    };

    if (!result.engine || !result.market || !result.board) {
      resolveCache.set(key, null);
      throw new Error(`Incomplete board info for ticker: ${ticker}`);
    }

    console.log(`[MOEX] resolved ticker ${ticker}:`, result);
    resolveCache.set(key, result);
    return result;
  } catch (err: any) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      resolveCache.set(key, null);
      throw new Error(`Ticker not found: ${ticker}`);
    }
    throw new Error(`MOEX resolve failed: ${err.message}`);
  }
}

export async function getDailyCandles(ticker: string, days: number = 90): Promise<MarketCandle[]> {
  const cacheKeyDaily = cacheKey(ticker, `daily:${days}`);
  const cached = dailyCache.get(cacheKeyDaily);
  if (cached && cached.expiresAt > nowMs()) {
    return cached.data;
  }

  const board = await resolveTicker(ticker);
  const tillMsk = new Date();
  const fromMsk = new Date(tillMsk.getTime() - days * 24 * 60 * 60 * 1000);

  const url = `${BASE_URL}/engines/${encodeURIComponent(board.engine)}/markets/${encodeURIComponent(
    board.market
  )}/boards/${encodeURIComponent(board.board)}/securities/${encodeURIComponent(
    board.secid
  )}/candles.json`;

  try {
    // Daily candles: MOEX ISS expects YYYY-MM-DD for interval=24
    const fromStr = formatMskDate(fromMsk);
    const tillStr = formatMskDate(tillMsk);
    console.log(`[MOEX] daily candles request: ${url} from=${fromStr} till=${tillStr}`);

    const res = await axios.get(url, {
      params: {
        from: fromStr,
        till: tillStr,
        interval: 24,
        'iss.meta': 'off',
      },
      headers: AXIOS_HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
    });

    const candles = res.data?.candles;
    console.log(`[MOEX] daily candles raw response keys:`, Object.keys(res.data || {}), `candles rows:`, candles?.data?.length ?? 0);
    if (!candles || !Array.isArray(candles.data) || candles.data.length === 0) {
      dailyCache.set(cacheKeyDaily, { data: [], expiresAt: nowMs() + 15 * 60 * 1000 });
      return [];
    }

    const columns: string[] = candles.columns;
    const idx: Record<string, number> = {};
    columns.forEach((c, i) => (idx[c] = i));

    const data: MarketCandle[] = candles.data.map((row: any[]) => ({
      time: parseMskDate(row[idx.begin] as string).toISOString(),
      open: parseFloat(row[idx.open]),
      close: parseFloat(row[idx.close]),
      low: parseFloat(row[idx.low]),
      high: parseFloat(row[idx.high]),
      volume: row[idx.volume] !== undefined ? parseFloat(row[idx.volume]) : undefined,
    }));

    dailyCache.set(cacheKeyDaily, { data, expiresAt: nowMs() + 15 * 60 * 1000 });
    return data;
  } catch (err: any) {
    throw new Error(`MOEX daily candles failed: ${err.message}`);
  }
}

export async function getCurrentPrice(ticker: string): Promise<number | null> {
  const cacheKeyPrice = cacheKey(ticker, 'current');
  const cached = currentPriceCache.get(cacheKeyPrice);
  if (cached && cached.expiresAt > nowMs()) {
    return cached.price;
  }

  const board = await resolveTicker(ticker);
  const url = `${BASE_URL}/engines/${encodeURIComponent(board.engine)}/markets/${encodeURIComponent(
    board.market
  )}/boards/${encodeURIComponent(board.board)}/securities/${encodeURIComponent(
    board.secid
  )}/candles.json`;

  try {
    // Try today's 1-minute candles for the most recent close
    const { start, end } = getMoscowDayBounds(new Date());
    const res = await axios.get(url, {
      params: {
        from: formatMskLocal(start),
        till: formatMskLocal(end),
        interval: 1,
        'iss.meta': 'off',
      },
      headers: AXIOS_HEADERS,
      timeout: REQUEST_TIMEOUT_MS,
    });

    const candles = res.data?.candles;
    if (candles && Array.isArray(candles.data) && candles.data.length > 0) {
      const columns: string[] = candles.columns;
      const idx: Record<string, number> = {};
      columns.forEach((c, i) => (idx[c] = i));
      const lastRow = candles.data[candles.data.length - 1];
      const price = parseFloat(lastRow[idx.close]);
      if (!isNaN(price) && price > 0) {
        currentPriceCache.set(cacheKeyPrice, { price, expiresAt: nowMs() + 60 * 1000 });
        return price;
      }
    }
  } catch (err: any) {
    console.log(`[MOEX] intraday current price failed for ${ticker}: ${err.message}`);
  }

  try {
    // Fallback to the latest daily candle close
    const daily = await getDailyCandles(ticker, 5);
    if (daily.length > 0) {
      const last = daily[daily.length - 1];
      const price = last.close ?? null;
      currentPriceCache.set(cacheKeyPrice, { price, expiresAt: nowMs() + 60 * 1000 });
      return price;
    }
  } catch (err: any) {
    console.log(`[MOEX] daily fallback current price failed for ${ticker}: ${err.message}`);
  }

  currentPriceCache.set(cacheKeyPrice, { price: null, expiresAt: nowMs() + 60 * 1000 });
  return null;
}

export async function getIntraday5min(ticker: string, dateStr: string): Promise<MarketCandle[]> {
  const date = new Date(dateStr + 'T00:00:00+03:00');
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${dateStr}`);
  }

  const isToday = formatMskDate(new Date()) === dateStr;
  const cacheKeyIntra = cacheKey(ticker, `intraday:${dateStr}`);
  const cached = intradayCache.get(cacheKeyIntra);
  if (cached && cached.expiresAt > nowMs()) {
    return cached.data;
  }

  const board = await resolveTicker(ticker);
  const { start, end } = getMoscowDayBounds(date);

  const url = `${BASE_URL}/engines/${encodeURIComponent(board.engine)}/markets/${encodeURIComponent(
    board.market
  )}/boards/${encodeURIComponent(board.board)}/securities/${encodeURIComponent(
    board.secid
  )}/candles.json`;

  const all: MarketCandle[] = [];
  let current = new Date(start);

  try {
    console.log(`[MOEX] intraday request: ${url} date=${dateStr}`);
    while (current < end) {
      const chunkEnd = new Date(Math.min(current.getTime() + INTRADAY_CHUNK_MINUTES * 60 * 1000, end.getTime()));
      console.log(`[MOEX] intraday chunk from=${formatMskLocal(current)} till=${formatMskLocal(chunkEnd)}`);
      const res = await axios.get(url, {
        params: {
          from: formatMskLocal(current),
          till: formatMskLocal(chunkEnd),
          interval: 1,
          'iss.meta': 'off',
        },
        headers: AXIOS_HEADERS,
        timeout: REQUEST_TIMEOUT_MS,
      });

      const candles = res.data?.candles;
      console.log(`[MOEX] intraday chunk rows:`, candles?.data?.length ?? 0);
      if (candles && Array.isArray(candles.data) && candles.data.length > 0) {
        const columns: string[] = candles.columns;
        const idx: Record<string, number> = {};
        columns.forEach((c, i) => (idx[c] = i));

        for (const row of candles.data) {
          all.push({
            time: parseMskDate(row[idx.begin] as string).toISOString(),
            open: parseFloat(row[idx.open]),
            close: parseFloat(row[idx.close]),
            low: parseFloat(row[idx.low]),
            high: parseFloat(row[idx.high]),
            volume: row[idx.volume] !== undefined ? parseFloat(row[idx.volume]) : undefined,
          });
        }
        const lastTime = parseMskDate(candles.data[candles.data.length - 1][idx.end] as string);
        current = new Date(lastTime.getTime() + 1000);
      } else {
        current = chunkEnd;
      }
    }

    const aggregated = all.length > 0 ? aggregateTo5min(all) : [];
    const ttl = isToday ? 60 * 1000 : 365 * 24 * 60 * 60 * 1000;
    intradayCache.set(cacheKeyIntra, { data: aggregated, expiresAt: nowMs() + ttl });
    return aggregated;
  } catch (err: any) {
    throw new Error(`MOEX intraday candles failed: ${err.message}`);
  }
}
