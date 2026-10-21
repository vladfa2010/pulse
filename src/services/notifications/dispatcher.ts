/**
 * PULSE — Notification Dispatcher.
 *
 * Единая точка рассылки любого продукта по всем каналам:
 *   recipients → entitlement → тихие часы/частота → контент → формат → отправка
 *
 * Воркеры (cron) больше не содержат ни тарифной логики, ни знания о каналах.
 */

import { sendTelegramMessage, sendTelegramPhoto, InlineKeyboard } from '../telegram';
import { sendEmail, EmailAttachment } from '../email';
import { sendPushNotification } from '../push';
import { sendWebPushToUser } from '../webPush';
import { buildDigestContent, DigestContent } from './digestContent';
import { buildWeeklyReportContent, WeeklyReportContent } from './weeklyReportContent';
import { WeeklyAISummaries } from './weeklySummaryAI';
import { renderWeeklyChart } from './weeklyChart';
import {
  formatDigestTelegram, formatDigestEmail, formatDigestPush,
  formatWeeklyReportTelegram, formatWeeklyReportEmail, formatWeeklyReportPush,
  formatWeeklyReportChartCaption, WeeklyReportDeliveryOptions,
} from './formatters';
import { getEntitlement } from './entitlement';
import { isQuietHoursForProduct } from './quietHours';
import { getCurrentWeekSnapshot, markSnapshotSent, issueReportAccessToken } from './weeklyReportSnapshot';
import { weekStartMskDate, weeklyReportTargetWeekStart } from './weeklyStats';
import {
  getRecipients, getEnabledSubscriptions, getDeliveryTarget, getQuietHours,
  isDueByFrequency, markSent,
} from './subscriptions';
import { Product, Channel, Subscription, DeliveryResult } from './types';

export type SendResult = 'sent' | 'empty' | 'skipped' | 'error';

export type NotificationContent = DigestContent | WeeklyReportContent;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const READ_ALL_KEYBOARD = {
  inline_keyboard: [[{ text: '✅ Прочитано', callback_data: 'digest_read_all' }]],
};

// ── ТЗ-191 Задача 5: ссылка на страницу отчёта для дистрибуции ──────────────

/** Единственное место сборки URL отчёта: ${FRONTEND_URL}/reports/weekly/:id?k=…&utm_… */
function weeklyReportUrl(reportId: string, token: string, channel: Channel): string {
  const base = (process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru').replace(/\/+$/, '');
  return `${base}/reports/weekly/${reportId}?k=${token}&utm_source=${channel}&utm_medium=weekly_report`;
}

/** Дополнительный контекст доставки weekly_report (ссылка + AI из снапшота) */
interface WeeklyDeliveryExtra {
  reportId: string;
  token: string | null;
  ai: WeeklyAISummaries | null;
}

function weeklyChannelOptions(extra: WeeklyDeliveryExtra | null, channel: Channel): WeeklyReportDeliveryOptions {
  if (!extra) return {};
  return {
    ai: extra.ai,
    reportUrl: extra.token ? weeklyReportUrl(extra.reportId, extra.token, channel) : undefined,
  };
}

/** Inline-кнопка «Открыть полный отчёт» (ссылка с magic-токеном) */
function weeklyReportKeyboard(url: string | undefined): InlineKeyboard | undefined {
  if (!url) return undefined;
  return { inline_keyboard: [[{ text: '📊 Открыть полный отчёт', url }]] };
}

// ── Отправка одного продукта в один канал ───────────────────────────────────

async function deliver(
  userId: string,
  product: Product,
  channel: Channel,
  content: NotificationContent,
  frequency: string,
  chart?: Buffer | null,
  weeklyExtra?: WeeklyDeliveryExtra | null
): Promise<boolean> {
  if (product === 'digest') {
    const c = content as DigestContent;
    switch (channel) {
      case 'telegram': {
        const target = await getDeliveryTarget(userId, 'telegram', product);
        if (!target) return false;
        const messages = formatDigestTelegram(c, frequency);
        for (let i = 0; i < messages.length; i++) {
          const isLast = i === messages.length - 1;
          const ok = await sendTelegramMessage(
            target.target,
            messages[i],
            'HTML',
            isLast ? READ_ALL_KEYBOARD : undefined
          );
          if (!ok) return false;
          if (!isLast) await sleep(200);
        }
        return true;
      }
      case 'email': {
        const target = await getDeliveryTarget(userId, 'email', product);
        if (!target) return false;
        const { subject, html } = formatDigestEmail(c);
        return sendEmail(target.target, subject, html);
      }
      case 'push': {
        const { title, body, data } = formatDigestPush(c);
        // Fan-out в обе push-системы: FCM (push.ts) и VAPID web push (webPush.ts).
        // Успех = доставлено хотя бы в одну.
        const [fcmOk, vapidCount] = await Promise.all([
          sendPushNotification(userId, title, body, data),
          sendWebPushToUser(userId, title, body, data),
        ]);
        return fcmOk || vapidCount > 0;
      }
    }
  }

  if (product === 'weekly_report') {
    const c = content as WeeklyReportContent;
    const opts = weeklyChannelOptions(weeklyExtra ?? null, channel);
    switch (channel) {
      case 'telegram': {
        const target = await getDeliveryTarget(userId, 'telegram', product);
        if (!target) return false;
        // ТЗ-184/191: картинка первым сообщением с inline-кнопкой на страницу
        // отчёта. Падение фото не отменяет текст (деградация → текстовая
        // сводка с кнопкой в последнем чанке).
        let photoSent = false;
        if (chart) {
          const caption = formatWeeklyReportChartCaption(c);
          const keyboard = weeklyReportKeyboard(opts.reportUrl);
          photoSent = await sendTelegramPhoto(target.target, chart, caption ?? undefined, keyboard);
          if (!photoSent) {
            console.warn(`[Dispatcher] user=${userId} product=weekly_report photo failed, sending text only`);
          } else {
            await sleep(500);
          }
        }
        const text = formatWeeklyReportTelegram(c, opts);
        const chunks = splitTelegramMessage(text, 4000);
        // Кнопку дублируем под текстом, только если фото не ушло (иначе она под фото)
        const fallbackKeyboard = photoSent ? undefined : weeklyReportKeyboard(opts.reportUrl);
        for (let i = 0; i < chunks.length; i++) {
          const isLast = i === chunks.length - 1;
          const ok = await sendTelegramMessage(
            target.target,
            chunks[i],
            'HTML',
            isLast ? fallbackKeyboard : undefined
          );
          if (!ok) return false;
          if (!isLast) await sleep(500);
        }
        return true;
      }
      case 'email': {
        const target = await getDeliveryTarget(userId, 'email', product);
        if (!target) return false;
        const { subject, html } = formatWeeklyReportEmail(c, { withChart: !!chart, ...opts });
        const attachments: EmailAttachment[] | undefined = chart
          ? [{ filename: 'weekly-chart.png', content: chart, contentId: 'weekly-chart' }]
          : undefined;
        return sendEmail(target.target, subject, html, attachments);
      }
      case 'push': {
        const { title, body, data } = formatWeeklyReportPush(c, opts.reportUrl);
        const [fcmOk, vapidCount] = await Promise.all([
          sendPushNotification(userId, title, body, data),
          sendWebPushToUser(userId, title, body, data),
        ]);
        return fcmOk || vapidCount > 0;
      }
    }
  }

  return false;
}

// ── Плановая рассылка одному юзеру (все его включённые каналы продукта) ────

export async function dispatchToUser(userId: string, product: Product): Promise<SendResult> {
  // ТЗ-191: id снапшота текущей недели (weekly_report) — для markSnapshotSent в finally
  let weeklySnapshotId: string | null = null;
  let weeklySnapshotAi: WeeklyAISummaries | null = null;
  let weeklyToken: string | null = null;
  let weeklySent = false;
  try {
    // 1. Тариф на уровне продукта (доступ + лимит тегов из плана)
    const ent = await getEntitlement(userId, product);
    if (!ent.allowed) {
      console.log(`[Dispatcher] user=${userId} product=${product} blocked: ${ent.reason}`);
      return 'skipped';
    }

    // 2. Тихие часы — по МСК (общие для всех каналов), кроме billing
    const quiet = await getQuietHours(userId);
    if (quiet?.enabled && isQuietHoursForProduct(product, quiet.start, quiet.end)) {
      console.log(`[Dispatcher] user=${userId} product=${product} quiet hours (MSK), skip`);
      return 'skipped';
    }

    // 3. Какие каналы due
    const subs = await getEnabledSubscriptions(userId, product);
    const due = subs.filter(s => isDueByFrequency(s));
    if (due.length === 0) return 'skipped';

    // 4. Контент строим ОДИН раз; окно — от самого раннего last_sent_at,
    //    чтобы ни один канал не потерял статьи (unread-фильтр дальше сам всё отсечёт)
    const earliest = due
      .map(s => s.lastSentAt)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    // ТЗ-191: для weekly_report контент — ИЗ СНАПШОТА фазы генерации (11:00),
    // buildContent здесь НЕ вызывается (иначе двойная работа и риск расхождения).
    // Ветка weekly_report в buildContent остаётся для совместимости (manual /now).
    // Нет снапшота (генерация не успела/упала) → skipped + warn: юзеру не ломаем,
    // дорассылка произойдёт при следующем подходящем окне (sent_at остаётся NULL).
    let content: NotificationContent | null;
    if (product === 'weekly_report') {
      // ПРАВКА-2 к ТЗ-191: ищем по той же отчётной неделе, что пишет генерация
      // (в пн–сб — завершившаяся на вчерашнем вс неделя, в вс — текущая)
      const snapshot = await getCurrentWeekSnapshot(
        userId,
        weekStartMskDate(weeklyReportTargetWeekStart())
      );
      if (!snapshot) {
        console.warn(`[Dispatcher] user=${userId} product=weekly_report no current-week snapshot, skipped`);
        return 'skipped';
      }
      content = snapshot.content;
      weeklySnapshotId = snapshot.id;
      weeklySnapshotAi = snapshot.ai;
      // ТЗ-191 Задача 5: plaintext-токена в БД нет — перевыпускаем (upsert той же
      // строки, срок 7 дней от отправки) и вставляем в ссылки письма/TG/push.
      // Ошибка выпуска токена не отменяет рассылку — уйдёт сводка без кнопки.
      try {
        weeklyToken = await issueReportAccessToken(snapshot.id);
      } catch (e) {
        console.error(`[Dispatcher] issueReportAccessToken failed for ${snapshot.id}, sending without link:`, e);
      }
    } else {
      content = await buildContent(userId, product, ent.maxTags, earliest);
    }
    if (!content || isEmptyContent(content)) {
      console.log(`[Dispatcher] user=${userId} product=${product} no content`);
      return 'empty';
    }

    // ТЗ-184: PNG инфографики — один раз на юзера, до фан-аута по каналам.
    // Рендер упал → null → каналы шлют текст (текущее поведение сохраняется).
    const chart = product === 'weekly_report'
      ? await renderWeeklyChart(content as WeeklyReportContent)
      : null;

    // 5. Фан-аут по каналам; last_sent_at обновляется per-channel после успеха.
    //    Доступ к КАНАЛУ — тоже из тарифа (features плана: telegram/push).
    let anySent = false;
    let anyError = false;
    for (const sub of due) {
      const channelEnt = await getEntitlement(userId, product, sub.channel);
      if (!channelEnt.allowed) {
        console.log(`[Dispatcher] user=${userId} product=${product} channel=${sub.channel} blocked: ${channelEnt.reason}`);
        continue;
      }
      const weeklyExtra: WeeklyDeliveryExtra | null = product === 'weekly_report'
        ? { reportId: weeklySnapshotId!, token: weeklyToken, ai: weeklySnapshotAi }
        : null;
      const ok = await deliver(userId, product, sub.channel, content, sub.frequency ?? '1h', chart, weeklyExtra);
      if (ok) {
        await markSent(userId, product, sub.channel);
        anySent = true;
        weeklySent = true;
      } else {
        anyError = true;
        console.error(`[Dispatcher] user=${userId} product=${product} channel=${sub.channel} failed`);
      }
      await sleep(300); // rate limit между каналами
    }

    return anySent ? 'sent' : anyError ? 'error' : 'skipped';
  } catch (err) {
    console.error(`[Dispatcher] user=${userId} product=${product} error:`, err);
    return 'error';
  } finally {
    // ТЗ-191: гейт идемпотентной отправки — только после успешного фан-аута.
    // Тихие часы/отсутствие due-каналов оставляют sent_at = NULL (дорассылка позже).
    if (weeklySent && weeklySnapshotId) {
      try {
        await markSnapshotSent(weeklySnapshotId);
      } catch (e) {
        console.error(`[Dispatcher] markSnapshotSent failed for ${weeklySnapshotId}:`, e);
      }
    }
  }
}

// ── Ручная отправка (/now, кнопка "Получить дайджест") ─────────────────────
// Игнорирует частоту и тихие часы, использует ВСЕ теги (как лента на сайте).

export async function dispatchToUserNow(
  userId: string,
  product: Product,
  channel: Channel
): Promise<SendResult> {
  try {
    const ent = await getEntitlement(userId, product, channel);
    if (!ent.allowed) {
      console.log(`[Dispatcher:manual] user=${userId} product=${product} channel=${channel} blocked: ${ent.reason}`);
      return 'skipped';
    }

    const content = await buildContent(userId, product, null, null, 'manual');
    if (!content || isEmptyContent(content)) return 'empty';

    const chart = product === 'weekly_report'
      ? await renderWeeklyChart(content as WeeklyReportContent)
      : null;
    const ok = await deliver(userId, product, channel, content, '1h', chart);
    if (!ok) return 'error';
    await markSent(userId, product, channel);
    return 'sent';
  } catch (err) {
    console.error(`[Dispatcher:manual] user=${userId} error:`, err);
    return 'error';
  }
}

// ── Рассылка всем (вызывается воркером) ─────────────────────────────────────

export async function broadcastProduct(product: Product): Promise<DeliveryResult> {
  console.log(`[Dispatcher] Broadcast product=${product}`);
  const recipients = await getRecipients(product);
  console.log(`[Dispatcher] ${recipients.length} recipients for ${product}`);

  let sent = 0, skipped = 0, errors = 0, empty = 0;
  for (const r of recipients) {
    const result = await dispatchToUser(r.userId, product);
    if (result === 'sent') sent++;
    else if (result === 'error') errors++;
    else if (result === 'empty') empty++;
    else skipped++;
    await sleep(300);
  }
  console.log(`[Dispatcher] ${product} done: ${sent} sent, ${skipped} skipped, ${empty} empty, ${errors} errors`);
  return { sent, skipped, errors, empty };
}

// ── Контент-роутер (при добавлении продукта — одна строка) ─────────────────

async function buildContent(
  userId: string,
  product: Product,
  maxTags: number | null,
  since: Date | null,
  context = 'scheduled'
): Promise<NotificationContent | null> {
  switch (product) {
    case 'digest':
      return buildDigestContent(userId, maxTags, since, context);
    case 'weekly_report':
      return buildWeeklyReportContent(userId, maxTags);
    // fact_check, news_alert, billing, engagement — event-driven, не по расписанию
    default:
      return null;
  }
}

export { buildContent };

// ── Helpers ───────────────────────────────────────────────────────────────────

function isEmptyContent(content: NotificationContent): boolean {
  if ('articles' in content) return content.articles.length === 0;
  if ('tagSummaries' in content) return content.tagSummaries.length === 0;
  return true;
}

function splitTelegramMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n', maxLength);
    if (cutAt === -1) cutAt = maxLength;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trim();
  }
  return chunks;
}
