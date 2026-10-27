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
import { popularTagsCached } from '../utils/tagCache';
import { computePopularTags } from '../services/popularTags';
import { markAllNewsAsRead, timeFilterSql } from '../services/newsReads';
import { embedBatch } from '../services/embeddings';
import { nowSql } from '../utils/nowSql';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ТЗ-161: интерактивный семантический поиск не ждёт батч-крон TEI
// (внутренний таймаут embedBatch — 600 с). 27.10: 5 → 15 с — при RAYON=1
// одиночный embed в TEI занимает 4–6 с + очередь (см. docs/embeddings.md,
// трейд-off 14.10); 5 с гасили семантическую ветку в пике (5 фолбэков/24ч).
// Переопределяется env SEMANTIC_SEARCH_TIMEOUT_MS.
const SEMANTIC_SEARCH_TIMEOUT_MS = parseInt(process.env.SEMANTIC_SEARCH_TIMEOUT_MS || '15000', 10);

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

    // TZ-37: запрашиваем limit+1 строк — наличие лишней строки = hasMore.
    // COUNT(*) убран: фронт не использует total, а COUNT по 90 дням — дорогой index-only scan.
    //
    // ТЗ-99: каскадные поля (cluster_*) через CTE ranked — позиция новости в кластере.
    // CTE считается один раз на запрос поверх кластеризованных новостей (мс).
    const result = await query(
      `WITH ranked AS (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY published_at)::int AS cluster_position
         FROM news
         WHERE cluster_id IS NOT NULL
       )
       SELECT n.id, n.title_ru, n.title_original, n.summary_ru, n.summary_original, n.source, n.url, n.published_at, n.sentiment, n.sentiment_score, n.sentiment_reasoning, n.sentiment_source, n.is_political, n.article_type, n.matched_tags,
              n.tag_impact, n.source_count, n.all_sources, n.fact_check_status, n.fact_check_result, n.slug,
              n.cluster_id,
              c.size AS cluster_size,
              c.last_seen_at AS cluster_last_seen_at,
              c.last_seen_at > now() - interval '2 hours' AS cluster_growing,
              r.cluster_position,
              CASE WHEN n.cluster_id IS NULL AND n.embedding IS NULL THEN TRUE ELSE FALSE END AS cluster_pending
       FROM news n
       LEFT JOIN clusters c ON c.id = n.cluster_id
       LEFT JOIN ranked r ON r.id = n.id
       WHERE ${timeFilter}
       ORDER BY n.published_at DESC
       LIMIT $1 OFFSET $2`,
      [limit + 1, offset]
    );

    const hasMore = result.rows.length > limit;
    const articles = hasMore ? result.rows.slice(0, limit) : result.rows;

    res.json({ articles, total: null, page, hasMore });
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
//   2. Ищем новости за 90 дней (timeFilterSql) WHERE matched_tags && user_tags
//   3. Если ?all не задан → ИСКЛЮЧАЕМ прочитанные (user_news_reads)
//   4. ORDER BY published_at DESC LIMIT 50
router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const showAll = req.query.all === 'true';     // ← true = ВСЕ по тегам (read + unread)
    const history = req.query.history === 'true';  // ← true = только ПРОЧИТАННЫЕ по тегам
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = (page - 1) * limit;

    const timeFilter = timeFilterSql();
    let articles: any[];
    let hasMore = false;

    // ─── Шаг 1: Теги пользователя (только активные, не замороженные) ───
    const portfolioResult = await query(
      `SELECT tag_id FROM portfolios WHERE user_id = $1 AND is_frozen = ${USE_SQLITE ? '0' : 'FALSE'}`,
      [userId]
    );
    const tagIds = portfolioResult.rows.map(r => r.tag_id);

    if (tagIds.length === 0) {
      return res.json({ articles: [], total: null, page, hasMore: false });
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
        readFilter = ' AND NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = ? AND r.news_id = news.id)';
        readParams = [userId];
      }

      // TZ-40: limit+1 вместо COUNT(*) — total никто не читает (проверено по фронту),
      // COUNT по 90 дням с LIKE-фильтром и подзапросом user_news_reads — лишняя работа на каждой странице.
      const orderDir = 'DESC'; // всегда новые сверху
      const result = await query(
        `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags,
                tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug,
                NULL AS cluster_id, NULL AS cluster_size, NULL AS cluster_position, NULL AS cluster_last_seen_at, 0 AS cluster_growing, 0 AS cluster_pending
         FROM news
         WHERE (${conditions})${readFilter}
         AND ${timeFilter}
         ORDER BY published_at ${orderDir}
         LIMIT ? OFFSET ?`,
        [...likeParams, ...readParams, limit + 1, offset]
      );
      hasMore = result.rows.length > limit;
      articles = hasMore ? result.rows.slice(0, limit) : result.rows;
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
        pgReadFilter = ' AND NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = $2 AND r.news_id = news.id)';
        pgParams = [tagIds, userId];
      }
      let pgIdx = pgParams.length + 1;

      // TZ-40: limit+1 вместо COUNT(*) — total никто не читает (проверено по фронту),
      // COUNT по 90 дням с GIN-фильтром и подзапросом user_news_reads — лишняя работа на каждой странице.
      //
      // TZ-7.3: двухстадийный запрос. Внутренний SELECT тянет только id (узкий, GIN+anti-join,
      // доказано EXPLAIN на проде: 905ms cold). Внешний джойн дочитывает широкие колонки
      // (summary_ru, tag_impact, fact_check_result и пр.) только для limit+1 отобранных строк —
      // раньше они вычитывались с диска для всех ~3757 кандидатов, отсюда 7–16s на ленте.
      const pgOrder = 'DESC'; // всегда новые сверху
      //
      // ТЗ-99: каскадные поля добавлены во ВНЕШНИЙ select (внутренний узкий id-select
      // TZ-7.3 не трогаем). CTE ranked — позиция новости внутри кластера.
      const result = await query(
        `WITH ranked AS (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY published_at)::int AS cluster_position
           FROM news
           WHERE cluster_id IS NOT NULL
         )
         SELECT n.id, n.title_ru, n.title_original, n.summary_ru, n.summary_original, n.source, n.url, n.published_at, n.sentiment, n.sentiment_score, n.sentiment_reasoning, n.sentiment_source, n.is_political, n.article_type, n.matched_tags,
                n.tag_impact, n.source_count, n.all_sources, n.fact_check_status, n.fact_check_result, n.slug,
                n.cluster_id,
                c.size AS cluster_size,
                c.last_seen_at AS cluster_last_seen_at,
                c.last_seen_at > now() - interval '2 hours' AS cluster_growing,
                r.cluster_position,
                CASE WHEN n.cluster_id IS NULL AND n.embedding IS NULL THEN TRUE ELSE FALSE END AS cluster_pending
         FROM news n
         LEFT JOIN clusters c ON c.id = n.cluster_id
         LEFT JOIN ranked r ON r.id = n.id
         JOIN (
           SELECT id FROM news
           WHERE matched_tags && $1::text[]${pgReadFilter}
           AND ${timeFilter}
           -- TZ-7.4: (published_at + INTERVAL '0 seconds') вместо published_at.
           -- Значение идентично, но планировщик не может использовать idx_news_published_at
           -- для сортировки — иначе он выбирает Index Scan Backward по датам с фильтром
           -- matched_tags на каждой строке (на проде: 122k строк отфильтровано, 7.5s)
           -- вместо GIN BitmapAnd (0.97s). Измерено EXPLAIN ANALYZE на проде.
           ORDER BY (published_at + INTERVAL '0 seconds') ${pgOrder}
           LIMIT $${pgIdx} OFFSET $${pgIdx + 1}
         ) t ON t.id = n.id
         ORDER BY n.published_at ${pgOrder}`,
        [...pgParams, limit + 1, offset]
      );
      hasMore = result.rows.length > limit;
      articles = hasMore ? result.rows.slice(0, limit) : result.rows;
    }

    res.json({
      articles,
      total: null,
      page,
      hasMore,
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
    const marked = await markAllNewsAsRead(userId);
    console.log(`[News] Read-all: user=${userId} marked=${marked}`);
    res.json({ success: true, marked });
  } catch (err: any) {
    console.error('[News] Read-all error:', err.message);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/news/unread-count — реальное число непрочитанных (ТЗ-177)
// ═══════════════════════════════════════════════════════════════════════════
// Для счётчика «Прочитать всё» в карусели «Это вы ещё не видели»: показывает
// все непрочитанные, а не ≤20 первой страницы. Те же условия, что у списка
// выше: активные теги портфеля + timeFilterSql (90 дней) + anti-join
// user_news_reads. NOT EXISTS — как в списке (:147/:181): news_id формально
// nullable, NOT IN с NULL обнулил бы выборку. COUNT(*), а не limit+1, —
// отдельным эндпоинтом, чтобы TZ-40 (total: null) не трогать.
router.get('/unread-count', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const portfolioResult = await query(
      `SELECT tag_id FROM portfolios WHERE user_id = $1 AND is_frozen = ${USE_SQLITE ? '0' : 'FALSE'}`,
      [userId]
    );
    const tagIds = portfolioResult.rows.map(r => r.tag_id);
    if (tagIds.length === 0) return res.json({ count: 0 });

    if (USE_SQLITE) {
      const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
      const likeParams = tagIds.map(id => `%"${id}"%`);
      // Каст без `::int`: адаптер (db-sqlite.ts) конвертит только `::text[]`/`::jsonb`
      const result = await query(
        `SELECT COUNT(*) AS count FROM news
         WHERE (${conditions})
           AND ${timeFilterSql()}
           AND NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = ? AND r.news_id = news.id)`,
        [...likeParams, userId]
      );
      return res.json({ count: Number(result.rows[0]?.count ?? 0) });
    }

    const result = await query(
      `SELECT COUNT(*)::int AS count FROM news
       WHERE matched_tags && $1::text[]
         AND ${timeFilterSql()}
         AND NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = $2 AND r.news_id = news.id)`,
      [tagIds, userId]
    );
    res.json({ count: result.rows[0]?.count ?? 0 });
  } catch (err: any) {
    console.error('[News] unread-count error:', err.message);
    res.status(500).json({ error: 'Failed to fetch unread count' });
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
  const routeStart = Date.now();
  try {
    const rawPeriod = (req.query.period as string) || '24h';
    const period = ['24h', '7d', '30d'].includes(rawPeriod) ? rawPeriod : '24h';
    const limit = Math.min(parseInt(req.query.limit as string) || 15, 30);

    const tags = await popularTagsCached(period, limit, () => computePopularTags(period, limit));

    res.set('Cache-Control', 'public, max-age=60');
    res.json({ tags });
    console.log(`[PopularTagsRoute] total=${Date.now() - routeStart}ms key=${period}:${limit}`);
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
                tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug,
                NULL AS cluster_id, NULL AS cluster_size, NULL AS cluster_position, NULL AS cluster_last_seen_at, 0 AS cluster_growing, 0 AS cluster_pending
         FROM news
         WHERE matched_tags LIKE $1 AND ${timeFilter}
         ORDER BY published_at DESC
         LIMIT 50`,
        [`%"${tagId}"%`]
      );
    } else {
      // ТЗ-7.5.2: @> ARRAY[$1]::text[] (даёт idx_news_matched_tags_gin) +
      // выражение в ORDER BY — иначе Index Scan Backward по idx_news_published_at
      // с построчным ANY-фильтром (замер на проде: 6043 мс, 61k строк отфильтровано).
      //
      // ТЗ-99: каскадные поля (CTE ranked + join'ы).
      result = await query(
        `WITH ranked AS (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY published_at)::int AS cluster_position
           FROM news
           WHERE cluster_id IS NOT NULL
         )
         SELECT n.id, n.title_ru, n.title_original, n.summary_ru, n.summary_original, n.source, n.url, n.published_at, n.sentiment, n.sentiment_score, n.sentiment_reasoning, n.sentiment_source, n.is_political, n.article_type, n.matched_tags,
                n.tag_impact, n.source_count, n.all_sources, n.fact_check_status, n.fact_check_result, n.slug,
                n.cluster_id,
                c.size AS cluster_size,
                c.last_seen_at AS cluster_last_seen_at,
                c.last_seen_at > now() - interval '2 hours' AS cluster_growing,
                r.cluster_position,
                CASE WHEN n.cluster_id IS NULL AND n.embedding IS NULL THEN TRUE ELSE FALSE END AS cluster_pending
         FROM news n
         LEFT JOIN clusters c ON c.id = n.cluster_id
         LEFT JOIN ranked r ON r.id = n.id
         WHERE n.matched_tags @> ARRAY[$1]::text[]
         AND ${timeFilter}
         ORDER BY (n.published_at + INTERVAL '0 seconds') DESC
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

    // ТЗ-163: word-AND — порядок слов не важен; слова ≥2 символов, каждое
    // в любом из 4 полей; при отсутствии таких — фолбэк на подстроку целиком.
    const searchWords = q
      .split(/\s+/)
      .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
      .filter((t) => t.length >= 2);

    let articles: any[];
    let total: number;

    if (USE_SQLITE) {
      const tagCondition = tagId ? `matched_tags LIKE ? AND ` : '';
      const tagParams = tagId ? [`%"${tagId}"%`] : [];
      // ТЗ-163: word-AND на LIKE — зеркально PG-ветке.
      const allFieldsSql = `LOWER(COALESCE(title_ru,'') || ' ' || COALESCE(summary_ru,'') || ' ' || COALESCE(title_original,'') || ' ' || COALESCE(summary_original,''))`;
      const searchCondition = searchWords.length > 0
        ? `(${searchWords.map(() => `${allFieldsSql} LIKE LOWER(?) ESCAPE '\\'`).join(' AND ')})`
        : `(LOWER(title_ru) LIKE LOWER(?) ESCAPE '\\' OR LOWER(title_original) LIKE LOWER(?) ESCAPE '\\' OR LOWER(summary_ru) LIKE LOWER(?) ESCAPE '\\' OR LOWER(summary_original) LIKE LOWER(?) ESCAPE '\\')`;

      const where = `${tagCondition}${timeFilter} AND ${searchCondition}`;
      const params = [...tagParams, ...searchWords.map((w) => `%${escapeLikePattern(w)}%`), ...(!searchWords.length ? [likePattern, likePattern, likePattern, likePattern] : [])];

      const countResult = await query(
        `SELECT COUNT(*) as count FROM news WHERE ${where}`,
        params
      );
      total = parseInt(countResult.rows[0]?.count || '0');

      const result = await query(
        `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags, tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug,
                NULL AS cluster_id, NULL AS cluster_size, NULL AS cluster_position, NULL AS cluster_last_seen_at, 0 AS cluster_growing, 0 AS cluster_pending
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
      // ТЗ-163: word-AND — каждое слово в любом из 4 полей (склейка полей);
      // фолбэк без подходящих слов — подстрока запроса целиком, как раньше.
      const allFieldsSql = `(COALESCE(title_ru,'') || ' ' || COALESCE(summary_ru,'') || ' ' || COALESCE(title_original,'') || ' ' || COALESCE(summary_original,''))`;
      let searchCondition: string;
      if (searchWords.length > 0) {
        const parts = searchWords.map(
          (_w, i) => `${allFieldsSql} ILIKE $${tagParams.length + 1 + i} ESCAPE '\\'`,
        );
        searchCondition = `(${parts.join(' AND ')})`;
      } else {
        const idx = tagParams.length + 1;
        searchCondition = `(title_ru ILIKE $${idx} ESCAPE '\\' OR title_original ILIKE $${idx} ESCAPE '\\' OR summary_ru ILIKE $${idx} ESCAPE '\\' OR summary_original ILIKE $${idx} ESCAPE '\\')`;
      }
      const searchParams = searchWords.length > 0
        ? searchWords.map((w) => `%${escapeLikePattern(w)}%`)
        : [likePattern];

      const where = `${tagCondition}${timeFilter} AND ${searchCondition}`;
      const params = [...tagParams, ...searchParams];

      const countResult = await query(
        `SELECT COUNT(*) as count FROM news WHERE ${where}`,
        params
      );
      total = parseInt(countResult.rows[0]?.count || '0');

      // ТЗ-99: каскадные поля (CTE ranked + join'ы).
      const result = await query(
        `WITH ranked AS (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY published_at)::int AS cluster_position
           FROM news
           WHERE cluster_id IS NOT NULL
         )
         SELECT n.id, n.title_ru, n.title_original, n.summary_ru, n.summary_original, n.source, n.url, n.published_at, n.sentiment, n.sentiment_score, n.sentiment_reasoning, n.sentiment_source, n.is_political, n.article_type, n.matched_tags, n.tag_impact, n.source_count, n.all_sources, n.fact_check_status, n.fact_check_result, n.slug,
                n.cluster_id,
                c.size AS cluster_size,
                c.last_seen_at AS cluster_last_seen_at,
                c.last_seen_at > now() - interval '2 hours' AS cluster_growing,
                r.cluster_position,
                CASE WHEN n.cluster_id IS NULL AND n.embedding IS NULL THEN TRUE ELSE FALSE END AS cluster_pending
         FROM news n
         LEFT JOIN clusters c ON c.id = n.cluster_id
         LEFT JOIN ranked r ON r.id = n.id
         WHERE ${where}
         ORDER BY n.published_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );
      articles = result.rows;
    }

    // ТЗ-161: точные совпадения всегда первыми и всегда помечены.
    for (const a of articles) a.match_type = 'exact';
    // Лексический счётчик до семантических докидов: hasMore — только по
    // лексическим совпадениям, иначе докиды завышают articles.length над total
    // и пагинация молча обрывается (REVIEW-TZ-161_163, нит hasMore).
    const lexicalCount = articles.length;

    // ─── ТЗ-161: семантическая часть гибридного поиска (PG-only) ────────
    // SQLite-режим (демо/CI): семантика недоступна — векторы живут только
    // в PostgreSQL; exact-only — осознанный фолбэк, поиск не падает.
    if (!USE_SQLITE && q.trim().length >= 4 && articles.length < limit) {
      try {
        const semantic = await semanticNewsSearch(q, articles, limit - articles.length);
        for (const { article, similarity } of semantic) {
          article.match_type = 'semantic';
          article.similarity = similarity;
          articles.push(article);
        }
      } catch (err: any) {
        // ТЗ-161: недоступность/таймаут TEI — молчаливый фолбэк на exact-only.
        console.warn('[News] Semantic search unavailable, exact-only:', err?.message);
      }
    }

    res.json({
      articles,
      total,
      page,
      hasMore: offset + lexicalCount < total,
    });
  } catch (err: any) {
    console.error('[News] Search error:', err.message, err.stack?.substring(0, 200));
    res.status(500).json({ error: 'Failed to search news', details: err.message });
  }
});

/**
 * ТЗ-161: семантический топ-k по эмбеддингу запроса.
 * Без дат-фильтра: покрытие векторами за 90 дней — всего 20,5% (ТЗ-160),
 * дат-окно сделало бы поиск слепым к свежаку. Свежесть учитывается мягким
 * бустом скоринга.
 */
async function semanticNewsSearch(
  q: string,
  exactArticles: any[],
  need: number,
): Promise<Array<{ article: any; similarity: number }>> {
  if (need <= 0) return [];

  const vectors = await withTimeout(embedBatch([q]), SEMANTIC_SEARCH_TIMEOUT_MS);
  const vecLiteral = vectorLiteral(vectors[0]);

  const candRes = await query(
    `SELECT id, 1 - (embedding <=> $1::vector) AS sim
     FROM news
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT 50`,
    [vecLiteral],
  );

  const exactIds = new Set(exactArticles.map((a) => a.id));
  const candidates = candRes.rows.filter((r: any) => !exactIds.has(r.id));
  if (candidates.length === 0) return [];

  // ТЗ-99: широкие колонки — тот же набор, что в ILIKE-ветке PG,
  // включая каскадные поля через CTE ranked.
  const wideRes = await query(
    `WITH ranked AS (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY cluster_id ORDER BY published_at)::int AS cluster_position
       FROM news
       WHERE cluster_id IS NOT NULL
     )
     SELECT n.id, n.title_ru, n.title_original, n.summary_ru, n.summary_original, n.source, n.url, n.published_at, n.sentiment, n.sentiment_score, n.sentiment_reasoning, n.sentiment_source, n.is_political, n.article_type, n.matched_tags, n.tag_impact, n.source_count, n.all_sources, n.fact_check_status, n.fact_check_result, n.slug,
            n.cluster_id,
            c.size AS cluster_size,
            c.last_seen_at AS cluster_last_seen_at,
            c.last_seen_at > now() - interval '2 hours' AS cluster_growing,
            r.cluster_position,
            CASE WHEN n.cluster_id IS NULL AND n.embedding IS NULL THEN TRUE ELSE FALSE END AS cluster_pending
     FROM news n
     LEFT JOIN clusters c ON c.id = n.cluster_id
     LEFT JOIN ranked r ON r.id = n.id
     WHERE n.id = ANY($1::uuid[])`,
    [candidates.map((c: any) => c.id)],
  );

  const simById = new Map(candidates.map((c: any) => [c.id, Number(c.sim)]));
  const nowMs = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  return wideRes.rows
    .map((article: any) => {
      const sim = simById.get(article.id) ?? 0;
      const ageMs = nowMs - new Date(article.published_at).getTime();
      // ТЗ-161: буст свежести — стартовые константы v1,
      // подбираются по реальному использованию.
      const boost = ageMs <= 14 * DAY_MS ? 0.10 : ageMs <= 90 * DAY_MS ? 0.05 : 0;
      return { article, similarity: sim, score: sim + boost };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, need)
    .map(({ article, similarity }) => ({ article, similarity: Math.round(similarity * 10000) / 10000 }));
}

// ТЗ-161: гонка с таймаутом — внутренний fetch embedBatch продолжит фоном,
// результат отбрасывается, роут отдаёт exact-only.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`semantic embed timeout ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

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

    // ТЗ-100 Задача 2: прикреплённые курсы из news_course_links (до 3,
    // только published + не удалённые + public — hidden не прикрепляются, v9).
    // Существующие поля ответа НЕ меняются — только добавляем attached_courses.
    const newsRow = result.rows[0];
    try {
      const coursesR = await query(
        `SELECT c.id, c.slug, c.title, c.type, c.price, c.cover_url, c.badges, c.size
         FROM news_course_links l
         JOIN courses c ON c.id = l.course_id
         WHERE l.news_id = $1
           AND c.status = 'published' AND c.deleted_at IS NULL AND c.visibility = 'public'
         ORDER BY l.position ASC
         LIMIT 3`,
        [newsRow.id],
      );
      newsRow.attached_courses = coursesR.rows.map((c: any) => ({
        id: c.id,
        slug: c.slug,
        title: c.title,
        type: c.type,
        price: Number(c.price),
        cover_url: c.cover_url,
        badges: typeof c.badges === 'string' ? JSON.parse(c.badges || '[]') : (c.badges || []),
        size: c.size,
      }));
    } catch (e: any) {
      console.warn('[News] attached_courses lookup failed:', e?.message);
      newsRow.attached_courses = [];
    }

    res.json(newsRow);
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
