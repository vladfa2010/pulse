/**
 * =============================================================================
 * PULSE — Public Plans API
 * =============================================================================
 *
 * GET /api/plans — список тарифов (включая coming soon)
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
        priceMonthly: Number(p.price_monthly),
        priceYearly: Number(p.price_yearly),
        yearlyDiscount: p.yearly_discount,
        tagLimit: p.tag_limit,
        features: p.features || {},
        isActive: p.is_active,
        comingSoonLabel: p.coming_soon_label,
        isPopular: p.id === 'premium',
      })),
    });
  } catch (err: any) {
    console.error('[Plans] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

export default router;
