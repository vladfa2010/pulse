/**
 * =============================================================================
 * PULSE — Push Notification Service (Firebase Cloud Messaging)
 * =============================================================================
 *
 * Sends push notifications to Android (and web) devices.
 * FCM tokens are stored in user_channels with channel = 'push'.
 */

import { initializeApp, cert } from 'firebase-admin';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { query } from '../config/db';
import { sendWebPushToUser } from './webPush';
import { isQuietHoursMsk } from './notifications/quietHours';
import { getEnabledSubscriptions } from './notifications/subscriptions';
import { getQuietHours } from './notifications/subscriptions';
import { truncateTextSmart, PUSH_TITLE_MAX, PUSH_BODY_MAX } from './notifications/formatters';

let messaging: Messaging | null = null;

// Initialize Firebase Admin from a base64-encoded service-account JSON.
const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (serviceAccountBase64 && serviceAccountBase64.length > 0) {
  try {
    const serviceAccount = JSON.parse(
      Buffer.from(serviceAccountBase64, 'base64').toString('utf8')
    );
    const app = initializeApp({
      credential: cert(serviceAccount as any),
    });
    messaging = getMessaging(app);
    console.log('[Push] Firebase Admin initialized');
  } catch (err: any) {
    console.error('[Push] Failed to initialize Firebase Admin:', err.message);
  }
} else {
  console.log('[Push] FIREBASE_SERVICE_ACCOUNT_BASE64 not set; push notifications disabled');
}

export function isPushConfigured(): boolean {
  return messaging !== null;
}

/**
 * Отправить data-only push с 3 кнопками голосования в Sentiment Index.
 * Без notification-блока — Android рисует уведомление сам в PulseMessagingService.
 */
export async function sendSentimentVotePush(userId: string): Promise<boolean> {
  console.log(`[Push] sendSentimentVotePush user=${userId}`);
  if (!messaging) {
    console.log('[Push] Not configured, skipping');
    return false;
  }

  try {
    const subs = await getEnabledSubscriptions(userId, 'engagement');
    const pushSub = subs.find(s => s.channel === 'push');
    if (!pushSub) {
      console.log(`[Push] engagement/push disabled for user ${userId}`);
      return false;
    }

    // Quiet hours (MSK)
    const quietResult = await query(
      `SELECT quiet_hours_enabled, quiet_hours_start, quiet_hours_end
       FROM notification_settings WHERE user_id = $1`,
      [userId]
    );
    const quiet = quietResult.rows[0];
    if (quiet?.quiet_hours_enabled && isQuietHoursMsk(quiet.quiet_hours_start, quiet.quiet_hours_end)) {
      console.log(`[Push] Quiet hours for user ${userId}, skipping sentiment vote`);
      return false;
    }

    // Fan-out: FCM + VAPID web push
    const fcmOk = await sendEngagementPushFcm(userId);
    const vapidOk = await sendWebPushToUser(userId, 'Оцените рынок', 'Ваш голос влияет на индекс сантимента. Как вы оцените рынок?', { type: 'sentiment_vote' });

    return fcmOk || vapidOk > 0;
  } catch (err: any) {
    console.error('[Push] sendSentimentVotePush failed:', err.message);
    return false;
  }
}

async function sendEngagementPushFcm(userId: string): Promise<boolean> {
  if (!messaging) return false;

  try {
    const channelResult = await query(
      `SELECT target FROM user_channels
       WHERE user_id = $1 AND channel = 'push' AND is_active = TRUE`,
      [userId]
    );
    if (channelResult.rows.length === 0) return false;

    const token = channelResult.rows[0].target;

    await messaging.send({
      token,
      data: {
        type: 'sentiment_vote',
        title: 'Оцените рынок',
        body: 'Ваш голос влияет на индекс сантимента. Как вы оцените рынок?',
      },
      android: { priority: 'high' },
    });

    console.log(`[Push] Sentiment vote FCM to user ${userId}`);
    return true;
  } catch (err: any) {
    const code = err.code || err.errorInfo?.code;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    ) {
      console.warn(`[Push] Invalid token for user ${userId}, deactivating`);
      try {
        await query(
          `UPDATE user_channels SET is_active = FALSE
           WHERE user_id = $1 AND channel = 'push'`,
          [userId]
        );
      } catch (dbErr: any) {
        console.error('[Push] Failed to deactivate token:', dbErr.message);
      }
    } else {
      console.error('[Push] sendEngagementPushFcm failed:', err.message);
    }
    return false;
  }
}

interface PushData {
  [key: string]: string;
}

export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data: PushData = {},
  options: { skipQuietHours?: boolean; skipEnabledCheck?: boolean } = {}
): Promise<boolean> {
  console.log(`[Push] sendPushNotification user=${userId} title="${title}"`);
  if (!messaging) {
    console.log('[Push] Not configured, skipping');
    return false;
  }

  try {
    // Kill-switch: пока фронт частично пишет в старую колонку, проверяем её тоже.
    // Для transactional push (billing) вызывающий может отключить эту проверку,
    // т.к. он уже проверил матрицу ('billing','push').
    if (!options.skipEnabledCheck) {
      const settingsResult = await query(
        `SELECT push_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end
         FROM notification_settings WHERE user_id = $1`,
        [userId]
      );
      const settings = settingsResult.rows[0];
      if (!settings || !settings.push_enabled) return false;

      if (!options.skipQuietHours && settings.quiet_hours_enabled && isQuietHoursMsk(settings.quiet_hours_start, settings.quiet_hours_end)) {
        console.log(`[Push] Quiet hours for user ${userId}, skipping`);
        return false;
      }
    }

    // Get active push token
    const channelResult = await query(
      `SELECT target FROM user_channels
       WHERE user_id = $1 AND channel = 'push' AND is_active = TRUE`,
      [userId]
    );
    if (channelResult.rows.length === 0) return false;

    const token = channelResult.rows[0].target;

    await messaging.send({
      token,
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        notification: { channelId: 'pulse_default' },
      },
    });

    console.log(`[Push] Sent to user ${userId}`);
    return true;
  } catch (err: any) {
    const code = err.code || err.errorInfo?.code;
    if (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    ) {
      console.warn(`[Push] Invalid token for user ${userId}, deactivating`);
      try {
        await query(
          `UPDATE user_channels SET is_active = FALSE
           WHERE user_id = $1 AND channel = 'push'`,
          [userId]
        );
      } catch (dbErr: any) {
        console.error('[Push] Failed to deactivate token:', dbErr.message);
      }
    } else {
      console.error('[Push] Send failed:', err.message);
    }
    return false;
  }
}

/**
 * Send an immediate push notification to users who track any of the given tags
 * and haven't already received a push for this article.
 */
export async function sendNewArticlePush(
  newsId: string,
  title: string,
  summary: string,
  source: string,
  matchedTags: string[]
): Promise<void> {
  console.log(`[Push] sendNewArticlePush called for ${newsId}, tags=${JSON.stringify(matchedTags)}, summary_len=${summary?.length || 0}, messaging=${!!messaging}`);
  if (!messaging || matchedTags.length === 0) {
    console.log(`[Push] Skipping article ${newsId}: messaging=${!!messaging}, tags=${matchedTags.length}`);
    return;
  }

  try {
    const result = await query(
      `SELECT DISTINCT p.user_id
       FROM portfolios p
       JOIN notification_subscriptions ns ON ns.user_id = p.user_id
         AND ns.product = 'news_alert' AND ns.channel = 'push' AND ns.enabled = TRUE
       WHERE p.tag_id = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM user_news_reads r
           WHERE r.user_id = p.user_id AND r.news_id = $2
         )
         AND NOT EXISTS (
           SELECT 1 FROM push_notifications_sent ps
           WHERE ps.user_id = p.user_id AND ps.news_id = $2
         )
         AND (
           EXISTS (
             SELECT 1 FROM user_channels uc
             WHERE uc.user_id = p.user_id AND uc.channel = 'push' AND uc.is_active = TRUE
           )
           OR EXISTS (
             SELECT 1 FROM push_subscriptions ps2
             WHERE ps2.user_id = p.user_id AND ps2.is_active = TRUE
           )
         )`,
      [matchedTags, newsId]
    );

    const userIds: string[] = result.rows.map(r => r.user_id);
    console.log(`[Push] Article ${newsId}: ${userIds.length} candidate users`);
    if (userIds.length === 0) return;

    const pushTitle = truncateTextSmart(title, PUSH_TITLE_MAX);

    const rawBody = (summary || '').trim();
    const body = truncateTextSmart(
      rawBody || source || 'Новая новость',
      PUSH_BODY_MAX
    );

    const data: PushData = {
      type: 'new_article',
      news_id: newsId,
      tag: matchedTags[0] || '',
      source: source || '',
    };

    for (const userId of userIds) {
      try {
        // Respect quiet hours (MSK) for content-driven alerts
        const quiet = await getQuietHours(userId);
        if (quiet?.enabled && isQuietHoursMsk(quiet.start, quiet.end)) {
          console.log(`[Push] Article ${newsId}: quiet hours for user ${userId}, skip`);
          continue;
        }

        const insertResult = await query(
          `INSERT INTO push_notifications_sent (user_id, news_id, title, source)
           VALUES ($1, $2, $3, 'push')
           ON CONFLICT (user_id, news_id) DO NOTHING
           RETURNING id`,
          [userId, newsId, pushTitle]
        );
        if (insertResult.rows.length === 0) {
          console.log(`[Push] Article ${newsId}: already sent to user ${userId}`);
          continue;
        }

        const [fcmOk, vapidCount] = await Promise.all([
          sendPushNotification(userId, pushTitle, body, data),
          sendWebPushToUser(userId, pushTitle, body, data),
        ]);
        console.log(`[Push] Article ${newsId}: sent to user ${userId} fcm=${fcmOk} vapid=${vapidCount}`);
      } catch (err: any) {
        console.error(`[Push] Failed to notify user ${userId} about article ${newsId}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error('[Push] sendNewArticlePush failed:', err.message);
  }
}
