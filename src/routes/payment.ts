/**
 * =============================================================================
 * PULSE — Payment Routes (Платежи через YuKassa)
 * =============================================================================
 *
 * Эндпоинты:
 *   POST /api/payment/create        — Создать платёж (возвращает ссылку на YuKassa)
 *   GET  /api/payment/upgrade-preview — Расчёт доплаты при апгрейде
 *   POST /api/payment/confirm       — Подтвердить платёж (demo-режим)
 *   GET  /api/payment/status/:id    — Проверить статус платежа
 *   GET  /api/payment/history       — История платежей пользователя
 *   POST /api/payment/force-check   — Принудительная проверка статуса
 *
 * YuKassa Flow (реальный):
 *   1. Фронтенд → POST /api/payment/create { planId, billingCycle }
 *   2. Бэкенд → YuKassa API
 *   3. YuKassa → возвращает confirmation_url
 *   4. Фронтенд редиректит пользователя на оплату
 *   5. YuKassa → webhook (/api/webhook/yookassa) → подписка активирована
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import { validate } from '../middleware/validate';
import { CreatePaymentSchema, ConfirmPaymentSchema, UpgradePreviewSchema } from '../schemas/payment';
import axios from 'axios';
import {
  activateSubscription,
  calculateUpgradePrice,
  getPlanById,
  getUserSubscription,
  PLAN_BILLING_DAYS,
  planLevel,
} from '../services/subscription';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

const BACKEND_URL = process.env.BACKEND_URL || 'https://pulse-api-bsov.onrender.com';
const WEBHOOK_URL = `${BACKEND_URL}/api/webhook/yookassa`;

const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
const IS_YOOKASSA_CONFIGURED = YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://pulse-frontend-jt53.onrender.com';

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

function yookassaAuth(): string {
  return 'Basic ' + Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
}

function buildReturnUrl(paymentId: string): string {
  // Hash-router reads search params after the hash fragment
  return `${FRONTEND_URL}/#/payment/return?payment_id=${paymentId}&return=1`;
}

function buildDemoReturnUrl(paymentId: string): string {
  return `${FRONTEND_URL}/#/payment/return?demo=1&payment_id=${paymentId}&return=1`;
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/payment/upgrade-preview
// ═══════════════════════════════════════════════════════════════════════════
router.get('/upgrade-preview', authMiddleware, validate(UpgradePreviewSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { targetPlan, billingCycle } = req.query as any;

    const sub = await getUserSubscription(userId);
    const preview = await calculateUpgradePrice(
      sub.plan,
      targetPlan as string,
      billingCycle as 'monthly' | 'yearly',
      sub.expiresAt
    );

    res.json(preview);
  } catch (err: any) {
    console.error('[Payment] Upgrade preview failed:', err.message);
    res.status(500).json({ error: 'Upgrade preview failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/payment/create
// ═══════════════════════════════════════════════════════════════════════════
router.post('/create', authMiddleware, validate(CreatePaymentSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const userEmail = req.user!.email || '';
    const planId = req.body.planId as string;
    const billingCycle = req.body.billingCycle as 'monthly' | 'yearly';
    const isUpgrade = !!req.body.isUpgrade;
    const method = (req.body.method as string) || 'bank_card';

    const plan = await getPlanById(planId);
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan' });
    }
    if (!plan.is_active) {
      return res.status(400).json({ error: 'Plan not available for purchase' });
    }

    const sub = await getUserSubscription(userId);

    // Validate upgrade direction
    if (isUpgrade && planLevel(planId) <= planLevel(sub.plan)) {
      return res.status(400).json({ error: 'Invalid upgrade direction' });
    }

    const durationDays = PLAN_BILLING_DAYS[billingCycle];
    const fullPrice = billingCycle === 'monthly' ? Number(plan.price_monthly) : Number(plan.price_yearly);

    let finalAmount = fullPrice;
    if (isUpgrade) {
      const preview = await calculateUpgradePrice(sub.plan, planId, billingCycle, sub.expiresAt);
      finalAmount = preview.topUpAmount;
    }

    if (finalAmount <= 0) {
      // Free switch (e.g., same price) — activate immediately
      await activateSubscription(userId, planId, durationDays);
      return res.json({ success: true, activated: true, planId, billingCycle });
    }

    const paymentId = uuidv4();

    await query(
      `INSERT INTO payments (id, user_id, amount, base_amount, discount, method, status, plan_id, billing_cycle, duration_days)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)`,
      [paymentId, userId, finalAmount, fullPrice, plan.yearly_discount, method, planId, billingCycle, durationDays]
    );

    // DEMO режим
    if (!IS_YOOKASSA_CONFIGURED) {
      return res.json({
        payment: { id: paymentId, amount: finalAmount, status: 'pending' },
        demo: true,
        confirmation_url: buildDemoReturnUrl(paymentId),
      });
    }

    const idempotenceKey = uuidv4();

    const yookassaPayload: any = {
      amount: { value: finalAmount.toFixed(2), currency: 'RUB' },
      capture: true,
      confirmation: { type: 'redirect', return_url: buildReturnUrl(paymentId) },
      description: `PULSE ${plan.name} — ${userEmail}`.slice(0, 128),
      save_payment_method: 'on',
      merchant_customer_id: userId,
      metadata: {
        payment_id: paymentId,
        user_id: userId,
        plan_id: planId,
        billing_cycle: billingCycle,
        duration_days: String(durationDays),
        is_upgrade: String(isUpgrade),
      },
      receipt: {
        customer: { email: userEmail },
        items: [{
          description: `Подписка PULSE ${plan.name} (${durationDays} дней)`.slice(0, 128),
          quantity: '1.00',
          amount: { value: finalAmount.toFixed(2), currency: 'RUB' },
          vat_code: 1,
          payment_subject: 'service',
          payment_mode: 'full_payment',
        }],
      },
    };

    const yookassaRes = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      yookassaPayload,
      {
        headers: {
          Authorization: yookassaAuth(),
          'Idempotence-Key': idempotenceKey,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    await query(
      `UPDATE payments SET provider_ref = $1 WHERE id = $2`,
      [yookassaRes.data.id, paymentId]
    );

    res.json({
      payment: { id: paymentId, amount: finalAmount, status: 'pending' },
      confirmation_url: yookassaRes.data.confirmation?.confirmation_url,
    });
  } catch (err: any) {
    console.error('[Payment] Create failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Payment creation failed',
      details: err.response?.data?.description || err.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/payment/confirm — demo mode
// ═══════════════════════════════════════════════════════════════════════════
router.post('/confirm', authMiddleware, validate(ConfirmPaymentSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { paymentId } = req.body;

    const paymentResult = await query(
      `SELECT plan_id, duration_days FROM payments WHERE id = $1 AND user_id = $2`,
      [paymentId, userId]
    );
    if (paymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const { plan_id, duration_days } = paymentResult.rows[0];

    await query(
      `UPDATE payments SET status = 'completed', paid_at = ${nowSql()} WHERE id = $1`,
      [paymentId]
    );

    await activateSubscription(userId, plan_id || 'premium', duration_days || 30, paymentId);

    const completedPayment = await query(
      `SELECT id, amount, plan_id, billing_cycle, duration_days, status FROM payments WHERE id = $1`,
      [paymentId]
    );

    res.json({
      success: true,
      message: 'Subscription activated',
      payment: completedPayment.rows[0] || { id: paymentId, amount: 0, status: 'completed' },
    });
  } catch (err) {
    res.status(500).json({ error: 'Payment confirmation failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/payment/status/:id
// ═══════════════════════════════════════════════════════════════════════════
router.get('/status/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    const result = await query(
      `SELECT id, amount, base_amount, discount, method, status, provider_ref, plan_id, billing_cycle, duration_days,
              paid_at, created_at FROM payments WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const payment = result.rows[0];

    if (IS_YOOKASSA_CONFIGURED && payment.provider_ref && payment.status === 'pending') {
      try {
        const yookassaRes = await axios.get(
          `https://api.yookassa.ru/v3/payments/${payment.provider_ref}`,
          { headers: { Authorization: yookassaAuth() }, timeout: 15000 }
        );
        const yookassaStatus = yookassaRes.data.status;

        if (yookassaStatus === 'succeeded') {
          await query(
            `UPDATE payments SET status = 'completed', paid_at = ${nowSql()} WHERE id = $1`,
            [id]
          );
          await activateSubscription(
            userId,
            payment.plan_id || 'premium',
            payment.duration_days || 30,
            id
          );
          payment.status = 'completed';
          payment.paid_at = new Date().toISOString();
        } else if (yookassaStatus === 'canceled') {
          await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [id]);
          payment.status = 'failed';
        }
      } catch (ykErr: any) {
        console.error(`[YuKassa] Status check failed for ${id}:`, ykErr.response?.data || ykErr.message);
      }
    }

    res.json({ payment });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/payment/history
// ═══════════════════════════════════════════════════════════════════════════
router.get('/history', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const result = await query(
      `SELECT id, amount, base_amount, discount, method, status, plan_id, billing_cycle, duration_days,
              paid_at, created_at FROM payments WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.userId]
    );
    res.json({ payments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/payment/force-check
// ═══════════════════════════════════════════════════════════════════════════
router.post('/force-check', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { paymentId } = req.body;
    const userId = req.user!.userId;

    if (!paymentId) {
      return res.status(400).json({ error: 'paymentId required' });
    }

    const result = await query(
      `SELECT id, status, provider_ref, plan_id, duration_days FROM payments WHERE id = $1 AND user_id = $2`,
      [paymentId, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const payment = result.rows[0];

    if (payment.status === 'completed') {
      return res.json({ status: 'completed', message: 'Already completed' });
    }

    if (!IS_YOOKASSA_CONFIGURED || !payment.provider_ref) {
      return res.status(400).json({ error: 'YuKassa not configured or no provider_ref' });
    }

    const yookassaRes = await axios.get(
      `https://api.yookassa.ru/v3/payments/${payment.provider_ref}`,
      { headers: { Authorization: yookassaAuth() }, timeout: 15000 }
    );
    const yookassaStatus = yookassaRes.data.status;

    if (yookassaStatus === 'succeeded') {
      await query(
        `UPDATE payments SET status = 'completed', paid_at = ${nowSql()} WHERE id = $1`,
        [paymentId]
      );
      await activateSubscription(
        userId,
        payment.plan_id || 'premium',
        payment.duration_days || 30,
        paymentId
      );
      return res.json({ status: 'completed', message: 'Payment confirmed, subscription activated' });
    } else if (yookassaStatus === 'canceled') {
      await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
      return res.json({ status: 'failed', message: 'Payment was canceled' });
    } else {
      return res.json({ status: 'pending', yookassaStatus, message: 'Payment still pending' });
    }
  } catch (err: any) {
    console.error('[Payment] Force-check failed:', err.response?.data || err.message);
    res.status(500).json({ error: 'Force-check failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Auto-setup YooKassa webhook on server start
// ═══════════════════════════════════════════════════════════════════════════
export async function setupYookassaWebhook(): Promise<void> {
  if (!IS_YOOKASSA_CONFIGURED) {
    console.log('[YuKassa] Webhook auto-setup skipped (not configured)');
    return;
  }

  try {
    const listRes = await axios.get(
      'https://api.yookassa.ru/v3/webhooks',
      { headers: { Authorization: yookassaAuth() }, timeout: 15000 }
    );

    const webhooks = listRes.data.items || [];
    const existingSucceeded = webhooks.find((w: any) => w.url === WEBHOOK_URL && w.event === 'payment.succeeded');
    const existingCanceled = webhooks.find((w: any) => w.url === WEBHOOK_URL && w.event === 'payment.canceled');

    if (existingSucceeded && existingCanceled) {
      console.log('[YuKassa] Webhooks already configured:', WEBHOOK_URL);
      return;
    }

    for (const wh of webhooks) {
      if (wh.url?.includes('onrender.com') || wh.url?.includes('pulse')) {
        try {
          await axios.delete(`https://api.yookassa.ru/v3/webhooks/${wh.id}`, {
            headers: { Authorization: yookassaAuth() }, timeout: 10000
          });
          console.log('[YuKassa] Removed old webhook:', wh.url);
        } catch {
          // ignore
        }
      }
    }

    await axios.post(
      'https://api.yookassa.ru/v3/webhooks',
      { event: 'payment.succeeded', url: WEBHOOK_URL },
      { headers: { Authorization: yookassaAuth() }, timeout: 15000 }
    );

    await axios.post(
      'https://api.yookassa.ru/v3/webhooks',
      { event: 'payment.canceled', url: WEBHOOK_URL },
      { headers: { Authorization: yookassaAuth() }, timeout: 15000 }
    );

    console.log('[YuKassa] Webhooks configured:', WEBHOOK_URL);
  } catch (err: any) {
    console.error('[YuKassa] Webhook setup failed:', err.response?.data || err.message);
  }
}

export default router;
