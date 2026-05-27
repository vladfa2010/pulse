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
import { startCron } from './services/cron';   // ← RSS агрегатор (каждые 15 мин)
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
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// TEMP: Cleanup duplicate news by content_hash (keep first, merge sources)
app.get('/cleanup-content-dups', async (req, res) => {
  try {
    // Find duplicates by content_hash
    const dups = await query(`
      SELECT content_hash, array_agg(id ORDER BY published_at) as ids,
             array_agg(source) as sources
      FROM news
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

// TEMP: Debug DB schema
app.get('/debug-db', async (req, res) => {
  try {
    const columns = await query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'news' 
      ORDER BY ordinal_position
    `);
    const count = await query('SELECT COUNT(*) as c FROM news');
    res.json({
      columns: columns.rows,
      news_count: parseInt(count.rows[0]?.c || '0'),
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
