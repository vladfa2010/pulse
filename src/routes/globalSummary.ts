import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { globalSummaryRefreshLimiter } from '../middleware/rateLimit';
import { generateGlobalSummary, getCachedGlobalSummary } from '../services/globalSummary';

const router = Router();

// GET /api/user/summary-global — AI summary of all news for the last 6 hours
router.get(
  '/summary-global',
  authMiddleware,
  globalSummaryRefreshLimiter,
  async (req: AuthRequest, res) => {
    try {
      const refresh = req.query.refresh === '1';
      const result = await generateGlobalSummary({ refresh });
      res.json({
        summary: result.summary,
        cached: result.cached,
        generated_at: result.generatedAt || undefined,
        articles_count: result.articlesCount,
        stale: result.stale || undefined, // ТЗ-50: true при отдаче старого кэша после неудачной генерации
      });
    } catch (err: any) {
      console.error('[GlobalSummaryRoute] Error:', err.message);
      res.status(500).json({ error: 'Failed to generate global summary' });
    }
  }
);

// ─── ТЗ-55: read-only кэш крона для авторизованных ──────────────────────────
// Семантика: НИКОГДА не триггерит LLM-генерацию (как /api/public/summary-global
// для гостей). Если кэша нет/протух — 204 No Content. Фронт ретраит раз в 30с,
// пока крон не отработает (warm-up 3 мин после boot, далее каждые 6ч MSK).
// Лимитер НЕ ставим: read-only O(1) чтение из in-memory Map, нагрузки 0.
//
// Сравнение с соседними эндпоинтами:
//   /api/public/summary-global      — гость, 404 если нет кэша, без auth
//   /api/user/summary-global        — auth, может триггерить LLM (refresh=true)
//   /api/user/summary-global/cached — auth, только кэш, 204 если нет
router.get(
  '/summary-global/cached',
  authMiddleware,
  async (_req: AuthRequest, res) => {
    const cached = getCachedGlobalSummary();
    if (!cached) {
      res.status(204).end(); // «кэша нет, но это не ошибка» — фронт ретраит
      return;
    }
    res.json({
      summary: cached.summary,
      generated_at: cached.generatedAt,
      articles_count: cached.articlesCount,
    });
  }
);

export default router;
