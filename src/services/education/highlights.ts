/**
 * =============================================================================
 * PULSE — LMS: выделения и заметки в уроках (ТЗ-237, сервис)
 * =============================================================================
 *
 * CRUD хайлайтов поверх lesson_highlights (lms_v13). Якорь — W3C
 * TextQuoteSelector (exact_text + prefix/suffix + pos_hint), разрешение —
 * на клиенте; сервер хранит и отдаёт. kind='hl' — заметки юзера (все ручки
 * этого файла); kind='share' (ТЗ-237 этап 2) в выборки НЕ попадает.
 *
 * Гейт записи — на уровне роута (checkLessonAccess → access.enrollment != null;
 * аудит ТЗ-237: НЕ «!blocked» — free-preview пускает не-записанных).
 * Чужой id → 404 (IDOR-прецедент logIdorBlocked). share_token — hex48
 * (прецедент lesson_shares, education.ts:1089), генерится при создании.
 */

import crypto from 'crypto';
import { query } from '../../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export interface HighlightRow {
  id: string;
  lesson_id: string;
  lesson_title: string;
  course_id: string;
  course_slug: string;
  course_title: string;
  exact_text: string;
  prefix: string | null;
  suffix: string | null;
  pos_hint: number | null;
  note: string | null;
  share_token: string | null;
  created_at: string;
}

const SELECT_JOINED = `
  SELECT h.id, h.lesson_id, cl.title AS lesson_title,
         c.id AS course_id, c.slug AS course_slug, c.title AS course_title,
         h.exact_text, h.prefix, h.suffix, h.pos_hint, h.note, h.share_token, h.created_at
  FROM lesson_highlights h
  JOIN course_lessons cl ON cl.id = h.lesson_id
  JOIN courses c ON c.id = cl.course_id`;

function mapRow(r: any): HighlightRow {
  return {
    id: String(r.id),
    lesson_id: String(r.lesson_id),
    lesson_title: r.lesson_title,
    course_id: String(r.course_id),
    course_slug: r.course_slug,
    course_title: r.course_title,
    exact_text: r.exact_text,
    prefix: r.prefix ?? null,
    suffix: r.suffix ?? null,
    pos_hint: r.pos_hint != null ? Number(r.pos_hint) : null,
    note: r.note ?? null,
    share_token: r.share_token ?? null,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

/** Список своих хайлайтов (kind='hl') с фильтрами и полным total (счётчик «Все заметки (N)»). */
export async function listHighlights(
  userId: string,
  filters: { lesson_id?: string; course_id?: string; limit: number; offset: number },
): Promise<{ items: HighlightRow[]; total: number }> {
  const conds = [`h.user_id = $1`, `h.kind = 'hl'`];
  const params: unknown[] = [userId];
  if (filters.lesson_id) { params.push(filters.lesson_id); conds.push(`h.lesson_id = $${params.length}`); }
  if (filters.course_id) { params.push(filters.course_id); conds.push(`cl.course_id = $${params.length}`); }
  const where = conds.join(' AND ');

  const items = await query(
    `${SELECT_JOINED} WHERE ${where} ORDER BY h.created_at DESC LIMIT ${filters.limit} OFFSET ${filters.offset}`,
    params,
  );
  const count = await query(
    `SELECT COUNT(*) AS count FROM lesson_highlights h
     JOIN course_lessons cl ON cl.id = h.lesson_id
     JOIN courses c ON c.id = cl.course_id
     WHERE ${where}`,
    params,
  );
  return { items: items.rows.map(mapRow), total: Number(count.rows[0]?.count ?? 0) };
}

export interface CreateHighlightInput {
  lesson_id: string;
  exact_text: string;
  prefix?: string | null;
  suffix?: string | null;
  pos_hint?: number | null;
  note?: string | null;
}

/** Создать хайлайт (kind='hl'). share_token — hex48 сразу (шеринг — этап 2, токен уже есть). */
export async function createHighlight(userId: string, input: CreateHighlightInput): Promise<HighlightRow> {
  const id = crypto.randomUUID();
  const shareToken = crypto.randomBytes(24).toString('hex');
  await query(
    `INSERT INTO lesson_highlights (id, user_id, lesson_id, exact_text, prefix, suffix, pos_hint, note, kind, share_token, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'hl', $9, ${USE_SQLITE ? "datetime('now')" : 'NOW()'})`,
    [
      id, userId, input.lesson_id, input.exact_text,
      input.prefix ?? null, input.suffix ?? null, input.pos_hint ?? null,
      input.note ?? null, shareToken,
    ],
  );
  const r = await query(`${SELECT_JOINED} WHERE h.id = $1`, [id]);
  return mapRow(r.rows[0]);
}

/** Обновить заметку (null/"" — удалить). Только владелец → иначе null (роут отдаст 404). */
export async function updateHighlightNote(userId: string, id: string, note: string | null): Promise<HighlightRow | null> {
  const own = await query(
    `SELECT id FROM lesson_highlights WHERE id = $1 AND user_id = $2 AND kind = 'hl'`,
    [id, userId],
  );
  if (own.rows.length === 0) return null;
  await query(`UPDATE lesson_highlights SET note = $1 WHERE id = $2`, [note || null, id]);
  const r = await query(`${SELECT_JOINED} WHERE h.id = $1`, [id]);
  return mapRow(r.rows[0]);
}

/** Удалить (владелец). Удаление строки = отзыв шеринга (токен умирает с записью). */
export async function deleteHighlight(userId: string, id: string): Promise<boolean> {
  const own = await query(
    `SELECT id FROM lesson_highlights WHERE id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (own.rows.length === 0) return false;
  await query(`DELETE FROM lesson_highlights WHERE id = $1`, [id]);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-237 этап 2 — шеринг цитат (/q/:token)
// ═══════════════════════════════════════════════════════════════════════════

/** share_url для существующего хайлайта владельца (kind='hl'); токен есть с
 *  создания, для старых записей без токена — догенерируем. null — не владелец. */
export async function getOwnedShareToken(userId: string, id: string): Promise<string | null> {
  const r = await query(
    `SELECT share_token FROM lesson_highlights WHERE id = $1 AND user_id = $2 AND kind = 'hl'`,
    [id, userId],
  );
  if (r.rows.length === 0) return null;
  let token = r.rows[0].share_token;
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    await query(`UPDATE lesson_highlights SET share_token = $1 WHERE id = $2`, [token, id]);
  }
  return token;
}

/** Шеринг без сохранения заметки (вариант B): kind='share' — в списках и
 *  дэйли-ревью не участвует, для /q/:token валиден наравне с 'hl'. */
export async function createQuoteShare(userId: string, input: CreateHighlightInput): Promise<string> {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString('hex');
  await query(
    `INSERT INTO lesson_highlights (id, user_id, lesson_id, exact_text, prefix, suffix, pos_hint, note, kind, share_token, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 'share', $8, ${USE_SQLITE ? "datetime('now')" : 'NOW()'})`,
    [id, userId, input.lesson_id, input.exact_text, input.prefix ?? null, input.suffix ?? null, input.pos_hint ?? null, token],
  );
  return token;
}

export interface ShareResolve {
  highlight_id: string;
  lesson_id: string;
  course_slug: string;
}

/** Резолв токена (любой kind) — для диплинка ?q= и страницы /q. */
export async function resolveShareToken(token: string): Promise<ShareResolve | null> {
  const r = await query(
    `SELECT h.id, h.lesson_id, c.slug AS course_slug
     FROM lesson_highlights h
     JOIN course_lessons cl ON cl.id = h.lesson_id
     JOIN courses c ON c.id = cl.course_id
     WHERE h.share_token = $1`,
    [token],
  );
  if (r.rows.length === 0) return null;
  return { highlight_id: String(r.rows[0].id), lesson_id: String(r.rows[0].lesson_id), course_slug: r.rows[0].course_slug };
}

export interface SharePageData {
  exact_text: string;
  course_title: string;
  course_slug: string;
  course_cover: string | null;
  lesson_id: string;
  highlight_id: string;
}

/** Данные публичной страницы /q/:token. PII автора в SELECT нет в принципе. */
export async function getSharePageData(token: string): Promise<SharePageData | null> {
  const r = await query(
    `SELECT h.id, h.exact_text, h.lesson_id, c.title AS course_title, c.slug AS course_slug, c.cover_url
     FROM lesson_highlights h
     JOIN course_lessons cl ON cl.id = h.lesson_id
     JOIN courses c ON c.id = cl.course_id
     WHERE h.share_token = $1`,
    [token],
  );
  if (r.rows.length === 0) return null;
  return {
    exact_text: r.rows[0].exact_text,
    course_title: r.rows[0].course_title,
    course_slug: r.rows[0].course_slug,
    course_cover: r.rows[0].cover_url ?? null,
    lesson_id: String(r.rows[0].lesson_id),
    highlight_id: String(r.rows[0].id),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-237 этап 3 — дэйли-ревью «Повторение выделений»
// ═══════════════════════════════════════════════════════════════════════════

export interface ReviewCard {
  id: string;
  exact_text: string;
  note: string | null;
  lesson_id: string;
  lesson_title: string;
  course_slug: string;
  /** Приёмка F5: название курса для мета-строки карточки (§2.9). */
  course_title: string;
}

/** Порог «сегодня» по МСК (бизнес-дата платформы). Без ::date в SQL —
 *  шим SQLite его не транслирует (техлид-ревью), сравнение параметром. */
function mskTodayStart(): Date {
  const mskNow = new Date(Date.now() + 3 * 3600 * 1000);
  return new Date(Date.UTC(mskNow.getUTCFullYear(), mskNow.getUTCMonth(), mskNow.getUTCDate()) - 3 * 3600 * 1000);
}

/** До 5 карточек на сегодня: самые давно не повторявшиеся первыми;
 *  просмотренные сегодня исключены. Только kind='hl'. */
export async function getReviewToday(userId: string): Promise<ReviewCard[]> {
  const threshold = mskTodayStart().toISOString();
  const r = await query(
    `SELECT h.id, h.exact_text, h.note, h.lesson_id, cl.title AS lesson_title, c.slug AS course_slug, c.title AS course_title
     FROM lesson_highlights h
     JOIN course_lessons cl ON cl.id = h.lesson_id
     JOIN courses c ON c.id = cl.course_id
     WHERE h.user_id = $1 AND h.kind = 'hl'
       AND (h.last_reviewed_at IS NULL OR h.last_reviewed_at < $2)
     ORDER BY COALESCE(h.last_reviewed_at, h.created_at) ASC
     LIMIT 5`,
    [userId, USE_SQLITE ? threshold.replace('T', ' ').slice(0, 19) : threshold],
  );
  return r.rows.map((x: any) => ({
    id: String(x.id),
    exact_text: x.exact_text,
    note: x.note ?? null,
    lesson_id: String(x.lesson_id),
    lesson_title: x.lesson_title,
    course_slug: x.course_slug,
    course_title: x.course_title,
  }));
}

/** «Помню» — last_reviewed_at = now. Идемпотентно; только владелец. */
export async function markReviewSeen(userId: string, highlightId: string): Promise<boolean> {
  const own = await query(
    `SELECT id FROM lesson_highlights WHERE id = $1 AND user_id = $2 AND kind = 'hl'`,
    [highlightId, userId],
  );
  if (own.rows.length === 0) return false;
  await query(
    `UPDATE lesson_highlights SET last_reviewed_at = ${USE_SQLITE ? "datetime('now')" : 'NOW()'} WHERE id = $1`,
    [highlightId],
  );
  return true;
}

/** Получатели крона: юзеры с ≥1 due-хайлайтом (порог — начало суток МСК). */
export async function listReviewDueUserIds(): Promise<string[]> {
  const threshold = mskTodayStart().toISOString();
  const r = await query(
    `SELECT DISTINCT h.user_id
     FROM lesson_highlights h
     WHERE h.kind = 'hl'
       AND (h.last_reviewed_at IS NULL OR h.last_reviewed_at < $1)`,
    [USE_SQLITE ? threshold.replace('T', ' ').slice(0, 19) : threshold],
  );
  return r.rows.map((x: any) => String(x.user_id));
}
