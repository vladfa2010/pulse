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

    const instruments = await buildInstrumentsForTags(matched_tags, published_at);

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

/**
 * Построение свечных инструментов для списка тегов (до 3 с инструментом),
 * якорь — published_at. Переиспользуется news-chart (ТЗ-3) и cascade-chart
 * (ТЗ-92, задача 6). Логика без изменений: сдвиг к ближайшему торговому дню,
 * таймзона биржи, provider finam.
 */
async function buildInstrumentsForTags(matchedTags: string[], publishedAt: string): Promise<InstrumentChart[]> {
  const [tagRes, exchangeList] = await Promise.all([
    query(
      'SELECT tag_id, tag_name, enriched_data FROM user_defined_tags WHERE tag_id = ANY($1::text[])',
      [matchedTags]
    ),
    marketRouter.getExchanges(),
  ]);

  const exchangeNameByMic = new Map<string, string>();
  for (const e of exchangeList) {
    exchangeNameByMic.set(e.mic.toUpperCase(), e.name);
  }

  const instrumentByTagId = new Map<string, InstrumentChart>();

  const order = new Map(matchedTags.map((id: string, i: number) => [id, i]));
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
    const pubDate = dateInTz(publishedAt, tz);
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
  return [...instrumentByTagId.values()];
}

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-92, задача 6 — каскады, график каскада, сюжеты (public, кэш по TTL)
// ═══════════════════════════════════════════════════════════════════════════

const CASCADES_CACHE_TTL_MS = 60 * 1000;        // 60 с
const CASCADE_CHART_CACHE_TTL_MS = 15 * 60 * 1000; // 15 мин
const STORIES_CACHE_TTL_MS = 15 * 60 * 1000;    // 15 мин

const cascadesCache = new Map<string, { at: number; payload: any }>();
const cascadeChartCache = new Map<string, { at: number; payload: any }>();
const storiesCache = new Map<string, { at: number; payload: any }>();

function cacheGet(store: Map<string, { at: number; payload: any }>, key: string, ttl: number): any | null {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.payload;
  return null;
}

function cacheSet(store: Map<string, { at: number; payload: any }>, key: string, payload: any): void {
  if (store.size > 2000) store.clear(); // грубая эвикция: данных немного
  store.set(key, { at: Date.now(), payload });
}

const CASCADE_WINDOWS: Record<string, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

/**
 * GET /api/market/cascades?window=24h|7d|30d
 * Кластеры окна с метриками (Методология §7): size, life_min, max_sim,
 * verdict, tags, первая новость. Сортировка size DESC. TTL 60 с.
 */
router.get('/cascades', async (req, res) => {
  try {
    const windowKey = (req.query.window as string) || '24h';
    const interval = CASCADE_WINDOWS[windowKey];
    if (!interval) {
      return res.status(400).json({ error: 'window must be 24h|7d|30d' });
    }

    const cached = cacheGet(cascadesCache, windowKey, CASCADES_CACHE_TTL_MS);
    if (cached) {
      res.setHeader('X-Cache', 'hit');
      return res.json(cached);
    }

    const result = await query(
      `SELECT c.id, c.size, c.max_sim, c.verdict, c.tags, c.source AS cluster_source,
              c.first_published_at, c.last_seen_at, c.story_id,
              EXTRACT(EPOCH FROM (c.last_seen_at - c.first_published_at)) / 60 AS life_min,
              fn.title AS first_title, fn.source AS first_source, fn.url AS first_url,
              fn.published_at AS first_news_at
       FROM clusters c
       LEFT JOIN LATERAL (
         SELECT n.title_ru AS title, n.source, n.url, n.published_at
         FROM cluster_items ci
         JOIN news n ON n.id = ci.news_id
         WHERE ci.cluster_id = c.id
         ORDER BY n.published_at ASC
         LIMIT 1
       ) fn ON true
       WHERE c.last_seen_at > NOW() - INTERVAL '${interval}'
       ORDER BY c.size DESC
       LIMIT 200`,
      []
    );

    const payload = {
      window: windowKey,
      cascades: result.rows.map((r: any) => ({
        cluster_id: r.id,
        size: r.size,
        life_min: r.life_min != null ? Math.round(Number(r.life_min)) : null,
        max_sim: r.max_sim != null ? Number(r.max_sim) : null,
        verdict: r.verdict,
        tags: r.tags || [],
        source: r.cluster_source,
        story_id: r.story_id,
        first_news: r.first_title
          ? { title: r.first_title, source: r.first_source, url: r.first_url, published_at: r.first_news_at }
          : null,
        first_published_at: r.first_published_at,
        last_seen_at: r.last_seen_at,
      })),
    };

    cacheSet(cascadesCache, windowKey, payload);
    res.setHeader('X-Cache', 'miss');
    return res.json(payload);
  } catch (err: any) {
    console.error('[marketPublic] cascades error:', err.message);
    return res.status(500).json({ error: 'cascades_unavailable' });
  }
});

/**
 * GET /api/market/cascade-chart?cluster_id=...
 * Свечи по инструментам тегов кластера (переиспользуем buildInstrumentsForTags:
 * до 3 тегов с инструментом) + метки времени новостей кластера. TTL 15 мин.
 */
router.get('/cascade-chart', async (req, res) => {
  try {
    const clusterId = req.query.cluster_id as string;
    if (!clusterId) {
      return res.status(400).json({ error: 'cluster_id required' });
    }

    const cached = cacheGet(cascadeChartCache, clusterId, CASCADE_CHART_CACHE_TTL_MS);
    if (cached) {
      res.setHeader('X-Cache', 'hit');
      return res.json(cached);
    }

    const clRes = await query(
      'SELECT id, tags, first_published_at, last_seen_at FROM clusters WHERE id = $1',
      [clusterId]
    );
    if (clRes.rows.length === 0) {
      return res.status(404).json({ error: 'Cluster not found' });
    }
    const cluster = clRes.rows[0];
    const anchor: string = cluster.first_published_at || cluster.last_seen_at;

    // Теги кластера: union matched_tags новостей-членов (realtime-кластеры
    // не заполняют clusters.tags), fallback — колонка clusters.tags
    const tagsRes = await query(
      `SELECT DISTINCT unnest(n.matched_tags) AS tag_id
       FROM cluster_items ci
       JOIN news n ON n.id = ci.news_id
       WHERE ci.cluster_id = $1
         AND n.matched_tags IS NOT NULL`,
      [clusterId]
    );
    const tagIds: string[] = tagsRes.rows.map((r: any) => r.tag_id);
    const effectiveTags = tagIds.length > 0 ? tagIds : (cluster.tags || []);

    const instruments = await buildInstrumentsForTags(effectiveTags, anchor);

    const newsRes = await query(
      `SELECT n.published_at, n.title_ru, n.source
       FROM cluster_items ci
       JOIN news n ON n.id = ci.news_id
       WHERE ci.cluster_id = $1
       ORDER BY n.published_at ASC`,
      [clusterId]
    );

    const payload = {
      cluster_id: clusterId,
      published_at: anchor,
      instruments,
      news_markers: newsRes.rows.map((r: any) => ({
        published_at: r.published_at,
        title: r.title_ru,
        source: r.source,
      })),
    };

    cacheSet(cascadeChartCache, clusterId, payload);
    res.setHeader('X-Cache', 'miss');
    return res.json(payload);
  } catch (err: any) {
    if (
      err.code === 'finam_no_key' ||
      err.code === 'finam_maintenance' ||
      err.code === 'finam_auth_failed' ||
      err.code === 'finam_rate_limited'
    ) {
      return res.status(503).json({ error: 'market_unavailable' });
    }
    console.error('[marketPublic] cascade-chart error:', err.message);
    return res.status(500).json({ error: 'market_unavailable' });
  }
});

/**
 * GET /api/market/stories
 * Сюжеты с составом входящих кластеров. TTL 15 мин.
 */
router.get('/stories', async (req, res) => {
  try {
    const cached = cacheGet(storiesCache, 'all', STORIES_CACHE_TTL_MS);
    if (cached) {
      res.setHeader('X-Cache', 'hit');
      return res.json(cached);
    }

    const result = await query(
      `SELECT s.id, s.title, s.summary, s.started_at, s.last_seen_at,
              c.id AS cluster_id, c.size, c.max_sim, c.verdict, c.tags,
              c.first_published_at, c.last_seen_at AS cluster_last_seen_at
       FROM stories s
       LEFT JOIN clusters c ON c.story_id = s.id
       ORDER BY s.last_seen_at DESC NULLS LAST, c.size DESC NULLS LAST
       LIMIT 500`,
      []
    );

    const byStory = new Map<string, any>();
    for (const r of result.rows) {
      if (!byStory.has(r.id)) {
        byStory.set(r.id, {
          story_id: r.id,
          title: r.title,
          summary: r.summary,
          started_at: r.started_at,
          last_seen_at: r.last_seen_at,
          clusters: [],
        });
      }
      if (r.cluster_id) {
        byStory.get(r.id).clusters.push({
          cluster_id: r.cluster_id,
          size: r.size,
          max_sim: r.max_sim != null ? Number(r.max_sim) : null,
          verdict: r.verdict,
          tags: r.tags || [],
          first_published_at: r.first_published_at,
          last_seen_at: r.cluster_last_seen_at,
        });
      }
    }

    const payload = { stories: [...byStory.values()] };
    cacheSet(storiesCache, 'all', payload);
    res.setHeader('X-Cache', 'miss');
    return res.json(payload);
  } catch (err: any) {
    console.error('[marketPublic] stories error:', err.message);
    return res.status(500).json({ error: 'stories_unavailable' });
  }
});

export default router;
