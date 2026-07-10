/**
 * =============================================================================
 * PULSE — Subscription Service
 * =============================================================================
 *
 * Unified helpers for the 4+1 tariff system:
 *   - plan levels and feature checks
 *   - upgrade price calculation (prorated)
 *   - subscription activation with day accumulation
 *   - downgrade freeze/unfreeze
 *   - scheduled downgrade processing
 */

import { query } from '../config/db';
import { sendTelegramMessage } from './telegram';
import { sendPushNotification } from './push';
import { sendWebPushToUser } from './webPush';
import axios from 'axios';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export const PLAN_LEVELS: Record<string, number> = {
  free: 0,
  base: 1,
  premium: 2,
  club: 3,
  pro: 4,
};

export const PLAN_BILLING_DAYS = {
  monthly: 30,
  yearly: 365,
};

export interface Plan {
  id: string;
  name: string;
  price_monthly: number;
  price_yearly: number;
  yearly_discount: number;
  tag_limit: number;
  features: Record<string, any>;
  display_order: number;
  is_active: boolean;
  coming_soon_label: string | null;
}

export interface SubscriptionStatus {
  plan: string;
  active: boolean;
  expiresAt: string | null;
  autoRenew: boolean;
  daysLeft: number;
  inGracePeriod: boolean;
  scheduledDowngrade: string | null;
}

// ─── SQL helpers ───────────────────────────────────────────────────────────
function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

function nowPlusDaysSql(days: number): string {
  return USE_SQLITE
    ? `datetime('now', '${days >= 0 ? '+' : ''}${days} days')`
    : `NOW() + INTERVAL '${days} days'`;
}

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
const IS_YOOKASSA_CONFIGURED = YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY;

function yookassaAuth(): string {
  return 'Basic ' + Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
}

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ─── Plan helpers ──────────────────────────────────────────────────────────
export function planLevel(planId: string): number {
  return PLAN_LEVELS[planId] ?? 0;
}

export function isAtLeast(currentPlanId: string, minPlanId: string): boolean {
  return planLevel(currentPlanId) >= planLevel(minPlanId);
}

export function isPaid(planId: string): boolean {
  return planLevel(planId) >= 1;
}

export async function getPlanById(planId: string): Promise<Plan | null> {
  const result = await query(`SELECT * FROM subscription_plans WHERE id = $1`, [planId]);
  return result.rows[0] || null;
}

export async function getActivePlans(): Promise<Plan[]> {
  const result = await query(
    `SELECT * FROM subscription_plans ORDER BY display_order ASC`,
    []
  );
  return result.rows;
}

// ─── User subscription helpers ─────────────────────────────────────────────
export async function getUserSubscription(userId: string): Promise<{
  plan: string;
  active: boolean;
  expiresAt: Date | null;
  autoRenew: boolean;
  scheduledDowngrade: string | null;
}> {
  const result = await query(
    `SELECT subscription_plan, subscription_active, subscription_expires_at,
            subscription_auto_renew, scheduled_plan_downgrade
     FROM users WHERE id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) {
    return { plan: 'free', active: false, expiresAt: null, autoRenew: false, scheduledDowngrade: null };
  }
  return {
    plan: row.subscription_plan || 'free',
    active: !!row.subscription_active,
    expiresAt: row.subscription_expires_at ? new Date(row.subscription_expires_at) : null,
    autoRenew: !!row.subscription_auto_renew,
    scheduledDowngrade: row.scheduled_plan_downgrade || null,
  };
}

export function buildSubscriptionStatus(sub: ReturnType<typeof getUserSubscription> extends Promise<infer T> ? T : never): SubscriptionStatus {
  const now = Date.now();
  const expires = sub.expiresAt ? sub.expiresAt.getTime() : 0;
  const graceEnd = expires + 3 * 24 * 60 * 60 * 1000;

  let active = false;
  let inGrace = false;
  let daysLeft = 0;

  if (!sub.expiresAt) {
    active = false;
  } else if (now < expires) {
    active = true;
    daysLeft = Math.max(0, Math.ceil((expires - now) / (24 * 60 * 60 * 1000)));
  } else if (now < graceEnd) {
    active = true; // grace period keeps features
    inGrace = true;
    daysLeft = Math.max(0, Math.ceil((graceEnd - now) / (24 * 60 * 60 * 1000)));
  } else {
    active = false;
    daysLeft = 0;
  }

  return {
    plan: sub.plan,
    active,
    expiresAt: sub.expiresAt ? sub.expiresAt.toISOString() : null,
    autoRenew: sub.autoRenew,
    daysLeft,
    inGracePeriod: inGrace,
    scheduledDowngrade: sub.scheduledDowngrade,
  };
}

// ─── Upgrade price calculation ─────────────────────────────────────────────
export interface UpgradePreview {
  currentPlan: string;
  targetPlan: string;
  billingCycle: 'monthly' | 'yearly';
  daysLeft: number;
  topUpAmount: number;
  fullPrice: number;
  newPeriodDays: number;
  description: string;
  canUpgrade: boolean;
}

export async function calculateUpgradePrice(
  currentPlanId: string,
  targetPlanId: string,
  billingCycle: 'monthly' | 'yearly',
  subscriptionExpiresAt: Date | null
): Promise<UpgradePreview> {
  const currentPlan = await getPlanById(currentPlanId);
  const targetPlan = await getPlanById(targetPlanId);

  if (!currentPlan || !targetPlan) {
    throw new Error('Plan not found');
  }

  const currentPrice =
    billingCycle === 'monthly' ? Number(currentPlan.price_monthly) : Number(currentPlan.price_yearly);
  const targetPrice =
    billingCycle === 'monthly' ? Number(targetPlan.price_monthly) : Number(targetPlan.price_yearly);
  const daysInPeriod = PLAN_BILLING_DAYS[billingCycle];

  const now = new Date();
  const expires = subscriptionExpiresAt ? new Date(subscriptionExpiresAt) : null;
  const msPerDay = 24 * 60 * 60 * 1000;

  let daysLeft = 0;
  if (expires && expires.getTime() > now.getTime()) {
    daysLeft = Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / msPerDay));
  }

  // Same-price plan switch or expired/free → full price
  const samePrice = currentPrice === targetPrice;
  const isExpiredOrFree = !expires || expires.getTime() <= now.getTime() || currentPlanId === 'free';

  let topUpAmount = targetPrice;
  if (!isExpiredOrFree && !samePrice && targetPrice > currentPrice) {
    const remainingValue = currentPrice * (daysLeft / daysInPeriod);
    const newRemainingValue = targetPrice * (daysLeft / daysInPeriod);
    topUpAmount = Math.round(newRemainingValue - remainingValue);
  }

  topUpAmount = Math.max(0, topUpAmount);

  return {
    currentPlan: currentPlanId,
    targetPlan: targetPlanId,
    billingCycle,
    daysLeft,
    topUpAmount,
    fullPrice: targetPrice,
    newPeriodDays: daysInPeriod,
    description: `Доплата ${currentPlanId} → ${targetPlanId} (${daysLeft} дн. осталось)`,
    canUpgrade: planLevel(targetPlanId) > planLevel(currentPlanId) || samePrice,
  };
}

// ─── Subscription activation ───────────────────────────────────────────────
export async function activateSubscription(
  userId: string,
  planId: string,
  durationDays: number,
  paymentId?: string,
  isUpgrade?: boolean
): Promise<void> {
  const now = new Date();

  // Portable expiry calculation
  let newExpires: Date;
  if (isUpgrade) {
    // Баг 1: при апгрейде обнуляем период (ТЗ раздел 4.5)
    newExpires = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
  } else {
    // Обычное продление — накопление дней
    const currentResult = await query(
      `SELECT subscription_expires_at FROM users WHERE id = $1`,
      [userId]
    );
    const currentExpires = currentResult.rows[0]?.subscription_expires_at
      ? new Date(currentResult.rows[0].subscription_expires_at)
      : null;
    const base = currentExpires && currentExpires.getTime() > now.getTime() ? currentExpires : now;
    newExpires = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);
  }

  await query(
    `UPDATE users
     SET subscription_active = TRUE,
         subscription_plan = $1,
         subscription_expires_at = $2,
         scheduled_plan_downgrade = NULL
     WHERE id = $3`,
    [planId, newExpires.toISOString(), userId]
  );

  // Reset reminder notifications so they fire again before the next renewal
  await query(
    `DELETE FROM subscription_notifications_sent
     WHERE user_id = $1 AND type IN ('reminder_3d', 'reminder_1d')`,
    [userId]
  );

  // Unfreeze tags that now fit into the new plan limit
  await unfreezeTagsUpToLimit(userId, planId);

  // Record renewal
  if (paymentId) {
    await query(
      `INSERT INTO subscription_renewals
         (user_id, plan_id, billing_cycle, payment_id, status, period_start, period_end)
       SELECT $1, $2, p.billing_cycle, p.id, 'completed', $3, $4
       FROM payments p WHERE p.id = $5`,
      [userId, planId, now.toISOString(), newExpires.toISOString(), paymentId]
    );
  }
}

// ─── Tag freeze / unfreeze ─────────────────────────────────────────────────
export async function freezeExcessTags(userId: string, planId: string): Promise<number> {
  const plan = await getPlanById(planId);
  if (!plan || plan.tag_limit < 0) return 0; // unlimited

  // Select tags to freeze (newest beyond limit)
  const result = await query(
    `SELECT id FROM portfolios
     WHERE user_id = $1 AND is_frozen = FALSE
     ORDER BY created_at DESC
     OFFSET $2`,
    [userId, plan.tag_limit]
  );

  let frozen = 0;
  for (const row of result.rows) {
    await query(`UPDATE portfolios SET is_frozen = TRUE WHERE id = $1`, [row.id]);
    frozen++;
  }

  // Audit log
  if (frozen > 0) {
    const tags = await query(
      `SELECT tag_id, tag_name, tag_type FROM portfolios WHERE user_id = $1 AND is_frozen = TRUE`,
      [userId]
    );
    for (const tag of tags.rows) {
      await query(
        `INSERT INTO frozen_tags (user_id, tag_id, tag_name, tag_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, tag_id) DO UPDATE SET frozen_at = ${nowSql()}, unfrozen_at = NULL`,
        [userId, tag.tag_id, tag.tag_name, tag.tag_type]
      );
    }
  }

  return frozen;
}

export async function unfreezeTagsUpToLimit(userId: string, planId: string): Promise<number> {
  const plan = await getPlanById(planId);
  if (!plan || plan.tag_limit < 0) {
    // unlimited → unfreeze all
    const result = await query(
      `UPDATE portfolios SET is_frozen = FALSE WHERE user_id = $1 AND is_frozen = TRUE RETURNING id`,
      [userId]
    );
    if (result.rows.length > 0) {
      await query(
        `UPDATE frozen_tags SET unfrozen_at = ${nowSql()} WHERE user_id = $1 AND unfrozen_at IS NULL`,
        [userId]
      );
    }
    return result.rows.length;
  }

  // Count active tags
  const activeResult = await query(
    `SELECT COUNT(*)::int as cnt FROM portfolios WHERE user_id = $1 AND is_frozen = FALSE`,
    [userId]
  );
  const activeCount = activeResult.rows[0]?.cnt || 0;
  const slots = Math.max(0, plan.tag_limit - activeCount);
  if (slots <= 0) return 0;

  const toUnfreeze = await query(
    `SELECT id, tag_id FROM portfolios
     WHERE user_id = $1 AND is_frozen = TRUE
     ORDER BY created_at ASC
     LIMIT $2`,
    [userId, slots]
  );

  let unfrozen = 0;
  for (const row of toUnfreeze.rows) {
    await query(`UPDATE portfolios SET is_frozen = FALSE WHERE id = $1`, [row.id]);
    await query(
      `UPDATE frozen_tags SET unfrozen_at = ${nowSql()} WHERE user_id = $1 AND tag_id = $2 AND unfrozen_at IS NULL`,
      [userId, row.tag_id]
    );
    unfrozen++;
  }
  return unfrozen;
}

// ─── Payment methods ───────────────────────────────────────────────────────
export async function savePaymentMethod(userId: string, pm: any): Promise<void> {
  if (!pm || !pm.id) return;
  const card = pm.card || {};
  await query(
    `INSERT INTO user_payment_methods
       (user_id, payment_method_id, provider, card_last4, card_brand, card_expiry, is_active, is_default)
     VALUES ($1, $2, 'yookassa', $3, $4, $5, TRUE, TRUE)
     ON CONFLICT (user_id, payment_method_id) DO UPDATE SET
       card_last4 = EXCLUDED.card_last4,
       card_brand = EXCLUDED.card_brand,
       card_expiry = EXCLUDED.card_expiry,
       is_active = TRUE`,
    [userId, pm.id, card.last4 || null, card.card_type || null, card.expiry_date || null]
  );
}

// ─── Auto-renewal ──────────────────────────────────────────────────────────
export async function processAutoRenewals(): Promise<{
  processed: number;
  errors: number;
  disabled: number;
}> {
  const result = { processed: 0, errors: 0, disabled: 0 };

  if (!IS_YOOKASSA_CONFIGURED) {
    console.log('[AutoRenew] YooKassa is not configured, skipping');
    return result;
  }

  const windowStart = USE_SQLITE
    ? "datetime('now', '-1 day')"
    : "NOW() - INTERVAL '1 day'";
  const windowEnd = USE_SQLITE
    ? "datetime('now', '+3 days')"
    : "NOW() + INTERVAL '3 days'";

  const dueUsers = await query(
    `SELECT u.id as user_id,
            u.subscription_plan,
            u.subscription_expires_at,
            u.email,
            u.auto_renew_failures
     FROM users u
     WHERE u.subscription_auto_renew = TRUE
       AND u.subscription_plan IN ('base','premium','club','pro')
       AND u.subscription_expires_at > ${windowStart}
       AND u.subscription_expires_at < ${windowEnd}
       AND COALESCE(u.auto_renew_failures, 0) < 3
     ORDER BY u.subscription_expires_at ASC`,
    []
  );

  for (const row of dueUsers.rows) {
    try {
      const plan = await getPlanById(row.subscription_plan);
      if (!plan || !plan.is_active) {
        console.warn(`[AutoRenew] Plan ${row.subscription_plan} not active for user ${row.user_id}`);
        continue;
      }

      // Prefer default card, otherwise the most recently saved active card
      const pmResult = await query(
        `SELECT payment_method_id, card_last4
         FROM user_payment_methods
         WHERE user_id = $1 AND is_active = TRUE
         ORDER BY is_default DESC, created_at DESC
         LIMIT 1`,
        [row.user_id]
      );
      if (pmResult.rows.length === 0) {
        console.warn(`[AutoRenew] No active payment method for user ${row.user_id}`);
        continue;
      }
      const paymentMethod = pmResult.rows[0];

      const amount = Number(plan.price_monthly);
      const paymentId = uuidv4();

      await query(
        `INSERT INTO payments
           (id, user_id, amount, base_amount, discount, method, status, plan_id, billing_cycle, duration_days, is_upgrade)
         VALUES ($1, $2, $3, $4, 0, 'bank_card', 'pending', $5, 'monthly', 30, FALSE)`,
        [paymentId, row.user_id, amount, amount, row.subscription_plan]
      );

      const yookassaRes = await axios.post(
        'https://api.yookassa.ru/v3/payments',
        {
          amount: { value: amount.toFixed(2), currency: 'RUB' },
          payment_method_id: paymentMethod.payment_method_id,
          capture: true,
          description: `PULSE Auto-renew ${plan.name}`.slice(0, 128),
          metadata: {
            payment_id: paymentId,
            user_id: row.user_id,
            plan_id: row.subscription_plan,
            billing_cycle: 'monthly',
            duration_days: '30',
            is_upgrade: 'false',
            auto_renew: 'true',
          },
          receipt: {
            customer: { email: row.email },
            items: [{
              description: `Подписка PULSE ${plan.name} (автопродление)`.slice(0, 128),
              quantity: '1.00',
              amount: { value: amount.toFixed(2), currency: 'RUB' },
              vat_code: 1,
              payment_subject: 'service',
              payment_mode: 'full_payment',
            }],
          },
        },
        {
          headers: {
            Authorization: yookassaAuth(),
            'Idempotence-Key': `auto-renew-${paymentId}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      await query(
        `UPDATE payments SET provider_ref = $1 WHERE id = $2`,
        [yookassaRes.data.id, paymentId]
      );

      if (yookassaRes.data.status === 'succeeded') {
        await query(
          `UPDATE payments SET status = 'completed', paid_at = ${nowSql()} WHERE id = $1`,
          [paymentId]
        );
        await activateSubscription(row.user_id, row.subscription_plan, 30, paymentId, false);
        await query(`UPDATE users SET auto_renew_failures = 0 WHERE id = $1`, [row.user_id]);
        console.log(`[AutoRenew] Success: user ${row.user_id}, ${amount} RUB, card *${paymentMethod.card_last4 || '****'}`);
        result.processed++;
      } else if (yookassaRes.data.status === 'canceled') {
        await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
        await handleAutoRenewFailure(row.user_id, result);
        result.errors++;
      }
      // pending / waiting_for_capture → webhook will finish the job
    } catch (err: any) {
      console.error(`[AutoRenew] Failed for user ${row.user_id}:`, err.response?.data || err.message);
      await handleAutoRenewFailure(row.user_id, result);
      result.errors++;
    }
  }

  return result;
}

async function handleAutoRenewFailure(
  userId: string,
  result: { processed: number; errors: number; disabled: number }
): Promise<void> {
  try {
    const failRes = await query(
      `UPDATE users
       SET auto_renew_failures = COALESCE(auto_renew_failures, 0) + 1
       WHERE id = $1
       RETURNING auto_renew_failures`,
      [userId]
    );
    const failures = Number(failRes.rows[0]?.auto_renew_failures || 0);
    if (failures >= 3) {
      await query(
        `UPDATE users SET subscription_auto_renew = FALSE WHERE id = $1`,
        [userId]
      );
      result.disabled++;
      console.warn(`[AutoRenew] Disabled auto-renew for user ${userId} after ${failures} failures`);
    }
  } catch (e: any) {
    console.error(`[AutoRenew] Failure tracking error for user ${userId}:`, e.message);
  }
}

// ─── Downgrade preview ─────────────────────────────────────────────────────
export async function getExcessTagsForDowngrade(
  userId: string,
  targetPlanId: string
): Promise<{ tagId: string; tagName: string; tagType: string }[]> {
  const plan = await getPlanById(targetPlanId);
  if (!plan || plan.tag_limit < 0) return [];

  const result = await query(
    `SELECT tag_id, tag_name, tag_type FROM portfolios
     WHERE user_id = $1 AND is_frozen = FALSE
     ORDER BY created_at DESC
     OFFSET $2`,
    [userId, plan.tag_limit]
  );

  return result.rows.map(r => ({ tagId: r.tag_id, tagName: r.tag_name, tagType: r.tag_type }));
}

// ─── Downgrade scheduling ──────────────────────────────────────────────────
export async function scheduleDowngrade(
  userId: string,
  targetPlanId: string
): Promise<void> {
  await query(
    `UPDATE users SET scheduled_plan_downgrade = $1 WHERE id = $2`,
    [targetPlanId, userId]
  );
}

export async function cancelScheduledDowngrade(userId: string): Promise<void> {
  await query(
    `UPDATE users SET scheduled_plan_downgrade = NULL WHERE id = $1`,
    [userId]
  );
}

export async function processScheduledDowngrades(): Promise<number> {
  const now = nowSql();
  const result = await query(
    `SELECT id, scheduled_plan_downgrade FROM users
     WHERE scheduled_plan_downgrade IS NOT NULL
       AND subscription_expires_at < ${now}`,
    []
  );

  let processed = 0;
  for (const row of result.rows) {
    const targetPlan = row.scheduled_plan_downgrade;
    await query(
      `UPDATE users
       SET subscription_plan = $1,
           scheduled_plan_downgrade = NULL,
           subscription_active = CASE WHEN $1 = 'free' THEN FALSE ELSE subscription_active END
       WHERE id = $2`,
      [targetPlan, row.id]
    );
    await freezeExcessTags(row.id, targetPlan);
    processed++;
  }
  return processed;
}

// ─── Notifications ─────────────────────────────────────────────────────────
export async function notifySubscriptionEvent(
  userId: string,
  type: 'reminder_3d' | 'reminder_1d' | 'grace_1d' | 'grace_3d' | 'downgrade_done',
  message: string
): Promise<void> {
  // Dedup by user+type (we keep only the latest record per type)
  await query(
    `INSERT INTO subscription_notifications_sent (user_id, type)
     VALUES ($1, $2)
     ON CONFLICT (user_id, type) DO UPDATE SET sent_at = ${nowSql()}`,
    [userId, type]
  );

  // Telegram
  const tgResult = await query(
    `SELECT target FROM user_channels WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
    [userId]
  );
  for (const row of tgResult.rows) {
    await sendTelegramMessage(row.target, message);
  }

  // Push (Firebase/FCM)
  await sendPushNotification(userId, 'PULSE', message, { type });

  // Web Push (VAPID)
  await sendWebPushToUser(userId, 'PULSE', message, { type });
}

export async function sendSubscriptionReminders(): Promise<{
  reminders: number;
  grace: number;
  downgrades: number;
}> {
  const now = nowSql();
  const msPerDay = 24 * 60 * 60 * 1000;

  // Users with paid plan expiring in 1-3 days
  const expiring = await query(
    `SELECT id, subscription_plan, subscription_expires_at,
            scheduled_plan_downgrade
     FROM users
     WHERE subscription_plan IN ('base','premium','club','pro')
       AND subscription_expires_at > ${now}
       AND subscription_expires_at < ${nowSqlPlusDays(4)}`,
    []
  );

  let reminders = 0;
  let grace = 0;

  for (const row of expiring.rows) {
    const userId = row.id;
    const expiresAt = new Date(row.subscription_expires_at);
    const daysLeft = Math.ceil((expiresAt.getTime() - Date.now()) / msPerDay);

    if (daysLeft === 3) {
      await notifySubscriptionEvent(
        userId,
        'reminder_3d',
        `⏳ Подписка PULSE ${row.subscription_plan} истекает через 3 дня. Чтобы не потерять доступ, продлите тариф в профиле.`
      );
      reminders++;
    } else if (daysLeft === 1) {
      await notifySubscriptionEvent(
        userId,
        'reminder_1d',
        `⚠️ Подписка PULSE ${row.subscription_plan} истекает завтра. Продлите сейчас, чтобы теги и уведомления продолжали работать.`
      );
      reminders++;
    }
  }

  // Grace period notifications (expired within 1-3 days)
  const graceUsers = await query(
    `SELECT id, subscription_plan, subscription_expires_at,
            scheduled_plan_downgrade
     FROM users
     WHERE subscription_plan IN ('base','premium','club','pro')
       AND subscription_expires_at < ${now}
       AND subscription_expires_at > ${nowSqlPlusDays(-3)}`,
    []
  );

  for (const row of graceUsers.rows) {
    const userId = row.id;
    const expiresAt = new Date(row.subscription_expires_at);
    const graceDays = Math.floor((Date.now() - expiresAt.getTime()) / msPerDay) + 1;
    if (graceDays === 1 || graceDays === 3) {
      const type = graceDays === 1 ? 'grace_1d' : 'grace_3d';
      await notifySubscriptionEvent(
        userId,
        type,
        `🚨 Подписка PULSE ${row.subscription_plan} истекла. Grace-период: день ${graceDays}/3. Оплатите тариф, чтобы избежать заморозки тегов.`
      );
      grace++;
    }
  }

  // Downgrades
  const downgraded = await processScheduledDowngrades();

  return { reminders, grace, downgrades: downgraded };
}

function nowSqlPlusDays(days: number): string {
  return USE_SQLITE
    ? `datetime('now', '${days >= 0 ? '+' : ''}${days} days')`
    : `NOW() + INTERVAL '${days} days'`;
}

// ─── Middleware factory ────────────────────────────────────────────────────
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../middleware/auth';

export function requireMinPlan(minPlanId: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const sub = await getUserSubscription(userId);
    const status = buildSubscriptionStatus(sub);
    if (!status.active && minPlanId !== 'free') {
      return res.status(403).json({ error: 'Subscription required', required: minPlanId, current: sub.plan });
    }
    if (planLevel(sub.plan) < planLevel(minPlanId)) {
      return res.status(403).json({ error: 'Requires paid plan', required: minPlanId, current: sub.plan });
    }
    next();
  };
}
