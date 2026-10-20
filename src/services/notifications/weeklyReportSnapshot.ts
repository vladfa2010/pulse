/**
 * PULSE — Снапшоты еженедельного отчёта + magic-токены доступа (ТЗ-191, Задача 1/3).
 *
 * Снапшот, а не пересчёт: завершённый отчёт генерируется один раз (воскресенье
 * 11:00 МСК), сохраняется в weekly_reports и навсегда показывается как был.
 * Открытие архива — чистое чтение: ни агрегаций к news, ни LLM-вызовов.
 *
 * Magic-link (?k=): один токен на отчёт, crypto.randomBytes(24) (192 бита),
 * в БД только SHA-256 хэш, срок 7 дней, last_used_at — throttled (≤1 раза в час).
 * Plaintext нигде не хранится: фаза отправки (13:00) перевыпускает токен
 * (upsert той же строки) и использует plaintext для ссылки в письме (Задача 5).
 */

import crypto from 'crypto';
import { query } from '../../config/db';
import { nowSql } from '../../utils/nowSql';
import { WeeklyReportContent } from './weeklyReportContent';
import { WeeklyAISummaries } from './weeklySummaryAI';
import { weekStartMskDate } from './weeklyStats';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const TOKEN_TTL_DAYS = 7;
const SHA256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface WeeklySnapshotPayload {
  content: WeeklyReportContent;
  ai: WeeklyAISummaries | null;
}

export interface WeeklyReportSnapshot {
  id: string;
  userId: string;
  /** YYYY-MM-DD понедельника отчётной недели (МСК) */
  weekStart: string;
  content: WeeklyReportContent;
  ai: WeeklyAISummaries | null;
  createdAt: any;
  updatedAt: any;
  sentAt: any;
}

/** События тега из payload снапшота — источник news_markers недельного графика */
export interface WeeklyTagEvent {
  published_at: string;
  title: string;
  sentiment: string;
  url: string;
  source: string;
}

/** Архивная строка списка (без полного payload) */
export interface WeeklyReportListItem {
  id: string;
  week_start: string;
  totalArticles: number;
  topTagName: string | null;
}

function parsePayload(raw: any): WeeklySnapshotPayload | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || !parsed.content) return null;
    return parsed as WeeklySnapshotPayload;
  } catch {
    return null;
  }
}

function mapRow(row: any): WeeklyReportSnapshot | null {
  const payload = parsePayload(row.payload);
  if (!payload) return null;
  const weekStart = typeof row.week_start === 'string'
    ? row.week_start.slice(0, 10)
    : new Date(row.week_start).toISOString().slice(0, 10);
  return {
    id: row.id,
    userId: row.user_id,
    weekStart,
    content: payload.content,
    ai: payload.ai ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at ?? null,
  };
}

// ── Снапшоты ────────────────────────────────────────────────────────────────

/**
 * Upsert по (user_id, week_start): повторная генерация в ту же неделю
 * обновляет payload, id сохраняется (ТЗ-191 решение 4).
 */
export async function saveWeeklyReportSnapshot(
  userId: string,
  content: WeeklyReportContent,
  ai: WeeklyAISummaries | null
): Promise<{ id: string; created: boolean }> {
  const weekStart = weekStartMskDate();
  const payload = JSON.stringify({ content, ai });

  const existing = await query(
    `SELECT id FROM weekly_reports WHERE user_id = $1 AND week_start = $2`,
    [userId, weekStart]
  );
  if (existing.rows.length > 0) {
    await query(
      `UPDATE weekly_reports SET payload = $3, updated_at = ${nowSql()} WHERE id = $1`,
      [existing.rows[0].id, weekStart, payload]
    );
    return { id: existing.rows[0].id, created: false };
  }

  const id = crypto.randomUUID();
  await query(
    `INSERT INTO weekly_reports (id, user_id, week_start, payload, created_at, updated_at)
     VALUES ($1, $2, $3, $4, ${nowSql()}, ${nowSql()})`,
    [id, userId, weekStart, payload]
  );
  return { id, created: true };
}

/** Снапшот по id (БЕЗ проверки доступа — она в routes/reports.ts, Задача 3) */
export async function getWeeklyReportSnapshot(reportId: string): Promise<WeeklyReportSnapshot | null> {
  const result = await query(
    `SELECT id, user_id, week_start, payload, created_at, updated_at, sent_at
     FROM weekly_reports WHERE id = $1`,
    [reportId]
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

/** Снапшот юзера за текущую неделю (фаза отправки 13:00, live→архив редирект) */
export async function getCurrentWeekSnapshot(userId: string): Promise<WeeklyReportSnapshot | null> {
  const result = await query(
    `SELECT id, user_id, week_start, payload, created_at, updated_at, sent_at
     FROM weekly_reports WHERE user_id = $1 AND week_start = $2`,
    [userId, weekStartMskDate()]
  );
  if (result.rows.length === 0) return null;
  return mapRow(result.rows[0]);
}

/** Архив юзера: ≤12 свежих недель, метаданные из payload без полного чтения тел */
export async function listWeeklyReports(userId: string, limit = 12): Promise<WeeklyReportListItem[]> {
  const result = await query(
    `SELECT id, week_start, payload FROM weekly_reports
     WHERE user_id = $1 ORDER BY week_start DESC LIMIT $2`,
    [userId, limit]
  );
  const items: WeeklyReportListItem[] = [];
  for (const row of result.rows) {
    const payload = parsePayload(row.payload);
    const content = payload?.content;
    const weekStart = typeof row.week_start === 'string'
      ? row.week_start.slice(0, 10)
      : new Date(row.week_start).toISOString().slice(0, 10);
    let topTagName: string | null = null;
    if (content?.stats) {
      const sorted = [...content.stats.perTag].sort((a, b) =>
        b.current - a.current || b.prevWeek - a.prevWeek || a.tagName.localeCompare(b.tagName)
      );
      topTagName = sorted[0]?.tagName ?? null;
    }
    if (!topTagName && content && content.tagSummaries.length > 0) {
      topTagName = content.tagSummaries[0].tagName;
    }
    items.push({
      id: row.id,
      week_start: weekStart,
      totalArticles: content?.totalArticles ?? 0,
      topTagName,
    });
  }
  return items;
}

/** Маппинг tagSummaries[].articles в события графика (отдельной таблицей не дублируем) */
export function getTagEventsFromSnapshot(snapshot: WeeklyReportSnapshot, tagId: string): WeeklyTagEvent[] {
  const tag = snapshot.content.tagSummaries.find((t) => t.tagId === tagId);
  if (!tag) return [];
  return tag.articles.map((a) => ({
    published_at: a.publishedAt instanceof Date ? a.publishedAt.toISOString() : String(a.publishedAt),
    title: a.title,
    sentiment: a.sentiment,
    url: a.url,
    source: a.source,
  }));
}

/** Гейт идемпотентной отправки: после успешного фан-аута (ТЗ-191 решение 3) */
export async function markSnapshotSent(reportId: string): Promise<void> {
  await query(
    `UPDATE weekly_reports SET sent_at = ${nowSql()} WHERE id = $1 AND sent_at IS NULL`,
    [reportId]
  );
}

// ── Magic-токены (только архив; live — сессия only) ─────────────────────────

const SQL_EXPIRES_AT = USE_SQLITE
  ? "datetime('now', '+7 days')"
  : `NOW() + INTERVAL '${TOKEN_TTL_DAYS} days'`;
const SQL_LAST_USED_THROTTLE = USE_SQLITE
  ? "datetime('now', '-1 hour')"
  : "NOW() - INTERVAL '1 hour'";

/**
 * Перевыпуск токена отчёта (одна строка на отчёт — UNIQUE(report_id)).
 * Возвращает plaintext — единственный момент, когда он существует:
 * фаза генерации вызывает один раз, фаза отправки (Задача 5) — чтобы
 * вставить ссылку в письмо/Telegram.
 */
export async function issueReportAccessToken(reportId: string): Promise<string> {
  const token = crypto.randomBytes(24).toString('hex'); // 192 бита энтропии
  const tokenHash = SHA256(token);
  await query(
    `INSERT INTO report_access_tokens (id, report_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, $3, ${SQL_EXPIRES_AT}, ${nowSql()})
     ON CONFLICT (report_id) DO UPDATE SET
       token_hash = $3,
       expires_at = ${SQL_EXPIRES_AT},
       last_used_at = NULL`,
    [crypto.randomUUID(), reportId, tokenHash]
  );
  return token;
}

/**
 * Проверка ?k=: SHA-256, привязка к отчёту, expires_at > now.
 * last_used_at обновляется throttled (≤1 раза в час) — аудит без write-шторма.
 */
export async function validateReportAccessToken(reportId: string, token: string): Promise<boolean> {
  if (!token || token.length > 128) return false;
  const result = await query(
    `SELECT id FROM report_access_tokens
     WHERE report_id = $1 AND token_hash = $2 AND expires_at > ${nowSql()}`,
    [reportId, SHA256(token)]
  );
  if (result.rows.length === 0) return false;
  await query(
    `UPDATE report_access_tokens SET last_used_at = ${nowSql()}
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < ${SQL_LAST_USED_THROTTLE})`,
    [result.rows[0].id]
  );
  return true;
}
