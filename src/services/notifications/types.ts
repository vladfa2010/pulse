/**
 * PULSE — Notification Matrix: базовые типы
 * Продукт = ЧТО отправляем. Канал = КУДА. Это ортогональные измерения.
 */

/**
 * Продукты:
 *  - digest        — периодическая подборка непрочитанных (cron)
 *  - weekly_report — еженедельный отчёт (cron)
 *  - fact_check    — результат факт-чека (event-driven, свой воркер)
 *  - news_alert    — мгновенный пуш о новой статье по тегам (event-driven, push.ts)
 *  - billing       — уведомления о подписке/оплате (transactional, тарифом не ограничивается)
 *  - engagement    — механики удержания: sentiment-напоминания «проголосуй», стрики
 *                    (event-driven, свой воркер; диспетчер решает только «кому»)
 */
export type Product = 'digest' | 'weekly_report' | 'fact_check' | 'news_alert' | 'billing' | 'engagement';
export type Channel = 'telegram' | 'email' | 'push';

export interface Subscription {
  userId: string;
  product: Product;
  channel: Channel;
  enabled: boolean;
  frequency: string | null;      // '1h'|'3h'|'6h'|'12h'|'24h' — только digest
  lastSentAt: Date | null;       // per product+channel
}

export interface DeliveryTarget {
  channel: Channel;
  /** chat_id для telegram, email-адрес, push-token — из user_channels */
  target: string;
}

/** Решение тарифа: может ли юзер получать продукт и с какими лимитами */
export interface Entitlement {
  allowed: boolean;
  maxTags: number | null;        // null = без лимита (ручной /now); иначе plan.tagLimit
  reason?: string;               // для логов: 'free_not_allowed' | 'no_subscription' ...
}

export const FREQUENCY_HOURS: Record<string, number> = {
  '1h': 1, '3h': 3, '6h': 6, '12h': 12, '24h': 24,
};

export const FREQUENCY_LABELS: Record<string, string> = {
  '1h': 'каждый час', '3h': 'каждые 3 часа', '6h': 'каждые 6 часов',
  '12h': '2 раза в сутки', '24h': 'раз в сутки',
};

export const FREQUENCY_LABELS_SHORT: Record<string, string> = {
  '1h': '1 ч', '3h': '3 ч', '6h': '6 ч', '12h': '12 ч', '24h': '24 ч',
};

export const PRODUCT_LABELS: Record<Product, string> = {
  digest: 'Дайджест непрочитанного',
  weekly_report: 'Еженедельный отчёт',
  fact_check: 'Факт-чек',
  news_alert: 'Мгновенные алерты',
  billing: 'Подписка и оплата',
  engagement: 'Механики и напоминания',
};

export const PRODUCT_NOTES: Record<Product, string> = {
  digest: 'Подборка по вашим тегам',
  weekly_report: 'Воскресенье, 13:00 МСК',
  fact_check: 'Результат проверки новости',
  news_alert: 'Пуш сразу при выходе новости',
  billing: 'Истечение, продление, чеки',
  engagement: 'Sentiment Index, стрики',
};

export const PRODUCT_CHANNELS: Record<Product, Channel[]> = {
  digest: ['telegram', 'email', 'push'],
  weekly_report: ['telegram', 'email', 'push'],
  fact_check: ['telegram', 'email'],
  news_alert: ['push'],
  billing: ['email', 'push'],
  engagement: ['push'],
};

export const CHANNEL_LABELS: Record<Channel, string> = {
  telegram: 'Telegram',
  email: 'Email',
  push: 'Push',
};

export const CHANNEL_ORDER: Channel[] = ['telegram', 'email', 'push'];

export interface QuietHours {
  enabled: boolean;
  start: string;
  end: string;
}

export interface NotificationMatrixResponse {
  subscriptions: Subscription[];
  quietHours: QuietHours | null;
  channels: { channel: Channel; is_active: boolean }[];
}

export interface NotificationMatrixUpdate {
  product: Product;
  channel: Channel;
  enabled?: boolean;
  frequency?: string;
}

export interface DeliveryResult {
  sent: number;
  skipped: number;
  errors: number;
  empty: number;
}

export interface CronLogCounters {
  articles_fetched?: number | null;
  articles_saved?: number | null;
}

export const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: true,
  start: '22:00',
  end: '08:00',
};

export const DEFAULT_DIGEST_FREQUENCY = '1h';

export const VALID_FREQUENCIES = ['1h', '3h', '6h', '12h', '24h'] as const;

export const VALID_PRODUCTS: Product[] = [
  'digest',
  'weekly_report',
  'fact_check',
  'news_alert',
  'billing',
  'engagement',
];

export const VALID_CHANNELS: Channel[] = ['telegram', 'email', 'push'];

export function isValidFrequency(value: string): value is typeof VALID_FREQUENCIES[number] {
  return (VALID_FREQUENCIES as readonly string[]).includes(value);
}

export function isValidProduct(value: string): value is Product {
  return VALID_PRODUCTS.includes(value as Product);
}

export function isValidChannel(value: string): value is Channel {
  return VALID_CHANNELS.includes(value as Channel);
}

export function isValidQuietHoursTime(value: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value);
}

export function getProductLabel(product: Product): string {
  return PRODUCT_LABELS[product] || product;
}

export function getProductNote(product: Product): string {
  return PRODUCT_NOTES[product] || '';
}

export function getProductChannels(product: Product): Channel[] {
  return PRODUCT_CHANNELS[product] || [];
}

export function getChannelLabel(channel: Channel): string {
  return CHANNEL_LABELS[channel] || channel;
}

export function getFrequencyLabel(frequency: string | null): string {
  return FREQUENCY_LABELS[frequency || ''] || 'по расписанию';
}

export function getFrequencyHours(frequency: string | null): number {
  return FREQUENCY_HOURS[frequency || ''] || 1;
}

export function defaultEnabledForProduct(product: Product, channel: Channel): boolean {
  // Дефолты, идентичные старой схеме notification_settings
  switch (product) {
    case 'digest':
      return channel === 'telegram'; // tg_digest_enabled DEFAULT TRUE в старой схеме
    case 'weekly_report':
      return channel === 'telegram' || channel === 'email';
    case 'fact_check':
      return channel === 'telegram' || channel === 'email';
    case 'news_alert':
      return false;
    case 'billing':
      return channel === 'email'; // transactional email всегда включён
    case 'engagement':
      return false;
    default:
      return false;
  }
}

export function defaultFrequencyForProduct(product: Product): string | null {
  return product === 'digest' ? DEFAULT_DIGEST_FREQUENCY : null;
}

export function isTransactionalProduct(product: Product): boolean {
  return product === 'billing';
}

export function isEventDrivenProduct(product: Product): boolean {
  return product === 'fact_check' || product === 'news_alert' || product === 'engagement' || product === 'billing';
}

export function isScheduledProduct(product: Product): boolean {
  return product === 'digest' || product === 'weekly_report';
}

export function requiresPortfolio(product: Product): boolean {
  return product === 'digest' || product === 'weekly_report' || product === 'news_alert';
}

export function isPaidOnlyProduct(product: Product): boolean {
  return product === 'weekly_report';
}
