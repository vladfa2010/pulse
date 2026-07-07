/**
 * =============================================================================
 * PULSE — Web Push Service (VAPID)
 * =============================================================================
 *
 * Sends browser push notifications via Push API + VAPID.
 * Subscriptions are stored in push_subscriptions.
 */

import webPush from 'web-push';
import { query } from '../config/db';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@pulse.app';

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
    console.log('[WebPush] VAPID configured');
  } catch (err: any) {
    console.error('[WebPush] VAPID config failed:', err.message);
  }
} else {
  console.log('[WebPush] VAPID keys not set; web push disabled');
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY;
}

export function isWebPushConfigured(): boolean {
  return configured;
}

export async function sendWebPushToUser(
  userId: string,
  title: string,
  body: string,
  data: Record<string, string> = {}
): Promise<number> {
  if (!configured) return 0;

  const result = await query(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions
     WHERE user_id = $1 AND is_active = TRUE`,
    [userId]
  );

  let sent = 0;
  for (const row of result.rows) {
    try {
      await webPush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify({ title, body, data })
      );
      sent++;
    } catch (err: any) {
      const status = err.statusCode;
      if (status === 410 || status === 404 || err.message?.includes('expired')) {
        // Subscription gone
        await query(
          `UPDATE push_subscriptions SET is_active = FALSE WHERE user_id = $1 AND endpoint = $2`,
          [userId, row.endpoint]
        );
      }
      console.error('[WebPush] Send failed:', err.message);
    }
  }
  return sent;
}
