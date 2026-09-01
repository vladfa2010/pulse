/**
 * News heatmap daily aggregates: freeze, increment, backfill, query (TZ 11.11).
 *
 * Timezone: Europe/Moscow for all day boundaries.
 */

import { query } from '../config/db';
import {
  DEFAULT_TZ,
  HOURS_DAYS,
  WEEKS,
  Scope,
  HeatmapCell,
  portfolioKey,
  sqliteOffset,
  quantile,
  spikeThreshold,
  toMskDateString,
  isoDate,
  addDays,
  buildYearDates,
} from './heatmap/utils';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Cache TTLs
const TODAY_CACHE_TTL_MS = 5 * 60 * 1000;
const HEATMAP_CACHE_TTL_MS = 15 * 60 * 1000;
const HISTORY_CACHE_TTL_MS = 24 * 3600 * 1000; // until next freeze invalidates
const CACHE_MAX_SIZE = 5000;

interface CacheEntry<T> { at: number; ttl: number; payload: T }
const cache = new Map<string, CacheEntry<any>>();

let tablesMissingWarned = false;

function evict(): void {
  if (cache.size <= CACHE_MAX_SIZE) return;
  const entries = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  const toRemove = entries.slice(0, Math.ceil(entries.length * 0.2));
  for (const [k] of toRemove) cache.delete(k);
}

export function getCached<T>(key: string): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

export function setCached<T>(key: string, payload: T, ttlMs: number): void {
  evict();
  cache.set(key, { at: Date.now(), ttl: ttlMs, payload });
}

// ─── SQL helpers (PG + SQLite) ─────────────────────────────────────────────

function yearHistoryParams(scope: Scope, userId: string, tagId: string): any[] {
  if (USE_SQLITE) {
    if (scope === 'tag') return [tagId];
    if (scope === 'portfolio') return [userId];
    return [];
  }
  if (scope === 'tag') return [tagId];
  if (scope === 'portfolio') return [userId];
  return [];
}

function sqlYearHistory(scope: Scope): { pg: string; lite: string } {
  if (scope === 'all') {
    return {
      pg: `SELECT day_msk, stories, pos, neg, resonance FROM news_all_daily WHERE day_msk >= (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}'::date - interval '${WEEKS * 7} days') ORDER BY day_msk`,
      lite: `SELECT day_msk, stories, pos, neg, resonance FROM news_all_daily WHERE day_msk >= date(datetime('now', '${sqliteOffset(DEFAULT_TZ)}', '-${WEEKS * 7} days')) ORDER BY day_msk`,
    };
  }
  if (scope === 'tag') {
    return {
      pg: `SELECT day_msk, stories, pos, neg, resonance FROM news_tag_daily WHERE tag_id = $1 AND day_msk >= (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}'::date - interval '${WEEKS * 7} days') ORDER BY day_msk`,
      lite: `SELECT day_msk, stories, pos, neg, resonance FROM news_tag_daily WHERE tag_id = ?1 AND day_msk >= date(datetime('now', '${sqliteOffset(DEFAULT_TZ)}', '-${WEEKS * 7} days')) ORDER BY day_msk`,
    };
  }
  return {
    pg: `SELECT day_msk, stories, pos, neg, resonance FROM user_portfolio_daily WHERE user_id = $1::uuid AND day_msk >= (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}'::date - interval '${WEEKS * 7} days') ORDER BY day_msk`,
    lite: `SELECT day_msk, stories, pos, neg, resonance FROM user_portfolio_daily WHERE user_id = ?1 AND day_msk >= date(datetime('now', '${sqliteOffset(DEFAULT_TZ)}', '-${WEEKS * 7} days')) ORDER BY day_msk`,
  };
}

function sqlYearToday(scope: Scope): { pg: string; lite: string } {
  if (scope === 'all') {
    return {
      pg: `SELECT COUNT(*)::int AS stories,
                  SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END)::int AS pos,
                  SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END)::int AS neg,
                  COALESCE(SUM(source_count),0)::int AS resonance
           FROM news
           WHERE (published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date = (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date
             AND cardinality(matched_tags) > 0`,
      lite: `SELECT COUNT(*) AS stories,
                  SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) AS pos,
                  SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) AS neg,
                  COALESCE(SUM(source_count),0) AS resonance
           FROM news
           WHERE date(datetime(published_at, '${sqliteOffset(DEFAULT_TZ)}')) = date(datetime('now', '${sqliteOffset(DEFAULT_TZ)}'))
             AND json_array_length(matched_tags) > 0`,
    };
  }
  if (scope === 'tag') {
    return {
      pg: `SELECT COUNT(*)::int AS stories,
                  SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END)::int AS pos,
                  SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END)::int AS neg,
                  COALESCE(SUM(source_count),0)::int AS resonance
           FROM news
           WHERE (published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date = (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date
             AND matched_tags @> ARRAY[$1]::text[]`,
      lite: `SELECT COUNT(*) AS stories,
                  SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END) AS pos,
                  SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END) AS neg,
                  COALESCE(SUM(source_count),0) AS resonance
           FROM news n
           WHERE date(datetime(published_at, '${sqliteOffset(DEFAULT_TZ)}')) = date(datetime('now', '${sqliteOffset(DEFAULT_TZ)}'))
             AND EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value = ?1)`,
    };
  }
  return {
    pg: `SELECT COUNT(DISTINCT n.id)::int AS stories,
                SUM(CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END)::int AS pos,
                SUM(CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END)::int AS neg,
                COALESCE(SUM(n.source_count),0)::int AS resonance
         FROM news n
         WHERE (n.published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date = (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date
           AND n.matched_tags && (SELECT array_agg(tag_id) FROM portfolios WHERE user_id = $1::uuid AND NOT is_frozen)`,
    lite: `SELECT COUNT(DISTINCT n.id) AS stories,
                SUM(CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END) AS pos,
                SUM(CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END) AS neg,
                COALESCE(SUM(n.source_count),0) AS resonance
         FROM news n
         WHERE date(datetime(n.published_at, '${sqliteOffset(DEFAULT_TZ)}')) = date(datetime('now', '${sqliteOffset(DEFAULT_TZ)}'))
           AND EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value IN
               (SELECT tag_id FROM portfolios WHERE user_id = ?1 AND NOT is_frozen))`,
  };
}

export function sqlDay(scope: Scope): { pg: string; lite: string } {
  const pgFilter = scope === 'tag'
    ? `AND matched_tags @> ARRAY[$2]::text[]`
    : scope === 'portfolio'
    ? `AND matched_tags && (SELECT array_agg(tag_id) FROM portfolios WHERE user_id = $2::uuid AND NOT is_frozen)`
    : `AND cardinality(matched_tags) > 0`;
  const liteFilter = scope === 'tag'
    ? `AND EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value = ?)`
    : scope === 'portfolio'
    ? `AND EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value IN
        (SELECT tag_id FROM portfolios WHERE user_id = ? AND NOT is_frozen))`
    : `AND json_array_length(n.matched_tags) > 0`;
  return {
    pg: `
      SELECT id, title_ru, summary_ru, source, url, published_at, sentiment, source_count, matched_tags
      FROM news
      WHERE (published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date = $1::date
        ${pgFilter}
      ORDER BY published_at DESC`,
    lite: `
      SELECT id, title_ru, summary_ru, source, url, published_at, sentiment, source_count, matched_tags
      FROM news n
      WHERE date(datetime(published_at, '${sqliteOffset(DEFAULT_TZ)}')) = ?
        ${liteFilter}
      ORDER BY published_at DESC`,
  };
}

export function sqlDayHours(scope: Scope): { pg: string; lite: string } {
  const pgFilter = scope === 'tag'
    ? `AND matched_tags @> ARRAY[$2]::text[]`
    : scope === 'portfolio'
    ? `AND matched_tags && (SELECT array_agg(tag_id) FROM portfolios WHERE user_id = $2::uuid AND NOT is_frozen)`
    : `AND cardinality(matched_tags) > 0`;
  const liteFilter = scope === 'tag'
    ? `AND EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value = ?)`
    : scope === 'portfolio'
    ? `AND EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value IN
        (SELECT tag_id FROM portfolios WHERE user_id = ? AND NOT is_frozen))`
    : `AND json_array_length(n.matched_tags) > 0`;
  return {
    pg: `
      SELECT to_char((published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date, 'YYYY-MM-DD') AS day,
             EXTRACT(HOUR FROM published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::int AS hour,
             COUNT(*)::int AS stories
      FROM news
      WHERE published_at >= NOW() - interval '${HOURS_DAYS} days'
        ${pgFilter}
      GROUP BY 1, 2 ORDER BY 1, 2`,
    lite: `
      SELECT date(datetime(published_at, '${sqliteOffset(DEFAULT_TZ)}')) AS day,
             CAST(strftime('%H', datetime(published_at, '${sqliteOffset(DEFAULT_TZ)}')) AS INTEGER) AS hour,
             COUNT(*) AS stories
      FROM news n
      WHERE published_at >= datetime('now', '-${HOURS_DAYS} days')
        ${liteFilter}
      GROUP BY 1, 2 ORDER BY 1, 2`,
  };
}

function tagMiniSql(): { pg: string; lite: string } {
  return {
    pg: `
      SELECT t.tag_id, to_char((published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date, 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS stories
      FROM news, LATERAL unnest(matched_tags) AS t(tag_id)
      WHERE published_at >= NOW() - interval '${WEEKS * 7} days'
        AND t.tag_id = ANY($1::text[])
      GROUP BY 1, 2`,
    lite: `
      SELECT je.value AS tag_id, date(datetime(published_at, '${sqliteOffset(DEFAULT_TZ)}')) AS day,
             COUNT(*) AS stories
      FROM news n, json_each(n.matched_tags) je
      WHERE published_at >= datetime('now', '-${WEEKS * 7} days')
        AND je.value IN (SELECT value FROM json_each(?))
      GROUP BY 1, 2`,
  };
}

// ─── Aggregate tables availability ──────────────────────────────────────────

async function aggregateTablesExist(): Promise<boolean> {
  if (USE_SQLITE) return true; // SQLite dev: schema will be created on boot
  try {
    const r = await query(`SELECT 1 FROM news_tag_daily LIMIT 1`);
    return true;
  } catch (e: any) {
    if (e.code === '42P01') {
      if (!tablesMissingWarned) {
        console.warn('[NewsHeatmap] history: aggregate tables missing (42P01) — fully live mode');
        tablesMissingWarned = true;
      }
      return false;
    }
    throw e;
  }
}

// ─── Year cells: frozen history + live today ─────────────────────────────────

export async function getYearCells(
  scope: Scope,
  userId: string,
  tagId: string,
  tz: string
): Promise<{ cells: HeatmapCell[]; frozenThrough: string | null }> {
  const today = toMskDateString(new Date());
  const allDates = buildYearDates();
  const dateSet = new Set(allDates);

  let historyRows: any[] = [];
  let frozenThrough: string | null = null;
  const useAggregates = await aggregateTablesExist();

  if (useAggregates) {
    const s = sqlYearHistory(scope);
    const r = await query(USE_SQLITE ? s.lite : s.pg, yearHistoryParams(scope, userId, tagId));
    historyRows = r.rows || [];
    if (historyRows.length > 0) {
      frozenThrough = historyRows[historyRows.length - 1].day_msk;
    }
  }

  const byDate = new Map<string, any>();
  for (const row of historyRows) {
    byDate.set(row.day_msk, row);
  }

  // If today not in history (freeze only covers through yesterday), compute live today.
  if (!byDate.has(today) && useAggregates) {
    const s = sqlYearToday(scope);
    const params = scope === 'tag' ? [tagId] : scope === 'portfolio' ? [userId] : [];
    try {
      const r = await query(USE_SQLITE ? s.lite : s.pg, params);
      const row = r.rows[0];
      if (row && row.stories > 0) {
        byDate.set(today, row);
      }
    } catch (e: any) {
      console.warn('[NewsHeatmap] live today fetch failed:', e.message);
    }
  }

  // Fill missing dates in window.
  const cells: HeatmapCell[] = allDates.map((date) => {
    const r = byDate.get(date);
    const stories = r ? Number(r.stories || 0) : 0;
    const pos = r ? Number(r.pos || 0) : 0;
    const neg = r ? Number(r.neg || 0) : 0;
    const sentiment_sign = stories === 0 ? null : pos > neg ? 1 : neg > pos ? -1 : 0;
    return {
      date,
      stories,
      pos,
      neg,
      resonance: r ? Number(r.resonance || 0) : 0,
      sentiment_sign,
      spike: false,
    };
  });

  // Spikes: last 90 days median threshold.
  const last90 = cells.slice(-90).map((c) => c.stories);
  const thr = spikeThreshold(last90);
  for (const c of cells) {
    if (c.stories >= thr && c.stories > 0) c.spike = true;
  }

  return { cells, frozenThrough };
}

// ─── Tag mini-grids (portfolio) ─────────────────────────────────────────────

export interface TagMiniGrid {
  tagId: string;
  cells: { date: string; stories: number }[];
  quantiles: number[];
}

export async function getTagMiniGrids(userId: string, tagIds: string[]): Promise<Map<string, TagMiniGrid>> {
  const result = new Map<string, TagMiniGrid>();
  if (tagIds.length === 0) return result;
  const allDates = buildYearDates();
  const s = tagMiniSql();
  const params = USE_SQLITE ? [JSON.stringify(tagIds)] : [tagIds];
  const r = await query(USE_SQLITE ? s.lite : s.pg, params);
  const byTag = new Map<string, Map<string, number>>();
  for (const row of r.rows || []) {
    const tagId = row.tag_id;
    if (!byTag.has(tagId)) byTag.set(tagId, new Map());
    byTag.get(tagId)!.set(row.day, Number(row.stories));
  }

  for (const tagId of tagIds) {
    const cells = allDates.map((date) => ({
      date,
      stories: byTag.get(tagId)?.get(date) || 0,
    }));
    const nonzero = cells.filter((c) => c.stories > 0).map((c) => c.stories).sort((a, b) => a - b);
    const quantiles = [quantile(nonzero, 0.5), quantile(nonzero, 0.75), quantile(nonzero, 0.9)];
    result.set(tagId, { tagId, cells, quantiles });
  }
  return result;
}

// ─── Portfolio freshness / rebuild ────────────────────────────────────────────

export async function ensurePortfolioHistoryFresh(userId: string, tags: string[]): Promise<void> {
  const currentHash = portfolioKey(tags);
  const meta = await query(
    USE_SQLITE
      ? `SELECT tags_hash FROM user_portfolio_daily_meta WHERE user_id = ?`
      : `SELECT tags_hash FROM user_portfolio_daily_meta WHERE user_id = $1::uuid`,
    [userId]
  );
  if (meta.rows[0]?.tags_hash === currentHash) return;

  const t0 = Date.now();
  console.info(`[NewsHeatmap] portfolio rebuild: start user=${userId}`);
  const s = {
    pg: `
      INSERT INTO user_portfolio_daily (user_id, day_msk, stories, pos, neg, resonance)
      SELECT $1::uuid,
             (n.published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date,
             COUNT(DISTINCT n.id),
             SUM(CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END),
             SUM(CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END),
             COALESCE(SUM(n.source_count), 0)
      FROM news n
      WHERE n.published_at >= NOW() - interval '${WEEKS * 7} days'
        AND n.matched_tags && (SELECT array_agg(tag_id) FROM portfolios WHERE user_id = $1::uuid AND NOT is_frozen)
      GROUP BY 1
      ON CONFLICT (user_id, day_msk) DO UPDATE SET
        stories = EXCLUDED.stories, pos = EXCLUDED.pos,
        neg = EXCLUDED.neg, resonance = EXCLUDED.resonance`,
    lite: `
      INSERT INTO user_portfolio_daily (user_id, day_msk, stories, pos, neg, resonance)
      SELECT ?1,
             date(datetime(n.published_at, '${sqliteOffset(DEFAULT_TZ)}')),
             COUNT(DISTINCT n.id),
             SUM(CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END),
             SUM(CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END),
             COALESCE(SUM(n.source_count), 0)
      FROM news n
      WHERE n.published_at >= datetime('now', '-${WEEKS * 7} days')
        AND EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value IN
          (SELECT tag_id FROM portfolios WHERE user_id = ?1 AND NOT is_frozen))
      GROUP BY 2
      ON CONFLICT (user_id, day_msk) DO UPDATE SET
        stories = EXCLUDED.stories, pos = EXCLUDED.pos,
        neg = EXCLUDED.neg, resonance = EXCLUDED.resonance`,
  };
  await query(USE_SQLITE ? s.lite : s.pg, [userId]);
  await query(
    USE_SQLITE
      ? `INSERT OR REPLACE INTO user_portfolio_daily_meta (user_id, tags_hash, rebuilt_at) VALUES (?, ?, datetime('now'))`
      : `INSERT INTO user_portfolio_daily_meta (user_id, tags_hash, rebuilt_at) VALUES ($1::uuid, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET tags_hash = EXCLUDED.tags_hash, rebuilt_at = EXCLUDED.rebuilt_at`,
    [userId, currentHash]
  );
  console.info(`[NewsHeatmap] portfolio rebuild: done duration_ms=${Date.now() - t0}`);
}

// ─── Freeze (cron 00:05 MSK) ────────────────────────────────────────────────

export async function freezeHeatmapRecentDays(): Promise<void> {
  const t0 = Date.now();
  console.info('[NewsHeatmap] freeze: start');
  try {
    // news_tag_daily: 3-day window
    const rTag = await query(USE_SQLITE
      ? `
        INSERT INTO news_tag_daily (tag_id, day_msk, stories, pos, neg, resonance)
        SELECT je.value AS tag_id,
               date(datetime(n.published_at, '${sqliteOffset(DEFAULT_TZ)}')),
               COUNT(*),
               SUM(CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END),
               SUM(CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END),
               COALESCE(SUM(n.source_count), 0)
        FROM news n, json_each(n.matched_tags) je
        WHERE date(datetime(n.published_at, '${sqliteOffset(DEFAULT_TZ)}')) >= date(datetime('now', '${sqliteOffset(DEFAULT_TZ)}', '-3 days'))
        GROUP BY 1, 2
        ON CONFLICT (tag_id, day_msk) DO UPDATE SET
          stories = EXCLUDED.stories, pos = EXCLUDED.pos,
          neg = EXCLUDED.neg, resonance = EXCLUDED.resonance`
      : `
        INSERT INTO news_tag_daily (tag_id, day_msk, stories, pos, neg, resonance)
        SELECT t.tag_id,
               (n.published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date,
               COUNT(*),
               SUM(CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END),
               SUM(CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END),
               COALESCE(SUM(n.source_count), 0)
        FROM news n, LATERAL unnest(n.matched_tags) AS t(tag_id)
        WHERE (n.published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date >= (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date - 3
        GROUP BY 1, 2
        ON CONFLICT (tag_id, day_msk) DO UPDATE SET
          stories = EXCLUDED.stories, pos = EXCLUDED.pos,
          neg = EXCLUDED.neg, resonance = EXCLUDED.resonance`
    );

    // user_portfolio_daily: 3-day window
    const rPortfolio = await query(USE_SQLITE
      ? `
        INSERT INTO user_portfolio_daily (user_id, day_msk, stories, pos, neg, resonance)
        SELECT s.user_id, s.d, COUNT(*), SUM(s.pos), SUM(s.neg), COALESCE(SUM(s.resonance), 0)
        FROM (
          SELECT DISTINCT p.user_id,
                 date(datetime(n.published_at, '${sqliteOffset(DEFAULT_TZ)}')) AS d,
                 n.id,
                 CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END AS pos,
                 CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END AS neg,
                 n.source_count AS resonance
          FROM portfolios p
          JOIN news n ON EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value = p.tag_id)
          WHERE NOT p.is_frozen
            AND date(datetime(n.published_at, '${sqliteOffset(DEFAULT_TZ)}')) >= date(datetime('now', '${sqliteOffset(DEFAULT_TZ)}', '-3 days'))
        ) s
        GROUP BY 1, 2
        ON CONFLICT (user_id, day_msk) DO UPDATE SET
          stories = EXCLUDED.stories, pos = EXCLUDED.pos,
          neg = EXCLUDED.neg, resonance = EXCLUDED.resonance`
      : `
        INSERT INTO user_portfolio_daily (user_id, day_msk, stories, pos, neg, resonance)
        SELECT s.user_id, s.d, COUNT(*), SUM(s.pos), SUM(s.neg), COALESCE(SUM(s.resonance), 0)
        FROM (
          SELECT DISTINCT p.user_id,
                 (n.published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date AS d,
                 n.id,
                 CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END AS pos,
                 CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END AS neg,
                 n.source_count AS resonance
          FROM portfolios p
          JOIN news n ON n.matched_tags @> ARRAY[p.tag_id]::text[]
          WHERE NOT p.is_frozen
            AND (n.published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date >= (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date - 3
        ) s
        GROUP BY 1, 2
        ON CONFLICT (user_id, day_msk) DO UPDATE SET
          stories = EXCLUDED.stories, pos = EXCLUDED.pos,
          neg = EXCLUDED.neg, resonance = EXCLUDED.resonance`
    );

    // news_all_daily: 3-day window
    const rAll = await query(USE_SQLITE
      ? `
        INSERT INTO news_all_daily (day_msk, stories, pos, neg, resonance)
        SELECT date(datetime(published_at, '${sqliteOffset(DEFAULT_TZ)}')),
               COUNT(*),
               SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END),
               SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END),
               COALESCE(SUM(source_count), 0)
        FROM news
        WHERE date(datetime(published_at, '${sqliteOffset(DEFAULT_TZ)}')) >= date(datetime('now', '${sqliteOffset(DEFAULT_TZ)}', '-3 days'))
          AND json_array_length(matched_tags) > 0
        GROUP BY 1
        ON CONFLICT (day_msk) DO UPDATE SET
          stories = EXCLUDED.stories, pos = EXCLUDED.pos,
          neg = EXCLUDED.neg, resonance = EXCLUDED.resonance`
      : `
        INSERT INTO news_all_daily (day_msk, stories, pos, neg, resonance)
        SELECT (published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date,
               COUNT(*),
               SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END),
               SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END),
               COALESCE(SUM(source_count), 0)
        FROM news
        WHERE (published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date >= (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date - 3
          AND cardinality(matched_tags) > 0
        GROUP BY 1
        ON CONFLICT (day_msk) DO UPDATE SET
          stories = EXCLUDED.stories, pos = EXCLUDED.pos,
          neg = EXCLUDED.neg, resonance = EXCLUDED.resonance`
    );

    console.info(`[NewsHeatmap] freeze: done tag=${rTag.rowCount} portfolio=${rPortfolio.rowCount} all=${rAll.rowCount} duration_ms=${Date.now() - t0}`);
  } catch (e: any) {
    console.error('[NewsHeatmap] freeze: fail', e.message);
    throw e;
  }
}

