/**
 * =============================================================================
 * PULSE — Admin: MP3-кеш радио (ТЗ-65)
 * =============================================================================
 *
 * Dashboard-ендпоинты для админ-таба «Радио» (frontend: Mp3CacheDashboard).
 * Все под adminMiddleware (admin.ts, НЕ middleware/auth.ts — исторический
 * паттерн админки). In-memory данные — 1 инстанс VDS, без БД.
 *
 *   GET  /api/admin/radio/mp3-cache/stats      — live метрики + hit rate
 *   GET  /api/admin/radio/mp3-cache/history    — ring buffer за 24ч (графики)
 *   GET  /api/admin/radio/mp3-cache/top-keys   — top-N текстов по hit count
 *   POST /api/admin/radio/mp3-cache/clear      — poison recovery
 *   POST /api/admin/radio/mp3-cache/prewarm    — прогрев стандартных сегментов
 *                                                + диалога сводки
 */

import { Router } from 'express';
import { adminMiddleware } from './admin';
import type { AuthRequest } from '../middleware/auth';
import { getRadioTtsMetrics } from '../services/radioMetrics';
import {
  getRadioMp3CacheStats,
  clearRadioMp3Cache,
  getTopKeys,
} from '../services/radioMp3Cache';
import { getHistory } from '../services/radioMp3CacheHistory';
import { prewarmCommonSegments } from '../services/radioMp3CachePrewarm';

const router = Router();

// GET /api/admin/radio/mp3-cache/stats — live метрики
router.get('/stats', adminMiddleware, async (_req: AuthRequest, res) => {
  try {
    const cache = getRadioMp3CacheStats();
    const tts = getRadioTtsMetrics();
    const total = tts.cache_hit + tts.cache_miss;
    const hitRate = total > 0 ? Math.round((tts.cache_hit / total) * 1000) / 10 : 0;
    res.json({ cache, tts, hitRate });
  } catch (err: any) {
    console.error('[AdminRadioCache] stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch cache stats' });
  }
});

// GET /api/admin/radio/mp3-cache/history — snapshot'ы за 24ч
router.get('/history', adminMiddleware, async (_req: AuthRequest, res) => {
  try {
    res.json({ snapshots: getHistory() });
  } catch (err: any) {
    console.error('[AdminRadioCache] history error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// GET /api/admin/radio/mp3-cache/top-keys?limit=10
router.get('/top-keys', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '10'), 10) || 10, 100);
    res.json({ topKeys: getTopKeys(limit) });
  } catch (err: any) {
    console.error('[AdminRadioCache] top-keys error:', err.message);
    res.status(500).json({ error: 'Failed to fetch top keys' });
  }
});

// POST /api/admin/radio/mp3-cache/clear — poison recovery за 1 клик
router.post('/clear', adminMiddleware, async (req: AuthRequest, res) => {
  try {
    const before = getRadioMp3CacheStats();
    clearRadioMp3Cache();
    console.log(`[AdminRadioCache] cleared by admin ${req.user?.userId}: ${before.entries} entries, ${before.bytes} bytes`);
    res.json({
      success: true,
      cleared: {
        entriesBefore: before.entries,
        bytesBefore: before.bytes,
        at: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    console.error('[AdminRadioCache] clear error:', err.message);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// POST /api/admin/radio/mp3-cache/prewarm
router.post('/prewarm', adminMiddleware, async (_req: AuthRequest, res) => {
  try {
    const result = await prewarmCommonSegments();
    console.log(`[AdminRadioCache] prewarm: ${result.ok} ok, ${result.skipped} skipped, ${result.errors} errors (${result.segments} segments)`);
    res.json({ success: true, ...result, at: new Date().toISOString() });
  } catch (err: any) {
    console.error('[AdminRadioCache] prewarm error:', err.message);
    res.status(500).json({ error: 'Failed to prewarm cache' });
  }
});

export default router;
