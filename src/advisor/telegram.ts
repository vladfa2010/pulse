/**
 * =============================================================================
 * PULSE — Advisor module: Telegram-доставка и привязка (ТЗ-183 Задача 2)
 * =============================================================================
 *
 *   - sendAdvisorTelegram — модульная обёртка над sendTelegramMessage ядра:
 *     разбиение на сообщения ≤ 4000 символов (лимит TG 4096, с запасом),
 *     пауза ≥ 1 с между сообщениями одному чату (rate limit TG API),
 *     ошибки (403/chat-not-found) → false + лог, cron не падает;
 *     после AUTO_DISABLE_FAILED_COUNT подряд failed — авто-отключение TG-каналов
 *     (notify_prefs.advisor_tg_enabled = false, риск-таблица ТЗ-183).
 *   - generateAdvisorLinkToken / verifyAdvisorLinkToken — одноразовый токен
 *     привязки (TTL 15 мин), тот же HMAC-паттерн, что verifyLinkToken ядра
 *     (webhook.ts): payload = userId:timestamp:signature. Одноразовость —
 *     признак telegram_chat_id IS NOT NULL (после привязки токен не принимается).
 */

import crypto from 'crypto';
import { query } from '../config/db';
import { sendTelegramMessage } from '../services/telegram';
import { getNotifyPrefs, saveNotifyPrefs } from './service';

const TG_CHUNK_MAX = 4000;
const TG_MIN_INTERVAL_MS = 1000;

/** TTL одноразового токена привязки (ТЗ-183 Задача 2.2). */
export const ADVISOR_TG_LINK_TTL_MS = 15 * 60 * 1000;

/** Подряд failed-отправок до авто-отключения TG-каналов (риск-таблица ТЗ-183). */
const AUTO_DISABLE_FAILED_COUNT = 10;

/** Момент последней отправки в чат (in-memory пауза ≥ 1 с на чат). */
const lastSentAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Разбиение на сообщения ≤ maxLength по границам абзацев/строк (ТЗ-183 Задача 2.3). */
export function splitAdvisorMessage(text: string, maxLength: number = TG_CHUNK_MAX): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n\n', maxLength);
    if (cutAt <= 0) cutAt = remaining.lastIndexOf('\n', maxLength);
    if (cutAt <= 0) cutAt = maxLength;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trim();
  }
  return chunks;
}

/**
 * Отправка текста советнику. Возвращает false при любой failed-части —
 * вызывающий код (cron/алерты) продолжает работу.
 */
export async function sendAdvisorTelegram(chatId: string, text: string): Promise<boolean> {
  if (!chatId || !text) return false;
  const chunks = splitAdvisorMessage(text);
  for (const chunk of chunks) {
    const elapsed = Date.now() - (lastSentAt.get(chatId) ?? 0);
    if (elapsed < TG_MIN_INTERVAL_MS) await sleep(TG_MIN_INTERVAL_MS - elapsed);
    const ok = await sendTelegramMessage(chatId, chunk, 'HTML');
    if (!ok) {
      await recordFailedSend(chatId);
      return false;
    }
    lastSentAt.set(chatId, Date.now());
  }
  await resetFailedCount(chatId);
  return true;
}

async function recordFailedSend(chatId: string): Promise<void> {
  console.warn(`[AdvisorTg] send failed: chat=${chatId}`);
  try {
    const result = await query(
      `SELECT user_id FROM advisor_settings WHERE telegram_chat_id = $1`,
      [chatId]
    );
    const userId = result.rows[0]?.user_id as string | undefined;
    if (!userId) return;
    const prefs = await getNotifyPrefs(userId);
    const count = Number(prefs.advisor_tg_failed_count ?? 0) + 1;
    if (count >= AUTO_DISABLE_FAILED_COUNT) {
      await saveNotifyPrefs(userId, { advisor_tg_enabled: false, advisor_tg_failed_count: 0 });
      console.log(`[AdvisorTg] Auto-disabled Telegram notifications for user=${userId} after ${AUTO_DISABLE_FAILED_COUNT} failed sends`);
    } else {
      await saveNotifyPrefs(userId, { advisor_tg_failed_count: count });
    }
  } catch (err: any) {
    console.error('[AdvisorTg] failed-count update error:', err.message);
  }
}

async function resetFailedCount(chatId: string): Promise<void> {
  try {
    const result = await query(
      `SELECT user_id, notify_prefs FROM advisor_settings WHERE telegram_chat_id = $1`,
      [chatId]
    );
    const row = result.rows[0];
    if (!row) return;
    const raw = row.notify_prefs;
    let stored: Record<string, unknown> = {};
    if (raw) {
      try {
        stored = typeof raw === 'string' ? JSON.parse(raw) : (raw as Record<string, unknown>);
      } catch { stored = {}; }
    }
    if (Number(stored.advisor_tg_failed_count ?? 0) > 0) {
      await saveNotifyPrefs(row.user_id as string, { advisor_tg_failed_count: 0 });
    }
  } catch (err: any) {
    console.error('[AdvisorTg] failed-count reset error:', err.message);
  }
}

// ─── Одноразовый токен привязки ─────────────────────────────────────────────

function hmacHex(secret: string, message: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex').slice(0, 16);
}

/** Payload deep-link: userId:timestamp:signature (HMAC от "userId:timestamp"). */
export function generateAdvisorLinkToken(userId: string): string {
  const secret = process.env.TELEGRAM_BOT_TOKEN || '';
  const ts = Date.now().toString();
  return `${userId}:${ts}:${hmacHex(secret, `${userId}:${ts}`)}`;
}

export type AdvisorTokenCheck = 'ok' | 'bad_signature' | 'expired';

/** Проверка сигнатуры HMAC + TTL 15 мин (небольшой допуск на перевод часов вперёд). */
export function verifyAdvisorLinkToken(userId: string, timestamp: string, signature: string): AdvisorTokenCheck {
  const secret = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!secret) return 'bad_signature';
  const expected = hmacHex(secret, `${userId}:${timestamp}`);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) {
      return 'bad_signature';
    }
  } catch {
    return 'bad_signature';
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return 'bad_signature';
  const age = Date.now() - ts;
  if (age < -60_000 || age > ADVISOR_TG_LINK_TTL_MS) return 'expired';
  return 'ok';
}
