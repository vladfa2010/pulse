/**
 * =============================================================================
 * PULSE — MCP: ежедневная оценка безопасности /mcp (ТЗ-190, Задачи 2–4)
 * =============================================================================
 *
 * Раз в сутки (startMcpSecurityCron, 06:40 МСК) сверяет вчерашние счётчики
 * mcp_security_daily с базовой линией (среднее за предыдущие 7 дней) и при
 * превышении порогов:
 *   1. пишет строку в mcp_security_alerts (лента админ-табы «МСП»;
 *      UNIQUE(day, metric) — повторный прогон дня не дублирует алерты);
 *   2. шлёт сообщение админу в Telegram (TELEGRAM_ADMIN_CHAT_ID, best-effort).
 *
 * Пороги (ТЗ-190 Задача 2):
 *   - auth_fail_share: доля 401 (невалидный токен) > 10 % дневного трафика;
 *   - rate_limit_429: суммарные 429 лимитеров > max(10, 10 × базовая линия);
 *   - request_spike: запросов > max(100, 10 × базовая линия).
 * Дни с трафиком < MIN_DAILY_REQUESTS в оценку не берём — x10 от почти нуля
 * (замечание к ТЗ-190) не должен будить админа по ночам.
 */

import { query } from '../config/db';
import { sendTelegramMessage } from './telegram';
import { flushMcpSecurityStats } from '../mcp/securityStats';

/** Меньше запросов за день — статистики недостаточно, алерты не стреляем */
export const MIN_DAILY_REQUESTS = 50;
export const FAIL_SHARE_THRESHOLD = 0.1;
export const BASELINE_DAYS = 7;

export interface McpSecurityAlert {
  metric: 'auth_fail_share' | 'rate_limit_429' | 'request_spike';
  value: number;
  threshold: number;
  detail: string;
}

export const MCP_SECURITY_METRIC_LABELS: Record<string, string> = {
  auth_fail_share: 'Доля мусорных 401',
  rate_limit_429: 'Срабатывания лимитеров (429)',
  request_spike: 'Всплеск запросов',
};

function dayOffset(dayStr: string, offset: number): string {
  return new Date(new Date(`${dayStr}T00:00:00Z`).getTime() + offset * 86400000)
    .toISOString()
    .slice(0, 10);
}

function fmtValue(metric: string, v: number): string {
  return metric === 'auth_fail_share' ? `${(v * 100).toFixed(1)} %` : String(Math.round(v));
}

/**
 * Оценка одного дня. Возвращает снятые метрики и список алертов (каждый уже
 * записан в mcp_security_alerts; внешний код шлёт Telegram). Idempotent.
 */
export async function evaluateMcpSecurityDay(
  day: string,
): Promise<{ requests: number; fail401: number; limited429: number; alerts: McpSecurityAlert[] }> {
  const r = await query('SELECT * FROM mcp_security_daily WHERE day = $1', [day]);
  const row = r.rows[0];
  const requests = row ? Number(row.requests_total) : 0;
  const fail401 = row ? Number(row.auth_fail_401) : 0;
  const limited429 = row ? Number(row.auth_limited_429) + Number(row.token_limited_429) : 0;

  if (!row || requests < MIN_DAILY_REQUESTS) {
    console.log(
      `[MCP-Security] ${day}: requests=${requests} (< ${MIN_DAILY_REQUESTS}) — оценка пропущена`,
    );
    return { requests, fail401, limited429, alerts: [] };
  }

  const base = await query(
    `SELECT AVG(requests_total) AS req_avg, AVG(auth_limited_429 + token_limited_429) AS lim_avg
     FROM mcp_security_daily WHERE day >= $1 AND day < $2`,
    [dayOffset(day, -BASELINE_DAYS), day],
  );
  const reqBase = Number(base.rows[0]?.req_avg || 0);
  const limBase = Number(base.rows[0]?.lim_avg || 0);

  const candidates: McpSecurityAlert[] = [];

  const share = fail401 / requests;
  if (share > FAIL_SHARE_THRESHOLD) {
    candidates.push({
      metric: 'auth_fail_share',
      value: share,
      threshold: FAIL_SHARE_THRESHOLD,
      detail: `401 без валидного токена: ${fail401} из ${requests} запросов`,
    });
  }

  const limThreshold = Math.max(10, 10 * limBase);
  if (limited429 > limThreshold) {
    candidates.push({
      metric: 'rate_limit_429',
      value: limited429,
      threshold: limThreshold,
      detail: `429: mcpAuthLimiter=${row.auth_limited_429}, mcpLimiter=${row.token_limited_429}`,
    });
  }

  const reqThreshold = Math.max(100, 10 * reqBase);
  if (requests > reqThreshold) {
    candidates.push({
      metric: 'request_spike',
      value: requests,
      threshold: reqThreshold,
      detail: `запросов ${requests}, базовая линия ${reqBase.toFixed(0)}/день`,
    });
  }

  const alerts: McpSecurityAlert[] = [];
  for (const a of candidates) {
    const ins = await query(
      `INSERT INTO mcp_security_alerts (day, metric, value, threshold, detail)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [day, a.metric, a.value, a.threshold, a.detail],
    );
    if (ins.rowCount) alerts.push(a); // уже существовал — алерт за день не дублируем
  }

  return { requests, fail401, limited429, alerts };
}

/** Telegram-уведомление по свежим алертам дня. Best-effort, без env — пропуск. */
export async function sendMcpSecurityAlerts(day: string, alerts: McpSecurityAlert[]): Promise<void> {
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId || alerts.length === 0) return;
  for (const a of alerts) {
    const text =
      `🛡 <b>MCP security alert</b>\n` +
      `День: ${day} (МСК)\n` +
      `${MCP_SECURITY_METRIC_LABELS[a.metric]}: ${fmtValue(a.metric, a.value)} ` +
      `(порог ${fmtValue(a.metric, a.threshold)})\n` +
      `${a.detail}\n` +
      `Лента: Админка → МСП`;
    await sendTelegramMessage(chatId, text).catch(() => {});
  }
}

/** Полный прогон крона: flush хвоста → оценка вчерашнего дня → алерты. */
export async function runMcpSecurityDaily(): Promise<void> {
  await flushMcpSecurityStats();
  const day = new Date(Date.now() + 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);
  const { requests, fail401, limited429, alerts } = await evaluateMcpSecurityDay(day);
  await sendMcpSecurityAlerts(day, alerts);
  console.log(
    `[MCP-Security] ${day}: requests=${requests}, 401=${fail401}, 429=${limited429}, alerts=${alerts.length}`,
  );
}
