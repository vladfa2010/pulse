/**
 * =============================================================================
 * PULSE — Advisor module: еженедельный отчёт по клиентам (ТЗ-183 Задача 9)
 * =============================================================================
 *
 * Модульный weekly: ядерный сервис weekly_report («Мой портфель») НЕ меняется.
 * Расписание зеркалит ядерный weekly-бродкаст (services/notifications/workers.ts:
 * воскресенье 13:00 Europe/Moscow).
 *
 *   Для пользователей с multi_portfolio и notify_prefs.advisor_weekly (дефолт ON):
 *     - по каждому активному клиенту выборка за 7 дней через selectNewsByTags;
 *     - 0 статей — БЕЗ LLM, блок «без значимых событий» (skip-empty, контроль стоимости);
 *     - иначе LLM-саммари недели (тот же buildSummaryPrompt/callSummaryLLM, что
 *       summaries.ts; concurrency ≤ 3);
 *     - сборка ОДНОГО сообщения с блоками по клиентам.
 *
 *   Каналы: TG — если advisor_settings.telegram_chat_id; email — если у
 *   пользователя есть активная подписка weekly_report/email в
 *   notification_subscriptions (ТОЛЬКО чтение, записей в таблицу ядра нет) и есть
 *   email в users. «Мой портфель» в отчёт НЕ включается — только клиенты.
 *
 *   Лог: [AdvisorWeekly] users=A clients=B generated=C skipped_empty=D.
 */

import cron from 'node-cron';
import { query } from '../config/db';
import { acquireCronLock, releaseCronLock } from '../services/cron';
import { sendEmail } from '../services/email';
import { hasFeature } from '../services/subscription';
import { selectNewsByTags, buildSummaryPrompt, callSummaryLLM } from '../services/userSummary';
import { getNotifyPrefs, NotifyPrefs } from './service';
import { sendAdvisorTelegram } from './telegram';

const WEEK_HOURS = 24 * 7;
const LLM_CONCURRENCY = 3;

const ADVISER_PAGE_URL = 'pulse.inside-trade.ru/adviser';
const EMAIL_SUBJECT = 'PULSE Adviser: неделя по клиентам';

interface WeeklyJob {
  userId: string;
  clientId: number;
  clientName: string;
  order: number;
  tagIds: string[];
  tagNames: string[];
}

interface WeeklyBlock {
  clientId: number;
  clientName: string;
  order: number;
  articlesCount: number;
  summary: string | null; // null — «без значимых событий»
}

interface UserWeeklyState {
  chatId: string | null;
  prefs: NotifyPrefs;
  emailEnabled: boolean;
}

function tgEnabled(prefs: NotifyPrefs): boolean {
  return prefs.advisor_tg_enabled !== false;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decline(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return many;
  if (mod10 > 1 && mod10 < 5) return few;
  if (mod10 === 1) return one;
  return many;
}

function formatRuDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/** Подпись периода: «15.10–21.10» (последние 7 дней, локальное время сервера = МСК на проде). */
function weekRangeLabel(now: Date = new Date()): string {
  const to = new Date(now);
  const from = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  return `${formatRuDate(from)}–${formatRuDate(to)}`;
}

function buildWeeklyMessage(blocks: WeeklyBlock[], periodLabel: string): string {
  const lines: string[] = [`📅 Неделя по клиентам · ${periodLabel}`, ''];
  for (const b of blocks) {
    if (b.articlesCount === 0 || !b.summary) {
      lines.push(`▸ ${b.clientName} — без значимых событий`);
      continue;
    }
    lines.push(`▸ ${b.clientName} (${b.articlesCount} ${decline(b.articlesCount, 'новость', 'новости', 'новостей')})`);
    lines.push(b.summary);
    lines.push('');
  }
  lines.push(`Все карточки: ${ADVISER_PAGE_URL}`);
  return lines.join('\n').trim();
}

/**
 * Прогон модульного weekly. Возвращает агрегаты (для лога и триггера).
 * Ошибки LLM по клиенту — пропуск блока, cron живёт (контроль стоимости:
 * only multi_portfolio + skip-empty).
 */
export async function runAdvisorWeekly(): Promise<{ users: number; clients: number; generated: number; skippedEmpty: number }> {
  const startedAt = Date.now();

  const clientsResult = await query(
    `SELECT c.id, c.name, c.advisor_user_id
     FROM advisor_clients c
     WHERE c.is_archived = FALSE
     ORDER BY c.advisor_user_id, c.sort_order ASC, c.created_at ASC`,
    []
  );

  const byUser = new Map<string, { id: number; name: string }[]>();
  for (const row of clientsResult.rows) {
    const uid = row.advisor_user_id as string;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid)!.push({ id: Number(row.id), name: row.name });
  }

  const userStates = new Map<string, UserWeeklyState>();
  const jobs: WeeklyJob[] = [];
  let usersCount = 0;

  for (const [userId, clients] of byUser) {
    if (!(await hasFeature(userId, 'multi_portfolio'))) continue;
    const prefs = await getNotifyPrefs(userId);
    if (prefs.advisor_weekly === false) continue;

    // Каналы доставки
    const settingsResult = await query(
      `SELECT telegram_chat_id FROM advisor_settings WHERE user_id = $1`,
      [userId]
    );
    const chatId = settingsResult.rows[0]?.telegram_chat_id ?? null;
    // READ-ONLY выборка из ядра: записей в notification_subscriptions не делаем
    const subResult = await query(
      `SELECT 1 AS ok FROM notification_subscriptions
       WHERE user_id = $1 AND product = 'weekly_report' AND channel = 'email' AND enabled = TRUE
       LIMIT 1`,
      [userId]
    );
    const emailEnabled = subResult.rows.length > 0;

    if ((!chatId || !tgEnabled(prefs)) && !emailEnabled) continue;
    usersCount++;
    userStates.set(userId, { chatId, prefs, emailEnabled });

    let order = 0;
    for (const client of clients) {
      const tagRows = await query(
        `SELECT tag_id, tag_name FROM advisor_client_tags WHERE client_id = $1 ORDER BY id ASC`,
        [client.id]
      );
      const tagIds = [...new Set(tagRows.rows.map((r: any) => r.tag_id as string | null).filter((v): v is string => !!v))];
      const tagNames = tagRows.rows.map((r: any) => r.tag_name as string);
      jobs.push({ userId, clientId: client.id, clientName: client.name, order: order++, tagIds, tagNames });
    }
  }

  // LLM-пул с concurrency ≤ 3; failed клиент — пропуск блока, cron живёт
  const blocksByUser = new Map<string, WeeklyBlock[]>();
  let generated = 0;
  let skippedEmpty = 0;
  let idx = 0;

  const lanes = Array.from({ length: LLM_CONCURRENCY }, async () => {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const pushBlock = (articlesCount: number, summary: string | null) => {
        const list = blocksByUser.get(job.userId) ?? [];
        list.push({ clientId: job.clientId, clientName: job.clientName, order: job.order, articlesCount, summary });
        blocksByUser.set(job.userId, list);
      };
      try {
        if (job.tagIds.length === 0) {
          pushBlock(0, null);
          skippedEmpty++;
          continue;
        }
        const articles = await selectNewsByTags(job.tagIds, WEEK_HOURS);
        if (articles.length === 0) {
          pushBlock(0, null);
          skippedEmpty++;
          continue;
        }
        const llm = await callSummaryLLM(buildSummaryPrompt(job.tagNames, articles, WEEK_HOURS));
        pushBlock(articles.length, llm.text);
        generated++;
      } catch (err: any) {
        console.error(`[AdvisorWeekly] client=${job.clientId} user=${job.userId} failed:`, err.message);
      }
    }
  });
  await Promise.all(lanes);

  // Сборка и отправка ОДНОГО сообщения на пользователя
  const periodLabel = weekRangeLabel();
  for (const [userId, blocks] of blocksByUser) {
    const state = userStates.get(userId);
    if (!state) continue;
    blocks.sort((a, b) => a.order - b.order);
    const message = buildWeeklyMessage(blocks, periodLabel);

    if (state.chatId && tgEnabled(state.prefs)) {
      try {
        const ok = await sendAdvisorTelegram(state.chatId, message);
        if (ok) console.log(`[AdvisorWeekly] TG sent: user=${userId} clients=${blocks.length}`);
        else console.warn(`[AdvisorWeekly] TG send failed: user=${userId}`);
      } catch (err: any) {
        console.warn(`[AdvisorWeekly] TG error: user=${userId}:`, err.message);
      }
    }

    if (state.emailEnabled) {
      try {
        const userResult = await query(`SELECT email FROM users WHERE id = $1`, [userId]);
        const email = userResult.rows[0]?.email;
        if (email) {
          const html = `<p>${escapeHtml(message).replace(/\n/g, '<br/>')}</p>`;
          const ok = await sendEmail(email, EMAIL_SUBJECT, html);
          if (ok) console.log(`[AdvisorWeekly] Email sent: user=${userId} clients=${blocks.length}`);
          else console.warn(`[AdvisorWeekly] Email send failed: user=${userId}`);
        }
      } catch (err: any) {
        console.warn(`[AdvisorWeekly] Email error: user=${userId}:`, err.message);
      }
    }
  }

  const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[AdvisorWeekly] users=${usersCount} clients=${jobs.length} generated=${generated} skipped_empty=${skippedEmpty} duration=${durationSec}s`);
  return { users: usersCount, clients: jobs.length, generated, skippedEmpty };
}

/**
 * Регистрация cron: воскресенье 13:00 Europe/Moscow — зеркало ядерного
 * weekly-бродкаста (services/notifications/workers.ts).
 */
export function startAdvisorWeeklyCron(opts?: { isShuttingDown?: () => boolean }): void {
  cron.schedule('0 13 * * 0', async () => {
    if (opts?.isShuttingDown?.()) return;
    const acquired = await acquireCronLock('advisor-weekly');
    if (!acquired) return;
    try {
      await runAdvisorWeekly();
    } catch (err: any) {
      console.error('[Cron] Advisor weekly failed:', err.message);
    } finally {
      await releaseCronLock('advisor-weekly');
    }
  }, { timezone: 'Europe/Moscow' });
  console.log('[Cron] Advisor weekly scheduled Sunday at 13:00 Europe/Moscow (mirror of core weekly)');
}
