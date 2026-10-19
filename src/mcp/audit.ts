/**
 * =============================================================================
 * PULSE — MCP: аудит вызовов (ТЗ-183, Задача 3 / ТЗ-185, Задача 3)
 * =============================================================================
 *
 * Запись на каждый вызов инструмента и на админские действия над токенами
 * (admin.revoke_token). В аудит НЕ падают: токен, тела ответов инструментов.
 * args обрезаются до 4 КБ. Срок хранения — 90 дней, автоочистка кроном
 * (startMcpCron, ИБ-5). ip/user_agent обрезаны (ИБ-8).
 */

import { query } from '../config/db';

const MAX_ARGS_BYTES = 4096;

export interface AuditEntry {
  tokenId: string | null;
  userId: string;
  tool: string;
  args: unknown;
  status: 'ok' | 'error';
  durationMs: number | null;
  ip: string | null;
  userAgent: string | null;
}

export function writeAudit(entry: AuditEntry): void {
  let argsJson = '{}';
  try {
    argsJson = JSON.stringify(entry.args ?? {});
  } catch {
    argsJson = '{"_unserializable":true}';
  }
  if (Buffer.byteLength(argsJson, 'utf8') > MAX_ARGS_BYTES) {
    argsJson = JSON.stringify({ _truncated: argsJson.slice(0, MAX_ARGS_BYTES) });
  }
  const p = query(
    `INSERT INTO mcp_audit_log (token_id, user_id, tool, args, status, duration_ms, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      entry.tokenId,
      entry.userId,
      entry.tool,
      argsJson,
      entry.status,
      entry.durationMs,
      entry.ip ? entry.ip.slice(0, 45) : null,
      entry.userAgent ? entry.userAgent.slice(0, 256) : null,
    ],
  );
  Promise.resolve(p).catch((e: any) => console.warn('[MCP] audit write failed:', e.message));
}

/** Обрезка длинных текстов в ответах инструментов (защита от раздувания контекста) */
export function truncateText(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '… [обрезано]';
}
