/**
 * =============================================================================
 * PULSE — Public Plans API
 * =============================================================================
 *
 * GET /api/plans — список активных тарифов
 */

import { Router } from 'express';
import { getActivePlans } from '../services/subscription';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const plans = await getActivePlans();
    res.json({
      plans: plans.map((p) => ({
        id: p.id,
        name: p.name,
        price: Number(p.price),
        billingFrequency: p.billing_frequency,
        yearlyDiscount: p.yearly_discount,
        tagLimit: p.tag_limit,
        planLevel: p.plan_level,
        features: p.features || {},
        isActive: p.is_active,
        isPopular: p.is_popular,
        comingSoonLabel: p.coming_soon_label,
        displayOrder: p.display_order,
      })),
    });
  } catch (err: any) {
    console.error('[Plans] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

export default router;
