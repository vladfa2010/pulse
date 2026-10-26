/**
 * =============================================================================
 * PULSE — TZ-197-club: эндпоинты закрытого Telegram-канала «Клуб» (ЛК)
 * =============================================================================
 *
 * Монтирование: app.use('/api/club', authMiddleware, clubRoutes) (src/index.ts).
 * Деградация без TELEGRAM_CLUB_CHAT_ID: GET /status работает как обычно,
 * invite/leave → 503 club_not_configured.
 *
 *   GET  /status  — eligible/eligibleReason, telegramConnected, membership,
 *                   joinedAt, channelUrl (+ ленивая сверка getChatMember)
 *   POST /invite  — revoke старой ссылки → createChatInviteLink(member_limit=1)
 *                   → upsert invited → logClubInviteIssued
 *   POST /leave   — kick (ban+unban) + revoke ссылки → status='left'
 */

import { Router } from 'express';
import { query } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { checkRateLimit, clubInviteLimiter } from '../middleware/rateLimit';
import { nowSql } from '../utils/nowSql';
import {
  isClubConfigured,
  getClubAccessInfo,
  getClubMembership,
  reconcileClubMembership,
  upsertClubInvite,
} from '../services/club';
import { createClubInviteLink, revokeClubInviteLink, kickClubMember } from '../services/telegram';
import { logClubInviteIssued } from '../services/activityLog';

const router = Router();

// GET /api/club/status
router.get('/status', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    const access = await getClubAccessInfo(userId);

    const channelResult = await query(
      `SELECT 1 AS ok FROM user_channels WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
      [userId]
    );
    const telegramConnected = channelResult.rows.length > 0;

    let row = await getClubMembership(userId);
    if (row && row.status === 'member') {
      // Ленивая сверка: в таблице member, а в канале нет → поправить на left.
      // Без env — no-op, отдаём статус из таблицы.
      row = await reconcileClubMembership(row);
    }

    const rawStatus = row?.status || 'none';
    // Контракт: none | invited | member | kicked (left сворачиваем в kicked —
    // для UI различие неважно, деталь в kickReason).
    const membership = rawStatus === 'left' ? 'kicked' : rawStatus;

    res.json({
      eligible: access.hasAccess,
      eligibleReason: access.hasAccess ? access.reason : 'none',
      telegramConnected,
      membership,
      joinedAt: row?.joined_at || null,
      kickReason: row?.kick_reason || null,
      channelUrl: row?.invite_link || null,
    });
  } catch (err: any) {
    console.error('[Club] GET /status failed:', err.message);
    res.status(500).json({ error: 'Failed to load club status' });
  }
});

// POST /api/club/invite
router.post('/invite', async (req: AuthRequest, res) => {
  try {
    if (!isClubConfigured()) {
      return res.status(503).json({ error: 'club_not_configured' });
    }
    if (!(await checkRateLimit(req, res, clubInviteLimiter))) return;

    const userId = req.user!.userId;

    const access = await getClubAccessInfo(userId);
    if (!access.hasAccess) {
      return res.status(403).json({ error: 'club_access_required' });
    }

    const channelResult = await query(
      `SELECT 1 AS ok FROM user_channels WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
      [userId]
    );
    if (channelResult.rows.length === 0) {
      return res.status(409).json({ error: 'telegram_not_connected' });
    }

    const existing = await getClubMembership(userId);
    if (existing?.invite_link) {
      await revokeClubInviteLink(existing.invite_link); // best-effort внутри
    }

    const inviteLink = await createClubInviteLink(userId.slice(0, 8));
    if (!inviteLink) {
      return res.status(502).json({ error: 'invite_failed' });
    }

    await upsertClubInvite(userId, inviteLink);
    logClubInviteIssued(userId).catch(() => {});
    console.log(`[Club] Invite issued user=${userId}`);

    res.json({ inviteLink });
  } catch (err: any) {
    console.error('[Club] POST /invite failed:', err.message);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// POST /api/club/leave — «выйти из канала» (обратный путь к вступлению обязателен)
router.post('/leave', async (req: AuthRequest, res) => {
  try {
    if (!isClubConfigured()) {
      return res.status(503).json({ error: 'club_not_configured' });
    }
    const userId = req.user!.userId;

    const row = await getClubMembership(userId);
    if (row) {
      if (row.status === 'member' && row.tg_user_id) {
        await kickClubMember(row.tg_user_id); // ban+unban — best-effort
      }
      if (row.invite_link) {
        await revokeClubInviteLink(row.invite_link);
      }
      // Фиксируем 'left' и из статуса 'invited' — регламент: видимый leave на join
      await query(
        `UPDATE telegram_club_members
         SET status = 'left', kick_reason = 'manual_leave', kicked_at = ${nowSql()}, updated_at = ${nowSql()}
         WHERE user_id = $1 AND status IN ('member', 'invited')`,
        [userId]
      );
      console.log(`[Club] Manual leave user=${userId}`);
    }

    res.json({ ok: true });
  } catch (err: any) {
    console.error('[Club] POST /leave failed:', err.message);
    res.status(500).json({ error: 'Failed to leave club' });
  }
});

export default router;
