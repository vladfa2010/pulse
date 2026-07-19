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
import { getCachedPopularTags, setCachedPopularTags } from '../utils/tagCache';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ─── SQL для фильтра по времени (90 дней) ─────────────────────────────────
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
// GET /api/news/global — ПУБЛИЧНАЯ общая лента (все новости, без auth)
// Используется третьей каруселью GlobalNewsCarousel.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/global', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = (page - 1) * limit;
    const timeFilter = timeFilterSql();

    const result = await query(
      `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags,
              tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug
       FROM news
       WHERE ${timeFilter}
       ORDER BY published_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const countResult = await query(`SELECT COUNT(*) as c FROM news WHERE ${timeFilter}`, []);
    const total = parseInt(countResult.rows[0]?.c || '0');

    res.json({ articles: result.rows, total, page, hasMore: offset + result.rows.length < total });
  } catch (err: any) {
    console.error('[News] Global error:', err.message);
    res.status(500).json({ error: 'Failed to fetch global news' });
  }
});

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

    // ─── GLOBAL MODE: все новости (включая без тегов) — Общая лента карусели 3
    // Показываем ВСЕ новости за 90 дней, без фильтра по тегам
    if (global) {
      const result = await query(
        `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags,
                tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug
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
      const orderDir = 'DESC'; // всегда новые сверху
      const result = await query(
        `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags,
                tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug
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
      const pgOrder = 'DESC'; // всегда новые сверху
      const result = await query(
        `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags,
                tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug
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
// POST /api/news/read-all — Отметить ВСЕ непрочитанные новости как прочитанные
// ═══════════════════════════════════════════════════════════════════════════
// Массовая версия POST /:id/read. Одним SQL-запросом помечает все новости,
// которые сейчас попадают в карусель "Это вы ещё не видели":
//   matched_tags && user_tags, за 90 дней, не в user_news_reads.
//
// Ответ: { success: true, marked: N } — сколько записей добавлено.
// Идемпотентен: повторный вызов → marked: 0.
router.post('/read-all', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    const portfolioResult = await query(
      'SELECT tag_id FROM portfolios WHERE user_id = $1',
      [userId]
    );
    const tagIds = portfolioResult.rows.map(r => r.tag_id);

    if (tagIds.length === 0) {
      return res.json({ success: true, marked: 0 });
    }

    let marked = 0;
    if (USE_SQLITE) {
      const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
      const likeParams = tagIds.map(id => `%"${id}"%`);
      const result = await query(
        `INSERT OR IGNORE INTO user_news_reads (user_id, news_id, read_at)
         SELECT ?, id, ${nowSql()}
         FROM news
         WHERE (${conditions})
           AND ${timeFilterSql()}
           AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = ?)`,
        [userId, ...likeParams, userId]
      );
      marked = (result as any).rowCount ?? 0;
    } else {
      const result = await query(
        `INSERT INTO user_news_reads (user_id, news_id, read_at)
         SELECT $1, id, ${nowSql()}
         FROM news
         WHERE matched_tags && $2::text[]
           AND ${timeFilterSql()}
           AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = $1)
         ON CONFLICT (user_id, news_id) DO NOTHING`,
        [userId, tagIds]
      );
      marked = (result as any).rowCount ?? 0;
    }

    console.log(`[News] Read-all: user=${userId} marked=${marked}`);
    res.json({ success: true, marked });
  } catch (err: any) {
    console.error('[News] Read-all error:', err.message);
    res.status(500).json({ error: 'Failed to mark all as read' });
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
// GET /api/news/tags/popular — ПУБЛИЧНЫЕ популярные теги с агрегатами
// ═══════════════════════════════════════════════════════════════════════════
router.get('/tags/popular', async (req, res) => {
  try {
    const rawPeriod = (req.query.period as string) || '24h';
    const period = ['24h', '7d', '30d'].includes(rawPeriod) ? rawPeriod : '24h';
    const limit = Math.min(parseInt(req.query.limit as string) || 15, 30);

    const cached = getCachedPopularTags(period, limit);
    if (cached) {
      return res.json({ tags: cached });
    }

    const periodCfg: Record<string, { orderCol: string }> = {
      '24h': { orderCol: 'articles_24h' },
      '7d': { orderCol: 'articles_7d' },
      '30d': { orderCol: 'articles_30d' },
    };
    const { orderCol } = periodCfg[period];

    const result = await query(
      `
      SELECT
        t.tag_id,
        t.tag_name,
        t.tag_type,
        COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > NOW() - INTERVAL '24 hours') as articles_24h,
        COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > NOW() - INTERVAL '7 days')  as articles_7d,
        COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > NOW() - INTERVAL '30 days') as articles_30d
      FROM user_defined_tags t
      LEFT JOIN news n ON t.tag_id = ANY(n.matched_tags) AND n.published_at > NOW() - INTERVAL '30 days'
      GROUP BY t.tag_id, t.tag_name, t.tag_type
      HAVING COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > NOW() - INTERVAL '24 hours') > 0
      ORDER BY ${orderCol} DESC
      LIMIT $1
      `,
      [limit]
    );

    const tags = result.rows.map((row: any) => ({
      tag_id: row.tag_id,
      tag_name: row.tag_name,
      tag_type: row.tag_type,
      news_count: parseInt(row[orderCol]) || 0,
      articles_24h: parseInt(row.articles_24h) || 0,
      articles_7d: parseInt(row.articles_7d) || 0,
      articles_30d: parseInt(row.articles_30d) || 0,
    }));

    setCachedPopularTags(period, limit, tags);
    res.json({ tags });
  } catch (err: any) {
    console.error('[News] Popular tags error:', err.message);
    res.status(500).json({ error: 'Failed to fetch popular tags' });
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
        `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags,
                tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug
         FROM news
         WHERE matched_tags LIKE $1 AND ${timeFilter}
         ORDER BY published_at DESC
         LIMIT 50`,
        [`%"${tagId}"%`]
      );
    } else {
      result = await query(
        `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags,
                tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug
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

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/news/search — поиск по словам в title/summary
// Параметры:
//   ?q=текст     — обязательный поисковый запрос
//   ?tag=tagId   — искать только внутри тега (опционально)
//   ?page=N      — пагинация (default: 1)
//   ?limit=N     — количество (default: 50, max: 100)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/search', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const q = (req.query.q as string || '').trim();
    const tagId = req.query.tag as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = (page - 1) * limit;

    if (!q) {
      return res.json({ articles: [], total: 0, page, hasMore: false });
    }

    const timeFilter = timeFilterSql();
    const likePattern = `%${escapeLikePattern(q)}%`;

    let articles: any[];
    let total: number;

    if (USE_SQLITE) {
      const tagCondition = tagId ? `matched_tags LIKE ? AND ` : '';
      const tagParams = tagId ? [`%"${tagId}"%`] : [];
      const searchCondition = `(LOWER(title_ru) LIKE LOWER(?) ESCAPE '\\' OR LOWER(title_original) LIKE LOWER(?) ESCAPE '\\' OR LOWER(summary_ru) LIKE LOWER(?) ESCAPE '\\' OR LOWER(summary_original) LIKE LOWER(?) ESCAPE '\\')`;

      const where = `${tagCondition}${timeFilter} AND ${searchCondition}`;
      const params = [...tagParams, likePattern, likePattern, likePattern, likePattern];

      const countResult = await query(
        `SELECT COUNT(*) as count FROM news WHERE ${where}`,
        params
      );
      total = parseInt(countResult.rows[0]?.count || '0');

      const result = await query(
        `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags, tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug
         FROM news
         WHERE ${where}
         ORDER BY published_at DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      articles = result.rows;
    } else {
      const tagCondition = tagId
        ? `($1 = ANY(matched_tags) OR matched_tags @> ARRAY[$1]::text[]) AND `
        : '';
      const tagParams = tagId ? [tagId] : [];
      const searchParamIndex = tagId ? '$2' : '$1';
      const searchCondition = `(title_ru ILIKE ${searchParamIndex} ESCAPE '\\' OR title_original ILIKE ${searchParamIndex} ESCAPE '\\' OR summary_ru ILIKE ${searchParamIndex} ESCAPE '\\' OR summary_original ILIKE ${searchParamIndex} ESCAPE '\\')`;

      const where = `${tagCondition}${timeFilter} AND ${searchCondition}`;
      const params = [...tagParams, likePattern];

      const countResult = await query(
        `SELECT COUNT(*) as count FROM news WHERE ${where}`,
        params
      );
      total = parseInt(countResult.rows[0]?.count || '0');

      const result = await query(
        `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags, tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug
         FROM news
         WHERE ${where}
         ORDER BY published_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      articles = result.rows;
    }

    res.json({
      articles,
      total,
      page,
      hasMore: offset + articles.length < total,
    });
  } catch (err: any) {
    console.error('[News] Search error:', err.message, err.stack?.substring(0, 200));
    res.status(500).json({ error: 'Failed to search news', details: err.message });
  }
});

// Escape LIKE wildcards to treat user input as literal text
function escapeLikePattern(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/news/by-slug/:slugOrId — загрузка новости по slug (fallback по id)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/by-slug/:slugOrId', async (req: AuthRequest, res) => {
  try {
    const { slugOrId } = req.params;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(slugOrId);

    const result = await query(
      `SELECT
        id, title_ru, summary_ru, title_original, summary_original, lang_original,
        source, source_id, url, published_at, fetched_at,
        sentiment, sentiment_score, sentiment_reasoning, sentiment_source,
        matched_tags, tag_impact, is_political, article_type,
        source_count, all_sources, fact_check_status, fact_check_result, slug
      FROM news
      WHERE slug = $1 ${isUuid ? 'OR id = $1::uuid' : ''}`,
      [slugOrId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'News not found' });
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    console.error('[News] By slug error:', err.message);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/news/by-slug/:slugOrId/tag-enrichments
// ═══════════════════════════════════════════════════════════════════════════
router.get('/by-slug/:slugOrId/tag-enrichments', async (req: AuthRequest, res) => {
  try {
    const { slugOrId } = req.params;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = uuidRegex.test(slugOrId);

    const newsResult = await query(
      `SELECT id, matched_tags, tag_impact FROM news WHERE slug = $1 ${isUuid ? 'OR id = $1::uuid' : ''}`,
      [slugOrId]
    );

    if (newsResult.rows.length === 0) {
      return res.status(404).json({ error: 'News not found' });
    }

    const matchedTags = newsResult.rows[0].matched_tags || [];
    const tagImpact = newsResult.rows[0].tag_impact || [];
    const allTagIds = new Set<string>(matchedTags);
    tagImpact.forEach((ti: any) => { if (ti.tag) allTagIds.add(ti.tag); });

    if (allTagIds.size === 0) {
      return res.json({ tags: [] });
    }

    const enrichResult = await query(
      `SELECT tag_id, tag_name, enriched_data
       FROM user_defined_tags
       WHERE tag_id = ANY($1::text[])`,
      [Array.from(allTagIds)]
    );

    const result = enrichResult.rows.map((row: any) => {
      const ed = row.enriched_data || {};
      return {
        tag_id: row.tag_id,
        tag_name: row.tag_name,
        ticker: ed.ticker || null,
        website: ed.website || null,
        description_ru: ed.description_ru || ed.description || null,
        key_products: ed.key_products || [],
        synonyms_en: ed.synonyms_en || [],
        synonyms_ru: ed.synonyms_ru || [],
        related_entities: ed.related_entities || [],
      };
    });

    res.json({ tags: result });
  } catch (err: any) {
    console.error('[TagEnrichments] By slug error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tag enrichments' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/news/:id/tag-enrichments — enriched data для всех тегов новости
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ ДОЛЖЕН идти ДО /:id — иначе Express сопоставит "123/tag-enrichments"
//    с /:id (id = "123/tag-enrichments") → 400 Invalid UUID
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id/tag-enrichments', async (req: AuthRequest, res) => {
  try {
    const newsId = req.params.id;

    // Валидация UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(newsId)) {
      return res.status(400).json({ error: 'Invalid news ID format' });
    }

    // Получаем matched_tags новости
    const newsResult = await query(
      `SELECT matched_tags, tag_impact FROM news WHERE id = $1`,
      [newsId]
    );

    if (newsResult.rows.length === 0) {
      return res.status(404).json({ error: 'News not found' });
    }

    const matchedTags = newsResult.rows[0].matched_tags || [];
    const tagImpact = newsResult.rows[0].tag_impact || [];

    // Собираем ВСЕ tag_id: из matched_tags + из tag_impact
    const allTagIds = new Set<string>(matchedTags);
    tagImpact.forEach((ti: any) => { if (ti.tag) allTagIds.add(ti.tag); });

    if (allTagIds.size === 0) {
      return res.json({ tags: [] });
    }

    // Получаем enriched_data для каждого тега
    const enrichResult = await query(
      `SELECT tag_id, tag_name, enriched_data
       FROM user_defined_tags
       WHERE tag_id = ANY($1::text[])`,
      [Array.from(allTagIds)]
    );

    const result = enrichResult.rows.map((row: any) => {
      const ed = row.enriched_data || {};
      return {
        tag_id: row.tag_id,
        tag_name: row.tag_name,
        ticker: ed.ticker || null,
        website: ed.website || null,
        description_ru: ed.description_ru || ed.description || null,
        key_products: ed.key_products || [],
        synonyms_en: ed.synonyms_en || [],
        synonyms_ru: ed.synonyms_ru || [],
        related_entities: ed.related_entities || [],
      };
    });

    res.json({ tags: result });
  } catch (err: any) {
    console.error('[TagEnrichments] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch tag enrichments' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/news/:id — детальная карточка новости
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const newsId = req.params.id;

    // Валидация UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(newsId)) {
      return res.status(400).json({ error: 'Invalid news ID format' });
    }

    const result = await query(
      `SELECT 
        id, title_ru, summary_ru, title_original, summary_original, lang_original,
        source, source_id, url, published_at, fetched_at,
        sentiment, sentiment_score, sentiment_reasoning, sentiment_source,
        matched_tags, tag_impact, is_political, article_type,
        source_count, all_sources, fact_check_status, fact_check_result, slug
      FROM news
      WHERE id = $1`,
      [newsId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'News not found' });
    }

    res.json(result.rows[0]);
  } catch (err: any) {
    console.error('[News] Get by ID error:', err.message);
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

export default router;
