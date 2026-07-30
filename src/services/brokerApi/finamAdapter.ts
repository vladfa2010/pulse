/**
 * PULSE — Finam Trade API adapter (read-only)
 *
 * Wire-format fixes (2026-07-30):
 *   - Finam REST uses snake_case: account_ids, average_price, etc.
 *   - Numbers are wrapped in { value: string } objects.
 *   - Invalid/expired credentials return HTTP 500 { code: 2, message: '' }.
 *
 * Auth flow: secret → POST /v1/sessions → JWT
 *            JWT → POST /v1/sessions/details → account_ids
 *            GET /v1/accounts/{account_id} → positions
 */

import axios from 'axios';
import { BrokerAdapter, TestKeyResult, BrokerPosition } from './index';

const BASE_URL = 'https://api.finam.ru';
const REQUEST_TIMEOUT_MS = 15000;

const HEADERS = {
  'User-Agent': 'Pulse-Portfolio/1.0 (contact@inside-trade.ru)',
  'Accept': 'application/json',
  'Content-Type': 'application/json',
};

function isInMaintenanceWindow(): boolean {
  // 05:00–06:15 MSK daily
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const hour = msk.getUTCHours();
  const minute = msk.getUTCMinutes();
  if (hour !== 5) return false;
  return minute <= 15;
}

function isFinamUnauthorized(data: any): boolean {
  // Finam returns HTTP 500 with code: 2 for invalid/revoked credentials or expired sessions
  return data && data.code === 2 && data.message === '';
}

function parseTickerMic(symbol: string): { ticker: string; exchange: string; currency: string } {
  // Format: SBER@MISX, RU000A1053P7@MISX, MDLN@XNGS, SECZ@XNYS
  const parts = symbol.split('@');
  const ticker = (parts[0] || symbol).trim().toUpperCase();
  const mic = (parts[1] || 'MISX').trim().toUpperCase();

  if (mic === 'MISX') {
    return { ticker, exchange: 'MOEX', currency: 'RUB' };
  }
  if (mic === 'XNGS') {
    return { ticker, exchange: 'NASDAQ', currency: 'USD' };
  }
  if (mic === 'XNYS') {
    return { ticker, exchange: 'NYSE', currency: 'USD' };
  }
  // Keep other MICs as-is (e.g. XPAR, XETR, etc.)
  return { ticker, exchange: mic, currency: 'USD' };
}

function normalizeError(error: any): { code: string; status?: number; message: string } {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data;
    const message = data?.message || data?.error || error.message;

    if (status === 401 || isFinamUnauthorized(data)) {
      return { code: 'broker_key_invalid', status, message };
    }
    if (status === 503 && isInMaintenanceWindow()) {
      return { code: 'broker_maintenance', status, message: 'Finam maintenance window' };
    }
    if (status && status >= 500) {
      return { code: 'broker_unavailable', status, message };
    }
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return { code: 'broker_timeout', status, message: error.message };
    }
    return { code: 'broker_unavailable', status, message };
  }
  return { code: 'broker_unavailable', message: error?.message || String(error) };
}

function getNumberValue(value: any): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && value !== null && typeof value.value === 'string') {
    return value.value;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  return null;
}

function parseNumber(value: any): number | null {
  const raw = getNumberValue(value);
  if (raw === null || raw === undefined) return null;
  const parsed = parseFloat(String(raw));
  return isFinite(parsed) ? parsed : null;
}

async function getJwt(secret: string): Promise<string> {
  const res = await axios.post(
    `${BASE_URL}/v1/sessions`,
    { secret },
    { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS }
  );
  const token = res.data?.token;
  if (!token || typeof token !== 'string') {
    throw Object.assign(new Error('No token in Finam sessions response'), { code: 'broker_unavailable' });
  }
  return token;
}

async function getAccountIds(jwt: string): Promise<{ ids: string[]; readonly: boolean }> {
  const res = await axios.post(
    `${BASE_URL}/v1/sessions/details`,
    { token: jwt },
    { headers: { ...HEADERS, Authorization: `Bearer ${jwt}` }, timeout: REQUEST_TIMEOUT_MS }
  );
  const ids = res.data?.account_ids;
  const readonly = !!res.data?.readonly;
  const accounts = Array.isArray(ids)
    ? ids.map((a: any) => (typeof a === 'string' ? a : String(a.id || a.accountId || a)))
    : [];
  return { ids: accounts, readonly };
}

async function getAccountPositions(jwt: string, accountId: string): Promise<BrokerPosition[]> {
  const res = await axios.get(`${BASE_URL}/v1/accounts/${encodeURIComponent(accountId)}`, {
    headers: { ...HEADERS, Authorization: `Bearer ${jwt}` },
    timeout: REQUEST_TIMEOUT_MS,
  });

  const rawPositions = res.data?.positions || res.data?.data?.positions || res.data || [];
  if (!Array.isArray(rawPositions)) return [];

  const result: BrokerPosition[] = [];
  for (const pos of rawPositions) {
    const symbol = pos.symbol;
    if (!symbol || typeof symbol !== 'string') continue;

    // Cash rows are not part of positions array; skip anything that looks like money
    const type = (pos.type || pos.security_type || '').toString().toLowerCase();
    if (type.includes('cash') || type.includes('money') || symbol.toLowerCase() === 'cash') continue;

    const { ticker, exchange, currency } = parseTickerMic(symbol);
    const quantity = parseNumber(pos.quantity);
    if (quantity === null || quantity === 0) continue;

    const avgPrice = parseNumber(pos.average_price);
    // "0.0" / "0" / 0 means position transferred without purchase price — treat as NULL
    const avgPriceNormalized = avgPrice === null || avgPrice === 0 ? null : avgPrice;

    result.push({
      ticker,
      exchange,
      companyName: ticker,
      quantity,
      avgPrice: avgPriceNormalized,
      currency,
      externalId: symbol,
    });
  }
  return result;
}

async function fetchAccountPositionsWithRetry(
  secret: string,
  jwt: string,
  accountId: string,
  attempt = 1
): Promise<BrokerPosition[]> {
  try {
    return await getAccountPositions(jwt, accountId);
  } catch (err: any) {
    const norm = normalizeError(err);
    // Finam returns 500 {code:2} for expired sessions too. Retry once with a fresh JWT.
    if (norm.code === 'broker_key_invalid' && attempt === 1) {
      console.log('[FinamAdapter] Session expired or invalid, refreshing JWT and retrying once');
      const freshJwt = await getJwt(secret);
      return fetchAccountPositionsWithRetry(secret, freshJwt, accountId, attempt + 1);
    }
    throw err;
  }
}

async function retryOnce<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    const norm = normalizeError(err);
    if (norm.code === 'broker_timeout' || norm.code === 'broker_unavailable') {
      console.log(`[FinamAdapter] ${label} failed (${norm.code}), retry once`);
      await new Promise(r => setTimeout(r, 1000));
      return await fn();
    }
    throw err;
  }
}

async function fetchAllPositions(secret: string): Promise<{ positions: BrokerPosition[]; readonly: boolean }> {
  return retryOnce(async () => {
    const jwt = await getJwt(secret);
    const { ids: accountIds, readonly } = await getAccountIds(jwt);
    const all: BrokerPosition[] = [];
    for (const accountId of accountIds) {
      const positions = await fetchAccountPositionsWithRetry(secret, jwt, accountId);
      all.push(...positions);
    }
    return { positions: all, readonly };
  }, 'fetchAllPositions');
}

const finamAdapter: BrokerAdapter = {
  broker: 'finam',

  async testKey(secret: string): Promise<TestKeyResult> {
    try {
      const { positions, readonly } = await fetchAllPositions(secret);
      return { ok: true, positionsCount: positions.length, readonly };
    } catch (err: any) {
      const norm = normalizeError(err);
      if (norm.code === 'broker_maintenance') {
        return { ok: false, error: 'broker_maintenance' };
      }
      return { ok: false, error: norm.code };
    }
  },

  async getPositions(secret: string): Promise<{ positions: BrokerPosition[] }> {
    try {
      const { positions } = await fetchAllPositions(secret);
      return { positions };
    } catch (err: any) {
      const norm = normalizeError(err);
      if (norm.code === 'broker_maintenance') {
        return { positions: [] };
      }
      throw new Error(norm.code);
    }
  },
};

export default finamAdapter;
