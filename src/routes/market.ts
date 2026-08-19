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

import { Router, Response } from 'express';
import { adminMiddleware } from './admin';
import { getDailyCandles, getIntraday5min } from '../services/market/marketRouter';
import { formatMskLocal } from '../services/market/utils';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function sendMarketError(res: Response, err: any): void {
  const byCode: Record<string, { status: number; text: string }> = {
    finam_no_key: { status: 503, text: 'Маркет-данные не настроены на сервере (нет ключа)' },
    finam_auth_failed: { status: 503, text: 'Ошибка авторизации в источнике данных' },
    finam_rate_limited: { status: 503, text: 'Превышен лимит запросов к источнику, попробуйте позже' },
    finam_maintenance: { status: 503, text: 'Источник данных на техобслуживании (05:00–06:15 МСК)' },
    finam_not_found: { status: 404, text: err?.message || 'Инструмент не найден' },
    finam_bad_exchange: { status: 400, text: err?.message || 'Биржа не поддерживается' },
  };
  if (err?.message?.includes('not found')) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err?.message?.includes('not supported')) {
    res.status(400).json({ error: err.message });
    return;
  }
  const m = err?.code ? byCode[err.code] : undefined;
  if (m) {
    res.status(m.status).json({ error: m.text, code: err.code });
    return;
  }
  res.status(502).json({ error: err?.message || 'Failed to fetch market data' });
}

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

    const { candles, provider } = await getDailyCandles(exchange, ticker, days);
    console.log(`[Market] candles_daily response for ${ticker}: ${candles.length} candles`);

    const fullDates = candles.map((c) => formatMskLocal(new Date(c.time)).slice(0, 10));
    const dayLabels = fullDates.map((d) => d.slice(5));
    const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high]);
    const volumes = candles.map((c) => c.volume ?? 0);

    res.json({
      ticker,
      exchange,
      provider,
      days,
      days_labels: dayLabels,
      full_dates: fullDates,
      ohlc,
      volumes,
    });
  } catch (err: any) {
    console.error('[Market] candles_daily error:', err.message);
    sendMarketError(res, err);
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

    const { candles, provider } = await getIntraday5min(exchange, ticker, date);

    const times = candles.map((c) => formatMskLocal(new Date(c.time)).slice(11, 16));
    const ohlc = candles.map((c) => [c.open, c.close, c.low, c.high]);
    const volumes = candles.map((c) => c.volume ?? 0);

    res.json({
      ticker,
      exchange,
      provider,
      date,
      times,
      ohlc,
      volumes,
    });
  } catch (err: any) {
    console.error('[Market] candles_intraday error:', err.message);
    sendMarketError(res, err);
  }
});

export default router;
