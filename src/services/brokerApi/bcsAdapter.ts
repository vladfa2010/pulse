/**
 * PULSE — BCS Trade API adapter (read-only)
 *
 * Keycloak token exchange: refresh_token → access_token + new refresh_token
 * Portfolio: GET /trade-api-bff-portfolio/api/v1/portfolio
 */

import axios from 'axios';
import { BrokerAdapter, TestKeyResult, BrokerPosition } from './index';

const TOKEN_URL = 'https://be.broker.ru/trade-api-keycloak/realms/tradeapi/protocol/openid-connect/token';
const PORTFOLIO_URL = 'https://be.broker.ru/trade-api-bff-portfolio/api/v1/portfolio';
const REQUEST_TIMEOUT_MS = 15000;

const HEADERS = {
  'User-Agent': 'Pulse-Portfolio/1.0 (contact@inside-trade.ru)',
  'Accept': 'application/json',
};

function normalizeError(error: any): { code: string; status?: number; message: string } {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const message = error.response?.data?.error_description || error.response?.data?.error || error.message;
    if (status === 401) return { code: 'broker_key_invalid', status, message };
    if (status && status >= 500) return { code: 'broker_unavailable', status, message };
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return { code: 'broker_timeout', status, message: error.message };
    }
    return { code: 'broker_unavailable', status, message };
  }
  return { code: 'broker_unavailable', message: error?.message || String(error) };
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

async function exchangeRefreshToken(refreshToken: string): Promise<TokenResponse> {
  const params = new URLSearchParams();
  params.set('client_id', 'trade-api-read');
  params.set('grant_type', 'refresh_token');
  params.set('refresh_token', refreshToken);

  const res = await axios.post(TOKEN_URL, params.toString(), {
    headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: REQUEST_TIMEOUT_MS,
  });

  if (!res.data?.access_token) {
    throw Object.assign(new Error('No access_token in BCS token response'), { code: 'broker_unavailable' });
  }

  return res.data as TokenResponse;
}

async function getPortfolio(accessToken: string): Promise<any[]> {
  const res = await axios.get(PORTFOLIO_URL, {
    headers: { ...HEADERS, Authorization: `Bearer ${accessToken}` },
    timeout: REQUEST_TIMEOUT_MS,
  });
  return res.data?.portfolio || res.data?.positions || res.data?.data || res.data || [];
}

function parseBcsPosition(pos: any): BrokerPosition | null {
  const term = (pos.term || pos.paymentDate || '').toString().toUpperCase();
  if (term && term !== 'T0') return null;

  const type = (pos.type || pos.positionType || '').toString().toLowerCase();
  if (type === 'moneylimit') return null;
  if (type !== 'depolimit') return null;

  const ticker = (pos.ticker || pos.symbol || pos.code || pos.isin || '').toString().toUpperCase().trim();
  if (!ticker) return null;

  const quantity = parseFloat(pos.quantity ?? pos.balance ?? pos.currentPosition ?? 0);
  if (!isFinite(quantity) || quantity === 0) return null;

  const rawAvg = pos.balancePrice || pos.avgPrice || pos.averagePrice || pos.price || '0';
  const avgPrice = parseFloat(rawAvg);
  const avgPriceNormalized = !isFinite(avgPrice) || avgPrice === 0 ? null : avgPrice;

  const currency = (pos.currency || 'RUB').toString().toUpperCase();

  let exchange = (pos.exchange || pos.board || 'MOEX').toString().toUpperCase();
  if (exchange === 'TQBR' || exchange === 'TQTF' || exchange === 'TQTD') exchange = 'MOEX';

  const companyName = pos.displayName || pos.shortName || pos.name || ticker;
  const externalId = pos.isin || pos.ticker || ticker;

  return { ticker, exchange, companyName, quantity, avgPrice: avgPriceNormalized, currency, externalId };
}

async function retryOnce<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const norm = normalizeError(err);
    if (norm.code === 'broker_timeout' || norm.code === 'broker_unavailable') {
      console.log(`[BcsAdapter] ${label} failed (${norm.code}), retry once`);
      await new Promise(r => setTimeout(r, 1000));
      return await fn();
    }
    throw err;
  }
}

async function fetchPositions(refreshToken: string): Promise<{ positions: BrokerPosition[]; newToken: string }> {
  return retryOnce(async () => {
    const tokens = await exchangeRefreshToken(refreshToken);
    const raw = await getPortfolio(tokens.access_token);
    const seen = new Set<string>();
    const positions: BrokerPosition[] = [];

    for (const pos of raw) {
      const normalized = parseBcsPosition(pos);
      if (!normalized) continue;
      const key = `${normalized.ticker}|${normalized.exchange}`;
      if (seen.has(key)) continue;
      seen.add(key);
      positions.push(normalized);
    }

    return { positions, newToken: tokens.refresh_token };
  }, 'fetchPositions');
}

const bcsAdapter: BrokerAdapter = {
  broker: 'bcs',

  async testKey(refreshToken: string): Promise<TestKeyResult> {
    try {
      const { positions, newToken } = await fetchPositions(refreshToken);
      return { ok: true, positionsCount: positions.length, newToken };
    } catch (err: any) {
      const norm = normalizeError(err);
      return { ok: false, error: norm.code };
    }
  },

  async getPositions(refreshToken: string): Promise<{ positions: BrokerPosition[]; newToken?: string }> {
    try {
      return await fetchPositions(refreshToken);
    } catch (err: any) {
      const norm = normalizeError(err);
      throw new Error(norm.code);
    }
  },
};

export default bcsAdapter;
