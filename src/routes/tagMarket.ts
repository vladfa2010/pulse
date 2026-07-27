import { Router } from 'express';
import { adminMiddleware } from './admin';
import { query } from '../config/db';

const USE_SQLITE = process.env.NODE_ENV !== 'production' && !process.env.DATABASE_URL;

const router = Router();

/**
 * GET /admin/tags/:tagId/news-daily
 * Возвращает количество новостей, привязанных к тегу, по каждому дню (MSK).
 * Период: last N days (default 90).
 */
router.get('/news-daily', adminMiddleware, async (req, res) => {
  try {
    const { tagId } = req.params;
    const days = Math.min(parseInt(req.query.days as string, 10) || 90, 365);

    if (!tagId) {
      return res.status(400).json({ error: 'tagId is required' });
    }

    let sql: string;
    let params: any[];

    if (USE_SQLITE) {
      // SQLite: конвертируем UTC в MSK (+3 часа) через datetime(..., '+3 hours')
      sql = `
        SELECT
          date(datetime(published_at, '+3 hours')) AS day,
          COUNT(*) AS count
        FROM articles
        WHERE status = 'published'
          AND published_at >= datetime('now', '-${days} days', '+3 hours')
          AND (
            matched_tags LIKE ?
            OR matched_tags LIKE ?
            OR matched_tags LIKE ?
            OR matched_tags = ?
          )
        GROUP BY date(datetime(published_at, '+3 hours'))
        ORDER BY day ASC
      `;
      params = [
        `%"${tagId}"%`,
        `%[${tagId},%`,
        `%,${tagId}]%`,
        tagId,
      ];
    } else {
      // PostgreSQL
      sql = `
        SELECT
          (published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date AS day,
          COUNT(*) AS count
        FROM articles
        WHERE status = 'published'
          AND published_at >= NOW() - INTERVAL '${days} days'
          AND $1 = ANY(matched_tags)
        GROUP BY (published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date
        ORDER BY day ASC
      `;
      params = [tagId];
    }

    const result = await query(sql, params);
    const rows = result.rows || [];

    const data = rows.map((r: any) => ({
      day: r.day,
      count: Number(r.count),
    }));

    return res.json({ tagId, days, data });
  } catch (err: any) {
    console.error('[TagMarket] news-daily error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err?.message });
  }
});

/**
 * GET /admin/tags/:tagId/articles-by-day?date=YYYY-MM-DD
 * Возвращает список новостей за конкретный день (MSK) для тега.
 */
router.get('/articles-by-day', adminMiddleware, async (req, res) => {
  try {
    const { tagId } = req.params;
    const { date } = req.query;

    if (!tagId || !date || typeof date !== 'string') {
      return res.status(400).json({ error: 'tagId and date (YYYY-MM-DD) are required' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    let sql: string;
    let params: any[];

    if (USE_SQLITE) {
      // MSK day bounds: date 00:00 - 23:59:59 MSK => UTC -3h
      sql = `
        SELECT
          id,
          title,
          slug,
          source,
          url,
          published_at,
          sentiment,
          summary,
          matched_tags
        FROM articles
        WHERE status = 'published'
          AND matched_tags IS NOT NULL
          AND (
            matched_tags LIKE ?
            OR matched_tags LIKE ?
            OR matched_tags LIKE ?
            OR matched_tags = ?
          )
          AND datetime(published_at, '+3 hours') >= datetime(?, 'start of day', '-3 hours')
          AND datetime(published_at, '+3 hours') < datetime(?, 'start of day', '+1 day', '-3 hours')
        ORDER BY published_at ASC
      `;
      params = [
        `%"${tagId}"%`,
        `%[${tagId},%`,
        `%,${tagId}]%`,
        tagId,
        `${date}T00:00:00`,
        `${date}T00:00:00`,
      ];
    } else {
      sql = `
        SELECT
          id,
          title,
          slug,
          source,
          url,
          published_at,
          sentiment,
          summary,
          matched_tags
        FROM articles
        WHERE status = 'published'
          AND $1 = ANY(matched_tags)
          AND (published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date = $2::date
        ORDER BY published_at ASC
      `;
      params = [tagId, date];
    }

    const result = await query(sql, params);
    const rows = result.rows || [];

    return res.json({ tagId, date, articles: rows });
  } catch (err: any) {
    console.error('[TagMarket] articles-by-day error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err?.message });
  }
});

export default router;
