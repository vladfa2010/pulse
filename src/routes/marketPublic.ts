/**
 * Public market-data routes (no admin required).
 * Used by the news card price-reaction chart.
 */

import { Router } from 'express';
import { query } from '../config/db';
import * as marketRouter from '../services/market/marketRouter';
import type { MarketCandle } from '../services/market/utils';

const router = Router();

function toMskDate(iso: string): string {
  const d = new Date(iso);
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);
  return msk.toISOString().slice(0, 10);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00+03:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

interface InstrumentChart {
  tag_id: string;
  tag_name: string;
  symbol: string;
  date: string;
  shifted: boolean;
  times: string[];
  ohlc: number[][];
  volumes: number[];
}

/**
 * GET /api/market/news-chart?news_id=...
 *
 * Returns 5-minute candles for the trading day of the news publication,
 * for up to 3 tags that have an instrument attached.
 * If the news was published outside trading hours, finds the nearest
 * trading day and marks the chart as shifted.
 */
router.get('/news-chart', async (req, res) => {
  try {
    const newsId = req.query.news_id as string;
    if (!newsId) {
      return res.status(400).json({ error: 'news_id required' });
    }

    const newsRes = await query(
      'SELECT published_at, matched_tags FROM news WHERE id = $1',
      [newsId]
    );

    if (newsRes.rows.length === 0) {
      return res.status(404).json({ error: 'News not found' });
    }

    const { published_at, matched_tags } = newsRes.rows[0];

    if (!matched_tags || matched_tags.length === 0) {
      return res.json({ published_at, instruments: [] });
    }

    const tagRes = await query(
      'SELECT tag_id, tag_name, enriched_data FROM user_defined_tags WHERE tag_id = ANY($1::text[])',
      [matched_tags]
    );

    const instrumentByTagId = new Map<string, InstrumentChart>();

    for (const tag of tagRes.rows) {
      let enrichedData = tag.enriched_data;
      if (typeof enrichedData === 'string') {
        try { enrichedData = JSON.parse(enrichedData); } catch { enrichedData = {}; }
      }
      if (!enrichedData || typeof enrichedData !== 'object') {
        enrichedData = {};
      }

      const symbol = enrichedData.symbol || null;
      const ticker = enrichedData.ticker || null;
      const mic = enrichedData.mic || null;

      if (!symbol && !(ticker && mic)) {
        continue;
      }

      let resolvedTicker: string;
      let exchange: string;
      if (symbol) {
        const parts = symbol.split('@');
        if (parts.length !== 2) continue;
        resolvedTicker = parts[0];
        exchange = parts[1];
      } else {
        resolvedTicker = ticker;
        exchange = mic;
      }

      const pubDate = toMskDate(published_at);
      let chartDate = pubDate;
      let shifted = false;

      let candles: { candles: MarketCandle[]; provider: 'finam' };
      try {
        candles = await marketRouter.getIntraday5min(exchange, resolvedTicker, chartDate);
      } catch (err: any) {
        if (err.code === 'finam_not_found') {
          continue;
        }
        throw err;
      }

      if (candles.candles.length === 0) {
        // Find nearest trading day: prefer next session, then previous.
        const daily = await marketRouter.getDailyCandles(exchange, resolvedTicker, 15);
        const dailyMap = new Map(daily.candles.map((c) => [c.time.slice(0, 10), c]));

        let nearestDate: string | null = null;
        for (let i = 1; i <= 5; i++) {
          const d = addDays(pubDate, i);
          if (dailyMap.has(d)) {
            nearestDate = d;
            break;
          }
        }
        if (!nearestDate) {
          for (let i = 1; i <= 5; i++) {
            const d = addDays(pubDate, -i);
            if (dailyMap.has(d)) {
              nearestDate = d;
              break;
            }
          }
        }

        if (nearestDate) {
          candles = await marketRouter.getIntraday5min(exchange, resolvedTicker, nearestDate);
          chartDate = nearestDate;
          shifted = true;
        }
      }

      if (candles.candles.length === 0) {
        continue;
      }

      instrumentByTagId.set(tag.tag_id, {
        tag_id: tag.tag_id,
        tag_name: tag.tag_name,
        symbol: symbol || `${resolvedTicker}@${exchange}`,
        date: chartDate,
        shifted,
        times: candles.candles.map((c) => c.time),
        ohlc: candles.candles.map((c) => [c.open, c.close, c.low, c.high]),
        volumes: candles.candles.map((c) => c.volume ?? 0),
      });
    }

    // Preserve matched_tags order and limit to 3.
    const instruments: InstrumentChart[] = [];
    for (const tagId of matched_tags) {
      const ins = instrumentByTagId.get(tagId);
      if (ins) {
        instruments.push(ins);
        if (instruments.length >= 3) break;
      }
    }

    return res.json({ published_at, instruments });
  } catch (err: any) {
    if (
      err.code === 'finam_no_key' ||
      err.code === 'finam_maintenance' ||
      err.code === 'finam_auth_failed' ||
      err.code === 'finam_rate_limited'
    ) {
      return res.status(503).json({ error: 'market_unavailable' });
    }

    console.error('[marketPublic] news-chart error:', err.message);
    return res.status(500).json({ error: 'market_unavailable' });
  }
});

export default router;
