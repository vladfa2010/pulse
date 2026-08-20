/**
 * Public market-data routes (no admin required).
 * Used by the news card price-reaction chart.
 */

import { Router, type Response } from 'express';
import { query } from '../config/db';
import * as marketRouter from '../services/market/marketRouter';
import type { MarketCandle } from '../services/market/utils';
import {
  micTimezone,
  dateInTz,
  addDays,
} from '../services/market/exchangeTimezones';

const router = Router();

const NEWS_CHART_CACHE_TODAY_MS = 60 * 1000;
const NEWS_CHART_CACHE_PAST_MS = 24 * 3600 * 1000;
const NEWS_CHART_CACHE_EMPTY_MS = 15 * 60 * 1000;
const NEWS_CHART_CACHE_MAX_SIZE = 5000;

const newsChartCache = new Map<string, { at: number; ttl: number; payload: any }>();

function evictNewsChartCache(): void {
  if (newsChartCache.size <= NEWS_CHART_CACHE_MAX_SIZE) return;
  const entries = [...newsChartCache.entries()].sort((a, b) => a[1].at - b[1].at);
  const toRemove = entries.slice(0, Math.ceil(entries.length * 0.2));
  for (const [key] of toRemove) {
    newsChartCache.delete(key);
  }
}

function getNewsChartCacheTtl(payload: { instruments: InstrumentChart[] }): number {
  const nowIso = new Date().toISOString();
  const hasTodayUnshifted = payload.instruments.some(
    (ins) => !ins.shifted && ins.date === dateInTz(nowIso, ins.timezone)
  );
  if (hasTodayUnshifted) return NEWS_CHART_CACHE_TODAY_MS;
  if (payload.instruments.length === 0) return NEWS_CHART_CACHE_EMPTY_MS;
  return NEWS_CHART_CACHE_PAST_MS;
}

function cacheAndSend(newsId: string, payload: { published_at: string; instruments: InstrumentChart[] }, res: Response) {
  evictNewsChartCache();
  const ttl = getNewsChartCacheTtl(payload);
  newsChartCache.set(newsId, { at: Date.now(), ttl, payload });
  res.setHeader('X-Cache', 'miss');
  return res.json(payload);
}

interface InstrumentChart {
  tag_id: string;
  tag_name: string;
  symbol: string;
  date: string;
  shifted: boolean;
  timezone: string;
  exchange_mic: string;
  exchange_name: string;
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
 *
 * Timezone-aware: dates and axis labels use the exchange's own timezone.
 */
router.get('/news-chart', async (req, res) => {
  try {
    const newsId = req.query.news_id as string;
    if (!newsId) {
      return res.status(400).json({ error: 'news_id required' });
    }

    const cached = newsChartCache.get(newsId);
    if (cached && Date.now() - cached.at < cached.ttl) {
      res.setHeader('X-Cache', 'hit');
      return res.json(cached.payload);
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
      return cacheAndSend(newsId, { published_at, instruments: [] }, res);
    }

    const [tagRes, exchangeList] = await Promise.all([
      query(
        'SELECT tag_id, tag_name, enriched_data FROM user_defined_tags WHERE tag_id = ANY($1::text[])',
        [matched_tags]
      ),
      marketRouter.getExchanges(),
    ]);

    const exchangeNameByMic = new Map<string, string>();
    for (const e of exchangeList) {
      exchangeNameByMic.set(e.mic.toUpperCase(), e.name);
    }

    const instrumentByTagId = new Map<string, InstrumentChart>();

    const order = new Map(matched_tags.map((id: string, i: number) => [id, i]));
    tagRes.rows.sort((a: any, b: any) => ((order.get(a.tag_id) ?? 1e9) as number) - ((order.get(b.tag_id) ?? 1e9) as number));

    for (const tag of tagRes.rows) {
      if (instrumentByTagId.size >= 3) break; // TZ-3.4: не ходим в Finam за тем, что выбросим
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
      let exchangeMic: string;
      if (symbol) {
        const parts = symbol.split('@');
        if (parts.length !== 2) continue;
        resolvedTicker = parts[0];
        exchangeMic = parts[1];
      } else {
        resolvedTicker = ticker;
        exchangeMic = mic;
      }

      const tz = micTimezone(exchangeMic);
      const pubDate = dateInTz(published_at, tz);
      let chartDate = pubDate;
      let shifted = false;

      let candles: { candles: MarketCandle[]; provider: 'finam' };
      try {
        candles = await marketRouter.getIntraday5min(exchangeMic, resolvedTicker, chartDate);
      } catch (err: any) {
        if (err.code === 'finam_not_found') {
          continue;
        }
        throw err;
      }

      if (candles.candles.length === 0) {
        // Find nearest trading day: prefer previous session (reaction already happened),
        // then next session. Covers weekends, holidays, and pre-market morning news.
        const daily = await marketRouter.getDailyCandles(exchangeMic, resolvedTicker, 15);
        const dailyMap = new Map(daily.candles.map((c) => [c.time.slice(0, 10), c]));

        let nearestDate: string | null = null;
        for (let i = 1; i <= 5; i++) {
          const d = addDays(pubDate, -i);
          if (dailyMap.has(d)) {
            nearestDate = d;
            break;
          }
        }
        if (!nearestDate) {
          for (let i = 1; i <= 5; i++) {
            const d = addDays(pubDate, i);
            if (dailyMap.has(d)) {
              nearestDate = d;
              break;
            }
          }
        }

        if (nearestDate) {
          candles = await marketRouter.getIntraday5min(exchangeMic, resolvedTicker, nearestDate);
          chartDate = nearestDate;
          shifted = true;
        }
      }

      if (candles.candles.length === 0) {
        continue;
      }

      const normalizedMic = exchangeMic.toUpperCase();
      instrumentByTagId.set(tag.tag_id, {
        tag_id: tag.tag_id,
        tag_name: tag.tag_name,
        symbol: symbol || `${resolvedTicker}@${exchangeMic}`,
        date: chartDate,
        shifted,
        timezone: tz,
        exchange_mic: exchangeMic,
        exchange_name: exchangeNameByMic.get(normalizedMic) || exchangeMic,
        times: candles.candles.map((c) => c.time),
        ohlc: candles.candles.map((c) => [c.open, c.close, c.low, c.high]),
        volumes: candles.candles.map((c) => c.volume ?? 0),
      });
    }

    // Preserve matched_tags order and limit to 3.
    // Map preserves insertion order after the sort above; break already limited size to 3.
    const instruments = [...instrumentByTagId.values()];

    return cacheAndSend(newsId, { published_at, instruments }, res);
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
