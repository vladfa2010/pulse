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

interface PushData {
  [key: string]: string;
}

export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data: PushData = {}
): Promise<boolean> {
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
