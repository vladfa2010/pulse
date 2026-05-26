import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { query } from './config/db';
import authRoutes from './routes/auth';
import newsRoutes from './routes/news';
import paymentRoutes from './routes/payment';
import userRoutes from './routes/user';
import translateRoutes from './routes/translate';
import webhookRoutes from './routes/webhook';
import adminRoutes from './routes/admin';
import { startCron } from './services/cron';
import { startReportCron } from './services/reports';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Middleware
app.use(cors());
app.use(express.json());

// Root — PULSE status page
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ru">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PULSE API</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{background:#161b22;border:1px solid #30363d;border-radius:16px;padding:40px;max-width:400px;text-align:center}.logo{font-size:28px;font-weight:700;margin-bottom:8px}.logo span{color:#00d4ff}.badge{display:inline-block;background:#238636;color:#fff;padding:4px 12px;border-radius:20px;font-size:12px;font-weight:500;margin:12px 0}.info{color:#8b949e;font-size:14px;line-height:1.6;margin:16px 0}.divider{border:none;border-top:1px solid #30363d;margin:20px 0}.links{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}.links a{color:#58a6ff;text-decoration:none;font-size:13px}.links a:hover{text-decoration:underline}</style>
</head>
<body>
<div class="box">
<div class="logo">P<span>UL</span>SE API</div>
<div class="badge">● ONLINE</div>
<div class="info">Сервер работает нормально.<br>API endpoints доступны по пути <code>/api/</code></div>
<hr class="divider">
<div class="links">
<a href="/health">/health</a>
<a href="/api/auth/me">/api/auth</a>
<a href="https://github.com/vladfa2010/pulse">GitHub</a>
</div>
</div>
</body></html>`);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/user', userRoutes);
app.use('/api/translate', translateRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server — initialize DB first
async function start() {
  if (USE_SQLITE) {
    const sqlite = await import('./config/db-sqlite');
    await sqlite.initSQLite();
    await sqlite.initSQLiteSchema();
  } else {
    // PostgreSQL: run schema.sql to create tables if they don't exist
    try {
      const fs = await import('fs');
      const path = await import('path');
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
              // Log but don't fail on "already exists" errors
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

  // Test DB connection on startup
  try {
    const testResult = await query('SELECT NOW() as time');
    console.log('[DB] Connected successfully:', testResult.rows[0].time);
  } catch (err: any) {
    console.error('[DB] Connection test FAILED:', err.message);
  }

  app.listen(PORT, () => {
    console.log(`PULSE backend running on port ${PORT}`);
    console.log(`Routes: /api/auth, /api/news, /api/payment, /api/user, /api/translate, /api/webhook, /api/admin`);

    // Start cron jobs
    startCron();
    startReportCron();
  });
}

start();
