/**
 * Finnhub API Adapter
 * TZ: TZ_FINNHUB_ADAPTER
 * Запрашивает новости по тикерам из user_defined_tags
 */

import { query } from '../config/db';
import crypto from 'crypto';
import { translateBatch } from './translate';

interface FinnhubArticle {
  datetime: number;
  headline: string;
  summary: string;
  source: string;
  url: string;
}

interface FetchedArticle {
  title_original: string;
  title_ru: string | null;
  summary_original: string;
  summary_ru: string | null;
  url: string;
  published_at: Date;
  source: string;
  source_id: string;
  source_type: string;
  lang_original: string;
  matched_tags: string[];
  content_hash: string;
}

export async function fetchFinnhubNews(config: any): Promise<FetchedArticle[]> {
  const apiKey = config.api_key;
  const baseUrl = config.base_url || 'https://finnhub.io/api/v1';
  const rpm = config.rate_limit_rpm || 60;
  const delayMs = Math.ceil(60000 / rpm);

  if (!apiKey) {
    console.error('[Finnhub] No API key');
    return [];
  }

  // 1. Собрать теги с тикерами
  const tagResult = await query(`
    SELECT DISTINCT t.tag_id, t.tag_name, t.enriched_data->>'ticker' as ticker
    FROM user_defined_tags t
    JOIN portfolios p ON p.tag_id = t.tag_id
    WHERE t.enriched_data->>'ticker' IS NOT NULL
      AND LENGTH(t.enriched_data->>'ticker') > 0
  `);
  const tags = tagResult.rows;

  if (tags.length === 0) {
    console.log('[Finnhub] No tags with tickers found');
    return [];
  }

  console.log(`[Finnhub] Fetching news for ${tags.length} tickers`);

  // 2. Дата — сегодня
  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];

  const articles: FetchedArticle[] = [];

  // 3. Запрос по каждому тикеру
  for (const tag of tags) {
    const ticker = tag.ticker.toUpperCase();
    const url = `${baseUrl}/company-news?symbol=${ticker}&from=${dateStr}&to=${dateStr}&token=${apiKey}`;

    try {
      const response = await fetch(url);
      if (response.status === 429) {
        console.log(`[Finnhub] 429 rate limit for ${ticker}, skipping`);
        continue;
      }
      if (!response.ok) {
        console.error(`[Finnhub] ${response.status} for ${ticker}`);
        continue;
      }

      const data = await response.json() as FinnhubArticle[];
      console.log(`[Finnhub] ${ticker}: ${data.length} articles`);

      for (const item of data) {
        const contentHash = crypto
          .createHash('sha256')
          .update(item.headline + '\n' + (item.summary || ''))
          .digest('hex');

        articles.push({
          title_original: item.headline,
          title_ru: null,
          summary_original: item.summary || '',
          summary_ru: null,
          url: item.url,
          published_at: new Date(item.datetime * 1000),
          source: 'Finnhub News',
          source_id: 'finnhub',
          source_type: 'api_search',
          lang_original: 'en',
          matched_tags: [tag.tag_id],
          content_hash: contentHash,
        });
      }
    } catch (err: any) {
      console.error(`[Finnhub] Error fetching ${ticker}:`, err.message);
    }

    await sleep(delayMs);
  }

  // Перевод EN → RU
  if (articles.length > 0) {
    try {
      const titles = articles.map(a => a.title_original);
      const summaries = articles.map(a => a.summary_original);
      const translatedTitles = await translateBatch(titles);
      const translatedSummaries = await translateBatch(summaries);
      for (let i = 0; i < articles.length; i++) {
        articles[i].title_ru = translatedTitles[i] || articles[i].title_original;
        articles[i].summary_ru = translatedSummaries[i] || articles[i].summary_original;
      }
      console.log(`[Finnhub] Translated ${articles.length} articles`);
    } catch (err: any) {
      console.error('[Finnhub] Translation error:', err.message);
    }
  }

  console.log(`[Finnhub] Total articles: ${articles.length}`);
  return articles;
}

export async function saveArticles(articles: FetchedArticle[]): Promise<void> {
  let saved = 0;
  let skipped = 0;

  for (const a of articles) {
    try {
      await query(`
        INSERT INTO news (
          title_original, title_ru, summary_original, summary_ru,
          source, source_id, source_type, url, content_hash,
          all_sources, source_count, published_at, lang_original,
          matched_tags
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$5], 1, $10, $11, $12)
        ON CONFLICT (content_hash) DO UPDATE SET
          all_sources = array_append_unique(news.all_sources, EXCLUDED.source),
          source_count = array_length(array_append_unique(news.all_sources, EXCLUDED.source), 1)
      `, [
        a.title_original, a.title_ru, a.summary_original, a.summary_ru,
        a.source, a.source_id, a.source_type, a.url, a.content_hash,
        a.published_at, a.lang_original, a.matched_tags
      ]);
      saved++;
    } catch (err: any) {
      console.error('[Finnhub] Save error:', err.message);
      skipped++;
    }
  }

  console.log(`[Finnhub] Saved: ${saved}, Skipped: ${skipped}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
