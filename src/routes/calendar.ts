/**
 * =============================================================================
 * PULSE — Investor Calendar routes
 * =============================================================================
 *
 * Public: GET /api/calendar
 */

import { Router } from 'express';
import { getCalendarData, isCalendarNotLoadedError } from '../services/calendar';

const router = Router();

// GET /api/calendar — public, no auth
router.get('/', async (_req, res) => {
  try {
    const data = await getCalendarData();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err: any) {
    if (isCalendarNotLoadedError(err)) {
      return res.status(503).json({ error: 'calendar_not_loaded' });
    }
    console.error('[Calendar] Failed to fetch calendar:', err.message);
    res.status(500).json({ error: 'Failed to fetch calendar' });
  }
});

export default router;
