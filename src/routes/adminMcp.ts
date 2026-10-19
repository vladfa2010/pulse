/**
 * =============================================================================
 * PULSE — Админ-таба «МСП»: реестр токенов и отзыв доступа (ТЗ-185)
 * =============================================================================
 *
 * GET  /api/admin/mcp/tokens — реестр всех токенов платформы (метаданные;
 *                              token_hash в ответ НЕ попадает никогда, ИБ-5).
 * POST /api/admin/mcp/tokens/:id/revoke — принудительный отзыв (идемпотентно;
 *                              email владельцу + аудит admin.revoke_token).
 *
 * Монтирование: app.use('/api/admin/mcp', adminLimiter, adminMcpRoutes) —
 * adminMiddleware внутри каждого роута (свежий is_admin, конвенция ТЗ-120).
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import { adminMiddleware } from '../middleware/admin';
import { query } from '../config/db';
import { writeAudit } from '../mcp/audit';
import { sendMcpRevokedByAdminEmail } from '../services/mcpEmails';

const router = Router();

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const NOW = USE_SQLITE ? "datetime('now')" : 'NOW()';

type SortKey = 'created_at' | 'last_used_at' | 'requests_count';

function isSortKey(v: unknown): v is SortKey {
  return v === 'created_at' || v === 'last_used_at' || v === 'requests_count';
}

/** GET /api/admin/mcp/tokens?q=&status=&sort= */
router.get('/tokens', adminMiddleware, async (req: Request, res: Response) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    const sortParam = req.query.sort;
    const sortKey = isSortKey(sortParam) ? sortParam : 'last_used_at';
    const sortDir = typeof req.query.dir === 'string' && req.query.dir === 'asc' ? 'ASC' : 'DESC';

    const conds: string[] = [];
    const params: unknown[] = [];
    if (q) {
      params.push(`%${q}%`);
      const ph = `$${params.length}`;
      conds.push(`(u.username ${USE_SQLITE ? 'LIKE' : 'ILIKE'} ${ph} OR u.email ${USE_SQLITE ? 'LIKE' : 'ILIKE'} ${ph} OR t.name ${USE_SQLITE ? 'LIKE' : 'ILIKE'} ${ph})`);
    }
    if (status === 'active') conds.push(`t.revoked_at IS NULL AND t.expires_at > ${NOW}`);
    else if (status === 'revoked') conds.push('t.revoked_at IS NOT NULL');
    else if (status === 'expired') conds.push(`t.revoked_at IS NULL AND t.expires_at <= ${NOW}`);

    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    // NULLS LAST — PG-диалект; SQLite по умолчанию ставит NULL последними при DESC
    const nullsLast = USE_SQLITE ? '' : ' NULLS LAST';
    const result = await query(
      `SELECT t.id, t.name, t.prefix, t.scopes, t.created_at, t.expires_at,
              t.last_used_at, t.revoked_at, t.revoked_by, t.requests_count,
              u.id AS user_id, u.username, u.email
       FROM mcp_tokens t JOIN users u ON u.id = t.user_id
       ${where}
       ORDER BY t.${sortKey} ${sortDir === 'ASC' ? 'ASC' : 'DESC'}${nullsLast}
       LIMIT 500`,
      params,
    );
    const now = Date.now();
    res.json({
      tokens: result.rows.map((r: any) => ({
        token_id: r.id,
        user: { id: r.user_id, username: r.username, email: r.email },
        name: r.name,
        prefix: r.prefix,
        scopes: r.scopes,
        created_at: r.created_at,
        expires_at: r.expires_at,
        last_used_at: r.last_used_at,
        revoked_at: r.revoked_at,
        revoked_by: r.revoked_by,
        requests_count: Number(r.requests_count),
        status: r.revoked_at ? 'revoked' : new Date(r.expires_at).getTime() <= now ? 'expired' : 'active',
      })),
    });
  } catch (err: any) {
    console.error('[AdminMcp] GET tokens error:', err.message);
    res.status(500).json({ error: 'Failed to fetch MCP tokens' });
  }
});

/** POST /api/admin/mcp/tokens/:id/revoke — идемпотентно */
router.post('/tokens/:id/revoke', adminMiddleware, async (req: Request, res: Response) => {
  const started = Date.now();
  const adminId = (req as any).user?.userId as string;
  const id = String(req.params.id || '');
  try {
    const r = await query(
      `SELECT t.id, t.name, t.revoked_at, t.user_id AS owner_id
       FROM mcp_tokens t WHERE t.id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) {
      res.status(404).json({ error: 'Токен не найден' });
      return;
    }
    if (!row.revoked_at) {
      await query(`UPDATE mcp_tokens SET revoked_at = ${NOW}, revoked_by = $2 WHERE id = $1`, [id, adminId]);
      // Email владельцу — юзер узнаёт мгновенно (смягчение права отзыва)
      sendMcpRevokedByAdminEmail(row.owner_id, row.name).catch((e: any) =>
        console.warn('[AdminMcp] revoke-email failed:', e.message),
      );
    }
    writeAudit({
      tokenId: id,
      userId: adminId,
      tool: 'admin.revoke_token',
      args: { token_id: id },
      status: 'ok',
      durationMs: Date.now() - started,
      ip: (req.ip || null) as string | null,
      userAgent: (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null) as string | null,
    });
    const fresh = await query(
      `SELECT id, name, revoked_at, revoked_by, user_id FROM mcp_tokens WHERE id = $1`,
      [id],
    );
    res.json({ ok: true, token: fresh.rows[0] });
  } catch (err: any) {
    console.error('[AdminMcp] POST revoke error:', err.message);
    writeAudit({
      tokenId: id,
      userId: adminId,
      tool: 'admin.revoke_token',
      args: { token_id: id },
      status: 'error',
      durationMs: Date.now() - started,
      ip: (req.ip || null) as string | null,
      userAgent: (typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null) as string | null,
    });
    res.status(500).json({ error: 'Failed to revoke MCP token' });
  }
});

export default router;
