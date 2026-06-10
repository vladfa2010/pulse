/**
 * NewsSourceManager — Единый пул источников новостей (RSS + API)
 *
 * Архитектура:
 *   1. Загружает enabled источники из news_sources
 *   2. Для каждого: вызывает адаптер (RSS или API)
 *   3. Нормализует статьи → единый формат
 *   4. Сохраняет в БД (INSERT ... ON CONFLICT)
 *
 * TZ: TZ_NEWS_SOURCE_MANAGER
 * Статус: В разработке
 */

import { query } from '../config/db';

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
  async run(): Promise<void> {
    // TODO: реализация
    console.log('[NewsSourceManager] Starting...');
  }
}
