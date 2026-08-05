/**
 * PULSE — digest.ts (compat-слой)
 *
 * Вся логика переехала в services/notifications/. Этот файл сохраняет
 * старые экспорты, чтобы не трогать index.ts и webhook.ts в первом релизе.
 * После перевода вызовов — удалить.
 */

import { dispatchToUser, dispatchToUserNow, broadcastProduct } from './notifications/dispatcher';
import { startNotificationWorkers } from './notifications/workers';
import { setSubscription, ensureDefaultSubscriptions } from './notifications/subscriptions';
import { Product, Channel } from './notifications/types';

/** Плановая отправка TG-дайджеста одному юзеру (старое API) */
export async function sendDigestToUser(userId: string): Promise<'sent' | 'empty' | 'error'> {
  const result = await dispatchToUser(userId, 'digest');
  return result === 'sent' ? 'sent' : result === 'error' ? 'error' : 'empty';
}

/** Ручная /now — всегда в Telegram (как раньше) */
export async function sendDigestToUserNow(userId: string): Promise<'sent' | 'empty' | 'error'> {
  const result = await dispatchToUserNow(userId, 'digest', 'telegram');
  return result === 'sent' ? 'sent' : result === 'error' ? 'error' : 'empty';
}

/** Рассылка всем (старое API) */
export async function sendAllDigests(): Promise<void> {
  await broadcastProduct('digest');
}

/** Запуск кронов (старое API — index.ts вызывает startDigestCron) */
export function startDigestCron(): void {
  startNotificationWorkers();
}

// ── Хелперы для точек, которые включали/выключали tg_digest_enabled ─────────
// webhook.ts (start_digest/stop_digest), user.ts (telegram-disconnect),
// index.ts (Telegram Widget connect) — переводим их на эти функции:

export function setDigestFrequency(userId: string, channel: 'telegram' | 'email' | 'push', frequency: string) {
  return setSubscription(userId, 'digest', channel, { frequency });
}

export function setProductEnabled(
  userId: string,
  product: Product,
  channel: Channel,
  enabled: boolean
) {
  return setSubscription(userId, product, channel, { enabled });
}

export function ensureDefaultNotificationSubscriptions(userId: string): Promise<void> {
  return ensureDefaultSubscriptions(userId);
}

export { ensureDefaultSubscriptions, setDigestEnabled } from './notifications/subscriptions';
export { getEntitlement, isPremiumActive, isPremium } from './notifications/entitlement';
export { getQuietHours } from './notifications/subscriptions';
export { isQuietHoursMsk } from './notifications/quietHours';
export { getUserSubscriptions } from './notifications/subscriptions';
export type { Product, Channel, Subscription } from './notifications/types';

export { dispatchToUser, dispatchToUserNow, broadcastProduct } from './notifications/dispatcher';
export { startNotificationWorkers } from './notifications/workers';
