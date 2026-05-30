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
    version: '7.14.1',
    cron: cronStatus,
    sse_subscribers: getSubscriberCount(),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SSE — Real-time news stream (Server-Sent Events)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/news/stream', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // CORS for EventSource
  addSubscriber(res);
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
    kimi_key_set: !!process.env.KIMI_API_KEY,
    kimi_key_length: process.env.KIMI_API_KEY ? process.env.KIMI_API_KEY.length : 0,
    kimi_key_prefix: process.env.KIMI_API_KEY ? process.env.KIMI_API_KEY.slice(0, 12) + '...' : null,
    kimi_model: process.env.KIMI_MODEL || 'kimi-k2 (default)',
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
    { sql: `CREATE TABLE IF NOT EXISTS user_defined_tags (tag_id VARCHAR(50) PRIMARY KEY, tag_name VARCHAR(100) NOT NULL, tag_type VARCHAR(20) DEFAULT 'company', keywords TEXT[] DEFAULT '{}', enriched_data JSONB, created_by UUID REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW())`, name: 'user_defined_tags' },
    // Telegram digest settings
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS tg_digest_enabled BOOLEAN DEFAULT FALSE`, name: 'tg_digest_enabled' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS digest_frequency VARCHAR(10) DEFAULT '3h'`, name: 'digest_frequency' },
    { sql: `ALTER TABLE user_defined_tags ADD COLUMN IF NOT EXISTS enriched_data JSONB`, name: 'enriched_data' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS last_digest_sent TIMESTAMP`, name: 'last_digest_sent' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS digest_email VARCHAR(255)`, name: 'digest_email' },
    { sql: `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS email_digest_enabled BOOLEAN DEFAULT FALSE`, name: 'email_digest_enabled' },
    { sql: `CREATE TABLE IF NOT EXISTS cron_log (id SERIAL PRIMARY KEY, task_name VARCHAR(50) NOT NULL, started_at TIMESTAMP NOT NULL DEFAULT NOW(), finished_at TIMESTAMP, articles_fetched INTEGER DEFAULT 0, articles_saved INTEGER DEFAULT 0, articles_merged INTEGER DEFAULT 0, errors TEXT, status VARCHAR(20) DEFAULT 'running')`, name: 'cron_log' },
    { sql: `CREATE INDEX IF NOT EXISTS idx_cron_log_started_at ON cron_log(started_at DESC)`, name: 'idx_cron_log_started_at' },
    { sql: `CREATE TABLE IF NOT EXISTS rss_source_meta (source_id VARCHAR(50) PRIMARY KEY, last_fetched_at TIMESTAMP NOT NULL DEFAULT NOW() - INTERVAL '24 hours', updated_at TIMESTAMP DEFAULT NOW())`, name: 'rss_source_meta' },
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
