/**
 * =============================================================================
 * PULSE — Market provider router
 * =============================================================================
 *
 * Selects data provider by exchange. Front-end passes exchange and ticker;
 * this module returns a unified response shape regardless of provider.
 *
 * v2: Finam Trade API is the single active provider for MOEX, NASDAQ, NYSE.
 * MOEX ISS adapter is kept in the repo but not registered; it can be restored
 * by adding it back to PROVIDERS.
 */

import * as finamMarketAdapter from './finamMarketAdapter';
import type { MarketCandle } from './utils';

export const SUPPORTED_EXCHANGES = ['MOEX', 'NASDAQ', 'NYSE'];

export interface MarketProvider {
  getDailyCandles(ticker: string, exchange: string, days?: number): Promise<MarketCandle[]>;
  getIntraday5min(ticker: string, exchange: string, date: string): Promise<MarketCandle[]>;
  getCurrentPrice(ticker: string, exchange: string): Promise<number | null>;
}

export type ServedBy = 'finam';

const PROVIDERS: Record<string, MarketProvider> = {
  MOEX: finamMarketAdapter,
  NASDAQ: finamMarketAdapter,
  NYSE: finamMarketAdapter,
};

async function resolveProvider(exchange: string): Promise<MarketProvider> {
  const key = exchange.toUpperCase();
  const provider = PROVIDERS[key];
  if (provider) return provider;
  // MIC passthrough: any valid Finam MIC is served by the Finam adapter
  if (await finamMarketAdapter.isKnownMic(key)) return finamMarketAdapter;
  throw new Error(`Exchange not supported: ${exchange}. Supported aliases: ${SUPPORTED_EXCHANGES.join(', ')} + any Finam MIC`);
}

export async function getDailyCandles(
  exchange: string,
  ticker: string,
  days?: number
): Promise<{ candles: MarketCandle[]; provider: ServedBy }> {
  const provider = await resolveProvider(exchange);
  const candles = await provider.getDailyCandles(ticker.toUpperCase(), exchange.toUpperCase(), days);
  return { candles, provider: 'finam' };
}

export async function getIntraday5min(
  exchange: string,
  ticker: string,
  date: string
): Promise<{ candles: MarketCandle[]; provider: ServedBy }> {
  const provider = await resolveProvider(exchange);
  const candles = await provider.getIntraday5min(ticker.toUpperCase(), exchange.toUpperCase(), date);
  return { candles, provider: 'finam' };
}

export async function getCurrentPrice(
  exchange: string,
  ticker: string
): Promise<{ price: number | null; provider: ServedBy }> {
  try {
    const provider = await resolveProvider(exchange);
    const price = await provider.getCurrentPrice(ticker.toUpperCase(), exchange.toUpperCase());
    return { price, provider: 'finam' };
  } catch (err: any) {
    console.error(`[MarketRouter] getCurrentPrice failed for ${ticker}@${exchange}:`, err.message);
    return { price: null, provider: 'finam' }; // batch price fetches must not throw (existing contract)
  }
}

export async function getCurrentPricesBatch(
  items: { ticker: string; exchange: string }[]
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>();
  const uniqueItems = new Map<string, { ticker: string; exchange: string }>();

  for (const item of items) {
    const key = `${item.ticker.toUpperCase()}@${item.exchange.toUpperCase()}`;
    if (!uniqueItems.has(key)) {
      uniqueItems.set(key, { ticker: item.ticker.toUpperCase(), exchange: item.exchange.toUpperCase() });
    }
  }

  const todo = Array.from(uniqueItems.values());
  const CONCURRENCY = 10;

  async function worker(chunk: { ticker: string; exchange: string }[]) {
    for (const item of chunk) {
      const key = `${item.ticker}@${item.exchange}`;
      try {
        const { price } = await getCurrentPrice(item.exchange, item.ticker);
        result.set(key, price);
      } catch (err: any) {
        console.error(`[MarketRouter] getCurrentPrice failed for ${key}:`, err.message);
        result.set(key, null);
      }
    }
  }

  const promises: Promise<void>[] = [];
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    promises.push(worker(todo.slice(i, i + CONCURRENCY)));
  }
  await Promise.all(promises);

  return result;
}

export function getProvidersInfo() {
  return {
    primary: Object.keys(PROVIDERS).map((exchange) => ({ exchange, provider: 'finam' as const })),
    fallback: [] as { exchange: string; provider: string }[], // ISS отключён на период отладки
    supportedExchanges: SUPPORTED_EXCHANGES,
  };
}

// Discovery helpers — exposed through the router so the admin tab does not import the adapter directly.
export const getAssets = () => finamMarketAdapter.getAssets();
export const resolveTicker = (t: string) => finamMarketAdapter.resolveTicker(t);
export const getExchanges = () => finamMarketAdapter.getExchanges();
export const invalidateAssetsCache = () => finamMarketAdapter.invalidateAssetsCache();
