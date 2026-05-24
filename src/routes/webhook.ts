import { Router } from 'express';
import { query } from '../config/db';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

function nowPlusDaysSql(days: number): string {
  return USE_SQLITE ? `datetime('now', '+${days} days')` : `NOW() + INTERVAL '${days} days'`;
}

// YooKassa webhook — POST /api/webhook/yookassa
router.post('/yookassa', async (req, res) => {
  try {
    const { event, object } = req.body;

    if (!object || !object.id) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    // Log webhook
    console.log('[YooKassa Webhook]', event, object.id);

    if (event === 'payment.succeeded' || event === 'payment.canceled') {
      const status = event === 'payment.succeeded' ? 'completed' : 'failed';

      // Update payment status
      await query(
        `UPDATE payments SET status = $1, paid_at = ${nowSql()} WHERE provider_ref = $2`,
        [status, object.id]
      );

      // Get user_id
      const paymentResult = await query(
        'SELECT user_id FROM payments WHERE provider_ref = $1',
        [object.id]
      );

      if (paymentResult.rows.length > 0 && status === 'completed') {
        const userId = paymentResult.rows[0].user_id;

        // Activate subscription for 30 days
        await query(
          `UPDATE users
           SET subscription_active = ${USE_SQLITE ? 1 : 1},
               subscription_expires_at = ${nowPlusDaysSql(30)}
           WHERE id = $1`,
          [userId]
        );

        console.log(`[YooKassa] Subscription activated for user ${userId}`);
      }
    }

    // Always return 200 to YooKassa
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('YooKassa webhook error:', err);
    // Still return 200 so YooKassa doesn't retry indefinitely
    res.status(200).json({ received: true, error: 'Processing failed' });
  }
});

export default router;
