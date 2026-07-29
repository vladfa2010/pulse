/**
 * PULSE — Notification Dispatcher.
 *
 * Единая точка рассылки любого продукта по всем каналам:
 *   recipients → entitlement → тихие часы/частота → контент → формат → отправка
 *
 * Воркеры (cron) больше не содержат ни тарифной логики, ни знания о каналах.
 */

import { sendTelegramMessage } from '../telegram';
import { sendEmail } from '../email';
import { sendPushNotification } from '../push';
import { sendWebPushToUser } from '../webPush';
import { buildDigestContent, DigestContent } from './digestContent';
import { formatDigestTelegram, formatDigestEmail, formatDigestPush } from './formatters';
import { getEntitlement } from './entitlement';
import { isQuietHoursForProduct } from './quietHours';
import {
  getRecipients, getEnabledSubscriptions, getDeliveryTarget, getQuietHours,
  isDueByFrequency, markSent,
} from './subscriptions';
import { Product, Channel, Subscription, DeliveryResult } from './types';

export type SendResult = 'sent' | 'empty' | 'skipped' | 'error';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Отправка одного продукта в один канал ───────────────────────────────────

async function deliver(
  userId: string,
  product: Product,
  channel: Channel,
  content: DigestContent,
  frequency: string
): Promise<boolean> {
  switch (channel) {
    case 'telegram': {
      const target = await getDeliveryTarget(userId, 'telegram', product);
      if (!target) return false;
      const messages = formatDigestTelegram(content, frequency);
      for (let i = 0; i < messages.length; i++) {
        const ok = await sendTelegramMessage(target.target, messages[i]);
        if (!ok) return false;
        if (i < messages.length - 1) await sleep(200);
      }
      return true;
    }
    case 'email': {
      const target = await getDeliveryTarget(userId, 'email', product);
      if (!target) return false;
      const { subject, html } = formatDigestEmail(content);
      return sendEmail(target.target, subject, html);
    }
    case 'push': {
      const { title, body, data } = formatDigestPush(content);
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

// ── Плановая рассылка одному юзеру (все его включённые каналы продукта) ────

export async function dispatchToUser(userId: string, product: Product): Promise<SendResult> {
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

    const content = await buildContent(userId, product, ent.maxTags, earliest);
    if (!content || content.articles.length === 0) {
      console.log(`[Dispatcher] user=${userId} product=${product} no content`);
      return 'empty';
    }

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
      const ok = await deliver(userId, product, sub.channel, content, sub.frequency ?? '1h');
      if (ok) {
        await markSent(userId, product, sub.channel);
        anySent = true;
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
    if (!content || content.articles.length === 0) return 'empty';

    const ok = await deliver(userId, product, channel, content, '1h');
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
): Promise<DigestContent | null> {
  switch (product) {
    case 'digest':
      return buildDigestContent(userId, maxTags, since, context);
    // case 'weekly_report': return buildWeeklyReportContent(userId, maxTags);
    // case 'fact_check': обрабатывается своим воркером по событиям, не по расписанию
    default:
      return null;
  }
}

export { buildContent };
