import { Router } from 'express';
import { query } from '../config/db';
import axios from 'axios';
import { isYookassaIp, getClientIp } from '../services/ipCheck';
import { activateSubscription, savePaymentMethod } from '../services/subscription';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// User state for multi-step flows (e.g., adding a tag)
// Map<chatId, { action: 'awaiting_tag_input' | 'confirming_tag', data?: any }>
const userStates = new Map<string, { action: string; data?: any }>();

// Tag keywords database (same as frontend)
const STANDARD_TAGS: Record<string, string[]> = {
  nvda: ['nvidia', 'nvda', 'энвидиа'],
  apple: ['apple', 'aapl', 'эпл', 'эппл'],
  tesla: ['tesla', 'tsla', 'тесла'],
  sber: ['сбер', 'сбербанк', 'sber'],
  gazprom: ['газпром', 'gazprom'],
  lukoil: ['лукойл', 'lukoil'],
  yandex: ['яндекс', 'yandex', 'yndx'],
  google: ['google', 'goog', 'алфабет', 'alphabet'],
  amazon: ['amazon', 'amzn', 'амазон'],
  microsoft: ['microsoft', 'msft', 'майкрософт'],
  btc: ['bitcoin', 'btc', 'биткоин', 'биткойн'],
  eth: ['ethereum', 'eth', 'эфириум'],
  oil: ['нефть', 'oil', 'brent', 'брент'],
  gold: ['золото', 'gold'],
  sp500: ['s&p 500', 'sp500', 'spx', 'эс-энд-би'],
  moex: ['moex', 'мосбиржа', 'индекс мосбиржи'],
  rub: ['рубль', 'ruble', 'usdrub', 'eurrub'],
  fed: ['фрс', 'fed', 'federal reserve', 'пowell'],
};

// HMAC helper for secure Telegram linking
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

// ═══════════════════════════════════════════════════════════════════════════
// YooKassa webhook — POST /api/webhook/yookassa
// ═══════════════════════════════════════════════════════════════════════════
router.post('/yookassa', async (req, res) => {
  const clientIp = getClientIp(req.headers, req.ip);
  const payload = req.body;

  try {
    await query(
      `INSERT INTO webhook_events (provider, event_type, payload, processed)
       VALUES ('yookassa', $1, $2, FALSE)`,
      [payload?.event || 'unknown', JSON.stringify(payload || {})]
    );
  } catch (e: any) {
    console.error('[Webhook] Audit log failed:', e.message);
  }

  try {
    // #Y1 IP validation (Render passes real client via X-Forwarded-For)
    if (!clientIp || !isYookassaIp(clientIp)) {
      console.warn(`[YooKassa Webhook] Rejected IP: ${clientIp}`);
      return res.status(403).json({ error: 'Forbidden' });
    }

    // #Y4 payload validation
    if (payload?.type !== 'notification') {
      return res.status(400).json({ error: 'Invalid notification type' });
    }

    const event = payload.event;
    const object = payload.object;

    if (!object || !object.id) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    console.log('[YooKassa Webhook]', event, object.id, 'from', clientIp);

    if (event !== 'payment.succeeded' && event !== 'payment.canceled' && event !== 'payment.waiting_for_capture') {
      return res.status(200).json({ received: true });
    }

    const paymentResult = await query(
      `SELECT id, user_id, status, plan_id, duration_days, amount, is_upgrade
       FROM payments WHERE provider_ref = $1`,
      [object.id]
    );

    if (paymentResult.rows.length === 0) {
      console.warn(`[YooKassa Webhook] Payment not found for provider_ref ${object.id}`);
      return res.status(200).json({ received: true, error: 'Payment not found' });
    }

    const payment = paymentResult.rows[0];

    // #Y3 idempotency
    if (payment.status === 'completed' && event === 'payment.succeeded') {
      console.log(`[YooKassa Webhook] Payment ${payment.id} already completed`);
      return res.status(200).json({ received: true, idempotent: true });
    }

    // #Y4 optional verification with YooKassa API
    const isYookassaConfigured = process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY;
    if (isYookassaConfigured) {
      try {
        const auth = 'Basic ' + Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
        const verifyRes = await axios.get(
          `https://api.yookassa.ru/v3/payments/${object.id}`,
          { headers: { Authorization: auth }, timeout: 15000 }
        );
        const verified = verifyRes.data;
        if (verified.status !== object.status) {
          console.warn('[YooKassa Webhook] Status mismatch', verified.status, object.status);
        }
        const meta = verified.metadata || {};
        if (meta.payment_id && meta.payment_id !== payment.id) {
          console.warn('[YooKassa Webhook] Metadata payment_id mismatch');
        }
      } catch (verifyErr: any) {
        console.error('[YooKassa Webhook] Verify failed:', verifyErr.response?.data || verifyErr.message);
      }
    }

    // #Y6 waiting_for_capture → capture
    if (event === 'payment.waiting_for_capture') {
      if (isYookassaConfigured) {
        try {
          const auth = 'Basic ' + Buffer.from(`${process.env.YOOKASSA_SHOP_ID}:${process.env.YOOKASSA_SECRET_KEY}`).toString('base64');
          await axios.post(
            `https://api.yookassa.ru/v3/payments/${object.id}/capture`,
            { amount: object.amount },
            { headers: { Authorization: auth, 'Idempotence-Key': `capture-${object.id}` }, timeout: 15000 }
          );
        } catch (captureErr: any) {
          console.error('[YooKassa Webhook] Capture failed:', captureErr.response?.data || captureErr.message);
        }
      }
      return res.status(200).json({ received: true });
    }

    if (event === 'payment.canceled') {
      await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);

      if (object.metadata?.auto_renew === 'true') {
        const failRes = await query(
          `UPDATE users
           SET auto_renew_failures = COALESCE(auto_renew_failures, 0) + 1
           WHERE id = $1
           RETURNING auto_renew_failures`,
          [payment.user_id]
        );
        const failures = Number(failRes.rows[0]?.auto_renew_failures || 0);
        if (failures >= 3) {
          await query(`UPDATE users SET subscription_auto_renew = FALSE WHERE id = $1`, [payment.user_id]);
          console.warn(`[AutoRenew] Disabled auto-renew for user ${payment.user_id} after ${failures} failures`);
        }
      }

      return res.status(200).json({ received: true });
    }

    // payment.succeeded
    await query(
      `UPDATE payments SET status = 'completed', paid_at = ${nowSql()} WHERE id = $1`,
      [payment.id]
    );

    // #Y7 save payment method for future auto-renew
    if (object.payment_method?.saved && object.payment_method?.id) {
      await savePaymentMethod(payment.user_id, object.payment_method);
    }

    await activateSubscription(
      payment.user_id,
      payment.plan_id || 'premium',
      payment.duration_days || 30,
      payment.id,
      payment.is_upgrade === true
    );

    if (object.metadata?.auto_renew === 'true') {
      console.log(`[AutoRenew] Webhook confirmed for user ${payment.user_id}`);
      await query(`UPDATE users SET auto_renew_failures = 0 WHERE id = $1`, [payment.user_id]);
    }

    console.log(`[YooKassa] Subscription activated for user ${payment.user_id}, plan ${payment.plan_id}`);

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error('YooKassa webhook error:', err);
    return res.status(200).json({ received: true, error: 'Processing failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Telegram Bot webhook — POST /api/webhook/telegram
// ═══════════════════════════════════════════════════════════════════════════
router.post('/telegram', async (req, res) => {
  try {
    // Handle chat member status changes (block / unblock / delete chat)
    if (req.body.my_chat_member) {
      const { chat, new_chat_member } = req.body.my_chat_member;
      const chatId = chat.id.toString();
      const status = new_chat_member.status;

      console.log(`[Webhook] my_chat_member: chat=${chatId}, status=${status}`);

      if (status === 'kicked' || status === 'left') {
        try {
          const channelResult = await query(
            `SELECT user_id FROM user_channels WHERE channel = 'telegram' AND target = $1`,
            [chatId]
          );

          if (channelResult.rows.length > 0) {
            const userId = channelResult.rows[0].user_id;
            await query(
              `UPDATE user_channels SET is_active = FALSE WHERE channel = 'telegram' AND target = $1`,
              [chatId]
            );
            await query(
              `UPDATE notification_settings SET tg_digest_enabled = FALSE WHERE user_id = $1`,
              [userId]
            );
            console.log(`[Webhook] Deactivated telegram channel for user ${userId}, chat ${chatId}`);
          } else {
            console.log(`[Webhook] No channel found for chat ${chatId}`);
          }
        } catch (err: any) {
          console.error(`[Webhook] Failed to deactivate channel for chat ${chatId}:`, err.message);
        }
        return res.sendStatus(200);
      }

      if (status === 'member') {
        console.log(`[Webhook] User ${chatId} re-added the bot (status=member)`);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // Handle callback queries from inline buttons
    if (req.body.callback_query) {
      return handleCallbackQuery(req, res);
    }

    const { message } = req.body;
    if (!message?.text || !message?.from || !BOT_TOKEN) {
      return res.sendStatus(200);
    }

    const chatId = message.chat.id.toString();
    const text = message.text.trim();
    const username = message.from.username || message.from.first_name || 'User';

    console.log(`[TG Bot] ${username} (${chatId}): ${text}`);

    // ─── Check user state (multi-step flows) ──────────────────────────
    const state = userStates.get(chatId);
    if (state) {
      if (state.action === 'awaiting_tag_input') {
        return handleTagInput(chatId, text, res);
      }
    }

    // Handle /start with payload: /start <user_id>:<token>
    const startMatch = text.match(/^\/start\s+(\S+)/i);
    if (startMatch) {
      const payload = startMatch[1];
      console.log(`[TG Bot] Start payload: ${payload}`);
      const parts = payload.split(':');
      if (parts.length === 2) {
        const tokenValid = verifyLinkToken(parts[0], parts[1]);
        console.log(`[TG Bot] verifyLinkToken(${parts[0]}, ...): ${tokenValid}`);
        if (tokenValid) {
          const userId = parts[0];
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
          await sendMessage(chatId,
            '✅ PULSE подключен!\n\nДайджесты будут приходить по расписанию.\n\nКоманды:\n/now — дайджест сейчас\n/stop — отключить'
          );
          return res.sendStatus(200);
        }
      }
    }

    // Simple commands
    switch (text.toLowerCase()) {
      case '/start': {
        const userResult = await query(
          `SELECT user_id FROM user_channels WHERE target = $1 AND channel = 'telegram' AND is_active = TRUE`,
          [chatId]
        );
        const isConnected = userResult.rows.length > 0;

        if (isConnected) {
          await sendMessageWithButtons(chatId, '👋 PULSE — ваши инвестиционные новости\n\nВыберите действие:', [
            [{ text: '📰 Получить дайджест', callback_data: 'digest_now' }],
            [{ text: '🏷 Мои теги', callback_data: 'my_tags' }],
            [{ text: '⚙️ Настройки', callback_data: 'settings' }],
            [{ text: '🔕 Отключить рассылку', callback_data: 'stop_digest' }],
          ]);
        } else {
          await sendMessage(chatId, '👋 PULSE — инвестиционные новости\n\nДля подключения:\n1. Войдите на сайт\n2. Профиль → Уведомления → Подключить Telegram');
        }
        break;
      }
      case '/stop': {
        await query(`UPDATE notification_settings SET tg_digest_enabled = FALSE WHERE user_id = (SELECT user_id FROM user_channels WHERE target = $1 AND channel = 'telegram')`, [chatId]);
        await sendMessageWithButtons(chatId, '🔕 Рассылка приостановлена.', [
          [{ text: '▶️ Включить рассылку', callback_data: 'start_digest' }],
        ]);
        break;
      }
      case '/now': {
        await handleDigestNow(chatId);
        break;
      }
    }

    res.sendStatus(200);
  } catch (err: any) {
    console.error('[TG Bot] Webhook error:', err.message);
    res.sendStatus(200);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Handle callback queries from inline buttons
// ═══════════════════════════════════════════════════════════════════════════
async function handleCallbackQuery(req: any, res: any): Promise<void> {
  try {
    const callback = req.body.callback_query;
    if (!callback || !BOT_TOKEN) {
      res.sendStatus(200);
      return;
    }

    const chatId = callback.message?.chat?.id?.toString();
    const data = callback.data;
    const callbackId = callback.id;

    if (!chatId || !data) {
      res.sendStatus(200);
      return;
    }

    console.log(`[TG Bot] Button clicked: ${data} by ${chatId}`);

    // Answer callback (removes loading state from button)
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
      callback_query_id: callbackId,
    });

    switch (data) {
      case 'digest_now': {
        await handleDigestNow(chatId);
        break;
      }
      case 'stop_digest': {
        await query(`UPDATE notification_settings SET tg_digest_enabled = FALSE WHERE user_id = (SELECT user_id FROM user_channels WHERE target = $1 AND channel = 'telegram')`, [chatId]);
        await sendMessageWithButtons(chatId, '🔕 Рассылка приостановлена.', [
          [{ text: '▶️ Включить рассылку', callback_data: 'start_digest' }],
        ]);
        break;
      }
      case 'start_digest': {
        await query(`UPDATE notification_settings SET tg_digest_enabled = TRUE WHERE user_id = (SELECT user_id FROM user_channels WHERE target = $1 AND channel = 'telegram')`, [chatId]);
        await sendMessageWithButtons(chatId, '▶️ Рассылка включена!', [
          [{ text: '📰 Получить дайджест', callback_data: 'digest_now' }],
        ]);
        break;
      }
      case 'settings': {
        await sendMessageWithButtons(chatId, '⚙️ Настройки:\n\nЧастота дайджеста: каждый час\n\nТихие часы: 23:00 — 07:00', [
          [{ text: '🔕 Отключить рассылку', callback_data: 'stop_digest' }],
          [{ text: '📰 Получить дайджест', callback_data: 'digest_now' }],
        ]);
        break;
      }
      case 'my_tags': {
        await showMyTags(chatId);
        break;
      }
      case 'add_tag': {
        await promptAddTag(chatId);
        break;
      }
    }

    // Handle delete_tag:<tagId> and confirm_add_tag:<tagName>
    if (data.startsWith('delete_tag:')) {
      const tagId = data.replace('delete_tag:', '');
      await deleteUserTag(chatId, tagId);
    } else if (data.startsWith('confirm_add_tag:')) {
      const tagName = decodeURIComponent(data.replace('confirm_add_tag:', ''));
      await confirmAddTag(chatId, tagName);
    }

    res.sendStatus(200);
  } catch (err: any) {
    console.error('[TG Bot] Callback error:', err.message);
    res.sendStatus(200);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper: send digest now (used by /now and button)
// ═══════════════════════════════════════════════════════════════════════════
async function handleDigestNow(chatId: string): Promise<void> {
  if (!BOT_TOKEN) return;

  const userResult = await query(
    `SELECT user_id FROM user_channels WHERE target = $1 AND channel = 'telegram' AND is_active = TRUE`,
    [chatId]
  );
  if (userResult.rows.length === 0) {
    await sendMessage(chatId, '⚠️ Аккаунт не подключен. Войдите на сайт и подключите Telegram в профиле.');
    return;
  }
  const userId = userResult.rows[0].user_id;

  await sendMessage(chatId, '⏳ Формирую дайджест...');

  try {
    const { sendDigestToUserNow } = await import('../services/digest');
    const sent = await sendDigestToUserNow(userId);
    if (!sent) {
      await sendMessageWithButtons(chatId, '📭 Нет новых непрочитанных новостей по вашим тегам.', [
        [{ text: '📰 Обновить', callback_data: 'digest_now' }],
      ]);
    }
  } catch (err: any) {
    console.error('[TG Bot] digest_now error:', err.message);
    await sendMessage(chatId, '❌ Ошибка формирования дайджеста.');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════════════════
async function sendMessage(chatId: string, text: string): Promise<void> {
  if (!BOT_TOKEN) return;
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Tag Management Functions
// ═══════════════════════════════════════════════════════════════════════════

async function getUserIdByChatId(chatId: string): Promise<string | null> {
  const result = await query(
    `SELECT user_id FROM user_channels WHERE target = $1 AND channel = 'telegram' AND is_active = TRUE`,
    [chatId]
  );
  return result.rows.length > 0 ? result.rows[0].user_id : null;
}

async function showMyTags(chatId: string): Promise<void> {
  const userId = await getUserIdByChatId(chatId);
  if (!userId) {
    await sendMessage(chatId, '⚠️ Аккаунт не подключен.');
    return;
  }

  const result = await query(
    `SELECT tag_id, tag_name, tag_type FROM portfolios WHERE user_id = $1 ORDER BY tag_name`,
    [userId]
  );

  if (result.rows.length === 0) {
    await sendMessageWithButtons(chatId, '🏷 У вас пока нет тегов.\n\nДобавьте теги, чтобы получать персональные новости.', [
      [{ text: '➕ Добавить тег', callback_data: 'add_tag' }],
    ]);
    return;
  }

  let text = `🏷 Ваши теги (${result.rows.length}):\n\n`;
  const keyboard: any[][] = [];

  for (const row of result.rows) {
    text += `• <b>${escapeHtml(row.tag_name)}</b> (${row.tag_type || 'custom'})\n`;
    keyboard.push([{
      text: `🗑 ${row.tag_name}`,
      callback_data: `delete_tag:${row.tag_id}`
    }]);
  }

  keyboard.push([{ text: '➕ Добавить тег', callback_data: 'add_tag' }]);

  await sendMessageWithButtons(chatId, text, keyboard);
}

async function promptAddTag(chatId: string): Promise<void> {
  userStates.set(chatId, { action: 'awaiting_tag_input' });
  await sendMessage(chatId, '➕ Введите название тега:\n\nНапример: <b>Сбер</b>, <b>Apple</b>, <b>нефть</b>\n\nИли отправьте /cancel для отмены.');
}

async function handleTagInput(chatId: string, text: string, res: any): Promise<void> {
  userStates.delete(chatId); // Clear state

  if (text.toLowerCase() === '/cancel') {
    await sendMessage(chatId, '❌ Отменено.');
    res.sendStatus(200);
    return;
  }

  const input = text.toLowerCase().trim();
  if (input.length < 2) {
    await sendMessage(chatId, '⚠️ Слишком короткое название. Минимум 2 символа.');
    res.sendStatus(200);
    return;
  }

  // Search in standard tags
  const matches: string[] = [];
  for (const [tagId, keywords] of Object.entries(STANDARD_TAGS)) {
    if (keywords.some(k => k.toLowerCase().includes(input) || input.includes(k.toLowerCase()))) {
      matches.push(tagId);
    }
  }

  // Check if exact match exists
  if (matches.length === 0) {
    // No matches — ask to create new tag
    await sendMessageWithButtons(chatId, `Тег "<b>${escapeHtml(text)}</b>" не найден в базе.\n\nСоздать новый тег?`, [
      [{ text: '✅ Создать', callback_data: `confirm_add_tag:${encodeURIComponent(text)}` }],
      [{ text: '❌ Отмена', callback_data: 'my_tags' }],
    ]);
  } else if (matches.length === 1) {
    // Single match — add directly
    await confirmAddTag(chatId, matches[0]);
  } else {
    // Multiple matches — show options
    const keyboard = matches.map(tagId => ([{
      text: `🏷 ${tagId}`,
      callback_data: `confirm_add_tag:${encodeURIComponent(tagId)}`
    }]));
    keyboard.push([{ text: '❌ Отмена', callback_data: 'my_tags' }]);
    await sendMessageWithButtons(chatId, `🔍 Найдено несколько совпадений для "<b>${escapeHtml(text)}</b>":`, keyboard);
  }

  res.sendStatus(200);
}

async function confirmAddTag(chatId: string, tagName: string): Promise<void> {
  const userId = await getUserIdByChatId(chatId);
  if (!userId) {
    await sendMessage(chatId, '⚠️ Аккаунт не подключен.');
    return;
  }

  const tagId = tagName.toLowerCase().replace(/\s+/g, '_');
  const tagType = STANDARD_TAGS[tagId] ? 'standard' : 'custom';

  try {
    await query(
      `INSERT INTO portfolios (user_id, tag_id, tag_name, tag_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, tag_id) DO NOTHING`,
      [userId, tagId, tagName, tagType]
    );
    await sendMessageWithButtons(chatId, `✅ Тег "<b>${escapeHtml(tagName)}</b>" добавлен!\n\nНовости по этому тегу появятся в ленте.`, [
      [{ text: '🏷 Мои теги', callback_data: 'my_tags' }],
      [{ text: '➕ Добавить ещё', callback_data: 'add_tag' }],
    ]);
  } catch (err: any) {
    console.error('[TG Bot] Add tag error:', err.message);
    await sendMessage(chatId, '❌ Ошибка добавления тега.');
  }
}

async function deleteUserTag(chatId: string, tagId: string): Promise<void> {
  const userId = await getUserIdByChatId(chatId);
  if (!userId) {
    await sendMessage(chatId, '⚠️ Аккаунт не подключен.');
    return;
  }

  try {
    await query(`DELETE FROM portfolios WHERE user_id = $1 AND tag_id = $2`, [userId, tagId]);
    await sendMessageWithButtons(chatId, `🗑 Тег удалён.`, [
      [{ text: '🏷 Мои теги', callback_data: 'my_tags' }],
    ]);
  } catch (err: any) {
    console.error('[TG Bot] Delete tag error:', err.message);
    await sendMessage(chatId, '❌ Ошибка удаления тега.');
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendMessageWithButtons(chatId: string, text: string, buttons: any[][]): Promise<void> {
  if (!BOT_TOKEN) return;
  await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

// GET /api/webhook/verify-token — проверить HMAC токен (debug)
router.get('/verify-token', async (req, res) => {
  try {
    const { userId, token } = req.query;
    if (!userId || !token) {
      return res.status(400).json({ error: 'userId and token required' });
    }
    const valid = verifyLinkToken(userId as string, token as string);
    res.json({ userId, tokenValid: valid });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
