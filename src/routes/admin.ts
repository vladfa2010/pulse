import { Router } from 'express';
import bcrypt from 'bcrypt';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import { validate } from '../middleware/validate';
import {
  CreatePlanSchema,
  UpdatePlanSchema,
  CreatePromoCodeSchema,
  UpdatePromoCodeSchema,
  CreateFeatureSchema,
} from '../schemas/promo';
import {
  getAllPlans,
  getPlanById,
  getActiveSubscriberCount,
  parseDbJson,
  getUserSubscription,
  freezeExcessTags,
  unfreezeTagsUpToLimit,
  invalidatePlansCache,
  PLAN_BILLING_DAYS,
  addBillingPeriod,
} from '../services/subscription';
import { listAllFeatures, createFeature, updateFeature } from './features';
import { getPromoByCode } from '../services/promo';
import { logAdminChangedPlan, logAdminExtendedSubscription } from '../services/activityLog';
import { broadcastCalendarRefresh } from '../services/sse';
import { nowSql } from '../utils/nowSql';
import { getUserId } from '../utils/users';
import {
  listCalendarEventGroups,
  getCalendarEventGroup,
  createCalendarEventGroup,
  updateCalendarEventGroup,
  deleteCalendarEventGroup,
  restoreCalendarEventGroup,
  validateProviderSlice,
  ingestProviderSlice,
  getMskDateString,
  addDays,
  normalizeDbDate,
  PROVIDER_PRIORITY,
  invalidateCalendarCache,
  getCanonicalSnapshot,
  computeDiff,
  withCalendarTransaction,
  rewriteCanonicalFromRaw,
  getCalendarLlmEnabled,
} from '../services/calendar';
import {
  detectAdapter,
  getAdapterBySource,
  getAdapters,
  toRawRows,
  CalendarAdapter,
  isFeedSource,
  isAdapterReady,
} from '../services/calendarAdapters';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Middleware: check is_admin flag in database
export function adminMiddleware(req: AuthRequest, res: any, next: any) {
  authMiddleware(req, res, async () => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const result = await query(
        'SELECT is_admin FROM users WHERE id = $1',
        [userId]
      );

      const isAdmin = USE_SQLITE
        ? (result.rows[0]?.is_admin === 1)
        : (result.rows[0]?.is_admin === true);

      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      next();
    } catch {
      res.status(500).json({ error: 'Admin check failed' });
    }
  });
}

// GET /api/admin/users — list all users with payment totals
router.get('/users', adminMiddleware, async (_req, res) => {
  try {
    const sql = USE_SQLITE
      ? `SELECT 
           u.id, u.email, u.username, u.is_verified, u.is_admin, u.is_blocked,
           u.subscription_active, u.subscription_expires_at,
           u.subscription_auto_renew, u.subscription_plan,
           u.last_login_at, u.login_count, u.registration_source,
           u.news_count, u.created_at,
           COALESCE(p.total_payments, 0) as total_payments,
           COALESCE(p.total_amount, 0) as total_amount,
           COALESCE(t.tag_count, 0) as tag_count,
           COALESCE(c.active_channels, 0) as active_channels,
           COALESCE(r.read_count, 0) as articles_read
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*) as total_payments,
                  COALESCE(SUM(amount), 0) as total_amount
           FROM payments
           WHERE status = 'completed'
           GROUP BY user_id
         ) p ON p.user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*) as tag_count
           FROM portfolios GROUP BY user_id
         ) t ON t.user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*) as active_channels
           FROM user_channels WHERE is_active = 1 GROUP BY user_id
         ) c ON c.user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*) as read_count
           FROM user_news_reads GROUP BY user_id
         ) r ON r.user_id = u.id
         ORDER BY u.created_at DESC LIMIT 500`
      : `SELECT 
           u.id, u.email, u.username, u.is_verified, u.is_admin, u.is_blocked,
           u.subscription_active, u.subscription_expires_at,
           u.subscription_auto_renew, u.subscription_plan,
           u.last_login_at, u.login_count, u.registration_source,
           u.news_count, u.created_at,
           COALESCE(p.total_payments, 0)::int as total_payments,
           COALESCE(p.total_amount, 0)::float as total_amount,
           COALESCE(t.tag_count, 0)::int as tag_count,
           COALESCE(c.active_channels, 0)::int as active_channels,
           COALESCE(r.read_count, 0)::int as articles_read
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*)::int as total_payments,
                  COALESCE(SUM(amount), 0)::float as total_amount
           FROM payments
           WHERE status = 'completed'
           GROUP BY user_id
         ) p ON p.user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*)::int as tag_count
           FROM portfolios GROUP BY user_id
         ) t ON t.user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*)::int as active_channels
           FROM user_channels WHERE is_active = TRUE GROUP BY user_id
         ) c ON c.user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*)::int as read_count
           FROM user_news_reads GROUP BY user_id
         ) r ON r.user_id = u.id
         ORDER BY u.created_at DESC LIMIT 500`;

    const [result, totalResult] = await Promise.all([
      query(sql),
      query('SELECT COUNT(*) as total FROM users'),
    ]);

    const users = result.rows.map((row: any) => ({
      ...row,
      is_blocked: row.is_blocked === true || row.is_blocked === 1,
      subscription_auto_renew: row.subscription_auto_renew === true || row.subscription_auto_renew === 1,
      total_payments: Number(row.total_payments ?? 0),
      total_amount: Number(row.total_amount ?? 0),
      tag_count: Number(row.tag_count ?? 0),
      active_channels: Number(row.active_channels ?? 0),
      articles_read: Number(row.articles_read ?? 0),
    }));

    const total = parseInt(totalResult.rows[0]?.total || '0', 10);

    res.json({ users, total });
  } catch (err) {
    console.error('[Admin] Failed to fetch users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/admin/users/:id — detailed user profile for admin card (matches UserDetailModal)
router.get('/users/:id', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.params.id;

    const userSql = USE_SQLITE
      ? `SELECT
           u.id, u.email, u.username, u.is_verified, u.is_admin, u.is_blocked,
           u.subscription_active, u.subscription_plan, u.subscription_expires_at,
           u.subscription_auto_renew, u.auto_renew_failures, u.scheduled_plan_downgrade,
           u.last_login_at, u.login_count, u.registration_source, u.registration_ip,
           u.timezone, u.locale, u.cohort_date, u.news_count, u.created_at,
           COALESCE(p.total_amount, 0) as total_amount,
           COALESCE(p.total_payments, 0) as total_payments,
           COALESCE(r.read_count, 0) as articles_read
         FROM users u
         LEFT JOIN (
           SELECT user_id, COUNT(*) as total_payments, COALESCE(SUM(amount), 0) as total_amount
           FROM payments WHERE status = 'completed' GROUP BY user_id
         ) p ON p.user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*) as read_count FROM user_news_reads GROUP BY user_id
         ) r ON r.user_id = u.id
         WHERE u.id = $1`
      : `SELECT
           u.id, u.email, u.username, u.is_verified, u.is_admin, u.is_blocked,
           u.subscription_active, u.subscription_plan, u.subscription_expires_at,
           u.subscription_auto_renew, u.auto_renew_failures, u.scheduled_plan_downgrade,
           u.last_login_at, u.login_count, u.registration_source, u.registration_ip,
           u.timezone, u.locale, u.cohort_date, u.news_count, u.created_at,
           COALESCE(p.total_amount, 0)::float as total_amount,
           COALESCE(p.total_payments, 0)::int as total_payments,
           COALESCE(r.read_count, 0)::int as articles_read
         FROM users u
         LEFT JOIN (
           SELECT user_id, COUNT(*)::int as total_payments, COALESCE(SUM(amount), 0)::float as total_amount
           FROM payments WHERE status = 'completed' GROUP BY user_id
         ) p ON p.user_id = u.id
         LEFT JOIN (
           SELECT user_id, COUNT(*)::int as read_count FROM user_news_reads GROUP BY user_id
         ) r ON r.user_id = u.id
         WHERE u.id = $1`;

    const userResult = await query(userSql, [userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    const [paymentsResult, tagsResult, channelsResult, loginsResult, notifResult] = await Promise.all([
      query(`SELECT id, amount, status, method, plan_id, paid_at, created_at FROM payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]),
      query(`SELECT tag_id, tag_name, tag_type, created_at FROM portfolios WHERE user_id = $1 ORDER BY created_at DESC`, [userId]),
      query(`SELECT channel, target, is_active, created_at FROM user_channels WHERE user_id = $1`, [userId]),
      query(`SELECT date(login_at) as day, COUNT(*) as count FROM user_logins WHERE user_id = $1 AND login_at > ${USE_SQLITE ? "datetime('now', '-30 days')" : "NOW() - INTERVAL '30 days'"} GROUP BY date(login_at) ORDER BY day ASC`, [userId]),
      query(`SELECT user_id, tg_enabled, email_enabled, push_enabled FROM notification_settings WHERE user_id = $1`, [userId]),
    ]);

    res.json({
      user: {
        ...user,
        is_blocked: user.is_blocked === true || user.is_blocked === 1,
        subscription_auto_renew: user.subscription_auto_renew === true || user.subscription_auto_renew === 1,
        total_amount: Number(user.total_amount ?? 0),
        total_payments: Number(user.total_payments ?? 0),
        articles_read: Number(user.articles_read ?? 0),
      },
      payments: paymentsResult.rows.map((p: any) => ({
        ...p,
        amount: Number(p.amount ?? 0),
      })),
      total_amount: Number(user.total_amount ?? 0),
      tags: tagsResult.rows,
      channels: channelsResult.rows.map((r: any) => ({ ...r, is_active: r.is_active === true || r.is_active === 1 })),
      login_history: loginsResult.rows.map((r: any) => ({ day: r.day, count: Number(r.count) })),
      notifications: notifResult.rows[0] || null,
    });
  } catch (err: any) {
    console.error('[Admin] User detail error:', err.message);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// POST /api/admin/users/:id/toggle-admin — toggle admin flag
router.post('/users/:id/toggle-admin', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.params.id;

    const current = await query(`SELECT id, is_admin, email FROM users WHERE id = $1`, [userId]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentValue = USE_SQLITE ? current.rows[0].is_admin === 1 : current.rows[0].is_admin === true;
    const nextValue = !currentValue;

    if (req.user?.userId === userId && currentValue) {
      return res.status(409).json({ error: 'You cannot remove your own admin rights' });
    }

    await query(`UPDATE users SET is_admin = $1 WHERE id = $2`, [nextValue, userId]);
    res.json({ success: true, user_id: userId, is_admin: nextValue });
  } catch (err: any) {
    console.error('[Admin] Toggle admin error:', err.message);
    res.status(500).json({ error: 'Failed to toggle admin' });
  }
});

// POST /api/admin/users/:id/toggle-block — toggle block flag
router.post('/users/:id/toggle-block', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.params.id;

    if (req.user?.userId === userId) {
      return res.status(409).json({ error: 'You cannot block yourself' });
    }

    const current = await query(`SELECT id, is_blocked FROM users WHERE id = $1`, [userId]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const currentValue = USE_SQLITE ? current.rows[0].is_blocked === 1 : current.rows[0].is_blocked === true;
    const nextValue = !currentValue;

    await query(`UPDATE users SET is_blocked = $1 WHERE id = $2`, [nextValue, userId]);
    res.json({ success: true, user_id: userId, is_blocked: nextValue });
  } catch (err: any) {
    console.error('[Admin] Toggle block error:', err.message);
    res.status(500).json({ error: 'Failed to toggle block' });
  }
});

// POST /api/admin/users/:id/auto-renew — toggle subscription auto-renewal
router.post('/users/:id/auto-renew', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.params.id;
    const { enabled } = req.body;
    if (enabled === undefined) {
      return res.status(400).json({ error: 'enabled required' });
    }

    if (!await getUserId(userId)) {
      return res.status(404).json({ error: 'User not found' });
    }

    await query(`UPDATE users SET subscription_auto_renew = $1 WHERE id = $2`, [enabled, userId]);
    res.json({ success: true, user_id: userId, enabled });
  } catch (err: any) {
    console.error('[Admin] Toggle auto-renew error:', err.message);
    res.status(500).json({ error: 'Failed to toggle auto-renew' });
  }
});

// POST /api/admin/users/:id/change-plan — admin changes user subscription plan
router.post('/users/:id/change-plan', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const targetUserId = req.params.id;
    const { planId } = req.body;

    if (!planId || typeof planId !== 'string') {
      return res.status(400).json({ error: 'planId required' });
    }

    const plan = await getPlanById(planId);
    if (!plan || !plan.is_active || plan.deleted_at) {
      return res.status(400).json({ error: 'Invalid or inactive plan' });
    }

    const sub = await getUserSubscription(targetUserId);
    const previousPlan = sub.plan;

    // ADM-F: юзер обязан существовать — иначе UPDATE обновит 0 строк,
    // а API соврёт success: true.
    const exists = await query(`SELECT id FROM users WHERE id = $1`, [targetUserId]);
    if (exists.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // DEFSUB-16: любой платной план обязан выставить expires_at —
    // это единственный источник истины для доступа (computeAccessState).
    // Продлеваем от текущего expires_at, если он в будущем, иначе от NOW().
    // Длительность берём из PLAN_BILLING_DAYS, как в activateSubscription.
    const isFree = planId === 'free';
    let newExpiresAt: Date | null = null;
    if (!isFree) {
      const base = sub.expiresAt && sub.expiresAt > new Date() ? sub.expiresAt : new Date();
      newExpiresAt = addBillingPeriod(base, plan.billing_frequency);
    }

    await query(
      `UPDATE users
       SET subscription_plan = $1,
           subscription_active = $2,
           subscription_expires_at = $3,
           subscription_auto_renew = FALSE,
           scheduled_plan_downgrade = NULL
       WHERE id = $4`,
      [planId, !isFree, newExpiresAt, targetUserId]
    );

    await freezeExcessTags(targetUserId, planId);
    await unfreezeTagsUpToLimit(targetUserId, planId);

    const tagCounts = await query(
      `SELECT SUM(CASE WHEN is_frozen THEN 0 ELSE 1 END) as active,
              SUM(CASE WHEN is_frozen THEN 1 ELSE 0 END) as frozen
       FROM portfolios WHERE user_id = $1`,
      [targetUserId]
    );
    const activeTags = Number(tagCounts.rows[0]?.active || 0);
    const frozenTags = Number(tagCounts.rows[0]?.frozen || 0);

    logAdminChangedPlan(req.user!.userId, targetUserId, previousPlan, planId, frozenTags).catch(() => {});

    res.json({
      success: true,
      previousPlan,
      newPlan: planId,
      expiresAt: newExpiresAt ? newExpiresAt.toISOString() : null,
      activeTags,
      frozenTags,
    });
  } catch (err: any) {
    console.error('[Admin] Change plan error:', err.message);
    res.status(500).json({ error: 'Failed to change plan' });
  }
});

// POST /api/admin/users/:id/extend-subscription — admin updates subscription expiration date
router.post('/users/:id/extend-subscription', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const targetUserId = req.params.id;
    const { expiresAt, addMonths } = req.body;

    const previousResult = await query(
      `SELECT subscription_expires_at FROM users WHERE id = $1`,
      [targetUserId]
    );
    // ADM-F
    if (previousResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const previousExpiresAt = previousResult.rows[0]?.subscription_expires_at || null;

    let newExpiresAt: Date;

    if (expiresAt) {
      newExpiresAt = new Date(expiresAt);
      if (isNaN(newExpiresAt.getTime())) {
        return res.status(400).json({ error: 'Invalid expiresAt date' });
      }
    } else if (addMonths && typeof addMonths === 'number' && addMonths > 0) {
      const base = previousExpiresAt && new Date(previousExpiresAt) > new Date()
        ? new Date(previousExpiresAt)
        : new Date();
      // ADM-H: «месяц» = 30 дней, как в платёжном пути (без setMonth).
      // Публичный контракт кнопки (addMonths) не меняем: N мес = N × 30 дней.
      newExpiresAt = new Date(base.getTime() + addMonths * 30 * 24 * 60 * 60 * 1000);
    } else {
      return res.status(400).json({ error: 'expiresAt or addMonths required' });
    }

    await query(
      `UPDATE users
       SET subscription_expires_at = $1,
           subscription_active = TRUE,
           expiry_notified = '{}'
       WHERE id = $2`,
      [newExpiresAt.toISOString(), targetUserId]
    );

    await query(
      `DELETE FROM subscription_notifications_sent
       WHERE user_id = $1 AND type IN ('reminder_3d', 'reminder_1d')`,
      [targetUserId]
    );

    logAdminExtendedSubscription(
      req.user!.userId,
      targetUserId,
      previousExpiresAt,
      newExpiresAt.toISOString(),
      addMonths
    ).catch(() => {});

    res.json({
      success: true,
      previousExpiresAt,
      newExpiresAt: newExpiresAt.toISOString(),
    });
  } catch (err: any) {
    console.error('[Admin] Extend subscription error:', err.message);
    res.status(500).json({ error: 'Failed to extend subscription' });
  }
});

// GET /api/admin/activity-log — admin action history from user_events
router.get('/activity-log', adminMiddleware, async (req, res) => {
  try {
    const userId = req.query.userId as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const where = userId ? 'WHERE ue.user_id = $1' : '';
    const params: any[] = userId ? [userId] : [];

    const result = await query(
      `SELECT ue.id, ue.user_id, ue.event_type, ue.event_data, ue.created_at,
              target.email as target_email
       FROM user_events ue
       LEFT JOIN users target ON target.id = ue.user_id
       ${where}
       ORDER BY ue.created_at DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );

    const rows = result.rows.map((row: any) => ({
      ...row,
      event_data: parseDbJson(row.event_data) || {},
    }));

    const actorIds = rows
      .map((r: any) => r.event_data?.admin_id)
      .filter((id: any) => id && typeof id === 'string');

    const actorEmails: Record<string, string> = {};
    if (actorIds.length > 0) {
      const placeholders = actorIds.map((_: any, i: number) => `$${i + 1}`).join(',');
      const actorsResult = await query(
        `SELECT id, email FROM users WHERE id IN (${placeholders})`,
        actorIds
      );
      for (const actor of actorsResult.rows) {
        actorEmails[actor.id] = actor.email;
      }
    }

    res.json({
      logs: rows.map((row: any) => ({
        ...row,
        actor_email: actorEmails[row.event_data?.admin_id] || null,
      })),
    });
  } catch (err: any) {
    console.error('[Admin] Activity log error:', err.message);
    res.status(500).json({ error: 'Failed to fetch activity log' });
  }
});

// POST /api/admin/users/:id/reset-password — set new password
router.post('/users/:id/reset-password', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.params.id;
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    if (!await getUserId(userId)) {
      return res.status(404).json({ error: 'User not found' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
    res.json({ success: true, user_id: userId, message: 'Password reset successfully' });
  } catch (err: any) {
    console.error('[Admin] Reset password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// GET /api/admin/users/:id/delete-preview — show what will be deleted/cascade
router.get('/users/:id/delete-preview', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.params.id;
    if (req.user?.userId === userId) {
      return res.status(409).json({ error: 'You cannot delete yourself' });
    }

    const userResult = await query(
      `SELECT id, email, username, is_admin, subscription_expires_at, subscription_auto_renew, subscription_plan
       FROM users WHERE id = $1`,
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    const [ownedTags, sharedTags, paymentMethod] = await Promise.all([
      query(`SELECT tag_id, tag_name FROM user_defined_tags WHERE created_by = $1`, [userId]),
      query(`SELECT DISTINCT p.tag_id, udt.tag_name FROM portfolios p JOIN user_defined_tags udt ON udt.tag_id = p.tag_id WHERE p.user_id = $1 AND udt.created_by IS DISTINCT FROM $1`, [userId]),
      query(`SELECT provider, is_active FROM user_payment_methods WHERE user_id = $1 AND is_active = ${USE_SQLITE ? '1' : 'TRUE'} LIMIT 1`, [userId]),
    ]);

    const hasAutoRenew = (user.subscription_auto_renew === true || user.subscription_auto_renew === 1) && user.subscription_active;

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.username,
        is_admin: user.is_admin === true || user.is_admin === 1,
        subscription_expires_at: user.subscription_expires_at,
        payment_method: paymentMethod.rows[0]?.provider || null,
        has_auto_renew: hasAutoRenew,
      },
      owned_tags: ownedTags.rows,
      shared_portfolio_tags: sharedTags.rows,
      summary: {
        has_owned_tags: ownedTags.rows.length > 0,
        has_shared_tags: sharedTags.rows.length > 0,
        total_tags: ownedTags.rows.length + sharedTags.rows.length,
        has_auto_renew: hasAutoRenew,
        subscription_expires_at: user.subscription_expires_at,
      },
    });
  } catch (err: any) {
    console.error('[Admin] Delete preview error:', err.message);
    res.status(500).json({ error: 'Failed to preview deletion' });
  }
});

// DELETE /api/admin/users/:id — hard delete user and all cascade data
router.delete('/users/:id', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.params.id;
    if (req.user?.userId === userId) {
      return res.status(409).json({ error: 'You cannot delete yourself' });
    }

    if (!await getUserId(userId)) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Set owned tags to no owner instead of deleting
    await query(`UPDATE user_defined_tags SET created_by = NULL WHERE created_by = $1`, [userId]);
    await query(`DELETE FROM users WHERE id = $1`, [userId]);
    res.json({ success: true, user_id: userId, deleted: true });
  } catch (err: any) {
    console.error('[Admin] Delete user error:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// GET /api/admin/stats — dashboard stats
router.get('/stats', adminMiddleware, async (_req, res) => {
  try {
    const usersResult = await query('SELECT COUNT(*) FROM users');
    const premiumResult = await query(
      'SELECT COUNT(*) FROM users WHERE subscription_active = TRUE'
    );
    const newsResult = await query('SELECT COUNT(*) FROM news');
    const news24hResult = await query(
      USE_SQLITE
        ? "SELECT COUNT(*) FROM news WHERE created_at > datetime('now', '-24 hours')"
        : "SELECT COUNT(*) FROM news WHERE created_at > NOW() - INTERVAL '24 hours'"
    );
    const paymentsResult = await query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = \'completed\''
    );

    res.json({
      users: parseInt(usersResult.rows[0].count),
      premiumUsers: parseInt(premiumResult.rows[0].count),
      totalNews: parseInt(newsResult.rows[0].count),
      newsLast24h: parseInt(news24hResult.rows[0].count),
      totalRevenue: parseFloat(paymentsResult.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin Plans
// ═══════════════════════════════════════════════════════════════════════════

function normalizePlanRow(row: any): any {
  return {
    ...row,
    features: parseDbJson(row.features) || {},
    price: Number(row.price),
    is_active: USE_SQLITE ? Boolean(row.is_active) : row.is_active,
    is_popular: USE_SQLITE ? Boolean(row.is_popular) : row.is_popular,
  };
}

// GET /api/admin/plans
router.get('/plans', adminMiddleware, async (_req, res) => {
  try {
    const plans = await getAllPlans();
    res.json({ plans: plans.map(normalizePlanRow) });
  } catch (err: any) {
    console.error('[Admin] Plans list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// GET /api/admin/plans/:planId/subscribers
router.get('/plans/:planId/subscribers', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const planId = req.params.planId;

    const plan = await getPlanById(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const countSql = USE_SQLITE
      ? `SELECT COUNT(*) as cnt FROM users
         WHERE subscription_plan = $1 AND subscription_active = TRUE`
      : `SELECT COUNT(*)::int as cnt FROM users
         WHERE subscription_plan = $1 AND subscription_active = TRUE`;

    const listSql = USE_SQLITE
      ? `SELECT
           u.id,
           u.email,
           u.username as name,
           u.subscription_auto_renew as auto_renew,
           u.subscription_expires_at as subscription_end,
           COALESCE(MIN(p.paid_at), u.created_at) as subscription_start
         FROM users u
         LEFT JOIN payments p ON p.user_id = u.id AND p.plan_id = $1 AND p.status = 'completed'
         WHERE u.subscription_plan = $1 AND u.subscription_active = TRUE
         GROUP BY u.id, u.email, u.username, u.subscription_auto_renew, u.subscription_expires_at, u.created_at
         ORDER BY subscription_start DESC
         LIMIT 100`
      : `SELECT
           u.id,
           u.email,
           u.username as name,
           u.subscription_auto_renew as auto_renew,
           u.subscription_expires_at as subscription_end,
           COALESCE(MIN(p.paid_at), u.created_at) as subscription_start
         FROM users u
         LEFT JOIN payments p ON p.user_id = u.id AND p.plan_id = $1 AND p.status = 'completed'
         WHERE u.subscription_plan = $1 AND u.subscription_active = TRUE
         GROUP BY u.id, u.email, u.username, u.subscription_auto_renew, u.subscription_expires_at, u.created_at
         ORDER BY subscription_start DESC
         LIMIT 100`;

    const [countResult, listResult] = await Promise.all([
      query(countSql, [planId]),
      query(listSql, [planId]),
    ]);

    const total = Number(countResult.rows[0]?.cnt || 0);
    const subscribers = listResult.rows.map((row: any) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      auto_renew: row.auto_renew === true || row.auto_renew === 1,
      subscription_start: row.subscription_start,
      subscription_end: row.subscription_end,
    }));

    res.json({ subscribers, total });
  } catch (err: any) {
    console.error('[Admin] Plan subscribers error:', err.message);
    res.status(500).json({ error: 'Failed to fetch plan subscribers' });
  }
});

// POST /api/admin/plans
router.post('/plans', adminMiddleware, validate(CreatePlanSchema), async (req: AuthRequest, res) => {
  try {
    const body = req.body;

    if (body.billing_frequency === 'yearly' && body.yearly_discount > 0) {
      return res.status(400).json({ error: 'yearly_discount must be 0 for yearly billing frequency' });
    }

    const existing = await query(`SELECT 1 FROM subscription_plans WHERE id = $1`, [body.id]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Plan ID already exists' });
    }

    // Ensure only one popular plan
    if (body.is_popular) {
      await query(`UPDATE subscription_plans SET is_popular = FALSE`);
    }

    await query(
      `INSERT INTO subscription_plans
         (id, name, price, billing_frequency, yearly_discount, tag_limit, plan_level, features,
          is_active, is_popular, coming_soon_label, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        body.id,
        body.name,
        body.price,
        body.billing_frequency,
        body.yearly_discount,
        body.tag_limit,
        body.plan_level,
        JSON.stringify(body.features || {}),
        body.is_active,
        body.is_popular,
        body.coming_soon_label || null,
        body.display_order,
      ]
    );

    invalidatePlansCache();

    const plan = await getPlanById(body.id);
    res.status(201).json({ plan: plan ? normalizePlanRow(plan) : null });
  } catch (err: any) {
    console.error('[Admin] Create plan error:', err.message);
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

// PATCH /api/admin/plans/:planId
router.patch('/plans/:planId', adminMiddleware, validate(UpdatePlanSchema), async (req: AuthRequest, res) => {
  try {
    const planId = req.params.planId;
    const body = req.body;

    const plan = await getPlanById(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const subscriberCount = await getActiveSubscriberCount(planId);
    if (subscriberCount > 0) {
      const blockedFields = ['plan_level', 'billing_frequency', 'id'];
      for (const field of blockedFields) {
        if (body[field] !== undefined && body[field] !== (plan as any)[field]) {
          return res.status(409).json({
            error: `Cannot change '${field}': ${subscriberCount} active subscribers. Create new plan instead.`,
            subscriberCount,
            blockedFields,
          });
        }
      }
    }

    const newBillingFrequency = body.billing_frequency !== undefined ? body.billing_frequency : plan.billing_frequency;
    const newYearlyDiscount = body.yearly_discount !== undefined ? body.yearly_discount : plan.yearly_discount;
    if (newBillingFrequency === 'yearly' && newYearlyDiscount > 0) {
      return res.status(400).json({ error: 'yearly_discount must be 0 for yearly billing frequency' });
    }

    // Ensure only one popular plan
    if (body.is_popular) {
      await query(`UPDATE subscription_plans SET is_popular = FALSE WHERE id <> $1`, [planId]);
    }

    const allowed = ['name', 'price', 'billing_frequency', 'yearly_discount', 'tag_limit', 'features', 'is_active', 'is_popular', 'coming_soon_label', 'display_order'];
    const fields: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    for (const key of allowed) {
      if (body[key] !== undefined) {
        fields.push(`${key} = $${paramIdx}`);
        values.push(key === 'features' ? JSON.stringify(body[key]) : body[key]);
        paramIdx++;
      }
    }

    // Insurance: activating a plan must clear the "coming soon" block label
    // if the admin form did not explicitly send one.
    if (body.is_active === true && body.coming_soon_label === undefined) {
      fields.push(`coming_soon_label = $${paramIdx}`);
      values.push(null);
      paramIdx++;
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(planId);
    await query(
      `UPDATE subscription_plans SET ${fields.join(', ')}, updated_at = ${nowSql()} WHERE id = $${paramIdx}`,
      values
    );

    invalidatePlansCache();

    const updated = await getPlanById(planId);
    res.json({ plan: updated ? normalizePlanRow(updated) : null });
  } catch (err: any) {
    console.error('[Admin] Update plan error:', err.message);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

async function archivePlan(planId: string): Promise<{ subscriberCount: number; message: string }> {
  const plan = await getPlanById(planId);
  if (!plan) {
    const err: any = new Error('Plan not found');
    err.status = 404;
    throw err;
  }

  const pendingPayments = await query(
    `SELECT COUNT(*) as cnt FROM payments WHERE plan_id = $1 AND status = 'pending'`,
    [planId]
  );
  const pendingCount = Number(pendingPayments.rows[0]?.cnt || 0);
  if (pendingCount > 0) {
    const err: any = new Error(`Cannot archive: ${pendingCount} pending payments. Wait or cancel them.`);
    err.status = 409;
    err.pendingPayments = pendingCount;
    throw err;
  }

  const subscriberCount = await getActiveSubscriberCount(planId);
  await query(`UPDATE subscription_plans SET deleted_at = ${nowSql()} WHERE id = $1`, [planId]);
  invalidatePlansCache();

  return {
    subscriberCount,
    message: `Тариф архивирован. ${subscriberCount} активных подписчиков останутся на нём до конца оплаченного периода.`,
  };
}

// DELETE /api/admin/plans/:planId — soft delete (legacy alias for archive)
router.delete('/plans/:planId', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const planId = req.params.planId;
    const { subscriberCount, message } = await archivePlan(planId);

    res.json({
      deleted: true,
      plan_id: planId,
      active_subscribers: subscriberCount,
      message,
    });
  } catch (err: any) {
    console.error('[Admin] Delete plan error:', err.message);
    if (err.status) {
      return res.status(err.status).json({ error: err.message, pendingPayments: err.pendingPayments });
    }
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

// POST /api/admin/plans/:planId/archive — explicit archive action
router.post('/plans/:planId/archive', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const planId = req.params.planId;
    const { subscriberCount, message } = await archivePlan(planId);

    res.json({
      archived: true,
      plan_id: planId,
      active_subscribers: subscriberCount,
      message,
    });
  } catch (err: any) {
    console.error('[Admin] Archive plan error:', err.message);
    if (err.status) {
      return res.status(err.status).json({ error: err.message, pendingPayments: err.pendingPayments });
    }
    res.status(500).json({ error: 'Failed to archive plan' });
  }
});

// POST /api/admin/plans/:planId/restore
router.post('/plans/:planId/restore', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const planId = req.params.planId;
    await query(
      `UPDATE subscription_plans SET deleted_at = NULL, updated_at = ${nowSql()} WHERE id = $1`,
      [planId]
    );
    invalidatePlansCache();

    const plan = await getPlanById(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    res.json({ restored: true, plan: normalizePlanRow(plan) });
  } catch (err: any) {
    console.error('[Admin] Restore plan error:', err.message);
    res.status(500).json({ error: 'Failed to restore plan' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin Promo Codes
// ═══════════════════════════════════════════════════════════════════════════

function normalizePromoRow(row: any): any {
  return {
    ...row,
    applicable_plans: parseDbJson(row.applicable_plans),
    is_active: USE_SQLITE ? Boolean(row.is_active) : row.is_active,
  };
}

// GET /api/admin/promo-codes
router.get('/promo-codes', adminMiddleware, async (_req, res) => {
  try {
    const result = await query(
      `SELECT * FROM promo_codes ORDER BY created_at DESC`,
      []
    );
    res.json({ promos: result.rows.map(normalizePromoRow) });
  } catch (err: any) {
    console.error('[Admin] Promo list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch promo codes' });
  }
});

// POST /api/admin/promo-codes
router.post('/promo-codes', adminMiddleware, validate(CreatePromoCodeSchema), async (req: AuthRequest, res) => {
  try {
    const body = req.body;
    const userId = req.user!.userId;

    const existing = await getPromoByCode(body.code);
    if (existing) {
      return res.status(409).json({ error: 'Promo code already exists' });
    }

    const result = await query(
      `INSERT INTO promo_codes
         (code, description, discount_type, discount_value, applicable_plans, max_uses, valid_from, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        body.code,
        body.description || null,
        body.discount_type,
        body.discount_value,
        body.applicable_plans || null,
        body.max_uses || null,
        body.valid_from || nowSql(),
        body.expires_at || null,
        userId,
      ]
    );
    res.status(201).json({ promo: normalizePromoRow(result.rows[0]) });
  } catch (err: any) {
    console.error('[Admin] Create promo error:', err.message);
    res.status(500).json({ error: 'Failed to create promo code' });
  }
});

// PUT /api/admin/promo-codes/:id
router.put('/promo-codes/:id', adminMiddleware, validate(UpdatePromoCodeSchema), async (req: AuthRequest, res) => {
  try {
    const id = req.params.id;
    const body = req.body;

    const allowed = ['description', 'discount_type', 'discount_value', 'applicable_plans', 'max_uses', 'valid_from', 'expires_at', 'is_active'];
    const fields: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    for (const key of allowed) {
      if (body[key] !== undefined) {
        fields.push(`${key} = $${paramIdx}`);
        values.push(key === 'applicable_plans' && body[key] ? JSON.stringify(body[key]) : body[key]);
        paramIdx++;
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(id);
    await query(
      `UPDATE promo_codes SET ${fields.join(', ')}, updated_at = ${nowSql()} WHERE id = $${paramIdx}`,
      values
    );

    const result = await query(`SELECT * FROM promo_codes WHERE id = $1`, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promo code not found' });
    }
    res.json({ promo: normalizePromoRow(result.rows[0]) });
  } catch (err: any) {
    console.error('[Admin] Update promo error:', err.message);
    res.status(500).json({ error: 'Failed to update promo code' });
  }
});

// DELETE /api/admin/promo-codes/:id — deactivate (soft)
router.delete('/promo-codes/:id', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id;
    const result = await query(
      `UPDATE promo_codes SET is_active = FALSE, updated_at = ${nowSql()} WHERE id = $1 RETURNING *`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Promo code not found' });
    }
    res.json({ deactivated: true, promo: normalizePromoRow(result.rows[0]) });
  } catch (err: any) {
    console.error('[Admin] Deactivate promo error:', err.message);
    res.status(500).json({ error: 'Failed to deactivate promo code' });
  }
});

// GET /api/admin/promo-codes/:id/stats
router.get('/promo-codes/:id/stats', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const id = req.params.id;
    const promoResult = await query(`SELECT * FROM promo_codes WHERE id = $1`, [id]);
    if (promoResult.rows.length === 0) {
      return res.status(404).json({ error: 'Promo code not found' });
    }

    const totalUses = await query(
      `SELECT COUNT(*) as cnt FROM user_promo_uses WHERE promo_code_id = $1`,
      [id]
    );
    const uniqueUsers = await query(
      `SELECT COUNT(DISTINCT user_id) as cnt FROM user_promo_uses WHERE promo_code_id = $1`,
      [id]
    );
    const revenueImpact = await query(
      `SELECT COALESCE(SUM(discount_applied), 0) as total FROM user_promo_uses WHERE promo_code_id = $1`,
      [id]
    );
    const trialConversions = await query(
      `SELECT COUNT(DISTINCT uup.user_id) as cnt
       FROM user_promo_uses uup
       JOIN users u ON u.id = uup.user_id
       WHERE uup.promo_code_id = $1
         AND uup.trial_days_used IS NOT NULL
         AND u.subscription_active = TRUE
         AND u.subscription_expires_at > ${nowSql()}`,
      [id]
    );
    const recentUses = await query(
      `SELECT u.email as user_email, uup.plan_id, uup.created_at
       FROM user_promo_uses uup
       JOIN users u ON u.id = uup.user_id
       WHERE uup.promo_code_id = $1
       ORDER BY uup.created_at DESC
       LIMIT 10`,
      [id]
    );

    res.json({
      promo: normalizePromoRow(promoResult.rows[0]),
      total_uses: Number(totalUses.rows[0]?.cnt || 0),
      unique_users: Number(uniqueUsers.rows[0]?.cnt || 0),
      revenue_impact: Number(revenueImpact.rows[0]?.total || 0),
      trial_conversions: Number(trialConversions.rows[0]?.cnt || 0),
      recent_uses: recentUses.rows,
    });
  } catch (err: any) {
    console.error('[Admin] Promo stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch promo stats' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Admin Features
// ═══════════════════════════════════════════════════════════════════════════

router.get('/features', adminMiddleware, listAllFeatures);
router.post('/features', adminMiddleware, validate(CreateFeatureSchema), createFeature);
router.put('/features/:id', adminMiddleware, updateFeature);

// ═══════════════════════════════════════════════════════════════════════════
// Admin Calendar Events CRUD
// Routes are mounted under /api/admin, so full paths are:
//   GET    /api/admin/calendar/events
//   POST   /api/admin/calendar/events
//   PUT    /api/admin/calendar/events/:date/:title/:kind
//   DELETE /api/admin/calendar/events/:date/:title/:kind
// ═══════════════════════════════════════════════════════════════════════════

function calendarErrorStatus(err: any): number {
  if (err && typeof err.status === 'number') return err.status;
  if (err && err.message && typeof err.message === 'string') {
    const msg = err.message.toLowerCase();
    if (msg.includes('not found')) return 404;
    if (msg.includes('already exists')) return 409;
    if (msg.includes('invalid') || msg.includes('required') || msg.includes('must be') || msg.includes('duplicate')) return 400;
  }
  return 500;
}

// GET /api/admin/calendar/events/:date/:title/:kind
router.get('/calendar/events/:date/:title/:kind', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const date = decodeURIComponent(req.params.date);
    const title = decodeURIComponent(req.params.title);
    const kind = decodeURIComponent(req.params.kind);

    const event = await getCalendarEventGroup(date, title, kind);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    res.json({ event });
  } catch (err: any) {
    console.error('[Admin] Calendar event get error:', err.message);
    const status = calendarErrorStatus(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message || 'Failed to fetch calendar event' });
  }
});

// GET /api/admin/calendar/events
router.get('/calendar/events', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const filters = {
      search: req.query.search as string | undefined,
      kind: req.query.kind as string | undefined,
      status: req.query.status as string | undefined,
      possible_duplicate: req.query.possible_duplicate === 'true' ? true : undefined,
      tombstones: req.query.tombstones === 'true' ? true : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      offset: req.query.offset ? Number(req.query.offset) : undefined,
    };

    const { events, total } = await listCalendarEventGroups(filters);
    res.json({ events, total });
  } catch (err: any) {
    console.error('[Admin] Calendar events list error:', err.message);
    const status = calendarErrorStatus(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message || 'Failed to list calendar events' });
  }
});

// DELETE /api/admin/calendar/events/tombstone — restore a previously deleted event
router.delete('/calendar/events/tombstone', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const date = decodeURIComponent(req.query.date as string);
    const title = decodeURIComponent(req.query.title as string);
    const company = decodeURIComponent(req.query.company as string);
    const originalTitle = typeof req.query.original_title === 'string'
      ? decodeURIComponent(req.query.original_title)
      : undefined;

    await restoreCalendarEventGroup(date, title, company, originalTitle);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Admin] Calendar event restore error:', err.message);
    const status = calendarErrorStatus(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message || 'Failed to restore calendar event' });
  }
});

// POST /api/admin/calendar/events
router.post('/calendar/events', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    await createCalendarEventGroup(req.body);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Admin] Calendar event create error:', err.message);
    const status = calendarErrorStatus(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message || 'Failed to create calendar event' });
  }
});

// PUT /api/admin/calendar/events/:date/:title/:kind
router.put('/calendar/events/:date/:title/:kind', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const oldDate = decodeURIComponent(req.params.date);
    const oldTitle = decodeURIComponent(req.params.title);
    const oldKind = decodeURIComponent(req.params.kind);

    await updateCalendarEventGroup(oldDate, oldTitle, oldKind, req.body);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Admin] Calendar event update error:', err.message);
    const status = calendarErrorStatus(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message || 'Failed to update calendar event' });
  }
});

// DELETE /api/admin/calendar/events/:date/:title/:kind
router.delete('/calendar/events/:date/:title/:kind', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const date = decodeURIComponent(req.params.date);
    const title = decodeURIComponent(req.params.title);
    const kind = decodeURIComponent(req.params.kind);

    await deleteCalendarEventGroup(date, title, kind);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[Admin] Calendar event delete error:', err.message);
    const status = calendarErrorStatus(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message || 'Failed to delete calendar event' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Provider slice ingest (M3)
// POST /api/admin/calendar/:source
// GET  /api/admin/calendar/sources
// ═══════════════════════════════════════════════════════════════════════════

router.get('/calendar/sources', adminMiddleware, async (_req, res) => {
  try {
    const serverDate = await getMskDateString();
    const windowStart = addDays(serverDate, -2);

    const sourcesMeta = await query('SELECT source, uploaded_at, last_stale_alert_at, last_warnings FROM calendar_sources');
    const countsResult = await query(
      `SELECT source,
              COUNT(*) as cnt,
              COUNT(DISTINCT date) as days
       FROM calendar_events_raw
       GROUP BY source`
    );
    const counts = new Map<string, number>();
    const days = new Map<string, number>();
    for (const row of countsResult.rows) {
      counts.set(row.source, Number(row.cnt || 0));
      days.set(row.source, Number(row.days || 0));
    }

    const coverageResult = await query(
      `SELECT source, MAX(date) as max_date FROM calendar_events_raw
       WHERE source IN ('investmint', 'smartlab', 'bcs', 'global')
       GROUP BY source`
    );
    const coverage = new Map<string, string>();
    for (const row of coverageResult.rows) {
      const maxDate = normalizeDbDate(row.max_date);
      if (maxDate) coverage.set(row.source, maxDate);
    }

    const metaBySource = new Map<string, any>();
    for (const row of sourcesMeta.rows) {
      metaBySource.set(row.source, row);
    }

    function parseLastWarnings(raw: unknown): string[] {
      if (!raw || typeof raw !== 'string') return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    const result = PROVIDER_PRIORITY.map((source) => {
      const meta = metaBySource.get(source);
      const eventsCount = counts.get(source) || 0;
      const daysCount = days.get(source) || 0;
      const maxDate = coverage.get(source);
      const stale = isFeedSource(source)
        ? !!(maxDate && maxDate < windowStart && eventsCount > 0)
        : false;
      return {
        source,
        uploaded_at: meta?.uploaded_at ? new Date(meta.uploaded_at).toISOString() : null,
        events_count: eventsCount,
        days: daysCount,
        last_stale_alert_at: meta?.last_stale_alert_at ? new Date(meta.last_stale_alert_at).toISOString() : null,
        last_warnings: parseLastWarnings(meta?.last_warnings),
        stale,
        feed: isFeedSource(source),
        adapter_ready: isAdapterReady(source),
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error('[Admin] Calendar sources error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar sources' });
  }
});

// DELETE /api/admin/calendar/sources/:source — очистка среза провайдера.
// Поддерживается только legacy; остальные источники перезаписываются через POST ingest.
router.delete('/calendar/sources/:source', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const source = req.params.source;
    if (source !== 'legacy') {
      return res.status(400).json({ error: 'чистка поддерживается только для legacy' });
    }

    const snapshotBefore = await getCanonicalSnapshot();

    await withCalendarTransaction(async (q) => {
      await q(`DELETE FROM calendar_events_raw WHERE source = $1`, [source]);
      await q(`DELETE FROM calendar_sources WHERE source = $1`, [source]);
    });

    const { canonical } = await rewriteCanonicalFromRaw();
    const diff = computeDiff(snapshotBefore, canonical);

    if (diff.nonempty) {
      broadcastCalendarRefresh();
      invalidateCalendarCache();
    }

    res.json({ removed_events: diff.counts.removed_events });
  } catch (err: any) {
    console.error('[Admin] Calendar source delete error:', err.message);
    const status = calendarErrorStatus(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message || 'Failed to delete calendar source' });
  }
});

// GET /api/admin/calendar/settings — текущее состояние рубильника LLM.
router.get('/calendar/settings', adminMiddleware, async (_req: AuthRequest, res) => {
  try {
    const llm_enabled = await getCalendarLlmEnabled();
    res.json({ llm_enabled });
  } catch (err: any) {
    console.error('[Admin] Calendar settings get error:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar settings' });
  }
});

// PUT /api/admin/calendar/settings — включить/выключить LLM-матчинг тегов.
router.put('/calendar/settings', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const { llm_enabled } = req.body;
    if (typeof llm_enabled !== 'boolean') {
      return res.status(400).json({ error: 'llm_enabled must be a boolean' });
    }

    const value = llm_enabled ? 'true' : 'false';
    if (USE_SQLITE) {
      await query(
        `INSERT OR REPLACE INTO calendar_settings (key, value) VALUES (?, ?)`,
        ['llm_enabled', value]
      );
    } else {
      await query(
        `INSERT INTO calendar_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        ['llm_enabled', value]
      );
    }

    const enabled = await getCalendarLlmEnabled();
    res.json({ llm_enabled: enabled });
  } catch (err: any) {
    console.error('[Admin] Calendar settings put error:', err.message);
    res.status(500).json({ error: 'Failed to update calendar settings' });
  }
});

router.post('/calendar/:source', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const requestedSource = req.params.source;
    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
    const raw = req.body;

    let source = requestedSource;
    let adapter: CalendarAdapter | undefined;

    if (source === 'auto') {
      const detection = detectAdapter(raw);
      if (detection.ambiguous) {
        const candidates = getAdapters()
          .filter((a) => !a.stub)
          .map((a) => a.source);
        return res.status(400).json({ error: 'формат неоднозначен, укажите :source', candidates });
      }
      if (!detection.adapter) {
        return res.status(400).json({ error: 'формат не распознан' });
      }
      if (detection.adapter.stub) {
        return res.status(400).json({ error: 'источник пока не поддерживается' });
      }
      source = detection.adapter.source;
      adapter = detection.adapter;
    } else {
      adapter = getAdapterBySource(source);
      if (!adapter) {
        return res.status(400).json({ error: `неизвестный источник: ${source}` });
      }
      if (adapter.stub) {
        return res.status(400).json({ error: 'источник пока не поддерживается' });
      }
    }

    const { events, warnings: parseWarnings } = adapter.parse(raw);
    const serverDate = await getMskDateString();
    const validation = validateProviderSlice(source, events, serverDate);

    if (validation.reject) {
      return res.status(400).json({ error: validation.reject, warnings: validation.warnings });
    }

    const flatRows = toRawRows(events, source);
    const allWarnings = [...parseWarnings.details, ...validation.warnings];
    const { diff, generatedAt } = await ingestProviderSlice(source, flatRows, dryRun, allWarnings);

    if (!dryRun && diff.nonempty) {
      broadcastCalendarRefresh();
      invalidateCalendarCache();
    }

    const uniqueDates = new Set(events.map((e) => e.date));

    res.json({
      parsed: {
        days: uniqueDates.size,
        events: events.length,
        no_ticker: parseWarnings.noTicker || 0,
        skipped: parseWarnings.skipped || 0,
        warnings: allWarnings,
      },
      diff: diff.counts,
      samples: {
        new: diff.samples.new,
        removed: diff.samples.removed,
        upgraded: diff.samples.upgraded,
        updated: diff.samples.updated,
      },
      generated_at: generatedAt,
    });
  } catch (err: any) {
    console.error('[Admin] Calendar provider upload error:', err.message);
    const status = calendarErrorStatus(err);
    res.status(status).json({ error: status === 500 ? 'Internal error' : err.message || 'Failed to upload provider slice' });
  }
});

export default router;
