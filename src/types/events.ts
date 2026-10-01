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
  'admin_changed_plan',
  'admin_extended_subscription',
  'page_view_portfolio',
  'portfolio_add_clicked',
  'portfolio_created',
  'admin_radio_flag_changed',
  // LMS «Образование» (ТЗ-101): события от userId АДМИНА — аудит кто/когда/что.
  'education.course_created',
  'education.course_updated',
  'education.course_published',
  'education.course_archived',
  'education.course_deleted',
  'education.course_restored',
  'education.enroll_admin',
  'education.unenroll_admin',
  // ТЗ-106: самозапись по подписке (source='subscription')
  'education.enroll_subscribed',
  // ТЗ-102: модерация UGC — аудит решений админа (approve/reject)
  'education.moderation_approve',
  'education.moderation_reject',
  // ТЗ-103: решения редактора по рекомендациям мэтчинга — датасет precision
  'education.match_attached',
  'education.match_dismissed',
] as const;

export type UserEventType = typeof USER_EVENT_TYPES[number];

export function isUserEventType(value: string): value is UserEventType {
  return USER_EVENT_TYPES.includes(value as UserEventType);
}
