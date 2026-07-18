import { Router } from 'express';
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
} from '../services/subscription';
import { listAllFeatures, createFeature, updateFeature } from './features';
import { getPromoByCode } from '../services/promo';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

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
           u.id, u.email, u.username, u.is_verified, u.is_admin,
           u.subscription_active, u.subscription_expires_at,
           u.news_count, u.created_at,
           COALESCE(p.total_payments, 0) as total_payments,
           COALESCE(p.total_amount, 0) as total_amount
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*) as total_payments,
                  COALESCE(SUM(amount), 0) as total_amount
           FROM payments
           WHERE status = 'completed'
           GROUP BY user_id
         ) p ON p.user_id = u.id
         ORDER BY u.created_at DESC LIMIT 500`
      : `SELECT 
           u.id, u.email, u.username, u.is_verified, u.is_admin,
           u.subscription_active, u.subscription_expires_at,
           u.news_count, u.created_at,
           COALESCE(p.total_payments, 0)::int as total_payments,
           COALESCE(p.total_amount, 0)::float as total_amount
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*)::int as total_payments,
                  COALESCE(SUM(amount), 0)::float as total_amount
           FROM payments
           WHERE status = 'completed'
           GROUP BY user_id
         ) p ON p.user_id = u.id
         ORDER BY u.created_at DESC LIMIT 500`;

    const result = await query(sql);

    const users = result.rows.map((row: any) => ({
      ...row,
      total_payments: Number(row.total_payments ?? 0),
      total_amount: Number(row.total_amount ?? 0),
    }));

    res.json({ users });
  } catch (err) {
    console.error('[Admin] Failed to fetch users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
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
        if (body[field] !== undefined) {
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

    const allowed = ['name', 'price', 'yearly_discount', 'tag_limit', 'features', 'is_active', 'is_popular', 'coming_soon_label', 'display_order'];
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

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(planId);
    await query(
      `UPDATE subscription_plans SET ${fields.join(', ')}, updated_at = ${nowSql()} WHERE id = $${paramIdx}`,
      values
    );

    const updated = await getPlanById(planId);
    res.json({ plan: updated ? normalizePlanRow(updated) : null });
  } catch (err: any) {
    console.error('[Admin] Update plan error:', err.message);
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

// DELETE /api/admin/plans/:planId — soft delete
router.delete('/plans/:planId', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const planId = req.params.planId;
    const plan = await getPlanById(planId);
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const pendingPayments = await query(
      `SELECT COUNT(*) as cnt FROM payments WHERE plan_id = $1 AND status = 'pending'`,
      [planId]
    );
    const pendingCount = Number(pendingPayments.rows[0]?.cnt || 0);
    if (pendingCount > 0) {
      return res.status(409).json({
        error: `Cannot delete: ${pendingCount} pending payments. Wait or cancel them.`,
        pendingPayments: pendingCount,
      });
    }

    const subscriberCount = await getActiveSubscriberCount(planId);
    await query(`UPDATE subscription_plans SET deleted_at = ${nowSql()} WHERE id = $1`, [planId]);

    res.json({
      deleted: true,
      plan_id: planId,
      active_subscribers: subscriberCount,
      message: `Тариф удалён из каталога. ${subscriberCount} активных подписчиков останутся на нём до конца оплаченного периода.`,
    });
  } catch (err: any) {
    console.error('[Admin] Delete plan error:', err.message);
    res.status(500).json({ error: 'Failed to delete plan' });
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

export default router;
