/**
 * =============================================================================
 * PULSE — MCP-токены личного кабинета (ТЗ-183, Задача 2)
 * =============================================================================
 *
 * GET    /api/user/mcp-tokens — список (без хэшей; prefix для идентификации)
 * POST   /api/user/mcp-tokens — создание (≤5 активных, иначе 409; токен
 *                               показывается ОДИН раз; email юзеру, ИБ-10)
 * DELETE /api/user/mcp-tokens/:id — отзыв владельцем (только свой, soft revoke)
 *
 * Формат токена: pulse_mcp_ + 48 hex из crypto.randomBytes(24). В БД — только
 * SHA-256(hex). Срок жизни — 180 дней (ИБ-1).
 */

import { Router } from 'express';
import { randomBytes } from 'crypto';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import { sha256Token } from '../mcp/context';
import { sendMcpTokenCreatedEmail } from '../services/mcpEmails';

const router = Router();

const TOKEN_TTL_DAYS = 180;
const MAX_ACTIVE_TOKENS = 5;
const USE_SQLITE = process.env.USE_SQLITE === 'true';
const NOW = USE_SQLITE ? "datetime('now')" : 'NOW()';

function isValidName(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 64;
}

router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const result = await query(
      `SELECT id, name, prefix, scopes, created_at, expires_at, last_used_at, revoked_at
       FROM mcp_tokens WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.userId],
    );
    const now = Date.now();
    res.json({
      tokens: result.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        prefix: r.prefix,
        scopes: r.scopes,
        created_at: r.created_at,
        expires_at: r.expires_at,
        last_used_at: r.last_used_at,
        revoked_at: r.revoked_at,
        status: r.revoked_at ? 'revoked' : new Date(r.expires_at).getTime() <= now ? 'expired' : 'active',
      })),
      max_active: MAX_ACTIVE_TOKENS,
      ttl_days: TOKEN_TTL_DAYS,
    });
  } catch (err: any) {
    console.error('[McpTokens] GET list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch MCP tokens' });
  }
});

router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { name } = req.body ?? {};
    if (!isValidName(name)) {
      res.status(400).json({ error: 'Название токена обязательно (1..64 символов)' });
      return;
    }
    const cleanName = name.trim();

    const active = await query(
      `SELECT COUNT(*) AS n FROM mcp_tokens
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > ${NOW}`,
      [req.user!.userId],
    );
    if (Number(active.rows[0].n) >= MAX_ACTIVE_TOKENS) {
      res.status(409).json({
        error: `Активных токенов максимум ${MAX_ACTIVE_TOKENS}. Отзовите ненужный и создайте новый.`,
      });
      return;
    }

    const token = 'pulse_mcp_' + randomBytes(24).toString('hex');
    const hash = sha256Token(token);
    const prefix = token.slice(0, 22) + '…';

    await query(
      `INSERT INTO mcp_tokens (user_id, name, token_hash, prefix, scopes, expires_at)
       VALUES ($1, $2, $3, $4, 'read', ${USE_SQLITE
         ? "datetime('now', '+180 days')"
         : "NOW() + INTERVAL '180 days'"})`,
      [req.user!.userId, cleanName, hash, prefix],
    );
    const rowR = await query('SELECT id, expires_at FROM mcp_tokens WHERE token_hash = $1', [hash]);
    const row = rowR.rows[0];

    // Email-уведомление (ИБ-10): название, время, IP. Fire-and-forget.
    sendMcpTokenCreatedEmail(req.user!.userId, cleanName, req.ip || null).catch((e: any) =>
      console.warn('[McpTokens] created-email failed:', e.message),
    );

    // Токен показывается юзеру ОДИН раз — прямо в ответе создания
    res.status(201).json({ id: row.id, name: cleanName, token, expires_at: row.expires_at });
  } catch (err: any) {
    console.error('[McpTokens] POST create error:', err.message);
    res.status(500).json({ error: 'Failed to create MCP token' });
  }
});

router.delete('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const id = String(req.params.id || '');
    // Только свой токен; идемпотентно — уже отозван не ошибка
    const mine = await query('SELECT id, revoked_at FROM mcp_tokens WHERE id = $1 AND user_id = $2', [id, req.user!.userId]);
    if (mine.rows.length === 0) {
      res.status(404).json({ error: 'Токен не найден' });
      return;
    }
    if (!mine.rows[0].revoked_at) {
      await query(`UPDATE mcp_tokens SET revoked_at = ${NOW} WHERE id = $1`, [id]);
    }
    res.json({ ok: true, id });
  } catch (err: any) {
    console.error('[McpTokens] DELETE revoke error:', err.message);
    res.status(500).json({ error: 'Failed to revoke MCP token' });
  }
});

export default router;
