/**
 * =============================================================================
 * PULSE — MCP: хелперы инструментов (аудит-обёртка, scope-гейт)
 * =============================================================================
 */

import type { CallToolResult } from '@modelcontextprotocol/server';
import type { McpContext } from '../context';
import { writeAudit } from '../audit';

/** Аудит-обёртка вызова инструмента: пишет след даже при падении (ТЗ-183 Задача 3) */
export async function runAudited(
  ctx: McpContext,
  tool: string,
  args: unknown,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const result = await fn();
    writeAudit({
      tokenId: ctx.tokenId, userId: ctx.userId, tool, args,
      status: 'ok', durationMs: Date.now() - started,
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    return result;
  } catch (e) {
    writeAudit({
      tokenId: ctx.tokenId, userId: ctx.userId, tool, args,
      status: 'error', durationMs: Date.now() - started,
      ip: ctx.ip, userAgent: ctx.userAgent,
    });
    throw e;
  }
}

export function textResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 1) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/** Проверка scope на вызове (ИБ-3): пересечение scope инструмента и scopes токена из БД */
export function hasScope(ctx: McpContext, required: string): boolean {
  return ctx.scopes.includes(required);
}
