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
  getAssets,
  invalidateAssetsCache,
  getAssetsStatus,
} from '../services/market/marketRouter';
import * as finamMarketAdapter from '../services/market/finamMarketAdapter';
import { hasFinamKey, isInMaintenanceWindow } from '../services/market/finamAuth';
import { formatMskLocal } from '../services/market/utils';
import { MIC_TIMEZONE, getTimezoneWarnings } from '../services/market/exchangeTimezones';
import { sendMarketError } from '../services/market/sendMarketError';

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
        chart: {
          times: r.candles.map((c) => c.time),
          ohlc: r.candles.map((c) => [c.open, c.close, c.low, c.high]),
          volumes: r.candles.map((c) => c.volume ?? 0),
        },
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
      chart: {
        times: r.candles.map((c) => c.time),
        ohlc: r.candles.map((c) => [c.open, c.close, c.low, c.high]),
        volumes: r.candles.map((c) => c.volume ?? 0),
      },
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

router.get('/search', adminMiddleware, async (req, res) => {
  const q = String(req.query.q || '').trim();
  const qUpper = q.toUpperCase();
  if (qUpper.length < 2) return res.json({ q: qUpper, count: 0, matches: [] });

  try {
    const assets = await getAssets();
    const qRu = q.toLowerCase();

    // ISIN is the most precise identifier; detect short ISIN prefixes like RU0009.
    const isIsinQuery = /^[A-Z]{2}[A-Z0-9]{0,10}$/.test(qUpper) && /[0-9]/.test(qUpper);

    const isinMatch: any[] = [];
    const starts: any[] = [];
    const contains: any[] = [];
    const nameMatch: any[] = [];

    for (const a of assets) {
      if (a.is_archived) continue;
      const t = String(a.ticker || '').toUpperCase();
      const nm = String(a.name || '').toLowerCase();
      if (isIsinQuery && String(a.isin || '').toUpperCase().startsWith(qUpper)) {
        isinMatch.push(a);
        continue;
      }
      if (t.startsWith(qUpper)) starts.push(a);
      else if (t.includes(qUpper)) contains.push(a);
      else if (qRu.length >= 3 && nm.includes(qRu)) nameMatch.push(a);
      if (starts.length >= 15) break;
    }

    const matches = [...isinMatch, ...starts, ...contains, ...nameMatch]
      .slice(0, 15)
      .map((a: any) => ({ symbol: a.symbol, mic: a.mic, ticker: a.ticker, name: a.name, type: a.type, isin: a.isin }));

    res.json({ q: qUpper, count: matches.length, matches });
  } catch (err: any) {
    sendMarketError(res, err);
  }
});

router.get('/assets/status', adminMiddleware, (_req, res) => {
  res.json(getAssetsStatus());
});

router.post('/cache/invalidate', adminMiddleware, async (_req, res) => {
  invalidateAssetsCache();
  res.json({ ok: true, status: getAssetsStatus() });
});

/**
 * GET /admin/market/timezones
 * All Finam exchanges with configured timezone + fallback warnings (TZ-3.1).
 */
router.get('/timezones', adminMiddleware, async (_req, res) => {
  try {
    const exchanges = await getExchanges();
    const rows = exchanges.map((e) => ({
      mic: e.mic,
      name: e.name,
      timezone: MIC_TIMEZONE[e.mic.toUpperCase()] ?? null,
      covered: !!MIC_TIMEZONE[e.mic.toUpperCase()],
    }));
    res.json({ rows, warnings: getTimezoneWarnings() });
  } catch (err: any) {
    sendMarketError(res, err);
  }
});

export default router;
