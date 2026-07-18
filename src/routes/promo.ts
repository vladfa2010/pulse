/**
 * =============================================================================
 * PULSE — Public Promo Validation Route
 * =============================================================================
 *
 * GET /api/promo/validate?code=START50&planId=premium
 */

import { Router } from 'express';
import { validate } from '../middleware/validate';
import { ValidatePromoQuerySchema } from '../schemas/promo';
import { validatePromoCode, getPromoByCode, applyPercentDiscount } from '../services/promo';
import { getPlanById, computePlanPrice } from '../services/subscription';

const router = Router();

router.get('/', validate(ValidatePromoQuerySchema), async (req, res) => {
  try {
    const { code, planId } = req.query as { code: string; planId: string };

    const plan = await getPlanById(planId);
    if (!plan || !plan.is_active || plan.deleted_at) {
      return res.json({ valid: false, reason: 'plan_not_available' });
    }

    const result = await validatePromoCode(code, planId);
    if (!result.valid) {
      return res.json({ valid: false, reason: result.reason });
    }

    const promo = result.promo!;
    const basePrice = Number(plan.price);
    const yearlyPrice = computePlanPrice(plan, 'yearly');

    if (promo.discount_type === 'trial') {
      return res.json({
        valid: true,
        code: promo.code,
        discount_type: promo.discount_type,
        discount_value: promo.discount_value,
        final_price: 1.0,
        final_price_yearly: 1.0,
        trial_days: promo.discount_value,
        description: promo.description,
      });
    }

    const finalMonthly = applyPercentDiscount(basePrice, promo.discount_value);
    const finalYearly = applyPercentDiscount(yearlyPrice, promo.discount_value);

    return res.json({
      valid: true,
      code: promo.code,
      discount_type: promo.discount_type,
      discount_value: promo.discount_value,
      final_price: finalMonthly,
      final_price_yearly: finalYearly,
      description: promo.description,
    });
  } catch (err: any) {
    console.error('[Promo] Validate error:', err.message);
    res.status(500).json({ error: 'Failed to validate promo code' });
  }
});

export default router;
