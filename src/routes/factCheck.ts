/**
 * =============================================================================
 * PULSE — Fact-Check Routes
 * =============================================================================
 *
 * Endpoints:
 *   POST /api/news/:id/fact-check       — запуск/перезапуск проверки
 *   GET  /api/news/:id/fact-check       — статус/результат
 *   POST /api/news/:id/fact-check/retry — повторить после ошибки
 */

import { Router, type Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import { getUserSubscription, planLevel } from '../services/subscription';
import { createFactCheckJob, updateNewsFactCheck } from '../services/factCheck';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

const ELIGIBLE_PLANS = ['premium', 'club', 'pro'];

function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

async function requirePremium(req: AuthRequest, res: Response): Promise<boolean> {
  const userId = req.user!.userId;
  const sub = await getUserSubscription(userId);
  const isEligible = sub.active && planLevel(sub.plan) >= planLevel('premium');

  if (!isEligible) {
    res.status(403).json({
      error: 'Факт-чекинг доступен только на тарифе Premium и выше',
      upgrade_required: true,
      min_plan: 'premium',
      min_price: 990,
    });
    return false;
  }
  return true;
}

async function checkRateLimit(userId: string, plan: string): Promise<boolean> {
  const limit = plan === 'premium' ? 10 : 30;
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
      return res.status(429).json({ error: 'Превышен лимит проверок. Попробуйте позже.' });
    }

    const newsResult = await query(
      `SELECT id, title_ru, summary_ru, fact_check_status, fact_check_result FROM news WHERE id = $1`,
      [newsId]
    );
    if (newsResult.rows.length === 0) {
      return res.status(404).json({ error: 'Новость не найдена' });
    }
    const news = newsResult.rows[0];

    if (news.fact_check_status === 'in_progress') {
      return res.status(409).json({ error: 'Проверка уже выполняется' });
    }

    const text = [news.title_ru, news.summary_ru].filter(Boolean).join('\n');
    if (text.length < 50) {
      return res.status(400).json({ error: 'Текст новости слишком короткий для проверки' });
    }

    const jobId = await createFactCheckJob(newsId, userId);
    if (!jobId) {
      return res.status(409).json({ error: 'Fact-check already in progress' });
    }

    res.status(news.fact_check_status === 'checked' ? 200 : 201).json({
      job_id: jobId,
      status: 'in_progress',
      news_status: 'in_progress',
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
      return res.json({
        status: 'checked',
        result: parseFactCheckResult(news.fact_check_result),
      });
    }

    // in_progress — return latest job status
    const jobResult = await query(
      `SELECT status FROM fact_check_jobs
       WHERE news_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [newsId, userId]
    );
    return res.status(202).json({
      status: 'in_progress',
      job_status: jobResult.rows[0]?.status || 'queued',
    });
  } catch (err: any) {
    console.error('[FactCheckRoute] GET error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
