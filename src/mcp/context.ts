/**
 * =============================================================================
 * PULSE — MCP: контекст запроса и аутентификация токена (ТЗ-183, Задача 2)
 * =============================================================================
 *
 * MCP-токен принимается ТОЛЬКО из заголовка Authorization: Bearer (ИБ-2):
 * query-параметр ?token= из extractToken для MCP не используется — токен в
 * URL попадает в логи прокси/историю. Далее SHA-256 → mcp_tokens → свежий
 * SELECT is_admin/is_blocked (конвенция ТЗ-120: блок/снятие админа действуют
 * мгновенно). Единый неинформативный 401 «Invalid token» — не подсвечивать
 * злоумышленнику, что хэш существует (ИБ-6). Сам токен никогда не пишется
 * в логи/аудит — только token_id.
 */

import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import { query } from '../config/db';

export interface McpContext {
  tokenId: string;
  userId: string;
  isAdmin: boolean;
  /** scopes из строки БД (ИБ-3: на вызове проверяется пересечение, не из кэша) */
  scopes: string[];
  /** След расследования (ИБ-8) — снаружи, из Express-запроса */
  ip: string | null;
  userAgent: string | null;
}

export const MCP_AUTH_ERROR = { error: 'Invalid token' };

export function sha256Token(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function extractBearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return undefined;
  const token = h.slice('Bearer '.length).trim();
  return token.length > 0 ? token : undefined;
}

export type McpAuthResult =
  | { ok: true; ctx: McpContext }
  | { ok: false; reason: 'invalid' | 'blocked' };

/**
 * Аутентификация MCP-токена без отправки ответа: успех → ctx; иначе причина.
 * res.locals.mcpContext/mcpTokenId ставятся только на успехе (для keyGenerator
 * mcpLimiter). Единый неинформативный 401 «Invalid token» — на стороне
 * вызывающей цепочки (ИБ-6), токен никогда не эхом не возвращается.
 */
export async function tryAuthenticateMcpToken(
  req: Request,
  res: Response,
): Promise<McpAuthResult> {
  const token = extractBearer(req);
  if (!token) return { ok: false, reason: 'invalid' };
  try {
    const hash = sha256Token(token);
    const t = await query(
      `SELECT id, user_id, scopes FROM mcp_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > ${nowSql()}`,
      [hash],
    );
    const row = t.rows[0];
    if (!row) return { ok: false, reason: 'invalid' };
    // Свежая роль: блок/снятие is_admin действуют мгновенно (конвенция ТЗ-120)
    const u = await query('SELECT is_admin, is_blocked FROM users WHERE id = $1', [row.user_id]);
    const user = u.rows[0];
    const isAdmin = user?.is_admin === true || user?.is_admin === 1;
    const isBlocked = user?.is_blocked === true || user?.is_blocked === 1;
    if (isBlocked) return { ok: false, reason: 'blocked' };
    const ctx: McpContext = {
      tokenId: row.id,
      userId: row.user_id,
      isAdmin,
      scopes: String(row.scopes || 'read').split(',').map((s: string) => s.trim()).filter(Boolean),
      ip: (req.ip || null) as string | null,
      userAgent: (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null) as string | null,
    };
    res.locals.mcpContext = ctx;
    res.locals.mcpTokenId = row.id;
    return { ok: true, ctx };
  } catch (e: any) {
    console.error('[MCP] auth error:', e.message);
    return { ok: false, reason: 'invalid' };
  }
}

/** now() в диалекте БД (по образцу cron.ts) */
function nowSql(): string {
  return process.env.USE_SQLITE === 'true' ? "datetime('now')" : 'NOW()';
}
