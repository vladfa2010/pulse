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
