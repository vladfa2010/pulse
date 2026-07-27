/**
 * =============================================================================
 * PULSE — Admin market data routes
 * =============================================================================
 *
 * Mounted at /admin/market in index.ts.
 *
 * Endpoints:
 *   GET /admin/market/candles_daily
 *   GET /admin/market/candles_intraday
 */

import { Router } from 'express';
import { adminMiddleware } from './admin';
import { getDailyCandles, getIntraday5min } from '../services/market/marketRouter';
import { formatMskLocal } from '../services/market/utils';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/candles_daily', adminMiddleware, async (req, res) => {
  try {
    const ticker = (req.query.ticker as string || '').trim().toUpperCase();
    const exchange = (req.query.exchange as string || req.query.provider as string || 'MOEX').trim().toUpperCase();
    let days = parseInt(req.query.days as string, 10);
    if (isNaN(days) || days <= 0) days = 90;
    days = Math.min(days, 500);

    if (!ticker) {
      return res.status(400).json({ error: 'ticker is required' });
    }

    const candles = await getDailyCandles(exchange, ticker, days);
    console.log(`[Market] candles_daily response for ${ticker}: ${candles.length} candles`);

    const fullDates = candles.map((c) => formatMskLocal(new Date(c.time)).slice(0, 10));
    const dayLabels = fullDates.map((d) => d.slice(5));
    const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high]);
    const volumes = candles.map((c) => c.volume ?? 0);

    res.json({
      ticker,
      exchange,
      provider: 'moex-iss',
      days,
      days_labels: dayLabels,
      full_dates: fullDates,
      ohlc,
      volumes,
    });
  } catch (err: any) {
    console.error('[Market] candles_daily error:', err.message);
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message?.includes('not supported')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(502).json({ error: err.message || 'Failed to fetch market data' });
  }
});

router.get('/candles_intraday', adminMiddleware, async (req, res) => {
  try {
    const ticker = (req.query.ticker as string || '').trim().toUpperCase();
    const exchange = (req.query.exchange as string || req.query.provider as string || 'MOEX').trim().toUpperCase();
    const date = (req.query.date as string || '').trim();

    if (!ticker || !date) {
      return res.status(400).json({ error: 'ticker and date are required' });
    }
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    const candles = await getIntraday5min(exchange, ticker, date);

    const times = candles.map((c) => formatMskLocal(new Date(c.time)).slice(11, 16));
    const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high]);
    const volumes = candles.map((c) => c.volume ?? 0);

    res.json({
      ticker,
      exchange,
      provider: 'moex-iss',
      date,
      times,
      ohlc,
      volumes,
    });
  } catch (err: any) {
    console.error('[Market] candles_intraday error:', err.message);
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: err.message });
    }
    if (err.message?.includes('not supported')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(502).json({ error: err.message || 'Failed to fetch intraday data' });
  }
});

export default router;
