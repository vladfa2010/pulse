/**
 * NewsSourceManager — Единый пул источников новостей (RSS + API)
 *
 * TZ: TZ_NEWS_SOURCE_MANAGER + TZ_FINNHUB_ADAPTER
 * Статус: В разработке
 */

import { query } from '../config/db';
import { fetchFinnhubNews, saveArticles as saveAPIArticles } from './finnhubAdapter';
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
            // Сохранить через API saver (унифицированный формат)
            const unified = articles.map(a => ({
              title_original: a.title,
              title_ru: a.title_ru || null,
              summary_original: a.summary,
              summary_ru: a.summary_ru || null,
              url: a.url,
              published_at: a.publishedAt,
              source: a.source,
              source_id: a.sourceId,
              source_type: 'rss' as const,
              lang_original: a.lang,
              matched_tags: [] as string[], // RSS — матчинг позже
              content_hash: '' // будет вычислен в saveAPIArticles
            }));
            // Вычислить content_hash для каждой
            for (const u of unified) {
              u.content_hash = crypto.createHash('sha256').update(u.title_original + '\n' + u.summary_original).digest('hex');
            }
            await saveAPIArticles(unified);
            console.log(`[NewsSourceManager] RSS: ${source.name} — ${articles.length} articles`);
          } else if (source.type === 'api_search') {
            if (source.name === 'finnhub') {
              const articles = await fetchFinnhubNews(source.config);
              await saveAPIArticles(articles);
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

// Singleton
let manager: NewsSourceManager | null = null;

export function getNewsSourceManager(): NewsSourceManager {
  if (!manager) manager = new NewsSourceManager();
  return manager;
}
