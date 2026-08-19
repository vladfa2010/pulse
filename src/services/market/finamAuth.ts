/**
 * Finam Trade API auth for market data (service-level key).
 * Secret (long-lived) -> POST /v1/sessions -> JWT (short-lived, cached in memory).
 * On 401 or HTTP 500 {code:2} the JWT is re-minted once and the request retried.
 */

import axios from 'axios';

export const FINAM_BASE_URL = 'https://api.finam.ru';

let cachedJwt: { token: string; obtainedAt: number } | null = null;
const JWT_TTL_MS = 15 * 60 * 1000; // re-mint every 15 min proactively

export function hasFinamKey(): boolean {
  return Boolean(process.env.FINAM_MARKET_SECRET);
}

export function isInMaintenanceWindow(now: Date = new Date()): boolean {
  // Daily maintenance 05:00–06:15 MSK
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const mins = msk.getUTCHours() * 60 + msk.getUTCMinutes();
  return mins >= 5 * 60 && mins < 6 * 60 + 15;
}

export async function getJwt(): Promise<string> {
  if (cachedJwt && Date.now() - cachedJwt.obtainedAt < JWT_TTL_MS) {
    return cachedJwt.token;
  }
  const secret = process.env.FINAM_MARKET_SECRET;
  if (!secret) {
    throw Object.assign(new Error('FINAM_MARKET_SECRET is not set'), { code: 'finam_no_key' });
  }
  const res = await axios.post(`${FINAM_BASE_URL}/v1/sessions`, { secret }, { timeout: 10000 });
  const token = res.data?.token;
  if (!token) {
    throw Object.assign(new Error('No token in Finam /v1/sessions response'), { code: 'finam_auth_failed' });
  }
  cachedJwt = { token, obtainedAt: Date.now() };
  return token;
}

export function dropJwt(): void {
  cachedJwt = null;
}

/** true for HTTP 401, and for HTTP 500 with body {code:2} (Finam signals expired session this way) */
export function isAuthError(err: any): boolean {
  const status = err?.response?.status;
  if (status === 401) return true;
  if (status === 500 && err?.response?.data?.code === 2) return true;
  return false;
}

/** Finam rate limit: 200 req/min per method */
export function isRateLimited(err: any): boolean {
  return err?.response?.status === 429;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Execute a Finam request with:
 *  - one silent re-auth retry on 401 / 500{code:2};
 *  - one retry after 1s backoff on 429; if 429 repeats, throw code 'finam_rate_limited'.
 */
export async function withFinamAuth<T>(fn: (jwt: string) => Promise<T>): Promise<T> {
  try {
    return await fn(await getJwt());
  } catch (err: any) {
    if (isAuthError(err)) {
      dropJwt();
      return await fn(await getJwt());
    }
    if (isRateLimited(err)) {
      await sleep(1000);
      try {
        return await fn(await getJwt());
      } catch (retryErr: any) {
        if (isRateLimited(retryErr)) {
          throw Object.assign(new Error('Finam rate limit exceeded (200 req/min)'), { code: 'finam_rate_limited' });
        }
        throw retryErr;
      }
    }
    throw err;
  }
}
