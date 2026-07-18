/**
 * =============================================================================
 * PULSE — Promo Code Service
 * =============================================================================
 *
 * Validation and application of promo codes for subscription payments.
 */

import { query } from '../config/db';
import { parseDbJson } from './subscription';

export interface PromoCode {
  id: string;
  code: string;
  description: string | null;
  discount_type: 'percent' | 'trial';
  discount_value: number;
  applicable_plans: string[] | null;
  max_uses: number | null;
  uses_count: number;
  valid_from: string;
  expires_at: string | null;
  is_active: boolean;
}

export interface PromoValidationResult {
  valid: boolean;
  promo?: PromoCode;
  finalPrice?: number;
  trialDays?: number;
  reason?: string;
}

function normalizeApplicablePlans(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return null;
}

export async function getPromoByCode(code: string): Promise<PromoCode | null> {
  const result = await query(
    `SELECT * FROM promo_codes WHERE code = $1 LIMIT 1`,
    [code]
  );
  if (!result.rows[0]) return null;
  const promo = result.rows[0];
  promo.applicable_plans = normalizeApplicablePlans(promo.applicable_plans);
  return promo;
}

export async function validatePromoCode(
  code: string,
  planId: string,
  userId?: string
): Promise<PromoValidationResult> {
  const promo = await getPromoByCode(code);
  if (!promo) {
    return { valid: false, reason: 'not_found' };
  }
  if (!promo.is_active) {
    return { valid: false, reason: 'inactive' };
  }

  const now = new Date();
  const validFrom = promo.valid_from ? new Date(promo.valid_from) : null;
  const expiresAt = promo.expires_at ? new Date(promo.expires_at) : null;

  if (validFrom && now < validFrom) {
    return { valid: false, reason: 'not_started' };
  }
  if (expiresAt && now >= expiresAt) {
    return { valid: false, reason: 'expired' };
  }
  if (promo.max_uses !== null && promo.uses_count >= promo.max_uses) {
    return { valid: false, reason: 'exhausted' };
  }
  if (promo.applicable_plans && !promo.applicable_plans.includes(planId)) {
    return { valid: false, reason: 'not_applicable' };
  }

  if (userId) {
    const used = await query(
      `SELECT 1 FROM user_promo_uses
       WHERE user_id = $1 AND promo_code_id = $2 LIMIT 1`,
      [userId, promo.id]
    );
    if (used.rows.length > 0) {
      return { valid: false, reason: 'already_used' };
    }
  }

  return { valid: true, promo };
}

export function applyPercentDiscount(basePrice: number, discountValue: number): number {
  const discounted = basePrice * (1 - discountValue / 100);
  return Math.max(1.0, Math.round(discounted * 100) / 100);
}

export async function applyPromoToPayment(
  paymentId: string,
  promo: PromoCode,
  userId: string,
  planId: string,
  billingCycle: string,
  basePrice: number
): Promise<{ finalAmount: number; trialDays?: number; discountApplied: number }> {
  if (promo.discount_type === 'trial') {
    const trialDays = promo.discount_value;
    await query(
      `UPDATE payments SET
         promo_code = $1,
         promo_discount_type = $2,
         promo_discount_value = $3
       WHERE id = $4`,
      [promo.code, promo.discount_type, promo.discount_value, paymentId]
    );
    await query(
      `INSERT INTO user_promo_uses
         (user_id, promo_code_id, plan_id, billing_cycle, trial_days_used, payment_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, promo_code_id) DO NOTHING`,
      [userId, promo.id, planId, billingCycle, trialDays, paymentId]
    );
    return { finalAmount: 1.0, trialDays, discountApplied: 0 };
  }

  const finalAmount = applyPercentDiscount(basePrice, promo.discount_value);
  const discountApplied = Math.round((basePrice - finalAmount) * 100) / 100;

  await query(
    `UPDATE payments SET
       promo_code = $1,
       promo_discount_type = $2,
       promo_discount_value = $3
     WHERE id = $4`,
    [promo.code, promo.discount_type, promo.discount_value, paymentId]
  );
  await query(
    `INSERT INTO user_promo_uses
       (user_id, promo_code_id, plan_id, billing_cycle, discount_applied, payment_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, promo_code_id) DO NOTHING`,
    [userId, promo.id, planId, billingCycle, discountApplied, paymentId]
  );
  return { finalAmount, discountApplied };
}

export async function incrementPromoUsage(promoId: string): Promise<void> {
  await query(
    `UPDATE promo_codes SET uses_count = uses_count + 1, updated_at = ${
      process.env.USE_SQLITE === 'true' ? "datetime('now')" : 'NOW()'
    } WHERE id = $1`,
    [promoId]
  );
}
