import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { globalSummaryRefreshLimiter } from '../middleware/rateLimit';
import { generateGlobalSummary } from '../services/globalSummary';

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
      });
    } catch (err: any) {
      console.error('[GlobalSummaryRoute] Error:', err.message);
      res.status(500).json({ error: 'Failed to generate global summary' });
    }
  }
);

export default router;
