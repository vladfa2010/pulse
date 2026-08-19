/**
 * Finam Trade API market data provider.
 * Symbol format: {ticker}@{MIC}  (SBER@MISX, MDLN@XNGS, IMOEX@MISX).
 */

import axios from 'axios';
import http2 from 'http2';
import { FINAM_BASE_URL, withFinamAuth, getJwt, dropJwt, hasFinamKey, isInMaintenanceWindow } from './finamAuth';
import type { MarketCandle } from './utils';

/** Our exchange aliases -> Finam MIC (ISO 10383). */
export const EXCHANGE_TO_MIC: Record<string, string> = {
  MOEX: 'MISX',
  NASDAQ: 'XNGS',
  NYSE: 'XNYS',
};

let exchangesCache: { at: number; list: { mic: string; name: string }[] } | null = null;
const EXCHANGES_TTL_MS = 24 * 3600 * 1000;

export async function getExchanges(): Promise<{ mic: string; name: string }[]> {
  if (exchangesCache && Date.now() - exchangesCache.at < EXCHANGES_TTL_MS) return exchangesCache.list;
  const res = await withFinamAuth((jwt) =>
    axios.get(`${FINAM_BASE_URL}/v1/exchanges`, { headers: { Authorization: jwt }, timeout: 10000 })
  );
  const list = res.data?.exchanges ?? [];
  exchangesCache = { at: Date.now(), list };
  return list;
}

export async function isKnownMic(code: string): Promise<boolean> {
  const c = code.toUpperCase();
  const list = await getExchanges();
  return list.some((e) => e.mic.toUpperCase() === c);
}

/**
 * Resolve our exchange value to a Finam MIC:
 *  1) alias from EXCHANGE_TO_MIC (MOEX -> MISX)
 *  2) the value itself, if it is a valid MIC from the Finam exchange list (XHKG, XTSE, ...)
 * Returns null for unknown values.
 */
export async function resolveMic(exchange: string): Promise<string | null> {
  const key = exchange.toUpperCase();
  if (EXCHANGE_TO_MIC[key]) return EXCHANGE_TO_MIC[key];
  return (await isKnownMic(key)) ? key : null;
}

// --- TTL caches (pattern from moexIssAdapter; mandatory — Finam limit is 200 req/min) ---
const TTL_DAILY_MS = 15 * 60 * 1000;               // daily candles
const TTL_INTRADAY_TODAY_MS = 60 * 1000;           // 5-min for the current day
const TTL_INTRADAY_PAST_MS = 365 * 24 * 3600 * 1000; // 5-min for past days (immutable)
const TTL_PRICE_MS = 60 * 1000;                    // latest quote
const TTL_EMPTY_MS = 15 * 60 * 1000;               // empty results cached too (invalid tickers)

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const dailyCache = new Map<string, CacheEntry<MarketCandle[]>>();
const intradayCache = new Map<string, CacheEntry<MarketCandle[]>>();
const priceCache = new Map<string, CacheEntry<number | null>>();

function cacheKey(ticker: string, exchange: string, suffix: string): string {
  return `${ticker.toUpperCase()}|${exchange.toUpperCase()}|${suffix}`;
}

function fromCache<T>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const hit = map.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.data;
  map.delete(key);
  return undefined;
}

function todayMsk(): string {
  const msk = new Date(Date.now() + 3 * 3600 * 1000);
  return msk.toISOString().slice(0, 10);
}

function parseDecimal(v: any): number {
  // Finam decimals come as { value: "276.54" }; volume may be "2.7871357E7"
  const raw = typeof v === 'object' && v !== null ? v.value : v;
  const n = parseFloat(String(raw));
  return Number.isFinite(n) ? n : 0;
}

function mapBar(bar: any): MarketCandle {
  return {
    time: new Date(bar.timestamp).toISOString(),
    open: parseDecimal(bar.open),
    high: parseDecimal(bar.high),
    low: parseDecimal(bar.low),
    close: parseDecimal(bar.close),
    volume: parseDecimal(bar.volume),
  };
}

async function fetchBars(symbol: string, timeframe: string, startIso: string, endIso: string): Promise<MarketCandle[]> {
  try {
    const res = await withFinamAuth((jwt) =>
      axios.get(`${FINAM_BASE_URL}/v1/instruments/${encodeURIComponent(symbol)}/bars`, {
        headers: { Authorization: jwt },
        params: {
          timeframe,
          'interval.start_time': startIso,
          'interval.end_time': endIso,
        },
        timeout: 15000,
      })
    );
    const bars = res.data?.bars ?? [];
    return bars.map(mapBar);
  } catch (err: any) {
    // Finam signals unknown tickers as HTTP 404 {code:5} — normalize so routes map it to 404
    if (err?.response?.status === 404) {
      throw Object.assign(new Error(`Security not found: ${symbol}`), { code: 'finam_not_found' });
    }
    throw err;
  }
}

function assertReady(): string {
  if (!hasFinamKey()) {
    throw Object.assign(new Error('Finam market key not configured'), { code: 'finam_no_key' });
  }
  if (isInMaintenanceWindow()) {
    throw Object.assign(new Error('Finam maintenance window (05:00–06:15 MSK)'), { code: 'finam_maintenance' });
  }
  return 'ok';
}

// --- MarketProvider implementation (exchange-aware signatures, see TZ §3) ---

export async function getDailyCandles(ticker: string, exchange: string, days = 90): Promise<MarketCandle[]> {
  assertReady();
  const mic = await resolveMic(exchange);
  if (!mic) {
    throw Object.assign(new Error(`Exchange not supported by Finam: ${exchange}`), { code: 'finam_bad_exchange' });
  }
  days = Math.min(Math.max(days, 1), 365); // clamp: Finam 400s/times out on huge windows
  const key = cacheKey(ticker, exchange, `d${days}`);
  const hit = fromCache(dailyCache, key);
  if (hit) return hit;

  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 3600 * 1000);
  const candles = await fetchBars(`${ticker}@${mic}`, 'TIME_FRAME_D', start.toISOString(), end.toISOString());
  dailyCache.set(key, { data: candles, expiresAt: Date.now() + (candles.length ? TTL_DAILY_MS : TTL_EMPTY_MS) });
  return candles;
}

export async function getIntraday5min(ticker: string, exchange: string, date: string): Promise<MarketCandle[]> {
  assertReady();
  const mic = await resolveMic(exchange);
  if (!mic) {
    throw Object.assign(new Error(`Exchange not supported by Finam: ${exchange}`), { code: 'finam_bad_exchange' });
  }
  const key = cacheKey(ticker, exchange, `m5_${date}`);
  const hit = fromCache(intradayCache, key);
  if (hit) return hit;

  // `date` is an MSK calendar day (YYYY-MM-DD) as used by the frontend.
  const start = new Date(`${date}T00:00:00+03:00`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const candles = await fetchBars(`${ticker}@${mic}`, 'TIME_FRAME_M5', start.toISOString(), end.toISOString());
  const ttl = candles.length === 0
    ? TTL_EMPTY_MS
    : date === todayMsk() ? TTL_INTRADAY_TODAY_MS : TTL_INTRADAY_PAST_MS;
  intradayCache.set(key, { data: candles, expiresAt: Date.now() + ttl });
  return candles;
}

export async function getCurrentPrice(ticker: string, exchange: string): Promise<number | null> {
  assertReady();
  const mic = await resolveMic(exchange);
  if (!mic) return null;
  const symbol = `${ticker}@${mic}`;
  const key = cacheKey(ticker, exchange, 'px');
  const hit = fromCache(priceCache, key);
  if (hit !== undefined) return hit;

  const res = await withFinamAuth((jwt) =>
    axios.get(`${FINAM_BASE_URL}/v1/instruments/${encodeURIComponent(symbol)}/quotes/latest`, {
      headers: { Authorization: jwt },
      timeout: 10000,
    })
  );
  const last = parseDecimal(res.data?.quote?.last);
  const price = last > 0 ? last : null;
  priceCache.set(key, { data: price, expiresAt: Date.now() + TTL_PRICE_MS });
  return price;
}

// --- Discovery helpers (used by admin tab, TZ-2) ---

let assetsCache: { at: number; assets: any[] } | null = null;
const ASSETS_TTL_MS = 24 * 3600 * 1000;

/**
 * GET /v1/assets returns ~3.5MB; Finam's transcoder deterministically 500s on it
 * over HTTP/1.1 (all axios/fetch/node-https clients). Over HTTP/2 it works.
 * Node's built-in http2 client is used for this endpoint only.
 */
function http2GetJson(path: string, jwt: string, timeoutMs = 30000): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const client = http2.connect(FINAM_BASE_URL);
    let status = 0;
    let body = '';

    const done = (err?: Error, statusCode = 0, payload = '') => {
      client.close();
      if (err) return reject(err);
      try {
        resolve({ status: statusCode, data: JSON.parse(payload) });
      } catch (e: any) {
        reject(new Error(`Finam http2: invalid JSON (status ${statusCode})`));
      }
    };

    client.on('error', (e) => done(e));
    const req = client.request({ ':path': path, ':method': 'GET', authorization: jwt });
    req.setTimeout(timeoutMs, () => done(new Error('Finam http2: timeout')));
    req.on('response', (headers) => { status = Number(headers[':status']) || 0; });
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => done(undefined, status, body));
    req.on('error', (e) => done(e));
    req.end();
  });
}

export async function getAssets(): Promise<any[]> {
  if (assetsCache && Date.now() - assetsCache.at < ASSETS_TTL_MS) return assetsCache.assets;

  // auth: reuse the same JWT lifecycle as the rest of the adapter
  const call = async () => {
    const jwt = await getJwt();
    const { status, data } = await http2GetJson('/v1/assets', jwt);
    if (status === 401 || (status === 500 && data?.code === 2)) {
      dropJwt();
      const jwt2 = await getJwt();
      const retry = await http2GetJson('/v1/assets', jwt2);
      if (retry.status !== 200) throw new Error(`Finam /v1/assets HTTP ${retry.status}`);
      return retry.data;
    }
    if (status === 429) {
      await new Promise((r) => setTimeout(r, 1000));
      const jwt2 = await getJwt();
      const retry = await http2GetJson('/v1/assets', jwt2);
      if (retry.status !== 200) {
        throw Object.assign(new Error('Finam rate limit exceeded (200 req/min)'), { code: 'finam_rate_limited' });
      }
      return retry.data;
    }
    if (status !== 200) throw new Error(`Finam /v1/assets HTTP ${status}`);
    return data;
  };

  const data = await call();
  const assets = data?.assets ?? [];
  assetsCache = { at: Date.now(), assets };
  return assets;
}

/** Manual invalidation for the admin tab (TZ-2): fresh IPOs/delistings appear without waiting 24h. */
export function invalidateAssetsCache(): void {
  assetsCache = null;
}

export async function resolveTicker(ticker: string): Promise<{ symbol: string; mic: string; name: string; type: string }[]> {
  const t = ticker.toUpperCase();
  const assets = await getAssets();
  return assets
    .filter((a: any) => a.ticker === t && !a.is_archived)
    .map((a: any) => ({ symbol: a.symbol, mic: a.mic, name: a.name, type: a.type }));
}
