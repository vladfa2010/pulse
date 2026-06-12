/**
 * NewsSourceManager — Единый пул источников новостей (RSS + API)
 * TZ: TZ_NEWS_SOURCE_MANAGER + TZ_FINNHUB_ADAPTER
 */

import { query } from '../config/db';
import { fetchAndSaveFinnhubNews, saveArticles, normalizeUrl } from './finnhubAdapter';
import { fetchAllRSS } from './rssFetcher';
import { RssSource } from './rssSources';
import crypto from 'crypto';

interface NewsSource {
  id: number;
  name: string;
  display_name: string;
  type: 'rss' | 'api_search' | 'api_feed';
  config: Record<string, any>;
  enabled: boolean;
  last_fetch_at: Date | null;
}

export class NewsSourceManager {
  private isRunning = false;

  async run(): Promise<void> {
    if (this.isRunning) {
      console.log('[NewsSourceManager] Already running, skip');
      return;
    }
    this.isRunning = true;

    try {
      console.log('[NewsSourceManager] Starting cycle...');

      // 0. Backfill: обновить matched_tags для существующих статей по тикерам
      try {
        const backfillResult = await query(`
          UPDATE news n
          SET matched_tags = (
            SELECT array_agg(DISTINCT x)
            FROM unnest(array_cat(COALESCE(n.matched_tags, '{}'::text[]), ARRAY[t.tag_id])) AS t(x)
          )
          FROM (
            SELECT DISTINCT t.tag_id, UPPER(t.enriched_data->>'ticker') as ticker
            FROM user_defined_tags t
            WHERE t.enriched_data->>'exchange' = 'USA'
              AND t.enriched_data->>'ticker' IS NOT NULL
          ) t
          WHERE (
            COALESCE(n.title_original, n.title_ru, '') ILIKE '%' || t.ticker || '%'
            OR COALESCE(n.summary_original, n.summary_ru, '') ILIKE '%' || t.ticker || '%'
          )
          AND (n.matched_tags IS NULL OR NOT (t.tag_id = ANY(n.matched_tags)))
        `);
        const rowCount = backfillResult.rowCount || 0;
        if (rowCount > 0) {
          console.log(`[NSM] Backfill: updated ${rowCount} articles with matched_tags`);
        }
      } catch (e: any) {
        console.error('[NSM] Backfill error:', e.message);
      }

      // 1. Загрузить enabled источники
      const result = await query(`
        SELECT id, name, display_name, type, config, enabled, last_fetch_at
        FROM news_sources
        WHERE enabled = true
        ORDER BY type, name
      `);
      const sources: NewsSource[] = result.rows;

      console.log(`[NewsSourceManager] ${sources.length} sources enabled`);

      // 2. Обработать каждый
      for (const source of sources) {
        try {
          if (source.type === 'rss') {
            // RSS adapter — индивидуальный fetch по source
            const rssSource: RssSource = {
              id: source.name,
              name: source.display_name,
              url: source.config.url,
              lang: source.config.lang || 'ru',
              category: source.config.category || 'news'
            };
            const articles = await fetchAllRSS([rssSource]);
            const unified = articles.map(a => ({
              title_original: a.title,
              title_ru: a.title_ru || null,
              summary_original: a.summary,
              summary_ru: a.summary_ru || null,
              url: a.url,
              published_at: a.publishedAt.toISOString(),
              source: a.source,
              source_id: a.sourceId,
              source_type: 'rss' as const,
              lang_original: a.lang,
              matched_tags: [] as string[],
              url_normalized: normalizeUrl(a.url),
              content_hash: crypto.createHash('sha256').update(a.title + '\n' + a.summary).digest('hex'),
              all_sources: [a.source],
              source_count: 1,
              needs_translation: a.lang === 'en',
            }));
            await saveArticles(unified as any);
            console.log(`[NewsSourceManager] RSS: ${source.name} — ${articles.length} articles`);
          } else if (source.type === 'api_search') {
            if (source.name === 'finnhub') {
              // Finnhub: каждые 5 минут (все тикеры)
              const minutesSinceLastFetch = source.last_fetch_at
                ? (Date.now() - new Date(source.last_fetch_at).getTime()) / 60000
                : 999;
              if (minutesSinceLastFetch < 5) {
                console.log(`[NewsSourceManager] Finnhub: skip (last fetch ${minutesSinceLastFetch.toFixed(1)}m ago, interval=5m)`);
              } else {
                const result = await fetchAndSaveFinnhubNews(source.config);
                console.log(`[NewsSourceManager] Finnhub: ${result.totalFetched} fetched, ${result.totalSaved} saved, ${result.totalMerged} merged`);
              }
            }
          }

          // Обновить last_fetch_at
          await query(`UPDATE news_sources SET last_fetch_at = NOW() WHERE id = $1`, [source.id]);
        } catch (err: any) {
          console.error(`[NewsSourceManager] Error processing ${source.name}:`, err.message);
        }
      }

      console.log('[NewsSourceManager] Cycle complete');
    } finally {
      this.isRunning = false;
    }
  }
}

let manager: NewsSourceManager | null = null;

export function getNewsSourceManager(): NewsSourceManager {
  if (!manager) manager = new NewsSourceManager();
  return manager;
}
