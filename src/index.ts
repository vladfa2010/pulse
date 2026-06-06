/**
 * =============================================================================
 * PULSE Backend — Точка входа (Entry Point)
 * =============================================================================
 *
 * Этот файл запускает Express-сервер и инициализирует:
 * 1. Подключение к базе данных (SQLite или PostgreSQL)
 * 2. Создание таблиц (schema.sql) если их ещё нет
 * 3. Запуск cron-задач (RSS агрегация, еженедельные репорты)
 * 4. Запуск HTTP-сервера на порту 3001
 *
 * Последовательность инициализации ВАЖНА:
 *   DB → Schema → Server → Cron
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import { query } from './config/db';          // ← Единая функция для SQL-запросов
import authRoutes from './routes/auth';
import newsRoutes from './routes/news';
import paymentRoutes from './routes/payment';
import userRoutes from './routes/user';
import translateRoutes from './routes/translate';
import webhookRoutes from './routes/webhook';
import adminRoutes from './routes/admin';
import { authMiddleware, AuthRequest } from './middleware/auth';
import { apiLimiter, authLimiter, webhookLimiter } from './middleware/rateLimit';
import { startCron, processArticles } from './services/cron';   // ← RSS агрегатор (каждые 15 мин)
import { startReportCron } from './services/reports'; // ← Еженедельные репорты
import { startDigestCron, sendAllDigests } from './services/digest'; // ← TG дайджест (каждые 3 ч)
import { setupYookassaWebhook } from './routes/payment'; // ← Auto-setup YuKassa webhook
import { addSubscriber, getSubscriberCount } from './services/sse'; // ← Real-time news stream

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
// USE_SQLITE=true → SQLite (локально), иначе → PostgreSQL (на Render)
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ═══════════════════════════════════════════════════════════════════════════
// PostgreSQL vs SQLite datetime helpers for migrations
// ═══════════════════════════════════════════════════════════════════════════
const _SQL_NOW = USE_SQLITE ? "datetime('now')" : 'NOW()';

// ═══════════════════════════════════════════════════════════════════════════
// Middleware — обработка входящих запросов
// ═══════════════════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(apiLimiter);  // ← Rate limiting для всех API запросов (Task 4)

// ═══════════════════════════════════════════════════════════════════════════
// Корневая страница — статус API (показывает что сервер жив)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>...PULSE API status page...</html>`);
});

// Health check — Render использует это для мониторинга
app.get('/health', async (req, res) => {
  // Check cron health
  let cronStatus = 'unknown';
  try {
    const lastRun = await query(`SELECT started_at FROM cron_log ORDER BY started_at DESC LIMIT 1`);
    if (lastRun.rows.length > 0) {
      const minutesAgo = (Date.now() - new Date(lastRun.rows[0].started_at).getTime()) / 60000;
      cronStatus = minutesAgo < 30 ? 'healthy' : minutesAgo < 60 ? 'stale' : 'down';
    } else {
      cronStatus = 'no_runs';
    }
  } catch {
    cronStatus = 'error';
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '8.1.0-cronfreeze-fix',
    cron: cronStatus,
    sse_subscribers: getSubscriberCount(),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Debug admins — list users with is_admin = true
// ═══════════════════════════════════════════════════════════════════════════
app.get('/debug-admins', async (req, res) => {
  const secret = req.headers['x-trigger-secret'];
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await query(
      `SELECT id, email, username, is_admin, created_at 
       FROM users 
       WHERE is_admin = true 
       ORDER BY created_at DESC`
    );
    res.json({
      admin_count: result.rows.length,
      admins: result.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Debug tag search — find tag by name
// ═══════════════════════════════════════════════════════════════════════════
app.get('/debug-tag', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const tagName = req.query.name as string;
  if (!tagName) {
    return res.status(400).json({ error: 'Missing ?name= parameter' });
  }

  try {
    const result = await query(
      `SELECT id, tag_id, name, keywords, synonyms_ru, is_user_defined, created_by, created_at
       FROM tags
       WHERE tag_id ILIKE $1 OR name ILIKE $1
       LIMIT 10`,
      [`%${tagName}%`]
    );
    res.json({
      search: tagName,
      found: result.rows.length,
      tags: result.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Test model availability — checks if a specific model is accessible
// ═══════════════════════════════════════════════════════════════════════════
app.get('/test-model', async (req, res) => {
  const testModel = (req.query.model as string) || 'kimi-k2.5';
  const apiKey = process.env.KIMI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ available: false, error: 'KIMI_API_KEY not set' });
  }

  try {
    const axios = (await import('axios')).default;
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: testModel,
        messages: [{ role: 'user', content: 'Say "OK"' }],
        max_tokens: 10,
      },
      {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 10000,
      }
    );

    res.json({
      available: true,
      model: testModel,
      response: response.data.choices?.[0]?.message?.content || 'no content',
      usage: response.data.usage,
    });
  } catch (err: any) {
    res.json({
      available: false,
      model: testModel,
      error: err.response?.status === 401 ? 'Unauthorized — model not available on current plan' :
             err.response?.status === 404 ? 'Model not found' :
             err.response?.status ? `HTTP ${err.response.status}: ${err.response.data?.error?.message || err.message}` :
             err.message,
      status_code: err.response?.status || null,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup failed articles — removes all articles with llm_error
// Use when deferred processor queue is too large or after LLM downtime
// ═══════════════════════════════════════════════════════════════════════════
app.post('/cleanup-failed-articles', async (req, res) => {
  const secret = req.headers['x-trigger-secret'];
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const before = await query(`SELECT COUNT(*) as count FROM news WHERE llm_error IS NOT NULL`);
    const count = parseInt(before.rows[0]?.count || '0');

    if (count === 0) {
      return res.json({ deleted: 0, message: 'No failed articles found' });
    }

    await query(`DELETE FROM news WHERE llm_error IS NOT NULL`);
    res.json({
      deleted: count,
      message: `Removed ${count} articles with llm_error. Deferred processor queue cleared.`,
    });
    console.log(`[Cleanup] Removed ${count} failed articles`);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration endpoint — applies DB migrations
// ═══════════════════════════════════════════════════════════════════════════
app.post('/migrate-v3', async (req, res) => {
  try {
    const results: string[] = [];
    // ... existing migration code ...
    res.json({ success: true, applied: results });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/migrate-admin', async (req, res) => {
  try {
    const results: string[] = [];

    // Add is_admin column if not exists
    const colCheck = await query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'users' AND column_name = 'is_admin'
    `);
    if (colCheck.rows.length === 0) {
      await query(`ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE`);
      results.push('Added is_admin column to users');
    } else {
      results.push(`is_admin already exists (type: ${colCheck.rows[0].data_type})`);
    }

    // Make vladfa@ya.ru admin
    const updateResult = await query(`
      UPDATE users SET is_admin = TRUE::BOOLEAN WHERE email = 'vladfa@ya.ru'
    `);
    results.push(`Made vladfa@ya.ru admin: ${updateResult.rows.length} rows updated`);

    res.json({ success: true, applied: results });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN MIDDLEWARE & ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// Middleware: verify admin from JWT
async function requireAdmin(req: any, res: any, next: any) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const jwt = require('jsonwebtoken');
    const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
    const decoded = jwt.verify(token, JWT_SECRET);

    if (!decoded.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = decoded;
    next();
  } catch (err: any) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// GET /admin/llm-dashboard — сводка по LLM метрикам (admin only)
app.get('/admin/llm-dashboard', requireAdmin, async (req, res) => {
  try {
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
        COUNT(*) FILTER (WHERE sentiment_source LIKE 'llm-%' AND sentiment_source != 'llm-partial') as failed
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

    // Manual queue (3+ attempts)
    const manualQueue = await query(`
      SELECT COUNT(*) as count
      FROM news
      WHERE llm_attempts >= 3
        AND llm_attempts IS NOT NULL
        AND llm_error IS NOT NULL
    `);

    const t = todayBatches.rows[0];
    const total = parseInt(t?.total || '0');
    const success = parseInt(t?.success || '0');
    const partial = parseInt(t?.partial || '0');
    const failed = parseInt(t?.failed || '0');

    res.json({
      today: {
        batches_total: total,
        batches_success: success,
        batches_partial: partial,
        batches_failed: failed,
        success_rate: total > 0 ? Math.round((success + partial) / total * 100 * 10) / 10 : 0,
        articles_processed: parseInt(todayArticles.rows[0]?.processed || '0'),
        articles_failed: parseInt(todayArticles.rows[0]?.failed || '0'),
        manual_queue: parseInt(manualQueue.rows[0]?.count || '0'),
      },
      errors_by_type: errorsByType.rows,
      hourly_trend: hourly.rows,
      per_tag: perTag.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/llm-errors — список ошибок
app.get('/admin/llm-errors', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const hours = parseInt(req.query.hours as string) || 24;

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

    const manualQueue = await query(`
      SELECT COUNT(*) as count
      FROM news
      WHERE llm_attempts >= 3
        AND llm_attempts IS NOT NULL
        AND llm_error IS NOT NULL
    `);

    res.json({
      total_failed: byType.rows.reduce((sum: number, r: any) => sum + parseInt(r.count), 0),
      by_type: byType.rows,
      manual_queue_count: parseInt(manualQueue.rows[0]?.count || '0'),
      recent: recent.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/backfill
app.post('/admin/backfill', requireAdmin, async (req, res) => {
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
        const { analyzeUnifiedBatch } = await import('./services/smartTagMatcher');
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
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/source-stats — статистика по RSS источникам (admin only)
app.get('/admin/source-stats', requireAdmin, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;

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

    res.json({ hours, sources });
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

// GET /admin/users — список всех пользователей
app.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const usersResult = await query(`
      SELECT
        u.id,
        u.email,
        u.username,
        u.is_verified,
        u.is_admin,
        u.is_blocked,
        u.subscription_active,
        u.subscription_expires_at,
        u.news_count,
        u.created_at,
        s.last_connected_at,
        COALESCE(p.total_payments, 0) as total_payments,
        COALESCE(p.total_amount, 0) as total_amount,
        (SELECT COUNT(*) FROM portfolios WHERE user_id = u.id) as tag_count,
        (SELECT COUNT(*) FROM user_channels WHERE user_id = u.id AND is_active = TRUE) as active_channels,
        (SELECT COUNT(*) FROM user_news_reads WHERE user_id = u.id) as articles_read
      FROM users u
      LEFT JOIN user_sessions s ON s.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COUNT(*) as total_payments, SUM(amount) as total_amount
        FROM payments
        WHERE status = 'succeeded'
        GROUP BY user_id
      ) p ON p.user_id = u.id
      ORDER BY u.created_at DESC
    `);

    res.json({
      total: usersResult.rows.length,
      users: usersResult.rows.map((row: any) => ({
        id: row.id,
        email: row.email,
        username: row.username,
        is_verified: row.is_verified === true || row.is_verified === 1,
        is_admin: row.is_admin === true || row.is_admin === 1,
        is_blocked: row.is_blocked === true || row.is_blocked === 1,
        subscription_active: row.subscription_active === true || row.subscription_active === 1,
        subscription_expires_at: row.subscription_expires_at,
        news_count: parseInt(row.news_count) || 0,
        created_at: row.created_at,
        last_login_at: row.last_connected_at,
        total_payments: parseInt(row.total_payments) || 0,
        total_amount: parseFloat(row.total_amount) || 0,
        tag_count: parseInt(row.tag_count) || 0,
        active_channels: parseInt(row.active_channels) || 0,
        articles_read: parseInt(row.articles_read) || 0,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/users/:id — детали пользователя
app.get('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;

    // User data
    const userResult = await query(`
      SELECT id, email, username, is_verified, is_admin, is_blocked,
             subscription_active, subscription_expires_at, subscription_auto_renew,
             news_count, created_at
      FROM users
      WHERE id = $1
    `, [userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const u = userResult.rows[0];

    // Last login
    const sessionResult = await query(`SELECT last_connected_at FROM user_sessions WHERE user_id = $1`, [userId]);

    // Payments
    const paymentsResult = await query(`
      SELECT id, amount, status, method, paid_at, created_at
      FROM payments
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    // Tags
    const tagsResult = await query(`
      SELECT tag_id, tag_name, tag_type, created_at
      FROM portfolios
      WHERE user_id = $1
      ORDER BY created_at DESC
    `, [userId]);

    // Channels (TG, email)
    const channelsResult = await query(`
      SELECT channel, target, is_active, created_at
      FROM user_channels
      WHERE user_id = $1
    `, [userId]);

    // Login history (last 30 days)
    const loginsResult = await query(`
      SELECT date_trunc('day', read_at) as day, COUNT(*) as count
      FROM user_news_reads
      WHERE user_id = $1 AND read_at > NOW() - INTERVAL '30 days'
      GROUP BY date_trunc('day', read_at)
      ORDER BY day ASC
    `, [userId]);

    // Notification settings
    const notifResult = await query(`SELECT * FROM notification_settings WHERE user_id = $1`, [userId]);

    // Articles read count
    const readsCount = await query(`SELECT COUNT(*) as count FROM user_news_reads WHERE user_id = $1`, [userId]);

    res.json({
      user: {
        id: u.id,
        email: u.email,
        username: u.username,
        is_verified: u.is_verified === true || u.is_verified === 1,
        is_admin: u.is_admin === true || u.is_admin === 1,
        is_blocked: u.is_blocked === true || u.is_blocked === 1,
        subscription_active: u.subscription_active === true || u.subscription_active === 1,
        subscription_expires_at: u.subscription_expires_at,
        subscription_auto_renew: u.subscription_auto_renew === true || u.subscription_auto_renew === 1,
        news_count: parseInt(u.news_count) || 0,
        created_at: u.created_at,
        last_login_at: sessionResult.rows[0]?.last_connected_at || null,
        articles_read: parseInt(readsCount.rows[0]?.count) || 0,
      },
      payments: paymentsResult.rows.map((p: any) => ({
        id: p.id,
        amount: parseFloat(p.amount),
        status: p.status,
        method: p.method,
        paid_at: p.paid_at,
        created_at: p.created_at,
      })),
      total_amount: paymentsResult.rows
        .filter((p: any) => p.status === 'succeeded')
        .reduce((sum: number, p: any) => sum + parseFloat(p.amount), 0),
      tags: tagsResult.rows,
      channels: channelsResult.rows,
      login_history: loginsResult.rows.map((r: any) => ({
        day: r.day,
        count: parseInt(r.count),
      })),
      notifications: notifResult.rows[0] || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/users/:id/reset-password
app.post('/admin/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const bcrypt = await import('bcryptjs');
    const hash = await bcrypt.hash(password, 10);

    await query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, userId]);

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/users/:id/toggle-admin
app.post('/admin/users/:id/toggle-admin', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;

    // Prevent self-demotion
    const adminUser = (req as any).user;
    if (adminUser.userId === userId) {
      return res.status(400).json({ error: 'Cannot change your own admin status' });
    }

    const result = await query(`
      UPDATE users SET is_admin = NOT is_admin WHERE id = $1
      RETURNING is_admin
    `, [userId]);

    res.json({ is_admin: result.rows[0]?.is_admin === true || result.rows[0]?.is_admin === 1 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /admin/users/:id/toggle-block
app.post('/admin/users/:id/toggle-block', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;

    // Prevent self-block
    const adminUser = (req as any).user;
    if (adminUser.userId === userId) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    const result = await query(`
      UPDATE users SET is_blocked = NOT COALESCE(is_blocked, FALSE) WHERE id = $1
      RETURNING is_blocked
    `, [userId]);

    res.json({ is_blocked: result.rows[0]?.is_blocked === true || result.rows[0]?.is_blocked === 1 });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Tags Management
// ═══════════════════════════════════════════════════════════════════════════

// GET /admin/tags — все теги с агрегатами
app.get('/admin/tags', requireAdmin, async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;

    const tagsResult = await query(`
      SELECT
        t.tag_id,
        t.tag_name,
        t.tag_type,
        t.keywords,
        t.created_at,
        COUNT(DISTINCT p.user_id) as subscriber_count,
        COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > NOW() - INTERVAL '${hours} hours') as articles_24h,
        COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > NOW() - INTERVAL '7 days') as articles_7d,
        COUNT(DISTINCT n.id) FILTER (WHERE n.published_at > NOW() - INTERVAL '30 days') as articles_30d,
        ROUND(AVG(n.sentiment_score) FILTER (WHERE n.sentiment_score IS NOT NULL AND n.published_at > NOW() - INTERVAL '${hours} hours'), 1) as avg_sentiment,
        COUNT(*) FILTER (WHERE n.sentiment_source = 'llm' OR n.sentiment_source = 'llm-partial') as llm_success,
        COUNT(*) FILTER (WHERE n.sentiment_source LIKE 'llm-%' AND n.sentiment_source != 'llm-partial') as llm_failed,
        MAX(n.published_at) as last_article_at
      FROM user_defined_tags t
      LEFT JOIN portfolios p ON p.tag_id = t.tag_id
      LEFT JOIN news n ON t.tag_id = ANY(n.matched_tags) AND n.published_at > NOW() - INTERVAL '30 days'
      GROUP BY t.tag_id, t.tag_name, t.tag_type, t.keywords, t.created_at
      ORDER BY articles_24h DESC, subscriber_count DESC
    `);

    res.json({
      hours,
      total: tagsResult.rows.length,
      tags: tagsResult.rows.map((row: any) => ({
        tag_id: row.tag_id,
        tag_name: row.tag_name,
        tag_type: row.tag_type,
        keywords: row.keywords || [],
        created_at: row.created_at,
        subscriber_count: parseInt(row.subscriber_count) || 0,
        articles_24h: parseInt(row.articles_24h) || 0,
        articles_7d: parseInt(row.articles_7d) || 0,
        articles_30d: parseInt(row.articles_30d) || 0,
        avg_sentiment: parseFloat(row.avg_sentiment) || 0,
        llm_success: parseInt(row.llm_success) || 0,
        llm_failed: parseInt(row.llm_failed) || 0,
        last_article_at: row.last_article_at,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/tags/:tagId — детали тега
app.get('/admin/tags/:tagId', requireAdmin, async (req, res) => {
  try {
    const tagId = req.params.tagId;

    // Tag info
    const tagResult = await query(`
      SELECT tag_id, tag_name, tag_type, keywords, enriched_data, created_at
      FROM user_defined_tags
      WHERE tag_id = $1
    `, [tagId]);

    if (tagResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }

    const tag = tagResult.rows[0];
    let relatedTags: string[] = [];
    let ticker = null;
    let website = null;
    let description = null;
    let keyProducts: string[] = [];
    try {
      if (tag.enriched_data?.related_tags) {
        relatedTags = tag.enriched_data.related_tags;
      } else if (tag.enriched_data?.related_entities) {
        relatedTags = tag.enriched_data.related_entities;
      }
      ticker = tag.enriched_data?.ticker || null;
      website = tag.enriched_data?.website || null;
      description = tag.enriched_data?.description_ru || null;
      keyProducts = tag.enriched_data?.key_products || [];
    } catch { /* ignore */ }

    // Daily stats (30 days)
    const dailyResult = await query(`
      SELECT
        date_trunc('day', published_at) as day,
        COUNT(*) as count,
        ROUND(AVG(sentiment_score) FILTER (WHERE sentiment_score IS NOT NULL), 1) as avg_sentiment
      FROM news
      WHERE $1 = ANY(matched_tags)
        AND published_at > NOW() - INTERVAL '30 days'
      GROUP BY date_trunc('day', published_at)
      ORDER BY day ASC
    `, [tagId]);

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

    res.json({
      tag: {
        tag_id: tag.tag_id,
        tag_name: tag.tag_name,
        tag_type: tag.tag_type,
        keywords: tag.keywords || [],
        created_at: tag.created_at,
        related_tags: relatedTags,
        ticker,
        website,
        description,
        key_products: keyProducts,
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
  tag_type: { type: 'enum', values: ['company', 'sector', 'country', 'commodity', 'index'] },
  ticker: { type: 'string', min: 1, max: 20, pattern: /^[A-Z0-9\.\-]+$/, optional: true },
  website: { type: 'url', max: 500, optional: true },
  description_ru: { type: 'string', max: 5000, optional: true },
  keywords: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', max: 100 } },
  key_products: { type: 'array', maxItems: 20, items: { type: 'string', max: 100 }, optional: true },
  related_tags: { type: 'array', maxItems: 20, items: { type: 'string' }, optional: true },
  synonyms_ru: { type: 'array', maxItems: 20, items: { type: 'string', max: 100 }, optional: true },
  synonyms_en: { type: 'array', maxItems: 20, items: { type: 'string', max: 100 }, optional: true },
};

function validateField(key: string, value: any): string | null {
  const rule = TAG_UPDATE_RULES[key];
  if (!rule) return null; // unknown field, skip

  if (value === null || value === undefined) {
    if (rule.optional) return null;
    return `${key} is required`;
  }

  if (rule.type === 'enum') {
    if (!rule.values.includes(value)) return `${key} must be one of: ${rule.values.join(', ')}`;
  }

  if (rule.type === 'string') {
    if (typeof value !== 'string') return `${key} must be a string`;
    if (rule.min && value.length < rule.min) return `${key} min ${rule.min} chars`;
    if (rule.max && value.length > rule.max) return `${key} max ${rule.max} chars`;
    if (rule.pattern && !rule.pattern.test(value)) return `${key} invalid format`;
  }

  if (rule.type === 'url') {
    if (typeof value !== 'string') return `${key} must be a string`;
    if (value.length > (rule.max || 500)) return `${key} max ${rule.max} chars`;
    try { new URL(value); } catch { return `${key} must be a valid URL`; }
  }

  if (rule.type === 'array') {
    if (!Array.isArray(value)) return `${key} must be an array`;
    if (rule.minItems && value.length < rule.minItems) return `${key} min ${rule.minItems} items`;
    if (rule.maxItems && value.length > rule.maxItems) return `${key} max ${rule.maxItems} items`;
    for (const item of value) {
      if (typeof item !== 'string') return `${key} items must be strings`;
      if (rule.items?.max && item.length > rule.items.max) return `${key} item max ${rule.items.max} chars`;
    }
  }

  return null;
}

// Check circular reference for related_tags
async function checkCircularReference(tagId: string, relatedTags: string[]): Promise<boolean> {
  if (!relatedTags || relatedTags.length === 0) return true;
  const result = await query(
    `SELECT tag_id FROM user_defined_tags 
     WHERE tag_id = ANY($1) 
     AND $2 = ANY(COALESCE(related_tags, ARRAY[]::varchar[]))`,
    [relatedTags, tagId]
  );
  return result.rows.length === 0;
}

app.put('/admin/tags/:tagId', requireAdmin, async (req, res) => {
  try {
    const tagId = req.params.tagId;
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

    // keywords minItems check (defense in depth)
    if (updates.keywords !== undefined && updates.keywords.length === 0) {
      return res.status(400).json({
        error: 'keywords cannot be empty (min 1 required)',
        field: 'keywords',
      });
    }

    // Build SET clauses for flat columns AND enriched_data JSONB
    const setClauses: string[] = [];
    const params: any[] = [tagId];
    let paramIdx = 2;

    if (updates.tag_type !== undefined) {
      setClauses.push(`tag_type = $${paramIdx++}`);
      params.push(updates.tag_type);
    }
    if (updates.keywords !== undefined) {
      setClauses.push(`keywords = $${paramIdx++}`);
      params.push(updates.keywords);
    }

    // Build enriched_data JSONB patch
    const jsonbFields = ['ticker', 'website', 'description_ru', 'key_products', 'related_tags', 'synonyms_ru', 'synonyms_en'];
    const jsonbUpdates: string[] = [];
    for (const f of jsonbFields) {
      if (updates[f] !== undefined) {
        jsonbUpdates.push(`'${f}', to_jsonb($${paramIdx++}::text${Array.isArray(updates[f]) ? '[]' : ''})`);
        params.push(updates[f]);
      }
    }
    if (jsonbUpdates.length > 0) {
      setClauses.push(`enriched_data = COALESCE(enriched_data, '{}') || jsonb_build_object(${jsonbUpdates.join(', ')})`);
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const result = await query(`
      UPDATE user_defined_tags
      SET ${setClauses.join(', ')}
      WHERE tag_id = $1
      RETURNING *
    `, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }

    // Unpack enriched_data to flat fields (matches GET /admin/tags/:tagId format)
    const updated = result.rows[0];
    const ed = updated.enriched_data || {};
    res.json({
      success: true,
      updated_fields: Object.keys(updates),
      tag: {
        tag_id: updated.tag_id,
        tag_name: updated.tag_name,
        tag_type: updated.tag_type,
        keywords: updated.keywords || [],
        created_at: updated.created_at,
        related_tags: ed.related_tags || ed.related_entities || [],
        ticker: ed.ticker || null,
        website: ed.website || null,
        description: ed.description_ru || null,
        description_ru: ed.description_ru || null,
        key_products: ed.key_products || [],
        synonyms_ru: ed.synonyms_ru || [],
        synonyms_en: ed.synonyms_en || [],
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /migrate-inline-tag-edit — migrate enriched_data to flat columns
// ═══════════════════════════════════════════════════════════════════════════
app.post('/migrate-inline-tag-edit', async (req, res) => {
  try {
    const secret = req.headers['x-trigger-secret'] || req.query.secret;
    if (secret !== process.env.CRON_SECRET_KEY) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // First, ensure columns exist
    await query(`
      ALTER TABLE user_defined_tags
        ADD COLUMN IF NOT EXISTS ticker VARCHAR(20),
        ADD COLUMN IF NOT EXISTS website VARCHAR(500),
        ADD COLUMN IF NOT EXISTS description_ru TEXT,
        ADD COLUMN IF NOT EXISTS key_products TEXT[] DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS related_tags TEXT[] DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS synonyms_ru TEXT[] DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS synonyms_en TEXT[] DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
    `);

    // Migrate data from enriched_data JSONB if exists
    const result = await query(`
      UPDATE user_defined_tags
      SET
        ticker = COALESCE(ticker, enriched_data->>'ticker'),
        website = COALESCE(website, enriched_data->>'website'),
        description_ru = COALESCE(description_ru, enriched_data->>'description_ru'),
        key_products = COALESCE(
          NULLIF(key_products, '{}'),
          CASE 
            WHEN enriched_data->'key_products' IS NOT NULL 
            THEN ARRAY(SELECT jsonb_array_elements_text(enriched_data->'key_products'))
            ELSE '{}'
          END
        ),
        related_tags = COALESCE(
          NULLIF(related_tags, '{}'),
          CASE 
            WHEN enriched_data->'related_tags' IS NOT NULL 
            THEN ARRAY(SELECT jsonb_array_elements_text(enriched_data->'related_tags'))
            WHEN enriched_data->'related_entities' IS NOT NULL 
            THEN ARRAY(SELECT jsonb_array_elements_text(enriched_data->'related_entities'))
            ELSE '{}'
          END
        ),
        synonyms_ru = COALESCE(
          NULLIF(synonyms_ru, '{}'),
          CASE 
            WHEN enriched_data->'synonyms_ru' IS NOT NULL 
            THEN ARRAY(SELECT jsonb_array_elements_text(enriched_data->'synonyms_ru'))
            ELSE '{}'
          END
        ),
        synonyms_en = COALESCE(
          NULLIF(synonyms_en, '{}'),
          CASE 
            WHEN enriched_data->'synonyms_en' IS NOT NULL 
            THEN ARRAY(SELECT jsonb_array_elements_text(enriched_data->'synonyms_en'))
            ELSE '{}'
          END
        )
      WHERE enriched_data IS NOT NULL
      RETURNING tag_id
    `);

    res.json({
      success: true,
      migrated: result.rows.length,
      message: `Migrated ${result.rows.length} tags from enriched_data to flat columns`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration endpoint — applies DB migrations for LLM error tracking (v3)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/migrate-v3', async (req, res) => {
  try {
    const results: string[] = [];

    // Check which columns already exist
    const colCheck = await query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'news' AND column_name IN ('llm_error', 'llm_attempts', 'last_retry_at', 'llm_raw_preview', 'llm_batch_size', 'llm_results_count')
    `);
    const existingCols = new Set(colCheck.rows.map((r: any) => r.column_name));

    // Add missing columns
    const columnsToAdd = [
      { name: 'llm_error', type: 'TEXT' },
      { name: 'llm_attempts', type: 'INTEGER DEFAULT 0' },
      { name: 'last_retry_at', type: 'TIMESTAMP' },
      { name: 'llm_raw_preview', type: 'TEXT' },
      { name: 'llm_batch_size', type: 'INTEGER' },
      { name: 'llm_results_count', type: 'INTEGER' },
    ];

    for (const col of columnsToAdd) {
      if (!existingCols.has(col.name)) {
        await query(`ALTER TABLE news ADD COLUMN ${col.name} ${col.type}`);
        results.push(`Added column: ${col.name}`);
      } else {
        results.push(`Already exists: ${col.name}`);
      }
    }

    // Expand sentiment_source to VARCHAR(30)
    await query(`ALTER TABLE news ALTER COLUMN sentiment_source TYPE VARCHAR(30)`);
    results.push('Expanded sentiment_source to VARCHAR(30)');

    // Create llm_batches table
    await query(`
      CREATE TABLE IF NOT EXISTS llm_batches (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMP NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMP,
        articles_count INTEGER NOT NULL,
        results_count INTEGER,
        tokens_used INTEGER,
        cost_usd DECIMAL(6,4),
        status VARCHAR(20) NOT NULL,
        error_type VARCHAR(30),
        error_message TEXT,
        raw_response_preview TEXT,
        duration_ms INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
    results.push('Created table: llm_batches');

    // Create indexes
    await query(`CREATE INDEX IF NOT EXISTS idx_news_llm_error ON news(llm_error) WHERE llm_error IS NOT NULL`);
    results.push('Created index: idx_news_llm_error');

    await query(`CREATE INDEX IF NOT EXISTS idx_news_sentiment_source ON news(sentiment_source)`);
    results.push('Created index: idx_news_sentiment_source');

    await query(`CREATE INDEX IF NOT EXISTS idx_news_llm_attempts ON news(llm_attempts) WHERE llm_attempts > 0`);
    results.push('Created index: idx_news_llm_attempts');

    await query(`CREATE INDEX IF NOT EXISTS idx_llm_batches_status ON llm_batches(status)`);
    results.push('Created index: idx_llm_batches_status');

    res.json({ success: true, applied: results });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Migration endpoint — Article Enrichment v3.0 schema
app.post('/migrate-v3-enrichment', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const results: string[] = [];

    await query(`CREATE TABLE IF NOT EXISTS news_tag_links (
      id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      news_id UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
      tag_id VARCHAR(50) NOT NULL,
      impact_score INTEGER,
      impact_reasoning TEXT,
      link_source VARCHAR(20) NOT NULL DEFAULT 'keyword',
      link_version INTEGER DEFAULT 1,
      linked_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(news_id, tag_id, link_source)
    )`);
    results.push('Created table: news_tag_links');

    await query(`CREATE INDEX IF NOT EXISTS idx_news_tag_links_news_id ON news_tag_links(news_id)`);
    results.push('Created index: idx_news_tag_links_news_id');

    await query(`CREATE INDEX IF NOT EXISTS idx_news_tag_links_tag_id ON news_tag_links(tag_id)`);
    results.push('Created index: idx_news_tag_links_tag_id');

    await query(`ALTER TABLE news ADD COLUMN IF NOT EXISTS enrichment_version INTEGER DEFAULT 1`);
    results.push('Added column: news.enrichment_version');

    await query(`CREATE INDEX IF NOT EXISTS idx_news_enrichment_version ON news(enrichment_version)`);
    results.push('Created index: idx_news_enrichment_version');

    // GIN index только для PostgreSQL (SQLite не поддерживает)
    const USE_SQLITE = process.env.USE_SQLITE === 'true';
    if (!USE_SQLITE) {
      await query(`CREATE INDEX IF NOT EXISTS idx_news_tag_impact_gin ON news USING GIN (tag_impact jsonb_path_ops)`);
      results.push('Created index: idx_news_tag_impact_gin (PostgreSQL only)');
    } else {
      results.push('Skipped GIN index (SQLite mode)');
    }

    res.json({ success: true, applied: results });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SSE — Real-time news stream (Server-Sent Events)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/news/stream', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // CORS for EventSource
  addSubscriber(res);
});

// ═══════════════════════════════════════════════════════════════════════════
// NEWS SEARCH — гибридный поиск по тегу (v2 news_tag_links + v1 tag_impact JSONB)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/news/search', async (req, res) => {
  try {
    const tag = (req.query.tag as string)?.toLowerCase();
    const days = Math.min(parseInt(req.query.days as string) || 7, 90);
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    if (!tag) {
      return res.status(400).json({ error: 'tag required' });
    }

    const articles = await query(`
      WITH combined AS (
        -- Новые статьи (v2, enrichment_version = 2) — из news_tag_links
        SELECT 
          n.id,
          n.title_ru,
          n.summary_ru,
          n.source,
          n.published_at,
          n.sentiment,
          n.sentiment_score,
          l.impact_score,
          l.impact_reasoning,
          CASE l.link_source
            WHEN 'llm_impact' THEN 0
            WHEN 'keyword'    THEN 1
            ELSE 2
          END as source_priority
        FROM news n
        JOIN news_tag_links l ON l.news_id = n.id
        WHERE l.tag_id = $1
          AND n.published_at > NOW() - INTERVAL '${days} days'

        UNION ALL

        -- Старые статьи (v1) — из tag_impact JSONB через GIN index
        SELECT 
          n.id,
          n.title_ru,
          n.summary_ru,
          n.source,
          n.published_at,
          n.sentiment,
          n.sentiment_score,
          (t->>'score')::int as impact_score,
          t->>'reasoning' as impact_reasoning,
          99 as source_priority
        FROM news n,
        LATERAL jsonb_array_elements(n.tag_impact) t
        WHERE n.tag_impact @> jsonb_build_array(jsonb_build_object('tag', $1))
          AND t->>'tag' = $1
          AND (n.enrichment_version IS NULL OR n.enrichment_version < 2)
          AND n.published_at > NOW() - INTERVAL '${days} days'
      )
      SELECT DISTINCT ON (id) *
      FROM combined
      ORDER BY id, source_priority, published_at DESC
      LIMIT $2
    `, [tag, limit]);

    res.json({ 
      tag, 
      days, 
      count: articles.rows.length,
      articles: articles.rows 
    });
  } catch (err: any) {
    console.error('[NewsSearch] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Backfill: translate existing EN titles to RU via Kimi
app.get('/backfill-translate', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { translateBatch } = await import('./services/translate');

    // Find news with EN titles (contain latin, no cyrillic)
    // Use COALESCE: prefer title_original if available, else title_ru
    const result = await query(`
      SELECT id, COALESCE(NULLIF(title_original, ''), title_ru) as source_text, title_ru
      FROM news
      WHERE title_ru ~ '[a-zA-Z]' AND title_ru !~ '[а-яёА-ЯЁ]'
      LIMIT 50
    `);

    console.log(`[Backfill-Translate] Found ${result.rows.length} EN titles to translate`);

    let translated = 0;
    const details: { id: string; before: string; after: string }[] = [];

    for (const row of result.rows) {
      try {
        const sourceText = row.source_text || row.title_ru;
        console.log(`[Backfill-Translate] Translating: "${sourceText?.slice(0, 60)}..."`);

        const [newTitle] = await translateBatch([sourceText]);
        if (newTitle && newTitle !== sourceText) {
          await query(`UPDATE news SET title_ru = $1, title_original = $2 WHERE id = $3`, [newTitle, sourceText, row.id]);
          translated++;
          details.push({ id: row.id, before: sourceText.slice(0, 80), after: newTitle.slice(0, 80) });
          console.log(`[Backfill-Translate] ✓ "${newTitle?.slice(0, 60)}..."`);
        } else {
          console.log(`[Backfill-Translate] ✗ No change (API returned same text)`);
        }
      } catch (e: any) {
        console.log(`[Backfill-Translate] Skip: ${e.message?.slice(0, 80)}`);
      }
    }

    res.json({ scanned: result.rows.length, translated, samples: details.slice(0, 5) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Backfill: translate existing EN summaries to RU via Kimi
app.get('/backfill-summary', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { translateBatch } = await import('./services/translate');

    // Find news with EN or empty summary (but EN lang or EN title)
    const result = await query(`
      SELECT id, title_original, title_ru
      FROM news
      WHERE (summary_ru IS NULL OR TRIM(summary_ru) = '' OR summary_ru ~ '^[a-zA-Z]')
        AND (lang_original = 'en' OR title_ru ~ '[a-zA-Z]')
      LIMIT 50
    `);

    console.log(`[Backfill-Summary] Found ${result.rows.length} articles needing summary translation`);

    let translated = 0;
    const details: { id: string; title: string; summary: string }[] = [];

    for (const row of result.rows) {
      try {
        // Use title_original if EN, else title_ru to generate a summary
        const sourceText = row.title_original || row.title_ru;
        if (!sourceText || sourceText.length < 5) continue;

        // Create a summary from the title (translate if EN)
        const [translatedSummary] = await translateBatch([sourceText]);
        if (translatedSummary && translatedSummary.length > 10) {
          await query(`UPDATE news SET summary_ru = $1 WHERE id = $2`, [translatedSummary, row.id]);
          translated++;
          details.push({ id: row.id, title: row.title_ru?.slice(0, 60) || '', summary: translatedSummary.slice(0, 80) });
          console.log(`[Backfill-Summary] ✓ ${row.id.slice(0, 8)}...`);
        }
      } catch (e: any) {
        console.log(`[Backfill-Summary] Skip: ${e.message?.slice(0, 80)}`);
      }
    }

    res.json({ scanned: result.rows.length, translated, samples: details.slice(0, 5) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Check env vars (safe — no secrets exposed)
// GET /debug-telegram — проверка статуса Telegram бота
app.get('/debug-telegram', async (req, res) => {
  try {
    const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    if (!TG_TOKEN) {
      return res.json({ configured: false, error: 'TELEGRAM_BOT_TOKEN not set' });
    }
    const axios = await import('axios');
    const meResp = await axios.default.get(`https://api.telegram.org/bot${TG_TOKEN}/getMe`, { timeout: 15000 });
    const whResp = await axios.default.get(`https://api.telegram.org/bot${TG_TOKEN}/getWebhookInfo`, { timeout: 15000 });
    res.json({
      configured: true,
      bot: meResp.data.ok ? { username: meResp.data.result?.username, name: meResp.data.result?.first_name } : null,
      webhook: whResp.data.ok ? {
        url: whResp.data.result?.url,
        has_custom_certificate: whResp.data.result?.has_custom_certificate,
        pending_update_count: whResp.data.result?.pending_update_count,
        last_error_date: whResp.data.result?.last_error_date,
        last_error_message: whResp.data.result?.last_error_message,
      } : null,
    });
  } catch (err: any) {
    res.json({ configured: false, error: err.message });
  }
});

// GET /debug-cron — статус cron (monitoring)
app.get('/debug-cron', async (req, res) => {
  try {
    // Last 5 cron runs
    const recentRuns = await query(
      `SELECT task_name, started_at, finished_at, articles_fetched, articles_saved, articles_merged, status, errors
       FROM cron_log ORDER BY started_at DESC LIMIT 5`
    );

    // Stats: last 24 hours
    const dayStats = await query(
      `SELECT COUNT(*) as total_runs,
              SUM(articles_saved) as total_saved,
              SUM(articles_merged) as total_merged,
              COUNT(*) FILTER (WHERE status = 'success') as success_count,
              COUNT(*) FILTER (WHERE status = 'warning') as warning_count
       FROM cron_log WHERE started_at > NOW() - INTERVAL '24 hours'`
    );

    // Is cron alive? (last run within 30 minutes for 15-min schedule)
    const lastRun = await query(
      `SELECT started_at FROM cron_log ORDER BY started_at DESC LIMIT 1`
    );
    const isAlive = lastRun.rows.length > 0 &&
      (new Date().getTime() - new Date(lastRun.rows[0].started_at).getTime()) < 30 * 60 * 1000;

    res.json({
      cron_alive: isAlive,
      last_run: lastRun.rows[0]?.started_at || null,
      recent_runs: recentRuns.rows,
      last_24h: dayStats.rows[0],
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug-env', async (req, res) => {
  res.json({
    has_database_url: !!process.env.DATABASE_URL,
    database_url_prefix: process.env.DATABASE_URL ? process.env.DATABASE_URL.slice(0, 20) + '...' : null,
    use_sqlite: process.env.USE_SQLITE === 'true',
    kimi_key_set: !!process.env.KIMI_API_KEY,
    kimi_key_length: process.env.KIMI_API_KEY ? process.env.KIMI_API_KEY.length : 0,
    kimi_key_prefix: process.env.KIMI_API_KEY ? process.env.KIMI_API_KEY.slice(0, 12) + '...' : null,
    kimi_model: process.env.KIMI_MODEL || 'moonshot-v1-32k (default)',
    cron_secret_set: !!process.env.CRON_SECRET_KEY,
    telegram_bot_set: !!process.env.TELEGRAM_BOT_TOKEN,
    telegram_bot_prefix: process.env.TELEGRAM_BOT_TOKEN ? process.env.TELEGRAM_BOT_TOKEN.split(':')[0] + ':...' : null,
    yookassa_shop_id_set: !!process.env.YOOKASSA_SHOP_ID,
    yookassa_secret_key_set: !!process.env.YOOKASSA_SECRET_KEY,
    yookassa_configured: !!(process.env.YOOKASSA_SHOP_ID && process.env.YOOKASSA_SECRET_KEY),
    frontend_url: process.env.FRONTEND_URL || 'https://pulse-frontend-jt53.onrender.com',
    node_env: process.env.NODE_ENV || 'development',
  });
});

// TEMP: Backfill sentiment for existing news — run LLM on last N articles
app.get('/backfill-sentiment', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    // Get articles without sentiment_score (or all if force=true)
    const force = req.query.force === 'true';
    const articlesResult = await query(`
      SELECT id, title_ru, summary_ru, sentiment, sentiment_score
      FROM news
      ${force ? '' : 'WHERE sentiment_score IS NULL'}
      ORDER BY published_at DESC
      LIMIT $1
    `, [limit]);

    const articles = articlesResult.rows;
    if (articles.length === 0) {
      return res.json({ message: 'No articles to process', processed: 0 });
    }

    console.log(`[Backfill] Processing ${articles.length} articles...`);
    const startTime = Date.now();

    // Process in batches of 10 using unified batch (sentiment + tag_impact + is_political)
    const { analyzeUnifiedBatch } = await import('./services/smartTagMatcher');
    const results = await analyzeUnifiedBatch(
      articles.map(a => ({ title: a.title_ru || '', summary: a.summary_ru || '', tags: [] }))
    );

    // Update DB
    let updated = 0;
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      const result = results[i];
      if (!result) continue;

      await query(`
        UPDATE news
        SET sentiment = $1,
            sentiment_score = $2,
            sentiment_reasoning = $3,
            sentiment_source = 'llm',
            is_political = $5
        WHERE id = $4
      `, [result.sentiment, result.score, result.reasoning || null, article.id, result.is_political || false]);
      updated++;
    }

    const duration = Date.now() - startTime;
    console.log(`[Backfill] Done: ${updated}/${articles.length} updated in ${duration}ms`);

    res.json({
      processed: articles.length,
      updated,
      duration_ms: duration,
      sample: results.slice(0, 3).map((r, i) => ({
        title: articles[i].title_ru?.slice(0, 40),
        score: r.score,
        sentiment: r.sentiment,
        is_political: r.is_political,
        reasoning: r.reasoning?.slice(0, 60),
      })),
    });
  } catch (err: any) {
    console.error('[Backfill] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Diagnostic endpoint — check DB health, cron locks, test insert
app.get('/debug-system', async (req, res) => {
  try {
    const lockResult = await query(`SELECT * FROM cron_locks WHERE job_name = 'rss-aggregator'`);
    const lock = lockResult.rows[0] || null;
    const newsCount = await query(`SELECT COUNT(*) as count FROM news`);
    const cronLog = await query(`SELECT * FROM cron_log ORDER BY started_at DESC LIMIT 3`);
    let testInsert = 'not_attempted';
    try {
      await query(`INSERT INTO news (id, title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, all_sources, source_count, published_at, lang_original, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, matched_tags, tag_impact) VALUES ('test-debug', 'Test', 'Тест', 'Тест', 'test', 'test', 'http://test', 'test', 'test-hash-debug', ARRAY['test'], 1, NOW(), 'ru', 'neutral', 0, NULL, 'keyword', ARRAY[]::text[], '{}') ON CONFLICT (content_hash) DO NOTHING`);
      testInsert = 'success';
      await query(`DELETE FROM news WHERE content_hash = 'test-hash-debug'`);
    } catch (e: any) { testInsert = `failed: ${e.message?.slice(0, 100)}`; }
    res.json({ database_url_present: !!process.env.DATABASE_URL, lock: lock ? { job_name: lock.job_name, locked_by: lock.locked_by?.slice(0, 30), locked_at: lock.locked_at, expires_at: lock.expires_at } : null, news_count: parseInt(newsCount.rows[0]?.count || '0'), cron_logs: cronLog.rows.map((r: any) => ({ id: r.id, task: r.task_name, started: r.started_at, status: r.status, fetched: r.articles_fetched, saved: r.articles_saved })), test_insert: testInsert });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /debug-news-recent — все новости за последние N минут (для диагностики)
app.get('/debug-news-recent', async (req, res) => {
  try {
    const minutes = Math.min(parseInt(req.query.minutes as string) || 30, 120);
    // ВСЕ новости за последние N минут
    const allResult = await query(
      `SELECT id, title_ru, source, published_at, fetched_at, matched_tags, array_length(matched_tags, 1) as tag_count
       FROM news
       WHERE published_at > NOW() - INTERVAL '${minutes} minutes'
       ORDER BY published_at DESC
       LIMIT 50`
    );
    const withTags = allResult.rows.filter(r => r.tag_count > 0);
    const withoutTags = allResult.rows.filter(r => !r.tag_count);
    res.json({
      minutes,
      total: allResult.rows.length,
      with_tags: withTags.length,
      without_tags: withoutTags.length,
      articles: allResult.rows.map(r => ({
        published_at: r.published_at,
        title: r.title_ru?.slice(0, 60),
        source: r.source,
        tags: r.matched_tags || [],
        tag_count: r.tag_count || 0,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /debug-latest-reasoning — last 3 articles with full sentiment data
app.get('/debug-latest-reasoning', async (req, res) => {
  try {
    const { query } = await import('./config/db');
    const result = await query(`
      SELECT title_ru, source, sentiment, sentiment_score, sentiment_reasoning, 
             article_type, is_political, matched_tags, tag_impact, published_at
      FROM news
      ORDER BY published_at DESC
      LIMIT 3
    `);
    res.json({
      articles: (result.rows || []).map((r: any) => ({
        title: r.title_ru?.slice(0, 80),
        source: r.source,
        sentiment: r.sentiment,
        score: r.sentiment_score,
        article_type: r.article_type,
        is_political: r.is_political,
        published_at: r.published_at,
        tags: r.matched_tags || [],
        tag_impacts: r.tag_impact || [],
        reasoning: r.sentiment_reasoning,
        reasoning_preview: r.sentiment_reasoning ? r.sentiment_reasoning.slice(0, 200) + (r.sentiment_reasoning.length > 200 ? '...' : '') : '(empty)',
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /debug-llm-raw — last LLM raw response and parse error
app.get('/debug-llm-raw', async (req, res) => {
  try {
    const { getLastLlmDebug } = await import('./services/smartTagMatcher');
    const debug = getLastLlmDebug();
    res.json(debug);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /debug-rss — detailed per-source RSS diagnostics
app.get('/debug-rss', async (req, res) => {
  try {
    const { RSS_SOURCES } = await import('./services/rssSources');
    const { getLastFetchStats } = await import('./services/rssFetcher');
    const { query } = await import('./config/db');

    // Source meta cache state
    const metaResult = await query(`SELECT source_id, last_fetched_at FROM rss_source_meta ORDER BY source_id`);
    const metaRows = metaResult.rows || [];

    // Latest article per source
    const latestResult = await query(`
      SELECT source_id, MAX(published_at) as latest, COUNT(*) as total
      FROM news
      GROUP BY source_id
    `);
    const latestMap: Record<string, { latest: string; total: string }> = {};
    for (const row of latestResult.rows || []) {
      latestMap[row.source_id] = { latest: row.latest, total: row.total };
    }

    // Build per-source report
    const sourceReport = RSS_SOURCES.map(s => {
      const meta = metaRows.find((m: any) => m.source_id === s.id);
      const latest = latestMap[s.id];
      return {
        id: s.id,
        name: s.name,
        url: s.url,
        lang: s.lang,
        last_fetched_at: meta?.last_fetched_at || null,
        latest_article: latest?.latest || null,
        article_count: latest ? parseInt(latest.total) : 0,
      };
    });

    // Last fetch stats (from most recent cron run)
    const fetchStats = getLastFetchStats();

    // Summary
    const okSources = fetchStats.filter(s => s.status === 'ok');
    const errorSources = fetchStats.filter(s => s.status !== 'ok');

    res.json({
      total_sources: RSS_SOURCES.length,
      meta_cache_entries: metaRows.length,
      source_report: sourceReport,
      last_fetch_stats: {
        timestamp: new Date().toISOString(),
        total_attempted: fetchStats.length,
        successful: okSources.length,
        failed: errorSources.length,
        total_articles_found: okSources.reduce((sum, s) => sum + s.items, 0),
        total_articles_kept: okSources.reduce((sum, s) => sum + s.kept, 0),
        per_source: fetchStats,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Cleanup duplicate news by content_hash (keep first, merge sources)
// ⚠️ Только для записей с заполненным content_hash (старые записи с NULL пропускаем)
app.get('/cleanup-content-dups', async (req, res) => {
  try {
    // Find duplicates by content_hash (исключаем NULL — они не дубликаты, а старые записи)
    const dups = await query(`
      SELECT content_hash, array_agg(id ORDER BY published_at) as ids,
             array_agg(source) as sources
      FROM news
      WHERE content_hash IS NOT NULL
      GROUP BY content_hash
      HAVING count(*) > 1
    `);

    let merged = 0;
    for (const row of dups.rows) {
      const ids: string[] = row.ids;
      const sources: string[] = [...new Set(row.sources as string[])]; // unique sources
      const keepId = ids[0]; // keep oldest
      const removeIds = ids.slice(1); // remove rest

      // Update kept record with merged sources
      await query(`UPDATE news SET all_sources = $1, source_count = $2 WHERE id = $3`,
        [sources, sources.length, keepId]);

      // Delete duplicates
      for (const removeId of removeIds) {
        await query(`DELETE FROM news WHERE id = $1`, [removeId]);
        merged++;
      }
    }

    res.json({ cleaned: merged, groups: dups.rows.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// CLEANUP: Reset stuck cron jobs
// ═══════════════════════════════════════════════════════════════════════════
app.post('/cron-cleanup', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  const expected = process.env.CRON_SECRET_KEY || 'pulse-dev-key';
  if (secret !== expected) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { query } = await import('./config/db');
    await query(`UPDATE cron_log SET status = 'stuck_reset', finished_at = NOW() WHERE status = 'running' AND started_at < NOW() - INTERVAL '10 minutes'`);
    res.json({ status: 'cleaned', message: 'Stuck cron jobs reset' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER: Manual RSS fetch (protected by secret key)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/trigger-rss', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  const expected = process.env.CRON_SECRET_KEY || 'pulse-dev-key';
  if (secret !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    console.log('[Trigger] Manual RSS fetch started');
    // Run in background — don't await
    processArticles().catch((err: any) => {
      console.error('[Trigger] RSS fetch failed:', err.message);
    });
    res.json({ status: 'started', message: 'RSS fetch is running in background. Check logs.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════

// TEMP: Test RSS fetch (no save, just fetch + count)
app.get('/test-rss', async (req, res) => {
  try {
    const { fetchAllRSS } = await import('./services/rssFetcher');
    const articles = await fetchAllRSS();
    const sorted = [...articles].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    res.json({
      count: articles.length,
      sources: [...new Set(articles.map(a => a.sourceId))],
      newest: sorted.slice(0, 5).map(a => ({ title: a.title.slice(0, 60), source: a.sourceId, date: a.publishedAt?.toISOString() })),
      oldest: sorted.slice(-3).map(a => ({ title: a.title.slice(0, 60), source: a.sourceId, date: a.publishedAt?.toISOString() })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Full RSS process with await (for debugging)
app.get('/test-process', async (req, res) => {
  try {
    const start = Date.now();
    // Capture console.error output
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => errors.push(args.map(a => String(a)).join(' '));
    await processArticles();
    console.error = origError;
    const elapsed = Date.now() - start;
    const count = await query('SELECT COUNT(*) as c FROM news');
    res.json({ status: 'done', elapsed_ms: elapsed, news_count: parseInt(count.rows[0]?.c || '0'), errors: errors.slice(0, 20) });
  } catch (err: any) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// TEMP: Debug DB schema + constraints
app.get('/debug-db', async (req, res) => {
  try {
    const columns = await query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'news'
      ORDER BY ordinal_position
    `);
    const count = await query('SELECT COUNT(*) as c FROM news');
    // Check UNIQUE constraints on content_hash
    const constraints = await query(`
      SELECT tc.constraint_name, tc.constraint_type, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
      WHERE tc.table_name = 'news' AND kcu.column_name = 'content_hash'
    `);
    // Check indexes on content_hash
    const indexes = await query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'news' AND indexdef LIKE '%content_hash%'
    `);
    // Summary translation stats
    const summaryStats = await query(`
      SELECT
        COUNT(*) FILTER (WHERE summary_ru IS NULL OR TRIM(summary_ru) = '') as empty,
        COUNT(*) FILTER (WHERE summary_ru IS NOT NULL AND TRIM(summary_ru) != '') as filled,
        COUNT(*) FILTER (WHERE (summary_ru IS NULL OR TRIM(summary_ru) = '') AND lang_original = 'en') as en_empty,
        COUNT(*) FILTER (WHERE (summary_ru IS NULL OR TRIM(summary_ru) = '') AND lang_original = 'ru') as ru_empty
      FROM news
    `);
    // Date distribution
    const dateDist = await query(`
      SELECT
        COUNT(*) FILTER (WHERE published_at > NOW() - INTERVAL '7 days') as d7,
        COUNT(*) FILTER (WHERE published_at > NOW() - INTERVAL '14 days') as d14,
        COUNT(*) FILTER (WHERE published_at > NOW() - INTERVAL '30 days') as d30,
        COUNT(*) FILTER (WHERE published_at > NOW() - INTERVAL '90 days') as d90,
        MIN(published_at) as oldest,
        MAX(published_at) as newest
      FROM news
    `);
    // DB size
    const dbSize = await query(`SELECT pg_size_pretty(pg_database_size(current_database())) as size`);
    res.json({
      columns: columns.rows,
      news_count: parseInt(count.rows[0]?.c || '0'),
      content_hash_constraints: constraints.rows,
      content_hash_indexes: indexes.rows,
      summary_stats: summaryStats.rows[0],
      date_distribution: dateDist.rows[0],
      db_size: dbSize.rows[0]?.size,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});



// TEMP: Source stats — news count per source for today
app.get('/source-stats', async (req, res) => {
  try {
    const finamSources = [
      'finam_companies', 'finam_news', 'finam_forecasts', 'finam_world',
      'finam_analytics', 'finam_bonds_news', 'finam_bonds_comments'
    ];
    // Count per finam source today
    const todayCounts = await query(`
      SELECT source_id, COUNT(*) as count
      FROM news
      WHERE source_id = ANY($1)
        AND fetched_at > NOW() - INTERVAL '24 hours'
      GROUP BY source_id
      ORDER BY count DESC
    `, [finamSources]);
    // Total finam today
    const totalFinam = await query(`
      SELECT COUNT(*) as count
      FROM news
      WHERE source_id LIKE 'finam_%'
        AND fetched_at > NOW() - INTERVAL '24 hours'
    `);
    // Top 10 sources today (all)
    const topSources = await query(`
      SELECT source_id, COUNT(*) as count
      FROM news
      WHERE fetched_at > NOW() - INTERVAL '24 hours'
      GROUP BY source_id
      ORDER BY count DESC
      LIMIT 10
    `);
    // Total all sources today
    const totalToday = await query(`
      SELECT COUNT(*) as count
      FROM news
      WHERE fetched_at > NOW() - INTERVAL '24 hours'
    `);
    res.json({
      finam_today: parseInt(totalFinam.rows[0]?.count || '0'),
      finam_breakdown: todayCounts.rows,
      all_top_sources_today: topSources.rows,
      all_total_today: parseInt(totalToday.rows[0]?.count || '0'),
      date: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// Sentiment Total — overall sentiment delta for ALL news (no tag filter)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/sentiment-total', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;

    // Daily sentiment counts for ALL news
    const dailyResult = await query(`
      SELECT
        DATE(published_at) as day,
        sentiment,
        COUNT(*) as count
      FROM news
      WHERE published_at > NOW() - INTERVAL '${days} days'
        AND sentiment IS NOT NULL
      GROUP BY DATE(published_at), sentiment
      ORDER BY day
    `, []);

    // Build response: day -> {positive, negative, neutral, delta}
    const dailyMap: Record<string, {positive: number; negative: number; neutral: number; delta: number}> = {};
    for (const row of dailyResult.rows) {
      let dayKey = row.day;
      if (typeof dayKey === 'object' && dayKey !== null) {
        dayKey = new Date(dayKey).toISOString().split('T')[0];
      }
      if (!dailyMap[dayKey]) dailyMap[dayKey] = {positive: 0, negative: 0, neutral: 0, delta: 0};
      dailyMap[dayKey][row.sentiment as 'positive' | 'negative' | 'neutral'] += parseInt(row.count);
    }

    // Calculate delta and build array
    const daily: any[] = [];
    for (const [day, data] of Object.entries(dailyMap)) {
      data.delta = data.positive - data.negative;
      daily.push({day, ...data});
    }
    daily.sort((a, b) => a.day.localeCompare(b.day));

    // Totals
    const totalPos = daily.reduce((s, d) => s + d.positive, 0);
    const totalNeg = daily.reduce((s, d) => s + d.negative, 0);
    const totalNeu = daily.reduce((s, d) => s + d.neutral, 0);

    res.json({
      days,
      total: {positive: totalPos, negative: totalNeg, neutral: totalNeu, delta: totalPos - totalNeg},
      daily,
    });
  } catch (err: any) {
    console.error('[SentimentTotal] Error:', err.message);
    res.status(500).json({error: err.message});
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Sentiment Stats — sentiment delta by day per tag (for analytics dashboard)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/sentiment-stats', async (req, res) => {
  try {
    const userId = req.query.userId as string;
    const days = parseInt(req.query.days as string) || 7;
    if (!userId) {
      return res.status(400).json({ error: 'userId required' });
    }

    // 1. Get user's tags
    const tagsResult = await query(
      `SELECT tag_id, tag_name FROM portfolios WHERE user_id = $1`,
      [userId]
    );
    const tags = tagsResult.rows;
    if (tags.length === 0) {
      return res.json({ tags: [], daily: [], summary: {} });
    }

    const tagIds = tags.map((t: any) => t.tag_id);

    // 2. Daily sentiment counts per tag
    const dailyResult = await query(
      `SELECT
         DATE(published_at) as day,
         UNNEST(matched_tags) as tag,
         sentiment,
         COUNT(*) as count
       FROM news
       WHERE published_at > NOW() - INTERVAL '${days} days'
         AND matched_tags && $1
         AND sentiment IS NOT NULL
       GROUP BY DATE(published_at), UNNEST(matched_tags), sentiment
       ORDER BY day DESC, tag`,
      [tagIds]
    );

    // 3. Summary: total pos/neg/neutral per tag
    const summaryResult = await query(
      `SELECT
         UNNEST(matched_tags) as tag,
         sentiment,
         COUNT(*) as count
       FROM news
       WHERE published_at > NOW() - INTERVAL '${days} days'
         AND matched_tags && $1
         AND sentiment IS NOT NULL
       GROUP BY UNNEST(matched_tags), sentiment`,
      [tagIds]
    );

    // Build summary per tag
    const summary: Record<string, { positive: number; negative: number; neutral: number; total: number }> = {};
    for (const row of summaryResult.rows) {
      if (!tagIds.includes(row.tag)) continue;
      if (!summary[row.tag]) summary[row.tag] = { positive: 0, negative: 0, neutral: 0, total: 0 };
      summary[row.tag][row.sentiment as 'positive' | 'negative' | 'neutral'] += parseInt(row.count);
      summary[row.tag].total += parseInt(row.count);
    }

    // Build daily timeline
    const dailyMap: Record<string, Record<string, { positive: number; negative: number; neutral: number; delta: number }>> = {};
    for (const row of dailyResult.rows) {
      if (!tagIds.includes(row.tag)) continue;
      const day = row.day;
      const tag = row.tag;
      if (!dailyMap[day]) dailyMap[day] = {};
      if (!dailyMap[day][tag]) dailyMap[day][tag] = { positive: 0, negative: 0, neutral: 0, delta: 0 };
      dailyMap[day][tag][row.sentiment as 'positive' | 'negative' | 'neutral'] += parseInt(row.count);
    }
    // Calculate delta (positive - negative) for each day/tag
    const daily: any[] = [];
    for (const [day, tagsData] of Object.entries(dailyMap)) {
      for (const [tag, data] of Object.entries(tagsData)) {
        data.delta = data.positive - data.negative;
        daily.push({ day, tag, ...data });
      }
    }
    daily.sort((a, b) => b.day.localeCompare(a.day));

    res.json({
      tags: tags.map((t: any) => ({ id: t.tag_id, name: t.tag_name })),
      days,
      summary,
      daily,
    });
  } catch (err: any) {
    console.error('[SentimentStats] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// API Routes — все эндпоинты начинаются с /api/
// ═══════════════════════════════════════════════════════════════════════════
app.use('/api/auth', authLimiter, authRoutes);  // Строгий лимит (5/15min) — защита от брутфорса
app.use('/api/news', newsRoutes);       // GET /api/news, /api/news/:tag
app.use('/api/payment', paymentRoutes); // POST /api/payment/create, /confirm
app.use('/api/user', userRoutes);       // GET/POST/DELETE /api/user/tags
app.use('/api/translate', translateRoutes);
app.use('/api/webhook', webhookLimiter, webhookRoutes); // Высокий лимит для YuKassa
app.use('/api/admin', adminRoutes);     // GET /api/admin/users, /stats

// ═══════════════════════════════════════════════════════════════════════════
// Telegram Bot — generate secure link for connecting account
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/telegram/link', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    console.log(`[Telegram Link] User ${userId} requesting link`);

    // Check subscription
    const userResult = await query(
      `SELECT subscription_active FROM users WHERE id = $1`,
      [userId]
    );
    console.log(`[Telegram Link] User ${userId} subscription:`, userResult.rows[0]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!userResult.rows[0].subscription_active) {
      return res.status(403).json({ error: 'Premium subscription required' });
    }

    // Generate secure token
    const linkToken = generateLinkToken(userId);
    const botUsername = 'Insidepulse_bot';
    const deepLink = `https://t.me/${botUsername}?start=${userId}:${linkToken}`;

    console.log(`[Telegram Link] Generated link for user ${userId}`);
    res.json({
      deepLink,
      botUsername,
      expiresIn: '24h',
    });
  } catch (err: any) {
    console.error('[Telegram Link] Error:', err.message, err.stack);
    res.status(500).json({ error: 'Failed to generate link: ' + err.message });
  }
});

// TEMP: Backfill matched_tags for existing articles without tags
app.get('/backfill-tags', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { smartMatchTags } = await import('./services/smartTagMatcher');

    // Find articles without matched_tags
    const articles = await query(
      `SELECT id, title_ru, summary_ru FROM news
       WHERE matched_tags IS NULL OR array_length(matched_tags, 1) IS NULL
       LIMIT 200`
    );

    let updated = 0;
    for (const row of articles.rows) {
      const tags = await smartMatchTags(row.title_ru, row.summary_ru);
      if (tags.length > 0) {
        await query(
          `UPDATE news SET matched_tags = $1 WHERE id = $2`,
          [tags, row.id]
        );
        updated++;
      }
    }

    res.json({ processed: articles.rows.length, updated_with_tags: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Quick tag distribution query
app.get('/quick-tags', async (req, res) => {
  try {
    const result = await query(`
      SELECT matched_tags, COUNT(*) as c
      FROM news
      WHERE matched_tags IS NOT NULL AND array_length(matched_tags, 1) > 0
      GROUP BY matched_tags
      ORDER BY c DESC
      LIMIT 30
    `);
    res.json({ tags: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Cleanup news — keep only 50 latest
app.get('/cleanup-news', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // Count before
    const before = await query('SELECT COUNT(*) as c FROM news');
    const beforeCount = parseInt(before.rows[0]?.c || '0');

    // Keep 50 latest by published_at
    await query(`
      DELETE FROM news
      WHERE id NOT IN (
        SELECT id FROM news
        ORDER BY published_at DESC
        LIMIT 50
      )
    `);

    // Clean up orphaned reads
    await query(`
      DELETE FROM user_news_reads
      WHERE news_id NOT IN (SELECT id FROM news)
    `);

    // Clean caches
    await query(`DELETE FROM translation_cache`);
    await query(`DELETE FROM smart_tag_cache`);

    // Count after
    const after = await query('SELECT COUNT(*) as c FROM news');
    const afterCount = parseInt(after.rows[0]?.c || '0');

    res.json({
      before: beforeCount,
      after: afterCount,
      deleted: beforeCount - afterCount,
      message: 'Kept 50 latest news, cleaned caches and orphaned reads',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /all-tags — ALL tags from user portfolios + user_defined_tags
app.get('/all-tags', async (req, res) => {
  try {
    // Get all unique tag_names from portfolios (where users actually add tags)
    const portfolioTagsResult = await query(`
      SELECT DISTINCT tag_name, tag_id, tag_type
      FROM portfolios
      ORDER BY tag_name
    `);

    // Get all tags from user_defined_tags (global catalog)
    const catalogTagsResult = await query(`
      SELECT tag_name, tag_type, enriched_data
      FROM user_defined_tags
      ORDER BY tag_name
    `);

    // Merge: portfolio tags + catalog tags
    const allTagNames = new Set([
      ...portfolioTagsResult.rows.map((r: any) => r.tag_name),
      ...catalogTagsResult.rows.map((r: any) => r.tag_name),
    ]);

    // Get tag counts from news (how many times each tag was matched)
    const newsCountsResult = await query(`
      SELECT unnest(matched_tags) as tag_name, COUNT(*) as count
      FROM news
      WHERE matched_tags IS NOT NULL AND array_length(matched_tags, 1) > 0
      GROUP BY tag_name
    `);
    const newsCounts = new Map(newsCountsResult.rows.map((r: any) => [r.tag_name, parseInt(r.count)]));

    // Get user portfolio counts (how many users track each tag)
    const portfolioCountsResult = await query(`
      SELECT tag_name, COUNT(DISTINCT user_id) as user_count
      FROM portfolios
      GROUP BY tag_name
    `);
    const portfolioCounts = new Map(portfolioCountsResult.rows.map((r: any) => [r.tag_name, parseInt(r.user_count)]));

    // Build catalog info map
    const catalogInfo = new Map(catalogTagsResult.rows.map((r: any) => [r.tag_name, {
      tag_type: r.tag_type,
      has_enrichment: !!r.enriched_data,
    }]));

    const tags = Array.from(allTagNames).map(tagName => {
      const catalog = catalogInfo.get(tagName);
      return {
        tag_name: tagName,
        tag_type: catalog?.tag_type || null,
        has_enrichment: catalog?.has_enrichment || false,
        news_count: newsCounts.get(tagName) || 0,
        user_count: portfolioCounts.get(tagName) || 0,
      };
    });

    res.json({
      total: tags.length,
      from_portfolios: portfolioTagsResult.rows.length,
      from_catalog: catalogTagsResult.rows.length,
      tags,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// TEMP: Stats on matched_tags distribution
app.get('/tag-stats', async (req, res) => {
  try {
    const withTags = await query(`SELECT COUNT(*) as c FROM news WHERE matched_tags IS NOT NULL AND array_length(matched_tags, 1) > 0`);
    const withoutTags = await query(`SELECT COUNT(*) as c FROM news WHERE matched_tags IS NULL OR array_length(matched_tags, 1) IS NULL`);

    const tagDist = await query(`
      SELECT unnest(matched_tags) as tag, COUNT(*) as count
      FROM news
      WHERE matched_tags IS NOT NULL AND array_length(matched_tags, 1) > 0
      GROUP BY tag
      ORDER BY count DESC
      LIMIT 20
    `);

    res.json({
      with_tags: parseInt(withTags.rows[0]?.c || '0'),
      without_tags: parseInt(withoutTags.rows[0]?.c || '0'),
      tag_distribution: tagDist.rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LLM ANALYTICS — Public endpoint for debugging
// ═══════════════════════════════════════════════════════════════════════════

app.get('/llm-analytics', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;

    // 1. Articles with reasoning (their status)
    const articles = await query(`
      SELECT published_at, title_ru, sentiment_source, sentiment_score, sentiment_reasoning,
             llm_error, llm_attempts, llm_batch_size, llm_results_count, matched_tags
      FROM news
      WHERE created_at > NOW() - INTERVAL '${hours} hours'
        AND (sentiment_source LIKE 'llm%' OR sentiment_reasoning IS NOT NULL)
      ORDER BY published_at DESC
      LIMIT 100
    `);

    // 2. Statistics
    const stats = await query(`
      SELECT
        COUNT(*) FILTER (WHERE sentiment_source = 'llm') as llm_success,
        COUNT(*) FILTER (WHERE sentiment_source = 'llm-partial') as llm_partial,
        COUNT(*) FILTER (WHERE sentiment_source LIKE 'llm-%' AND sentiment_source != 'llm-partial') as llm_error,
        COUNT(*) FILTER (WHERE sentiment_reasoning IS NOT NULL AND sentiment_source NOT LIKE 'llm-%') as with_reasoning,
        COUNT(*) FILTER (WHERE sentiment_reasoning IS NULL AND matched_tags IS NOT NULL AND array_length(matched_tags, 1) > 0) as empty_with_tags,
        COUNT(*) as total
      FROM news
      WHERE created_at > NOW() - INTERVAL '${hours} hours'
    `);

    // 3. Error breakdown
    const errors = await query(`
      SELECT sentiment_source, COUNT(*) as count
      FROM news
      WHERE sentiment_source LIKE 'llm-%'
        AND created_at > NOW() - INTERVAL '${hours} hours'
      GROUP BY sentiment_source
      ORDER BY count DESC
    `);

    // 4. Batch stats
    const batches = await query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'success') as success,
        COUNT(*) FILTER (WHERE status = 'partial') as partial,
        COUNT(*) FILTER (WHERE status = 'error') as failed
      FROM llm_batches
      WHERE started_at > NOW() - INTERVAL '${hours} hours'
    `);

    res.json({
      period_hours: hours,
      stats: stats.rows[0],
      errors: errors.rows,
      batches: batches.rows[0],
      articles: articles.rows.map((r: any) => ({
        time: r.published_at,
        title: r.title_ru?.slice(0, 60),
        source: r.sentiment_source,
        score: r.sentiment_score,
        has_reasoning: !!r.sentiment_reasoning,
        reasoning_preview: r.sentiment_reasoning ? r.sentiment_reasoning.slice(0, 80) : null,
        llm_error: r.llm_error,
        attempts: r.llm_attempts,
        batch_size: r.llm_batch_size,
        results_count: r.llm_results_count,
        tags: r.matched_tags,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// HMAC helper for secure Telegram linking
// ═══════════════════════════════════════════════════════════════════════════
function verifyLinkToken(userId: string, token: string): boolean {
  const secret = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(userId).digest('hex').slice(0, 16);
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(token, 'hex'));
}

export function generateLinkToken(userId: string): string {
  const secret = process.env.TELEGRAM_BOT_TOKEN || '';
  return crypto.createHmac('sha256', secret).update(userId).digest('hex').slice(0, 16);
}

// Trigger digest manually (admin)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/trigger-digest', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    sendAllDigests();
    res.json({ status: 'started', message: 'Digest distribution running in background' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TG webhook helper
// ═══════════════════════════════════════════════════════════════════════════
async function sendTelegramReply(chatId: string, text: string): Promise<void> {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!BOT_TOKEN) return;

  try {
    const axios = (await import('axios')).default;
    await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
  } catch (err) {
    console.error('[TG Reply] Failed:', (err as Error).message);
  }
}

function escapeMd(text: string): string {
  return text.replace(/[_*\[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// 404 — если роут не найден
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ═══════════════════════════════════════════════════════════════════════════
// Инициализация и запуск сервера
// ═══════════════════════════════════════════════════════════════════════════
async function start() {

  // ─── Шаг 1: Инициализация базы данных ─────────────────────────────────
  if (USE_SQLITE) {
    // SQLite: создаём файл и таблицы через db-sqlite.ts
    const sqlite = await import('./config/db-sqlite');
    await sqlite.initSQLite();
    await sqlite.initSQLiteSchema();
  } else {
    // PostgreSQL: создаём таблицы из schema.sql если их ещё нет
    try {
      const fs = await import('fs');
      const path = await import('path');
      // __dirname = /app/dist (после компиляции tsc)
      // schema.sql копируется в dist/models/ через Dockerfile
      const schemaPath = path.join(__dirname, 'models', 'schema.sql');
      console.log('[PostgreSQL] Looking for schema at:', schemaPath);

      if (fs.existsSync(schemaPath)) {
        const schema = fs.readFileSync(schemaPath, 'utf-8');
        const statements = schema.split(';').filter(s => s.trim());
        console.log(`[PostgreSQL] Found ${statements.length} statements`);

        for (const stmt of statements) {
          if (stmt.trim()) {
            try {
              await query(stmt + ';');
              console.log('[PostgreSQL] OK:', stmt.trim().substring(0, 50));
            } catch (e: any) {
              // Игнорируем "already exists" — таблица уже создана
              if (!e.message?.includes('already exists')) {
                console.log('[PostgreSQL] WARN:', e.message?.substring(0, 80));
              }
            }
          }
        }
        console.log('[PostgreSQL] Schema initialized');
      } else {
        console.error('[PostgreSQL] schema.sql NOT FOUND at', schemaPath);
      }
    } catch (err: any) {
      console.error('[PostgreSQL] Schema init error:', err.message);
    }
  }

  // ─── Шаг 2: Миграции ──────────────────────────────────────────────────
  // Добавляем колонки и constraints, которые могут отсутствовать
  try {
    await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE`);
    console.log('[DB] Migration: is_admin column ensured');
  } catch { /* ignore */ }
  // url_normalized + content_hash + all_sources + source_count
  const migrations = [
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS url_normalized TEXT`, name: 'url_normalized' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS content_hash TEXT`, name: 'content_hash' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS all_sources TEXT[] DEFAULT '{}'`, name: 'all_sources' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS source_count INTEGER DEFAULT 1`, name: 'source_count' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS tag_impact JSONB DEFAULT '[]'`, name: 'tag_impact' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS sentiment_source VARCHAR(20) DEFAULT 'keyword'`, name: 'sentiment_source' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS sentiment_score INTEGER`, name: 'sentiment_score' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS sentiment_reasoning TEXT`, name: 'sentiment_reasoning' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS is_political BOOLEAN DEFAULT FALSE`, name: 'is_political' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS article_type VARCHAR(10) DEFAULT 'micro'`, name: 'article_type' },
    { sql: `CREATE TABLE IF NOT EXISTS cron_locks (job_name VARCHAR(50) PRIMARY KEY, locked_at TIMESTAMP, locked_by VARCHAR(100), expires_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'cron_locks' },
    { sql: `CREATE TABLE IF NOT EXISTS user_defined_tags (tag_id VARCHAR(50) PRIMARY KEY, tag_name VARCHAR(100) NOT NULL, tag_type VARCHAR(20) DEFAULT 'company', keywords TEXT[] DEFAULT '{}', enriched_data JSONB, created_by UUID REFERENCES users(id), created_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'user_defined_tags' },
    // Telegram digest settings
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS tg_digest_enabled BOOLEAN DEFAULT FALSE`, name: 'tg_digest_enabled' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS digest_frequency VARCHAR(10) DEFAULT '3h'`, name: 'digest_frequency' },
    { sql: `ALTER TABLE user_defined_tags ADD COLUMN IF NOT EXISTS enriched_data JSONB`, name: 'enriched_data' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS last_digest_sent TIMESTAMP`, name: 'last_digest_sent' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS digest_email VARCHAR(255)`, name: 'digest_email' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS email_digest_enabled BOOLEAN DEFAULT FALSE`, name: 'email_digest_enabled' },
    { sql: `CREATE TABLE IF NOT EXISTS cron_log (id ${USE_SQLITE ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY'}, task_name VARCHAR(50) NOT NULL, started_at TIMESTAMP NOT NULL DEFAULT ${_SQL_NOW}, finished_at TIMESTAMP, articles_fetched INTEGER DEFAULT 0, articles_saved INTEGER DEFAULT 0, articles_merged INTEGER DEFAULT 0, errors TEXT, status VARCHAR(20) DEFAULT 'running')`, name: 'cron_log' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_cron_log_started_at ON cron_log(started_at DESC)`, name: 'idx_cron_log_started_at' },
    { sql: `CREATE TABLE IF NOT EXISTS rss_source_meta (source_id VARCHAR(50) PRIMARY KEY, last_fetched_at TIMESTAMP NOT NULL DEFAULT ${USE_SQLITE ? "datetime('now', '-24 hours')" : "NOW() - INTERVAL '24 hours'"}, updated_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'rss_source_meta' },
  ];
  for (const m of migrations) {
    try {
      await query(m.sql);
      console.log(`[DB] Migration: ${m.name} added`);
    } catch (e: any) {
      console.log(`[DB] Migration warning for ${m.name}:`, e.message);
    }
  }
  // Backfill
  try {
    await query(`UPDATE news SET all_sources = ARRAY[source], source_count = 1 WHERE all_sources IS NULL OR array_length(all_sources, 1) IS NULL`);
    console.log('[DB] Migration: backfilled all_sources and source_count');
  } catch (e: any) {
    console.log('[DB] Migration backfill warning:', e.message);
  }
  // UNIQUE(url) на news — предотвращает дубликаты одной и той же новости
  try {
    await query(`ALTER TABLE news ADD CONSTRAINT news_url_unique UNIQUE (url)`);
    console.log('[DB] Migration: news.url unique constraint added');
  } catch { /* ignore — может уже существовать */ }
  // UNIQUE(url_normalized) — защита от нормализованных дублей
  try {
    await query(`ALTER TABLE news ADD CONSTRAINT news_url_norm_unique UNIQUE (url_normalized)`);
    console.log('[DB] Migration: news.url_normalized unique constraint added');
  } catch { /* ignore */ }
  // UNIQUE(content_hash) — одна новость = одна запись
  try {
    await query(`ALTER TABLE news ADD CONSTRAINT news_content_hash_unique UNIQUE (content_hash)`);
    console.log('[DB] Migration: news.content_hash unique constraint added');
  } catch { /* ignore */ }
  // UNIQUE(content_hash) — backup защита по контенту
  try {
    await query(`ALTER TABLE news ADD CONSTRAINT news_content_hash_unique UNIQUE (content_hash)`);
    console.log('[DB] Migration: news.content_hash unique constraint added');
  } catch { /* ignore */ }
  // UNIQUE constraint на user_sessions.user_id
  try {
    await query(`ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_user_id_unique UNIQUE (user_id)`);
    console.log('[DB] Migration: user_sessions.user_id unique constraint added');
  } catch { /* ignore */ }
  // UNIQUE constraint на user_news_reads (user_id, news_id)
  try {
    await query(`ALTER TABLE user_news_reads ADD CONSTRAINT user_news_reads_unique UNIQUE (user_id, news_id)`);
    console.log('[DB] Migration: user_news_reads unique constraint added');
  } catch { /* ignore */ }

  // ─── Шаг 3: Проверка подключения ──────────────────────────────────────
  try {
    const testResult = await query('SELECT NOW() as time');
    console.log('[DB] Connected successfully:', testResult.rows[0].time);
  } catch (err: any) {
    console.error('[DB] Connection test FAILED:', err.message);
  }

// ─── Шаг 4: Запуск HTTP-сервера ───────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`PULSE backend running on port ${PORT}`);
    console.log(`Routes: /api/auth, /api/news, /api/payment, /api/user, /api/translate, /api/webhook, /api/admin`);

    // ─── Шаг 5: Запуск фоновых задач ──────────────────────────────────
    startCron();       // ← RSS агрегация (каждые 15 минут)
    startReportCron(); // ← Еженедельные репорты (воскресенье 13:00)

    // ─── Шаг 6: Настройка YuKassa webhook ─────────────────────────────
    setTimeout(() => {
      setupYookassaWebhook().catch(err => console.error('[YuKassa] Webhook setup error:', err));
    }, 5000); // Задержка 5с чтобы сервер точно был доступен

    // ─── Шаг 7: Настройка Telegram Bot webhook ────────────────────────
    setTimeout(async () => {
      const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
      if (!TG_TOKEN) {
        console.log('[TG Bot] No TELEGRAM_BOT_TOKEN, skipping webhook setup');
        return;
      }
      const WEBHOOK_URL = `${process.env.BACKEND_URL || 'https://pulse-api-bsov.onrender.com'}/api/webhook/telegram`;
      try {
        const axios = await import('axios');
        // Delete old webhook first
        await axios.default.post(`https://api.telegram.org/bot${TG_TOKEN}/deleteWebhook`, {}, { timeout: 15000 });
        // Set new webhook
        const resp = await axios.default.post(
          `https://api.telegram.org/bot${TG_TOKEN}/setWebhook`,
          { url: WEBHOOK_URL },
          { timeout: 15000 }
        );
        if (resp.data.ok) {
          console.log('[TG Bot] Webhook set:', WEBHOOK_URL);
        } else {
          console.error('[TG Bot] Webhook setup failed:', resp.data);
        }
      } catch (err: any) {
        console.error('[TG Bot] Webhook setup error:', err.message);
      }
    }, 8000);

    startDigestCron(); // ← TG дайджест (каждые 3 часа)
  });
}

start();// deploy-check: 1779921938
// force rebuild v5 1779922827
// deploy trigger 1779970311
// build: 1779986393
// deploy check: 1779986817
// build check 1779993464
