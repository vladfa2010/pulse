import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Build WHERE clause for tag matching
function buildTagWhere(tagIds: string[]): { clause: string; params: any[] } {
  if (USE_SQLITE) {
    // SQLite: matched_tags stored as JSON text, use LIKE
    const conditions = tagIds.map((_, i) => `matched_tags LIKE $${i + 1}`);
    return {
      clause: '(' + conditions.join(' OR ') + ')',
      params: tagIds.map(id => `%"${id}"%`),
    };
  }
  // PostgreSQL: native array support
  return {
    clause: 'matched_tags && $1::text[]',
    params: [tagIds],
  };
}

// Time filter SQL
function timeFilterSql(): string {
  if (USE_SQLITE) {
    return "published_at > datetime('now', '-14 days')";
  }
  return "published_at > NOW() - INTERVAL '14 days'";
}

// Current timestamp SQL
function nowSql(): string {
  if (USE_SQLITE) {
    return "datetime('now')";
  }
  return 'NOW()';
}

// GET /api/news — get fresh news for user
router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const since = req.query.since as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = (page - 1) * limit;

    // Get user tags
    const portfolioResult = await query(
      'SELECT tag_id FROM portfolios WHERE user_id = $1',
      [userId]
    );
    const tagIds = portfolioResult.rows.map(r => r.tag_id);

    if (tagIds.length === 0) {
      return res.json({ articles: [], total: 0, page, hasMore: false });
    }

    const tagWhere = buildTagWhere(tagIds);
    const timeFilter = timeFilterSql();

    // Build params
    const params: any[] = [...tagWhere.params];
    let paramIdx = params.length + 1;

    let sql = `
      SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags
      FROM news
      WHERE ${tagWhere.clause}
    `;

    if (since) {
      sql += ` AND published_at > $${paramIdx}`;
      params.push(since);
      paramIdx++;
    }

    // Count total
    const countSql = sql.replace(
      'SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags',
      'SELECT COUNT(*) as count'
    ) + ` AND ${timeFilter}`;

    const countResult = await query(countSql, params);
    const total = parseInt(countResult.rows[0]?.count || '0');

    // Get paginated results
    sql += ` AND ${timeFilter}
      ORDER BY published_at DESC
      LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    // Update last_connected_at
    if (USE_SQLITE) {
      await query(
        `INSERT OR REPLACE INTO user_sessions (id, user_id, last_connected_at)
         VALUES ((SELECT id FROM user_sessions WHERE user_id = $1), $1, ${nowSql()})`,
        [userId]
      );
    } else {
      await query(
        `INSERT INTO user_sessions (user_id, last_connected_at)
         VALUES ($1, ${nowSql()})
         ON CONFLICT (user_id) DO UPDATE SET last_connected_at = ${nowSql()}`,
        [userId]
      );
    }

    // Increment news_count
    await query(
      'UPDATE users SET news_count = news_count + $1 WHERE id = $2',
      [result.rows.length, userId]
    );

    res.json({
      articles: result.rows,
      total,
      page,
      hasMore: offset + result.rows.length < total,
    });
  } catch (err) {
    console.error('News fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// GET /api/news/tags/:tagId — news for specific tag
router.get('/tags/:tagId', async (req, res) => {
  try {
    const { tagId } = req.params;
    const timeFilter = timeFilterSql();

    let result;
    if (USE_SQLITE) {
      result = await query(
        `SELECT title_ru, summary_ru, source, url, published_at, sentiment
         FROM news
         WHERE matched_tags LIKE $1 AND ${timeFilter}
         ORDER BY published_at DESC
         LIMIT 50`,
        [`%"${tagId}"%`]
      );
    } else {
      result = await query(
        `SELECT title_ru, summary_ru, source, url, published_at, sentiment
         FROM news
         WHERE $1 = ANY(matched_tags)
         AND ${timeFilter}
         ORDER BY published_at DESC
         LIMIT 50`,
        [tagId]
      );
    }

    res.json({ articles: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tag news' });
  }
});

export default router;
