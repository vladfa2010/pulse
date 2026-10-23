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
  // ТЗ-185: самоотписка студента (purchase отказ, прогресс сохраняется)
  'education.unenroll',
  // ТЗ-186: админ уведомил записанного пользователя (почта/push/Telegram)
  'education.enroll_notified',
  // ТЗ-106: самозапись по подписке (source='subscription')
  'education.enroll_subscribed',
  // ТЗ-184: автозапись в момент интерактива (сдача теста/завершение урока).
  // В TG-алерты админам не добавляется (не входит в ALERT_EVENT_TYPES) —
  // событие аналитическое (воронка ТЗ-179), а не повод для уведомления.
  'education.enroll_auto',
  // ТЗ-179: студенческие события обучения (аналитика воронки; админы не логируются)
  'education.course_started',
  'education.lesson_started',
  'education.material_downloaded',
  'education.test_attempt',
  // ТЗ-102: модерация UGC — аудит решений админа (approve/reject/delete)
  'education.moderation_approve',
  'education.moderation_reject',
  'education.moderation_delete',
  // ТЗ-103: решения редактора по рекомендациям мэтчинга — датасет precision
  'education.match_attached',
  'education.match_dismissed',
  // ТЗ-136: загрузка картинки в конспект/описание (kind='content')
  'education.content_image_uploaded',
  // ТЗ-105 v2: программы (плейлисты курсов) — аудит действий админа
  'education.path_created',
  'education.path_updated',
  'education.path_deleted',
  'education.path_published',
  'education.path_archived',
  'education.path_enroll_admin',
  // ТЗ-172: переключение рантайм-настроек мэтчинга (выключатель LLM-ранкера)
  'education.settings_updated',
  // ТЗ-120: аудит выгрузок базы пользователей (кто, когда, сколько строк)
  'admin_export_users',
  // ТЗ-123: алерты админам — портфели/образование/витрины + антифлуд-фонды
  'position_added',
  'position_closed',
  'course_started',
  'lesson_completed',
  'course_completed',
  'weekly_report_viewed',
  'cascades_viewed',
  'page_view_feed',
] as const;

export type UserEventType = typeof USER_EVENT_TYPES[number];

export function isUserEventType(value: string): value is UserEventType {
  return USER_EVENT_TYPES.includes(value as UserEventType);
}
