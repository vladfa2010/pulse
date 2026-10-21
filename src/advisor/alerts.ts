/**
 * =============================================================================
 * PULSE — Advisor module: алерты сентимента (ТЗ-183 Задача 5)
 * =============================================================================
 *
 * Вызывается из runAdvisorPrecompute (summaries.ts) сразу после генерации
 * саммари клиента. LLM не нужен — считаем по свежему sentiment_mix из
 * advisor_summaries. Cooldown 12 ч на (клиент, направление) через колонки
 * advisor_clients.last_alert_neg_at / last_alert_pos_at (созданы ТЗ-182).
 * Независимые флаги notify_prefs.advisor_alert_neg / advisor_alert_pos.
 */

import { query } from '../config/db';
import { getNotifyPrefs } from './service';
import { sendAdvisorTelegram } from './telegram';

// Пороги и cooldown подобраны эмпирически, тюнить здесь (ТЗ-183 Задача 5).
const ALERT_NEG_SHARE_PCT = 60;
const ALERT_POS_SHARE_PCT = 70;
const ALERT_MIN_ARTICLES = 5;
const ALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const ALERT_PERIOD_HOURS = 12;

interface SentimentMix { pos: number; neg: number; neu: number }

function parseMix(raw: unknown): SentimentMix | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object' && 'pos' in obj && 'neg' in obj) {
      return { pos: Number(obj.pos) || 0, neg: Number(obj.neg) || 0, neu: Number(obj.neu) || 0 };
    }
  } catch { /* не JSON — без алерта */ }
  return null;
}

/**
 * Проверка свежего саммари клиента на всплеск негатива/позитива и отправка
 * алерта в TG (при привязанном telegram_chat_id и включённом флаге).
 * Не бросает исключений — cron не падает.
 */
export async function maybeSendSentimentAlert(userId: string, clientId: number): Promise<void> {
  const settings = await query(
    `SELECT telegram_chat_id FROM advisor_settings WHERE user_id = $1`,
    [userId]
  );
  const chatId = settings.rows[0]?.telegram_chat_id as string | undefined;
  if (!chatId) return;

  const prefs = await getNotifyPrefs(userId);
  if (prefs.advisor_tg_enabled === false) return;

  const summaryResult = await query(
    `SELECT c.name, c.last_alert_neg_at, c.last_alert_pos_at,
            s.sentiment_mix, s.articles_count
     FROM advisor_clients c
     LEFT JOIN advisor_summaries s ON s.client_id = c.id AND s.period_hours = $2
     WHERE c.id = $1`,
    [clientId, ALERT_PERIOD_HOURS]
  );
  const row = summaryResult.rows[0];
  if (!row) return;

  const articles = Number(row.articles_count) || 0;
  if (articles < ALERT_MIN_ARTICLES) return;
  const mix = parseMix(row.sentiment_mix);
  if (!mix) return;

  const now = Date.now();
  const checks: Array<{
    dir: 'neg' | 'pos';
    share: number;
    threshold: number;
    lastAt: string | null;
    flag: boolean;
    text: string;
  }> = [
    {
      dir: 'neg',
      share: mix.neg,
      threshold: ALERT_NEG_SHARE_PCT,
      lastAt: row.last_alert_neg_at ?? null,
      flag: prefs.advisor_alert_neg !== false,
      text: `⚠️ ${row.name}: всплеск негатива (${mix.neg}% новостей за 12 ч). Повод связаться первым.`,
    },
    {
      dir: 'pos',
      share: mix.pos,
      threshold: ALERT_POS_SHARE_PCT,
      lastAt: row.last_alert_pos_at ?? null,
      flag: prefs.advisor_alert_pos !== false,
      text: `✅ ${row.name}: сильный позитив (${mix.pos}%). Хороший повод порадовать клиента.`,
    },
  ];

  for (const check of checks) {
    if (check.share < check.threshold || !check.flag) continue;
    if (check.lastAt && now - new Date(check.lastAt).getTime() < ALERT_COOLDOWN_MS) continue;

    const sent = await sendAdvisorTelegram(chatId, check.text);
    if (sent) {
      // Стампуем ПОСЛЕ успешной отправки: failed-отправка не съедает cooldown
      await query(
        `UPDATE advisor_clients SET last_alert_${check.dir}_at = $1 WHERE id = $2`,
        [new Date().toISOString(), clientId]
      );
      console.log(`[AdvisorAlerts] ${check.dir} alert: user=${userId} client=${clientId} (${row.name}) share=${check.share}% articles=${articles}`);
    }
  }
}
