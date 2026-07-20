/**
 * =============================================================================
 * PULSE — User Event Types
 * =============================================================================
 *
 * Единое место определения типов пользовательских событий.
 * Вынесено в отдельный файл, чтобы разорвать циклическую зависимость между
 * activityLog.ts и adminAlerts.ts.
 */

export const USER_EVENT_TYPES = [
  'register',
  'login',
  'forgot_password',
  'password_reset',
  'tag_added',
  'tag_removed',
  'payment_completed',
  'subscription_activated',
  'subscription_cancelled',
  'channel_connected',
  'channel_disconnected',
  'telegram_connected',
  'telegram_disconnected',
  'email_connected',
  'email_disconnected',
  'sentiment_vote',
  'factcheck_ordered',
  'page_view_plans',
] as const;

export type UserEventType = typeof USER_EVENT_TYPES[number];

export function isUserEventType(value: string): value is UserEventType {
  return USER_EVENT_TYPES.includes(value as UserEventType);
}
