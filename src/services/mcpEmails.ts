/**
 * =============================================================================
 * PULSE — MCP: email-уведомления по токенам (ТЗ-183 ИБ-10 / ТЗ-185 Задача 3)
 * =============================================================================
 *
 * Уведомления: создание токена, первое использование (детектор компрометации),
 * напоминание о ротации (за 7 дней до expires_at), принудительный отзыв админом.
 * Quiet hours юзера учитываются (isQuietHours) — письмо не шлём в тихие часы,
 * ротационное напоминание можно слать позже той же джобой.
 */

import { query } from '../config/db';
import { sendEmail, isQuietHours } from './email';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function userEmail(userId: string): Promise<{ email: string; username: string } | null> {
  const r = await query('SELECT email, username FROM users WHERE id = $1', [userId]);
  const row = r.rows[0];
  return row ? { email: row.email, username: row.username } : null;
}

async function deliver(userId: string, subject: string, html: string): Promise<boolean> {
  if (await isQuietHours(userId)) return false;
  const u = await userEmail(userId);
  if (!u) return false;
  return sendEmail(u.email, subject, html);
}

/** Токен создан (ИБ-10): название, время, IP создания */
export async function sendMcpTokenCreatedEmail(userId: string, name: string, ip: string | null): Promise<boolean> {
  return deliver(
    userId,
    'PULSE: создан MCP-токен',
    `<p>Для вашего аккаунта создан MCP-токен <b>«${esc(name)}»</b>.</p>` +
      `<p>Время: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК` +
      (ip ? `, IP: ${esc(ip)}` : '') + `.</p>` +
      `<p>Токен действует 180 дней. Если это были не вы — отзовите токен в личном кабинете (раздел «API / MCP») и смените пароль.</p>`,
  );
}

/** Первое использование токена (ИБ-10, детектор компрометации) */
export async function sendMcpFirstUseEmail(userId: string, tokenName: string): Promise<boolean> {
  return deliver(
    userId,
    'PULSE: MCP-токен использован впервые',
    `<p>MCP-токен <b>«${esc(tokenName)}»</b> впервые использован для доступа к данным Пульса.</p>` +
      `<p>Если вы не подключали MCP-клиент — отзовите токен в личном кабинете (раздел «API / MCP») и смените пароль.</p>`,
  );
}

/** Напоминание о ротации: expires_at в окне 7 дней (ИБ-1) */
export async function sendMcpRotationReminderEmail(
  userId: string,
  tokenName: string,
  expiresAt: string,
): Promise<boolean> {
  return deliver(
    userId,
    'PULSE: истекает срок действия MCP-токена',
    `<p>Срок действия MCP-токена <b>«${esc(tokenName)}»</b> истекает ${esc(expiresAt)}.</p>` +
      `<p>Создайте новый токен в личном кабинете (раздел «API / MCP»), пока старый работает — клиенту не придётся ждать.</p>`,
  );
}

/** Принудительный отзыв админом (ТЗ-185): юзер узнаёт мгновенно */
export async function sendMcpRevokedByAdminEmail(userId: string, tokenName: string): Promise<boolean> {
  return deliver(
    userId,
    'PULSE: MCP-токен отозван администратором',
    `<p>MCP-токен <b>«${esc(tokenName)}»</b> отозван администратором платформы.</p>` +
      `<p>Клиент с этим токеном сразу потерял доступ. Если это были не вы — смените пароль и отзовите остальные токены в личном кабинете (раздел «API / MCP»).</p>`,
  );
}
