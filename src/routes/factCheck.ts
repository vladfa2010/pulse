/**
 * =============================================================================
 * PULSE — Fact-Check Routes
 * =============================================================================
 *
 * Endpoints:
 *   POST /api/news/:id/fact-check        — запуск/перезапуск проверки
 *   GET  /api/news/:id/fact-check        — статус/результат
 *   GET  /api/news/:id/fact-check/stream — SSE-прогресс проверки
 */

import { Router } from 'express';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import { getUserSubscription } from '../services/subscription';
import { createFactCheckJob, updateNewsFactCheck, setEmitter, removeEmitter } from '../services/factCheck';
import { logFactCheckOrdered, logUserEvent } from '../services/activityLog';
import { nowSql } from '../utils/nowSql';
import requirePremium from '../middleware/requirePremium';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

async function checkRateLimit(userId: string, plan: string): Promise<boolean> {
  const limit = plan === 'premium' ? 100 : 300;
  const since = USE_SQLITE
    ? "datetime('now', '-1 hour')"
    : "NOW() - INTERVAL '1 hour'";
  const result = await query(
    `SELECT COUNT(*) as count FROM fact_check_jobs
     WHERE user_id = $1 AND created_at > ${since}`,
    [userId]
  );
  return parseInt(result.rows[0]?.count || '0', 10) < limit;
}

function parseFactCheckResult(raw: any): any | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

// All routes below require authentication
router.use(authMiddleware);

// POST /api/news/:id/fact-check — start or restart fact-check
router.post('/:id/fact-check', async (req: AuthRequest, res) => {
  try {
    const newsId = req.params.id.toLowerCase();
    const userId = req.user!.userId;

    if (!(await requirePremium(req, res))) return;

    const sub = await getUserSubscription(userId);
    if (!(await checkRateLimit(userId, sub.plan))) {
      return res.status(429).json({ error: 'Превышен лимит проверок. Попробуйте позже.', retry_after: 3600 });
    }

    const newsResult = await query(
      `SELECT id, title_ru, title_original, summary_ru, summary_original, fact_check_status, fact_check_result FROM news WHERE id = $1`,
      [newsId]
    );
    if (newsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Новость не найдена' });
    }
    const news = newsResult.rows[0];

    if (news.fact_check_status === 'in_progress') {
      return res.status(409).json({ error: 'Проверка уже выполняется' });
    }

    // ТЗ-205: ранний отказ — без фолбэка на original-поля пустой text уходил
    // в pipeline и модель честно отвечала «укажите тему», а мусор кэшировался.
    const fcTitle = (news.title_ru || '').trim() || (news.title_original || '').trim();
    const fcSummary = (news.summary_ru || '').trim() || (news.summary_original || '').trim();
    const fcText = [fcTitle, fcSummary].filter(Boolean).join('\n');
    if (fcText.replace(/\s+/g, ' ').trim().length < 10) {
      return res.status(422).json({
        error: 'У этой новости пока нет текста для проверки (перевод ещё не выполнен). Попробуйте позже.',
        not_ready: true,
      });
    }

    const jobId = await createFactCheckJob(newsId, userId);
    if (!jobId) {
      return res.status(409).json({ error: 'Fact-check already in progress' });
    }

    logFactCheckOrdered(userId, newsId).catch(() => {});

    res.status(news.fact_check_status === 'checked' ? 200 : 201).json({
      job_id: jobId,
      status: 'in_progress',
      news_status: 'in_progress',
      limit_per_hour: sub.plan === 'premium' ? 100 : 300,
    });
  } catch (err: any) {
    console.error('[FactCheckRoute] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/:id/fact-check — get status/result
router.get('/:id/fact-check', async (req: AuthRequest, res) => {
  try {
    const newsId = req.params.id.toLowerCase();
    const userId = req.user!.userId;

    const newsResult = await query(
      `SELECT fact_check_status, fact_check_result FROM news WHERE id = $1`,
      [newsId]
    );
    if (newsResult.rows.length === 0) {
      return res.status(404).json({ error: 'News not found' });
    }
    const news = newsResult.rows[0];

    if (news.fact_check_status === 'not_checked') {
      return res.status(404).json({ error: 'Not checked' });
    }

    if (news.fact_check_status === 'checked') {
      const sub = await getUserSubscription(userId);
      const limitPerHour = sub.plan === 'premium' ? 100 : 300;
      const since = USE_SQLITE
        ? "datetime('now', '-1 hour')"
        : "NOW() - INTERVAL '1 hour'";
      const usedThisHour = await query(
        `SELECT COUNT(*) as count FROM fact_check_jobs WHERE user_id = $1 AND created_at > ${since}`,
        [userId]
      );
      const used = parseInt(usedThisHour.rows[0]?.count || '0', 10);
      const remaining = Math.max(0, limitPerHour - used);
      return res.json({
        status: 'checked',
        result: parseFactCheckResult(news.fact_check_result),
        limit: { per_hour: limitPerHour, remaining, reset_in_minutes: 60 - Math.floor((Date.now() % 3_600_000) / 60_000) },
      });
    }

    // in_progress — return latest job status
    const jobResult = await query(
      `SELECT status, attempts, next_retry_at FROM fact_check_jobs
       WHERE news_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [newsId, userId]
    );
    return res.status(202).json({
      status: 'in_progress',
      job_status: jobResult.rows[0]?.status || 'queued',
      // ТЗ-206: polling-фолбэк показывает тот же честный статус ретрая, что и SSE
      attempts: jobResult.rows[0]?.attempts ?? 0,
      next_retry_at: jobResult.rows[0]?.next_retry_at || null,
    });
  } catch (err: any) {
    console.error('[FactCheckRoute] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/:id/fact-check/stream — SSE stream of fact-check stages
router.get('/:id/fact-check/stream', async (req: AuthRequest, res) => {
  try {
    const newsId = req.params.id.toLowerCase();
    const userId = req.user!.userId;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const emitter = new EventEmitter();
    setEmitter(newsId, userId, emitter);

    const send = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    emitter.on('stage', (stage: string, payload: any) => {
      send({ stage, payload, timestamp: Date.now() });
    });
    emitter.on('complete', () => {
      send({ type: 'complete' });
      res.end();
    });
    emitter.on('error', (message: string) => {
      send({ type: 'error', message });
      res.end();
    });
    // ТЗ-206: нефинальная ошибка — stream не закрываем, фронт показывает статус ретрая
    emitter.on('retry', (payload: any) => {
      send({ type: 'retry', ...payload });
    });

    req.on('close', () => {
      emitter.removeAllListeners();
      removeEmitter(newsId, userId, emitter);
    });
  } catch (err: any) {
    console.error('[FactCheckRoute] SSE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/news/:id/fact-check/share — многоразовая шеринговая ссылка (ТЗ-209).
// Создавать может любой авторизованный (результат внутри платформы виден всем,
// включая Free). Мягкая квота: 20 активных ссылок на пользователя. Ссылка без
// сгорания, TTL 7 дней — в отличие от одноразовых lesson_shares (ТЗ-187).
router.post('/:id/fact-check/share', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const newsId = req.params.id.toLowerCase();
    const userId = req.user!.userId;

    const newsResult = await query(
      `SELECT id, fact_check_status, fact_check_result FROM news WHERE id = $1`,
      [newsId]
    );
    if (newsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Новость не найдена' });
    }
    const news = newsResult.rows[0];
    if (news.fact_check_status !== 'checked' || !news.fact_check_result) {
      return res.status(409).json({ error: 'Результат проверки ещё не готов' });
    }
    const parsed = typeof news.fact_check_result === 'string'
      ? JSON.parse(news.fact_check_result)
      : news.fact_check_result;
    if (parsed?.error) {
      return res.status(409).json({ error: 'Проверка завершилась ошибкой, шеринг недоступен' });
    }

    // Идемпотентность: активная ссылка этого пользователя на эту новость —
    // возвращаем её, квоту не расходуем.
    const cutoff = new Date().toISOString();
    const existing = await query(
      `SELECT token, expires_at FROM fact_check_shares
       WHERE owner_user_id = $1 AND news_id = $2 AND expires_at > $3
       ORDER BY created_at DESC LIMIT 1`,
      [userId, newsId, cutoff]
    );
    const base = (process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru').replace(/\/+$/, '');
    if (existing.rows.length > 0) {
      return res.status(200).json({ url: `${base}/share/factcheck/${existing.rows[0].token}` });
    }

    // Квота: 20 активных ссылок (порог на JS — шим SQLite криво транслирует NOW()).
    const quota = await query(
      `SELECT count(*) AS cnt FROM fact_check_shares
       WHERE owner_user_id = $1 AND expires_at > $2`,
      [userId, cutoff]
    );
    if (Number(quota.rows[0]?.cnt ?? 0) >= 20) {
      return res.status(429).json({ error: 'Лимит активных ссылок (20). Дождитесь истечения старых.' });
    }

    const shareId = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('hex'); // 48 символов ≤ VARCHAR(64)
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await query(
      `INSERT INTO fact_check_shares (id, token, news_id, owner_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [shareId, token, newsId, userId, expiresAt]
    );
    logUserEvent(userId, 'factcheck_shared', { news_id: newsId, share_id: shareId }).catch(() => {});

    res.status(201).json({ url: `${base}/share/factcheck/${token}` });
  } catch (err: any) {
    console.error('[FactCheckShare] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
