// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-186: уведомление пользователя при записи на курс админом.
// Доступность каналов — getDeliveryTarget (email неявный, push FCM→VAPID,
// telegram активный user_channels). Отправка транзакционная: тихие часы и
// частотные лимиты диспетчера НЕ применяем (явное действие админа).
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { sendEmail } from '../email';
import { sendTelegramMessage } from '../telegram';
import type { InlineKeyboard } from '../telegram';
import { sendPushNotification } from '../push';
import { sendWebPushToUser } from '../webPush';
import { getDeliveryTarget } from '../notifications/subscriptions';
import type { Channel } from '../notifications/types';

export type EnrollNotifyChannel = Extract<Channel, 'email' | 'push' | 'telegram'>;
export const ENROLL_NOTIFY_CHANNELS: EnrollNotifyChannel[] = ['email', 'push', 'telegram'];

export interface EnrollNotifyResult {
  sent: Partial<Record<EnrollNotifyChannel, boolean>>;
  skipped: Partial<Record<EnrollNotifyChannel, string>>;
  failed: Partial<Record<EnrollNotifyChannel, string>>;
}

const APP_URL = (process.env.APP_URL || process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru').replace(/\/+$/, '');

// ─── Email-шаблон (та же дизайн-система писем, что templates/fact-check-result.html) ──

let emailTemplate: string | null = null;

function loadEmailTemplate(): string {
  if (emailTemplate) return emailTemplate;
  const templatePath = path.resolve(__dirname, '../../../templates/course-access-granted.html');
  emailTemplate = fs.readFileSync(templatePath, 'utf-8');
  return emailTemplate;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmailHtml(courseTitle: string, courseUrl: string): string {
  return loadEmailTemplate()
    .replace(/\{\{courseTitle\}\}/g, escapeHtml(courseTitle))
    .replace(/\{\{courseUrl\}\}/g, courseUrl);
}

// ─── API ─────────────────────────────────────────────────────────────────────

/** Доступность каналов для юзера (флаги чекбоксов модалки админа). */
export async function getEnrollNotifyChannels(
  userId: string,
): Promise<Record<EnrollNotifyChannel, boolean>> {
  const [email, push, telegram] = await Promise.all(
    ENROLL_NOTIFY_CHANNELS.map((c) => getDeliveryTarget(userId, c)),
  );
  return { email: !!email, push: !!push, telegram: !!telegram };
}

/** Отправка «Вам предоставлен доступ к курсу …» по выбранным каналам. */
export async function notifyEnrolledUser(args: {
  userId: string;
  course: { id: string; title: string; slug: string };
  channels: EnrollNotifyChannel[];
}): Promise<EnrollNotifyResult> {
  const { userId, course, channels } = args;
  const courseUrl = `${APP_URL}/education/${course.slug}`;
  const text = `Вам предоставлен доступ к курсу «${course.title}».`;

  const result: EnrollNotifyResult = { sent: {}, skipped: {}, failed: {} };

  for (const channel of channels) {
    try {
      // Канал мог отвалиться между записью и отправкой — честный skipped.
      const target = await getDeliveryTarget(userId, channel);
      if (!target) {
        result.skipped[channel] = 'channel_not_connected';
        continue;
      }

      if (channel === 'email') {
        const ok = await sendEmail(
          target.target,
          `Вам предоставлен доступ к курсу «${course.title}»`,
          buildEmailHtml(course.title, courseUrl),
        );
        if (ok) result.sent.email = true;
        else result.failed.email = 'send_failed';
      } else if (channel === 'telegram') {
        const keyboard: InlineKeyboard = {
          inline_keyboard: [[{ text: 'Изучить', url: courseUrl }]],
        };
        const ok = await sendTelegramMessage(target.target, text, 'HTML', keyboard);
        if (ok) result.sent.telegram = true;
        else result.failed.telegram = 'send_failed';
      } else {
        // Push: FCM (user_channels) и VAPID (push_subscriptions) — оба, как
        // в billing-ветке; доставка засчитывается по любому транспорту.
        const data = { type: 'course_access', url: `/education/${course.slug}` };
        const [fcmOk, vapidSent] = await Promise.all([
          sendPushNotification(userId, 'Доступ к курсу', text, data, {
            skipQuietHours: true,
            skipEnabledCheck: true,
          }),
          sendWebPushToUser(userId, 'Доступ к курсу', text, data),
        ]);
        if (fcmOk || vapidSent > 0) result.sent.push = true;
        else result.failed.push = 'send_failed';
      }
    } catch (err: any) {
      result.failed[channel] = err?.message || 'error';
    }
  }

  return result;
}
