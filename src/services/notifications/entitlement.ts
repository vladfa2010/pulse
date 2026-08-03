/**
 * PULSE — Entitlement: ЕДИНСТВЕННОЕ место, где решается «какому тарифу что доступно».
 *
 * Источник правды о тарифах — БД, а не код:
 *   subscription_plans.features (JSONB) + features_registry, редактируется из админки.
 *   План юзера: users.subscription_plan; активность: subscription_active + expires_at.
 *
 * Три измерения доступа:
 *   1. Доступ к ПРОДУКТУ — PRODUCT_ACCESS (ниже). Биллинг/механики — всем;
 *      weekly_report — только платным. Смена политики = одна строка здесь.
 *   2. Доступ к КАНАЛУ — фичи плана 'telegram'/'push' (уже есть в features_registry;
 *      email — всегда доступен, он неявный). Именно так тарифы задуманы в админке:
 *      free: telegram=false, push=false; base+: telegram=true, push=true.
 *   3. Лимит тегов — subscription_plans.tag_limit (free=3, base=10, premium=25, -1=без лимита).
 *
 * Воркеры НЕ фильтруют по подписке в SQL. Диспетчер спрашивает getEntitlement(),
 * и каждый отказ пишется в лог с причиной.
 */

import { query } from '../../config/db';
import { hasFeature } from '../subscription';
import { Product, Channel, Entitlement } from './types';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ── Доступ к продуктам ──────────────────────────────────────────────────────
// 'all'  — любой план, включая free
// 'paid' — только активная платная подписка
const PRODUCT_ACCESS: Record<Product, 'all' | 'paid'> = {
  digest: 'all',          // лимит тегов и каналы — из плана (ниже)
  news_alert: 'all',
  fact_check: 'all',
  engagement: 'all',      // механики удержания — всем
  billing: 'all',         // transactional — всегда
  weekly_report: 'paid',  // как раньше: только subscription_active
};

// ── Канал → фича-флаг плана (features_registry) ────────────────────────────
// null = канал не гейтится тарифом
const CHANNEL_FEATURE: Record<Channel, string | null> = {
  telegram: 'telegram',
  push: 'push',
  email: null,            // email неявный, доступен всем планам
};

interface ResolvedPlan {
  planId: string;
  paid: boolean;                 // активная платная подписка
  features: Record<string, any>;
  tagLimit: number;              // -1 = без лимита
}

const FREE_FALLBACK: ResolvedPlan = {
  planId: 'free',
  paid: false,
  features: { telegram: false, push: false },  // = features плана free из subscription_plans_v2
  tagLimit: 3,
};

async function resolvePlan(userId: string): Promise<ResolvedPlan> {
  const result = await query(
    `SELECT u.subscription_plan, u.subscription_active, u.subscription_expires_at,
            p.features, p.tag_limit, p.price_monthly
     FROM users u
     LEFT JOIN subscription_plans p ON p.id = u.subscription_plan
     WHERE u.id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return FREE_FALLBACK;

  const row = result.rows[0];
  const expired = row.subscription_expires_at && new Date(row.subscription_expires_at) < new Date();
  const active = !!row.subscription_active && !expired;
  // Trial-пользователи и так сидят на платном плане (промо выдаёт plan с price > 0),
  // отдельный флаг не нужен
  const paid = (row.price_monthly ?? 0) > 0;

  // Неактивная подписка = план free (поведение как раньше, но теперь управляется из админки)
  if (!active || !row.features) {
    return {
      ...FREE_FALLBACK,
      paid: false,
    };
  }

  return {
    planId: row.subscription_plan || 'free',
    paid,
    features: row.features || {},
    tagLimit: row.tag_limit ?? 3,
  };
}

/**
 * Может ли юзер получить продукт по каналу — и с каким лимитом тегов.
 * @param channel если не передан — проверяется только доступ к продукту
 */
export async function getEntitlement(
  userId: string,
  product: Product,
  channel?: Channel
): Promise<Entitlement> {
  const plan = await resolvePlan(userId);

  // 1. Продукт
  if (PRODUCT_ACCESS[product] === 'paid' && !plan.paid) {
    return { allowed: false, maxTags: 0, reason: `product '${product}' requires paid plan (current: ${plan.planId})` };
  }

  // 2. Канал — через hasFeature() чтобы учитывать features_registry.is_active
  if (channel) {
    const featureKey = CHANNEL_FEATURE[channel];
    if (featureKey) {
      const has = await hasFeature(userId, featureKey);
      if (!has) {
        return {
          allowed: false,
          maxTags: 0,
          reason: `channel '${channel}' not available (feature '${featureKey}' disabled in registry or plan)`,
        };
      }
    }
  }

  // 3. Лимит тегов из плана (используется как soft cap в дайджесте)
  return {
    allowed: true,
    maxTags: plan.tagLimit < 0 ? null : plan.tagLimit,
  };
}

/** Совместимость: простая проверка «платный ли юзер» (для UI-гейтов). */
export async function isPremiumActive(userId: string): Promise<boolean> {
  return (await resolvePlan(userId)).paid;
}

/** Для совместимости со старыми вызовами isPremium(). */
export async function isPremium(userId: string): Promise<boolean> {
  return isPremiumActive(userId);
}

export async function getPlanTagLimit(userId: string): Promise<number> {
  return (await resolvePlan(userId)).tagLimit;
}

export async function getPlanFeatures(userId: string): Promise<Record<string, any>> {
  return (await resolvePlan(userId)).features;
}

export async function getPlanId(userId: string): Promise<string> {
  return (await resolvePlan(userId)).planId;
}

export function getDefaultFreeFeatures(): Record<string, any> {
  return FREE_FALLBACK.features;
}

export function getDefaultFreeTagLimit(): number {
  return FREE_FALLBACK.tagLimit;
}

export function isProductPaidOnly(product: Product): boolean {
  return PRODUCT_ACCESS[product] === 'paid';
}

export function getChannelFeatureKey(channel: Channel): string | null {
  return CHANNEL_FEATURE[channel];
}

export function getProductAccessLevel(product: Product): 'all' | 'paid' {
  return PRODUCT_ACCESS[product];
}
