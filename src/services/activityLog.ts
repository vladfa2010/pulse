/**
 * =============================================================================
 * PULSE — Activity Log Service
 * =============================================================================
 *
 * Единая точка для логирования пользовательских событий в user_events.
 * Все функции обёрнуты в try/catch — лог НЕ ломает основной flow.
 */

import { query } from '../config/db';
import { notifyAdmins } from './adminAlerts';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

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
  'sentiment_vote',
] as const;

export type UserEventType = typeof USER_EVENT_TYPES[number];

export function isUserEventType(value: string): value is UserEventType {
  return USER_EVENT_TYPES.includes(value as UserEventType);
}

/**
 * Записать событие пользователя в лог.
 * Не пробрасывает ошибки — silently fail.
 */
export async function logUserEvent(
  userId: string,
  eventType: UserEventType,
  eventData: Record<string, any> = {}
): Promise<void> {
  try {
    const dataJson = USE_SQLITE ? JSON.stringify(eventData) : eventData;
    await query(
      `INSERT INTO user_events (user_id, event_type, event_data)
       VALUES ($1, $2, $3)`,
      [userId, eventType, dataJson]
    );

    // Отправляем TG-алерты админам асинхронно (не ждём)
    notifyAdmins(eventType, eventData, userId).catch(() => {});
  } catch (err) {
    console.error('[ActivityLog] Failed to log event:', eventType, 'for user', userId, err);
  }
}

// ─── Типизированные хелперы ───────────────────────────────────────────────

export async function logRegister(userId: string, email: string, username: string): Promise<void> {
  return logUserEvent(userId, 'register', { email, username });
}

export async function logLogin(userId: string, email: string): Promise<void> {
  return logUserEvent(userId, 'login', { email });
}

export async function logForgotPassword(userId: string, email: string): Promise<void> {
  return logUserEvent(userId, 'forgot_password', { email });
}

export async function logPasswordReset(userId: string, email: string): Promise<void> {
  return logUserEvent(userId, 'password_reset', { email });
}

export async function logTagAdded(
  userId: string,
  tagId: string,
  tagName: string,
  tagType: string
): Promise<void> {
  return logUserEvent(userId, 'tag_added', { tag_id: tagId, tag_name: tagName, tag_type: tagType });
}

export async function logTagRemoved(userId: string, tagId: string, tagName: string): Promise<void> {
  return logUserEvent(userId, 'tag_removed', { tag_id: tagId, tag_name: tagName });
}

export async function logPaymentCompleted(
  userId: string,
  amount: number,
  planId: string,
  method: string
): Promise<void> {
  return logUserEvent(userId, 'payment_completed', { amount, plan_id: planId, method });
}

export async function logSubscriptionActivated(userId: string, planId: string, expiresAt: string): Promise<void> {
  return logUserEvent(userId, 'subscription_activated', { plan_id: planId, expires_at: expiresAt });
}

export async function logSubscriptionCancelled(userId: string, planId: string): Promise<void> {
  return logUserEvent(userId, 'subscription_cancelled', { plan_id: planId });
}

export async function logChannelConnected(userId: string, channel: string, target: string): Promise<void> {
  return logUserEvent(userId, 'channel_connected', { channel, target });
}

export async function logChannelDisconnected(userId: string, channel: string, target: string): Promise<void> {
  return logUserEvent(userId, 'channel_disconnected', { channel, target });
}

export async function logSentimentVote(
  userId: string,
  voteValue: number,
  indexAtVote: number
): Promise<void> {
  return logUserEvent(userId, 'sentiment_vote', { vote_value: voteValue, index_at_vote: indexAtVote });
}
