/**
 * =============================================================================
 * PULSE — News heatmap routes (TZ 11.11)
 * =============================================================================
 *
 * Public endpoint for guests (scope=all) and authenticated endpoints
 * for portfolio / per-tag views.
 *
 *   GET /api/news_heatmap?scope=portfolio|tag|all&scale=year|day|day_hours&...
 *   GET /api/news_heatmap/candles?tag_id=...|index=IMOEX|SPY
 */

import { Router, type Response, type NextFunction } from 'express';
import { query } from '../config/db';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import * as marketRouter from '../services/market/marketRouter';
import { sendMarketError } from '../services/market/sendMarketError';
import {
  DEFAULT_TZ,
  WEEKS,
  Scope,
  HeatmapCell,
  portfolioKey,
  quantile,
  spikeThreshold,
} from '../services/heatmap/utils';
import {
  getYearCells,
  getTagMiniGrids,
  TagMiniGrid,
  ensurePortfolioHistoryFresh,
  getCached,
  setCached,
} from '../services/heatmapDaily';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Instrument {
  ticker: string;
  mic: string;
  symbol: string;
}

const INDEX_SYMBOLS: Record<string, Instrument> = {
  IMOEX: { ticker: 'IMOEX', mic: 'MISX', symbol: 'IMOEX@MISX' },
  SPY: { ticker: 'SPY', mic: 'XNGS', symbol: 'SPY@XNGS' },
};

async function resolveTagInstrument(tagId: string): Promise<Instrument | null> {
  const tagRes = await query(
    `SELECT enriched_data FROM user_defined_tags WHERE tag_id = $1`,
    [tagId.toLowerCase()]
  );
  if (tagRes.rows.length === 0) return null;

  let enrichedData = tagRes.rows[0].enriched_data;
  if (typeof enrichedData === 'string') {
    try { enrichedData = JSON.parse(enrichedData); } catch { enrichedData = {}; }
  }
  if (!enrichedData || typeof enrichedData !== 'object') {
    enrichedData = {};
  }

  const symbol = enrichedData.symbol || null;
  const ticker = enrichedData.ticker || null;
  const mic = enrichedData.mic || null;
  const exchange = enrichedData.exchange || null;

  if (symbol) {
    const parts = symbol.split('@');
    if (parts.length === 2) {
      return { ticker: parts[0], mic: parts[1], symbol };
    }
  }

  if (ticker && mic) {
    return { ticker, mic, symbol: `${ticker}@${mic}` };
  }

  if (ticker && exchange) {
    // Map our exchange aliases to Finam MICs.
    const aliasToMic: Record<string, string> = {
      moex: 'MISX',
      nasdaq: 'XNGS',
      nyse: 'XNYS',
    };
    const resolvedMic = aliasToMic[exchange.toLowerCase()] || exchange;
    return { ticker, mic: resolvedMic, symbol: `${ticker}@${resolvedMic}` };
  }

  return null;
}

// scope=all is public; other scopes require authentication.
function maybeAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  if (req.query.scope === 'all') {
    next();
    return;
  }
  authMiddleware(req, res, next);
}

/**
 * GET /api/news_heatmap?scope=portfolio|tag|all&scale=year|day|day_hours&date=YYYY-MM-DD&tag_id=...
 */
router.get('/', maybeAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.userId ?? 'guest';
    const scope = (req.query.scope === 'tag'
      ? 'tag'
      : req.query.scope === 'all'
        ? 'all'
        : 'portfolio') as Scope;
    const tagId = (req.query.tag_id as string || '').trim();
    const scale = (['day', 'day_hours'].includes(req.query.scale as string)
      ? req.query.scale
      : 'year') as 'year' | 'day' | 'day_hours';
    const date = (req.query.date as string || '').trim();

    if (scope === 'tag' && !tagId) {
      return res.status(400).json({ error: 'tag_id is required for scope=tag' });
    }
    if (scale === 'day' && !DATE_RE.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }

    const tz = DEFAULT_TZ;
    const cacheKey = scope === 'all'
      ? `all|${scale}|${date}`
      : `${userId}|${scope}|${tagId}|${tz}|${scale}|${date}`;
    const hit = getCached(cacheKey);
    if (hit) {
      res.setHeader('X-Cache', 'hit');
      return res.json(hit);
    }

    let payload: any;

    if (scale === 'year') {
      const { cells, frozenThrough } = await getYearCells(scope, userId, tagId, tz);

      const nonzero = cells.filter((c) => c.stories > 0).map((c) => c.stories).sort((a, b) => a - b);
      const quantiles = [quantile(nonzero, 0.5), quantile(nonzero, 0.75), quantile(nonzero, 0.9)];

      const last90 = cells.slice(-90).map((c) => c.stories);
      const thr = spikeThreshold(last90);
      for (const c of cells) {
        if (c.stories >= thr && c.stories > 0) c.spike = true;
      }

      const instrument = scope === 'tag' ? await resolveTagInstrument(tagId) : null;

      payload = {
        cells,
        quantiles,
        instrument,
        meta: {
          generated_at: new Date().toISOString(),
          stale: false,
          tz,
          empty: cells.length === 0,
          frozen_through: frozenThrough,
        },
      };
    } else {
      // scale=day or scale=day_hours: read live from news table.
      const s = scale === 'day'
        ? await import('../services/heatmapDaily').then((m) => m.sqlDay(scope))
        : await import('../services/heatmapDaily').then((m) => m.sqlDayHours(scope));

      const USE_SQLITE = process.env.USE_SQLITE === 'true';
      const scopeParam = scope === 'tag' ? tagId : userId;

      const params = scale === 'day'
        ? (scope === 'all'
            ? (USE_SQLITE ? [date] : [tz, date])
            : (USE_SQLITE ? [date, scopeParam] : [tz, date, scopeParam]))
        : (scope === 'all'
            ? (USE_SQLITE ? [] : [tz])
            : (USE_SQLITE ? [scopeParam] : [tz, scopeParam]));

      const r = await query(USE_SQLITE ? s.lite : s.pg, params);

      if (scale === 'day') {
        payload = {
          date,
          stories: (r.rows || []).map((row: any) => ({
            id: row.id,
            title: row.title_ru,
            summary: row.summary_ru,
            source: row.source,
            url: row.url,
            published_at: row.published_at,
            sentiment: row.sentiment,
            source_count: Number(row.source_count ?? 1),
            matched_tags: row.matched_tags,
          })),
          meta: { generated_at: new Date().toISOString(), stale: false, tz },
        };
      } else {
        payload = {
          days: 14,
          cells: (r.rows || []).map((row: any) => ({
            day: row.day,
            hour: Number(row.hour),
            stories: Number(row.stories),
          })),
          meta: { generated_at: new Date().toISOString(), stale: false, tz },
        };
      }
    }

    // Year payload cached briefly (today is live); day/day_hours cached a bit longer.
    const ttlMs = scale === 'year' ? 5 * 60 * 1000 : 15 * 60 * 1000;
    setCached(cacheKey, payload, ttlMs);
    res.setHeader('X-Cache', 'miss');
    return res.json(payload);
  } catch (err: any) {
    console.error('[NewsHeatmap] route error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err?.message });
  }
});

/**
 * GET /api/news_heatmap/candles?tag_id=SBER
 * GET /api/news_heatmap/candles?index=IMOEX|SPY
 */
/**
 * GET /api/news_heatmap/mini-grids?tag_ids=SBER,AAPL,...
 *
 * Per-tag mini year grids for the portfolio block (TZ 11.11 §4.4).
 */
router.get('/mini-grids', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const raw = (req.query.tag_ids as string || '').trim();
    const tagIds = raw
      ? raw.split(',').map((t) => t.trim()).filter(Boolean)
      : [];

    if (tagIds.length === 0) {
      return res.status(400).json({ error: 'tag_ids is required' });
    }

    const grids = await getTagMiniGrids(userId, tagIds);
    const payload = Array.from(grids.values()).map((g: TagMiniGrid) => ({
      tag_id: g.tagId,
      cells: g.cells,
      quantiles: g.quantiles,
    }));

    return res.json({ grids: payload });
  } catch (err: any) {
    console.error('[NewsHeatmap] mini-grids error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err?.message });
  }
});

router.get('/candles', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const index = (req.query.index as string || '').trim().toUpperCase();
    const tagId = (req.query.tag_id as string || '').trim();

    let instrument: Instrument | null = null;
    if (index) {
      instrument = INDEX_SYMBOLS[index] || null;
      if (!instrument) {
        return res.status(400).json({ error: 'index must be IMOEX or SPY' });
      }
    } else if (tagId) {
      instrument = await resolveTagInstrument(tagId);
    } else {
      return res.status(400).json({ error: 'tag_id or index is required' });
    }

    if (!instrument) {
      return res.status(404).json({ error: 'No instrument attached to tag', code: 'no_instrument' });
    }

    const { candles, provider } = await marketRouter.getWeeklyCandles(instrument.mic, instrument.ticker, WEEKS);

    return res.json({
      ticker: instrument.ticker,
      exchange: instrument.mic,
      symbol: instrument.symbol,
      provider,
      weeks: WEEKS,
      full_dates: candles.map((c) => c.time.slice(0, 10)),
      ohlc: candles.map((c) => [c.open, c.close, c.low, c.high]),
      volumes: candles.map((c) => c.volume ?? 0),
    });
  } catch (err: any) {
    console.error('[NewsHeatmap] candles error:', err.message);
    return sendMarketError(res, err);
  }
});

export default router;
