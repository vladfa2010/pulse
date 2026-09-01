/**
 * One-off backfill for news heatmap aggregate tables (TZ 11.11).
 *
 * Run: npx ts-node --transpile-only src/scripts/backfillNewsHeatmap.ts
 *
 * Fills:
 *   - news_tag_daily     (last 12 months)
 *   - news_all_daily     (last 12 months)
 *   - user_portfolio_daily (last 12 months for all users)
 */

import { query } from '../config/db';
import {
  DEFAULT_TZ,
  WEEKS,
  sqliteOffset,
  portfolioKey,
} from '../services/heatmap/utils';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

async function backfill(): Promise<void> {
  console.log('[Backfill] Starting news heatmap backfill...');
  const t0 = Date.now();

  if (USE_SQLITE) {
    await backfillSQLite();
  } else {
    await backfillPG();
  }

  console.log(`[Backfill] Done in ${Date.now() - t0}ms`);
  process.exit(0);
}

async function backfillPG(): Promise<void> {
  console.log('[Backfill] PostgreSQL mode');

  // news_tag_daily
  console.log('[Backfill] Filling news_tag_daily...');
  const tagRes = await query(`
    INSERT INTO news_tag_daily (tag_id, day_msk, stories, pos, neg, resonance)
    SELECT t.tag_id,
           (n.published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date,
           COUNT(*),
           SUM(CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END),
           SUM(CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END),
           COALESCE(SUM(n.source_count), 0)
    FROM news n, LATERAL unnest(n.matched_tags) AS t(tag_id)
    WHERE (n.published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date >= (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date - ${WEEKS * 7}
      AND cardinality(n.matched_tags) > 0
    GROUP BY 1, 2
    ON CONFLICT (tag_id, day_msk) DO UPDATE SET
      stories = EXCLUDED.stories,
      pos = EXCLUDED.pos,
      neg = EXCLUDED.neg,
      resonance = EXCLUDED.resonance
  `);
  console.log(`[Backfill] news_tag_daily rows: ${tagRes.rowCount}`);

  // news_all_daily
  console.log('[Backfill] Filling news_all_daily...');
  const allRes = await query(`
    INSERT INTO news_all_daily (day_msk, stories, pos, neg, resonance)
    SELECT (published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date,
           COUNT(*),
           SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END),
           SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END),
           COALESCE(SUM(source_count), 0)
    FROM news
    WHERE (published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date >= (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date - ${WEEKS * 7}
      AND cardinality(matched_tags) > 0
    GROUP BY 1
    ON CONFLICT (day_msk) DO UPDATE SET
      stories = EXCLUDED.stories,
      pos = EXCLUDED.pos,
      neg = EXCLUDED.neg,
      resonance = EXCLUDED.resonance
  `);
  console.log(`[Backfill] news_all_daily rows: ${allRes.rowCount}`);

  // user_portfolio_daily
  console.log('[Backfill] Filling user_portfolio_daily...');
  const portfolioRes = await query(`
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
        AND (n.published_at AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date >= (NOW() AT TIME ZONE 'UTC' AT TIME ZONE '${DEFAULT_TZ}')::date - ${WEEKS * 7}
    ) s
    GROUP BY 1, 2
    ON CONFLICT (user_id, day_msk) DO UPDATE SET
      stories = EXCLUDED.stories,
      pos = EXCLUDED.pos,
      neg = EXCLUDED.neg,
      resonance = EXCLUDED.resonance
  `);
  console.log(`[Backfill] user_portfolio_daily rows: ${portfolioRes.rowCount}`);

  // Update meta hashes for all users (SHA-256 в Node — формат совпадает с portfolioKey()).
  console.log('[Backfill] Updating portfolio meta hashes...');
  const users = await query(`SELECT DISTINCT user_id FROM portfolios WHERE NOT is_frozen`);
  for (const row of users.rows) {
    const tags = await query(
      `SELECT tag_id FROM portfolios WHERE user_id = $1 AND NOT is_frozen ORDER BY tag_id`,
      [row.user_id]
    );
    const hash = portfolioKey(tags.rows.map((r: any) => r.tag_id));
    await query(
      `INSERT INTO user_portfolio_daily_meta (user_id, tags_hash, rebuilt_at) VALUES ($1::uuid, $2, NOW())
       ON CONFLICT (user_id) DO UPDATE SET tags_hash = EXCLUDED.tags_hash, rebuilt_at = EXCLUDED.rebuilt_at`,
      [row.user_id, hash]
    );
  }
  console.log('[Backfill] Portfolio meta hashes updated');
}

async function backfillSQLite(): Promise<void> {
  console.log('[Backfill] SQLite mode');
  const offset = sqliteOffset(DEFAULT_TZ);

  // news_tag_daily
  console.log('[Backfill] Filling news_tag_daily...');
  const tagRes = await query(`
    INSERT INTO news_tag_daily (tag_id, day_msk, stories, pos, neg, resonance)
    SELECT je.value AS tag_id,
           date(datetime(n.published_at, '${offset}')),
           COUNT(*),
           SUM(CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END),
           SUM(CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END),
           COALESCE(SUM(n.source_count), 0)
    FROM news n, json_each(n.matched_tags) je
    WHERE date(datetime(n.published_at, '${offset}')) >= date(datetime('now', '${offset}', '-${WEEKS * 7} days'))
      AND json_array_length(n.matched_tags) > 0
    GROUP BY 1, 2
    ON CONFLICT (tag_id, day_msk) DO UPDATE SET
      stories = EXCLUDED.stories,
      pos = EXCLUDED.pos,
      neg = EXCLUDED.neg,
      resonance = EXCLUDED.resonance
  `);
  console.log(`[Backfill] news_tag_daily rows: ${tagRes.rowCount}`);

  // news_all_daily
  console.log('[Backfill] Filling news_all_daily...');
  const allRes = await query(`
    INSERT INTO news_all_daily (day_msk, stories, pos, neg, resonance)
    SELECT date(datetime(published_at, '${offset}')),
           COUNT(*),
           SUM(CASE WHEN sentiment='positive' THEN 1 ELSE 0 END),
           SUM(CASE WHEN sentiment='negative' THEN 1 ELSE 0 END),
           COALESCE(SUM(source_count), 0)
    FROM news
    WHERE date(datetime(published_at, '${offset}')) >= date(datetime('now', '${offset}', '-${WEEKS * 7} days'))
      AND json_array_length(matched_tags) > 0
    GROUP BY 1
    ON CONFLICT (day_msk) DO UPDATE SET
      stories = EXCLUDED.stories,
      pos = EXCLUDED.pos,
      neg = EXCLUDED.neg,
      resonance = EXCLUDED.resonance
  `);
  console.log(`[Backfill] news_all_daily rows: ${allRes.rowCount}`);

  // user_portfolio_daily
  console.log('[Backfill] Filling user_portfolio_daily...');
  const portfolioRes = await query(`
    INSERT INTO user_portfolio_daily (user_id, day_msk, stories, pos, neg, resonance)
    SELECT s.user_id, s.d, COUNT(*), SUM(s.pos), SUM(s.neg), COALESCE(SUM(s.resonance), 0)
    FROM (
      SELECT DISTINCT p.user_id,
             date(datetime(n.published_at, '${offset}')) AS d,
             n.id,
             CASE WHEN n.sentiment='positive' THEN 1 ELSE 0 END AS pos,
             CASE WHEN n.sentiment='negative' THEN 1 ELSE 0 END AS neg,
             n.source_count AS resonance
      FROM portfolios p
      JOIN news n ON EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value = p.tag_id)
      WHERE NOT p.is_frozen
        AND date(datetime(n.published_at, '${offset}')) >= date(datetime('now', '${offset}', '-${WEEKS * 7} days'))
    ) s
    GROUP BY 1, 2
    ON CONFLICT (user_id, day_msk) DO UPDATE SET
      stories = EXCLUDED.stories,
      pos = EXCLUDED.pos,
      neg = EXCLUDED.neg,
      resonance = EXCLUDED.resonance
  `);
  console.log(`[Backfill] user_portfolio_daily rows: ${portfolioRes.rowCount}`);

  // Update meta hashes for all users (SHA-256 в Node — формат совпадает с portfolioKey()).
  console.log('[Backfill] Updating portfolio meta hashes...');
  const users = await query(`SELECT DISTINCT user_id FROM portfolios WHERE NOT is_frozen`);
  for (const row of users.rows) {
    const tags = await query(`SELECT tag_id FROM portfolios WHERE user_id = ? AND NOT is_frozen ORDER BY tag_id`, [row.user_id]);
    const hash = portfolioKey(tags.rows.map((r: any) => r.tag_id));
    await query(
      `INSERT OR REPLACE INTO user_portfolio_daily_meta (user_id, tags_hash, rebuilt_at) VALUES (?, ?, datetime('now'))`,
      [row.user_id, hash]
    );
  }
  console.log('[Backfill] Portfolio meta hashes updated');
}

backfill().catch((err) => {
  console.error('[Backfill] Fatal error:', err);
  process.exit(1);
});
