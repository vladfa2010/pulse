import { Router } from 'express';
import { query } from '../config/db';
import axios from 'axios';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// HMAC helper for secure Telegram linking (copied to avoid circular import)
function verifyLinkToken(userId: string, token: string): boolean {
  const secret = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!secret) return false;
  const expected = require('crypto').createHmac('sha256', secret).update(userId).digest('hex').slice(0, 16);
  return expected === token;
}

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
           SET subscription_active = TRUE,
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

// Telegram Bot webhook — POST /api/webhook/telegram
router.post('/telegram', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message?.text || !message?.from || !BOT_TOKEN) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id.toString();
    const text = message.text.trim();
    const username = message.from.username || message.from.first_name || 'User';

    console.log(`[TG Bot] ${username} (${chatId}): ${text}`);

    // Handle /start with payload: /start <user_id>:<token>
    const startMatch = text.match(/^\/start\s+(\S+)/i);
    if (startMatch) {
      const payload = startMatch[1];
      const parts = payload.split(':');
      if (parts.length === 2) {
        const { verifyLinkToken } = await import('../index');
        if (verifyLinkToken(parts[0], parts[1])) {
          const userId = parts[0];
          // Save connection
          await query(
            `INSERT INTO user_channels (user_id, channel, target, is_active)
             VALUES ($1, 'telegram', $2, TRUE)
             ON CONFLICT (user_id, channel) DO UPDATE SET target = $2, is_active = TRUE`,
            [userId, chatId]
          );
          await query(
            `UPDATE notification_settings SET tg_digest_enabled = TRUE WHERE user_id = $1`,
            [userId]
          );
          await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: '✅ PULSE подключен!\n\nДайджесты будут приходить по расписанию.\n\nКоманды:\n/now — дайджест сейчас\n/stop — отключить',
          });
          return res.sendStatus(200);
        }
      }
    }

    // Simple commands
    switch (text.toLowerCase()) {
      case '/start': {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: '👋 PULSE — инвестиционные новости\n\nДля подключения:\n1. Войдите на сайт\n2. Профиль → Уведомления → Подключить Telegram',
        });
        break;
      }
      case '/stop': {
        await query(`UPDATE notification_settings SET tg_digest_enabled = FALSE WHERE user_id = (SELECT user_id FROM user_channels WHERE target = $1 AND channel = 'telegram')`, [chatId]);
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: '🔕 Рассылка приостановлена.\n\nДля возобновления: /start',
        });
        break;
      }
      case '/now': {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: chatId,
          text: '⏳ Формирую дайджест...',
        });
        break;
      }
    }

    res.sendStatus(200);
  } catch (err: any) {
    console.error('[TG Bot] Webhook error:', err.message);
    res.sendStatus(200); // Always return 200 to Telegram
  }
});

export default router;
