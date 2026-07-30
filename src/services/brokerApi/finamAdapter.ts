/**
 * PULSE — Finam Trade API adapter (read-only)
 *
 * https://api.finam.ru/docs/rest
 * Auth flow: secret → POST /v1/sessions → JWT
 *            JWT → POST /v1/sessions/details → account ids
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

function parseTickerMic(symbol: string): { ticker: string; exchange: string; currency: string } {
  // Format: SBER@MISX, MDLN@XNGS, SECZ@XNYS
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
    const message = error.response?.data?.message || error.response?.data?.error || error.message;
    if (status === 401) return { code: 'broker_key_invalid', status, message };
    if (status === 503 && isInMaintenanceWindow()) {
      return { code: 'broker_maintenance', status, message: 'Finam maintenance window' };
    }
    if (status && status >= 500) return { code: 'broker_unavailable', status, message };
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return { code: 'broker_timeout', status, message: error.message };
    }
    return { code: 'broker_unavailable', status, message };
  }
  return { code: 'broker_unavailable', message: error?.message || String(error) };
}

async function getJwt(secret: string): Promise<string> {
  const res = await axios.post(
    `${BASE_URL}/v1/sessions`,
    { secret },
    { headers: HEADERS, timeout: REQUEST_TIMEOUT_MS }
  );
  const token = res.data?.token || res.data?.access_token || res.data?.jwt;
  if (!token) {
    throw Object.assign(new Error('No JWT in sessions response'), { code: 'broker_unavailable' });
  }
  return token;
}

async function getAccountIds(jwt: string): Promise<string[]> {
  const res = await axios.post(
    `${BASE_URL}/v1/sessions/details`,
    { token: jwt },
    { headers: { ...HEADERS, Authorization: `Bearer ${jwt}` }, timeout: REQUEST_TIMEOUT_MS }
  );
  const accounts = res.data?.accounts || res.data?.accountIds || res.data?.data?.accounts || [];
  return Array.isArray(accounts) ? accounts.map((a: any) => (a.id || a.accountId || a).toString()) : [];
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
    const symbol = pos.symbol || pos.security || pos.code || pos.ticker;
    if (!symbol) continue;

    // Skip cash / equity rows (we only store securities)
    const type = (pos.type || pos.securityType || '').toString().toLowerCase();
    if (type.includes('cash') || type.includes('money') || symbol.toLowerCase() === 'cash') continue;

    const { ticker, exchange, currency } = parseTickerMic(symbol);
    const quantity = parseFloat(pos.quantity ?? pos.balance ?? pos.amount ?? 0);
    if (!isFinite(quantity) || quantity === 0) continue;

    const rawAvg = pos.average_price || pos.averagePrice || pos.avgPrice || pos.price || '0';
    const avgPrice = parseFloat(rawAvg);
    const avgPriceNormalized = !isFinite(avgPrice) || avgPrice === 0 ? null : avgPrice;

    const companyName = pos.shortName || pos.name || pos.securityName || ticker;

    result.push({
      ticker,
      exchange,
      companyName,
      quantity,
      avgPrice: avgPriceNormalized,
      currency,
      externalId: symbol,
    });
  }
  return result;
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

async function fetchAllPositions(secret: string): Promise<BrokerPosition[]> {
  return retryOnce(async () => {
    const jwt = await getJwt(secret);
    const accountIds = await getAccountIds(jwt);
    const all: BrokerPosition[] = [];
    for (const accountId of accountIds) {
      const positions = await getAccountPositions(jwt, accountId);
      all.push(...positions);
    }
    return all;
  }, 'fetchAllPositions');
}

const finamAdapter: BrokerAdapter = {
  broker: 'finam',

  async testKey(secret: string): Promise<TestKeyResult> {
    try {
      const positions = await fetchAllPositions(secret);
      return { ok: true, positionsCount: positions.length };
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
      const positions = await fetchAllPositions(secret);
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
