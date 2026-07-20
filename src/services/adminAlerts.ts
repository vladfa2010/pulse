/**
 * =============================================================================
 * PULSE — Admin Telegram Alerts Service
 * =============================================================================
 *
 * Управляет настройками TG-уведомлений админов и рассылает алерты
 * при событиях пользователей (register, payment, sentiment_vote и т.д.).
 *
 * Все операции не ломают основной flow — ошибки логируются и игнорируются.
 */

import { query } from '../config/db';
import { sendTelegramMessage } from './telegram';
import { UserEventType } from './activityLog';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export const ALERT_EVENT_TYPES: { value: UserEventType | 'sentiment_vote'; label: string }[] = [
  { value: 'register', label: 'Регистрация' },
  { value: 'login', label: 'Вход' },
  { value: 'forgot_password', label: 'Забыли пароль' },
  { value: 'password_reset', label: 'Сброс пароля' },
  { value: 'tag_added', label: 'Добавлен тег' },
  { value: 'tag_removed', label: 'Удалён тег' },
  { value: 'payment_completed', label: 'Оплата' },
  { value: 'subscription_activated', label: 'Подписка активирована' },
  { value: 'subscription_cancelled', label: 'Подписка отменена' },
  { value: 'channel_connected', label: 'Канал подключён' },
  { value: 'channel_disconnected', label: 'Канал отключён' },
  { value: 'sentiment_vote', label: 'Прогноз индекса (голос)' },
  { value: 'page_view_plans', label: 'Просмотр тарифов' },
  { value: 'factcheck_ordered', label: 'Заказан фактчек' },
];

export interface AdminTgSettings {
  id: string;
  admin_user_id: string;
  tg_chat_id: string;
  event_types: UserEventType[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

interface UserMini {
  id: string;
  email: string;
  username: string;
}

async function getUserMini(userId: string): Promise<UserMini | null> {
  try {
    const result = await query(
      `SELECT id, email, username FROM users WHERE id = $1`,
      [userId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
  } catch (err) {
    console.error('[AdminAlerts] getUserMini failed:', err);
    return null;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAlert(eventType: UserEventType, user: UserMini | null, data: Record<string, any>): string {
  const userLine = user
    ? `👤 <b>Пользователь:</b> ${escapeHtml(user.username || user.email || user.id)}\n   📧 ${escapeHtml(user.email)}\n   🆔 <code>${user.id}</code>`
    : `👤 <b>Пользователь:</b> <code>${data.user_id || 'unknown'}</code>`;

  const typeLabel = ALERT_EVENT_TYPES.find(t => t.value === eventType)?.label || eventType;
  let details = '';

  switch (eventType) {
    case 'register':
      details = `📧 Email: ${escapeHtml(data.email || '')}`;
      break;
    case 'payment_completed':
      details = `💰 Сумма: ${data.amount || '?'}\n📦 План: ${escapeHtml(data.plan_id || '')}\n💳 Способ: ${escapeHtml(data.method || '')}`;
      break;
    case 'subscription_activated':
      details = `📦 План: ${escapeHtml(data.plan_id || '')}\n⏳ До: ${escapeHtml(data.expires_at || '')}`;
      break;
    case 'subscription_cancelled':
      details = `📦 План: ${escapeHtml(data.plan_id || '')}`;
      break;
    case 'tag_added':
      details = `🏷 Тег: ${escapeHtml(data.tag_name || '')}\n📁 Тип: ${escapeHtml(data.tag_type || '')}\n🆔 ID: <code>${escapeHtml(data.tag_id || '')}</code>`;
      break;
    case 'tag_removed':
      details = `🏷 Тег: ${escapeHtml(data.tag_name || '')}\n🆔 ID: <code>${escapeHtml(data.tag_id || '')}</code>`;
      break;
    case 'sentiment_vote':
      details = `📊 Голос: <b>${data.vote_value === 1 ? '🟢 Рост' : data.vote_value === -1 ? '🔴 Падение' : '⚪ Нейтрально'}</b>\n📈 Индекс: ${data.index_at_vote ?? '?'}`;
      break;
    case 'channel_connected':
    case 'channel_disconnected':
      details = `🔌 Канал: ${escapeHtml(data.channel || '')}\n🎯 Цель: ${escapeHtml(data.target || '')}`;
      break;
    case 'page_view_plans':
      details = `📄 Страница: тарифы`;
      break;
    case 'factcheck_ordered':
      details = `🔍 Запрос: ${escapeHtml(data.query || '')}`;
      break;
    default:
      details = Object.entries(data)
        .filter(([key]) => key !== 'user_id')
        .map(([key, value]) => `${escapeHtml(key)}: ${typeof value === 'string' ? escapeHtml(value) : JSON.stringify(value)}`)
        .join('\n');
  }

  return `🔔 <b>${escapeHtml(typeLabel)}</b>\n\n${userLine}\n\n${details}`;
}

/**
 * Получить настройки TG-алертов для админа.
 */
function parseEventTypes(raw: any): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return raw ? [raw] : [];
    }
  }
  return [];
}

export async function getAdminTgSettings(adminUserId: string): Promise<AdminTgSettings | null> {
  try {
    const result = await query(
      `SELECT * FROM admin_tg_settings WHERE admin_user_id = $1`,
      [adminUserId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    row.event_types = parseEventTypes(row.event_types);
    return row;
  } catch (err) {
    console.error('[AdminAlerts] getAdminTgSettings failed:', err);
    return null;
  }
}

/**
 * Сохранить настройки TG-алертов админа.
 */
export async function saveAdminTgSettings(
  adminUserId: string,
  tgChatId: string,
  eventTypes: UserEventType[],
  isActive: boolean
): Promise<AdminTgSettings | null> {
  try {
    const chatId = tgChatId.trim();
    const types = eventTypes.filter(t => ALERT_EVENT_TYPES.some(a => a.value === t));
    const existing = await query(
      `SELECT id FROM admin_tg_settings WHERE admin_user_id = $1`,
      [adminUserId]
    );

    if (existing.rows.length > 0) {
      const result = await query(
        `UPDATE admin_tg_settings
         SET tg_chat_id = $1, event_types = $2, is_active = $3, updated_at = ${USE_SQLITE ? "datetime('now')" : 'NOW()'}
         WHERE admin_user_id = $4
         RETURNING *`,
        [chatId, types, isActive, adminUserId]
      );
      return result.rows[0];
    }

    const result = await query(
      `INSERT INTO admin_tg_settings (admin_user_id, tg_chat_id, event_types, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [adminUserId, chatId, types, isActive]
    );
    return result.rows[0];
  } catch (err) {
    console.error('[AdminAlerts] saveAdminTgSettings failed:', err);
    return null;
  }
}

/**
 * Отправить тестовый алерт админу.
 */
export async function sendTestAlert(adminUserId: string, chatId: string): Promise<boolean> {
  const text = `🧪 <b>Тестовое уведомление Pulse</b>\n\nЕсли вы видите это сообщение, настройки TG-алертов работают корректно.`;
  const ok = await sendTelegramMessage(chatId, text);
  if (ok) {
    await saveAdminTgSettings(adminUserId, chatId, [], true);
  }
  return ok;
}

/**
 * Разослать алерты всем активным админам, подписанным на данный eventType.
 */
export async function notifyAdmins(
  eventType: UserEventType,
  eventData: Record<string, any>,
  userId?: string
): Promise<void> {
  try {
    const settingsResult = await query(
      `SELECT admin_user_id, tg_chat_id, event_types
       FROM admin_tg_settings
       WHERE is_active = TRUE AND tg_chat_id IS NOT NULL AND tg_chat_id <> ''`,
      []
    );

    if (settingsResult.rows.length === 0) return;

    const user = userId ? await getUserMini(userId) : null;
    const text = formatAlert(eventType, user, { ...eventData, user_id: userId });

    for (const row of settingsResult.rows) {
      try {
        const types = parseEventTypes(row.event_types);
        if (!types.includes(eventType)) continue;
        await sendTelegramMessage(row.tg_chat_id, text);
      } catch (err) {
        console.error('[AdminAlerts] notifyAdmins per-row failed:', err);
      }
    }
  } catch (err) {
    console.error('[AdminAlerts] notifyAdmins failed:', err);
  }
}
