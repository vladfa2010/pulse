/**
 * =============================================================================
 * PULSE — Market provider router
 * =============================================================================
 *
 * Selects data provider by exchange. Front-end passes exchange and ticker;
 * this module returns a unified response shape regardless of provider.
 *
 * v1: MOEX only. Future providers (Finnhub for NASDAQ/NYSE) register below.
 */

import * as moexIssAdapter from './moexIssAdapter';
import type { MarketCandle } from './utils';

export const SUPPORTED_EXCHANGES = ['MOEX'];

export interface MarketProvider {
  getDailyCandles(ticker: string, days?: number): Promise<MarketCandle[]>;
  getIntraday5min(ticker: string, date: string): Promise<MarketCandle[]>;
  getCurrentPrice(ticker: string): Promise<number | null>;
}

const PROVIDERS: Record<string, MarketProvider> = {
  MOEX: moexIssAdapter,
};

export function getProvider(exchange: string): MarketProvider {
  const key = exchange.toUpperCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(`Exchange not supported: ${exchange}. Supported: ${SUPPORTED_EXCHANGES.join(', ')}`);
  }
  return provider;
}

export async function getDailyCandles(exchange: string, ticker: string, days?: number): Promise<MarketCandle[]> {
  return getProvider(exchange).getDailyCandles(ticker.toUpperCase(), days);
}

export async function getIntraday5min(exchange: string, ticker: string, date: string): Promise<MarketCandle[]> {
  return getProvider(exchange).getIntraday5min(ticker.toUpperCase(), date);
}

export async function getCurrentPrice(exchange: string, ticker: string): Promise<number | null> {
  const key = exchange.toUpperCase();
  if (!SUPPORTED_EXCHANGES.includes(key)) {
    return null;
  }
  return getProvider(key).getCurrentPrice(ticker.toUpperCase());
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
        const price = await getCurrentPrice(item.exchange, item.ticker);
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
