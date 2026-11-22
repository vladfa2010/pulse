/**
 * =============================================================================
 * PULSE — Бакеты «Пока вас не было» для карусели непрочитанного (ТЗ-218)
 * =============================================================================
 *
 * Сборка BucketPayload для GET /api/news (unread-режим, первая страница).
 * Закрытые 6-часовые бакеты по МСК без просмотра (user_bucket_reads) →
 * карточки-саммари; хвост старше 24ч → корешок «Вчера» (sentinel epoch).
 * Окна принадлежности — (start, end]: новость ровно на границе относится к
 * предыдущему бакету (критерий приёмки ТЗ-218).
 *
 * Фиче-флаг BUCKETS_ENABLED (дефолт true) — откат без редеплоя.
 * Виральные сюжеты: кластеры size >= VIRAL_MIN_SOURCES с новостью окна по
 * тегам юзера; при выключенном CLUSTERING_ENABLED/отсутствии таблицы — 0.
 */

import { query } from '../config/db';
import { closedBucketsSince, BucketKey, BucketRange, MSK_OFFSET_HOURS } from './bucketTime';
import { getOrGenerateBucketSummary } from './bucketSummary';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export const BUCKETS_ENABLED = process.env.BUCKETS_ENABLED !== 'false';
const VIRAL_MIN_SOURCES = 5;

export interface BucketTopNews {
  id: string;
  slug: string | null;
  title: string;
  source: string | null;
  sentiment: string | null;
}

export interface BucketPayload {
  key: BucketKey | 'older';
  label: string;
  range_start: string | null;
  range_end: string;
  count: number;
  sentiment: { pos: number; neg: number };
  viral_stories: number;
  summary: string | null;
  top_news: BucketTopNews[];
  generated_at: string | null;
}

const LABELS: Record<string, string> = {
  night: 'Ночь',
  morning: 'Утро',
  day: 'День',
  evening: 'Вечер',
  older: 'Вчера',
};

/** Диалектные условия тегов (зеркалим news.ts): PG && / SQLite LIKE-цепочка. */
function tagConds(tagIds: string[], params: unknown[], alias = 'n'): string {
  if (USE_SQLITE) {
    const conds = tagIds.map(() => `${alias}.matched_tags LIKE ?`);
    for (const t of tagIds) params.push(`%"${t}"%`);
    return conds.join(' OR ');
  }
  params.push(tagIds);
  return `${alias}.matched_tags && $${params.length}::text[]`;
}

function pushParam(params: unknown[], v: unknown): string {
  params.push(v);
  return `$${params.length}`;
}

function timeCond(params: unknown[], start: Date | null, end: Date, alias = 'n'): string {
  const conds: string[] = [];
  if (start) {
    params.push(USE_SQLITE ? start.toISOString().replace('T', ' ').slice(0, 19) : start.toISOString());
    conds.push(`${alias}.published_at > ${USE_SQLITE ? '?' : `$${params.length}`}`);
  }
  params.push(USE_SQLITE ? end.toISOString().replace('T', ' ').slice(0, 19) : end.toISOString());
  conds.push(`${alias}.published_at <= ${USE_SQLITE ? '?' : `$${params.length}`}`);
  return conds.join(' AND ');
}

async function countAndSentiment(userId: string, tagIds: string[], start: Date | null, end: Date): Promise<{ count: number; pos: number; neg: number }> {
  const params: unknown[] = [];
  const tc = tagConds(tagIds, params);
  const t = timeCond(params, start, end);
  const nr = USE_SQLITE
    ? 'NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = ? AND r.news_id = n.id)'
    : `NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = ${pushParam(params, userId)} AND r.news_id = n.id)`;
  if (USE_SQLITE) params.push(userId);
  const res = await query(
    `SELECT COUNT(*) AS count,
            COUNT(*) FILTER (WHERE n.sentiment = 'positive') AS pos,
            COUNT(*) FILTER (WHERE n.sentiment = 'negative') AS neg
     FROM news n
     WHERE ${tc} AND ${t} AND ${nr}`,
    params
  );
  const r = res.rows[0] || {};
  return { count: Number(r.count || 0), pos: Number(r.pos || 0), neg: Number(r.neg || 0) };
}

async function topNews(tagIds: string[], start: Date | null, end: Date): Promise<BucketTopNews[]> {
  const params: unknown[] = [];
  const tc = tagConds(tagIds, params);
  const t = timeCond(params, start, end);
  const nullsLast = USE_SQLITE ? '' : ' NULLS LAST';
  const res = await query(
    `SELECT n.id, n.slug, COALESCE(n.title_ru, n.title_original) AS title, n.source, n.sentiment
     FROM news n
     WHERE ${tc} AND ${t}
     ORDER BY n.source_count DESC, n.sentiment_score DESC${nullsLast}
     LIMIT 4`,
    params
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    slug: r.slug ?? null,
    title: r.title ?? '',
    source: r.source ?? null,
    sentiment: r.sentiment ?? null,
  }));
}

/** Виральные сюжеты окна; любая ошибка/выключенный флаг/нет таблицы → 0. */
async function viralStories(tagIds: string[], start: Date | null, end: Date): Promise<number> {
  if (USE_SQLITE || process.env.CLUSTERING_ENABLED !== 'true') return 0;
  try {
    const params: unknown[] = [VIRAL_MIN_SOURCES];
    const tc = tagConds(tagIds, params);
    const t = timeCond(params, start, end);
    const res = await query(
      `SELECT COUNT(*) AS count FROM clusters c
       WHERE c.size >= $1 AND EXISTS (
         SELECT 1 FROM news n
         WHERE n.cluster_id = c.id AND ${tc} AND ${t}
       )`,
      params
    );
    return Number(res.rows[0]?.count || 0);
  } catch (err: any) {
    console.warn(`[Buckets] viral count failed (сводим к 0): ${err.message?.slice(0, 100)}`);
    return 0;
  }
}

/** Окна исключения для живой выборки (NOT-предикат по каждому окну).
 *  PG: плейсхолдеры нумеруются со смещением baseIdx (после основных params). */
/** Чтение top_news из bucket_summaries по квантованному ключу (без LLM и живого SELECT). */
async function topNewsFromDb(userId: string, tagIds: string[], start: Date, end: Date): Promise<BucketTopNews[]> {
  const { createHash } = await import('crypto');
  const sorted = [...tagIds].sort().join('|');
  const key = createHash('sha1').update(`${sorted}|${start.toISOString()}|${end.toISOString()}`).digest('hex');
  const res = await query(
    `SELECT top_news FROM bucket_summaries WHERE user_id = $1 AND tags_hash = $2 AND variant = 'bucket'`,
    [userId, key]
  );
  return parseTopNews(res.rows[0]?.top_news);
}

/** top_news из строки БД (variant='bucket' — набор фиксирован, ТЗ-218 читать из БД). */
function parseTopNews(raw: unknown): BucketTopNews[] {
  if (!raw) return [];
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr.map((x: any) => ({
      id: String(x.id),
      slug: x.slug ?? null,
      title: String(x.title ?? ''),
      source: x.source ?? null,
      sentiment: x.sentiment ?? null,
    }));
  } catch {
    return [];
  }
}

export function exclusionPredicate(
  windows: Array<{ start: Date | null; end: Date }>,
  params: unknown[],
  baseIdx = 0
): string {
  const parts = windows.map((w) => {
    const p: string[] = [];
    if (w.start) {
      params.push(USE_SQLITE ? w.start.toISOString().replace('T', ' ').slice(0, 19) : w.start.toISOString());
      p.push(`published_at > ${USE_SQLITE ? '?' : `$${baseIdx + params.length}`}`);
    }
    params.push(USE_SQLITE ? w.end.toISOString().replace('T', ' ').slice(0, 19) : w.end.toISOString());
    p.push(`published_at <= ${USE_SQLITE ? '?' : `$${baseIdx + params.length}`}`);
    return `(${p.join(' AND ')})`;
  });
  return parts.length ? ` AND NOT (${parts.join(' OR ')})` : '';
}

/**
 * Сборка бакетов для юзера. Отдаёт payloads + окна исключения (для живой
 * выборки роута) + sentinel-viewed_at корешка «Вчера».
 */
export async function buildBuckets(
  userId: string,
  tagIds: string[]
): Promise<{ buckets: BucketPayload[]; exclude: Array<{ start: Date | null; end: Date }> }> {
  const empty = { buckets: [], exclude: [] as Array<{ start: Date | null; end: Date }> };
  if (!BUCKETS_ENABLED || tagIds.length === 0) return empty;

  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);
  const closed = closedBucketsSince(now, dayAgo).filter((b) => now.getTime() - b.end.getTime() <= 24 * 3600 * 1000);

  // просмотренные бакеты за сутки
  const viewedRes = await query(
    `SELECT bucket_start, viewed_at FROM user_bucket_reads WHERE user_id = $1`,
    [userId]
  );
  const viewed = new Map<string, string>();
  let olderViewedAt: string | null = null;
  for (const row of viewedRes.rows) {
    const bs = new Date(row.bucket_start).getTime();
    if (bs <= 0) {
      olderViewedAt = row.viewed_at;
      continue;
    }
    viewed.set(String(bs), row.viewed_at);
  }

  const buckets: BucketPayload[] = [];
  const exclude: Array<{ start: Date | null; end: Date }> = [];

  for (const b of closed) {
    if (viewed.has(String(b.start.getTime()))) continue;
    const { count, pos, neg } = await countAndSentiment(userId, tagIds, b.start, b.end);
    if (count === 0) continue;
    const [summaryRes, viral] = await Promise.all([
      getOrGenerateBucketSummary(userId, tagIds, b.start, b.end, 'bucket', b.key),
      viralStories(tagIds, b.start, b.end),
    ]);
    // top_news: из строки БД (набор бакета фиксирован — ТЗ-218 читать из БД, не дёргать
    // живой SELECT); живый запрос — только если строки ещё нет (ленивая генерация стартовала)
    const tops = await topNewsFromDb(userId, tagIds, b.start, b.end)
      .then((rows) => (rows.length ? rows : topNews(tagIds, b.start, b.end)));
    buckets.push({
      key: b.key,
      label: LABELS[b.key],
      range_start: b.start.toISOString(),
      range_end: b.end.toISOString(),
      count,
      sentiment: { pos, neg },
      viral_stories: viral,
      summary: summaryRes?.summary ?? null,
      top_news: tops,
      generated_at: summaryRes?.generated_at ?? null,
    });
    exclude.push({ start: b.start, end: b.end });
  }

  // корешок «Вчера»: непрочитанные старше 24ч, опубликованные позже просмотра sentinel
  const olderEnd = dayAgo;
  const op: unknown[] = [];
  const push = (v: unknown) => { op.push(v); return USE_SQLITE ? '?' : `$${op.length}`; };
  const oc = USE_SQLITE
    ? tagIds.map((t) => { const p = push(`%"${t}"%`); return `n.matched_tags LIKE ${p}`; }).join(' OR ')
    : `n.matched_tags && ${push(tagIds)}::text[]`;
  const upper = push(USE_SQLITE ? olderEnd.toISOString().replace('T', ' ').slice(0, 19) : olderEnd.toISOString());
  const notRead = `NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = ${push(userId)} AND r.news_id = n.id)`;
  const publishedAfter = olderViewedAt
    ? ` AND n.published_at > ${push(USE_SQLITE ? new Date(olderViewedAt).toISOString().replace('T', ' ').slice(0, 19) : new Date(olderViewedAt).toISOString())}`
    : '';
  const olderCountRes = await query(
    `SELECT COUNT(*) AS count,
            COUNT(*) FILTER (WHERE n.sentiment = 'positive') AS pos,
            COUNT(*) FILTER (WHERE n.sentiment = 'negative') AS neg
     FROM news n
     WHERE ${oc}
       AND n.published_at <= ${upper}
       AND ${notRead}${publishedAfter}`,
    op
  );
  const olderCount = Number(olderCountRes.rows[0]?.count || 0);

  if (olderCount > 0) {
    const [summaryRes, tops, viral] = await Promise.all([
      getOrGenerateBucketSummary(userId, tagIds, null, olderEnd, 'older', null),
      topNews(tagIds, null, olderEnd),
      viralStories(tagIds, null, olderEnd),
    ]);
    buckets.unshift({
      key: 'older',
      label: LABELS.older,
      range_start: null,
      range_end: olderEnd.toISOString(),
      count: olderCount,
      sentiment: {
        pos: Number(olderCountRes.rows[0]?.pos || 0),
        neg: Number(olderCountRes.rows[0]?.neg || 0),
      },
      viral_stories: viral,
      summary: summaryRes?.summary ?? null,
      top_news: tops,
      generated_at: summaryRes?.generated_at ?? null,
    });
    exclude.push({ start: null, end: olderEnd });
  }
  // ТЗ-218 З3 п.3: окно >24ч исключается из живой выборки БЕЗУСЛОВНО — иначе
  // после просмотра «Вчера» остаток старого хвоста снова показывался живыми
  exclude.push({ start: null, end: olderEnd });

  return { buckets, exclude };
}
