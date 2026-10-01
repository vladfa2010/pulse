/**
 * =============================================================================
 * PULSE — LMS «Образование»: календарный мэтчинг курсов ↔ события (ТЗ-103 v2,
 * Задача 7) — backend, правила без LLM/эмбеддингов
 * =============================================================================
 *
 * Принцип (осознанный отказ от семантики, YAGNI): только пересечение
 * event.tag_ids ∩ course_tags ≥ 1; kind категориален. Эмбеддинги и LLM для
 * событий НЕ используются — теги событий чистые (источник — структурированный
 * календарь). Пересмотреть, только если редакторы пожалуются на полноту.
 *
 * Связи НЕ персистим: конвейер пересобирает calendar_events целиком
 * (writeCanonicalRows → DELETE + INSERT), id событий нестабильны — событие
 * адресуется натуральным ключом (date, title, kind, ticker).
 *
 * Кэш in-memory (паттерн services/heatmapDaily.ts, ТЗ-103 v3 п.1; внешний Redis
 * НЕ используется — один инстанс): ключ 'education:calmatch:today:<YYYY-MM-DD>',
 * TTL 1 час. Инвалидация — вместе с витриной: invalidateEducationCache()
 * (services/education/cache.ts) зовёт invalidateCalMatchCache() ниже.
 *
 * «Сегодня/завтра» — бизнес-дата МСК, та же, что использует календарь
 * (getMskDateString из services/calendar; риск №8 ТЗ-103 v2). Прошедшие
 * события нигде не показываем. Событие без tag_ids не мэтчится ни к чему
 * (риск №9 — лучше пропустить, чем показать нерелевантный курс).
 */

import { query } from '../../config/db';
import { getMskDateString, addDays } from '../calendar';

const CALMATCH_TTL_MS = 60 * 60 * 1000; // 1 час (ТЗ-103 Задача 7 п.3)
const CACHE_PREFIX = 'education:calmatch:';
const MAX_COURSES_PER_EVENT = 3; // лимит курсов на событие (Задача 7 п.1)

interface CacheEntry<T> { at: number; payload: T }
const cache = new Map<string, CacheEntry<any>>();

/** Инвалидация календарного кэша — вызывается из invalidateEducationCache(). */
export function invalidateCalMatchCache(): void {
  for (const key of cache.keys()) {
    if (key.startsWith(CACHE_PREFIX)) cache.delete(key);
  }
}

export function getCalMatchCached<T>(key: string, producer: () => Promise<T>): Promise<T> {
  const fullKey = CACHE_PREFIX + key;
  const hit = cache.get(fullKey);
  if (hit && Date.now() - hit.at <= CALMATCH_TTL_MS) {
    return Promise.resolve(hit.payload as T);
  }
  cache.delete(fullKey);
  return producer().then((payload) => {
    cache.set(fullKey, { at: Date.now(), payload });
    return payload;
  });
}

function parseTagIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export interface MatchedCourse {
  slug: string;
  title: string;
  type: string;
  size: string;
  price: number;
  cover_url: string | null;
  badges: string[];
  matched_tags: string[]; // названия общих тегов — «причина» для UI
}

export interface MatchedEvent {
  date: string;
  title: string;
  kind: string;
  status: string;
  company: string;
  ticker: string;
  matched_tags: string[];
}

interface CourseRow {
  id: string;
  slug: string;
  title: string;
  type: string;
  size: string;
  price: number;
  cover_url: string | null;
  badges: string;
  created_at: string;
  tag_id: string | null;
  tag_name: string | null;
}

/**
 * Курсы для события: пересечение tag_ids ∩ course_tags ≥ 1, курс published,
 * не удалён и public (hidden/черновики в публичный мэтчинг не попадают).
 * Сортировка: число общих тегов DESC, затем свежесть курса DESC
 * (created_at — у курсов нет published_at, ближайший по смыслу «свежесть
 * публикации»). Лимит 3 курса на событие.
 */
export async function matchCoursesToEvent(eventTagIds: string[]): Promise<MatchedCourse[]> {
  const wanted = new Set(eventTagIds);
  if (wanted.size === 0) return [];

  const rows = await query(
    `SELECT c.id, c.slug, c.title, c.type, c.size, c.price, c.cover_url, c.badges,
            c.created_at, ct.tag_id, udt.tag_name
     FROM courses c
     LEFT JOIN course_tags ct ON ct.course_id = c.id
     LEFT JOIN user_defined_tags udt ON udt.tag_id = ct.tag_id
     WHERE c.status = 'published' AND c.deleted_at IS NULL AND c.visibility = 'public'
     ORDER BY c.created_at DESC`,
    [],
  );

  const byCourse = new Map<string, { row: CourseRow; tagIds: Set<string>; tagNames: Map<string, string> }>();
  for (const r of rows.rows as CourseRow[]) {
    let entry = byCourse.get(r.id);
    if (!entry) {
      entry = { row: r, tagIds: new Set(), tagNames: new Map() };
      byCourse.set(r.id, entry);
    }
    if (r.tag_id && wanted.has(r.tag_id)) {
      entry.tagIds.add(r.tag_id);
      entry.tagNames.set(r.tag_id, r.tag_name || r.tag_id);
    }
  }

  const matched = [...byCourse.values()]
    .filter((e) => e.tagIds.size > 0)
    .sort((a, b) =>
      b.tagIds.size - a.tagIds.size
      || String(b.row.created_at || '').localeCompare(String(a.row.created_at || '')),
    )
    .slice(0, MAX_COURSES_PER_EVENT);

  return matched.map((e) => {
    let badges: string[] = [];
    try {
      badges = JSON.parse(e.row.badges || '[]');
    } catch {
      badges = [];
    }
    return {
      slug: e.row.slug,
      title: e.row.title,
      type: e.row.type,
      size: e.row.size,
      price: Number(e.row.price),
      cover_url: e.row.cover_url,
      badges: Array.isArray(badges) ? badges : [],
      matched_tags: [...e.tagIds].map((id) => e.tagNames.get(id) || id),
    };
  });
}

/** Теги курса (для events-preview и courses/:slug/events). */
export async function courseTagIds(courseId: string): Promise<string[]> {
  const r = await query(
    `SELECT tag_id FROM course_tags WHERE course_id = $1`, [courseId],
  );
  return r.rows.map((row: any) => row.tag_id);
}

/**
 * События для курса: окно [сегодня, сегодня+daysAhead] (бизнес-дата МСК),
 * пересечение tag_ids ≥ 1. Сортировка date ASC. Прошедшие события не
 * возвращаем никогда. События без tag_ids пропускаем.
 */
export async function matchEventsToCourse(courseTagIds: string[], daysAhead = 14): Promise<MatchedEvent[]> {
  if (courseTagIds.length === 0) return [];
  const wanted = new Set(courseTagIds);
  const today = await getMskDateString();
  const until = addDays(today, daysAhead);

  // Названия общих тегов (matched_tags в ответе — имена, как у курсов)
  const ph = courseTagIds.map((_, i) => `$${i + 1}`).join(',');
  const namesR = await query(
    `SELECT tag_id, tag_name FROM user_defined_tags WHERE tag_id IN (${ph})`,
    courseTagIds,
  );
  const tagNames = new Map(namesR.rows.map((r: any) => [r.tag_id, r.tag_name || r.tag_id]));

  const rows = await query(
    `SELECT date, title, kind, status, company, ticker, tag_ids
     FROM calendar_events
     WHERE date >= $1 AND date <= $2
     ORDER BY date ASC`,
    [today, until],
  );

  const events: MatchedEvent[] = [];
  for (const r of rows.rows) {
    const tagIds = parseTagIds(r.tag_ids);
    const shared = tagIds.filter((t) => wanted.has(t));
    if (shared.length === 0) continue;
    events.push({
      date: String(r.date).slice(0, 10),
      title: r.title,
      kind: r.kind,
      status: r.status,
      company: r.company,
      ticker: r.ticker,
      matched_tags: shared.map((id) => tagNames.get(id) || id),
    });
  }
  return events;
}
