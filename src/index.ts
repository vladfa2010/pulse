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
import { query } from './config/db';          // ← Единая функция для SQL-запросов
import authRoutes from './routes/auth';
import newsRoutes from './routes/news';
import paymentRoutes from './routes/payment';
import userRoutes from './routes/user';
import translateRoutes from './routes/translate';
import webhookRoutes from './routes/webhook';
import adminRoutes from './routes/admin';
import { apiLimiter, authLimiter, webhookLimiter } from './middleware/rateLimit';
import { startCron, processArticles } from './services/cron';   // ← RSS агрегатор (каждые 15 мин)
import { startReportCron } from './services/reports'; // ← Еженедельные репорты

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
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '4.4' });
});

// TEMP: Check env vars (safe — no secrets exposed)
app.get('/debug-env', async (req, res) => {
  res.json({
    kimi_key_set: !!process.env.KIMI_API_KEY,
    kimi_key_length: process.env.KIMI_API_KEY ? process.env.KIMI_API_KEY.length : 0,
    kimi_key_prefix: process.env.KIMI_API_KEY ? process.env.KIMI_API_KEY.slice(0, 12) + '...' : null,
    cron_secret_set: !!process.env.CRON_SECRET_KEY,
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
      date_distribution: dateDist.rows[0],
      db_size: dbSize.rows[0]?.size,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});



// ═══════════════════════════════════════════════════════════════════════════
// API Routes — все эндпоинты начинаются с /api/
// ═══════════════════════════════════════════════════════════════════════════
app.use('/api/auth', authLimiter, authRoutes);  // Строгий лимит (5/15min) — защита от брутфорса
app.use('/api/news', newsRoutes);       // GET /api/news, /api/news/:tag
app.use('/api/payment', paymentRoutes); // POST /api/payment/create, /confirm
app.use('/api/user', userRoutes);       // GET/POST/DELETE /api/user/tags
app.use('/api/translate', translateRoutes);
app.use('/api/webhook', webhookLimiter, webhookRoutes); // Высокий лимит для YuKassa
app.use('/api/admin', adminRoutes);     // GET /api/admin/users, /stats

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
    { sql: `CREATE TABLE IF NOT EXISTS user_defined_tags (tag_id VARCHAR(50) PRIMARY KEY, tag_name VARCHAR(100) NOT NULL, tag_type VARCHAR(20) DEFAULT 'company', keywords TEXT[] DEFAULT '{}', created_by UUID REFERENCES users(id), created_at TIMESTAMP DEFAULT NOW())`, name: 'user_defined_tags' },
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
  });
}

start();
