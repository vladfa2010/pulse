import axios from 'axios';
import FormData from 'form-data';
import { query } from '../config/db';
import { setDigestEnabled } from './notifications/subscriptions';
import { isQuietHoursMsk } from './notifications/quietHours';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Check if bot is configured
function isConfigured(): boolean {
  return !!BOT_TOKEN && BOT_TOKEN.length > 10;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  /** URL-кнопка (ТЗ-191 Задача 5: «Открыть полный отчёт» со ссылкой magic-link) */
  url?: string;
}

export interface InlineKeyboard {
  inline_keyboard: InlineKeyboardButton[][];
}

// Send message via Telegram Bot API
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  parseMode: 'HTML' | 'MarkdownV2' = 'HTML',
  replyMarkup?: InlineKeyboard
): Promise<boolean> {
  if (!isConfigured()) {
    console.warn('[Telegram] Bot token not configured');
    return false;
  }

  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: false,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    return true;
  } catch (err: any) {
    const errorCode = err.response?.data?.error_code;
    const description = err.response?.data?.description || '';

    // User blocked the bot or deleted the chat — deactivate channel
    if (errorCode === 403 || (errorCode === 400 && /chat not found/i.test(description))) {
      if (description.includes('blocked') || description.includes('deactivated') || description.includes('user is deactivated') || /chat not found/i.test(description)) {
        console.warn(`[Telegram] User ${chatId} inaccessible: ${description}`);
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
            await setDigestEnabled(userId, 'telegram', false);
            console.log(`[Telegram] Auto-deactivated channel for chat ${chatId}, user ${userId}`);
          }
        } catch (dbErr: any) {
          console.error('[Telegram] Failed to deactivate channel:', dbErr.message);
        }
        return false;
      }
    }

    console.error('[Telegram] Send failed:', err.response?.status, errorCode, description, (err as Error).message, '— data:', JSON.stringify(err.response?.data ?? {}));
    return false;
  }
}

// Send photo via Telegram Bot API (sendPhoto, multipart/form-data).
// ТЗ-184: инфографика weekly_report первым сообщением. Caption ≤1024 символов
// обрезаем на всякий случай. Возвращает false при любой ошибке — вызывающий
// код (dispatcher) продолжает слать текстовый отчёт (деградация, не сбой).
// ТЗ-191 Задача 5: replyMarkup — inline-кнопка со ссылкой на страницу отчёта.
export async function sendTelegramPhoto(
  chatId: string,
  photo: Buffer,
  caption?: string,
  replyMarkup?: InlineKeyboard
): Promise<boolean> {
  if (!isConfigured()) {
    console.warn('[Telegram] Bot token not configured');
    return false;
  }

  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('photo', photo, { filename: 'weekly-chart.png', contentType: 'image/png' });
    if (caption) {
      form.append('caption', caption.slice(0, 1024));
      form.append('parse_mode', 'HTML');
    }
    if (replyMarkup) {
      form.append('reply_markup', JSON.stringify(replyMarkup));
    }
    await axios.post(`${TELEGRAM_API}/sendPhoto`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    });
    return true;
  } catch (err: any) {
    console.warn('[Telegram] Send photo failed:',
      err.response?.status, err.response?.data?.error_code, err.response?.data?.description || (err as Error).message);
    return false;
  }
}

// Send weekly report to user
export async function sendWeeklyReport(userId: string, reportText: string): Promise<boolean> {
  try {
    // Get user's Telegram channel
    const result = await query(
      `SELECT target FROM user_channels WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
      [userId]
    );

    if (result.rows.length === 0) return false;

    const chatId = result.rows[0].target;

    // Split long messages (Telegram limit: 4096 chars)
    const chunks = splitMessage(reportText, 4000);
    for (const chunk of chunks) {
      await sendTelegramMessage(chatId, chunk);
      await sleep(500); // Rate limit
    }

    return true;
  } catch (err) {
    console.error('[Telegram] Weekly report failed:', err);
    return false;
  }
}

// Send sentiment alert
export async function sendAlert(userId: string, title: string, body: string): Promise<boolean> {
  try {
    // Check quiet hours
    const settingsResult = await query(
      `SELECT quiet_hours_enabled, quiet_hours_start, quiet_hours_end
       FROM notification_settings WHERE user_id = $1`,
      [userId]
    );

    const settings = settingsResult.rows[0];
    if (settings?.quiet_hours_enabled && isQuietHoursMsk(settings.quiet_hours_start, settings.quiet_hours_end)) {
      console.log(`[Telegram] Quiet hours, skipping alert for user ${userId}`);
      return false;
    }

    // Get Telegram channel
    const channelResult = await query(
      `SELECT target FROM user_channels WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
      [userId]
    );

    if (channelResult.rows.length === 0) return false;

    const chatId = channelResult.rows[0].target;
    const message = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;

    return await sendTelegramMessage(chatId, message);
  } catch (err) {
    console.error('[Telegram] Alert failed:', err);
    return false;
  }
}

// ============================================================
// Helpers
// ============================================================

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    // Find last newline before maxLength
    let cutAt = remaining.lastIndexOf('\n', maxLength);
    if (cutAt === -1) cutAt = maxLength;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trim();
  }
  return chunks;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
