/**
 * =============================================================================
 * PULSE — MCP: статистика безопасности /mcp (ТЗ-190, Задачи 2 и 4)
 * =============================================================================
 *
 * Ежедневные счётчики трафика /mcp для базовой линии и алертинга. In-memory,
 * flush раз в минуту одним аккумулятором (паттерн counters.ts) — записи в БД
 * на каждый запрос не нужно.
 *
 * mcp_security_daily — дельты по дням (календарные, МСК): requests_total,
 * auth_fail_401 (невалидный токен), auth_limited_429 (mcpAuthLimiter),
 * token_limited_429 (mcpLimiter). Снятие метрик, сверка с базовой линией и
 * алертинг — startMcpSecurityCron (services/cron.ts).
 *
 * mcp_security_daily_ips — DISTINCT ip за день (МСК). IP-адреса в контуре
 * уже хранятся в mcp_audit_log на каждый вызов — отдельная таблица нужна
 * только для дешёвого дедупа «ip встречался в этот день».
 *
 * Upsert без ON CONFLICT DO UPDATE: диалекты расходятся (адаптер sqlite
 * ломает такой синтаксис подстановкой INSERT OR IGNORE), поэтому сначала
 * UPDATE, при 0 строк — INSERT с ON CONFLICT DO NOTHING (идемпотентно).
 */

import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const FLUSH_INTERVAL_MS = 60 * 1000;
/** Защита памяти: больше уникальных IP за день не набираем (для ленты и так за глаза) */
const MAX_IPS_PER_DAY = 10000;

/** Календарный день в Europe/Moscow (UTC+3, без DST с 2014) в формате YYYY-MM-DD */
export function mskDay(offsetDays = 0): string {
  return new Date(Date.now() + 3 * 3600 * 1000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

interface DayCounters {
  day: string;
  requests: number;
  fail401: number;
  auth429: number;
  token429: number;
}

let current: DayCounters = freshCounters();
const ipsToday = new Set<string>();

function freshCounters(): DayCounters {
  return { day: mskDay(), requests: 0, fail401: 0, auth429: 0, token429: 0 };
}

/** Сменился календарный день: накопленное уходит в flush, счётчики обнуляются */
function rolloverIfNeeded(): void {
  if (mskDay() === current.day) return;
  flushMcpSecurityStats().catch((e: any) =>
    console.warn('[MCP] security stats rollover flush failed:', e.message),
  );
  current = freshCounters();
  ipsToday.clear();
}

/** Каждый запрос, дошедший до цепочки /mcp */
export function recordMcpRequest(ip: string | undefined): void {
  rolloverIfNeeded();
  current.requests += 1;
  if (ip && ipsToday.size < MAX_IPS_PER_DAY) ipsToday.add(ip.slice(0, 45));
}

/** 401/403 — неудачная аутентификация токена (мусорный перебор) */
export function recordMcpAuthFail(): void {
  rolloverIfNeeded();
  current.fail401 += 1;
}

/** 429 от mcpAuthLimiter (20 неудач / 15 мин на IP исчерпаны) */
export function recordMcpAuthLimited(): void {
  rolloverIfNeeded();
  current.auth429 += 1;
}

/** 429 от mcpLimiter (120 запросов / 15 мин на токен исчерпаны) */
export function recordMcpTokenLimited(): void {
  rolloverIfNeeded();
  current.token429 += 1;
}

let flushing: Promise<void> | null = null;

/** Сброс накопленного в БД. Сериализован: параллельные вызовы ждут первый. */
export function flushMcpSecurityStats(): Promise<void> {
  if (!flushing) {
    flushing = doFlush().finally(() => {
      flushing = null;
    });
  }
  return flushing;
}

async function doFlush(): Promise<void> {
  const day = current.day;
  const requests = current.requests;
  const fail401 = current.fail401;
  const auth429 = current.auth429;
  const token429 = current.token429;
  const ips = [...ipsToday];
  current = freshCounters();
  ipsToday.clear();

  if (requests + fail401 + auth429 + token429 > 0) {
    const updated = await query(
      `UPDATE mcp_security_daily
       SET requests_total = requests_total + $2,
           auth_fail_401 = auth_fail_401 + $3,
           auth_limited_429 = auth_limited_429 + $4,
           token_limited_429 = token_limited_429 + $5,
           updated_at = ${USE_SQLITE ? "datetime('now')" : 'NOW()'}
       WHERE day = $1`,
      [day, requests, fail401, auth429, token429],
    );
    if (!updated.rowCount) {
      await query(
        `INSERT INTO mcp_security_daily
           (day, requests_total, auth_fail_401, auth_limited_429, token_limited_429)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [day, requests, fail401, auth429, token429],
      );
    }
  }

  for (const ip of ips) {
    await query(`INSERT INTO mcp_security_daily_ips (day, ip) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      day,
      ip,
    ]);
  }
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

export function startMcpSecurityFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushMcpSecurityStats().catch((e: any) =>
      console.warn('[MCP] security stats flush failed:', e.message),
    );
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
  console.log('[MCP] security stats flush scheduled (every 60s)');
}

export function stopMcpSecurityFlush(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
