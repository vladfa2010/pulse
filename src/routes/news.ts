import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';

const router = Router();

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

    // Build query — find news matching any user tag
    let sql = `
      SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags
      FROM news
      WHERE matched_tags && $1::text[]
    `;
    const params: any[] = [tagIds];

    if (since) {
      sql += ` AND published_at > $2`;
      params.push(since);
    }

    // Count total
    const countResult = await query(
      sql.replace('SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags', 'SELECT COUNT(*)') + ` AND published_at > NOW() - INTERVAL '14 days'`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results
    sql += ` AND published_at > NOW() - INTERVAL '14 days'
      ORDER BY published_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const result = await query(sql, params);

    // Update last_connected_at
    await query(
      `INSERT INTO user_sessions (user_id, last_connected_at)
       VALUES ($1, NOW())
       ON CONFLICT (user_id) DO UPDATE SET last_connected_at = NOW()`,
      [userId]
    );

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
    const result = await query(
      `SELECT title_ru, summary_ru, source, url, published_at, sentiment
       FROM news
       WHERE $1 = ANY(matched_tags)
       AND published_at > NOW() - INTERVAL '14 days'
       ORDER BY published_at DESC
       LIMIT 50`,
      [tagId]
    );
    res.json({ articles: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tag news' });
  }
});

export default router;
