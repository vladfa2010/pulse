import axios from 'axios';
import { query } from '../config/db';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Check if bot is configured
function isConfigured(): boolean {
  return !!BOT_TOKEN && BOT_TOKEN.length > 10;
}

// Send message via Telegram Bot API
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  parseMode: 'HTML' | 'MarkdownV2' = 'HTML'
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
            await query(
              `UPDATE notification_settings SET tg_digest_enabled = FALSE WHERE user_id = $1`,
              [userId]
            );
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
    if (settings?.quiet_hours_enabled && isQuietHours(settings.quiet_hours_start, settings.quiet_hours_end)) {
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

function isQuietHours(start: string, end: string): boolean {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return current >= startMinutes && current <= endMinutes;
  }
  // Crosses midnight
  return current >= startMinutes || current <= endMinutes;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
