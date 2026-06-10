/**
 * NewsSourceManager — Единый пул источников новостей (RSS + API)
 *
 * TZ: TZ_NEWS_SOURCE_MANAGER + TZ_FINNHUB_ADAPTER
 * Статус: В разработке
 */

import { query } from '../config/db';
import { fetchFinnhubNews, saveArticles } from './finnhubAdapter';

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
            // TODO: RSS adapter (существующий fetchAllRSS)
            console.log(`[NewsSourceManager] RSS: ${source.name} — TODO`);
          } else if (source.type === 'api_search') {
            if (source.name === 'finnhub') {
              const articles = await fetchFinnhubNews(source.config);
              await saveArticles(articles);
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
