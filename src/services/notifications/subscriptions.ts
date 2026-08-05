/**
 * PULSE — Notification Subscriptions: CRUD над матрицей продукт×канал.
 * notification_subscriptions — единственный источник правды о подписках.
 */

import { query } from '../../config/db';
import { Product, Channel, Subscription, DeliveryTarget, FREQUENCY_HOURS, DEFAULT_QUIET_HOURS } from './types';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ── Чтение ──────────────────────────────────────────────────────────────────

export async function getUserSubscriptions(userId: string): Promise<Subscription[]> {
  const result = await query(
    `SELECT user_id, product, channel, enabled, frequency, last_sent_at
     FROM notification_subscriptions WHERE user_id = $1`,
    [userId]
  );
  return result.rows.map(mapRow);
}

export async function getEnabledSubscriptions(
  userId: string,
  product: Product
): Promise<Subscription[]> {
  const result = await query(
    `SELECT user_id, product, channel, enabled, frequency, last_sent_at
     FROM notification_subscriptions
     WHERE user_id = $1 AND product = $2 AND enabled = TRUE`,
    [userId, product]
  );
  return result.rows.map(mapRow);
}

export async function getSubscription(
  userId: string,
  product: Product,
  channel: Channel
): Promise<Subscription | null> {
  const result = await query(
    `SELECT user_id, product, channel, enabled, frequency, last_sent_at
     FROM notification_subscriptions
     WHERE user_id = $1 AND product = $2 AND channel = $3`,
    [userId, product, channel]
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

// ── Запись ──────────────────────────────────────────────────────────────────

export async function setSubscription(
  userId: string,
  product: Product,
  channel: Channel,
  patch: { enabled?: boolean; frequency?: string }
): Promise<void> {
  // UPSERT: строка появляется при первом включении
  // ВАЖНО: INSERT требует NOT NULL enabled → COALESCE($4, FALSE) только для вставки;
  // UPDATE использует COALESCE($4, enabled) → frequency-only вызов не сбрасывает enabled.
  if (USE_SQLITE) {
    await query(
      `INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, 0), $5, datetime('now'))
       ON CONFLICT (user_id, product, channel) DO UPDATE SET
         enabled = COALESCE($4, enabled),
         frequency = COALESCE($5, frequency),
         updated_at = datetime('now')`,
      [userId, product, channel, patch.enabled ?? null, patch.frequency ?? null]
    );
  } else {
    await query(
      `INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency, updated_at)
       VALUES ($1, $2, $3, COALESCE($4, FALSE), $5, NOW())
       ON CONFLICT (user_id, product, channel) DO UPDATE SET
         enabled = COALESCE($4, notification_subscriptions.enabled),
         frequency = COALESCE($5, notification_subscriptions.frequency),
         updated_at = NOW()`,
      [userId, product, channel, patch.enabled ?? null, patch.frequency ?? null]
    );
  }

  // Переходный sync: фронт/внутренние сервисы ещё читают старую колонку push_enabled
  if (channel === 'push' && patch.enabled !== undefined) {
    if (USE_SQLITE) {
      await query(
        `INSERT INTO notification_settings (user_id, push_enabled)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET push_enabled = $2`,
        [userId, patch.enabled ? 1 : 0]
      );
    } else {
      await query(
        `INSERT INTO notification_settings (user_id, push_enabled)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET push_enabled = $2`,
        [userId, patch.enabled]
      );
    }
  }
}

/** DB-обёртка для включения/выключения дайджеста в канале (перенесена из digest.ts, TZ-10b). */
export function setDigestEnabled(
  userId: string,
  channel: 'telegram' | 'email' | 'push',
  enabled: boolean
) {
  return setSubscription(userId, 'digest', channel, { enabled });
}

export async function setSubscriptionsBatch(
  userId: string,
  patches: { product: Product; channel: Channel; enabled?: boolean; frequency?: string }[]
): Promise<void> {
  for (const patch of patches) {
    await setSubscription(userId, patch.product, patch.channel, {
      enabled: patch.enabled,
      frequency: patch.frequency,
    });
  }
}

export async function ensureDefaultSubscriptions(userId: string): Promise<void> {
  // Дефолты, идентичные старой схеме notification_settings
  const defaults: { product: Product; channel: Channel; enabled: boolean; frequency?: string }[] = [
    { product: 'digest', channel: 'telegram', enabled: false, frequency: '1h' },
    { product: 'digest', channel: 'email', enabled: false, frequency: '1h' },
    { product: 'digest', channel: 'push', enabled: false, frequency: '1h' },
    { product: 'weekly_report', channel: 'telegram', enabled: true },
    { product: 'weekly_report', channel: 'email', enabled: true },
    { product: 'weekly_report', channel: 'push', enabled: false },
    { product: 'fact_check', channel: 'telegram', enabled: true },
    { product: 'fact_check', channel: 'email', enabled: true },
    { product: 'news_alert', channel: 'push', enabled: false },
    { product: 'billing', channel: 'email', enabled: true },
    { product: 'billing', channel: 'push', enabled: true },
    { product: 'engagement', channel: 'push', enabled: false },
  ];

  for (const d of defaults) {
    // Сидинг ТОЛЬКО отсутствующих строк: DO NOTHING при конфликте —
    // существующие значения юзера никогда не перезаписываются.
    // НЕ через setSubscription: его UPSERT с COALESCE($4, enabled)
    // затирает выбор юзера дефолтом на каждый GET.
    if (USE_SQLITE) {
      await query(
        `INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, datetime('now'), datetime('now'))
         ON CONFLICT (user_id, product, channel) DO NOTHING`,
        [userId, d.product, d.channel, d.enabled ? 1 : 0, d.frequency ?? null]
      );
    } else {
      await query(
        `INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (user_id, product, channel) DO NOTHING`,
        [userId, d.product, d.channel, d.enabled, d.frequency ?? null]
      );
    }
  }
}

export async function markSent(
  userId: string,
  product: Product,
  channel: Channel
): Promise<void> {
  await query(
    `UPDATE notification_subscriptions
     SET last_sent_at = ${USE_SQLITE ? "datetime('now')" : 'NOW()'}
     WHERE user_id = $1 AND product = $2 AND channel = $3`,
    [userId, product, channel]
  );
}

export async function markSentBatch(
  userId: string,
  product: Product,
  channels: Channel[]
): Promise<void> {
  for (const channel of channels) {
    await markSent(userId, product, channel);
  }
}

// ── Выборка получателей для рассылки ────────────────────────────────────────
// ВАЖНО: здесь НЕТ фильтра subscription_active — тариф проверяет диспетчер
// через getEntitlement(). Так у всех продуктов одна политика.

export interface Recipient {
  userId: string;
  subscriptions: Subscription[];
}

export async function getRecipients(product: Product): Promise<Recipient[]> {
  const result = await query(
    `SELECT ns.user_id, ns.channel, ns.enabled, ns.frequency, ns.last_sent_at
     FROM notification_subscriptions ns
     WHERE ns.product = $1
       AND ns.enabled = TRUE
       -- у юзера есть активный канал доставки этого типа
       -- (email — неявный канал: адрес регистрации есть у каждого;
       --  push — FCM user_channels ИЛИ VAPID push_subscriptions)
       AND (ns.channel = 'email' OR EXISTS (
         SELECT 1 FROM user_channels uc
         WHERE uc.user_id = ns.user_id AND uc.channel = ns.channel AND uc.is_active = TRUE
       ) OR (ns.channel = 'push' AND EXISTS (
         SELECT 1 FROM push_subscriptions ps
         WHERE ps.user_id = ns.user_id AND ps.is_active = TRUE
       )))
       -- для теговых продуктов нужен хотя бы один активный (не frozen) тег
       AND ($2 IN ('fact_check', 'billing', 'engagement') OR EXISTS (
         SELECT 1 FROM portfolios p WHERE p.user_id = ns.user_id AND p.is_frozen = FALSE LIMIT 1
       ))`,
    [product, product]
  );

  const byUser = new Map<string, Subscription[]>();
  for (const row of result.rows) {
    const sub = mapRow({ ...row, user_id: row.user_id, product });
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id)!.push(sub);
  }
  return [...byUser.entries()].map(([userId, subscriptions]) => ({ userId, subscriptions }));
}

// ── Каналы доставки ─────────────────────────────────────────────────────────

export async function getDeliveryTarget(
  userId: string,
  channel: Channel,
  product?: Product
): Promise<DeliveryTarget | null> {
  // Email — неявный канал: он есть у каждого юзера по определению.
  // Адрес доставки: digest_email (override для дайджеста) → email из регистрации.
  if (channel === 'email') {
    const result = await query(
      `SELECT u.email AS account_email, ns.digest_email
       FROM users u
       LEFT JOIN notification_settings ns ON ns.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );
    if (result.rows.length === 0) return null;
    const { account_email, digest_email } = result.rows[0];
    if (product === 'digest' && digest_email) return { channel, target: digest_email };
    return account_email ? { channel, target: account_email } : null;
  }

  // Push — ДВЕ транспортные системы: FCM (user_channels) и VAPID web push
  // (таблица push_subscriptions). Канал считается подключённым, если есть хотя бы одна.
  if (channel === 'push') {
    const fcm = await query(
      `SELECT target FROM user_channels
       WHERE user_id = $1 AND channel = 'push' AND is_active = TRUE`,
      [userId]
    );
    if (fcm.rows.length > 0) return { channel, target: fcm.rows[0].target };
    const vapid = await query(
      `SELECT endpoint FROM push_subscriptions
       WHERE user_id = $1 AND is_active = TRUE LIMIT 1`,
      [userId]
    );
    if (vapid.rows.length > 0) return { channel, target: vapid.rows[0].endpoint };
    return null;
  }

  // Telegram — явный канал, нужна активная строка в user_channels
  const result = await query(
    `SELECT target FROM user_channels
     WHERE user_id = $1 AND channel = $2 AND is_active = TRUE`,
    [userId, channel]
  );
  if (result.rows.length === 0) return null;
  return { channel, target: result.rows[0].target };
}

// ── Частота и тихие часы ────────────────────────────────────────────────────

export function isDueByFrequency(sub: Subscription, now: Date = new Date()): boolean {
  if (!sub.frequency) return true; // продукты без частоты — всегда due
  if (!sub.lastSentAt) return true;
  const freqHours = FREQUENCY_HOURS[sub.frequency] ?? 1;
  const hoursSince = (now.getTime() - sub.lastSentAt.getTime()) / 3600000;
  return hoursSince >= freqHours;
}

export async function getQuietHours(userId: string): Promise<
  { enabled: boolean; start: string; end: string } | null
> {
  const result = await query(
    `SELECT quiet_hours_enabled, quiet_hours_start, quiet_hours_end
     FROM notification_settings WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  // Юзер без строки настроек (legacy) — применяем дефолт схемы, как у всех остальных.
  // Иначе одни юзеры с тихими часами, другие без — недетерминированное поведение.
  if (!row) return { ...DEFAULT_QUIET_HOURS };
  return {
    enabled: !!row.quiet_hours_enabled,
    start: row.quiet_hours_start || '22:00',
    end: row.quiet_hours_end || '08:00',
  };
}

export async function setQuietHours(
  userId: string,
  quietHours: { enabled?: boolean; start?: string; end?: string }
): Promise<void> {
  if (USE_SQLITE) {
    await query(
      `INSERT INTO notification_settings (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, updated_at)
       VALUES ($1, COALESCE($2, 1), COALESCE($3, '22:00'), COALESCE($4, '08:00'), datetime('now'))
       ON CONFLICT (user_id) DO UPDATE SET
         quiet_hours_enabled = COALESCE($2, quiet_hours_enabled),
         quiet_hours_start = COALESCE($3, quiet_hours_start),
         quiet_hours_end = COALESCE($4, quiet_hours_end),
         updated_at = datetime('now')`,
      [userId, quietHours.enabled ?? null, quietHours.start ?? null, quietHours.end ?? null]
    );
  } else {
    await query(
      `INSERT INTO notification_settings (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, updated_at)
       VALUES ($1, COALESCE($2, TRUE), COALESCE($3, '22:00'), COALESCE($4, '08:00'), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         quiet_hours_enabled = COALESCE($2, notification_settings.quiet_hours_enabled),
         quiet_hours_start = COALESCE($3, notification_settings.quiet_hours_start),
         quiet_hours_end = COALESCE($4, notification_settings.quiet_hours_end),
         updated_at = NOW()`,
      [userId, quietHours.enabled ?? null, quietHours.start ?? null, quietHours.end ?? null]
    );
  }
}

export async function ensureNotificationSettings(userId: string): Promise<void> {
  // Гарантируем, что у юзера есть строка notification_settings (для тихих часов и т.д.)
  if (USE_SQLITE) {
    await query(
      `INSERT INTO notification_settings (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end)
       VALUES ($1, 1, '22:00', '08:00')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
  } else {
    await query(
      `INSERT INTO notification_settings (user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end)
       VALUES ($1, TRUE, '22:00', '08:00')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function mapRow(row: any): Subscription {
  return {
    userId: row.user_id,
    product: row.product,
    channel: row.channel,
    enabled: !!row.enabled,
    frequency: row.frequency ?? null,
    lastSentAt: row.last_sent_at ? new Date(row.last_sent_at) : null,
  };
}

export { mapRow as _mapRowForTests };
