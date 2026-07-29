/**
 * PULSE — Notification Settings API (новое, матричное).
 *
 * GET  /api/user/notification-matrix  → вся матрица продукт×канал
 * PUT  /api/user/notification-matrix  → { product, channel, enabled?, frequency? }
 * POST /api/user/notification-matrix/quiet-hours → { enabled?, start?, end? }
 *
 * Старые эндпоинты (/api/user/notification-settings, telegram-status,
 * email-digest) маппятся на матрицу — фронт можно переводить постепенно.
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  getUserSubscriptions,
  setSubscription,
  getQuietHours,
  setQuietHours,
  ensureDefaultSubscriptions,
  getDeliveryTarget,
} from '../services/notifications/subscriptions';
import { query } from '../config/db';
import {
  isValidProduct,
  isValidChannel,
  isValidFrequency,
  isValidQuietHoursTime,
  Product,
  Channel,
  CHANNEL_ORDER,
} from '../services/notifications/types';

const router = Router();

router.get('/notification-matrix', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    // Гарантируем, что у новых/legacy юзеров есть матрица
    await ensureDefaultSubscriptions(userId);

    const subs = await getUserSubscriptions(userId);
    const quiet = await getQuietHours(userId);

    // Активные каналы доставки, чтобы фронт мог подсветить "не подключено".
    // Email — неявный канал: адрес регистрации есть у каждого юзера, всегда активен.
    const channelsResult = await query(
      `SELECT channel, is_active FROM user_channels WHERE user_id = $1`,
      [userId]
    );
    const channels = channelsResult.rows.map((r: any) => ({ channel: r.channel, is_active: r.is_active }));
    if (!channels.find((c: any) => c.channel === 'email')) {
      channels.push({ channel: 'email', is_active: true });
    }

    // Push также активен, если есть VAPID подписка
    const pushSubResult = await query(
      `SELECT 1 FROM push_subscriptions WHERE user_id = $1 AND is_active = TRUE LIMIT 1`,
      [userId]
    );
    if (pushSubResult.rows.length > 0 && !channels.find((c: any) => c.channel === 'push')) {
      channels.push({ channel: 'push', is_active: true });
    }

    res.json({
      subscriptions: subs,
      quietHours: quiet,
      channels,
    });
  } catch (err: any) {
    console.error('[NotifAPI] GET matrix error:', err.message);
    res.status(500).json({ error: 'Failed to fetch notification matrix' });
  }
});

router.put('/notification-matrix', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { product, channel, enabled, frequency } = req.body;

    if (!isValidProduct(product)) {
      return res.status(400).json({ error: 'Invalid product' });
    }
    if (!isValidChannel(channel)) {
      return res.status(400).json({ error: 'Invalid channel' });
    }
    if (frequency !== undefined && !isValidFrequency(frequency)) {
      return res.status(400).json({ error: 'Invalid frequency' });
    }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled' });
    }

    await setSubscription(userId, product as Product, channel as Channel, { enabled, frequency });
    res.json({ success: true });
  } catch (err: any) {
    console.error('[NotifAPI] PUT matrix error:', err.message);
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

router.post('/notification-matrix/quiet-hours', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { enabled, start, end } = req.body;

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Invalid enabled' });
    }
    if (start !== undefined && !isValidQuietHoursTime(start)) {
      return res.status(400).json({ error: 'Invalid start time' });
    }
    if (end !== undefined && !isValidQuietHoursTime(end)) {
      return res.status(400).json({ error: 'Invalid end time' });
    }

    await setQuietHours(userId, { enabled, start, end });
    res.json({ success: true });
  } catch (err: any) {
    console.error('[NotifAPI] POST quiet-hours error:', err.message);
    res.status(500).json({ error: 'Failed to update quiet hours' });
  }
});

router.get('/notification-delivery-target', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { channel, product } = req.query as { channel?: string; product?: string };
    if (!channel || !isValidChannel(channel)) {
      return res.status(400).json({ error: 'Invalid channel' });
    }
    const target = await getDeliveryTarget(userId, channel as Channel, product as any);
    res.json({ channel, target: target?.target || null });
  } catch (err: any) {
    console.error('[NotifAPI] GET delivery target error:', err.message);
    res.status(500).json({ error: 'Failed to get delivery target' });
  }
});

export default router;
