import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

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

// POST /api/payment/create — create payment
router.post('/create', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { amount = 490, discount = 0, method = 'card' } = req.body;

    const finalAmount = Math.round(amount * (1 - discount / 100));
    const paymentId = uuidv4();

    await query(
      `INSERT INTO payments (id, user_id, amount, base_amount, discount, method, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [paymentId, userId, finalAmount, amount, discount, method]
    );

    res.json({ payment: { id: paymentId, amount: finalAmount, status: 'pending' } });
  } catch (err) {
    res.status(500).json({ error: 'Payment creation failed' });
  }
});

// POST /api/payment/confirm — confirm payment (demo)
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
       SET subscription_active = ${USE_SQLITE ? 1 : 1},
           subscription_expires_at = ${nowPlusDaysSql(30)}
       WHERE id = $1`,
      [userId]
    );

    res.json({ success: true, message: 'Subscription activated' });
  } catch (err) {
    res.status(500).json({ error: 'Payment confirmation failed' });
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
