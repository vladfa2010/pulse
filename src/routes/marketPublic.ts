/**
 * Public market-data routes (no admin required).
 * Used by the news card price-reaction chart.
 */

import { Router, type Response } from 'express';
import { query } from '../config/db';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { hasFinamKey, isInMaintenanceWindow } from '../services/market/finamAuth';
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
  // ТЗ-97: многодневный диапазон каскада (только /cascade-chart; для /news-chart не заполняются)
  dates?: string[];
  covered_until?: string;
  truncated?: boolean;
  range_fallback?: boolean;
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
// ТЗ-97: крышка многодневного диапазона каскада (календарных дней, включительно)
const CASCADE_CHART_MAX_RANGE_DAYS = 14;
const STORIES_CACHE_TTL_MS = 15 * 60 * 1000;    // 15 мин
// ТЗ-115: темы меняются раз в сутки — TTL как у /stories (15 мин)
const TOPICS_CACHE_TTL_MS = 15 * 60 * 1000;     // 15 мин
// ТЗ-115: темы живут только на VPS — на Render (флаг выключен) ручки отвечают
// 404 topics_disabled БЕЗ обращения к таблицам (там их нет)
const TOPICS_ENABLED = process.env.TOPICS_ENABLED === 'true';

const cascadesCache = new Map<string, { at: number; payload: any }>();
const cascadeChartCache = new Map<string, { at: number; payload: any }>();
const storiesCache = new Map<string, { at: number; payload: any }>();
// ТЗ-115, задача 4 — кэши тем (как storiesCache: Map + cacheGet/cacheSet)
const topicsCache = new Map<string, { at: number; payload: any }>();
const topicCache = new Map<string, { at: number; payload: any }>();
// ТЗ-93: данные графа и ресерч-статистика — кэш по окну, TTL 15 мин
const cascadeGraphCache = new Map<string, { at: number; payload: any }>();
const cascadeResearchCache = new Map<string, { at: number; payload: any }>();

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
              fn.published_at AS first_news_at,
              sc.sources AS sources
       FROM clusters c
       LEFT JOIN LATERAL (
         SELECT n.title_ru AS title, n.source, n.url, n.published_at
         FROM cluster_items ci
         JOIN news n ON n.id = ci.news_id
         WHERE ci.cluster_id = c.id
         ORDER BY n.published_at ASC
         LIMIT 1
       ) fn ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(n.source ORDER BY ci.lag_min) AS sources
         FROM cluster_items ci
         JOIN news n ON n.id = ci.news_id
         WHERE ci.cluster_id = c.id
       ) sc ON true
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
        sources: r.sources || [],
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
 * GET /api/market/cascade-graph?window=7d|30d (ТЗ-93, задача 2)
 * Данные force-графа каскадов: узлы-цепочки (первоисточник → дубли по
 * lag_min), категории-сюжеты для цвета и фон «звёздное поле» — ВСЕ новости
 * окна. TTL 15 мин, ключ = окно. 24h для графа не отдаём (400).
 */
router.get('/cascade-graph', async (req, res) => {
  try {
    const windowKey = (req.query.window as string) || '7d';
    if (windowKey !== '7d' && windowKey !== '30d') {
      return res.status(400).json({ error: 'window must be 7d|30d' });
    }
    const interval = CASCADE_WINDOWS[windowKey];

    const cached = cacheGet(cascadeGraphCache, windowKey, CASCADE_CHART_CACHE_TTL_MS);
    if (cached) {
      res.setHeader('X-Cache', 'hit');
      return res.json(cached);
    }

    const cascadesRes = await query(
      `SELECT c.id AS cluster_id, c.story_id,
              (SELECT json_agg(sub ORDER BY sub.lag) FROM (
                 SELECT ci.lag_min AS lag, n.source,
                        n.title_ru AS title,
                        EXTRACT(EPOCH FROM n.published_at)::bigint AS t
                 FROM cluster_items ci
                 JOIN news n ON n.id = ci.news_id
                 WHERE ci.cluster_id = c.id
                 ORDER BY ci.lag_min ASC
               ) sub) AS items
       FROM clusters c
       WHERE c.last_seen_at > NOW() - INTERVAL '${interval}'`,
      []
    );

    const storyIds = [
      ...new Set(cascadesRes.rows.map((r: any) => r.story_id).filter(Boolean)),
    ] as string[];
    let stories: any[] = [];
    if (storyIds.length > 0) {
      const storiesRes = await query(
        `SELECT id AS story_id, title FROM stories WHERE id = ANY($1::uuid[])`,
        [storyIds]
      );
      stories = storiesRes.rows;
    }

    const feedRes = await query(
      `SELECT EXTRACT(EPOCH FROM published_at)::bigint AS t, source
       FROM news
       WHERE published_at > NOW() - INTERVAL '${interval}'
       ORDER BY published_at ASC`,
      []
    );

    const payload = {
      window: windowKey,
      cascades: cascadesRes.rows.map((r: any) => ({
        cluster_id: r.cluster_id,
        story_id: r.story_id,
        items: r.items || [],
      })),
      stories,
      feed: feedRes.rows.map((r: any) => [Number(r.t), r.source]),
    };

    cacheSet(cascadeGraphCache, windowKey, payload);
    res.setHeader('X-Cache', 'miss');
    return res.json(payload);
  } catch (err: any) {
    console.error('[marketPublic] cascade-graph error:', err.message);
    return res.status(500).json({ error: 'cascade_graph_unavailable' });
  }
});

/**
 * GET /api/market/cascade-research?window=7d|30d (ТЗ-93, задача 3)
 * Статистика «кто чаще первый» + скорость каскада. Живые числа для вкладки
 * «Ресерч» страницы Каскадов. TTL 15 мин, ключ = окно.
 */
router.get('/cascade-research', async (req, res) => {
  try {
    const windowKey = (req.query.window as string) || '7d';
    if (windowKey !== '7d' && windowKey !== '30d') {
      return res.status(400).json({ error: 'window must be 7d|30d' });
    }
    const interval = CASCADE_WINDOWS[windowKey];

    const cached = cacheGet(cascadeResearchCache, windowKey, CASCADE_CHART_CACHE_TTL_MS);
    if (cached) {
      res.setHeader('X-Cache', 'hit');
      return res.json(cached);
    }

    const result = await query(
      `WITH items AS (
         SELECT ci.cluster_id, n.source, ci.lag_min
         FROM cluster_items ci
         JOIN news n ON n.id = ci.news_id
         JOIN clusters c ON c.id = ci.cluster_id
         WHERE c.first_published_at > NOW() - INTERVAL '${interval}'
       ),
       ranked AS (
         SELECT *, row_number() OVER (PARTITION BY cluster_id ORDER BY lag_min ASC, source) AS rn
         FROM items
       ),
       firsts AS (
         SELECT cluster_id, source AS first_source FROM ranked WHERE rn = 1
       ),
       seconds AS (
         SELECT cluster_id, lag_min AS second_lag FROM ranked WHERE rn = 2
       ),
       per_source AS (
         SELECT r.source,
                count(*) AS participations,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY r.lag_min)
                  FILTER (WHERE r.lag_min > 0) AS median_lag_not_first
         FROM ranked r
         GROUP BY r.source
       ),
       first_counts AS (
         SELECT first_source AS source, count(*) AS first_count
         FROM firsts
         GROUP BY first_source
       ),
       window_clusters AS (
         SELECT count(*) AS n FROM clusters
         WHERE first_published_at > NOW() - INTERVAL '${interval}'
       ),
       speed AS (
         SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY second_lag) AS median_second_lag,
                count(*) FILTER (WHERE second_lag <= 10) AS dup_le_10m,
                count(*) FILTER (WHERE second_lag <= 60) AS dup_le_60m,
                count(*) AS cascades_with_second
         FROM seconds
       )
       SELECT ps.source,
              COALESCE(fc.first_count, 0) AS first_count,
              ps.participations,
              ps.median_lag_not_first,
              wc.n AS clusters_total,
              s.median_second_lag,
              s.dup_le_10m,
              s.dup_le_60m,
              s.cascades_with_second
       FROM per_source ps
       LEFT JOIN first_counts fc ON fc.source = ps.source
       CROSS JOIN window_clusters wc
       CROSS JOIN speed s
       ORDER BY first_count DESC NULLS LAST`,
      []
    );

    const clustersTotal = result.rows.length > 0 ? Number(result.rows[0].clusters_total) : 0;
    const speedRow = result.rows.length > 0 ? result.rows[0] : null;
    const payload = {
      window: windowKey,
      clusters_total: clustersTotal,
      sources: result.rows.map((r: any) => ({
        source: r.source,
        first_count: Number(r.first_count),
        share: clustersTotal > 0 ? Number(r.first_count) / clustersTotal : 0,
        participations: Number(r.participations),
        first_rate: Number(r.participations) > 0 ? Number(r.first_count) / Number(r.participations) : 0,
        median_lag_not_first:
          r.median_lag_not_first != null ? Math.round(Number(r.median_lag_not_first)) : null,
      })),
      speed: {
        median_second_lag_min: speedRow?.median_second_lag != null ? Number(speedRow.median_second_lag) : null,
        cascades_with_second: speedRow ? Number(speedRow.cascades_with_second) : 0,
        dup_le_10m: speedRow ? Number(speedRow.dup_le_10m) : 0,
        dup_le_60m: speedRow ? Number(speedRow.dup_le_60m) : 0,
        dup_le_10m_share:
          speedRow && Number(speedRow.cascades_with_second) > 0
            ? Number(speedRow.dup_le_10m) / Number(speedRow.cascades_with_second)
            : 0,
        dup_le_60m_share:
          speedRow && Number(speedRow.cascades_with_second) > 0
            ? Number(speedRow.dup_le_60m) / Number(speedRow.cascades_with_second)
            : 0,
      },
    };

    cacheSet(cascadeResearchCache, windowKey, payload);
    res.setHeader('X-Cache', 'miss');
    return res.json(payload);
  } catch (err: any) {
    console.error('[marketPublic] cascade-research error:', err.message);
    return res.status(500).json({ error: 'cascade_research_unavailable' });
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

    // ТЗ-97: многодневный охват — одним диапазонным запросом Finam от якорного
    // дня (instrument.date, уже разрешён со сдвигом) до дня last_seen_at кластера.
    // buildInstrumentsForTags не меняем — это пост-обработка только для /cascade-chart.
    const rangedInstruments: InstrumentChart[] = [];
    for (const instrument of instruments) {
      const d0 = instrument.date;
      let d1 = dateInTz(cluster.last_seen_at, instrument.timezone);
      let truncated = false;
      const d1Max = addDays(d0, CASCADE_CHART_MAX_RANGE_DAYS - 1);
      if (d1 > d1Max) {
        d1 = d1Max;
        truncated = true;
      }
      if (d1 <= d0) {
        // Однодневный каскад — поведение как до ТЗ-97, поля диапазона не выставляем.
        rangedInstruments.push(instrument);
        continue;
      }
      instrument.truncated = truncated;

      const [rangeTicker, rangeMic] = instrument.symbol.split('@');
      let rangeCandles: MarketCandle[];
      try {
        rangeCandles = (await marketRouter.getIntraday5minRange(rangeMic, rangeTicker, d0, d1)).candles;
      } catch (err: any) {
        if (err.code === 'finam_not_found') {
          continue; // пропустить инструмент
        }
        throw err;
      }

      if (rangeCandles.length === 0) {
        // Finam не хранит M5 за старые даты — оставляем однодневный график
        instrument.range_fallback = true;
        rangedInstruments.push(instrument);
        continue;
      }

      // Дотяжка вперёд (доп. к ТЗ-97): если каскад живёт до/после последней
      // свечи диапазона (напр. весь в выходные, а якорь сдвинут на пятницу),
      // после последней новости в охвате нет свечей — фронт-клиппинг спрячет
      // все маркеры. Дозапрашиваем следующие торговые дни в пределах той же
      // крышки 14 дней от d0. При truncated === true не дотягиваем — хвост
      // осознанно уходит в чип «+N вне графика».
      const lastCandleTime = rangeCandles[rangeCandles.length - 1].time;
      if (!truncated && lastCandleTime < cluster.last_seen_at) {
        const d1ForwardMax = addDays(d1, CASCADE_CHART_MAX_RANGE_DAYS);
        const capForwardMax = addDays(d0, CASCADE_CHART_MAX_RANGE_DAYS - 1);
        const forwardEnd = d1ForwardMax < capForwardMax ? d1ForwardMax : capForwardMax;
        const forwardStart = addDays(d1, 1);
        if (forwardStart <= forwardEnd) {
          let forwardCandles: MarketCandle[] = [];
          try {
            forwardCandles = (await marketRouter.getIntraday5minRange(rangeMic, rangeTicker, forwardStart, forwardEnd)).candles;
          } catch (err: any) {
            if (err.code !== 'finam_not_found') throw err;
            // finam_not_found: дотяжку пропускаем, оставляем исходный диапазон
          }
          if (forwardCandles.length > 0) {
            // Склейка: защита от дублей по time (если диапазоны пересеклись),
            // сортировка по возрастанию времени.
            const merged = new Map<string, MarketCandle>();
            for (const c of rangeCandles) merged.set(c.time, c);
            for (const c of forwardCandles) merged.set(c.time, c);
            rangeCandles = [...merged.values()].sort((a, b) => a.time.localeCompare(b.time));
          }
          // Пустой дозапрос (напр. понедельник ещё не наступил) — оставляем как есть,
          // завтра свечи появятся и TTL кэша подтянет их сам.
        }
      }

      // Свечи отсортированы по возрастанию (fetchBars отдаёт в порядке времени);
      // findNearestTimeIndex фронта полагается на сортировку.
      instrument.times = rangeCandles.map((c) => c.time);
      instrument.ohlc = rangeCandles.map((c) => [c.open, c.close, c.low, c.high]);
      instrument.volumes = rangeCandles.map((c) => c.volume ?? 0);
      instrument.dates = [...new Set(rangeCandles.map((c) => dateInTz(c.time, instrument.timezone)))];
      instrument.covered_until = rangeCandles[rangeCandles.length - 1].time;
      rangedInstruments.push(instrument);
    }

    // ТЗ-99: id и url новости — список новостей каскада в деталь-панели
    // становится кликабельным (ссылка на первоисточник / карточку новости).
    const newsRes = await query(
      `SELECT n.id, n.url, n.published_at, n.title_ru, n.source
       FROM cluster_items ci
       JOIN news n ON n.id = ci.news_id
       WHERE ci.cluster_id = $1
       ORDER BY n.published_at ASC`,
      [clusterId]
    );

    const payload = {
      cluster_id: clusterId,
      published_at: anchor,
      instruments: rangedInstruments,
      news_markers: newsRes.rows.map((r: any) => ({
        id: r.id,
        url: r.url,
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

/**
 * GET /api/market/topics (ТЗ-115, задача 4)
 * Темы последнего done-прогона topics-worker, сортировка news_count DESC.
 * Темы без имени (named=false) отдаём с name=null — фронт покажет
 * «Тема без названия (формируется)» (штатно до крона нейминга 04:10 МСК).
 * TTL 15 мин, публичная, read-only. При TOPICS_ENABLED != 'true' — 404.
 */
router.get('/topics', async (req, res) => {
  if (!TOPICS_ENABLED) {
    return res.status(404).json({ error: 'topics_disabled' });
  }
  try {
    const cached = cacheGet(topicsCache, 'all', TOPICS_CACHE_TTL_MS);
    if (cached) {
      res.setHeader('X-Cache', 'hit');
      return res.json(cached);
    }

    const runRes = await query(
      `SELECT id, window_days, news_count, noise_count, finished_at
       FROM topic_runs
       WHERE status = 'done'
       ORDER BY finished_at DESC NULLS LAST
       LIMIT 1`,
      []
    );

    let payload: any;
    if (runRes.rows.length === 0) {
      // Прогона ещё не было — пустое состояние (не ошибка)
      payload = {
        run_at: null,
        window_days: null,
        topics_total: 0,
        news_covered: 0,
        noise_count: 0,
        topics: [],
      };
    } else {
      const run = runRes.rows[0];
      const topicsRes = await query(
        `SELECT id, name, summary, named, news_count, span_days, sources_count, trend, daily
         FROM topics
         WHERE run_id = $1
         ORDER BY news_count DESC`,
        [run.id]
      );
      payload = {
        run_at: run.finished_at,
        window_days: run.window_days,
        topics_total: topicsRes.rows.length,
        news_covered: run.news_count != null ? Number(run.news_count) : 0,
        noise_count: run.noise_count != null ? Number(run.noise_count) : 0,
        topics: topicsRes.rows.map((r: any) => ({
          id: r.id,
          // unnamed-темы — строго name=null (не пустая строка)
          name: r.named ? r.name : null,
          summary: r.named ? r.summary : null,
          news_count: Number(r.news_count),
          span_days: r.span_days != null ? Number(r.span_days) : null,
          sources_count: r.sources_count != null ? Number(r.sources_count) : null,
          trend: r.trend,
          daily: r.daily || [],
        })),
      };
    }

    cacheSet(topicsCache, 'all', payload);
    res.setHeader('X-Cache', 'miss');
    return res.json(payload);
  } catch (err: any) {
    console.error('[marketPublic] topics error:', err.message);
    return res.status(500).json({ error: 'topics_unavailable' });
  }
});

/**
 * GET /api/market/topic?id=<uuid> (ТЗ-115, задача 4)
 * Детальная карточка темы: новости (topic_items JOIN news, time DESC, лимит 200),
 * каскады в теме (JOIN cluster_items по news_id, overlap DESC, лимит 20),
 * сюжеты в теме (news_id → cluster_items → clusters.story_id, overlap DESC, лимит 20).
 * TTL 15 мин, публичная, read-only. При TOPICS_ENABLED != 'true' — 404.
 */
router.get('/topic', async (req, res) => {
  if (!TOPICS_ENABLED) {
    return res.status(404).json({ error: 'topics_disabled' });
  }
  try {
    const topicId = req.query.id as string;
    if (!topicId) {
      return res.status(400).json({ error: 'id required' });
    }

    const cached = cacheGet(topicCache, topicId, TOPICS_CACHE_TTL_MS);
    if (cached) {
      res.setHeader('X-Cache', 'hit');
      return res.json(cached);
    }

    const tRes = await query(
      `SELECT id, name, summary, named, news_count, span_days, sources_count, trend, daily
       FROM topics
       WHERE id = $1`,
      [topicId]
    );
    if (tRes.rows.length === 0) {
      return res.status(404).json({ error: 'topic_not_found' });
    }
    const t = tRes.rows[0];

    const newsRes = await query(
      `SELECT n.id, n.published_at, n.source, n.title_ru, n.url
       FROM topic_items ti
       JOIN news n ON n.id = ti.news_id
       WHERE ti.topic_id = $1
       ORDER BY n.published_at DESC
       LIMIT 200`,
      [topicId]
    );

    // Каскады в теме: overlap = сколько новостей темы входит в каскад
    const cascadesRes = await query(
      `SELECT c.id,
              fn.title,
              c.size AS news_count,
              COUNT(*) AS overlap
       FROM topic_items ti
       JOIN cluster_items ci ON ci.news_id = ti.news_id
       JOIN clusters c ON c.id = ci.cluster_id
       LEFT JOIN LATERAL (
         SELECT n.title_ru AS title
         FROM cluster_items ci2
         JOIN news n ON n.id = ci2.news_id
         WHERE ci2.cluster_id = c.id
         ORDER BY n.published_at ASC
         LIMIT 1
       ) fn ON true
       WHERE ti.topic_id = $1
       GROUP BY c.id, fn.title, c.size
       ORDER BY overlap DESC
       LIMIT 20`,
      [topicId]
    );

    // Сюжеты в теме: news_id темы → каскады → сюжет (clusters.story_id);
    // overlap = сколько новостей темы входит в каскады сюжета
    const storiesRes = await query(
      `SELECT s.id, s.title AS name, COUNT(*) AS overlap
       FROM topic_items ti
       JOIN cluster_items ci ON ci.news_id = ti.news_id
       JOIN clusters c ON c.id = ci.cluster_id
       JOIN stories s ON s.id = c.story_id
       WHERE ti.topic_id = $1
       GROUP BY s.id, s.title
       ORDER BY overlap DESC
       LIMIT 20`,
      [topicId]
    );

    const payload = {
      id: t.id,
      name: t.named ? t.name : null,
      summary: t.named ? t.summary : null,
      stats: {
        news_count: Number(t.news_count),
        span_days: t.span_days != null ? Number(t.span_days) : null,
        sources_count: t.sources_count != null ? Number(t.sources_count) : null,
        trend: t.trend,
        daily: t.daily || [],
      },
      news: newsRes.rows.map((r: any) => ({
        id: r.id,
        time: r.published_at,
        source: r.source,
        title: r.title_ru,
        url: r.url,
      })),
      cascades: cascadesRes.rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        news_count: Number(r.news_count),
        overlap: Number(r.overlap),
      })),
      stories: storiesRes.rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        overlap: Number(r.overlap),
      })),
    };

    cacheSet(topicCache, topicId, payload);
    res.setHeader('X-Cache', 'miss');
    return res.json(payload);
  } catch (err: any) {
    console.error('[marketPublic] topic error:', err.message);
    return res.status(500).json({ error: 'topics_unavailable' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-56: watchlist котировок для радио — тикеры из активных тегов портфеля
// ═══════════════════════════════════════════════════════════════════════════

const WATCHLIST_CACHE_TTL_MS = 2 * 60 * 1000; // синхрон с TTL_PRICE_MS (2 мин)

interface WatchlistEntry {
  symbol: string; // "SBER@MISX"
  tag_id: string;
  tag_name: string;
  price: number;
  changePct: number;
  currency: 'RUB' | 'USD' | null; // для озвучки: рубли/доллары
  ts: number;
}

const watchlistCache = new Map<string, { at: number; payload: WatchlistEntry[] }>();

/** Валюта по MIC: MOEX → RUB, NASDAQ/NYSE → USD, прочее → null (без суффикса). */
function currencyByMic(mic: string): 'RUB' | 'USD' | null {
  const m = mic.toUpperCase();
  if (m === 'MISX') return 'RUB';
  if (m === 'XNGS' || m === 'XNYS') return 'USD';
  return null;
}

/**
 * GET /api/market/watchlist-quotes (auth)
 *
 * Тикеры из активных тегов юзера (`portfolios.is_frozen = FALSE`,
 * `enriched_data.symbol` или `ticker + mic`). Цены через
 * `marketRouter.getCurrentPricesBatch` (Finam, кэш 2 мин).
 * Кэш ответа 2 мин по user_id.
 *
 * Используется фронтом: Watchlist в /radio + buildQuotesSegments в эфире.
 * До батча — явный pre-check Finam (maintenance/нет ключа), иначе batch
 * глотал бы ошибки и maintenance выглядел бы как «пустой список».
 */
router.get('/watchlist-quotes', authMiddleware, async (req: AuthRequest, res) => {
  const userId = req.user?.userId; // auth.ts: req.user = { userId, email }
  if (!userId) {
    return res.status(401).json({ error: 'auth_required' });
  }

  if (!hasFinamKey() || isInMaintenanceWindow()) {
    return res.status(503).json({ error: 'market_unavailable' });
  }

  // Cache hit
  const cached = watchlistCache.get(userId);
  if (cached && Date.now() - cached.at < WATCHLIST_CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'hit');
    return res.json({ quotes: cached.payload, ts: cached.at });
  }

  try {
    // 1. Активные теги юзера + enriched_data (порядок — алфавит по tag_name)
    const tagRes = await query(
      `SELECT p.tag_id, p.tag_name, udt.enriched_data
       FROM portfolios p
       JOIN user_defined_tags udt ON udt.tag_id = p.tag_id
       WHERE p.user_id = $1 AND p.is_frozen = FALSE
       ORDER BY p.tag_name ASC`,
      [userId]
    );

    // 2. Резолв symbol (тот же паттерн, что buildInstrumentsForTags)
    const items: { ticker: string; exchange: string; tagId: string; tagName: string; symbol: string }[] = [];
    for (const row of tagRes.rows) {
      let enriched = row.enriched_data;
      if (typeof enriched === 'string') {
        try { enriched = JSON.parse(enriched); } catch { enriched = null; }
      }
      if (!enriched || typeof enriched !== 'object') continue;

      const symbol = enriched.symbol || null;
      const ticker = enriched.ticker || null;
      const mic = enriched.mic || null;

      if (!symbol && !(ticker && mic)) continue;

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

      items.push({
        ticker: resolvedTicker,
        exchange: exchangeMic,
        tagId: row.tag_id,
        tagName: row.tag_name,
        symbol: symbol || `${resolvedTicker}@${exchangeMic}`,
      });
    }

    // 3. Batch-запрос цен (кэш Finam 2 мин — дедупликация внутри)
    let payload: WatchlistEntry[] = [];
    if (items.length > 0) {
      const priceItems = items.map((i) => ({ ticker: i.ticker, exchange: i.exchange }));
      const priceMap = await marketRouter.getCurrentPricesBatch(priceItems);

      for (const item of items) {
        const key = `${item.ticker}@${item.exchange}`;
        const quote = priceMap.get(key);
        if (!quote) continue; // Finam не вернул цену — пропускаем
        payload.push({
          symbol: item.symbol,
          tag_id: item.tagId,
          tag_name: item.tagName,
          price: quote.price,
          changePct: quote.changePct,
          currency: currencyByMic(item.exchange),
          ts: Date.now(),
        });
      }
    }

    watchlistCache.set(userId, { at: Date.now(), payload });
    res.setHeader('X-Cache', 'miss');
    return res.json({ quotes: payload, ts: Date.now() });
  } catch (err: any) {
    console.error('[marketPublic] watchlist-quotes error:', err.message);
    if (
      err.code === 'finam_no_key' ||
      err.code === 'finam_maintenance' ||
      err.code === 'finam_auth_failed' ||
      err.code === 'finam_rate_limited'
    ) {
      return res.status(503).json({ error: 'market_unavailable' });
    }
    return res.status(500).json({ error: 'watchlist_unavailable' });
  }
});

export default router;
