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
import {
  getDailyCandles,
  getIntraday5min,
  getProvidersInfo,
  getExchanges,
  invalidateAssetsCache,
} from '../services/market/marketRouter';
import * as finamMarketAdapter from '../services/market/finamMarketAdapter';
import { hasFinamKey, isInMaintenanceWindow } from '../services/market/finamAuth';
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

router.get('/exchanges', adminMiddleware, async (_req, res) => {
  try {
    const exchanges = await getExchanges();
    res.json({ exchanges });
  } catch (err: any) {
    sendMarketError(res, err);
  }
});

router.get('/providers', adminMiddleware, async (_req, res) => {
  const info = getProvidersInfo();
  res.json({
    providers: [
      {
        id: 'finam',
        name: 'Finam Trade API',
        role: 'primary',
        exchanges: info.primary.map((p) => p.exchange),
        auth: { type: 'service_key', configured: hasFinamKey() },
        maintenance: isInMaintenanceWindow(),
        docs: 'docs/market-data.md',
      },
      {
        id: 'moex-iss',
        name: 'MOEX ISS',
        role: 'disabled',
        exchanges: ['MOEX'],
        auth: { type: 'anonymous', configured: true },
        maintenance: false,
        docs: 'https://iss.moex.com/iss/reference/',
      },
    ],
    supportedExchanges: info.supportedExchanges,
  });
});

router.get('/providers/status', adminMiddleware, async (_req, res) => {
  async function probe(fn: () => Promise<any>): Promise<{ ok: boolean; ms: number; error?: string }> {
    const t0 = Date.now();
    try {
      await fn();
      return { ok: true, ms: Date.now() - t0 };
    } catch (err: any) {
      return { ok: false, ms: Date.now() - t0, error: err.message };
    }
  }

  const finam = hasFinamKey()
    ? isInMaintenanceWindow()
      ? { ok: true, ms: 0, error: 'maintenance window 05:00–06:15 MSK (ожидаемо)' }
      : await probe(() => finamMarketAdapter.getCurrentPrice('SBER', 'MOEX'))
    : { ok: false, ms: 0, error: 'FINAM_MARKET_SECRET not set' };

  res.json({ checkedAt: new Date().toISOString(), finam });
});

router.get('/test', adminMiddleware, async (req, res) => {
  const ticker = String(req.query.ticker || '').trim().toUpperCase();
  const exchange = String(req.query.exchange || 'MOEX').trim().toUpperCase();
  const tf = String(req.query.tf || 'daily');
  if (!ticker) return res.status(400).json({ error: 'ticker is required' });

  const t0 = Date.now();
  try {
    if (tf === 'm5') {
      let date = String(req.query.date || '');
      if (!date) {
        const d = await getDailyCandles(exchange, ticker, 10);
        if (d.candles.length === 0) {
          return res.json({
            ticker,
            exchange,
            tf,
            provider: d.provider,
            ms: Date.now() - t0,
            candles: 0,
            hint: 'Пусто — тикер валиден, но в интервале нет торгов (выходные/приостановка). Несуществующий тикер Finam вернул бы 404.',
          });
        }
        date = d.candles[d.candles.length - 1].time.slice(0, 10);
      }
      const r = await getIntraday5min(exchange, ticker, date);
      return res.json({
        ticker,
        exchange,
        tf,
        date,
        provider: r.provider,
        ms: Date.now() - t0,
        candles: r.candles.length,
        first: r.candles[0] ?? null,
        last: r.candles[r.candles.length - 1] ?? null,
      });
    }
    const r = await getDailyCandles(exchange, ticker, 30);
    res.json({
      ticker,
      exchange,
      tf,
      provider: r.provider,
      ms: Date.now() - t0,
      candles: r.candles.length,
      first: r.candles[0] ?? null,
      last: r.candles[r.candles.length - 1] ?? null,
      hint:
        r.candles.length === 0
          ? 'Пусто — тикер валиден, но в интервале нет торгов (выходные/приостановка). Несуществующий тикер Finam вернул бы 404.'
          : undefined,
    });
  } catch (err: any) {
    sendMarketError(res, err);
  }
});

router.get('/resolve', adminMiddleware, async (req, res) => {
  const ticker = String(req.query.ticker || '').trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'ticker is required' });
  try {
    const matches = await finamMarketAdapter.resolveTicker(ticker);
    res.json({ ticker, count: matches.length, matches });
  } catch (err: any) {
    sendMarketError(res, err);
  }
});

router.post('/cache/invalidate', adminMiddleware, async (_req, res) => {
  invalidateAssetsCache();
  res.json({ ok: true });
});

export default router;
