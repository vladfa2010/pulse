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
import { isQuietHours } from './email';

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
    const settingsResult = await query(
      `SELECT push_enabled FROM notification_settings WHERE user_id = $1`,
      [userId]
    );
    const settings = settingsResult.rows[0];
    if (!settings || !settings.push_enabled) return false;

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

    console.log(`[Push] Sentiment vote push to user ${userId}`);
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
      console.error('[Push] sendSentimentVotePush failed:', err.message);
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
  data: PushData = {}
): Promise<boolean> {
  console.log(`[Push] sendPushNotification user=${userId} title="${title}"`);
  if (!messaging) {
    console.log('[Push] Not configured, skipping');
    return false;
  }

  try {
    // Check user settings
    const settingsResult = await query(
      `SELECT push_enabled, quiet_hours_enabled, quiet_hours_start, quiet_hours_end
       FROM notification_settings WHERE user_id = $1`,
      [userId]
    );
    const settings = settingsResult.rows[0];
    if (!settings || !settings.push_enabled) return false;

    if (settings.quiet_hours_enabled && await isQuietHours(userId)) {
      console.log(`[Push] Quiet hours for user ${userId}, skipping`);
      return false;
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
  source: string,
  matchedTags: string[]
): Promise<void> {
  console.log(`[Push] sendNewArticlePush called for ${newsId}, tags=${JSON.stringify(matchedTags)}, messaging=${!!messaging}`);
  if (!messaging || matchedTags.length === 0) {
    console.log(`[Push] Skipping article ${newsId}: messaging=${!!messaging}, tags=${matchedTags.length}`);
    return;
  }

  try {
    const result = await query(
      `SELECT DISTINCT p.user_id
       FROM portfolios p
       JOIN notification_settings ns ON ns.user_id = p.user_id AND ns.push_enabled = TRUE
       JOIN user_channels uc ON uc.user_id = p.user_id AND uc.channel = 'push' AND uc.is_active = TRUE
       LEFT JOIN user_news_reads r ON r.user_id = p.user_id AND r.news_id = $2
       LEFT JOIN push_notifications_sent ps ON ps.user_id = p.user_id AND ps.news_id = $2
       WHERE p.tag_id = ANY($1::text[])
         AND r.user_id IS NULL
         AND ps.id IS NULL`,
      [matchedTags, newsId]
    );

    const userIds: string[] = result.rows.map(r => r.user_id);
    console.log(`[Push] Article ${newsId}: ${userIds.length} candidate users`);
    if (userIds.length === 0) return;

    const body = source || 'Новая новость';
    const data: PushData = {
      type: 'new_article',
      news_id: newsId,
      tag: matchedTags[0] || '',
    };

    for (const userId of userIds) {
      try {
        const insertResult = await query(
          `INSERT INTO push_notifications_sent (user_id, news_id)
           VALUES ($1, $2)
           ON CONFLICT (user_id, news_id) DO NOTHING
           RETURNING id`,
          [userId, newsId]
        );
        if (insertResult.rows.length === 0) {
          console.log(`[Push] Article ${newsId}: already sent to user ${userId}`);
          continue;
        }

        const ok = await sendPushNotification(userId, title, body, data);
        console.log(`[Push] Article ${newsId}: sent to user ${userId} = ${ok}`);
      } catch (err: any) {
        console.error(`[Push] Failed to notify user ${userId} about article ${newsId}:`, err.message);
      }
    }
  } catch (err: any) {
    console.error('[Push] sendNewArticlePush failed:', err.message);
  }
}
