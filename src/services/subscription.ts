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

import { query, pool } from '../config/db';
import { sendTelegramMessage } from './telegram';
import { sendPushNotification } from './push';
import { sendWebPushToUser } from './webPush';
import { getEnabledSubscriptions, getDeliveryTarget } from './notifications/subscriptions';
import axios from 'axios';
import { logSubscriptionActivated } from './activityLog';
import {
  sendExpiry4DaysAuto,
  sendExpiry4DaysManual,
  sendExpiry1DayAuto,
  sendExpiry1DayManual,
  sendExpiredPaymentFailed,
  sendExpiredToday,
  sendEmail,
} from './email';
import { logPaymentCompleted } from './activityLog';
import { nowSql } from '../utils/nowSql';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export const PLAN_BILLING_DAYS: Record<string, number> = {
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  yearly: 365,
};

export type BillingCycle = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

// ADM-H: единственная арифметика периода подписки. Эталон — дни
// (PLAN_BILLING_DAYS), как в платёжном пути. Календарные месяцы
// (setMonth) в подписках не используются: баг переполнения
// (31 янв + 1 мес = 3 мар) и разная цена дня в разных месяцах.
// base вычисляет вызывающий код: max(текущий expires_at, NOW()).
export function addBillingPeriod(base: Date, billingFrequency: string): Date {
  const days = PLAN_BILLING_DAYS[billingFrequency] || 30;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

export interface Plan {
  id: string;
  name: string;
  price: number;
  billing_frequency: BillingCycle;
  yearly_discount: number;
  tag_limit: number;
  features: Record<string, any>;
  display_order: number;
  is_active: boolean;
  is_popular: boolean;
  coming_soon_label: string | null;
  plan_level: number;
  deleted_at: string | null;
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

// ─── JSON parsing helper ───────────────────────────────────────────────────
export function parseDbJson<T = any>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value as T;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return null;
}

// ─── Plan helpers ──────────────────────────────────────────────────────────
// ⚠️ Инвариант: объекты Plan из кеша НЕ мутировать — все call-site'ы получают одну ссылку.
let plansCache: { data: Map<string, Plan>; expiresAt: number } | null = null;
const PLANS_CACHE_TTL_MS = 60_000;

async function getAllPlansCached(): Promise<Map<string, Plan>> {
  const now = Date.now();
  if (plansCache && plansCache.expiresAt > now) {
    return plansCache.data;
  }
  // КРИТИЧНО: без WHERE deleted_at IS NULL — оригинальный контракт getPlanById.
  // Фильтрация is_active / deleted_at — ответственность call-site'ов.
  const result = await query(
    `SELECT * FROM subscription_plans ORDER BY display_order ASC`,
    []
  );
  const data = new Map(
    result.rows.map((p: any) => [p.id, { ...p, features: parseDbJson(p.features) || {} }])
  );
  plansCache = { data, expiresAt: now + PLANS_CACHE_TTL_MS };
  return data;
}

export function invalidatePlansCache(): void {
  plansCache = null;
}

export async function getPlanById(planId: string): Promise<Plan | null> {
  const plans = await getAllPlansCached();
  return plans.get(planId) ?? null;
}

export async function planLevel(planId: string): Promise<number> {
  const plan = await getPlanById(planId);
  return plan?.plan_level ?? 0;
}

export function planLevelOf(plan: Plan | null): number {
  return plan?.plan_level ?? 0;
}

export async function isAtLeast(currentPlanId: string, minPlanId: string): Promise<boolean> {
  const [current, min] = await Promise.all([planLevel(currentPlanId), planLevel(minPlanId)]);
  return current >= min;
}

export async function isPaid(planId: string): Promise<boolean> {
  return (await planLevel(planId)) >= 1;
}

export async function getActivePlans(): Promise<Plan[]> {
  const result = await query(
    `SELECT * FROM subscription_plans
     WHERE is_active = TRUE AND deleted_at IS NULL
     ORDER BY display_order ASC`,
    []
  );
  return result.rows.map((p) => ({ ...p, features: parseDbJson(p.features) || {} }));
}

export async function getAllPlans(): Promise<Plan[]> {
  const result = await query(
    `SELECT * FROM subscription_plans ORDER BY display_order ASC`,
    []
  );
  return result.rows.map((p) => ({ ...p, features: parseDbJson(p.features) || {} }));
}

export async function getActiveSubscriberCount(planId: string): Promise<number> {
  const result = await query(
    `SELECT COUNT(*)::int as cnt FROM users
     WHERE subscription_plan = $1 AND subscription_active = TRUE`,
    [planId]
  );
  return Number(result.rows[0]?.cnt || 0);
}

export function computePlanPrice(plan: Plan, billingCycle: BillingCycle): number {
  const base = Number(plan.price);
  if (billingCycle === 'yearly') {
    if (plan.yearly_discount > 0) {
      return Math.round(base * 12 * (1 - plan.yearly_discount / 100));
    }
    if (plan.billing_frequency !== 'yearly') {
      return Math.round(base * 12);
    }
  }
  if (billingCycle === 'quarterly' && plan.billing_frequency !== 'quarterly') {
    return Math.round(base * 3);
  }
  if (billingCycle === 'weekly' && plan.billing_frequency !== 'weekly') {
    return Math.round(base / 4);
  }

  // TZ_YEARLY_TO_MONTHLY: convert yearly/quarterly base price to monthly
  if (billingCycle === 'monthly' && plan.billing_frequency === 'yearly') {
    return Math.round(base / 12);
  }
  if (billingCycle === 'monthly' && plan.billing_frequency === 'quarterly') {
    return Math.round(base / 3);
  }

  return base;
}

// ─── User subscription helpers ─────────────────────────────────────────────

export const GRACE_DAYS = 3;
export const GRACE_PERIOD_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

export interface AccessState {
  active: boolean;
  inGrace: boolean;
  daysLeft: number;
}

/**
 * Единая формула доступа по подписке.
 * - active: подписка оплачена ИЛИ внутри грейс-периода.
 * - inGrace: подписка истекла, но грейс ещё идёт.
 * - daysLeft: дней до конца оплаченного периода или до конца грейса.
 */
export function computeAccessState(expiresAt: Date | null): AccessState {
  const now = Date.now();
  if (!expiresAt) {
    return { active: false, inGrace: false, daysLeft: 0 };
  }
  const expires = expiresAt.getTime();
  const graceEnd = expires + GRACE_PERIOD_MS;
  if (now < expires) {
    return {
      active: true,
      inGrace: false,
      daysLeft: Math.max(0, Math.ceil((expires - now) / (24 * 60 * 60 * 1000))),
    };
  }
  if (now < graceEnd) {
    return {
      active: true,
      inGrace: true,
      daysLeft: Math.max(0, Math.ceil((graceEnd - now) / (24 * 60 * 60 * 1000))),
    };
  }
  return { active: false, inGrace: false, daysLeft: 0 };
}

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
  const access = computeAccessState(sub.expiresAt);

  // DEFSUB-16: канарейка — платный план + active=TRUE, но expires_at=NULL.
  // Это всегда баг: код выставил план без expires_at. Легитимный drift
  // (истёкший платный до тика крона) сюда не попадает — там expiresAt в прошлом.
  if (process.env.NODE_ENV !== 'production'
      && sub.active
      && sub.plan !== 'free'
      && sub.expiresAt === null
      && !access.active) {
    console.warn('[subscription] INCONSISTENT: paid plan + active=TRUE + expiresAt=NULL', {
      plan: sub.plan,
    });
  }

  const plan = access.active ? sub.plan : 'free';

  return {
    plan,
    active: access.active,
    expiresAt: sub.expiresAt ? sub.expiresAt.toISOString() : null,
    autoRenew: sub.autoRenew,
    daysLeft: access.daysLeft,
    inGracePeriod: access.inGrace,
    scheduledDowngrade: access.active ? sub.scheduledDowngrade : null,
  };
}

// ─── Upgrade price calculation ─────────────────────────────────────────────
export interface UpgradePreview {
  currentPlan: string;
  targetPlan: string;
  billingCycle: BillingCycle;
  daysLeft: number;
  topUpAmount: number;
  fullPrice: number;
  newPeriodDays: number;
  description: string;
  canUpgrade: boolean;
}

export async function calculateUpgradePrice(
  userId: string,
  targetPlanId: string,
  billingCycle: BillingCycle
): Promise<UpgradePreview> {
  const sub = await getUserSubscription(userId);
  const currentPlanId = sub.plan;
  const currentPlan = await getPlanById(currentPlanId);
  const targetPlan = await getPlanById(targetPlanId);

  if (!currentPlan || !targetPlan) {
    throw new Error('Plan not found');
  }

  // Current price from user's last completed payment, not plan.price
  const lastPayment = await query(
    `SELECT amount FROM payments
     WHERE user_id = $1 AND status = 'completed'
     ORDER BY paid_at DESC NULLS LAST, created_at DESC LIMIT 1`,
    [userId]
  );
  const currentPrice = Number(lastPayment.rows[0]?.amount || 0);
  const targetPrice = computePlanPrice(targetPlan, billingCycle);
  const daysInPeriod = PLAN_BILLING_DAYS[billingCycle];

  const now = new Date();
  const expires = sub.expiresAt;
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
    canUpgrade: planLevelOf(targetPlan) > planLevelOf(currentPlan) || samePrice,
  };
}

// ─── Subscription activation ───────────────────────────────────────────────
export async function activateSubscription(
  userId: string,
  planId: string,
  durationDays: number,
  paymentId?: string,
  isUpgrade?: boolean,
  billingCycle: BillingCycle = 'monthly'
): Promise<void> {
  const now = new Date();

  // TZ_UPGRADE_DAYS: при апгрейде и продлении накапливаем дни от max(currentExpires, NOW())
  const currentResult = await query(
    `SELECT subscription_expires_at FROM users WHERE id = $1`,
    [userId]
  );
  const currentExpires = currentResult.rows[0]?.subscription_expires_at
    ? new Date(currentResult.rows[0].subscription_expires_at)
    : null;
  const base = currentExpires && currentExpires.getTime() > now.getTime() ? currentExpires : now;
  const newExpires = new Date(base.getTime() + durationDays * 24 * 60 * 60 * 1000);

  await query(
    `UPDATE users
     SET subscription_active = TRUE,
         subscription_plan = $1,
         subscription_expires_at = $2,
         expiry_notified = '{}',
         scheduled_plan_downgrade = CASE WHEN $4 = TRUE THEN NULL ELSE scheduled_plan_downgrade END
     WHERE id = $3`,
    [planId, newExpires.toISOString(), userId, isUpgrade || false]
  );

  logSubscriptionActivated(userId, planId, newExpires.toISOString()).catch(() => {});

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

// ─── Atomic payment activation (prevents double-charge / double-activation) ─

/**
 * Атомарная активация платежа.
 * UPDATE ... WHERE status = 'pending' гарантирует что только 1 вызов пройдёт.
 * @returns true — активировали, false — уже был активирован (idempotent)
 */
export async function activatePaymentIfNeeded(paymentId: string): Promise<boolean> {
  const result = await query(
    `UPDATE payments
     SET status = 'completed',
         paid_at = ${nowSql()}
     WHERE id = $1
       AND status = 'pending'
     RETURNING user_id, plan_id, duration_days, is_upgrade, amount, method, billing_cycle`,
    [paymentId]
  );

  if (result.rows.length === 0) {
    // Уже активирован — idempotent, не ошибка
    return false;
  }

  const p = result.rows[0];

  await activateSubscription(
    p.user_id,
    p.plan_id,
    p.duration_days || 30,
    paymentId,
    p.is_upgrade === true,
    p.billing_cycle || 'monthly'
  );

  // Сброс счётчика неудач авто-продления
  await query(`UPDATE users SET auto_renew_failures = 0 WHERE id = $1`, [p.user_id]);

  // TZ_PROMO_ATOMIC: атомарный инкремент uses_count только при успешной оплате
  await incrementPromoUsageAtomic(paymentId);

  logPaymentCompleted(p.user_id, Number(p.amount), p.plan_id, p.method || 'yookassa').catch(() => {});

  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// Promo usage — atomic increment only after successful payment
// ═════════════════════════════════════════════════════════════════════════════
export async function incrementPromoUsageAtomic(paymentId: string): Promise<void> {
  const result = await query(
    `SELECT p.promo_code, pc.id as promo_id
     FROM payments p
     JOIN promo_codes pc ON pc.code = p.promo_code
     WHERE p.id = $1 AND p.promo_code IS NOT NULL`,
    [paymentId]
  );
  if (result.rows.length === 0) return;

  const { promo_id } = result.rows[0];
  const updateResult = await query(
    `UPDATE promo_codes
     SET uses_count = uses_count + 1
     WHERE id = $1
       AND (max_uses IS NULL OR uses_count < max_uses)
     RETURNING uses_count, max_uses`,
    [promo_id]
  );

  if (updateResult.rows.length > 0) {
    const row = updateResult.rows[0];
    console.log(`[Promo] Atomic increment: ${row.uses_count}/${row.max_uses || '∞'}`);
  } else {
    console.warn(`[Promo] Could not atomic increment promo usage for payment ${paymentId}: limit reached`);
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

  await reconcileFrozenTags(userId);

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
    await reconcileFrozenTags(userId);
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
    unfrozen++;
  }
  await reconcileFrozenTags(userId);
  return unfrozen;
}

// ─── Manual tag selection: keep only specific tags active, freeze the rest ──
export async function setActiveTags(userId: string, keepTagIds: string[]): Promise<{ kept: number; frozen: number; unfrozen: number }> {
  if (keepTagIds.length === 0) {
    const freezeResult = await query(
      `UPDATE portfolios SET is_frozen = TRUE WHERE user_id = $1 AND is_frozen = FALSE RETURNING id`,
      [userId]
    );
    await reconcileFrozenTags(userId);
    return { kept: 0, frozen: freezeResult.rows.length, unfrozen: 0 };
  }

  const placeholders = keepTagIds.map((_, i) => `$${i + 2}`).join(',');
  const params = [userId, ...keepTagIds];

  const unfreezeResult = await query(
    `UPDATE portfolios SET is_frozen = FALSE WHERE user_id = $1 AND id IN (${placeholders}) RETURNING id`,
    params
  );
  const freezeResult = await query(
    `UPDATE portfolios SET is_frozen = TRUE WHERE user_id = $1 AND is_frozen = FALSE AND id NOT IN (${placeholders}) RETURNING id`,
    params
  );

  await reconcileFrozenTags(userId);

  return { kept: keepTagIds.length, frozen: freezeResult.rows.length, unfrozen: unfreezeResult.rows.length };
}

/**
 * Единый реконсилятор: синхронизирует audit-таблицу frozen_tags
 * с актуальным состоянием portfolios.is_frozen.
 * Вызывать после ЛЮБОГО изменения is_frozen.
 */
export async function reconcileFrozenTags(userId: string): Promise<void> {
  const now = nowSql();

  // 1. Добавить/обновить записи для тегов, которые СЕЙЧАС frozen
  await query(
    `INSERT INTO frozen_tags (user_id, tag_id, tag_name, tag_type, frozen_at, unfrozen_at)
     SELECT p.user_id, p.tag_id, p.tag_name, p.tag_type, ${now}, NULL
     FROM portfolios p
     WHERE p.user_id = $1 AND p.is_frozen
     ON CONFLICT (user_id, tag_id) DO UPDATE SET
       frozen_at = ${now},
       unfrozen_at = NULL,
       tag_name = EXCLUDED.tag_name,
       tag_type = EXCLUDED.tag_type`,
    [userId]
  );

  // 2. Пометить unfrozen для тегов, которые СЕЙЧАС активны
  await query(
    `UPDATE frozen_tags
     SET unfrozen_at = ${now}
     WHERE user_id = $1
       AND unfrozen_at IS NULL
       AND tag_id IN (
         SELECT tag_id FROM portfolios
         WHERE user_id = $1 AND NOT is_frozen
       )`,
    [userId]
  );

  // 3. Удалить записи для удалённых тегов (нет в portfolios)
  await query(
    `DELETE FROM frozen_tags ft
     WHERE ft.user_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM portfolios p
         WHERE p.user_id = ft.user_id AND p.tag_id = ft.tag_id
       )`,
    [userId]
  );
}

// ─── Expiry helpers ────────────────────────────────────────────────────────
export interface LostFeatures {
  features: string[];
  tagCount: number;
  frozenCount: number;
}

export async function getLostFeatures(userId: string, planId: string): Promise<LostFeatures> {
  const planResult = await query(
    `SELECT features FROM subscription_plans WHERE id = $1`,
    [planId]
  );
  const planFeatures = parseDbJson<Record<string, any>>(planResult.rows[0]?.features) || {};

  const freeResult = await query(
    `SELECT features FROM subscription_plans WHERE id = 'free'`
  );
  const freeFeatures = parseDbJson<Record<string, any>>(freeResult.rows[0]?.features) || {};

  const registryResult = await query(
    `SELECT id, label FROM features_registry WHERE is_active = TRUE`
  );
  const registry = Object.fromEntries(registryResult.rows.map((r) => [r.id, r.label]));

  const lost = Object.entries(planFeatures)
    .filter(([key, val]) => val === true && !freeFeatures[key])
    .map(([key]) => registry[key] || key);

  const tagsResult = await query(
    `SELECT COUNT(*) as cnt FROM portfolios WHERE user_id = $1`,
    [userId]
  );
  const tagCount = Number(tagsResult.rows[0]?.cnt || 0);

  const frozenResult = await query(
    `SELECT COUNT(*) as cnt FROM portfolios WHERE user_id = $1 AND is_frozen = TRUE`,
    [userId]
  );
  const frozenCount = Number(frozenResult.rows[0]?.cnt || 0);

  return { features: lost, tagCount, frozenCount };
}

export interface UserMonthlyStats {
  totalNews: number;
  filteredNews: number;
  aiSummaries: number;
  alertsCount: number;
  hoursSaved: number;
  noisePercent: number;
}

export async function getUserMonthlyStats(userId: string): Promise<UserMonthlyStats> {
  const since = new Date();
  since.setMonth(since.getMonth() - 1);
  const sinceIso = since.toISOString();

  // Total news in the last month
  let totalNews = 0;
  try {
    const totalResult = await query(
      `SELECT COUNT(*) as cnt FROM news WHERE published_at > $1`,
      [sinceIso]
    );
    totalNews = Number(totalResult.rows[0]?.cnt || 0);
  } catch (e: any) {
    console.error('[Stats] Error counting total news:', e.message);
  }

  // News linked to user's active tags (via news_tag_links) in the last month
  let filteredNews = 0;
  try {
    const filteredResult = await query(
      `SELECT COUNT(DISTINCT n.id) as cnt
       FROM news n
       JOIN news_tag_links l ON l.news_id = n.id
       JOIN portfolios p ON p.tag_id = l.tag_id
       WHERE p.user_id = $1 AND n.published_at > $2 AND p.is_frozen = FALSE`,
      [userId, sinceIso]
    );
    filteredNews = Number(filteredResult.rows[0]?.cnt || 0);
  } catch (e: any) {
    console.error('[Stats] Error counting personal news:', e.message);
  }

  // AI summaries and alerts tables may not exist yet — try/catch with fallback to 0
  let aiSummaries = 0;
  try {
    const aiResult = await query(
      `SELECT COUNT(*) as cnt FROM ai_summaries WHERE user_id = $1 AND created_at > $2`,
      [userId, sinceIso]
    );
    aiSummaries = parseInt(aiResult.rows[0]?.cnt || '0', 10);
  } catch (e: any) {
    console.warn('[Stats] ai_summaries table not found or error:', e.message);
  }

  let alertsCount = 0;
  try {
    const alertsResult = await query(
      `SELECT COUNT(*) as cnt FROM alerts WHERE user_id = $1 AND created_at > $2`,
      [userId, sinceIso]
    );
    alertsCount = parseInt(alertsResult.rows[0]?.cnt || '0', 10);
  } catch (e: any) {
    console.warn('[Stats] alerts table not found or error:', e.message);
  }

  const hoursSaved = Math.round(filteredNews * 2 / 60);
  const noisePercent = totalNews > 0 ? Math.round((1 - filteredNews / totalNews) * 100) : 0;

  if (totalNews === 0 && filteredNews === 0) {
    console.error(`[Stats] All zeros for user ${userId}: check news table, news_tag_links, date range`);
  }

  return {
    totalNews,
    filteredNews,
    aiSummaries,
    alertsCount,
    hoursSaved,
    noisePercent,
  };
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
// ─── Cron race-condition protection ─────────────────────────────────────────

function oneHourAgoSql(): string {
  return USE_SQLITE ? "datetime('now', '-1 hour')" : "NOW() - INTERVAL '1 hour'";
}

async function hasRecentPendingPayment(userId: string): Promise<boolean> {
  const existing = await query(
    `SELECT 1 FROM payments
     WHERE user_id = $1 AND status = 'pending'
       AND created_at > ${oneHourAgoSql()}
     LIMIT 1`,
    [userId]
  );
  return existing.rows.length > 0;
}

async function withPostgresUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `cron:user:${userId}`;
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

async function withSQLiteUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `cron:user:${userId}`;
  try {
    await query(
      `INSERT INTO cron_locks (lock_key, locked_at) VALUES ($1, datetime('now'))`,
      [lockKey]
    );
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      throw new Error(`Lock already held for user ${userId}`);
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    await query(`DELETE FROM cron_locks WHERE lock_key = $1`, [lockKey]).catch(() => {});
  }
}

/**
 * Гарантирует, что для одного пользователя одновременно работает только один cron-процесс.
 * PostgreSQL: pg_advisory_lock / pg_advisory_unlock.
 * SQLite: таблица cron_locks (UNIQUE lock_key).
 */
export async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  if (USE_SQLITE) {
    return withSQLiteUserLock(userId, fn);
  }
  return withPostgresUserLock(userId, fn);
}

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
       AND u.subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
       AND u.subscription_expires_at > ${windowStart}
       AND u.subscription_expires_at < ${windowEnd}
       AND COALESCE(u.auto_renew_failures, 0) < 3
       AND u.scheduled_plan_downgrade IS NULL
     ORDER BY u.subscription_expires_at ASC`,
    []
  );

  for (const row of dueUsers.rows) {
    try {
      await withUserLock(row.user_id, async () => {
        if (await hasRecentPendingPayment(row.user_id)) {
          console.log(`[AutoRenew] User ${row.user_id} already has a recent pending payment, skipping`);
          return;
        }

        const plan = await getPlanById(row.subscription_plan);
        if (!plan || !plan.is_active) {
          // План полностью деактивирован (не архивирован) — отключаем auto-renew
          await query(`UPDATE users SET subscription_auto_renew = FALSE WHERE id = $1`, [row.user_id]);
          console.warn(`[AutoRenew] Plan ${row.subscription_plan} deactivated (active=${plan?.is_active}), disabling auto-renew for user ${row.user_id}`);
          return;
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
          console.warn(`[AutoRenew] No active payment method for user ${row.user_id}, counting as failure`);

          // TZ_NO_CARD_NOTIFY: count as a failure and notify the user
          const failRes = await query(
            `UPDATE users
             SET auto_renew_failures = COALESCE(auto_renew_failures, 0) + 1,
                 updated_at = ${nowSql()}
             WHERE id = $1
             RETURNING auto_renew_failures`,
            [row.user_id]
          );
          const failures = Number(failRes.rows[0]?.auto_renew_failures || 0);

          await notifySubscriptionEvent(
            row.user_id,
            'grace_1d',
            'Автопродление подписки невозможно: не привязана карта. Привяжите карту в профиле, чтобы избежать перевода на Free.'
          );

          if (failures >= 3) {
            await query(`UPDATE users SET subscription_auto_renew = FALSE WHERE id = $1`, [row.user_id]);
            await notifySubscriptionEvent(
              row.user_id,
              'downgrade_done',
              'Автопродление отключено после 3 неудач. Подписка будет переведена на Free по истечении срока.'
            );
            result.disabled++;
          }

          result.errors++;
          return;
        }
        const paymentMethod = pmResult.rows[0];

        // Billing cycle пользователя из последнего успешного платежа (или плана по умолчанию)
        const lastPayment = await query(
          `SELECT billing_cycle FROM payments
           WHERE user_id = $1 AND status = 'completed'
           ORDER BY paid_at DESC LIMIT 1`,
          [row.user_id]
        );
        const userBillingCycle: BillingCycle = (lastPayment.rows[0]?.billing_cycle as BillingCycle) || plan.billing_frequency || 'monthly';
        const amount = computePlanPrice(plan, userBillingCycle);
        const durationDays = PLAN_BILLING_DAYS[userBillingCycle] || 30;
        const paymentId = uuidv4();

        await query(
          `INSERT INTO payments
             (id, user_id, amount, base_amount, discount, method, status, plan_id, billing_cycle, duration_days, is_upgrade)
           VALUES ($1, $2, $3, $4, 0, 'bank_card', 'pending', $5, $6, $7, FALSE)`,
          [paymentId, row.user_id, amount, amount, row.subscription_plan, userBillingCycle, durationDays]
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
              billing_cycle: userBillingCycle,
              duration_days: String(durationDays),
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
          const activated = await activatePaymentIfNeeded(paymentId);
          if (activated) {
            console.log(`[AutoRenew] Success: user ${row.user_id}, ${amount} RUB, card *${paymentMethod.card_last4 || '****'}`);
          } else {
            console.log(`[AutoRenew] Payment ${paymentId} already activated by webhook`);
          }
          result.processed++;
        } else if (yookassaRes.data.status === 'canceled') {
          await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
          // TZ_DOUBLE_INCREMENT: webhook is the single source of truth for counting failures
          console.log(`[AutoRenew] Payment ${paymentId} canceled, waiting for webhook to count failure`);
          result.errors++;
        }
        // pending / waiting_for_capture → webhook will finish the job
      });
    } catch (err: any) {
      if (err.message?.includes('Lock already held')) {
        console.log(`[AutoRenew] User ${row.user_id} is locked by another process, skipping`);
        continue;
      }
      console.error(`[AutoRenew] Failed for user ${row.user_id}:`, err.response?.data || err.message);
      // TZ_DOUBLE_INCREMENT: do not increment here; webhook handles failure counting
      result.errors++;
    }
  }

  return result;
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
export async function applyDowngradeNow(
  userId: string,
  targetPlanId: string
): Promise<void> {
  const now = nowSql();
  const keepActive = targetPlanId !== 'free';

  // TZ_DOWNGRADE_RACE: atomic UPDATE with expires_at check so a just-renewed
  // subscription is not overwritten by the downgrade.
  // DEFSUB-16: при уходе на free обнуляем subscription_expires_at (гигиена данных).
  const updateResult = await query(
    `UPDATE users
     SET subscription_plan = $1,
         scheduled_plan_downgrade = NULL,
         subscription_active = $2,
         subscription_expires_at = CASE WHEN $2 = TRUE THEN subscription_expires_at ELSE NULL END,
         subscription_auto_renew = FALSE
     WHERE id = $3
       AND subscription_expires_at < ${now}
     RETURNING id`,
    [targetPlanId, keepActive, userId]
  );

  if (updateResult.rows.length === 0) {
    console.log(`[DowngradeNow] User ${userId}: downgrade to ${targetPlanId} skipped (expires_at missing or renewed)`);
    return;
  }

  await freezeExcessTags(userId, targetPlanId);
  console.log(`[DowngradeNow] User ${userId} → ${targetPlanId}, auto_renew=FALSE, tags frozen`);

  // DEFSUB-14: уведомляем пользователя о фактическом понижении тарифа
  // ADM-I: разные тексты для free и платной цели.
  // Платная цель живёт на остатке грейса — явно называем дедлайн оплаты.
  const message = targetPlanId === 'free'
    ? 'Подписка завершена. Тариф переведён на Free, лишние теги заморожены. Чтобы восстановить функции, оформите подписку.'
    : `Тариф PULSE изменён на ${targetPlanId}. Для продолжения работы оплатите новый тариф в течение ${GRACE_DAYS} дней — иначе аккаунт перейдёт на Free.`;

  await notifySubscriptionEvent(userId, 'downgrade_done', message).catch(() => {});
}

export async function scheduleDowngrade(
  userId: string,
  targetPlanId: string
): Promise<void> {
  await query(
    `UPDATE users
     SET scheduled_plan_downgrade = $1,
         subscription_auto_renew = FALSE
     WHERE id = $2`,
    [targetPlanId, userId]
  );
}

export async function cancelScheduledDowngrade(userId: string): Promise<void> {
  await query(
    `UPDATE users SET scheduled_plan_downgrade = NULL WHERE id = $1`,
    [userId]
  );
  // TZ_CANCEL_DOWNGRADE_LIMIT: unfreeze only up to the current plan limit instead of all tags
  const sub = await getUserSubscription(userId);
  await unfreezeTagsUpToLimit(userId, sub.plan);
  await reconcileFrozenTags(userId);
  await notifySubscriptionEvent(userId, 'downgrade_cancelled', 'Даунгрейд отменён, теги разморожены в пределах лимита тарифа');
}

export async function processScheduledDowngrades(): Promise<number> {
  const now = nowSql();
  const graceThreshold = USE_SQLITE
    ? `datetime('now', '-${GRACE_DAYS} days')`
    : `NOW() - INTERVAL '${GRACE_DAYS} days'`;
  let processed = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // DEFSUB-1: auto-fallback to free after grace period ends (for users without
  // scheduled downgrade). Fixes stuck premium plans that stay on 'premium'
  // forever after expiry + grace.
  // ═══════════════════════════════════════════════════════════════════════════
  const graceExpiredResult = await query(
    `UPDATE users
     SET subscription_plan = 'free',
         subscription_active = FALSE,
         subscription_auto_renew = FALSE,
         scheduled_plan_downgrade = NULL
     WHERE subscription_plan != 'free'
       AND subscription_expires_at < ${graceThreshold}
       AND scheduled_plan_downgrade IS NULL
     RETURNING id`,
    []
  );
  for (const row of graceExpiredResult.rows) {
    await withUserLock(row.id, async () => {
      await applyDowngradeNow(row.id, 'free');
    });
    processed++;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TZ_SUBSCRIPTION_EXPIRE: deactivate expired paid subscriptions that have
  // no scheduled downgrade. DB-flag hygiene for reporting; access logic uses
  // computeAccessState, so this does not gate features in the middle of grace.
  // ═══════════════════════════════════════════════════════════════════════════
  const expiredResult = await query(
    `UPDATE users
     SET subscription_active = FALSE
     WHERE subscription_active = TRUE
       AND subscription_expires_at < ${now}
       AND subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
       AND scheduled_plan_downgrade IS NULL
     RETURNING id, subscription_plan`,
    []
  );
  processed += expiredResult.rows.length;
  for (const row of expiredResult.rows) {
    console.log(`[SubscriptionExpire] Deactivated expired subscription: user=${row.id}, plan=${row.subscription_plan}`);
  }

  const result = await query(
    `SELECT id, scheduled_plan_downgrade, subscription_plan, subscription_active
     FROM users
     WHERE (scheduled_plan_downgrade IS NOT NULL
            AND subscription_expires_at < ${now})
        OR (subscription_plan IN (
              SELECT id FROM subscription_plans WHERE deleted_at IS NOT NULL
            )
            AND subscription_active = FALSE
            AND subscription_expires_at < ${now})`,
    []
  );

  for (const row of result.rows) {
    await withUserLock(row.id, async () => {
      const targetPlan = row.scheduled_plan_downgrade || 'free';
      await applyDowngradeNow(row.id, targetPlan);
      processed++;
    });
  }
  return processed;
}

// ─── Notifications ─────────────────────────────────────────────────────────
export async function notifySubscriptionEvent(
  userId: string,
  type: 'reminder_3d' | 'reminder_1d' | 'grace_1d' | 'grace_3d' | 'downgrade_done' | 'downgrade_cancelled',
  message: string
): Promise<void> {
  // Dedup by user+type (we keep only the latest record per type)
  await query(
    `INSERT INTO subscription_notifications_sent (user_id, type)
     VALUES ($1, $2)
     ON CONFLICT (user_id, type) DO UPDATE SET sent_at = ${nowSql()}`,
    [userId, type]
  );

  // TZ_NOTIFICATION_SETTINGS: respect user notification preferences via matrix
  const billingSubs = await getEnabledSubscriptions(userId, 'billing');

  for (const sub of billingSubs) {
    try {
      if (sub.channel === 'telegram') {
        const target = await getDeliveryTarget(userId, 'telegram', 'billing');
        if (target) await sendTelegramMessage(target.target, message);
      } else if (sub.channel === 'email') {
        const target = await getDeliveryTarget(userId, 'email', 'billing');
        if (target) {
          const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#0a0a0a;margin:0;padding:20px;color:#e5e5e5;">
<div style="max-width:480px;margin:0 auto;background:#111111;border-radius:16px;overflow:hidden;border:1px solid #222222;">
<div style="padding:28px;">${escapeHtml(message).replace(/\n/g, '<br>')}</div>
</div></body></html>`;
          await sendEmail(target.target, 'PULSE', html);
        }
      } else if (sub.channel === 'push') {
        await sendPushNotification(userId, 'PULSE', message, { type });
        await sendWebPushToUser(userId, 'PULSE', message, { type });
      }
    } catch (err: any) {
      console.error(`[notifySubscriptionEvent] ${sub.channel} failed for ${userId}:`, err.message);
    }
  }
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
     WHERE subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
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
     WHERE subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
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
      // ADM-I: нейтральная формулировка — честна и для истёкшей подписки,
      // и для scheduled-даунгрейда на платный план (юзер его ещё не оплачивал).
      await notifySubscriptionEvent(
        userId,
        type,
        `🚨 Тариф PULSE ${row.subscription_plan} не оплачен. Доступ работает в grace-режиме: день ${graceDays}/${GRACE_DAYS}. Оплатите тариф — иначе по концу grace аккаунт перейдёт на Free, а теги сверх лимита Free будут заморожены.`
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

function dateSql(): string {
  return USE_SQLITE ? "date('now')" : 'CURRENT_DATE';
}

function dateSqlPlusDays(days: number): string {
  return USE_SQLITE
    ? `date('now', '${days >= 0 ? '+' : ''}${days} days')`
    : `DATE(CURRENT_DATE + INTERVAL '${days} days')`;
}

// ─── Email + Push expiry notifications (T-4, T-1, T-0) ───────────────────
export async function sendExpiryNotifications(): Promise<{
  sent: number;
  skipped: number;
  errors: number;
}> {
  const result = { sent: 0, skipped: 0, errors: 0 };
  const frontendUrl = process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru';

  try {
    // T-4 days
    const fourDays = await query(
      `SELECT u.id, u.email, u.username, u.subscription_plan, u.subscription_expires_at,
              u.subscription_auto_renew, u.auto_renew_failures, u.expiry_notified,
              sp.name as plan_name, sp.price
       FROM users u
       JOIN subscription_plans sp ON sp.id = u.subscription_plan
       WHERE u.subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
         AND u.subscription_active = TRUE
         AND date(u.subscription_expires_at) = ${dateSqlPlusDays(4)}`,
      []
    );

    for (const row of fourDays.rows) {
      const notified = parseDbJson<Record<string, boolean>>(row.expiry_notified) || {};
      if (notified['4d']) {
        result.skipped++;
        continue;
      }
      try {
        const profileUrl = `${frontendUrl}/profile`;
        const ok = row.subscription_auto_renew
          ? await sendExpiry4DaysAuto(row.email, {
              name: row.username || row.email,
              planName: row.plan_name,
              expiresAt: row.subscription_expires_at,
              price: Number(row.price || 0),
              profileUrl,
            })
          : await sendExpiry4DaysManual(row.email, {
              name: row.username || row.email,
              planName: row.plan_name,
              expiresAt: row.subscription_expires_at,
              price: Number(row.price || 0),
              profileUrl,
              lostFeatures: (await getLostFeatures(row.id, row.subscription_plan)).features,
            });
        if (ok) {
          notified['4d'] = true;
          await query(`UPDATE users SET expiry_notified = $1 WHERE id = $2`, [
            JSON.stringify(notified),
            row.id,
          ]);
          result.sent++;
          await sendBillingPush(row.id, 'PULSE — подписка', `Через 4 дня истекает подписка ${row.plan_name}`, { type: 'billing', subtype: '4d' });
        } else {
          result.errors++;
        }
      } catch (e: any) {
        console.error('[ExpiryNotify] T-4 failed for user', row.id, e.message);
        result.errors++;
      }
    }

    // T-1 day
    const oneDay = await query(
      `SELECT u.id, u.email, u.username, u.subscription_plan, u.subscription_expires_at,
              u.subscription_auto_renew, u.auto_renew_failures, u.expiry_notified,
              sp.name as plan_name, sp.price
       FROM users u
       JOIN subscription_plans sp ON sp.id = u.subscription_plan
       WHERE u.subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
         AND u.subscription_active = TRUE
         AND date(u.subscription_expires_at) = ${dateSqlPlusDays(1)}`,
      []
    );

    for (const row of oneDay.rows) {
      const notified = parseDbJson<Record<string, boolean>>(row.expiry_notified) || {};
      if (notified['1d']) {
        result.skipped++;
        continue;
      }
      try {
        const profileUrl = `${frontendUrl}/profile`;
        const ok = row.subscription_auto_renew
          ? await sendExpiry1DayAuto(row.email, {
              name: row.username || row.email,
              planName: row.plan_name,
              expiresAt: row.subscription_expires_at,
              price: Number(row.price || 0),
              profileUrl,
            })
          : await sendExpiry1DayManual(row.email, {
              name: row.username || row.email,
              planName: row.plan_name,
              expiresAt: row.subscription_expires_at,
              price: Number(row.price || 0),
              profileUrl,
              lostFeatures: (await getLostFeatures(row.id, row.subscription_plan)).features,
            });
        if (ok) {
          notified['1d'] = true;
          await query(`UPDATE users SET expiry_notified = $1 WHERE id = $2`, [
            JSON.stringify(notified),
            row.id,
          ]);
          result.sent++;
          await sendBillingPush(row.id, 'PULSE — подписка', `Завтра истекает подписка ${row.plan_name}`, { type: 'billing', subtype: '1d' });
        } else {
          result.errors++;
        }
      } catch (e: any) {
        console.error('[ExpiryNotify] T-1 failed for user', row.id, e.message);
        result.errors++;
      }
    }

    // T-0: expired today
    const expiredToday = await query(
      `SELECT u.id, u.email, u.username, u.subscription_plan, u.subscription_expires_at,
              u.subscription_auto_renew, u.auto_renew_failures, u.expiry_notified,
              sp.name as plan_name, sp.price
       FROM users u
       JOIN subscription_plans sp ON sp.id = u.subscription_plan
       WHERE u.subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
         AND u.subscription_active = TRUE
         AND date(u.subscription_expires_at) <= ${dateSql()}`,
      []
    );

    for (const row of expiredToday.rows) {
      const notified = parseDbJson<Record<string, boolean>>(row.expiry_notified) || {};
      if (notified['expired']) {
        result.skipped++;
        continue;
      }
      try {
        const profileUrl = `${frontendUrl}/profile`;
        let ok = false;
        if (row.subscription_auto_renew) {
          ok = await sendExpiredPaymentFailed(row.email, {
            name: row.username || row.email,
            planName: row.plan_name,
            price: Number(row.price || 0),
            profileUrl,
          });
        } else {
          const lost = await getLostFeatures(row.id, row.subscription_plan);
          const stats = await getUserMonthlyStats(row.id);
          ok = await sendExpiredToday(row.email, {
            name: row.username || row.email,
            planName: row.plan_name,
            profileUrl,
            lostFeatures: lost,
            stats,
          });
        }
        if (ok) {
          notified['expired'] = true;
          await query(`UPDATE users SET expiry_notified = $1 WHERE id = $2`, [
            JSON.stringify(notified),
            row.id,
          ]);
          result.sent++;
          await sendBillingPush(row.id, 'PULSE — подписка истекла', `Подписка ${row.plan_name} истекла`, { type: 'billing', subtype: 'expired' });
        } else {
          result.errors++;
        }
      } catch (e: any) {
        console.error('[ExpiryNotify] T-0 failed for user', row.id, e.message);
        result.errors++;
      }
    }
  } catch (e: any) {
    console.error('[ExpiryNotify] Fatal error:', e.message);
    result.errors++;
  }

  console.log('[ExpiryNotify] sent:', result.sent, 'skipped:', result.skipped, 'errors:', result.errors);
  return result;
}

async function sendBillingPush(
  userId: string,
  title: string,
  body: string,
  data: Record<string, string>
): Promise<void> {
  try {
    const subs = await getEnabledSubscriptions(userId, 'billing');
    if (!subs.some(s => s.channel === 'push')) return;

    await Promise.all([
      sendPushNotification(userId, title, body, data, { skipQuietHours: true, skipEnabledCheck: true }),
      sendWebPushToUser(userId, title, body, data),
    ]);
  } catch (e: any) {
    console.error(`[ExpiryNotify] Billing push failed for user ${userId}:`, e.message);
  }
}

// ─── Feature registry cache ────────────────────────────────────────────────
interface FeatureRegistryEntry {
  id: string;
  label: string;
  description: string | null;
  is_active: boolean;
  loadedAt: number;
}

export let featuresRegistryCache: Record<string, FeatureRegistryEntry> | null = null;
let featuresRegistryCacheAt = 0;
const FEATURE_REGISTRY_TTL = 5 * 60 * 1000; // 5 minutes

export function invalidateFeaturesRegistryCache(): void {
  featuresRegistryCache = null;
  featuresRegistryCacheAt = 0;
}

async function loadFeaturesRegistry(): Promise<Record<string, FeatureRegistryEntry>> {
  const now = Date.now();
  if (featuresRegistryCache && now - featuresRegistryCacheAt < FEATURE_REGISTRY_TTL) {
    return featuresRegistryCache;
  }
  const result = await query(`SELECT id, label, description, is_active FROM features_registry`);
  const map: Record<string, FeatureRegistryEntry> = {};
  for (const row of result.rows) {
    map[row.id] = { ...row, loadedAt: now };
  }
  featuresRegistryCache = map;
  featuresRegistryCacheAt = now;
  return map;
}

export async function hasFeature(userId: string, featureId: string): Promise<boolean> {
  const sub = await getUserSubscription(userId);
  const plan = await getPlanById(sub.plan);
  if (!plan?.features?.[featureId]) return false;

  // Бесплатный план (plan_level === 0) не требует активной подписки —
  // фичи free-тарифа управляются напрямую из features_registry.
  // Платные плановые фичи доступны только при grace-aware активности.
  if (plan.plan_level > 0) {
    const access = computeAccessState(sub.expiresAt);
    if (!access.active) return false;
  }

  const registry = await loadFeaturesRegistry();
  const feature = registry[featureId];
  if (!feature?.is_active) return false;

  return true;
}

export function requireFeature(featureId: string) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const has = await hasFeature(userId, featureId);
    if (!has) {
      return res.status(403).json({ error: `Feature '${featureId}' not available` });
    }
    next();
  };
}

// ─── Trial expiration cron ─────────────────────────────────────────────────
export async function processTrialExpirations(): Promise<{
  processed: number;
  failed: number;
}> {
  const result = { processed: 0, failed: 0 };

  const since = USE_SQLITE
    ? "datetime('now', '-7 days')"
    : "NOW() - INTERVAL '7 days'";

  // TZ_TRIAL_DISTINCT: eliminate duplicate rows when a user has multiple
  // user_promo_uses records. DISTINCT ON works on PostgreSQL; SQLite uses GROUP BY.
  const trialSql = USE_SQLITE
    ? `SELECT u.id as user_id, u.email, u.subscription_plan, u.subscription_expires_at,
              MAX(uup.trial_days_used) as trial_days_used,
              MAX(uup.promo_code_id) as promo_code_id,
              MAX(uup.expected_renewal_price) as expected_renewal_price
       FROM users u
       JOIN user_promo_uses uup ON uup.user_id = u.id
       WHERE uup.trial_days_used IS NOT NULL
         AND u.subscription_expires_at < ${nowSql()}
         AND u.subscription_expires_at > ${since}
         AND u.subscription_active = TRUE
         AND u.scheduled_plan_downgrade IS NULL
       GROUP BY u.id, u.email, u.subscription_plan, u.subscription_expires_at`
    : `SELECT DISTINCT ON (u.id)
              u.id as user_id, u.email, u.subscription_plan, u.subscription_expires_at,
              uup.trial_days_used, uup.promo_code_id, uup.expected_renewal_price
       FROM users u
       JOIN user_promo_uses uup ON uup.user_id = u.id
       WHERE uup.trial_days_used IS NOT NULL
         AND u.subscription_expires_at < ${nowSql()}
         AND u.subscription_expires_at > ${since}
         AND u.subscription_active = TRUE
         AND u.scheduled_plan_downgrade IS NULL
       ORDER BY u.id, uup.created_at DESC`;

  const trialUsers = await query(trialSql, []);

  for (const row of trialUsers.rows) {
    try {
      await withUserLock(row.user_id, async () => {
        if (await hasRecentPendingPayment(row.user_id)) {
          console.log(`[TrialExpiration] User ${row.user_id} already has a recent pending payment, skipping`);
          return;
        }

        // Если автопродление отключено — не пытаемся списывать, сразу даунгрейд
        if (!row.subscription_auto_renew) {
          await scheduleDowngrade(row.user_id, 'free');
          await notifySubscriptionEvent(
            row.user_id,
            'grace_1d',
            'Автопродление отключено. Подписка будет переведена на Free.'
          );
          result.processed++;
          return;
        }

        const plan = await getPlanById(row.subscription_plan);
        if (!plan || !plan.is_active) {
          await scheduleDowngrade(row.user_id, 'free');
          await notifySubscriptionEvent(
            row.user_id,
            'grace_1d',
            `Тариф ${plan?.name || row.subscription_plan} больше не доступен. Подписка будет переведена на Free.`
          );
          result.processed++;
          return;
        }

        if (!IS_YOOKASSA_CONFIGURED) {
          // DEMO mode: grace period then downgrade
          await scheduleDowngrade(row.user_id, 'free');
          await notifySubscriptionEvent(
            row.user_id,
            'grace_1d',
            'Ваш пробный период закончился. Оформите подписку для продолжения.'
          );
          result.processed++;
          return;
        }

        const pmResult = await query(
          `SELECT payment_method_id, card_last4
           FROM user_payment_methods
           WHERE user_id = $1 AND is_active = TRUE
           ORDER BY is_default DESC, created_at DESC
           LIMIT 1`,
          [row.user_id]
        );
        if (pmResult.rows.length === 0) {
          await scheduleDowngrade(row.user_id, 'free');
          await notifySubscriptionEvent(
            row.user_id,
            'grace_1d',
            'Ваш пробный период закончился. Привяжите карту для продолжения подписки.'
          );
          result.processed++;
          return;
        }
        const paymentMethod = pmResult.rows[0];

        const trialBillingCycle: BillingCycle = plan.billing_frequency || 'monthly';
        const trialDurationDays = PLAN_BILLING_DAYS[trialBillingCycle] || 30;
        const amount = computePlanPrice(plan, trialBillingCycle);
        const paymentId = uuidv4();

        await query(
          `INSERT INTO payments
             (id, user_id, amount, base_amount, discount, method, status, plan_id, billing_cycle, duration_days, is_upgrade)
           VALUES ($1, $2, $3, $4, 0, 'bank_card', 'pending', $5, $6, $7, FALSE)`,
          [paymentId, row.user_id, amount, amount, row.subscription_plan, trialBillingCycle, trialDurationDays]
        );

        const yookassaRes = await axios.post(
          'https://api.yookassa.ru/v3/payments',
          {
            amount: { value: amount.toFixed(2), currency: 'RUB' },
            payment_method_id: paymentMethod.payment_method_id,
            capture: true,
            description: `PULSE ${plan.name} — продление после trial`.slice(0, 128),
            metadata: {
              payment_id: paymentId,
              user_id: row.user_id,
              plan_id: row.subscription_plan,
              billing_cycle: trialBillingCycle,
              duration_days: String(trialDurationDays),
              is_upgrade: 'false',
              auto_renew: 'true',
            },
            receipt: {
              customer: { email: row.email },
              items: [{
                description: `Подписка PULSE ${plan.name} (продление после trial)`.slice(0, 128),
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
              'Idempotence-Key': `trial-renew-${paymentId}`,
              'Content-Type': 'application/json',
            },
            timeout: 15000,
          }
        );

        await query(`UPDATE payments SET provider_ref = $1 WHERE id = $2`, [yookassaRes.data.id, paymentId]);

        if (yookassaRes.data.status === 'succeeded') {
          const activated = await activatePaymentIfNeeded(paymentId);
          if (activated) {
            console.log(`[TrialExpiration] Success: user ${row.user_id}, ${amount} RUB, card *${paymentMethod.card_last4 || '****'}`);
          } else {
            console.log(`[TrialExpiration] Payment ${paymentId} already activated by webhook`);
          }
          result.processed++;
        } else if (yookassaRes.data.status === 'canceled') {
          await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
          await scheduleDowngrade(row.user_id, 'free');
          await notifySubscriptionEvent(
            row.user_id,
            'grace_1d',
            'Ваш пробный период закончился. Привяжите новую карту для продолжения подписки.'
          );
          result.failed++;
        }
        // pending / waiting_for_capture → webhook will finish the job
      });
    } catch (err: any) {
      if (err.message?.includes('Lock already held')) {
        console.log(`[TrialExpiration] User ${row.user_id} is locked by another process, skipping`);
        continue;
      }
      console.error(`[TrialExpiration] Failed for user ${row.user_id}:`, err.response?.data || err.message);
      try {
        await scheduleDowngrade(row.user_id, 'free');
      } catch { /* ignore */ }
      result.failed++;
    }
  }

  return result;
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
    const [currentLevel, minLevel] = await Promise.all([planLevel(sub.plan), planLevel(minPlanId)]);
    if (currentLevel < minLevel) {
      return res.status(403).json({ error: 'Requires paid plan', required: minPlanId, current: sub.plan });
    }
    next();
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
