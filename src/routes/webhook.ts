import { Router } from 'express';
import { query } from '../config/db';

const router = Router();

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
      const paymentResult = await query(
        `UPDATE payments SET status = $1, paid_at = NOW()
         WHERE provider_ref = $2
         RETURNING user_id`,
        [status, object.id]
      );

      if (paymentResult.rows.length > 0 && status === 'completed') {
        const userId = paymentResult.rows[0].user_id;

        // Activate subscription for 30 days
        await query(
          `UPDATE users
           SET subscription_active = TRUE,
               subscription_expires_at = NOW() + INTERVAL '30 days'
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
