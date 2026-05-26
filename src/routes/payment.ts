import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import axios from 'axios';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

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

function nowPlusDaysSql(days: number): string {
  return USE_SQLITE ? `datetime('now', '+${days} days')` : `NOW() + INTERVAL '${days} days'`;
}

// Basic Auth header for YuKassa
function yookassaAuth(): string {
  return 'Basic ' + Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
}

// POST /api/payment/create — create payment via YooKassa
router.post('/create', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { amount = 490, discount = 0, method = 'bank_card' } = req.body;

    const finalAmount = Math.round(amount * (1 - discount / 100));
    const paymentId = uuidv4();

    // 1) Save initial record
    await query(
      `INSERT INTO payments (id, user_id, amount, base_amount, discount, method, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [paymentId, userId, finalAmount, amount, discount, method]
    );

    // 2) If YuKassa is not configured, fall back to DEMO mode (local confirmation page)
    if (!IS_YOOKASSA_CONFIGURED) {
      console.log('[Payment] YuKassa not configured, using DEMO mode');
      return res.json({
        payment: { id: paymentId, amount: finalAmount, status: 'pending' },
        demo: true,
        confirmation_url: `${FRONTEND_URL}/#/payment/return?demo=1&payment_id=${paymentId}`
      });
    }

    // 3) Create payment via YuKassa API
    const idempotenceKey = uuidv4();
    const yookassaPayload = {
      amount: {
        value: finalAmount.toFixed(2),
        currency: 'RUB'
      },
      capture: true,
      confirmation: {
        type: 'redirect',
        return_url: `${FRONTEND_URL}/#/payment/return?payment_id=${paymentId}`
      },
      description: `PULSE Premium — ${req.user!.email || userId}`,
      metadata: {
        payment_id: paymentId,
        user_id: userId,
        discount: String(discount)
      }
    };

    console.log('[YuKassa] Creating payment:', yookassaPayload);

    const yookassaRes = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      yookassaPayload,
      {
        headers: {
          'Authorization': yookassaAuth(),
          'Idempotence-Key': idempotenceKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const yookassaData = yookassaRes.data;
    console.log('[YuKassa] Payment created:', yookassaData.id);

    // 4) Save YuKassa provider_ref
    await query(
      `UPDATE payments SET provider_ref = $1 WHERE id = $2`,
      [yookassaData.id, paymentId]
    );

    // 5) Return confirmation_url to frontend
    res.json({
      payment: {
        id: paymentId,
        amount: finalAmount,
        status: 'pending'
      },
      confirmation_url: yookassaData.confirmation?.confirmation_url
    });

  } catch (err: any) {
    console.error('[Payment] Create failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Payment creation failed',
      details: err.response?.data?.description || err.message
    });
  }
});

// POST /api/payment/confirm — manual confirmation (admin or demo)
router.post('/confirm', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { paymentId } = req.body;

    // Update payment
    await query(
      `UPDATE payments SET status = 'completed', paid_at = ${nowSql()} WHERE id = $1`,
      [paymentId]
    );

    // Activate subscription for 30 days
    await query(
      `UPDATE users
       SET subscription_active = 1,
           subscription_expires_at = ${nowPlusDaysSql(30)}
       WHERE id = $1`,
      [userId]
    );

    res.json({ success: true, message: 'Subscription activated' });
  } catch (err) {
    res.status(500).json({ error: 'Payment confirmation failed' });
  }
});

// GET /api/payment/status/:id — check payment status
router.get('/status/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    // Get local payment record
    const result = await query(
      'SELECT id, amount, base_amount, discount, method, status, provider_ref, paid_at, created_at FROM payments WHERE id = $1 AND user_id = $2',
      [id, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const payment = result.rows[0];

    // If YuKassa is configured and we have a provider_ref, check with YuKassa
    if (IS_YOOKASSA_CONFIGURED && payment.provider_ref && payment.status === 'pending') {
      try {
        const yookassaRes = await axios.get(
          `https://api.yookassa.ru/v3/payments/${payment.provider_ref}`,
          {
            headers: { 'Authorization': yookassaAuth() },
            timeout: 10000
          }
        );

        const yookassaStatus = yookassaRes.data.status;
        console.log(`[YuKassa] Status check for ${payment.provider_ref}: ${yookassaStatus}`);

        if (yookassaStatus === 'succeeded' && payment.status !== 'completed') {
          // Update local DB
          await query(
            `UPDATE payments SET status = 'completed', paid_at = ${nowSql()} WHERE id = $1`,
            [id]
          );
          await query(
            `UPDATE users
             SET subscription_active = 1,
                 subscription_expires_at = ${nowPlusDaysSql(30)}
             WHERE id = $1`,
            [userId]
          );
          payment.status = 'completed';
          payment.paid_at = new Date().toISOString();
        } else if (yookassaStatus === 'canceled') {
          await query(
            `UPDATE payments SET status = 'failed' WHERE id = $1`,
            [id]
          );
          payment.status = 'failed';
        }
      } catch (ykErr: any) {
        console.error('[YuKassa] Status check failed:', ykErr.message);
      }
    }

    res.json({ payment });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// GET /api/payment/history
router.get('/history', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const result = await query(
      `SELECT id, amount, base_amount, discount, method, status, paid_at, created_at
       FROM payments
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [req.user!.userId]
    );
    res.json({ payments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

export default router;
