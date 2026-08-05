import { query } from '../config/db';

/**
 * PK lookup по id. Возвращает null, если юзер не найден
 * (call-site'ы сами решают про 404).
 */
export async function getUserId(userId: string): Promise<string | null> {
  const result = await query(`SELECT id FROM users WHERE id = $1`, [userId]);
  return result.rows[0]?.id ?? null;
}

/**
 * Получить subscription_plan юзера. null, если юзер не найден.
 */
export async function getUserPlanId(userId: string): Promise<string | null> {
  const result = await query(`SELECT subscription_plan FROM users WHERE id = $1`, [userId]);
  return result.rows[0]?.subscription_plan ?? null;
}

/**
 * Получить subscription_active (boolean, нормализованный).
 * КРИТИЧНО: null = юзер не найден — отличаем от "неактивен",
 * иначе 404-ветка call-site'ов превращается в 403.
 */
export async function getUserSubscriptionActive(userId: string): Promise<boolean | null> {
  const result = await query(`SELECT subscription_active FROM users WHERE id = $1`, [userId]);
  if (result.rows.length === 0) return null;
  const v = result.rows[0].subscription_active;
  return v === true || v === 1;
}
