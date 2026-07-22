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
import axios from 'axios';
import { query, pool } from './config/db';  // ← query + pool (for transactions)
import { setCachedPopularTags } from './utils/tagCache';
import { slugify } from './utils/slugify';
import authRoutes from './routes/auth';
import newsRoutes from './routes/news';
import factCheckRoutes from './routes/factCheck';
import { startFactCheckCron } from './services/factCheck';
import paymentRoutes from './routes/payment';
import plansRoutes from './routes/plans';
import promoRoutes from './routes/promo';
import featuresRoutes from './routes/features';
import userRoutes from './routes/user';
import translateRoutes from './routes/translate';
import webhookRoutes from './routes/webhook';
import adminRoutes from './routes/admin';
import adminMetricsRoutes from './routes/adminMetrics';
import sentimentRoutes from './routes/sentiment';
import appRoutes from './routes/app';
import { authMiddleware, AuthRequest } from './middleware/auth';
import { apiLimiter, authLimiter, webhookLimiter, forgotPasswordLimiter, passwordResetFlowLimiter, promoValidateLimiter } from './middleware/rateLimit';
import { startCron } from './services/cron';   // RSS cron отключен (TZ_REMOVE_DUPLICATE_RSS_CRON) — модуль оставлен для отката
import { startReportCron, sendWeeklyReportForUser } from './services/reports'; // ← Еженедельные репорты
import { startDigestCron, sendAllDigests } from './services/digest'; // ← TG дайджест (каждый час)
import cron from 'node-cron';
import { resetDailyWindows, refreshImoexCache } from './services/sentimentIndex';
import { sendSentimentVotePush } from './services/push';
import { processScheduledDowngrades, processAutoRenewals, processTrialExpirations, getPlanById } from './services/subscription';
import { isUserEventType } from './types/events';
import { logPageViewPlans } from './services/activityLog';
import { getAdminTgSettings, saveAdminTgSettings, sendTestAlert, ALERT_EVENT_TYPES } from './services/adminAlerts';
import { setupYookassaWebhook } from './routes/payment'; // ← Auto-setup YuKassa webhook
import { addSubscriber, getSubscriberCount, addSentimentSubscriber } from './services/sse'; // ← Real-time news stream

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
// SQLite-safe ALTER TABLE ADD COLUMN IF NOT EXISTS helper
// PostgreSQL supports `IF NOT EXISTS` in ALTER TABLE; SQLite does not.
// This helper parses the migration and checks PRAGMA table_info before adding.
// ═══════════════════════════════════════════════════════════════════════════
async function runMigration(sql: string, name: string) {
  if (USE_SQLITE && /^ALTER TABLE\s+/i.test(sql)) {
    const tableMatch = sql.match(/^ALTER TABLE\s+(\w+)\s+/i);
    if (!tableMatch) return;
    const table = tableMatch[1];
    const parts = sql.split(/ADD COLUMN\s+IF NOT EXISTS/i).slice(1);
    if (parts.length > 0) {
      const info = await query(`PRAGMA table_info(${table})`);
      const existing = new Set(info.rows.map((r: any) => r.name));
      for (const part of parts) {
        const trimmed = part.trim().replace(/,\s*$/, '');
        const colMatch = trimmed.match(/^(\w+)\s+(.+)$/i);
        if (!colMatch) continue;
        const col = colMatch[1];
        const def = colMatch[2];
        if (existing.has(col)) continue;
        await query(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
        existing.add(col);
      }
      console.log(`[DB] Migration: ${name} ensured`);
      return;
    }
  }
  await query(sql);
  console.log(`[DB] Migration: ${name} added`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Middleware — обработка входящих запросов
// ═══════════════════════════════════════════════════════════════════════════
app.set('trust proxy', true); // Required for X-Forwarded-For behind Render proxy
app.use(cors());
app.use(express.json());
app.use(apiLimiter);  // ← Rate limiting для всех API запросов (Task 4)

// ═══════════════════════════════════════════════════════════════════════════
// Корневая страница — статус API (показывает что сервер жив)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>...PULSE API status page...</html>`);
});

// Debug version — точный git commit hash на сервере
app.get('/debug/version', async (req, res) => {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const gitPath = path.join(__dirname, '..', '.git', 'refs', 'heads', 'main');
    let commit = 'unknown';
    if (fs.existsSync(gitPath)) {
      commit = fs.readFileSync(gitPath, 'utf-8').trim().substring(0, 7);
    }
    res.json({ commit, full: commit === 'unknown' ? null : fs.readFileSync(gitPath, 'utf-8').trim() });
  } catch {
    res.json({ commit: 'unknown', full: null });
  }
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
    version: '8.4.0',
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
// Debug tag detail — show full tag data (admin via JWT or secret via URL)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/debug-tag/:tagId', async (req, res) => {
  // Auth: either admin JWT OR secret query param
  const token = req.headers.authorization?.replace('Bearer ', '');
  const secret = req.query.secret as string;
  
  let isAdmin = false;
  
  if (secret && secret === (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    isAdmin = true;
  } else if (token) {
    try {
      const jwt = await import('jsonwebtoken');
      const decoded = jwt.default.verify(token, process.env.JWT_SECRET!) as any;
      isAdmin = !!decoded.is_admin;
    } catch {
      isAdmin = false;
    }
  }
  
  if (!isAdmin) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const tagId = req.params.tagId.toLowerCase();

    // Get tag from user_defined_tags
    const tagResult = await query(
      `SELECT * FROM user_defined_tags WHERE tag_id = $1`,
      [tagId]
    );

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

    // Enriched fields
    const exchange = ed.exchange || null;
    const trend    = ed.trend    || null;
    const sector   = ed.sector   || null;

    // Get article counts
    let linksCount = 0;
    try {
      const linksResult = await query(
        `SELECT COUNT(*) as count FROM news_tag_links WHERE tag_id = $1`,
        [tagId]
      );
      linksCount = parseInt(linksResult.rows[0].count);
    } catch { /* table may not exist */ }

    const matchedResult = await query(
      `SELECT COUNT(*) as count FROM news WHERE $1::text = ANY(matched_tags)`,
      [tagId]
    );

    const llmResult = await query(
      `SELECT COUNT(*) as count FROM news WHERE tag_impact @> jsonb_build_array(jsonb_build_object('tag', $1::text))`,
      [tagId]
    );

    let subsCount = 0;
    try {
      const subscribersResult = await query(
        `SELECT COUNT(DISTINCT user_id) as count FROM portfolios WHERE tag_id = $1`,
        [tagId]
      );
      subsCount = parseInt(subscribersResult.rows[0].count);
    } catch { /* ignore */ }

    // Return same flat format as PUT /admin/tags/:tagId (tag: { ... })
    res.json({
      tag: {
        tag_id: tag.tag_id,
        tag_name: tag.tag_name,
        tag_type: tag.tag_type,
        keywords: tag.keywords || [],
        created_at: tag.created_at,
        related_tags: ed.related_tags || ed.related_entities || [],
        ticker: ed.ticker || null,
        website: ed.website || null,
        description: ed.description_ru || null,
        description_ru: ed.description_ru || null,
        key_products: ed.key_products || [],
        synonyms_ru: ed.synonyms_ru || [],
        synonyms_en: ed.synonyms_en || [],
        exchange,
        trend,
        sector,
      },
      daily_stats: [],
      recent_articles: [],
      subscribers: [],
      subscriber_count: subsCount,
      stats: {
        news_tag_links: linksCount,
        matched_in_articles: parseInt(matchedResult.rows[0].count),
        llm_impact_articles: parseInt(llmResult.rows[0].count),
        subscriber_count: subsCount,
      },
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
// TZ_DELETE_ACCOUNT — Verify deletion: check all tables for orphaned records
// GET /debug/verify-delete/:userId?secret=KEY
// ═══════════════════════════════════════════════════════════════════════════
app.get('/debug/verify-delete/:userId', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const userId = req.params.userId;

  try {
    const checks: any[] = [];

    // 1. users — must be 0 (deleted)
    const u = await query(`SELECT COUNT(*) as c FROM users WHERE id = $1`, [userId]);
    checks.push({ table: 'users', count: parseInt(u.rows[0].c), expected: 0, ok: parseInt(u.rows[0].c) === 0 });

    // 2. payments — must be 0 (cascade deleted)
    const p = await query(`SELECT COUNT(*) as c FROM payments WHERE user_id = $1`, [userId]);
    checks.push({ table: 'payments', count: parseInt(p.rows[0].c), expected: 0, ok: parseInt(p.rows[0].c) === 0 });

    // 3. portfolios — must be 0 (cascade deleted)
    const po = await query(`SELECT COUNT(*) as c FROM portfolios WHERE user_id = $1`, [userId]);
    checks.push({ table: 'portfolios', count: parseInt(po.rows[0].c), expected: 0, ok: parseInt(po.rows[0].c) === 0 });

    // 4. user_sessions — must be 0 (cascade deleted)
    const s = await query(`SELECT COUNT(*) as c FROM user_sessions WHERE user_id = $1`, [userId]);
    checks.push({ table: 'user_sessions', count: parseInt(s.rows[0].c), expected: 0, ok: parseInt(s.rows[0].c) === 0 });

    // 5. user_channels — must be 0 (cascade deleted)
    const c = await query(`SELECT COUNT(*) as c FROM user_channels WHERE user_id = $1`, [userId]);
    checks.push({ table: 'user_channels', count: parseInt(c.rows[0].c), expected: 0, ok: parseInt(c.rows[0].c) === 0 });

    // 6. notification_settings — must be 0 (cascade deleted)
    const n = await query(`SELECT COUNT(*) as c FROM notification_settings WHERE user_id = $1`, [userId]);
    checks.push({ table: 'notification_settings', count: parseInt(n.rows[0].c), expected: 0, ok: parseInt(n.rows[0].c) === 0 });

    // 7. user_news_reads — must be 0 (cascade deleted)
    const r = await query(`SELECT COUNT(*) as c FROM user_news_reads WHERE user_id = $1`, [userId]);
    checks.push({ table: 'user_news_reads', count: parseInt(r.rows[0].c), expected: 0, ok: parseInt(r.rows[0].c) === 0 });

    // 8. user_defined_tags — created_by must be NULL (SET NULL), not deleted
    const t = await query(`SELECT COUNT(*) as c FROM user_defined_tags WHERE created_by = $1`, [userId]);
    checks.push({ table: 'user_defined_tags (old owner)', count: parseInt(t.rows[0].c), expected: 0, ok: parseInt(t.rows[0].c) === 0 });

    // 9. Tags that survived with created_by = NULL
    const t2 = await query(`SELECT tag_id, tag_name FROM user_defined_tags WHERE created_by IS NULL`);
    checks.push({ table: 'user_defined_tags (orphaned)', count: t2.rows.length, tags: t2.rows.map((r: any) => r.tag_id) });

    const allOk = checks.filter((c: any) => c.ok !== undefined).every((c: any) => c.ok);

    res.json({
      user_id: userId,
      all_ok: allOk,
      checks,
      verdict: allOk ? 'DELETION VERIFIED: No orphaned records found' : 'ORPHANED RECORDS DETECTED',
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
// Auth: x-trigger-secret (cron) OR admin JWT (dashboard)
// ═══════════════════════════════════════════════════════════════════════════
app.post('/cleanup-failed-articles', async (req, res) => {
  const secret = req.headers['x-trigger-secret'];
  let isAdmin = false;

  if (secret !== process.env.CRON_SECRET_KEY) {
    // Fallback to admin JWT auth
    const token = req.headers.authorization?.replace('Bearer ', '') || req.cookies?.token;
    if (token) {
      try {
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
        const decoded = jwt.verify(token, JWT_SECRET);
        isAdmin = !!decoded.is_admin;
      } catch {
        isAdmin = false;
      }
    }
    if (!isAdmin) {
      return res.status(403).json({ error: 'Forbidden' });
    }
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
// ADMIN: Count news by filters
// Body: { matched_tags?: string[], source_id?: string, lang_original?: string,
//         date_from?: string, date_to?: string, title_contains?: string }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/admin/news-count', async (req, res) => {
  const secret = req.headers['x-trigger-secret'];
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { matched_tags, source_id, lang_original, date_from, date_to, title_contains } = req.body;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let p = 1;

    if (matched_tags && matched_tags.length > 0) {
      conditions.push(`matched_tags && $${p++}::text[]`);
      params.push(matched_tags);
    }
    if (source_id) {
      conditions.push(`source_id = $${p++}`);
      params.push(source_id);
    }
    if (lang_original) {
      conditions.push(`lang_original = $${p++}`);
      params.push(lang_original);
    }
    if (date_from) {
      conditions.push(`published_at >= $${p++}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`published_at <= $${p++}`);
      params.push(date_to);
    }
    if (title_contains) {
      conditions.push(`(title_original ILIKE $${p++} OR title_ru ILIKE $${p++})`);
      params.push(`%${title_contains}%`, `%${title_contains}%`);
    }

    const sql = `SELECT COUNT(*) as count FROM news WHERE ${conditions.join(' AND ')}`;
    const result = await query(sql, params);
    const count = parseInt(result.rows[0]?.count || '0');

    res.json({ count, filters: { matched_tags, source_id, lang_original, date_from, date_to, title_contains } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Delete news by filters
// Body: { matched_tags?: string[], source_id?: string, lang_original?: string,
//         date_from?: string, date_to?: string, title_contains?: string,
//         dry_run?: boolean }
// ═══════════════════════════════════════════════════════════════════════════
app.post('/admin/news-delete', async (req, res) => {
  const secret = req.headers['x-trigger-secret'];
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { matched_tags, source_id, lang_original, date_from, date_to, title_contains, dry_run } = req.body;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let p = 1;

    if (matched_tags && matched_tags.length > 0) {
      conditions.push(`matched_tags && $${p++}::text[]`);
      params.push(matched_tags);
    }
    if (source_id) {
      conditions.push(`source_id = $${p++}`);
      params.push(source_id);
    }
    if (lang_original) {
      conditions.push(`lang_original = $${p++}`);
      params.push(lang_original);
    }
    if (date_from) {
      conditions.push(`published_at >= $${p++}`);
      params.push(date_from);
    }
    if (date_to) {
      conditions.push(`published_at <= $${p++}`);
      params.push(date_to);
    }
    if (title_contains) {
      conditions.push(`(title_original ILIKE $${p++} OR title_ru ILIKE $${p++})`);
      params.push(`%${title_contains}%`, `%${title_contains}%`);
    }

    const countSql = `SELECT COUNT(*) as count FROM news WHERE ${conditions.join(' AND ')}`;
    const countResult = await query(countSql, params);
    const count = parseInt(countResult.rows[0]?.count || '0');

    if (dry_run) {
      return res.json({ dry_run: true, would_delete: count, filters: { matched_tags, source_id, lang_original, date_from, date_to, title_contains } });
    }

    if (count === 0) {
      return res.json({ deleted: 0, message: 'No matching articles found' });
    }

    const deleteSql = `DELETE FROM news WHERE ${conditions.join(' AND ')}`;
    await query(deleteSql, params);

    res.json({ deleted: count, filters: { matched_tags, source_id, lang_original, date_from, date_to, title_contains } });
    console.log(`[Admin] Deleted ${count} news articles`);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: List news with matched_tags (GET — для браузера)
// Query: ?source_id=finnhub&limit=50&secret=KEY
// ═══════════════════════════════════════════════════════════════════════════
app.get('/admin/news-list', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const source_id = req.query.source_id as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let p = 1;

    if (source_id) {
      conditions.push(`source_id = $${p++}`);
      params.push(source_id);
    }
    params.push(limit);

    const result = await query(`
      SELECT id, title_ru, title_original, source, source_id, url, published_at,
             matched_tags, sentiment, sentiment_source, lang_original, created_at
      FROM news
      WHERE ${conditions.join(' AND ')}
      ORDER BY published_at DESC
      LIMIT $${p}
    `, params);

    res.json({
      count: result.rows.length,
      articles: result.rows.map(r => ({
        id: r.id,
        title: r.title_ru || r.title_original || '(no title)',
        source: r.source,
        source_id: r.source_id,
        url: r.url,
        published_at: r.published_at,
        matched_tags: r.matched_tags || [],
        sentiment: r.sentiment,
        sentiment_source: r.sentiment_source,
        lang: r.lang_original
      }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Send weekly report to specific user
// Query: ?user_id=123&secret=KEY
// ═══════════════════════════════════════════════════════════════════════════
app.get('/admin/weekly-report', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  let userId = req.query.user_id as string;
  const chatId = req.query.chat_id as string;

  // Если chat_id передан — найти user_id по Telegram chat_id
  if (chatId && !userId) {
    const result = await query(
      `SELECT user_id FROM user_channels WHERE target = $1 AND channel_type = 'telegram' AND is_active = TRUE`,
      [chatId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No user found for this chat_id' });
    }
    userId = result.rows[0].user_id;
  }

  if (!userId) {
    return res.status(400).json({ error: 'Missing user_id or chat_id parameter' });
  }

  try {
    console.log(`[Admin] Sending weekly report to user ${userId}`);
    const result = await sendWeeklyReportForUser(userId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN: Count news by filters (GET — для браузера)
// Query: ?matched_tags=nvda,crispr&source_id=finnhub&lang_original=en&secret=KEY
// ═══════════════════════════════════════════════════════════════════════════
app.get('/admin/news-count-query', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const matched_tags = req.query.matched_tags ? String(req.query.matched_tags).split(',') : null;
    const source_id = req.query.source_id ? String(req.query.source_id) : null;
    const lang_original = req.query.lang_original ? String(req.query.lang_original) : null;

    const conditions: string[] = ['1=1'];
    const params: any[] = [];
    let p = 1;

    if (matched_tags && matched_tags.length > 0) {
      conditions.push(`matched_tags && $${p++}::text[]`);
      params.push(matched_tags);
    }
    if (source_id) {
      conditions.push(`source_id = $${p++}`);
      params.push(source_id);
    }
    if (lang_original) {
      conditions.push(`lang_original = $${p++}`);
      params.push(lang_original);
    }

    const sql = `SELECT COUNT(*) as count FROM news WHERE ${conditions.join(' AND ')}`;
    const result = await query(sql, params);
    const count = parseInt(result.rows[0]?.count || '0');

    res.json({ count, filters: { matched_tags, source_id, lang_original } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TZ_DELETE_ACCOUNT: Check FK constraint on user_defined_tags.created_by
// GET /debug/check-fk?secret=KEY
// ═══════════════════════════════════════════════════════════════════════════
app.get('/debug/check-fk', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const result = await query(`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS foreign_table,
        ccu.column_name AS foreign_column,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = 'user_defined_tags'
        AND kcu.column_name = 'created_by'
    `);

    if (result.rows.length === 0) {
      res.json({ fk_exists: false, delete_rule: null, message: 'No FK constraint found on created_by' });
    } else {
      const fk = result.rows[0];
      res.json({
        fk_exists: true,
        constraint_name: fk.constraint_name,
        column: fk.column_name,
        references: `${fk.foreign_table}.${fk.foreign_column}`,
        delete_rule: fk.delete_rule,  // CASCADE | SET NULL | NO ACTION | RESTRICT
        update_rule: fk.update_rule,
        is_set_null: fk.delete_rule === 'SET NULL',
        message: fk.delete_rule === 'SET NULL' ? 'OK: ON DELETE SET NULL' : `WARNING: ON DELETE ${fk.delete_rule}`,
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TZ_DELETE_ACCOUNT: Apply SET NULL migration on demand
// POST /migrate-set-null?secret=KEY
// ═══════════════════════════════════════════════════════════════════════════
app.post('/migrate-set-null', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    // Check current FK
    const checkResult = await query(`
      SELECT rc.delete_rule, tc.constraint_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
      WHERE tc.table_name = 'user_defined_tags'
        AND tc.constraint_type = 'FOREIGN KEY'
    `);

    if (checkResult.rows.length === 0) {
      return res.json({ applied: false, message: 'No FK found. Creating new one with SET NULL...' });
    }

    const currentRule = checkResult.rows[0].delete_rule;
    const constraintName = checkResult.rows[0].constraint_name;

    if (currentRule === 'SET NULL') {
      return res.json({ applied: false, already_ok: true, delete_rule: currentRule, message: 'Already ON DELETE SET NULL' });
    }

    // Drop old FK and create new one with SET NULL
    await query(`ALTER TABLE user_defined_tags DROP CONSTRAINT ${constraintName}`);
    await query(`
      ALTER TABLE user_defined_tags
      ADD CONSTRAINT user_defined_tags_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id)
      ON DELETE SET NULL
    `);

    res.json({ applied: true, old_rule: currentRule, new_rule: 'SET NULL', message: 'FK updated to ON DELETE SET NULL' });
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
// Migration: Add missing columns to payments table
// method, provider_ref, base_amount, discount
// ═══════════════════════════════════════════════════════════════════════════
app.post('/migrate-payments', async (req, res) => {
  try {
    const results: string[] = [];

    // Check current columns
    const colsResult = await query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'payments'
      ORDER BY ordinal_position
    `);
    const existingCols = colsResult.rows.map((r: any) => r.column_name);
    results.push(`Existing columns: ${existingCols.join(', ')}`);

    // Add method column if missing
    if (!existingCols.includes('method')) {
      await query(`ALTER TABLE payments ADD COLUMN method VARCHAR(50) DEFAULT 'bank_card'`);
      // After adding with DEFAULT, make it NOT NULL for new rows
      await query(`ALTER TABLE payments ALTER COLUMN method SET NOT NULL`);
      results.push('Added method column (VARCHAR(50) NOT NULL DEFAULT bank_card)');
    } else {
      results.push('method column already exists');
    }

    // Add provider_ref column if missing (was yookassa_payment_id)
    if (!existingCols.includes('provider_ref')) {
      await query(`ALTER TABLE payments ADD COLUMN provider_ref VARCHAR(255)`);
      results.push('Added provider_ref column (VARCHAR(255))');
    } else {
      results.push('provider_ref column already exists');
    }

    // Add base_amount column if missing
    if (!existingCols.includes('base_amount')) {
      await query(`ALTER TABLE payments ADD COLUMN base_amount DECIMAL(10,2) NOT NULL DEFAULT 490.00`);
      results.push('Added base_amount column (DECIMAL(10,2) DEFAULT 490.00)');
    } else {
      results.push('base_amount column already exists');
    }

    // Add discount column if missing
    if (!existingCols.includes('discount')) {
      await query(`ALTER TABLE payments ADD COLUMN discount INTEGER DEFAULT 0`);
      results.push('Added discount column (INTEGER DEFAULT 0)');
    } else {
      results.push('discount column already exists');
    }

    // Drop old yookassa_payment_id column if exists (migration cleanup)
    if (existingCols.includes('yookassa_payment_id')) {
      await query(`ALTER TABLE payments DROP COLUMN yookassa_payment_id`);
      results.push('Dropped old yookassa_payment_id column');
    }

    // Drop old payment_method column if exists (migration cleanup)
    if (existingCols.includes('payment_method')) {
      await query(`ALTER TABLE payments DROP COLUMN payment_method`);
      results.push('Dropped old payment_method column');
    }

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
        keyword_fallback: parseInt(todayArticles.rows[0]?.keyword_fallback || '0'),
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
        u.subscription_plan,
        u.subscription_expires_at,
        u.subscription_auto_renew,
        u.registration_source,
        u.login_count,
        u.news_count,
        u.created_at,
        u.last_login_at,
        COALESCE(p.total_payments, 0) as total_payments,
        COALESCE(p.total_amount, 0) as total_amount,
        (SELECT COUNT(*) FROM portfolios WHERE user_id = u.id) as tag_count,
        (SELECT COUNT(*) FROM user_channels WHERE user_id = u.id AND is_active = ${USE_SQLITE ? 1 : 'TRUE'}) as active_channels,
        (SELECT COUNT(*) FROM user_news_reads WHERE user_id = u.id) as articles_read
      FROM users u
      LEFT JOIN (
        SELECT user_id, COUNT(*) as total_payments, SUM(amount) as total_amount
        FROM payments
        WHERE status = 'completed'
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
        subscription_plan: row.subscription_plan || 'free',
        subscription_expires_at: row.subscription_expires_at,
        subscription_auto_renew: row.subscription_auto_renew === true || row.subscription_auto_renew === 1,
        registration_source: row.registration_source || null,
        login_count: parseInt(row.login_count) || 0,
        news_count: parseInt(row.news_count) || 0,
        created_at: row.created_at,
        last_login_at: row.last_login_at,
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

// GET /admin/events — лента событий пользователей (Activities List)
app.get('/admin/events', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const eventType = req.query.type as string;
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 720);

    if (eventType && !isUserEventType(eventType)) {
      return res.status(400).json({ error: 'Invalid event type' });
    }

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

    res.json({
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
    });
  } catch (err: any) {
    console.error('[Admin] Failed to fetch events:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/events/stats — статистика событий для дашборда
app.get('/admin/events/stats', requireAdmin, async (req, res) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours as string) || 24, 1), 720);
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

    res.json({
      hours,
      by_type: byTypeResult.rows.map((row: any) => ({
        event_type: row.event_type,
        count: parseInt(row.count) || 0,
      })),
      hourly: hourlyResult.rows.map((row: any) => ({
        hour: row.hour,
        count: parseInt(row.count) || 0,
      })),
    });
  } catch (err: any) {
    console.error('[Admin] Failed to fetch event stats:', err);
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
             subscription_active, subscription_plan, subscription_expires_at, subscription_auto_renew,
             registration_source, login_count, news_count, created_at, last_login_at
      FROM users
      WHERE id = $1
    `, [userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const u = userResult.rows[0];

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

    // Login history (last 30 days) from user_logins
    const loginHistoryResult = await query(
      USE_SQLITE
        ? `SELECT date(login_at) as day, COUNT(*) as count
           FROM user_logins
           WHERE user_id = ? AND login_at > datetime('now', '-30 days')
           GROUP BY date(login_at)
           ORDER BY day ASC`
        : `SELECT date_trunc('day', login_at) as day, COUNT(*) as count
           FROM user_logins
           WHERE user_id = $1 AND login_at > NOW() - INTERVAL '30 days'
           GROUP BY date_trunc('day', login_at)
           ORDER BY day ASC`,
      [userId]
    );

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
        subscription_plan: u.subscription_plan || 'free',
        subscription_expires_at: u.subscription_expires_at,
        subscription_auto_renew: u.subscription_auto_renew === true || u.subscription_auto_renew === 1,
        registration_source: u.registration_source || null,
        login_count: parseInt(u.login_count) || 0,
        news_count: parseInt(u.news_count) || 0,
        created_at: u.created_at,
        last_login_at: u.last_login_at || null,
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
        .filter((p: any) => p.status === 'completed')
        .reduce((sum: number, p: any) => sum + parseFloat(p.amount), 0),
      tags: tagsResult.rows,
      channels: channelsResult.rows,
      login_history: loginHistoryResult.rows.map((r: any) => ({
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

// POST /admin/users/:id/auto-renew — включить/выключить автопродление пользователя
app.post('/admin/users/:id/auto-renew', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const { enabled } = req.body;
    const enable = enabled === true;

    const userResult = await query(`
      SELECT subscription_plan, subscription_expires_at, subscription_auto_renew
      FROM users
      WHERE id = $1
    `, [userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const currentAutoRenew = USE_SQLITE
      ? (user.subscription_auto_renew === 1 || user.subscription_auto_renew === true)
      : (user.subscription_auto_renew === true);

    if (currentAutoRenew === enable) {
      return res.status(409).json({
        error: `Auto-renew is already ${enable ? 'enabled' : 'disabled'}`
      });
    }

    if (enable) {
      const plan = await getPlanById(user.subscription_plan || 'free');
      if (!plan || !plan.is_active || plan.deleted_at) {
        return res.status(400).json({ error: 'Current plan is not available for renewal' });
      }

      const pmResult = await query(`
        SELECT id FROM user_payment_methods
        WHERE user_id = $1 AND is_active = ${USE_SQLITE ? 1 : 'TRUE'}
        LIMIT 1
      `, [userId]);

      if (pmResult.rows.length === 0) {
        return res.status(400).json({ error: 'No saved payment method' });
      }
    }

    await query(`
      UPDATE users SET subscription_auto_renew = $1 WHERE id = $2
    `, [enable, userId]);

    res.json({
      success: true,
      enabled: enable,
      subscription: {
        plan: user.subscription_plan || 'free',
        expires_at: user.subscription_expires_at,
        auto_renew: enable,
      },
    });
  } catch (err: any) {
    console.error('[Admin] Auto-renew toggle error:', err);
    res.status(500).json({ error: err.message });
  }
});
// GET /admin/users/:id/delete-preview
// 
// Что делает: показывает админу ЧТО будет удалено/изменено перед удалением.
// Зачем: админ должен понимать последствия — какие теги потеряют владельца,
//        какие останутся (shared), есть ли активная подписка.
// 
// Структура ответа (4 секции):
//   1. user — имя, email, admin-статус, подписка
//   2. owned_tags — теги где user = created_by (жёлтые → SET NULL)
//   3. shared_portfolio_tags — чужие теги в портфеле (зелёные → остаются)
//   4. summary — has_owned_tags, has_shared_tags, has_auto_renew
// ═══════════════════════════════════════════════════════════════════════════
app.get('/admin/users/:id/delete-preview', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;

    // ── User ──
    const userResult = await query(`
      SELECT u.id, u.email, u.username, u.is_admin,
             u.subscription_expires_at,
             p.payment_method,
             EXISTS (
               SELECT 1 FROM payments p2
               WHERE p2.user_id = u.id
                 AND p2.status = 'active'
             ) AS has_auto_renew
      FROM users u
      LEFT JOIN (
        SELECT DISTINCT ON (user_id) user_id, method AS payment_method
        FROM payments WHERE status = 'active'
        ORDER BY user_id, created_at DESC
      ) p ON p.user_id = u.id
      WHERE u.id = $1
    `, [userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // ── Owned tags ──
    const ownedTagsResult = await query(`
      SELECT tag_id, tag_name
      FROM user_defined_tags
      WHERE created_by = $1
    `, [userId]);

    // ── Shared portfolio tags ──
    const sharedTagsResult = await query(`
      SELECT DISTINCT t.tag_id, t.tag_name
      FROM portfolios p
      JOIN user_defined_tags t ON t.tag_id = p.tag_id
      WHERE p.user_id = $1
        AND t.created_by IS DISTINCT FROM $1
    `, [userId]);

    // ── Summary ──
    const summary = {
      has_owned_tags: ownedTagsResult.rows.length > 0,
      has_shared_tags: sharedTagsResult.rows.length > 0,
      total_tags: ownedTagsResult.rows.length + sharedTagsResult.rows.length,
      has_auto_renew: user.has_auto_renew,
      subscription_expires_at: user.subscription_expires_at,
    };

    // ── Response ──
    const preview: any = {
      user: {
        id: user.id,
        email: user.email,
        name: user.username,
        is_admin: user.is_admin === true || user.is_admin === 1,
        subscription_expires_at: user.subscription_expires_at,
        payment_method: user.payment_method,  // method AS payment_method из подзапроса
        has_auto_renew: user.has_auto_renew,
      },
      owned_tags: ownedTagsResult.rows,
      shared_portfolio_tags: sharedTagsResult.rows,
      summary,
    };

    res.json(preview);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TZ_DELETE_ACCOUNT v1.0 — DELETE USER
// DELETE /admin/users/:id
//
// Что делает: безопасное каскадное удаление пользователя с 7 слоями защиты.
//
// Цепочка защиты (все 7 обязательны):
//   1. Self-delete guard — admin не может удалить себя (400)
//   2. Advisory lock — pg_advisory_xact_lock предотвращает race condition
//   3. TOCTOU double-check — "а вдруг пользователь уже удалён?" (404)
//   4. YooKassa cancel — отмена auto-renew ПЕРЕД удалением
//   5. Transaction — BEGIN → 7 DELETE → COMMIT (ROLLBACK при ошибке)
//   6. Cascading delete — payments, portfolios, sessions, channels,
//                          notification_settings, news_reads, users
//   7. Audit log — запись в cron_log для расследований
//
// Созданные теги: created_by → SET NULL (теги остаются, но без владельца)
// Чужие теги в портфеле: затронуты через CASCADE в portfolios
//
// Возвращает: { success: true } или { error: string }
// ═══════════════════════════════════════════════════════════════════════════
app.delete('/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const userId = req.params.id;
    const adminUser = (req as any).user;

    // ── 1. Self-delete guard ──
    if (adminUser.userId === userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    // ── 2. Advisory lock (prevent concurrent deletes) ──
    await query(`SELECT pg_advisory_xact_lock(hashtext('delete_user_' || $1::text))`, [userId]);

    // ── 3. TOCTOU double-check (user still exists) ──
    const checkResult = await query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // ── 4. Collect info for side effects ──
    // Колонки: method (не payment_method), provider_ref (не yookassa_payment_id)
    const paymentResult = await query(`
      SELECT method, provider_ref, status
      FROM payments
      WHERE user_id = $1 AND status = 'active'
    `, [userId]);
    const activePayments = paymentResult.rows;

    // ── 5. Side effects: cancel YooKassa auto-renew ──
    for (const payment of activePayments) {
      if (payment.method === 'yookassa' && payment.provider_ref) {
        try {
          await cancelYookassaAutoRenew(payment.provider_ref);
        } catch (e: any) {
          console.warn(`[DeleteAccount] Failed to cancel auto-renew for ${userId}:`, e.message);
        }
      }
    }

    // ── 6. Cascading delete ──
    await query(`BEGIN`);

    await query(`DELETE FROM payments WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM portfolios WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM user_channels WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM notification_settings WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM user_news_reads WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM users WHERE id = $1`, [userId]);

    await query(`COMMIT`);

    // ── 7. Audit log ──
    // Колонки cron_log: task_name (VARCHAR), status (VARCHAR), errors (TEXT)
    await query(`
      INSERT INTO cron_log (task_name, status, errors)
      VALUES ('delete_account', 'completed', $1)
    `, [`Deleted user ${userId} by admin ${adminUser.userId}`]);

    res.json({ success: true });
  } catch (err: any) {
    await query(`ROLLBACK`).catch(() => {});
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
        t.is_verified,
        t.created_at,
        ${USE_SQLITE ? "JSON_EXTRACT(t.enriched_data, '$._backfill')" : "t.enriched_data->'_backfill'"} as backfill,
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
      GROUP BY t.tag_id, t.tag_name, t.tag_type, t.keywords, t.is_verified, t.created_at, t.enriched_data
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

    res.json({ hours, total: tags.length, tags });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/tags/search — поиск тегов по enriched-полям (substring, ILIKE)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/tags/search', async (req, res) => {
  try {
    const q = (req.query.q as string)?.trim();

    if (!q || q.length < 3) {
      return res.status(400).json({ error: 'Search query must be at least 3 characters' });
    }
    if (q.length > 50) {
      return res.status(400).json({ error: 'Search query must not exceed 50 characters' });
    }

    const result = await query(
      `SELECT
        tag_id,
        tag_name,
        tag_type,
        enriched_data->>'ticker' as ticker
      FROM user_defined_tags
      WHERE
        tag_name ILIKE '%' || $1 || '%'
        OR enriched_data->>'ticker' ILIKE '%' || $1 || '%'
        OR enriched_data->>'exchange' ILIKE '%' || $1 || '%'
        OR enriched_data->>'trend' ILIKE '%' || $1 || '%'
        OR enriched_data->>'sector' ILIKE '%' || $1 || '%'
        OR enriched_data->>'isin' ILIKE '%' || $1 || '%'
        OR EXISTS (
          SELECT 1 FROM unnest(keywords) k
          WHERE k ILIKE '%' || $1 || '%'
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            COALESCE(enriched_data->'synonyms_en', '[]'::jsonb)
          ) s WHERE s ILIKE '%' || $1 || '%'
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            COALESCE(enriched_data->'synonyms_ru', '[]'::jsonb)
          ) s WHERE s ILIKE '%' || $1 || '%'
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            COALESCE(enriched_data->'key_products', '[]'::jsonb)
          ) s WHERE s ILIKE '%' || $1 || '%'
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            COALESCE(enriched_data->'related_entities', '[]'::jsonb)
          ) s WHERE s ILIKE '%' || $1 || '%'
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            COALESCE(enriched_data->'sectors', '[]'::jsonb)
          ) s WHERE s ILIKE '%' || $1 || '%'
        )
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(
            COALESCE(enriched_data->'trends', '[]'::jsonb)
          ) s WHERE s ILIKE '%' || $1 || '%'
        )
      LIMIT 10`,
      [q]
    );

    res.json({
      tags: result.rows,
      total: result.rows.length,
    });
  } catch (err: any) {
    console.error('[Tags] Search error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /admin/tags/:tagId — детали тега
app.get('/admin/tags/:tagId', requireAdmin, async (req, res) => {
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
    let trend = null;
    let sector = null;
    let sectors: string[] = [];
    let trends: string[] = [];
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
      trend       = ed.trend         || null;
      sector      = ed.sector        || null;
      sectors     = ed.sectors       || (ed.sector ? [ed.sector] : []);
      trends      = ed.trends        || (ed.trend ? [ed.trend] : []);
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
        is_verified: tag.is_verified === true || tag.is_verified === 1,
        related_tags: relatedTags,
        ticker,
        website,
        websites,
        wikipedia_url: wikipediaUrl,
        country,
        isin,
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
  tag_type: { type: 'enum', values: ['company', 'ticker', 'sector', 'trend', 'country', 'commodity', 'index', 'person', 'currency'] },
  ticker: { type: 'string', min: 1, max: 20, pattern: /^[A-Z0-9\.\-]+$/, optional: true },
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
  trend:    { type: 'string', max: 100, optional: true },
  sector:   { type: 'string', max: 100, optional: true },
  trends:   { type: 'array', maxItems: 10, items: { type: 'string', max: 100 }, optional: true },
  sectors:  { type: 'array', maxItems: 10, items: { type: 'string', max: 100 }, optional: true },
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

app.put('/admin/tags/:tagId', requireAdmin, async (req, res) => {
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
    const jsonbFields = ['ticker', 'website', 'description_ru', 'key_products', 'related_tags', 'synonyms_ru', 'synonyms_en', 'exchange', 'trend', 'sector', 'websites', 'wikipedia_url', 'country', 'isin', 'sectors', 'trends'];
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
      const { rebuildKeywordsFromEnrichment } = await import('./services/tagManager');
      newKeywords = await rebuildKeywordsFromEnrichment(tagId);
      updated.keywords = newKeywords;
    } else {
      newKeywords = [...updates.keywords].sort();
    }

    // If keywords changed, retro-scan existing articles for the updated tag
    if (JSON.stringify(oldKeywords) !== JSON.stringify(newKeywords)) {
      const { backfillTagMatches } = await import('./services/tagBackfill');
      backfillTagMatches(tagId, { dryRun: false }).catch((err: any) => {
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
    };

    // Any successful tag update may affect matching keywords.
    // Invalidate cache and wake up no-tags articles for re-check.
    const { wakeUpNoTagsArticles } = await import('./services/tagManager');
    const { invalidateUserTagsCache } = await import('./services/smartTagMatcher');
    invalidateUserTagsCache();
    wakeUpNoTagsArticles().catch((err: any) => {
      console.error('[AdminTags] wakeUpNoTagsArticles error:', err.message);
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
app.post('/admin/tags/:tagId/enrich', requireAdmin, async (req, res) => {
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

    const { enrichTagViaLLM, generateTagKeywords, buildEnrichedKeywords, wakeUpNoTagsArticles, TAG_TYPES } = await import('./services/tagManager');
    const { invalidateUserTagsCache } = await import('./services/smartTagMatcher');

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
    wakeUpNoTagsArticles().catch((err: any) => {
      console.error('[AdminEnrich] wakeUpNoTagsArticles error:', err.message);
    });

    // Ретро-скан существующих новостей по обновлённым keywords
    const { backfillTagMatches } = await import('./services/tagBackfill');
    backfillTagMatches(tagId, { dryRun: false }).catch((err: any) => {
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
app.post('/admin/tags/:tagId/backfill-matches', requireAdmin, async (req, res) => {
  const tagId = req.params.tagId.toLowerCase();
  const dryRun = req.body?.dryRun !== false; // default dry-run for safety (защита на экзотические конфигурации)
  console.log(`[AdminBackfillMatches] tag=${tagId} dryRun=${dryRun}`);

  try {
    const { backfillTagMatches, countTagMatches, fetchTag } = await import('./services/tagBackfill');
    const tag = await fetchTag(tagId);
    if (!tag) {
      return res.status(404).json({ error: 'Tag not found', tag_id: tagId });
    }
    if (dryRun) {
      const { matched, tokens } = await countTagMatches(tagId);
      if (tokens === 0) {
        return res.status(400).json({ error: 'No keywords to scan', tag_id: tagId, matched: 0, tokens: 0 });
      }
      if (tokens > 500) {
        return res.status(400).json({ error: 'Too many keywords/tokens', tag_id: tagId, matched, tokens });
      }
      return res.json({ success: true, dryRun: true, tag_id: tagId, matched, tokens });
    }
    const result = await backfillTagMatches(tagId, { dryRun: false });
    if (result.error) {
      return res.json({ success: false, ...result });
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
app.post('/admin/backfill-matches-all', requireAdmin, async (req, res) => {
  try {
    const { backfillAllTags } = await import('./services/tagBackfill');
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
app.delete('/admin/tags/:tagId', requireAdmin, async (req, res) => {
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
app.get('/admin/tags/:tagId/delete-preview', requireAdmin, async (req, res) => {
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
app.get('/admin/news-sources', requireAdmin, async (req, res) => {
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
app.put('/admin/news-sources/:id/toggle', requireAdmin, async (req, res) => {
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
app.get('/admin/tg-alerts/settings', requireAdmin, async (req: any, res) => {
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
app.put('/admin/tg-alerts/settings', requireAdmin, async (req: any, res) => {
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
app.post('/admin/tg-alerts/test', requireAdmin, async (req: any, res) => {
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

    // news_tag_links: таблица + индексы теперь в schema.sql (§5d)
    // Оставляем только enrichment_version — это отдельная миграция
    await query(`ALTER TABLE news ADD COLUMN IF NOT EXISTS enrichment_version INTEGER DEFAULT 1`);
    results.push('Added column: news.enrichment_version');

    await query(`CREATE INDEX IF NOT EXISTS idx_news_enrichment_version ON news(enrichment_version)`);
    results.push('Created index: idx_news_enrichment_version');

    // news_sources: таблица + источники
    await query(`CREATE TABLE IF NOT EXISTS news_sources (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) NOT NULL UNIQUE,
      display_name VARCHAR(100) NOT NULL,
      type VARCHAR(20) NOT NULL,
      config JSONB DEFAULT '{}',
      enabled BOOLEAN DEFAULT true,
      last_fetch_at TIMESTAMP,
      last_error TEXT,
      last_error_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    results.push('Created table: news_sources');

    // Migration: add last_error columns if table exists without them
    try {
      await query(`ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS last_error TEXT`);
      await query(`ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMP`);
    } catch (e: any) {
      // ignore
    }

    // Migrate RSS sources
    const { RSS_SOURCES } = await import('./services/rssSources');
    for (const s of RSS_SOURCES) {
      await query(`INSERT INTO news_sources (name, display_name, type, config, enabled)
        VALUES ($1, $2, 'rss', $3, true)
        ON CONFLICT (name) DO NOTHING`,
        [s.id, s.name, JSON.stringify({ url: s.url, lang: s.lang, category: s.category })]
      );
    }
    results.push(`Migrated ${RSS_SOURCES.length} RSS sources`);

    // Add Finnhub API source (API key через env FINNHUB_API_KEY)
    await query(`INSERT INTO news_sources (name, display_name, type, config, enabled)
      VALUES ('finnhub', 'Finnhub News', 'api_search', $1, true)
      ON CONFLICT (name) DO UPDATE SET config = $1`,
      [JSON.stringify({
        base_url: 'https://finnhub.io/api/v1',
        endpoint: '/company-news',
        rate_limit_rpm: 60,
        rate_limit_rpd: 300,
        schedule_minutes: 60
      })]
    );
    results.push('Added source: finnhub');

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

import { getNewsSourceManager } from './services/newsSourceManager';

// ═══════════════════════════════════════════════════════════════════════════
// SSE — Real-time news stream (Server-Sent Events)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/news/stream', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // CORS for EventSource
  addSubscriber(res);
});

// ═══════════════════════════════════════════════════════════════════════════
// SSE — Sentiment Index stream
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/sentiment/stream', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  addSentimentSubscriber(res);
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
        allowed_updates: whResp.data.result?.allowed_updates,
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

    // Is cron alive? (last run within 90 minutes for hourly digest schedule)
    const lastRun = await query(
      `SELECT started_at FROM cron_log ORDER BY started_at DESC LIMIT 1`
    );
    const isAlive = lastRun.rows.length > 0 &&
      (new Date().getTime() - new Date(lastRun.rows[0].started_at).getTime()) < 90 * 60 * 1000;

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

// GET /debug/finnhub-errors — последние ошибки Finnhub
app.get('/debug/finnhub-errors', async (req, res) => {
  try {
    const result = await query(`SELECT last_error, last_error_at FROM news_sources WHERE name = 'finnhub'`);
    res.json(result.rows[0] || { last_error: null, last_error_at: null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /debug/finnhub-tickers — сколько тикеров в портфелях (USA)
app.get('/debug/finnhub-tickers', async (req, res) => {
  try {
    const tagResult = await query(`
      SELECT DISTINCT
        t.tag_id,
        t.tag_name,
        t.enriched_data->>'ticker' as ticker,
        COUNT(p.user_id) as subscriber_count
      FROM user_defined_tags t
      JOIN portfolios p ON p.tag_id = t.tag_id
      WHERE t.enriched_data->>'ticker' IS NOT NULL
        AND LENGTH(t.enriched_data->>'ticker') > 0
        AND t.enriched_data->>'exchange' = 'USA'
      GROUP BY t.tag_id, t.tag_name, t.enriched_data->>'ticker'
      ORDER BY subscriber_count DESC
    `);
    res.json({
      total: tagResult.rows.length,
      top_12: tagResult.rows.slice(0, 12).map((r: any) => ({ tag_id: r.tag_id, tag_name: r.tag_name, ticker: r.ticker, subscribers: parseInt(r.subscriber_count) })),
      rare: tagResult.rows.slice(12).map((r: any) => ({ tag_id: r.tag_id, tag_name: r.tag_name, ticker: r.ticker, subscribers: parseInt(r.subscriber_count) })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
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
  console.log('[Trigger] Manual RSS fetch started via NSM');
  nsm.run().catch((err: any) => console.error('[Trigger] NSM error:', err.message));
  res.json({ status: 'started', source: 'nsm', message: 'NSM is running in background. Check logs.' });
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER: NewsSourceManager (RSS + API adapters)
// ═══════════════════════════════════════════════════════════════════════════
// МОЖНО вызывать сразу — NSM lazy singleton, run() — async
const nsm = getNewsSourceManager();
app.get('/trigger/nsm', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  nsm.run().catch((e: any) => console.error('[NSM] trigger error:', e.message));
  res.json({ started: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER: News Processor (Layer 1 + Layer 2)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/trigger/process', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  import('./services/newsProcessor').then(({ processRawArticles }) => {
    processRawArticles().catch(e => console.error('[Process] trigger error:', e.message));
  });
  res.json({ started: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER: Run subscription auto-renewals manually (production: cron at 09:00 UTC)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/trigger/auto-renew', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const result = await processAutoRenewals();
    res.json({ started: true, result });
  } catch (err: any) {
    console.error('[AutoRenew] trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER: Wake up no-tags articles and re-run processor
// ═══════════════════════════════════════════════════════════════════════════
app.get('/trigger/wake-no-tags', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { wakeUpNoTagsArticles } = await import('./services/tagManager');
    const { processRawArticles } = await import('./services/newsProcessor');
    const woken = await wakeUpNoTagsArticles();
    // Run processor in background to pick up woken articles
    processRawArticles().catch(e => console.error('[WakeNoTags] processor error:', e.message));
    res.json({ started: true, woken });
  } catch (err: any) {
    console.error('[WakeNoTags] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER: Recalculate keywords for all tags from enriched_data
// ═══════════════════════════════════════════════════════════════════════════
app.get('/trigger/recalculate-keywords', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { buildEnrichedKeywords } = await import('./services/tagManager');
    const result = await query(
      `SELECT tag_id, tag_name, enriched_data FROM user_defined_tags`,
      []
    );
    let updated = 0;
    for (const row of result.rows) {
      let enrichment = row.enriched_data;
      if (typeof enrichment === 'string') {
        try { enrichment = JSON.parse(enrichment); } catch { enrichment = null; }
      }
      const keywords = buildEnrichedKeywords(row.tag_id, enrichment);
      await query(
        `UPDATE user_defined_tags SET keywords = $1 WHERE tag_id = $2`,
        [keywords, row.tag_id]
      );
      updated++;
    }
    res.json({ started: true, updated });
  } catch (err: any) {
    console.error('[RecalculateKeywords] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGER: Reprocess articles that contain a specific matched tag
// ═══════════════════════════════════════════════════════════════════════════
app.get('/trigger/reprocess-tag/:tagId', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const tagId = req.params.tagId.toLowerCase();
    const { processRawArticles } = await import('./services/newsProcessor');
    const result = await query(
      `UPDATE news
       SET needs_translation = TRUE,
           sentiment_source = NULL,
           matched_tags = '{}',
           tag_impact = '[]'
       WHERE $1 = ANY(matched_tags)
       RETURNING id`,
      [tagId]
    );
    const count = result.rows.length;
    processRawArticles().catch(e => console.error('[ReprocessTag] processor error:', e.message));
    res.json({ started: true, tagId, count });
  } catch (err: any) {
    console.error('[ReprocessTag] error:', err.message);
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

// TEMP: Full NSM process with await (for debugging)
app.get('/test-process', async (req, res) => {
  try {
    const start = Date.now();
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: any[]) => errors.push(args.map(a => String(a)).join(' '));
    await nsm.run();
    console.error = origError;
    const elapsed = Date.now() - start;
    const count = await query('SELECT COUNT(*) as c FROM news');
    res.json({ status: 'done', source: 'nsm', elapsed_ms: elapsed, news_count: parseInt(count.rows[0]?.c || '0'), errors: errors.slice(0, 20) });
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

// ═══════════════════════════════════════════════════════════════════════════
// OG / Deeplink render — HTML shell for Telegram/WhatsApp scrapers
// ═══════════════════════════════════════════════════════════════════════════

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.get('/n/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const result = await query(
      `SELECT id, title_ru, title_original, summary_ru, summary_original,
              source, published_at, sentiment, sentiment_score, url, slug
       FROM news WHERE slug = $1`,
      [slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).send('<html><body>Not found</body></html>');
    }

    const a = result.rows[0];
    const title = a.title_ru || a.title_original || 'PULSE News';
    const desc = (a.summary_ru || a.summary_original || '').substring(0, 300);
    const pubDate = a.published_at ? new Date(a.published_at).toISOString() : '';
    const modDate = pubDate;
    const frontendUrl = process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru';
    const canonical = `${frontendUrl}/news/${a.slug}`;
    const ogImage = `${frontendUrl}/og-default.png`;

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: title,
      description: desc,
      url: canonical,
      image: ogImage,
      datePublished: pubDate,
      dateModified: modDate,
      author: { '@type': 'Organization', name: a.source || 'PULSE' },
      publisher: {
        '@type': 'Organization',
        name: 'PULSE',
        logo: { '@type': 'ImageObject', url: `${frontendUrl}/logo.png` }
      },
      mainEntityOfPage: { '@type': 'WebPage', '@id': canonical }
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc)}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="PULSE">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:locale" content="ru_RU">
  <meta property="article:published_time" content="${pubDate}">
  <meta property="article:modified_time" content="${modDate}">
  <meta property="article:author" content="${escapeHtml(a.source || 'PULSE')}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="twitter:image" content="${ogImage}">
  <script type="application/ld+json">${jsonLd}</script>
  <style>body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px;color:#333;line-height:1.6}a{color:#2563eb;text-decoration:none}</style>
</head>
<body>
  <nav style="margin-bottom:24px">
    <a href="${frontendUrl}/">PULSE</a> / <a href="${frontendUrl}/feed">Новости</a>
  </nav>
  <article>
    <h1>${escapeHtml(title)}</h1>
    <p style="color:#666;font-size:14px">
      ${escapeHtml(a.source || '')} · ${pubDate ? new Date(pubDate).toLocaleDateString('ru-RU') : ''}
    </p>
    <p>${escapeHtml(desc)}</p>
    <p><a href="${canonical}">Открыть в PULSE →</a></p>
  </article>
  <footer style="margin-top:48px;padding-top:24px;border-top:1px solid #eee;color:#999;font-size:12px">
    <p>PULSE — инвестиционные новости в реальном времени</p>
    <p><a href="${frontendUrl}">pulse.inside-trade.ru</a></p>
  </footer>
</body>
</html>`);
  } catch (err: any) {
    console.error('[OG] Error:', err.message);
    res.status(500).send('Server error');
  }
});

// Sitemap — SEO discovery for news articles
app.get('/sitemap.xml', async (req, res) => {
  try {
    const frontendUrl = process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru';
    const dateFilter = USE_SQLITE
      ? "published_at > datetime('now', '-30 days')"
      : "published_at > NOW() - INTERVAL '30 days'";
    const result = await query(
      `SELECT slug, published_at FROM news
       WHERE ${dateFilter}
       AND slug IS NOT NULL
       ORDER BY published_at DESC
       LIMIT 5000`
    );

    const urls = result.rows.map((row: any) => {
      const lastmod = new Date(row.published_at).toISOString().split('T')[0];
      return `  <url>\n    <loc>${frontendUrl}/news/${row.slug}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>never</changefreq>\n    <priority>0.8</priority>\n  </url>`;
    }).join('\n');

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`;

    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(sitemap);
  } catch (err: any) {
    console.error('[Sitemap] Error:', err.message);
    res.status(500).send('Server error');
  }
});

// robots.txt — allow indexing news pages, disallow private/admin routes
app.get('/robots.txt', (req, res) => {
  const frontendUrl = process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(`User-agent: *
Allow: /news/
Allow: /n/
Disallow: /api/
Disallow: /admin/
Disallow: /debug/
Disallow: /feed
Disallow: /profile
Disallow: /payment/

Sitemap: ${frontendUrl}/sitemap.xml
`);
});

// API Routes — все эндпоинты начинаются с /api/
// ═══════════════════════════════════════════════════════════════════════════
// Лимитеры для восстановления пароля (сначала — специфичные, потом общий authLimiter)
app.use('/api/auth/forgot-password', forgotPasswordLimiter); // 3/час на email
app.use('/api/auth/verify-code', passwordResetFlowLimiter);
app.use('/api/auth/reset-password', passwordResetFlowLimiter);
app.use('/api/auth', authLimiter, authRoutes);  // Строгий лимит (15/15min) — защита от брутфорса
app.use('/api/news', newsRoutes);       // GET /api/news, /api/news/:tag (должен быть первым, т.к. содержит публичные маршруты)
app.use('/api/news', factCheckRoutes);  // POST/GET /api/news/:id/fact-check
app.use('/api/payment', paymentRoutes); // POST /api/payment/create, /confirm
app.use('/api/plans', plansRoutes);     // GET /api/plans
app.use('/api/promo/validate', promoValidateLimiter, promoRoutes); // GET /api/promo/validate
app.use('/api/features', featuresRoutes); // GET /api/features
app.use('/api/user', userRoutes);       // GET/POST/DELETE /api/user/tags
app.use('/api/translate', translateRoutes);
app.use('/api/webhook', webhookLimiter, webhookRoutes); // Высокий лимит для YuKassa
app.use('/api/admin', adminRoutes);     // GET /api/admin/users, /stats
app.use('/api/admin', adminMetricsRoutes); // GET /api/admin/metrics?section=...
app.use('/admin', adminMetricsRoutes);     // GET /admin/metrics?section=... (frontend adminApi root path)
app.use('/api/sentiment', sentimentRoutes); // Sentiment Index
app.use('/api/app', appRoutes);            // App version / update info

// ═══════════════════════════════════════════════════════════════════════════
// Page view events
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/events/page-view', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { page } = req.body;
    if (page === 'plans') {
      logPageViewPlans(req.user!.userId).catch(() => {});
    }
    res.json({ success: true });
  } catch (err: any) {
    console.error('[PageView] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

// ═══════════════════════════════════════════════════════════════════════════
// Telegram Login Widget — callback endpoint
// ═══════════════════════════════════════════════════════════════════════════
app.post('/api/auth/telegram', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    // ── 1. Check Premium ──
    const userResult = await query(
      `SELECT subscription_active FROM users WHERE id = $1`,
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    if (!userResult.rows[0].subscription_active) {
      return res.status(403).json({ error: 'Premium subscription required' });
    }

    // ── 2. Extract Telegram data ──
    const { id, hash, auth_date, first_name, username, last_name, photo_url } = req.body;
    if (!id || !hash || !auth_date) {
      return res.status(400).json({ error: 'Missing Telegram auth data' });
    }

    const chatId = id.toString();

    // ── 3. Verify hash (Telegram Login Widget signature) ──
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!botToken) {
      return res.status(500).json({ error: 'Telegram bot token not configured' });
    }

    const authFields: Record<string, string | number | undefined> = {
      id,
      first_name,
      last_name,
      username,
      photo_url,
      auth_date,
    };

    const dataCheckArr: string[] = [];
    const keys = Object.keys(authFields).sort();
    for (const key of keys) {
      const value = authFields[key];
      if (value !== undefined && value !== null && value !== '') {
        dataCheckArr.push(`${key}=${value}`);
      }
    }
    const dataCheckString = dataCheckArr.join('\n');

    // Login Widget / OAuth widget use SHA256(bot_token) as the HMAC key.
    // (WebAppData HMAC is only for Telegram Mini Apps.)
    const secretKey = crypto.createHash('sha256').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    try {
      const hashBuf = Buffer.from(hash, 'hex');
      const expectedBuf = Buffer.from(expectedHash, 'hex');
      if (!crypto.timingSafeEqual(hashBuf, expectedBuf)) {
        return res.status(403).json({ error: 'Invalid Telegram auth signature' });
      }
    } catch {
      return res.status(403).json({ error: 'Invalid hash format' });
    }

    // ── 4. Check auth_date freshness (max 24h) ──
    const authDateMs = parseInt(auth_date) * 1000;
    if (Date.now() - authDateMs > 24 * 60 * 60 * 1000) {
      return res.status(403).json({ error: 'Auth data expired' });
    }

    // ── 5. Save channel ──
    if (USE_SQLITE) {
      await query(
        `INSERT OR REPLACE INTO user_channels (id, user_id, channel, target, is_active)
         VALUES ($1, $2, 'telegram', $3, 1)`,
        [crypto.randomUUID(), userId, chatId]
      );
    } else {
      await query(
        `INSERT INTO user_channels (id, user_id, channel, target, is_active)
         VALUES ($1, $2, 'telegram', $3, TRUE)
         ON CONFLICT (user_id, channel) DO UPDATE SET target = $3, is_active = TRUE`,
        [crypto.randomUUID(), userId, chatId]
      );
    }

    // ── 6. Enable digest ──
    if (USE_SQLITE) {
      await query(
        `INSERT OR REPLACE INTO notification_settings (user_id, tg_digest_enabled) VALUES ($1, 1)`,
        [userId]
      );
    } else {
      await query(
        `INSERT INTO notification_settings (user_id, tg_digest_enabled)
         VALUES ($1, TRUE)
         ON CONFLICT (user_id) DO UPDATE SET tg_digest_enabled = TRUE`,
        [userId]
      );
    }

    console.log(`[Telegram Widget] User ${userId} linked to TG ${chatId}`);
    res.json({ success: true, chatId });
  } catch (err: any) {
    console.error('[Telegram Widget] Error:', err.message);
    res.status(500).json({ error: 'Failed to link Telegram account' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Telegram Bot Config — public bot info for frontend OAuth
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/telegram/config', async (req, res) => {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!botToken) {
      return res.status(500).json({ error: 'Telegram bot not configured' });
    }

    const botId = botToken.split(':')[0];
    if (!botId || isNaN(parseInt(botId))) {
      return res.status(500).json({ error: 'Invalid bot token format' });
    }

    res.json({
      botId: parseInt(botId),
      botUsername: 'Insidepulse_bot',
    });
  } catch (err: any) {
    console.error('[Telegram Config] Error:', err.message);
    res.status(500).json({ error: 'Failed to get telegram config' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Debug: validate Telegram chat/channel
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/debug/telegram-channel/:chatId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const chatId = req.params.chatId;
    const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
    if (!botToken) {
      return res.status(500).json({ error: 'Telegram bot not configured' });
    }

    const { data } = await axios.get(`https://api.telegram.org/bot${botToken}/getChat`, {
      params: { chat_id: chatId },
    });

    res.json({
      valid: true,
      chat: {
        id: data.result.id,
        type: data.result.type,
        username: data.result.username,
        title: data.result.title,
      },
    });
  } catch (error: any) {
    const code = error.response?.data?.error_code;
    const description = error.response?.data?.description;
    if (code === 400 || code === 403) {
      return res.json({
        valid: false,
        error: description,
        suggestion: 'Channel should be deactivated',
      });
    }
    res.status(500).json({ error: error.message });
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

    // Get tag counts from news (matched_tags stores tag_id, join with user_defined_tags for tag_name)
    const newsCountsResult = await query(`
      SELECT t.tag_name, COUNT(*) as count
      FROM news n
      JOIN user_defined_tags t ON t.tag_id = ANY(n.matched_tags)
      WHERE n.matched_tags IS NOT NULL AND array_length(n.matched_tags, 1) > 0
      GROUP BY t.tag_name
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

// ═══════════════════════════════════════════════════════════════════════════
// TZ_DELETE_ACCOUNT v1.0 — YooKassa auto-renew cancellation
//
// Зачем: перед удалением пользователя ОБЯЗАТЕЛЬНО отменить auto-renew.
// Иначе YooKassa продолжит списывать деньги с карты пользователя,
// хотя аккаунт уже удалён.
//
// Алгоритм:
//   1. Проверить что YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY настроены
//   2. POST /v3/payments/{paymentId}/cancel с Basic auth
//   3. Idempotence-Key = уникальный (timestamp) — безопасно повторять
//   4. Логирование результата
//
// Ошибки не прерывают удаление — логируем и продолжаем.
// Пользователь уже решил удалиться, мы делаем best effort.
// ═══════════════════════════════════════════════════════════════════════════
async function cancelYookassaAutoRenew(paymentId: string): Promise<void> {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;

  if (!shopId || !secretKey) {
    console.warn('[YooKassa] Missing credentials, skipping cancel');
    return;
  }

  const auth = Buffer.from(`${shopId}:${secretKey}`).toString('base64');

  const response = await fetch(`https://api.yookassa.ru/v3/payments/${paymentId}/cancel`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'Idempotence-Key': `cancel-${paymentId}-${Date.now()}`,
    },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`YooKassa cancel failed: ${response.status} ${errorText}`);
  }

  console.log(`[YooKassa] Auto-renew cancelled for payment ${paymentId}`);
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
    await runMigration('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE', 'is_admin');
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
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS needs_translation BOOLEAN DEFAULT TRUE`, name: 'needs_translation' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS is_political BOOLEAN DEFAULT FALSE`, name: 'is_political' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS article_type VARCHAR(10) DEFAULT 'micro'`, name: 'article_type' },
    { sql: `CREATE TABLE IF NOT EXISTS cron_locks (job_name VARCHAR(50) PRIMARY KEY, locked_at TIMESTAMP, locked_by VARCHAR(100), expires_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'cron_locks' },
    { sql: `CREATE TABLE IF NOT EXISTS user_defined_tags (tag_id VARCHAR(50) PRIMARY KEY, tag_name VARCHAR(100) NOT NULL, tag_type VARCHAR(20) DEFAULT 'company', keywords TEXT[] DEFAULT '{}', enriched_data JSONB, created_by UUID REFERENCES users(id), created_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'user_defined_tags' },
    // Telegram digest settings
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS tg_digest_enabled BOOLEAN DEFAULT FALSE`, name: 'tg_digest_enabled' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS digest_frequency VARCHAR(10) DEFAULT '1h'`, name: 'digest_frequency' },
    { sql: `ALTER TABLE user_defined_tags ADD COLUMN IF NOT EXISTS enriched_data JSONB`, name: 'enriched_data' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS last_digest_sent TIMESTAMP`, name: 'last_digest_sent' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS digest_email VARCHAR(255)`, name: 'digest_email' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS email_digest_enabled BOOLEAN DEFAULT FALSE`, name: 'email_digest_enabled' },
    { sql: `CREATE TABLE IF NOT EXISTS cron_log (id ${USE_SQLITE ? 'INTEGER PRIMARY KEY AUTOINCREMENT' : 'SERIAL PRIMARY KEY'}, task_name VARCHAR(50) NOT NULL, started_at TIMESTAMP NOT NULL DEFAULT ${_SQL_NOW}, finished_at TIMESTAMP, articles_fetched INTEGER DEFAULT 0, articles_saved INTEGER DEFAULT 0, articles_merged INTEGER DEFAULT 0, errors TEXT, status VARCHAR(20) DEFAULT 'running')`, name: 'cron_log' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_cron_log_started_at ON cron_log(started_at DESC)`, name: 'idx_cron_log_started_at' },
    // TZ_TG_DIGEST_V3: index for hybrid fetched_at filter (digest + reports)
    { sql: `CREATE INDEX IF NOT EXISTS idx_news_fetched_at ON news(fetched_at DESC)`, name: 'idx_news_fetched_at' },
    { sql: `CREATE TABLE IF NOT EXISTS rss_source_meta (source_id VARCHAR(50) PRIMARY KEY, last_fetched_at TIMESTAMP NOT NULL DEFAULT ${USE_SQLITE ? "datetime('now', '-24 hours')" : "NOW() - INTERVAL '24 hours'"}, updated_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'rss_source_meta' },
    { sql: `CREATE TABLE IF NOT EXISTS llm_batches (id SERIAL PRIMARY KEY, status VARCHAR(20) NOT NULL, started_at TIMESTAMP NOT NULL, finished_at TIMESTAMP NOT NULL, articles_count INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, failed_count INTEGER NOT NULL DEFAULT 0, partial_count INTEGER NOT NULL DEFAULT 0, error_types JSONB DEFAULT '{}', created_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'llm_batches' },
    // TGparser — RSS source (exists in rssSources.ts but missing in news_sources table)
    { sql: `INSERT INTO news_sources (name, display_name, type, config, enabled) VALUES ('tgparser', 'TG Parser News', 'rss', '{"url": "https://tgparser-web.onrender.com/rss", "lang": "ru", "category": "news"}', true) ON CONFLICT (name) DO NOTHING`, name: 'news_source_tgparser' },
    // Sentiment Index tables
    { sql: `CREATE TABLE IF NOT EXISTS sentiment_votes (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, vote_value SMALLINT NOT NULL CHECK (vote_value IN (-1, 0, 1)), created_at TIMESTAMPTZ DEFAULT ${_SQL_NOW}, tickers JSONB DEFAULT '[]', index_at_vote INT DEFAULT 0, imoex_at_vote DECIMAL(10,2), imoex_after_1h DECIMAL(10,2), index_after_2h INT, check_status VARCHAR(20) DEFAULT 'pending')`, name: 'sentiment_votes' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sentiment_votes_user_time ON sentiment_votes(user_id, created_at DESC)`, name: 'idx_sentiment_votes_user_time' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sentiment_votes_created ON sentiment_votes(created_at DESC)`, name: 'idx_sentiment_votes_created' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sentiment_votes_check ON sentiment_votes(check_status, created_at)`, name: 'idx_sentiment_votes_check' },
    { sql: `CREATE TABLE IF NOT EXISTS sentiment_user_windows (user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, last_vote_at TIMESTAMPTZ, next_vote_at TIMESTAMPTZ, vote_count_today INT DEFAULT 0, total_votes_all_time INT DEFAULT 0, sync_count INT DEFAULT 0, total_votes_count INT DEFAULT 0, streak_days INT DEFAULT 0, max_streak_days INT DEFAULT 0, favorite_sentiment VARCHAR(10) DEFAULT NULL, impact_sum INT DEFAULT 0, last_streak_date DATE DEFAULT NULL, unlocked_badges JSONB DEFAULT '[]', forecast_streak INT DEFAULT 0, max_forecast_streak INT DEFAULT 0, contrarian_count INT DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT ${_SQL_NOW})`, name: 'sentiment_user_windows' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sentiment_windows_next_vote ON sentiment_user_windows(next_vote_at)`, name: 'idx_sentiment_windows_next_vote' },
    { sql: `CREATE TABLE IF NOT EXISTS sentiment_index_cache (date DATE PRIMARY KEY, current_value INT DEFAULT 0, vote_count INT DEFAULT 0, imoex_candles JSONB DEFAULT '[]', imoex_updated_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT ${_SQL_NOW})`, name: 'sentiment_index_cache' },
    { sql: `ALTER TABLE sentiment_index_cache ADD COLUMN IF NOT EXISTS imoex_candles JSONB DEFAULT '[]'`, name: 'sentiment_index_cache_imoex_candles' },
    { sql: `ALTER TABLE sentiment_index_cache ADD COLUMN IF NOT EXISTS imoex_updated_at TIMESTAMPTZ`, name: 'sentiment_index_cache_imoex_updated_at' },
    { sql: `CREATE TABLE IF NOT EXISTS push_notifications_sent (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, news_id UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE, sent_at TIMESTAMP DEFAULT ${_SQL_NOW}, UNIQUE(user_id, news_id))`, name: 'push_notifications_sent' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_push_notifications_sent_user_id ON push_notifications_sent(user_id)`, name: 'idx_push_notifications_sent_user_id' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_push_notifications_sent_news_id ON push_notifications_sent(news_id)`, name: 'idx_push_notifications_sent_news_id' },
    // Sentiment vote push deduplication
    { sql: `CREATE TABLE IF NOT EXISTS sentiment_vote_push_sent (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, sent_date DATE NOT NULL, created_at TIMESTAMP DEFAULT ${_SQL_NOW}, UNIQUE(user_id, sent_date))`, name: 'sentiment_vote_push_sent' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sentiment_vote_push_sent_user_id ON sentiment_vote_push_sent(user_id)`, name: 'idx_sentiment_vote_push_sent_user_id' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sentiment_vote_push_sent_date ON sentiment_vote_push_sent(sent_date)`, name: 'idx_sentiment_vote_push_sent_date' },
    // Subscription plans v2
    { sql: `CREATE TABLE IF NOT EXISTS subscription_plans (id VARCHAR(20) PRIMARY KEY, name VARCHAR(50) NOT NULL, price_monthly DECIMAL(10,2) NOT NULL, price_yearly DECIMAL(10,2) NOT NULL, yearly_discount INTEGER DEFAULT 20, tag_limit INTEGER NOT NULL, features JSONB NOT NULL DEFAULT '{}', display_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN DEFAULT TRUE, coming_soon_label VARCHAR(50) DEFAULT NULL, created_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'subscription_plans' },
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_plan VARCHAR(20) DEFAULT 'free'`, name: 'users_subscription_plan' },
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS scheduled_plan_downgrade VARCHAR(20)`, name: 'users_scheduled_downgrade' },
    { sql: `ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan_id VARCHAR(20)`, name: 'payments_plan_id' },
    { sql: `ALTER TABLE payments ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(10) DEFAULT 'monthly'`, name: 'payments_billing_cycle' },
    { sql: `ALTER TABLE payments ADD COLUMN IF NOT EXISTS duration_days INTEGER DEFAULT 30`, name: 'payments_duration_days' },
    { sql: `ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_upgrade BOOLEAN DEFAULT FALSE`, name: 'payments_is_upgrade' },
    { sql: `ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT FALSE`, name: 'portfolios_is_frozen' },
    { sql: `ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS tag_name VARCHAR(100), ADD COLUMN IF NOT EXISTS tag_type VARCHAR(20) DEFAULT 'company', ADD COLUMN IF NOT EXISTS is_frozen BOOLEAN DEFAULT FALSE`, name: 'portfolios_tag_name_type' },
    { sql: `UPDATE portfolios p SET tag_name = udt.tag_name, tag_type = udt.tag_type FROM user_defined_tags udt WHERE p.tag_id = udt.tag_id AND p.tag_name IS NULL`, name: 'portfolios_backfill_tag_name' },
    { sql: `UPDATE portfolios SET tag_name = tag_id, tag_type = 'company' WHERE tag_name IS NULL`, name: 'portfolios_fallback_tag_name' },
    { sql: `ALTER TABLE portfolios ALTER COLUMN tag_name SET NOT NULL`, name: 'portfolios_tag_name_not_null' },
    { sql: `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portfolios_user_tag_unique' AND conrelid = 'portfolios'::regclass) THEN ALTER TABLE portfolios ADD CONSTRAINT portfolios_user_tag_unique UNIQUE (user_id, tag_id); END IF; END $$`, name: 'portfolios_unique_constraint' },
    { sql: `CREATE TABLE IF NOT EXISTS user_payment_methods (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, payment_method_id VARCHAR(255) NOT NULL, provider VARCHAR(20) DEFAULT 'yookassa', card_last4 VARCHAR(4), card_brand VARCHAR(20), card_expiry VARCHAR(5), is_active BOOLEAN DEFAULT TRUE, is_default BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT ${_SQL_NOW}, deactivated_at TIMESTAMP, UNIQUE(user_id, payment_method_id))`, name: 'user_payment_methods' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_user_payment_methods_user_id ON user_payment_methods(user_id)`, name: 'idx_user_payment_methods_user_id' },
    { sql: `CREATE TABLE IF NOT EXISTS subscription_renewals (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, plan_id VARCHAR(20) NOT NULL REFERENCES subscription_plans(id), billing_cycle VARCHAR(10) NOT NULL, payment_id UUID REFERENCES payments(id), status VARCHAR(20) NOT NULL, period_start TIMESTAMP NOT NULL, period_end TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'subscription_renewals' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_renewals_user_id ON subscription_renewals(user_id)`, name: 'idx_renewals_user_id' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_renewals_period_end ON subscription_renewals(period_end)`, name: 'idx_renewals_period_end' },
    { sql: `CREATE TABLE IF NOT EXISTS frozen_tags (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, tag_id VARCHAR(50) NOT NULL, tag_name VARCHAR(100) NOT NULL, tag_type VARCHAR(20) NOT NULL, frozen_at TIMESTAMP DEFAULT ${_SQL_NOW}, unfrozen_at TIMESTAMP, UNIQUE(user_id, tag_id))`, name: 'frozen_tags' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_frozen_tags_user_id ON frozen_tags(user_id)`, name: 'idx_frozen_tags_user_id' },
    { sql: `CREATE TABLE IF NOT EXISTS push_subscriptions (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT ${_SQL_NOW}, UNIQUE(user_id, endpoint))`, name: 'push_subscriptions' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id)`, name: 'idx_push_subscriptions_user_id' },
    { sql: `CREATE TABLE IF NOT EXISTS webhook_events (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), provider VARCHAR(20) NOT NULL, event_type VARCHAR(50) NOT NULL, payload JSONB DEFAULT '{}', processed BOOLEAN DEFAULT FALSE, error TEXT, created_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'webhook_events' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_webhook_events_created_at ON webhook_events(created_at DESC)`, name: 'idx_webhook_events_created_at' },
    { sql: `CREATE TABLE IF NOT EXISTS subscription_notifications_sent (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, type VARCHAR(30) NOT NULL, sent_at TIMESTAMP DEFAULT ${_SQL_NOW}, UNIQUE(user_id, type))`, name: 'subscription_notifications_sent' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_sub_notif_user_type ON subscription_notifications_sent(user_id, type)`, name: 'idx_sub_notif_user_type' },
    // Admin tariffs v3: plan_level, is_popular, deleted_at, billing_frequency, price
    { sql: `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP DEFAULT NULL`, name: 'plans_deleted_at' },
    { sql: `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS plan_level INTEGER NOT NULL DEFAULT 0`, name: 'plans_plan_level' },
    { sql: `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS is_popular BOOLEAN NOT NULL DEFAULT FALSE`, name: 'plans_is_popular' },
    { sql: `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS billing_frequency VARCHAR(20) NOT NULL DEFAULT 'monthly'`, name: 'plans_billing_frequency' },
    { sql: `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS price DECIMAL(10,2) NOT NULL DEFAULT 0`, name: 'plans_price' },
    { sql: `UPDATE subscription_plans SET price = price_monthly, billing_frequency = 'monthly' WHERE price = 0 AND price_monthly IS NOT NULL`, name: 'plans_migrate_price' },
    { sql: `UPDATE subscription_plans SET plan_level = CASE WHEN id = 'free' THEN 0 WHEN id = 'base' THEN 1 WHEN id = 'premium' THEN 2 WHEN id = 'club' THEN 3 WHEN id = 'pro' THEN 4 END WHERE plan_level = 0`, name: 'plans_init_levels' },
    { sql: `UPDATE subscription_plans SET is_popular = TRUE WHERE id = 'premium'`, name: 'plans_premium_popular' },
    { sql: `UPDATE subscription_plans SET is_active = TRUE WHERE id IN ('club', 'pro')`, name: 'plans_activate_club_pro' },
    { sql: `ALTER TABLE subscription_plans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT ${_SQL_NOW}`, name: 'plans_updated_at' },
    { sql: `ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_code VARCHAR(50) DEFAULT NULL`, name: 'payments_promo_code' },
    { sql: `ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_discount_type VARCHAR(20) DEFAULT NULL`, name: 'payments_promo_discount_type' },
    { sql: `ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_discount_value INTEGER DEFAULT NULL`, name: 'payments_promo_discount_value' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_payments_promo ON payments(promo_code)`, name: 'idx_payments_promo' },
    { sql: `CREATE TABLE IF NOT EXISTS promo_codes (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), code VARCHAR(50) NOT NULL UNIQUE, description VARCHAR(255) DEFAULT NULL, discount_type VARCHAR(20) NOT NULL DEFAULT 'percent', discount_value INTEGER NOT NULL DEFAULT 0, applicable_plans VARCHAR(20)[] DEFAULT NULL, max_uses INTEGER DEFAULT NULL, uses_count INTEGER NOT NULL DEFAULT 0, valid_from TIMESTAMP NOT NULL DEFAULT ${_SQL_NOW}, expires_at TIMESTAMP DEFAULT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_by UUID REFERENCES users(id), created_at TIMESTAMP DEFAULT ${_SQL_NOW}, updated_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'promo_codes' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_promo_codes_code ON promo_codes(code)`, name: 'idx_promo_codes_code' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active) WHERE is_active = TRUE`, name: 'idx_promo_codes_active' },
    { sql: `CREATE TABLE IF NOT EXISTS user_promo_uses (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, promo_code_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE, plan_id VARCHAR(20) NOT NULL, billing_cycle VARCHAR(10) NOT NULL, discount_applied INTEGER NOT NULL DEFAULT 0, trial_days_used INTEGER DEFAULT NULL, expected_renewal_price DECIMAL(10,2) DEFAULT NULL, payment_id UUID REFERENCES payments(id), created_at TIMESTAMP DEFAULT ${_SQL_NOW}, UNIQUE(user_id, promo_code_id))`, name: 'user_promo_uses' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_user_promo_uses_user ON user_promo_uses(user_id)`, name: 'idx_user_promo_uses_user' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_user_promo_uses_promo ON user_promo_uses(promo_code_id)`, name: 'idx_user_promo_uses_promo' },
    { sql: `CREATE TABLE IF NOT EXISTS features_registry (id VARCHAR(50) PRIMARY KEY, label VARCHAR(100) NOT NULL, description VARCHAR(255) DEFAULT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP DEFAULT ${_SQL_NOW}, updated_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'features_registry' },
    { sql: `ALTER TABLE features_registry DROP COLUMN IF EXISTS type`, name: 'features_registry_drop_type' },
    { sql: `ALTER TABLE features_registry DROP COLUMN IF EXISTS options`, name: 'features_registry_drop_options' },
    { sql: `ALTER TABLE features_registry ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT ${_SQL_NOW}`, name: 'features_registry_updated_at' },
    { sql: `INSERT INTO features_registry (id, label, description) VALUES ('telegram', 'Telegram-дайджест', 'Дайджест новостей в Telegram'), ('push', 'Push-уведомления', 'Push-уведомления в браузере/приложении'), ('ai_summary', 'AI-саммари по портфелю', 'AI-анализ портфеля каждый час'), ('alerts', 'Sentiment-алерты', 'Уведомления при резком изменении сентимента'), ('priority', 'Приоритетная доставка', 'Приоритет обработки новостей'), ('early_delivery', 'Ранняя доставка', 'Доступ к новостям на 5 минут раньше'), ('custom_thresholds', 'Кастомные пороги', 'Настройка порогов для алертов'), ('club_access', 'Club доступ', 'Доступ к закрытому Telegram-чату'), ('api_access', 'API доступ', 'Доступ к REST API с токеном') ON CONFLICT (id) DO NOTHING`, name: 'features_registry_seed' },
    { sql: `CREATE TABLE IF NOT EXISTS password_reset_codes (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, code VARCHAR(6) NOT NULL, created_at TIMESTAMPTZ DEFAULT ${_SQL_NOW}, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, used BOOLEAN DEFAULT FALSE)`, name: 'password_reset_codes' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_password_reset_codes_user_expires ON password_reset_codes(user_id, expires_at DESC)`, name: 'idx_password_reset_codes_user_expires' },
    // Admin TG alerts
    { sql: `CREATE TABLE IF NOT EXISTS admin_tg_settings (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, tg_chat_id VARCHAR(50) NOT NULL, event_types TEXT[] DEFAULT '{}', is_active BOOLEAN DEFAULT TRUE, created_at TIMESTAMP DEFAULT ${_SQL_NOW}, updated_at TIMESTAMP DEFAULT ${_SQL_NOW}, UNIQUE(admin_user_id))`, name: 'admin_tg_settings' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_admin_tg_settings_active ON admin_tg_settings(is_active)`, name: 'idx_admin_tg_settings_active' },
    // Fact-checking
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS fact_check_status TEXT NOT NULL DEFAULT 'not_checked'`, name: 'news_fact_check_status' },
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS fact_check_result JSONB DEFAULT NULL`, name: 'news_fact_check_result' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS fact_check_email_enabled BOOLEAN DEFAULT TRUE`, name: 'notification_settings_fact_check_email_enabled' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS fact_check_tg_enabled BOOLEAN DEFAULT TRUE`, name: 'notification_settings_fact_check_tg_enabled' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_news_fact_check_status ON news(fact_check_status)`, name: 'idx_news_fact_check_status' },
    { sql: `CREATE TABLE IF NOT EXISTS fact_check_jobs (id ${USE_SQLITE ? 'TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))' : 'UUID PRIMARY KEY DEFAULT uuid_generate_v4()'}, news_id ${USE_SQLITE ? 'TEXT' : 'UUID'} NOT NULL REFERENCES news(id) ON DELETE CASCADE, user_id ${USE_SQLITE ? 'TEXT' : 'UUID'} NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'queued', error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, next_retry_at TIMESTAMP, created_at TIMESTAMP DEFAULT ${_SQL_NOW}, updated_at TIMESTAMP DEFAULT ${_SQL_NOW}, UNIQUE(news_id, user_id))`, name: 'fact_check_jobs' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_fact_check_jobs_status ON fact_check_jobs(status)`, name: 'idx_fact_check_jobs_status' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_fact_check_jobs_news_id ON fact_check_jobs(news_id)`, name: 'idx_fact_check_jobs_news_id' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_fact_check_jobs_user_id ON fact_check_jobs(user_id)`, name: 'idx_fact_check_jobs_user_id' },
    // News slugs for deeplinks
    { sql: `ALTER TABLE news ADD COLUMN IF NOT EXISTS slug VARCHAR(250) UNIQUE`, name: 'news_slug' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_news_slug ON news(slug)`, name: 'idx_news_slug' },
    // TZ_ADMIN2_ANALYTICS_v3_5: user analytics and management columns
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE`, name: 'users_is_blocked' },
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP`, name: 'users_last_login_at' },
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count INTEGER DEFAULT 0`, name: 'users_login_count' },
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_source VARCHAR(50)`, name: 'users_registration_source' },
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS registration_ip VARCHAR(45)`, name: 'users_registration_ip' },
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(50)`, name: 'users_timezone' },
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS locale VARCHAR(10)`, name: 'users_locale' },
    { sql: `ALTER TABLE users ADD COLUMN IF NOT EXISTS cohort_date DATE`, name: 'users_cohort_date' },
    { sql: `CREATE TABLE IF NOT EXISTS user_logins (id ${USE_SQLITE ? 'TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16))))' : 'UUID PRIMARY KEY DEFAULT uuid_generate_v4()'}, user_id ${USE_SQLITE ? 'TEXT' : 'UUID'} NOT NULL REFERENCES users(id) ON DELETE CASCADE, login_at TIMESTAMP DEFAULT ${_SQL_NOW}, ip_address VARCHAR(45), user_agent TEXT, platform VARCHAR(20), device_type VARCHAR(20), os VARCHAR(50), browser VARCHAR(50), country VARCHAR(2), created_at TIMESTAMP DEFAULT ${_SQL_NOW})`, name: 'user_logins' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_user_logins_user_id ON user_logins(user_id)`, name: 'idx_user_logins_user_id' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_user_logins_login_at ON user_logins(login_at DESC)`, name: 'idx_user_logins_login_at' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_user_logins_platform ON user_logins(platform)`, name: 'idx_user_logins_platform' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_user_logins_device_type ON user_logins(device_type)`, name: 'idx_user_logins_device_type' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_user_logins_country ON user_logins(country)`, name: 'idx_user_logins_country' },
    { sql: `ALTER TABLE push_notifications_sent ADD COLUMN IF NOT EXISTS title VARCHAR(255)`, name: 'push_notifications_sent_title' },
    { sql: `ALTER TABLE push_notifications_sent ADD COLUMN IF NOT EXISTS source VARCHAR(50)`, name: 'push_notifications_sent_source' },
  ];
  for (const m of migrations) {
    try {
      await runMigration(m.sql, m.name);
    } catch (e: any) {
      console.log(`[DB] Migration warning for ${m.name}:`, e.message);
    }
  }

  // Backfill missing news slugs on startup (one-time / after migration)
  (async () => {
    try {
      const missing = await query(`SELECT id, title_original, title_ru FROM news WHERE slug IS NULL LIMIT 5000`);
      if (missing.rows.length === 0) return;
      console.log(`[SlugBackfill] ${missing.rows.length} articles without slug`);
      for (const row of missing.rows) {
        const title = row.title_original || row.title_ru || 'news';
        let slug = slugify(title, row.id);
        try {
          await query(`UPDATE news SET slug = $1 WHERE id = $2`, [slug, row.id]);
        } catch (err: any) {
          if (/unique constraint/i.test(err.message)) {
            slug = slug + row.id.replace(/-/g, '').substring(8, 12);
            await query(`UPDATE news SET slug = $1 WHERE id = $2`, [slug, row.id]);
          } else {
            console.error(`[SlugBackfill] ${row.id} failed:`, err.message);
          }
        }
      }
      console.log('[SlugBackfill] Done');
    } catch (err: any) {
      console.error('[SlugBackfill] Error:', err.message);
    }
  })();

  // Seed subscription plans
  try {
    await query(`
      INSERT INTO subscription_plans
        (id, name, price, billing_frequency, yearly_discount, tag_limit, features, display_order, is_active, is_popular, coming_soon_label, plan_level)
      VALUES
        ('free',    'Free',    0,     'monthly', 0,  3,
         '{"telegram":false,"push":false,"ai_summary":false,"alerts":false,"priority":"normal"}',
         1, TRUE, FALSE, NULL, 0),
        ('base',    'Base',    100,   'monthly', 20, 10,
         '{"telegram":true,"push":true,"ai_summary":false,"alerts":false,"priority":"normal"}',
         2, TRUE, FALSE, NULL, 1),
        ('premium', 'Premium', 990,   'monthly', 20, 25,
         '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"high"}',
         3, TRUE, TRUE, NULL, 2),
        ('club',    'Club',    2500,  'monthly', 20, -1,
         '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"max","early_delivery":true,"custom_thresholds":true,"club_access":true}',
         4, TRUE, FALSE, 'Скоро', 3),
        ('pro',     'Pro',     2500,  'monthly', 20, -1,
         '{"telegram":true,"push":true,"ai_summary":true,"alerts":true,"priority":"max","early_delivery":true,"custom_thresholds":true,"api_access":true}',
         5, TRUE, FALSE, 'Скоро', 4)
      ON CONFLICT (id) DO NOTHING
    `);
    console.log('[DB] Migration: subscription_plans seeded');
  } catch (e: any) {
    console.log('[DB] Migration subscription_plans seed warning:', e.message);
  }

  // Critical: free plan must exist
  const freePlan = await getPlanById('free');
  if (!freePlan) {
    console.error('[CRITICAL] Free plan not found! System cannot function.');
    process.exit(1);
  }
  console.log(`[OK] Free plan loaded: tag_limit=${freePlan.tag_limit}`);

  // Migrate existing users to subscription_plan
  try {
    await query(`
      UPDATE users SET subscription_plan = 'premium'
      WHERE subscription_active = TRUE
        AND (subscription_plan IS NULL OR subscription_plan = '' OR subscription_plan = 'free')
    `);
    await query(`
      UPDATE users SET subscription_plan = 'free'
      WHERE (subscription_active = FALSE OR subscription_active IS NULL)
        AND (subscription_plan IS NULL OR subscription_plan = '')
    `);
    console.log('[DB] Migration: existing users migrated to subscription_plan');
  } catch (e: any) {
    console.log('[DB] Migration users subscription_plan warning:', e.message);
  }

  // Backfill
  try {
    await query(`UPDATE news SET all_sources = ARRAY[source], source_count = 1 WHERE all_sources IS NULL OR array_length(all_sources, 1) IS NULL`);
    console.log('[DB] Migration: backfilled all_sources and source_count');
  } catch (e: any) {
    console.log('[DB] Migration backfill warning:', e.message);
  }

  // llm_batches: add missing columns (for tables created before v9.5)
  try {
    await query(`ALTER TABLE llm_batches ADD COLUMN IF NOT EXISTS success_count INTEGER NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE llm_batches ADD COLUMN IF NOT EXISTS failed_count INTEGER NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE llm_batches ADD COLUMN IF NOT EXISTS partial_count INTEGER NOT NULL DEFAULT 0`);
    await query(`ALTER TABLE llm_batches ADD COLUMN IF NOT EXISTS error_types JSONB DEFAULT '{}'`);
    console.log('[DB] Migration: llm_batches columns added (success_count, failed_count, partial_count, error_types)');
  } catch (e: any) {
    console.log('[DB] Migration llm_batches columns warning:', e.message);
  }

  // News Processor: initialize needs_translation for existing articles (all → FALSE, only new articles get TRUE)
  try {
    await query(`UPDATE news SET needs_translation = FALSE WHERE needs_translation IS NULL OR needs_translation = TRUE`);
    console.log('[DB] Migration: initialized needs_translation = FALSE for existing articles');
  } catch (e: any) {
    console.log('[DB] Migration needs_translation warning:', e.message);
  }

  // News Processor: partial index for fast lookup
  try {
    await query(`CREATE INDEX IF NOT EXISTS idx_news_needs_processing ON news (published_at DESC) WHERE needs_translation = TRUE`);
    console.log('[DB] Migration: idx_news_needs_processing created');
  } catch (e: any) {
    console.log('[DB] Migration index warning:', e.message);
  }

  // CRITICAL: Allow NULL in title_ru — Finnhub inserts raw articles with title_ru=null
  try {
    await query(`ALTER TABLE news ALTER COLUMN title_ru DROP NOT NULL`);
    console.log('[DB] Migration: title_ru NOT NULL constraint dropped');
  } catch (e: any) {
    console.log('[DB] Migration title_ru warning:', e.message);
  }
  // UNIQUE(url) на news — предотвращает дубликаты одной и той же новости
  try {
    await query(`ALTER TABLE news ADD CONSTRAINT news_url_unique UNIQUE (url)`);
    console.log('[DB] Migration: news.url unique constraint added');
  } catch { /* ignore — может уже существовать */ }
  // DROP UNIQUE(url_normalized) — normalizeUrl() даёт одинаковый результат
  // для URL с разными query params (Finnhub: ?id=xxx). UNIQUE(url) достаточно.
  try {
    await query(`ALTER TABLE news DROP CONSTRAINT IF EXISTS news_url_norm_unique`);
    console.log('[DB] Migration: dropped UNIQUE(url_normalized) constraint');
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

  // ═══════════════════════════════════════════════════════════════
  // TZ_DELETE_ACCOUNT v1.0 — Migration: SET NULL on user_defined_tags.created_by
  //
  // Проблема: старый FK был без ON DELETE — при DELETE users падал с FK violation.
  // Решение: DROP старый FK → ADD новый с ON DELETE SET NULL.
  //
  // Что происходит при удалении пользователя:
  //   - created_by = NULL (тег остаётся в системе, но без владельца)
  //   - другие пользователи, подписанные на тег, не теряют его
  //
  // Универсальная миграция: ищет constraint по system catalog, не по имени.
  // Безопасна для повторного запуска (IF constraint_name IS NOT NULL).
  // ═══════════════════════════════════════════════════════════════
  try {
    await query(`
      DO $$
      DECLARE
        constraint_name TEXT;
      BEGIN
        -- Найти FK constraint на created_by через system catalog
        SELECT tc.constraint_name INTO constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_name = 'user_defined_tags'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND ccu.column_name = 'created_by';

        IF constraint_name IS NOT NULL THEN
          -- Удалить старый FK (без ON DELETE)
          EXECUTE format('ALTER TABLE user_defined_tags DROP CONSTRAINT %I', constraint_name);
        END IF;

        -- Создать новый FK с ON DELETE SET NULL
        ALTER TABLE user_defined_tags
          ADD CONSTRAINT user_defined_tags_created_by_fkey
          FOREIGN KEY (created_by) REFERENCES users(id)
          ON DELETE SET NULL;
      END $$;
    `);
    console.log('[DB] Migration: user_defined_tags.created_by → ON DELETE SET NULL');
  } catch (e: any) {
    console.log('[DB] Migration user_defined_tags warning:', e.message);
  }

  // ═══════════════════════════════════════════════════════════════
  // MIGRATIONS: Finnhub Adapter v2 (TZ_FINNHUB_COMPLETE_FIX_v2)
  // ═══════════════════════════════════════════════════════════════

  // FIN-011: published_at → TIMESTAMPTZ
  try {
    await query(`
      DO $$
      BEGIN
        ALTER TABLE news ALTER COLUMN published_at TYPE TIMESTAMPTZ;
      EXCEPTION
        WHEN others THEN NULL;
      END $$;
    `);
    console.log('[DB] Migration: published_at → TIMESTAMPTZ');
  } catch (e: any) {
    console.log('[DB] Migration TIMESTAMPTZ warning:', e.message);
  }

  // news_sources.last_error / last_error_at для мониторинга ошибок
  try {
    await query(`ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS last_error TEXT`);
    await query(`ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMP`);
    console.log('[DB] Migration: news_sources.last_error added');
  } catch (e: any) {
    console.log('[DB] Migration last_error warning:', e.message);
  }

  // news_sources.error_count для мониторинга
  try {
    await query(`ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS error_count INTEGER DEFAULT 0`);
    console.log('[DB] Migration: news_sources.error_count added');
  } catch (e: any) {
    console.log('[DB] Migration error_count warning:', e.message);
  }

  // UNIQUE constraint на user_sessions.user_id
  // bilingual / source tracking columns
  const newsCols = [
    { name: 'summary_original', type: 'TEXT' },
    { name: 'source_type', type: "VARCHAR(20) DEFAULT 'rss'" },
    { name: 'lang_original', type: "VARCHAR(2)" },
  ];
  for (const col of newsCols) {
    try {
      await query(`ALTER TABLE news ADD COLUMN IF NOT EXISTS ${col.name} ${col.type}`);
      console.log(`[DB] Migration: ${col.name} column added`);
    } catch (e: any) {
      console.log(`[DB] Migration warning for ${col.name}:`, e.message);
    }
  }

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
    // startCron() — ОТКЛЮЧЕН (TZ_REMOVE_DUPLICATE_RSS_CRON)
    // RSS обрабатывается NewsSourceManager каждые 5 мин
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
        // Set new webhook (explicit allowed_updates to receive my_chat_member)
        const resp = await axios.default.post(
          `https://api.telegram.org/bot${TG_TOKEN}/setWebhook`,
          {
            url: WEBHOOK_URL,
            allowed_updates: ['message', 'my_chat_member', 'callback_query'],
          },
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

    startDigestCron(); // TG digest cron (every hour)
    startFactCheckCron(); // Fact-check worker (every 10s)

    // Sentiment Index — daily reset of vote_count_today / streak at 00:00 MSK (21:00 UTC)
    cron.schedule('0 21 * * *', () => {
      resetDailyWindows().catch((e: any) => console.error('[Sentiment] daily reset error:', e.message));
    });

    // IMOEX 5-min cache refresh during trading hours (MSK 10:00–23:00 → UTC 07:00–20:00)
    cron.schedule('*/5 7-20 * * 1-5', () => {
      refreshImoexCache().catch((e: any) => console.error('[IMOEX] cron refresh error:', e.message));
    });

    // Auto-renewal — daily at 09:00 UTC (process subscriptions expiring within 3 days)
    cron.schedule('0 9 * * *', () => {
      processAutoRenewals()
        .then((result) => console.log('[Cron] Auto-renew:', result))
        .catch((e: any) => console.error('[Cron] Auto-renew failed:', e.message));
    });
    console.log('[Cron] Auto-renew scheduled daily at 09:00 UTC');

    // Trial expirations — every 6 hours
    cron.schedule('0 */6 * * *', () => {
      processTrialExpirations()
        .then((result) => console.log('[Cron] Trial expirations:', result))
        .catch((e: any) => console.error('[Cron] Trial expirations failed:', e.message));
    });
    console.log('[Cron] Trial expirations scheduled every 6 hours');

    // ═══════════════════════════════════════════════════════════════════
    // Cron: scheduled downgrades
    setInterval(async () => {
      try {
        const processed = await processScheduledDowngrades();
        if (processed > 0) {
          console.log(`[Downgrade] Processed ${processed} scheduled downgrades`);
        }
      } catch (err: any) {
        console.error('[Downgrade] Cron error:', err.message);
      }
    }, 5 * 60 * 1000);

    // Cron: push-напоминание голосовать в Sentiment Index (1 раз в день)
    // Чётный день → 10:30 МСК, нечётный → 15:00 МСК
    // Выходные — не шлём
    // ═══════════════════════════════════════════════════════════════════

    function getTodayPushTimeMsk(): { hour: number; minute: number } | null {
      const mskOffset = 3 * 60 * 60 * 1000;
      const mskTime = new Date(Date.now() + mskOffset);
      const dayOfWeek = mskTime.getUTCDay();  // 0=вс, 6=сб
      const dayOfMonth = mskTime.getUTCDate();

      if (dayOfWeek === 0 || dayOfWeek === 6) return null;

      if (dayOfMonth % 2 === 0) {
        return { hour: 10, minute: 30 };
      }
      return { hour: 15, minute: 0 };
    }

    setInterval(async () => {
      try {
        const pushTime = getTodayPushTimeMsk();
        if (!pushTime) return;

        const mskOffset = 3 * 60 * 60 * 1000;
        const mskNow = new Date(Date.now() + mskOffset);
        const currentHour = mskNow.getUTCHours();
        const currentMinute = mskNow.getUTCMinutes();

        const pushMinutes = pushTime.hour * 60 + pushTime.minute;
        const nowMinutes = currentHour * 60 + currentMinute;
        if (nowMinutes < pushMinutes || nowMinutes >= pushMinutes + 5) return;

        const y = mskNow.getUTCFullYear();
        const m = String(mskNow.getUTCMonth() + 1).padStart(2, '0');
        const d = String(mskNow.getUTCDate()).padStart(2, '0');
        const todayStr = `${y}-${m}-${d}`;

        const result = await query(
          `SELECT u.id as user_id
           FROM users u
           JOIN notification_settings ns ON ns.user_id = u.id AND ns.push_enabled = TRUE
           JOIN user_channels uc ON uc.user_id = u.id AND uc.channel = 'push' AND uc.is_active = TRUE
           WHERE NOT EXISTS (
             SELECT 1 FROM sentiment_votes sv
             WHERE sv.user_id = u.id
               AND sv.created_at >= $1::timestamp AND sv.created_at < $1::timestamp + INTERVAL '1 day'
           )
           AND NOT EXISTS (
             SELECT 1 FROM sentiment_vote_push_sent sp
             WHERE sp.user_id = u.id AND sp.sent_date = $1
           )`,
          [`${todayStr} 00:00:00`]
        );

        console.log(`[SentimentVotePush] ${todayStr} ${pushTime.hour}:${String(pushTime.minute).padStart(2, '0')} — ${result.rows.length} eligible users`);

        for (const row of result.rows) {
          await sendSentimentVotePush(row.user_id);
          await query(
            `INSERT INTO sentiment_vote_push_sent (user_id, sent_date)
             VALUES ($1, $2)
             ON CONFLICT (user_id, sent_date) DO NOTHING`,
            [row.user_id, `${todayStr} 00:00:00`]
          );
        }
      } catch (err: any) {
        console.error('[SentimentVotePush] Cron error:', err.message);
      }
    }, 5 * 60 * 1000);

    // NewsSourceManager — фоновый запуск каждые 5 мин
    // NOTE: /trigger/nsm endpoint зарегистрирован в основном потоке выше
    setInterval(() => {
      nsm.run().catch((e: any) => console.error('[NSM] interval error:', e.message));
    }, 5 * 60 * 1000);

    // News Processor cron — Layer 1 + Layer 2 (translate + sentiment)
    // Обрабатывает "сырые" статьи (needs_translation = TRUE)
    setInterval(() => {
      import('./services/newsProcessor').then(({ processRawArticles }) => {
        processRawArticles().catch(e => console.error('[NewsProcessor] interval error:', e.message));
      });
    }, 10 * 60 * 1000); // 10 min

    // Catch-up: если давно не запускали — запустить
    query(`SELECT MAX(last_fetch_at) as max FROM news_sources WHERE type = 'api_search'`).then(lastFetch => {
      const hoursSince = lastFetch.rows[0]?.max
        ? (Date.now() - new Date(lastFetch.rows[0].max).getTime()) / 3600000
        : 999;
      if (hoursSince > 2) {
        console.log(`[NSM] Last fetch ${hoursSince.toFixed(1)}h ago, running catch-up`);
        nsm.run().catch((e: any) => console.error('[NSM] catch-up error:', e.message));
      }
    });
  });
}

start();