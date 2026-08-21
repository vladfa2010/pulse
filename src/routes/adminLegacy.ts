import { Router } from 'express';
import { adminMiddleware } from './admin';
import { AuthRequest } from '../middleware/auth';
import { query, pool } from '../config/db';
import { adminCached, adminCacheInvalidate } from '../utils/adminCache';
import { setCachedPopularTags } from '../utils/tagCache';
import marketRoutes from './market';
import tagMarketRoutes from './tagMarket';
import * as marketRouter from '../services/market/marketRouter';
import { isUserEventType } from '../types/events';
import {
  getAdminTgSettings,
  saveAdminTgSettings,
  sendTestAlert,
  ALERT_EVENT_TYPES,
} from '../services/adminAlerts';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';


// ═══════════════════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/llm-dashboard — сводка по LLM метрикам (admin only)
router.get('/llm-dashboard', adminMiddleware, async (req, res) => {
  try {
    const payload = await adminCached('llm-dashboard', 90_000, async () => {
      // Today stats
      const todayBatches = await query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'success') as success,
          COUNT(*) FILTER (WHERE status = 'partial') as partial,
          COUNT(*) FILTER (WHERE status = 'error') as failed
        FROM llm_batches
        WHERE started_at > CURRENT_DATE
      `);

      const todayArticles = await query(`
        SELECT
          COUNT(*) FILTER (WHERE sentiment_source = 'llm' OR sentiment_source = 'llm-partial') as processed,
          COUNT(*) FILTER (WHERE sentiment_source LIKE 'llm-%' AND sentiment_source != 'llm-partial') as failed,
          COUNT(*) FILTER (WHERE sentiment_source = 'keyword') as keyword_fallback
        FROM news
        WHERE created_at > CURRENT_DATE
      `);

      const errorsByType = await query(`
        SELECT sentiment_source, COUNT(*) as count
        FROM news
        WHERE sentiment_source LIKE 'llm-%' AND sentiment_source != 'llm-partial'
          AND created_at > CURRENT_DATE
        GROUP BY sentiment_source
        ORDER BY count DESC
      `);

      // Hourly trend
      const hourly = await query(`
        SELECT
          date_trunc('hour', started_at) as hour,
          COUNT(*) FILTER (WHERE status = 'success') as success,
          COUNT(*) FILTER (WHERE status = 'error') as failed,
          COUNT(*) FILTER (WHERE status = 'partial') as partial
        FROM llm_batches
        WHERE started_at > NOW() - INTERVAL '12 hours'
        GROUP BY date_trunc('hour', started_at)
        ORDER BY hour DESC
        LIMIT 12
      `);

      // Per-tag stats
      const perTag = await query(`
        SELECT
          unnest(matched_tags) as tag,
          COUNT(*) as articles,
          COUNT(*) FILTER (WHERE sentiment_source NOT LIKE 'llm-%') as success
        FROM news
        WHERE created_at > CURRENT_DATE
          AND matched_tags IS NOT NULL
        GROUP BY unnest(matched_tags)
        ORDER BY articles DESC
        LIMIT 20
      `);

      // Manual queue (3+ attempts, 7-day window)
      const manualQueue = await query(`
        SELECT COUNT(*) as count
        FROM news
        WHERE llm_attempts >= 3
          AND llm_attempts IS NOT NULL
          AND llm_error IS NOT NULL
          AND created_at > NOW() - INTERVAL '7 days'
      `);

      const t = todayBatches.rows[0];
      const total = parseInt(t?.total || '0');
      const success = parseInt(t?.success || '0');
      const partial = parseInt(t?.partial || '0');
      const failed = parseInt(t?.failed || '0');

      return {
        today: {
          batches_total: total,
          batches_success: success,
          batches_partial: partial,
          batches_failed: failed,
          success_rate: total > 0 ? Math.round((success + partial) / total * 100 * 10) / 10 : 0,
          articles_processed: parseInt(todayArticles.rows[0]?.processed || '0'),
          articles_failed: parseInt(todayArticles.rows[0]?.failed || '0'),
          keyword_fallback: parseInt(todayArticles.rows[0]?.keyword_fallback || '0'),
          manual_queue: parseInt(manualQueue.rows[0]?.count || '0'),
        },
        errors_by_type: errorsByType.rows,
        hourly_trend: hourly.rows,
        per_tag: perTag.rows,
      };
    });

    res.set('Cache-Control', 'private, max-age=60');
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/llm-errors — список ошибок
router.get('/llm-errors', adminMiddleware, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const hours = parseInt(req.query.hours as string) || 24;

    const payload = await adminCached(`llm-errors:${hours}:${limit}`, 60_000, async () => {
      const byType = await query(`
        SELECT sentiment_source, COUNT(*) as count
        FROM news
        WHERE sentiment_source LIKE 'llm-%' AND sentiment_source != 'llm-partial'
          AND created_at > NOW() - INTERVAL '${hours} hours'
        GROUP BY sentiment_source
        ORDER BY count DESC
      `);

      const recent = await query(`
        SELECT id, title_ru, published_at, sentiment_source, llm_error, llm_attempts, llm_raw_preview, matched_tags
        FROM news
        WHERE llm_error IS NOT NULL
          AND llm_attempts IS NOT NULL
          AND created_at > NOW() - INTERVAL '${hours} hours'
        ORDER BY published_at DESC
        LIMIT $1
      `, [limit]);

      // Manual queue (3+ attempts, 7-day window)
      const manualQueue = await query(`
        SELECT COUNT(*) as count
        FROM news
        WHERE llm_attempts >= 3
          AND llm_attempts IS NOT NULL
          AND llm_error IS NOT NULL
          AND created_at > NOW() - INTERVAL '7 days'
      `);

      return {
        total_failed: byType.rows.reduce((sum: number, r: any) => sum + parseInt(r.count), 0),
        by_type: byType.rows,
        manual_queue_count: parseInt(manualQueue.rows[0]?.count || '0'),
        recent: recent.rows,
      };
    });

    res.set('Cache-Control', 'private, max-age=60');
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/backfill
router.post('/backfill', adminMiddleware, async (req, res) => {
  try {
    const { newsIds, tag, since } = req.body;
    let articles: any[] = [];

    if (newsIds && Array.isArray(newsIds) && newsIds.length > 0) {
      const result = await query(`
        SELECT id, title_ru, summary_ru, matched_tags
        FROM news
        WHERE id = ANY($1::uuid[])
      `, [newsIds]);
      articles = result.rows;
    } else if (tag) {
      const result = await query(`
        SELECT id, title_ru, summary_ru, matched_tags
        FROM news
        WHERE $1 = ANY(matched_tags)
          AND (sentiment_source LIKE 'llm-%' OR sentiment_reasoning IS NULL)
        ORDER BY published_at DESC
        LIMIT 100
      `, [tag]);
      articles = result.rows;
    } else if (since) {
      const interval = since === '24h' ? '24 hours' : since === '7d' ? '7 days' : '24 hours';
      const result = await query(`
        SELECT id, title_ru, summary_ru, matched_tags
        FROM news
        WHERE (sentiment_source LIKE 'llm-%' OR sentiment_reasoning IS NULL)
          AND published_at > NOW() - INTERVAL '${interval}'
        ORDER BY published_at DESC
        LIMIT 100
      `);
      articles = result.rows;
    }

    if (articles.length === 0) {
      return res.json({ processed: 0, succeeded: 0, failed: 0, message: 'No articles to backfill' });
    }

    const llmAvailable = !!process.env.KIMI_API_KEY;
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < articles.length; i += 10) {
      const batch = articles.slice(i, i + 10);
      try {
        const { analyzeUnifiedBatch } = await import('../services/smartTagMatcher');
        const results = await analyzeUnifiedBatch(
          batch.map((a: any) => ({
            title: a.title_ru,
            summary: a.summary_ru,
            tags: a.matched_tags || [],
          }))
        );
        for (let j = 0; j < batch.length; j++) {
          const r = results[j];
          await query(`
            UPDATE news
            SET sentiment = $1, sentiment_score = $2, sentiment_reasoning = $3,
                sentiment_source = $4, llm_error = NULL, llm_attempts = COALESCE(llm_attempts, 0) + 1,
                tag_impact = $5, is_political = $6, article_type = $7, last_retry_at = NOW()
            WHERE id = $8
          `, [r.sentiment, r.score, r.reasoning, (r as any)._llmSource || 'llm',
              JSON.stringify(r.tag_impacts), r.is_political, r.article_type, batch[j].id]);
          succeeded++;
        }
      } catch (err: any) {
        failed += batch.length;
      }
    }

    res.json({ processed: articles.length, succeeded, failed });
    adminCacheInvalidate('llm-');
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/source-stats — статистика по RSS источникам (admin only)
router.get('/source-stats', adminMiddleware, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;

    const payload = await adminCached(`source-stats:${hours}`, 90_000, async () => {
      // Статистика по источникам за N часов
      const sourceStats = await query(`
        SELECT
          source,
          COUNT(*) as total_articles,
          COUNT(*) FILTER (WHERE matched_tags IS NOT NULL AND array_length(matched_tags, 1) > 0) as tagged_articles,
          COUNT(*) FILTER (WHERE matched_tags IS NULL OR array_length(matched_tags, 1) = 0) as untagged_articles,
          COUNT(*) FILTER (WHERE sentiment_source = 'llm' OR sentiment_source = 'llm-partial') as llm_success,
          COUNT(*) FILTER (WHERE sentiment_source LIKE 'llm-%' AND sentiment_source != 'llm-partial') as llm_failed,
          COUNT(*) FILTER (WHERE sentiment_source = 'llm-timeout') as llm_timeout,
          ROUND(AVG(sentiment_score) FILTER (WHERE sentiment_score IS NOT NULL), 1) as avg_sentiment,
          MAX(published_at) as last_article_at,
          CASE
            WHEN source LIKE '% bloomberg %' OR source LIKE '%reuters%' OR source LIKE '%wsj%'
                 OR source LIKE '%ft.com%' OR source LIKE '%cnbc%' OR source LIKE '%marketwatch%'
                 OR source LIKE '%seekingalpha%' OR source LIKE '%morningstar%'
                 OR source LIKE '%hackernews%' OR source LIKE '%techcrunch%'
                 OR source LIKE '%ars technica%' OR source LIKE '%wired%'
                 OR source LIKE '%apnews%' OR source LIKE '%washingtonpost%'
            THEN 'en'
            ELSE 'ru'
          END as language
        FROM news
        WHERE published_at > NOW() - INTERVAL '${hours} hours'
        GROUP BY source
        ORDER BY total_articles DESC
      `);

      // Топ-5 тегов по каждому источнику
      const sourceTags = await query(`
        SELECT
          source,
          unnest(matched_tags) as tag,
          COUNT(*) as tag_count
        FROM news
        WHERE published_at > NOW() - INTERVAL '${hours} hours'
          AND matched_tags IS NOT NULL
          AND array_length(matched_tags, 1) > 0
        GROUP BY source, unnest(matched_tags)
        ORDER BY source, tag_count DESC
      `);

      // Группируем теги по источнику
      const tagsBySource: Record<string, { tag: string; count: number }[]> = {};
      for (const row of sourceTags.rows) {
        if (!tagsBySource[row.source]) tagsBySource[row.source] = [];
        if (tagsBySource[row.source].length < 5) {
          tagsBySource[row.source].push({ tag: row.tag, count: parseInt(row.tag_count) });
        }
      }

      const sources = sourceStats.rows.map((row: any) => ({
        source: row.source,
        total_articles: parseInt(row.total_articles),
        tagged_articles: parseInt(row.tagged_articles),
        untagged_articles: parseInt(row.untagged_articles),
        llm_success: parseInt(row.llm_success),
        llm_failed: parseInt(row.llm_failed),
        llm_timeout: parseInt(row.llm_timeout),
        avg_sentiment: parseFloat(row.avg_sentiment) || 0,
        last_article_at: row.last_article_at,
        language: row.language,
        top_tags: tagsBySource[row.source] || [],
      }));

      return { hours, sources };
    });

    res.set('Cache-Control', 'private, max-age=60');
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Users Management
// ═══════════════════════════════════════════════════════════════════════════

// Ensure is_blocked column exists
query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'is_blocked' LIMIT 1`).then((check: any) => {
  if (check.rows.length === 0) {
    query(`ALTER TABLE users ADD COLUMN is_blocked BOOLEAN DEFAULT FALSE`).catch(() => {});
  }
}).catch(() => {});

// GET /admin/events — лента событий пользователей (Activities List)
router.get('/events', adminMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const eventType = req.query.type as string;
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 720);

    if (eventType && !isUserEventType(eventType)) {
      return res.status(400).json({ error: 'Invalid event type' });
    }

    const payload = await adminCached(`events:${hours}:${eventType || 'all'}:${limit}`, 60_000, async () => {
      const conditions: string[] = [];
      const params: any[] = [];

      if (USE_SQLITE) {
        conditions.push(`e.created_at > datetime('now', '-${hours} hours')`);
      } else {
        conditions.push(`e.created_at > NOW() - INTERVAL '${hours} hours'`);
      }

      if (eventType) {
        conditions.push(`e.event_type = $1`);
        params.push(eventType);
      }
      params.push(limit);

      const result = await query(
        `SELECT
           e.id, e.user_id, e.event_type, e.event_data, e.created_at,
           u.username, u.email
         FROM user_events e
         JOIN users u ON u.id = e.user_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY e.created_at DESC
         LIMIT $${params.length}`,
        params
      );

      return {
        events: result.rows.map((row: any) => {
          let eventData = row.event_data;
          if (typeof eventData === 'string') {
            try { eventData = JSON.parse(eventData); } catch { eventData = {}; }
          }
          return {
            id: row.id,
            user_id: row.user_id,
            username: row.username,
            email: row.email,
            event_type: row.event_type,
            event_data: eventData || {},
            created_at: row.created_at,
          };
        }),
        total: result.rows.length,
        hours,
        filter: eventType || null,
      };
    });

    res.set('Cache-Control', 'private, max-age=60');
    res.json(payload);
  } catch (err: any) {
    console.error('[Admin] Failed to fetch events:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/events/stats — статистика событий для дашборда
router.get('/events/stats', adminMiddleware, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 720);

    const payload = await adminCached(`events-stats:${hours}`, 60_000, async () => {
      const timeFilter = USE_SQLITE
        ? `e.created_at > datetime('now', '-${hours} hours')`
        : `e.created_at > NOW() - INTERVAL '${hours} hours'`;

      const byTypeResult = await query(
        `SELECT e.event_type, COUNT(*) as count
         FROM user_events e
         WHERE ${timeFilter}
         GROUP BY e.event_type
         ORDER BY count DESC`,
        []
      );

      const hourExpr = USE_SQLITE
        ? "strftime('%Y-%m-%d %H:00', e.created_at)"
        : "date_trunc('hour', e.created_at)::text";

      const hourlyResult = await query(
        `SELECT ${hourExpr} as hour, COUNT(*) as count
         FROM user_events e
         WHERE ${timeFilter}
         GROUP BY hour
         ORDER BY hour ASC`,
        []
      );

      return {
        hours,
        by_type: byTypeResult.rows.map((row: any) => ({
          event_type: row.event_type,
          count: parseInt(row.count) || 0,
        })),
        hourly: hourlyResult.rows.map((row: any) => ({
          hour: row.hour,
          count: parseInt(row.count) || 0,
        })),
      };
    });

    res.set('Cache-Control', 'private, max-age=60');
    res.json(payload);
  } catch (err: any) {
    console.error('[Admin] Failed to fetch event stats:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Tags Management
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/tags — все теги с агрегатами
router.get('/tags', adminMiddleware, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;

    const payload = await adminCached(`admin-tags:${hours}`, 120_000, async () => {
      const tagsResult = USE_SQLITE
        ? await query(`
            SELECT
              t.tag_id,
              t.tag_name,
              t.tag_type,
              t.keywords,
              t.is_verified,
              t.created_at,
              JSON_EXTRACT(t.enriched_data, '$._backfill') as backfill,
              COUNT(DISTINCT p.user_id) as subscriber_count,
              COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > datetime('now', '-${hours} hours')) as articles_24h,
              COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > datetime('now', '-7 days')) as articles_7d,
              COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > datetime('now', '-30 days')) as articles_30d,
              ROUND(AVG(n.sentiment_score) FILTER (WHERE n.sentiment_score IS NOT NULL AND n.published_at > datetime('now', '-${hours} hours')), 1) as avg_sentiment,
              COUNT(*) FILTER (WHERE n.sentiment_source = 'llm' OR n.sentiment_source = 'llm-partial') as llm_success,
              COUNT(*) FILTER (WHERE n.sentiment_source LIKE 'llm-%' AND n.sentiment_source != 'llm-partial') as llm_failed,
              MAX(n.published_at) as last_article_at
            FROM user_defined_tags t
            LEFT JOIN portfolios p ON p.tag_id = t.tag_id
            LEFT JOIN news n ON t.tag_id = ANY(n.matched_tags) AND n.published_at > datetime('now', '-30 days')
            GROUP BY t.tag_id, t.tag_name, t.tag_type, t.keywords, t.is_verified, t.created_at, t.enriched_data
            ORDER BY articles_24h DESC, subscriber_count DESC
          `)
        : await query(`
            WITH tag_ids AS (
              SELECT array_agg(tag_id)::text[] AS ids FROM user_defined_tags
            ),
            agg AS (
              SELECT
                m.tag AS tag_id,
                COUNT(*) FILTER (WHERE n.published_at > NOW() - INTERVAL '${hours} hours') as articles_24h,
                COUNT(*) FILTER (WHERE n.published_at > NOW() - INTERVAL '7 days') as articles_7d,
                COUNT(*) as articles_30d,
                ROUND(AVG(n.sentiment_score) FILTER (WHERE n.sentiment_score IS NOT NULL AND n.published_at > NOW() - INTERVAL '${hours} hours'), 1) as avg_sentiment,
                COUNT(*) FILTER (WHERE n.sentiment_source = 'llm' OR n.sentiment_source = 'llm-partial') as llm_success,
                COUNT(*) FILTER (WHERE n.sentiment_source LIKE 'llm-%' AND n.sentiment_source != 'llm-partial') as llm_failed,
                MAX(n.published_at) as last_article_at
              FROM news n
              CROSS JOIN LATERAL unnest(n.matched_tags) AS m(tag)
              WHERE n.published_at > NOW() - INTERVAL '30 days'
                AND n.matched_tags && (SELECT ids FROM tag_ids)
              GROUP BY m.tag
            ),
            subs AS (
              SELECT tag_id, COUNT(DISTINCT user_id) AS subscriber_count
              FROM portfolios
              GROUP BY tag_id
            )
            SELECT
              t.tag_id,
              t.tag_name,
              t.tag_type,
              t.keywords,
              t.is_verified,
              t.created_at,
              t.enriched_data->'_backfill' as backfill,
              COALESCE(s.subscriber_count, 0) as subscriber_count,
              COALESCE(a.articles_24h, 0) as articles_24h,
              COALESCE(a.articles_7d, 0) as articles_7d,
              COALESCE(a.articles_30d, 0) as articles_30d,
              a.avg_sentiment,
              COALESCE(a.llm_success, 0) as llm_success,
              COALESCE(a.llm_failed, 0) as llm_failed,
              a.last_article_at
            FROM user_defined_tags t
            LEFT JOIN agg a ON a.tag_id = t.tag_id
            LEFT JOIN subs s ON s.tag_id = t.tag_id
            ORDER BY articles_24h DESC, subscriber_count DESC
          `);

      const tags = tagsResult.rows.map((row: any) => ({
      tag_id: row.tag_id,
      tag_name: row.tag_name,
      tag_type: row.tag_type,
      keywords: row.keywords || [],
      is_verified: row.is_verified === true || row.is_verified === 1,
      created_at: row.created_at,
      backfill: (() => {
        if (!row.backfill) return null;
        if (typeof row.backfill === 'string') {
          try { return JSON.parse(row.backfill); } catch { return null; }
        }
        return row.backfill;
      })(),
      subscriber_count: parseInt(row.subscriber_count) || 0,
      articles_24h: parseInt(row.articles_24h) || 0,
      articles_7d: parseInt(row.articles_7d) || 0,
      articles_30d: parseInt(row.articles_30d) || 0,
      avg_sentiment: parseFloat(row.avg_sentiment) || 0,
      llm_success: parseInt(row.llm_success) || 0,
      llm_failed: parseInt(row.llm_failed) || 0,
      last_article_at: row.last_article_at,
    }));

    // Warm shared cache for public /news/tags/popular endpoint
    // Each period cache must keep its own ordering/news_count, otherwise 7d/30d
    // responses can be served in 24h order.
    const buildPopularTags = (orderField: 'articles_24h' | 'articles_7d' | 'articles_30d') =>
      tags
        .map((t: any) => ({
          tag_id: t.tag_id,
          tag_name: t.tag_name,
          tag_type: t.tag_type,
          news_count: t[orderField] || 0,
          articles_24h: t.articles_24h || 0,
          articles_7d: t.articles_7d || 0,
          articles_30d: t.articles_30d || 0,
        }))
        .sort((a: any, b: any) => b[orderField] - a[orderField])
        .slice(0, 15);

      setCachedPopularTags('24h', 15, buildPopularTags('articles_24h'));
      setCachedPopularTags('7d', 15, buildPopularTags('articles_7d'));
      setCachedPopularTags('30d', 15, buildPopularTags('articles_30d'));

      return { hours, total: tags.length, tags };
    });

    res.set('Cache-Control', 'private, max-age=60');
    res.json(payload);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


// Market data routes (must be mounted BEFORE /tags/:tagId)
router.use('/market', marketRoutes);
router.use('/tags/:tagId', tagMarketRoutes);

// GET /admin/tags/:tagId — детали тега
router.get('/tags/:tagId', adminMiddleware, async (req, res) => {
  try {
    const tagId = req.params.tagId.toLowerCase();

    // Tag info
    const tagResult = await query(`
      SELECT tag_id, tag_name, tag_type, keywords, enriched_data, is_verified, created_at
      FROM user_defined_tags
      WHERE tag_id = $1
    `, [tagId]);

    if (tagResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }

    const tag = tagResult.rows[0];
    // enriched_data may be string from pg driver — parse to object
    let enrichedData = tag.enriched_data;
    if (typeof enrichedData === 'string') {
      try { enrichedData = JSON.parse(enrichedData); } catch { enrichedData = {}; }
    }
    if (!enrichedData || typeof enrichedData !== 'object') {
      enrichedData = {};
    }
    const ed = enrichedData;
    let relatedTags: string[] = [];
    let ticker = null;
    let website = null;
    let websites: string[] = [];
    let wikipediaUrl = null;
    let country = null;
    let isin = null;
    let description = null;
    let keyProducts: string[] = [];
    let synonymsRu: string[] = [];
    let synonymsEn: string[] = [];
    let exchange = null;
    let symbol = null;
    let mic = null;
    let trend = null;
    let sector = null;
    let sectors: string[] = [];
    let trends: string[] = [];
    let geoCountries: string[] = [];
    let geoRegions: string[] = [];
    let geoCities: string[] = [];
    try {
      if (ed.related_tags) {
        relatedTags = ed.related_tags;
      } else if (ed.related_entities) {
        relatedTags = ed.related_entities;
      }
      ticker      = ed.ticker        || null;
      website     = ed.website       || null;
      websites    = ed.websites      || (ed.website ? [ed.website] : []);
      wikipediaUrl = ed.wikipedia_url || null;
      country     = ed.country       || null;
      isin        = ed.isin          || null;
      description = ed.description_ru || null;
      keyProducts = ed.key_products  || [];
      synonymsRu  = ed.synonyms_ru   || [];
      synonymsEn  = ed.synonyms_en   || [];
      exchange    = ed.exchange      || null;
      symbol      = ed.symbol        || null;
      mic         = ed.mic           || null;
      trend       = ed.trend         || null;
      sector      = ed.sector        || null;
      sectors     = ed.sectors       || (ed.sector ? [ed.sector] : []);
      trends      = ed.trends        || (ed.trend ? [ed.trend] : []);
      geoCountries = ed.geo_countries || (ed.country ? [ed.country] : []);
      geoRegions  = ed.geo_regions   || [];
      geoCities   = ed.geo_cities    || [];
    } catch { /* ignore */ }

    // Daily stats (30 days) — grouped by MSK day
    let dailySql: string;
    let dailyParams: any[];
    if (USE_SQLITE) {
      dailySql = `
        SELECT
          date(datetime(published_at, '+3 hours')) as day,
          COUNT(*) as count,
          ROUND(AVG(sentiment_score) FILTER (WHERE sentiment_score IS NOT NULL), 1) as avg_sentiment
        FROM news
        WHERE matched_tags IS NOT NULL
          AND (
            matched_tags LIKE ?
            OR matched_tags LIKE ?
            OR matched_tags LIKE ?
            OR matched_tags = ?
          )
          AND datetime(published_at, '+3 hours') >= datetime('now', '-30 days', '+3 hours')
        GROUP BY date(datetime(published_at, '+3 hours'))
        ORDER BY day ASC
      `;
      dailyParams = [`%"${tagId}"%`, `%[${tagId},%`, `%,${tagId}]%`, tagId];
    } else {
      dailySql = `
        SELECT
          (published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date as day,
          COUNT(*) as count,
          ROUND(AVG(sentiment_score) FILTER (WHERE sentiment_score IS NOT NULL), 1) as avg_sentiment
        FROM news
        WHERE $1 = ANY(matched_tags)
          AND published_at > NOW() - INTERVAL '30 days'
        GROUP BY (published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date
        ORDER BY day ASC
      `;
      dailyParams = [tagId];
    }
    const dailyResult = await query(dailySql, dailyParams);

    // Recent articles
    const articlesResult = await query(`
      SELECT id, title_ru, published_at, sentiment_score, sentiment_source, source
      FROM news
      WHERE $1 = ANY(matched_tags)
      ORDER BY published_at DESC
      LIMIT 20
    `, [tagId]);

    // Subscribers
    const subscribersResult = await query(`
      SELECT u.email, u.username, p.created_at
      FROM portfolios p
      JOIN users u ON u.id = p.user_id
      WHERE p.tag_id = $1
      ORDER BY p.created_at DESC
    `, [tagId]);

    // Market block: resolved instrument for chart/price widgets
    let market: any = { symbol: null, mic: null, source: 'none', ambiguous: false, candidates: [] };
    if (ticker) {
      try {
        if (symbol) {
          market = { symbol, mic: mic || symbol.split('@')[1] || null, source: 'saved', ambiguous: false, candidates: [] };
        } else {
          const matches = await marketRouter.resolveTicker(ticker);
          if (matches.length === 0) {
            market = { symbol: null, mic: null, source: 'none', ambiguous: false, candidates: [] };
          } else {
            const best = matches.find((m) => m.mic === 'MISX') ?? matches[0];
            market = {
              symbol: null,
              mic: best.mic,
              source: 'auto',
              ambiguous: matches.length > 1,
              candidates: matches.slice(0, 5),
            };
          }
        }
      } catch (err: any) {
        console.error(`[admin/tags/:tagId] market resolve failed for ${tagId}:`, err.message);
        market = null;
      }
    }

    res.json({
      tag: {
        tag_id: tag.tag_id,
        tag_name: tag.tag_name,
        tag_type: tag.tag_type,
        keywords: tag.keywords || [],
        created_at: tag.created_at,
        is_verified: tag.is_verified === true || tag.is_verified === 1,
        related_tags: relatedTags,
        ticker,
        website,
        websites,
        wikipedia_url: wikipediaUrl,
        country,
        isin,
        symbol,
        mic,
        description,
        description_ru: description,
        key_products: keyProducts,
        synonyms_ru: synonymsRu,
        synonyms_en: synonymsEn,
        exchange,
        trend,
        sector,
        sectors,
        trends,
        geo_countries: geoCountries,
        geo_regions: geoRegions,
        geo_cities: geoCities,
      },
      daily_stats: dailyResult.rows.map((r: any) => ({
        day: r.day,
        count: parseInt(r.count),
        avg_sentiment: parseFloat(r.avg_sentiment) || 0,
      })),
      recent_articles: articlesResult.rows.map((a: any) => ({
        id: a.id,
        title: a.title_ru,
        published_at: a.published_at,
        sentiment_score: a.sentiment_score,
        sentiment_source: a.sentiment_source,
        source: a.source,
      })),
      subscribers: subscribersResult.rows,
      subscriber_count: subscribersResult.rows.length,
      market,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PUT /admin/tags/:tagId — inline editing (TZ_INLINE_TAG_EDIT_v2)
// ═══════════════════════════════════════════════════════════════════════════

// Validation rules
const TAG_UPDATE_RULES: Record<string, any> = {
  tag_type: { type: 'enum', values: ['company', 'ticker', 'sector', 'trend', 'country', 'commodity', 'index', 'person', 'currency'] },
  ticker: { type: 'string', min: 1, max: 20, pattern: /^[A-Z0-9\.\-]+$/, optional: true },
  symbol: { type: 'string', max: 40, pattern: /^[A-Z0-9.\-]+@[A-Z0-9]+$/, optional: true },
  website: { type: 'url', max: 500, optional: true },
  websites: { type: 'array', maxItems: 10, items: { type: 'url', max: 500 }, optional: true },
  wikipedia_url: { type: 'url', max: 500, optional: true },
  country: { type: 'string', max: 100, optional: true },
  isin: { type: 'string', max: 12, pattern: /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/, optional: true },
  description_ru: { type: 'string', max: 5000, optional: true },
  key_products: { type: 'array', maxItems: 20, items: { type: 'string', max: 100 }, optional: true },
  related_tags: { type: 'array', maxItems: 20, items: { type: 'string' }, optional: true },
  synonyms_ru: { type: 'array', maxItems: 20, items: { type: 'string', max: 100 }, optional: true },
  synonyms_en: { type: 'array', maxItems: 20, items: { type: 'string', max: 100 }, optional: true },
  keywords: { type: 'array', maxItems: 100, items: { type: 'string', max: 100 }, optional: true },
  exchange: { type: 'string', max: 50, pattern: /^[A-Z][A-Za-z\.\-]*$/, optional: true },
  mic: { type: 'string', min: 4, max: 8, pattern: /^[A-Z0-9]+$/, optional: true },
  trend:    { type: 'string', max: 100, optional: true },
  sector:   { type: 'string', max: 100, optional: true },
  trends:   { type: 'array', maxItems: 10, items: { type: 'string', max: 100 }, optional: true },
  sectors:  { type: 'array', maxItems: 10, items: { type: 'string', max: 100 }, optional: true },
  geo_countries: { type: 'array', maxItems: 10, items: { type: 'string', max: 100 }, optional: true },
  geo_regions:   { type: 'array', maxItems: 10, items: { type: 'string', max: 100 }, optional: true },
  geo_cities:    { type: 'array', maxItems: 10, items: { type: 'string', max: 100 }, optional: true },
  is_verified: { type: 'boolean' },
};

function validateField(key: string, value: any): string | null {
  const rule = TAG_UPDATE_RULES[key];
  if (!rule) return null; // unknown field, skip

  if (value === null || value === undefined || value === '') {
    if (rule.optional) return null;
    return `${key} is required`;
  }

  if (rule.type === 'enum') {
    if (!rule.values.includes(value)) return `${key} must be one of: ${rule.values.join(', ')}`;
  }

  if (rule.type === 'string') {
    if (typeof value !== 'string') return `${key} must be a string`;
    if (rule.min && value.length > 0 && value.length < rule.min) return `${key} min ${rule.min} chars`;
    if (rule.max && value.length > rule.max) return `${key} max ${rule.max} chars`;
    if (rule.pattern && value.length > 0 && !rule.pattern.test(value)) return `${key} invalid format`;
  }

  if (rule.type === 'boolean') {
    if (typeof value !== 'boolean') return `${key} must be a boolean`;
  }

  if (rule.type === 'url') {
    if (typeof value !== 'string') return `${key} must be a string`;
    if (value.length > (rule.max || 500)) return `${key} max ${rule.max} chars`;
    if (!value) return null; // пустая строка — OK для optional
    // Auto-fix: add https:// if no protocol
    if (!value.match(/^https?:\/\//)) {
      value = 'https://' + value;
    }
    try { new URL(value); } catch { return `${key} must be a valid URL`; }
  }

  if (rule.type === 'array') {
    if (!Array.isArray(value)) return `${key} must be an array`;
    if (rule.minItems && value.length < rule.minItems) return `${key} min ${rule.minItems} items`;
    if (rule.maxItems && value.length > rule.maxItems) return `${key} max ${rule.maxItems} items`;
    for (const item of value) {
      if (typeof item !== 'string') return `${key} items must be strings`;
      if (rule.items?.max && item.length > rule.items.max) return `${key} item max ${rule.items.max} chars`;
      // NEW: validate URL items inside arrays (e.g. websites)
      if (rule.items?.type === 'url' && item) {
        const urlToCheck = item.match(/^https?:\/\//) ? item : 'https://' + item;
        try { new URL(urlToCheck); } catch { return `${key} items must be valid URLs`; }
      }
    }
  }

  return null;
}

// Check circular reference for related_tags
async function checkCircularReference(tagId: string, relatedTags: string[]): Promise<boolean> {
  if (!relatedTags || relatedTags.length === 0) return true;
  const result = await query(
    `SELECT tag_id FROM user_defined_tags 
     WHERE tag_id = ANY($1::text[]) 
       AND enriched_data->'related_tags' @> to_jsonb($2::text)`,
    [relatedTags, tagId]
  );
  return result.rows.length === 0;
}

router.put('/tags/:tagId', adminMiddleware, async (req, res) => {
  try {
    const tagId = req.params.tagId.toLowerCase();
    const allowed = Object.keys(TAG_UPDATE_RULES);
    const updates: Record<string, any> = {};
    const errors: Record<string, string> = {};

    // Collect and validate updates
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        const error = validateField(key, req.body[key]);
        if (error) {
          errors[key] = error;
        } else {
          updates[key] = req.body[key];
        }
      }
    }

    // TZ-2.12: free-text ticker is allowed. If no symbol was picked, clear instrument
    // fields so no stale symbol/mic/exchange/isin remain.
    if (updates.ticker !== undefined && !updates.symbol) {
      updates.symbol = null;
      updates.mic = null;
      updates.exchange = null;
      updates.isin = null;
    }

    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation failed', errors });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Circular reference check
    if (updates.related_tags) {
      const ok = await checkCircularReference(tagId, updates.related_tags);
      if (!ok) {
        return res.status(400).json({
          error: 'Circular reference detected',
          field: 'related_tags',
        });
      }
    }

    // TZ-2.10: symbol is source of truth; derive or validate mic
    if (updates.symbol && !updates.mic) {
      updates.mic = updates.symbol.split('@')[1] || null;
    }
    if (updates.mic) updates.mic = String(updates.mic).toUpperCase();
    if (updates.symbol && updates.mic && updates.symbol.split('@')[1] !== updates.mic) {
      errors.mic = `mic не совпадает с symbol (${updates.symbol})`;
    }
    if (Object.keys(errors).length > 0) {
      return res.status(400).json({ error: 'Validation failed', errors });
    }

    // Auto-fix URL: add https:// if no protocol
    if (updates.website && !updates.website.match(/^https?:\/\//)) {
      updates.website = 'https://' + updates.website;
    }
    if (updates.wikipedia_url && !updates.wikipedia_url.match(/^https?:\/\//)) {
      updates.wikipedia_url = 'https://' + updates.wikipedia_url;
    }
    if (updates.websites && Array.isArray(updates.websites)) {
      updates.websites = updates.websites.map(url =>
        typeof url === 'string' && !url.match(/^https?:\/\//) ? 'https://' + url : url
      );
    }

    // Build SET clauses for flat columns
    const setClauses: string[] = [];
    const params: any[] = [tagId];
    let paramIdx = 2;

    if (updates.tag_type !== undefined) {
      setClauses.push(`tag_type = $${paramIdx++}`);
      params.push(updates.tag_type);
    }

    // TZ_TAG_EXTENDED_FIELDS: is_verified is a flat column so it survives re-enrichment
    if (updates.is_verified !== undefined) {
      setClauses.push(`is_verified = $${paramIdx++}`);
      params.push(updates.is_verified);
    }

    // Direct keywords update (admin override)
    if (updates.keywords !== undefined) {
      setClauses.push(`keywords = $${paramIdx++}`);
      params.push(updates.keywords);
    }

    // Build enriched_data patch in JS (SQLite + PostgreSQL compatible)
    const jsonbFields = ['ticker', 'symbol', 'mic', 'website', 'description_ru', 'key_products', 'related_tags', 'synonyms_ru', 'synonyms_en', 'exchange', 'trend', 'sector', 'websites', 'wikipedia_url', 'country', 'isin', 'sectors', 'trends', 'geo_countries', 'geo_regions', 'geo_cities'];
    // Normalize empty strings to null (INC-004: empty string !== null in JSONB)
    for (const f of jsonbFields) {
      if (updates[f] === '') updates[f] = null;
    }
    const enrichedPatch: Record<string, any> = {};
    for (const f of jsonbFields) {
      if (updates[f] !== undefined) {
        enrichedPatch[f] = updates[f];
      }
    }
    // Legacy sync: keep single-value fields in sync with the first array item
    if (updates.websites !== undefined) {
      enrichedPatch.website = updates.websites[0] || null;
    }
    if (updates.sectors !== undefined) {
      enrichedPatch.sector = updates.sectors[0] || null;
    }
    if (updates.trends !== undefined) {
      enrichedPatch.trend = updates.trends[0] || null;
    }
    if (updates.geo_countries !== undefined) {
      enrichedPatch.country = updates.geo_countries[0] || null;
    }

    if (Object.keys(enrichedPatch).length > 0) {
      // Fetch current enriched_data and merge patch in memory
      const currentResult = await query(
        `SELECT enriched_data FROM user_defined_tags WHERE tag_id = $1`,
        [tagId]
      );
      if (currentResult.rows.length === 0) {
        return res.status(404).json({ error: 'Tag not found' });
      }
      let currentEnriched: any = currentResult.rows[0].enriched_data;
      if (typeof currentEnriched === 'string') {
        try { currentEnriched = JSON.parse(currentEnriched); } catch { currentEnriched = {}; }
      }
      if (!currentEnriched || typeof currentEnriched !== 'object') {
        currentEnriched = {};
      }
      const mergedEnriched = { ...currentEnriched, ...enrichedPatch };
      setClauses.push(`enriched_data = $${paramIdx++}::jsonb`);
      params.push(JSON.stringify(mergedEnriched));
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Capture pre-update keywords BEFORE the UPDATE so the diff is correct.
    const preUpdateResult = await query(
      `SELECT keywords FROM user_defined_tags WHERE tag_id = $1`,
      [tagId]
    );
    const preUpdateKeywords = preUpdateResult.rows[0]?.keywords || [];

    const updateResult = await query(`
      UPDATE user_defined_tags
      SET ${setClauses.join(', ')}
      WHERE tag_id = $1
    `, params);

    if ((updateResult.rowCount ?? 0) === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }

    // Fetch updated row explicitly (SQLite does not support RETURNING * via db.run)
    const result = await query(`
      SELECT tag_id, tag_name, tag_type, keywords, enriched_data, is_verified, created_at
      FROM user_defined_tags
      WHERE tag_id = $1
    `, [tagId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    // Unpack enriched_data to flat fields (matches GET /admin/tags/:tagId format)
    const updated = result.rows[0];
    // enriched_data may be string from pg driver — parse to object
    let enrichedDataPut = updated.enriched_data;
    if (typeof enrichedDataPut === 'string') {
      try { enrichedDataPut = JSON.parse(enrichedDataPut); } catch { enrichedDataPut = {}; }
    }
    if (!enrichedDataPut || typeof enrichedDataPut !== 'object') {
      enrichedDataPut = {};
    }
    const ed = enrichedDataPut;

    // Rebuild keywords from enriched_data after any update, UNLESS admin explicitly updated keywords.
    // enriched_data is the single source of truth for matching keywords, but manual override is allowed.
    const oldKeywords = [...preUpdateKeywords].sort();
    let newKeywords = oldKeywords;
    if (updates.keywords === undefined) {
      const { rebuildKeywordsFromEnrichment } = await import('../services/tagManager');
      newKeywords = [...(await rebuildKeywordsFromEnrichment(tagId))].sort();
      updated.keywords = newKeywords;
    } else {
      newKeywords = [...updates.keywords].sort();
    }

    // If keywords changed, retro-scan existing articles for the updated tag
    if (JSON.stringify(oldKeywords) !== JSON.stringify(newKeywords)) {
      const { backfillTagMatches } = await import('../services/tagBackfill');
      backfillTagMatches(tagId, { dryRun: false, priority: true }).catch((err: any) => {
        console.error('[AdminTags] backfillTagMatches error:', err.message);
      });
    }

    // Build tag response — always include ticker/exchange/trend/sector (frontend expects them)
    const tagResponse: any = {
      tag_id: updated.tag_id,
      tag_name: updated.tag_name,
      tag_type: updated.tag_type,
      keywords: updated.keywords || [],
      created_at: updated.created_at,
      is_verified: updated.is_verified === true || updated.is_verified === 1,
      ticker: ed.ticker || null,
      symbol: ed.symbol || null,
      mic: ed.mic || null,
      website: ed.website || null,
      websites: ed.websites || (ed.website ? [ed.website] : []),
      wikipedia_url: ed.wikipedia_url || null,
      country: ed.country || null,
      isin: ed.isin || null,
      sectors: ed.sectors || (ed.sector ? [ed.sector] : []),
      trends: ed.trends || (ed.trend ? [ed.trend] : []),
      description: ed.description_ru || null,
      description_ru: ed.description_ru || null,
      key_products: ed.key_products || [],
      synonyms_ru: ed.synonyms_ru || [],
      synonyms_en: ed.synonyms_en || [],
      related_tags: ed.related_tags || ed.related_entities || [],
      exchange: ed.exchange || null,
      trend: ed.trend || null,
      sector: ed.sector || null,
      geo_countries: ed.geo_countries || (ed.country ? [ed.country] : []),
      geo_regions: ed.geo_regions || [],
      geo_cities: ed.geo_cities || [],
    };

    // Any successful tag update may affect matching keywords.
    // Invalidate cache and wake up no-tags articles for re-check.
    const { wakeUpNoTagsArticlesCoalesced } = await import('../services/tagManager');
    const { invalidateUserTagsCache } = await import('../services/smartTagMatcher');
    invalidateUserTagsCache();
    adminCacheInvalidate('admin-tags');
    adminCacheInvalidate('llm-');
    wakeUpNoTagsArticlesCoalesced().catch((err: any) => {
      console.error('[AdminTags] wakeUpNoTagsArticlesCoalesced error:', err.message);
    });

    res.json({
      success: true,
      updated_fields: Object.keys(updates),
      tag: tagResponse,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /admin/tags/:tagId/enrich — run LLM enrichment manually from admin UI
// ═══════════════════════════════════════════════════════════════════════════
router.post('/tags/:tagId/enrich', adminMiddleware, async (req, res) => {
  const tagId = req.params.tagId.toLowerCase();

  try {
    const tagResult = await query(
      `SELECT tag_id, tag_name, tag_type, enriched_data FROM user_defined_tags WHERE tag_id = $1`,
      [tagId]
    );
    if (tagResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    const tag = tagResult.rows[0];

    console.log(`[AdminEnrich] Starting enrichment for "${tag.tag_name}" (${tagId})`);

    const { enrichTagViaLLM, generateTagKeywords, buildEnrichedKeywords, wakeUpNoTagsArticlesCoalesced, TAG_TYPES } = await import('../services/tagManager');
    const { invalidateUserTagsCache } = await import('../services/smartTagMatcher');

    const enrichment = await enrichTagViaLLM(tag.tag_name);
    if (!enrichment) {
      return res.status(502).json({ error: 'Enrichment failed — LLM returned no data' });
    }

    const baseKeywords = generateTagKeywords(tag.tag_name);
    const enhancedKeywords = buildEnrichedKeywords(tag.tag_name, enrichment);
    const allKeywords = [...new Set([...baseKeywords, ...enhancedKeywords])]
      .filter(k => k.length >= 2 && k.length <= 50);

    const finalType = TAG_TYPES.includes(enrichment.tag_type) ? enrichment.tag_type : tag.tag_type;

    await query(
      `UPDATE user_defined_tags
       SET enriched_data = $1,
           keywords = $2,
           tag_type = $3
       WHERE tag_id = $4`,
      [JSON.stringify(enrichment), allKeywords, finalType, tagId]
    );

    invalidateUserTagsCache();
    adminCacheInvalidate('admin-tags');
    adminCacheInvalidate('llm-');
    wakeUpNoTagsArticlesCoalesced().catch((err: any) => {
      console.error('[AdminEnrich] wakeUpNoTagsArticlesCoalesced error:', err.message);
    });

    // Ретро-скан существующих новостей по обновлённым keywords
    const { backfillTagMatches } = await import('../services/tagBackfill');
    backfillTagMatches(tagId, { dryRun: false, priority: true }).catch((err: any) => {
      console.error('[AdminEnrich] backfillTagMatches error:', err.message);
    });

    console.log(`[AdminEnrich] Enriched "${tag.tag_name}": type=${enrichment.tag_type}, ticker=${enrichment.ticker || 'none'}, keywords=${allKeywords.length}`);

    res.json({
      success: true,
      enriched: true,
      enrichment: {
        tag_type: enrichment.tag_type,
        ticker: enrichment.ticker,
        website: enrichment.website,
        websites: enrichment.websites || [],
        wikipedia_url: enrichment.wikipedia_url || null,
        country: enrichment.country || null,
        isin: enrichment.isin || null,
        sectors: enrichment.sectors || [],
        trends: enrichment.trends || [],
        description_ru: enrichment.description_ru,
        key_products: enrichment.key_products,
        synonyms_ru: enrichment.synonyms_ru,
        synonyms_en: enrichment.synonyms_en,
        related_entities: enrichment.related_entities,
      },
    });
  } catch (err: any) {
    console.error(`[AdminEnrich] Error for ${tagId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /admin/tags/:tagId/backfill-matches — dry-run preview or apply retro scan
// ═══════════════════════════════════════════════════════════════════════════
router.post('/tags/:tagId/backfill-matches', adminMiddleware, async (req, res) => {
  const tagId = req.params.tagId.toLowerCase();
  const dryRun = req.body?.dryRun !== false; // default dry-run for safety (защита на экзотические конфигурации)
  console.log(`[AdminBackfillMatches] tag=${tagId} dryRun=${dryRun}`);

  try {
    const { backfillTagMatches, countTagMatches, fetchTag, MAX_TOKENS } = await import('../services/tagBackfill');
    const tag = await fetchTag(tagId);
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found', tag_id: tagId });
    }
    if (dryRun) {
      const { matched, tokens } = await countTagMatches(tagId);
      if (tokens === 0) {
        return res.status(400).json({ error: 'No keywords to scan', message: 'Нет ключевых слов для сканирования', tag_id: tagId, matched: 0, tokens: 0 });
      }
      if (tokens > MAX_TOKENS) {
        return res.status(400).json({ error: 'Too many keywords/tokens', message: 'Слишком много ключевых слов/токенов', tag_id: tagId, matched, tokens });
      }
      return res.json({ success: true, dryRun: true, tag_id: tagId, matched, tokens });
    }
    const result = await backfillTagMatches(tagId, { dryRun: false, sync: true, priority: true });
    if (result.error) {
      return res.json({ success: false, ...result });
    }
    if (result.skipped) {
      return res.json({ success: true, skipped: true, message: 'Скан по этому тегу уже идёт — дождись зелёного бейджа', ...result });
    }
    return res.json({ success: true, ...result });
  } catch (err: any) {
    console.error(`[AdminBackfillMatches] Error for ${tagId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /admin/backfill-matches-all — one-shot retro scan for all tags
// ═══════════════════════════════════════════════════════════════════════════
router.post('/backfill-matches-all', adminMiddleware, async (req, res) => {
  try {
    const { backfillAllTags } = await import('../services/tagBackfill');
    const adminUserId = (req as any).user?.userId;
    // Run in background so the HTTP request doesn't time out
    backfillAllTags(adminUserId).then(result => {
      console.log('[AdminBackfillAll] completed:', result);
    }).catch(err => {
      console.error('[AdminBackfillAll] failed:', err.message);
    });
    res.json({ success: true, message: 'Backfill all started in background' });
  } catch (err: any) {
    console.error('[AdminBackfillAll] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /admin/tags/:tagId — atomic cascade delete (PostgreSQL ONLY)
router.delete('/tags/:tagId', adminMiddleware, async (req, res) => {
  // SQLite mode — transactions not supported via pool.connect()
  if (!pool) {
    return res.status(500).json({
      error: 'SQLite mode not supported for admin tag deletion. Use PostgreSQL.',
      code: 'SQLITE_UNSUPPORTED',
    });
  }

  let client: any = null;
  try {
    const tagId = req.params.tagId.toLowerCase();

    // Acquire dedicated connection for the transaction
    client = await pool.connect();

    // Check tag exists first
    const checkResult = await client.query(
      `SELECT tag_id, tag_name FROM user_defined_tags WHERE tag_id = $1`,
      [tagId]
    );
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    const tagName = checkResult.rows[0].tag_name;

    // ════════════════ TRANSACTION START ════════════════
    await client.query('BEGIN');

    // Safety guard against runaway transactions on huge tags
    await client.query("SET LOCAL statement_timeout = '30s'");

    // 1. Delete from portfolios (subscriptions)
    const portfoliosResult = await client.query(`DELETE FROM portfolios WHERE tag_id = $1`, [tagId]);
    const deletedPortfolios = portfoliosResult.rowCount || 0;

    // 2. Clean matched_tags (TEXT[])
    const matchedResult = await client.query(
      `UPDATE news SET matched_tags = array_remove(matched_tags, $1) WHERE $1 = ANY(matched_tags)`,
      [tagId]
    );
    const cleanedMatched = matchedResult.rowCount || 0;

    // 3. Clean tag_impact (JSONB)
    const llmResult = await client.query(
      `UPDATE news SET tag_impact = COALESCE(
        (SELECT jsonb_agg(elem) FROM jsonb_array_elements(tag_impact) elem WHERE elem->>'tag' != $1),
        '[]'::jsonb
      ) WHERE tag_impact @> jsonb_build_array(jsonb_build_object('tag', $1::text))`,
      [tagId]
    );
    const cleanedLlm = llmResult.rowCount || 0;

    // 4. Clean smart_tag_cache (optional table)
    let cleanedCache = 0;
    try {
      const r = await client.query(
        `UPDATE smart_tag_cache SET tags = array_remove(tags, $1) WHERE $1 = ANY(tags)`,
        [tagId]
      );
      cleanedCache = r.rowCount || 0;
    } catch (err: any) {
      if (err.code === '42P01') { /* table does not exist, OK */ }
      else throw err;
    }

    // 5. Delete news_tag_links (optional table)
    let deletedLinks = 0;
    try {
      const r = await client.query(`DELETE FROM news_tag_links WHERE tag_id = $1`, [tagId]);
      deletedLinks = r.rowCount || 0;
    } catch (err: any) {
      if (err.code === '42P01') { /* table does not exist, OK */ }
      else throw err;
    }

    // 6. Clean related_tags in enriched_data of other tags
    const relatedResult = await client.query(
      `UPDATE user_defined_tags
       SET enriched_data = CASE
         WHEN enriched_data IS NULL THEN NULL
         WHEN enriched_data = '{}'::jsonb THEN enriched_data
         WHEN enriched_data->'related_tags' IS NULL THEN enriched_data
         ELSE jsonb_set(
           enriched_data,
           '{related_tags}',
           COALESCE(
             (SELECT jsonb_agg(elem)
              FROM jsonb_array_elements(enriched_data->'related_tags') elem
              WHERE elem #>> '{}' != $1),
             '[]'::jsonb
           )
         )
       END
       WHERE enriched_data ? 'related_tags'
         AND enriched_data->'related_tags' @> to_jsonb($1::text)`,
      [tagId]
    );
    const cleanedRelated = relatedResult.rowCount || 0;

    // 7. Delete the tag itself (LAST!)
    await client.query(`DELETE FROM user_defined_tags WHERE tag_id = $1`, [tagId]);

    // ════════════════ COMMIT ════════════════
    await client.query('COMMIT');

    res.json({
      success: true,
      deleted_tag: tagId,
      tag_name: tagName,
      stats: {
        deleted_news_links: deletedLinks,
        deleted_portfolios: deletedPortfolios,
        cleaned_articles_matched: cleanedMatched,
        cleaned_articles_llm: cleanedLlm,
        cleaned_smart_cache: cleanedCache,
        cleaned_related_tags: cleanedRelated,
      },
    });
  } catch (err: any) {
    // ════════════════ ROLLBACK ════════════════
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rbErr) { /* ignore */ }
    }
    console.error(`[Admin] Delete tag error:`, err.message);
    res.status(500).json({ error: 'Delete failed', code: err.code, message: err.message });
  } finally {
    if (client) client.release();
  }
});

// GET /admin/tags/:tagId/delete-preview — statistics for delete confirmation modal
router.get('/tags/:tagId/delete-preview', adminMiddleware, async (req, res) => {
  try {
    const tagId = req.params.tagId.toLowerCase();

    // Get tag info
    const tagResult = await query(`SELECT tag_id, tag_name FROM user_defined_tags WHERE tag_id = $1`, [tagId]);
    if (tagResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }
    const tagName = tagResult.rows[0].tag_name;

    // Count references
    let linksCount = 0;
    try {
      const r = await query(`SELECT COUNT(*) as count FROM news_tag_links WHERE tag_id = $1`, [tagId]);
      linksCount = parseInt(r.rows[0].count);
    } catch { /* table may not exist */ }

    const portfoliosResult = await query(
      `SELECT COUNT(DISTINCT user_id) as count FROM portfolios WHERE tag_id = $1`, [tagId]
    );
    const portfoliosCount = parseInt(portfoliosResult.rows[0].count);

    const matchedResult = await query(
      `SELECT COUNT(*) as count FROM news WHERE $1::text = ANY(matched_tags)`, [tagId]
    );
    const matchedCount = parseInt(matchedResult.rows[0].count);

    const llmResult = await query(
      `SELECT COUNT(*) as count FROM news WHERE tag_impact @> jsonb_build_array(jsonb_build_object('tag', $1::text))`,
      [tagId]
    );
    const llmCount = parseInt(llmResult.rows[0].count);

    const relatedResult = await query(
      `SELECT COUNT(*) as count FROM user_defined_tags WHERE enriched_data->'related_tags' @> to_jsonb($1::text)`,
      [tagId]
    );
    const relatedCount = parseInt(relatedResult.rows[0].count);

    let cacheCount = 0;
    try {
      const r = await query(`SELECT COUNT(*) as count FROM smart_tag_cache WHERE $1 = ANY(tags)`, [tagId]);
      cacheCount = parseInt(r.rows[0].count);
    } catch { /* table may not exist */ }

    res.json({
      tag_id: tagId,
      tag_name: tagName,
      links_count: linksCount,
      portfolios_count: portfoliosCount,
      matched_articles_count: matchedCount,
      llm_articles_count: llmCount,
      related_tags_count: relatedCount,
      smart_cache_entries: cacheCount,
    });
  } catch (err: any) {
    console.error(`[Admin] Delete preview error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN — News Sources (вкл/выкл RSS и API адаптеров)
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/news-sources — список всех источников
router.get('/news-sources', adminMiddleware, async (req, res) => {
  try {
    const result = await query(`
      SELECT id, name, display_name, type, enabled, last_fetch_at, created_at
      FROM news_sources
      ORDER BY type, name
    `);
    res.json({ sources: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/news-sources/:id/toggle — вкл/выкл
router.put('/news-sources/:id/toggle', adminMiddleware, async (req, res) => {
  try {
    const result = await query(`
      UPDATE news_sources SET enabled = NOT enabled WHERE id = $1
      RETURNING id, name, display_name, type, enabled
    `, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Source not found' });
    }
    res.json({ source: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN — TG Alerts (настройки уведомлений админов)
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/tg-alerts/settings — получить свои настройки
router.get('/tg-alerts/settings', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const adminUserId = req.user?.userId;
    if (!adminUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const settings = await getAdminTgSettings(adminUserId);
    res.json({
      settings: settings || null,
      event_types: ALERT_EVENT_TYPES,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /admin/tg-alerts/settings — сохранить настройки
router.put('/tg-alerts/settings', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const adminUserId = req.user?.userId;
    if (!adminUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { tg_chat_id, event_types, is_active } = req.body;
    if (!tg_chat_id || typeof tg_chat_id !== 'string' || !tg_chat_id.trim()) {
      return res.status(400).json({ error: 'tg_chat_id is required' });
    }
    const types = Array.isArray(event_types) ? event_types.filter((t: string) =>
      ALERT_EVENT_TYPES.some(a => a.value === t)
    ) : [];
    const active = typeof is_active === 'boolean' ? is_active : true;
    const settings = await saveAdminTgSettings(adminUserId, tg_chat_id, types, active);
    if (!settings) {
      return res.status(500).json({ error: 'Failed to save settings' });
    }
    res.json({ settings, event_types: ALERT_EVENT_TYPES });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/tg-alerts/test — отправить тестовое сообщение
router.post('/tg-alerts/test', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const adminUserId = req.user?.userId;
    if (!adminUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const { tg_chat_id } = req.body;
    if (!tg_chat_id || typeof tg_chat_id !== 'string' || !tg_chat_id.trim()) {
      return res.status(400).json({ error: 'tg_chat_id is required' });
    }
    const ok = await sendTestAlert(adminUserId, tg_chat_id.trim());
    if (!ok) {
      return res.status(502).json({ error: 'Failed to send Telegram message. Check chat_id and bot token.' });
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
