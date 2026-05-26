/**
 * =============================================================================
 * PULSE — News Routes (Лента новостей)
 * =============================================================================
 *
 * КЛЮЧЕВАЯ ЛОГИКА: показывать ТОЛЬКО непрочитанные новости.
 *
 * Как это работает:
 *   1. Пользователь открывает ленту → GET /api/news
 *   2. Бэкенд ищет новости по тегам пользователя
 *   3. ИСКЛЮЧАЕТ новости из user_news_reads (уже просмотренные)
 *   4. Возвращает только свежие + непрочитанные
 *
 * Когда новость считается "прочитанной":
 *   - Frontend посылает POST /api/news/:id/read после того,
 *     как пользователь увидел новость (on scroll into view)
 *   - Или при клике на карточку
 *
 * Эндпоинты:
 *   GET  /api/news?all=true  → Лента (ВСЕ новости — для обучения в /feed)
 *   GET  /api/news           → Лента (только НЕПРОЧИТАННЫЕ — для главной)
 *   POST /api/news/:id/read  → Отметить как прочитанную
 *   GET  /api/news/tags/:id  → Новости по конкретному тегу
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ─── SQL для фильтра по времени (14 дней) ─────────────────────────────────
function timeFilterSql(): string {
  return USE_SQLITE
    ? "published_at > datetime('now', '-14 days')"
    : "published_at > NOW() - INTERVAL '14 days'";
}

// ─── SQL для текущего времени ─────────────────────────────────────────────
function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/news — ЛЕНТА НОВОСТЕЙ
// ═══════════════════════════════════════════════════════════════════════════
// Параметры:
//   ?all=true    → ВСЕ новости (read + unread) — для страницы /feed
//   (без all)    → Только НЕПРОЧИТАННЫЕ — для главной "Это вы ещё не видели"
//   ?page=N      → Пагинация (default: 1)
//   ?limit=N     → Количество (default: 50, max: 100)
//
// Логика:
//   1. Получаем теги пользователя из portfolios
//   2. Ищем новости за 14 дней WHERE matched_tags && user_tags
//   3. Если ?all не задан → ИСКЛЮЧАЕМ прочитанные (user_news_reads)
//   4. ORDER BY published_at DESC LIMIT 50
router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const showAll = req.query.all === 'true';  // ← true = показать ВСЕ (для /feed)
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = (page - 1) * limit;

    // ─── Шаг 1: Теги пользователя ──────────────────────────────────────
    const portfolioResult = await query(
      'SELECT tag_id FROM portfolios WHERE user_id = $1',
      [userId]
    );
    const tagIds = portfolioResult.rows.map(r => r.tag_id);

    if (tagIds.length === 0) {
      return res.json({ articles: [], total: 0, page, hasMore: false });
    }

    const timeFilter = timeFilterSql();
    let articles: any[];
    let total: number;

    if (USE_SQLITE) {
      // ─── SQLite версия ──────────────────────────────────────────────
      const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
      const likeParams = tagIds.map(id => `%"${id}"%`);

      // SQL часть: исключение прочитанных (если showAll=false)
      const excludeRead = showAll ? '' : ' AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = ?)';
      const excludeParams = showAll ? [] : [userId];

      // Count
      const countResult = await query(
        `SELECT COUNT(*) as count FROM news
         WHERE (${conditions})${excludeRead}
         AND ${timeFilter}`,
        [...likeParams, ...excludeParams]
      );
      total = parseInt(countResult.rows[0]?.count || '0');

      // Get
      const result = await query(
        `SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags
         FROM news
         WHERE (${conditions})${excludeRead}
         AND ${timeFilter}
         ORDER BY published_at DESC
         LIMIT ? OFFSET ?`,
        [...likeParams, ...excludeParams, limit, offset]
      );
      articles = result.rows;
    } else {
      // ─── PostgreSQL версие ──────────────────────────────────────────
      const excludeRead = showAll ? '' : ' AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = $2)';
      const pgParams: any[] = showAll ? [tagIds] : [tagIds, userId];
      let pgIdx = showAll ? 2 : 3;

      // Count
      const countResult = await query(
        `SELECT COUNT(*) as count FROM news
         WHERE matched_tags && $1::text[]${excludeRead}
         AND ${timeFilter}`,
        pgParams
      );
      total = parseInt(countResult.rows[0]?.count || '0');

      // Get
      const result = await query(
        `SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags
         FROM news
         WHERE matched_tags && $1::text[]${excludeRead}
         AND ${timeFilter}
         ORDER BY published_at DESC
         LIMIT $${pgIdx} OFFSET $${pgIdx + 1}`,
        [...pgParams, limit, offset]
      );
      articles = result.rows;
    }

    // ─── Обновляем last_connected_at ────────────────────────────────────
    if (USE_SQLITE) {
      await query(
        `INSERT OR REPLACE INTO user_sessions (id, user_id, last_connected_at)
         VALUES ((SELECT id FROM user_sessions WHERE user_id = $1), $1, ${nowSql()})`,
        [userId, userId]
      );
    } else {
      await query(
        `INSERT INTO user_sessions (user_id, last_connected_at)
         VALUES ($1, ${nowSql()})
         ON CONFLICT (user_id) DO UPDATE SET last_connected_at = ${nowSql()}`,
        [userId]
      );
    }

    res.json({
      articles,
      total,
      page,
      hasMore: offset + articles.length < total,
    });
  } catch (err: any) {
    console.error('[News] Feed error:', err.message);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/news/:id/read — Отметить новость как прочитанную
// ═══════════════════════════════════════════════════════════════════════════
// Фронтенд вызывает этот endpoint когда:
//   - Новость появилась в viewport (IntersectionObserver)
//   - Или пользователь кликнул на карточку
//
// После этого новость НЕ будет показываться в ленте (исключается через
// user_news_reads в GET /api/news).
router.post('/:id/read', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const newsId = req.params.id;

    // UPSERT: если запись уже есть — не падаем с ошибкой
    if (USE_SQLITE) {
      await query(
        `INSERT OR IGNORE INTO user_news_reads (user_id, news_id, read_at)
         VALUES ($1, $2, ${nowSql()})`,
        [userId, newsId]
      );
    } else {
      await query(
        `INSERT INTO user_news_reads (user_id, news_id, read_at)
         VALUES ($1, $2, ${nowSql()})
         ON CONFLICT (user_id, news_id) DO NOTHING`,
        [userId, newsId]
      );
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error('[News] Mark read error:', err.message);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/news/tags/:tagId — Новости по конкретному тегу (без auth)
// ═══════════════════════════════════════════════════════════════════════════
// Публичный endpoint — показывает последние 50 новостей по тегу.
// НЕ фильтрует прочитанные (публичная страница).
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
