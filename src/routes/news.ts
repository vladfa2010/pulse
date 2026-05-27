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
    ? "published_at > datetime('now', '-90 days')"
    : "published_at > NOW() - INTERVAL '90 days'";
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
    const showAll = req.query.all === 'true';     // ← true = ВСЕ по тегам (read + unread)
    const history = req.query.history === 'true';  // ← true = только ПРОЧИТАННЫЕ по тегам
    const global = req.query.global === 'true';    // ← true = ВСЕ новости без фильтра тегов
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = (page - 1) * limit;

    const timeFilter = timeFilterSql();
    let articles: any[];
    let total: number;

    // ─── GLOBAL MODE: все новости без фильтра по тегам ──────────────────
    if (global) {
      const result = await query(
        `SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags,
                source_count, all_sources
         FROM news
         WHERE ${timeFilter}
         ORDER BY published_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      articles = result.rows;
      const countResult = await query(`SELECT COUNT(*) as c FROM news WHERE ${timeFilter}`, []);
      total = parseInt(countResult.rows[0]?.c || '0');

      res.json({ articles, total, page, hasMore: offset + articles.length < total });
      return;
    }

    // ─── Шаг 1: Теги пользователя ──────────────────────────────────────
    const portfolioResult = await query(
      'SELECT tag_id FROM portfolios WHERE user_id = $1',
      [userId]
    );
    const tagIds = portfolioResult.rows.map(r => r.tag_id);

    if (tagIds.length === 0) {
      return res.json({ articles: [], total: 0, page, hasMore: false });
    }

    if (USE_SQLITE) {
      // ─── SQLite версия ──────────────────────────────────────────────
      const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
      const likeParams = tagIds.map(id => `%"${id}"%`);

      // SQL часть: фильтр по прочтению
      // history=true → ТОЛЬКО прочитанные
      // showAll=true → ВСЕ (без фильтра)
      // default → ТОЛЬКО непрочитанные
      let readFilter: string;
      let readParams: any[];
      if (history) {
        readFilter = ' AND id IN (SELECT news_id FROM user_news_reads WHERE user_id = ?)';
        readParams = [userId];
      } else if (showAll) {
        readFilter = '';
        readParams = [];
      } else {
        readFilter = ' AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = ?)';
        readParams = [userId];
      }

      // Count
      const countResult = await query(
        `SELECT COUNT(*) as count FROM news
         WHERE (${conditions})${readFilter}
         AND ${timeFilter}`,
        [...likeParams, ...readParams]
      );
      total = parseInt(countResult.rows[0]?.count || '0');

      // Get (with source_count and all_sources)
      const orderDir = history ? 'ASC' : 'DESC';
      const result = await query(
        `SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags,
                source_count, all_sources
         FROM news
         WHERE (${conditions})${readFilter}
         AND ${timeFilter}
         ORDER BY published_at ${orderDir}
         LIMIT ? OFFSET ?`,
        [...likeParams, ...readParams, limit, offset]
      );
      articles = result.rows;
    } else {
      // ─── PostgreSQL версия ──────────────────────────────────────────
      // history=true → ТОЛЬКО прочитанные
      // showAll=true → ВСЕ (без фильтра)
      // default → ТОЛЬКО непрочитанные
      let pgReadFilter: string;
      let pgParams: any[];
      if (history) {
        pgReadFilter = ' AND id IN (SELECT news_id FROM user_news_reads WHERE user_id = $2)';
        pgParams = [tagIds, userId];
      } else if (showAll) {
        pgReadFilter = '';
        pgParams = [tagIds];
      } else {
        pgReadFilter = ' AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = $2)';
        pgParams = [tagIds, userId];
      }
      let pgIdx = pgParams.length + 1;

      // Count
      const countResult = await query(
        `SELECT COUNT(*) as count FROM news
         WHERE matched_tags && $1::text[]${pgReadFilter}
         AND ${timeFilter}`,
        pgParams
      );
      total = parseInt(countResult.rows[0]?.count || '0');

      // Get (with source_count and all_sources)
      // history → хронологический порядок (ASC), остальные → новые сверху (DESC)
      const pgOrder = history ? 'ASC' : 'DESC';
      const result = await query(
        `SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags,
                source_count, all_sources
         FROM news
         WHERE matched_tags && $1::text[]${pgReadFilter}
         AND ${timeFilter}
         ORDER BY published_at ${pgOrder}
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
    console.error('[News] Feed error:', err.message, err.stack?.substring(0, 200));
    res.status(500).json({ error: 'Failed to fetch news', details: err.message });
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
