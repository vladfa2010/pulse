/**
 * Finnhub API Adapter
 * TZ: TZ_FINNHUB_ADAPTER
 * Запрашивает новости по тикерам из user_defined_tags
 */

import { query } from '../config/db';
import crypto from 'crypto';

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
  const apiKey = process.env.FINNHUB_API_KEY || config.api_key;
  const baseUrl = config.base_url || 'https://finnhub.io/api/v1';
  const rpm = config.rate_limit_rpm || 60;
  const delayMs = Math.ceil(60000 / rpm);

  if (!apiKey) {
    console.error('[Finnhub] No API key. Set FINNHUB_API_KEY env var.');
    return [];
  }

  // 1. Собрать теги с тикерами (только нерусские биржи: NASDAQ, NYSE, LSE и т.д.)
  const tagResult = await query(`
    SELECT DISTINCT
      t.tag_id,
      t.tag_name,
      t.enriched_data->>'ticker' as ticker,
      t.enriched_data->>'exchange' as exchange,
      COUNT(p.user_id) as subscriber_count
    FROM user_defined_tags t
    JOIN portfolios p ON p.tag_id = t.tag_id
    WHERE t.enriched_data->>'ticker' IS NOT NULL
      AND LENGTH(t.enriched_data->>'ticker') > 0
      AND t.enriched_data->>'exchange' = 'USA'
    GROUP BY t.tag_id, t.tag_name, t.enriched_data->>'ticker', t.enriched_data->>'exchange'
    ORDER BY subscriber_count DESC
  `);
  const allTags = tagResult.rows;

  if (allTags.length === 0) {
    const debugResult = await query(`
      SELECT t.tag_id, t.tag_name, t.enriched_data->>'ticker' as t, t.enriched_data->>'exchange' as e
      FROM user_defined_tags t
      JOIN portfolios p ON p.tag_id = t.tag_id
    `);
    console.log(`[Finnhub] DEBUG All portfolio tags:`, JSON.stringify(debugResult.rows));
    console.log('[Finnhub] No tags with exchange=USA found');
    return [];
  }

  // Все тикеры каждый цикл (пока их мало — tiered не нужен)
  const tags = [...allTags];
  console.log(`[Finnhub] Total: ${allTags.length} tickers, fetching ALL this cycle`);

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

  // title_ru и summary_ru остаются null — признак "сырой" статьи
  // News Processor найдёт их через WHERE title_ru IS NULL и сделает перевод
  console.log(`[Finnhub] Total articles: ${articles.length} (raw: title_ru=null, summary_ru=null)`);
  return articles;
}

export async function saveArticles(articles: FetchedArticle[]): Promise<void> {
  let saved = 0;
  let skipped = 0;
  let urlDup = 0;

  for (const a of articles) {
    // 1. Проверка по URL — primary dedup
    const existingByUrl = await query(`SELECT id FROM news WHERE url = $1`, [a.url]);
    if (existingByUrl.rows.length > 0) {
      urlDup++;
      continue; // Skip — уже есть от RSS или другого API
    }

    try {
      await query(`
        INSERT INTO news (
          title_original, title_ru, summary_original, summary_ru,
          source, source_id, source_type, url, content_hash,
          all_sources, source_count, published_at, lang_original,
          matched_tags
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text[], 1, $11, $12, $13)
        ON CONFLICT (content_hash) DO UPDATE SET
          matched_tags = (
            SELECT array_agg(DISTINCT x)
            FROM unnest(
              array_cat(
                COALESCE(news.matched_tags, '{}'::text[]),
                EXCLUDED.matched_tags
              )
            ) AS t(x)
          ),
          all_sources = (
            SELECT array_agg(DISTINCT x)
            FROM unnest(
              array_cat(
                COALESCE(news.all_sources, '{}'::text[]),
                ARRAY[EXCLUDED.source]
              )
            ) AS t(x)
          ),
          source_count = (
            SELECT COUNT(DISTINCT x)
            FROM unnest(
              array_cat(
                COALESCE(news.all_sources, '{}'::text[]),
                ARRAY[EXCLUDED.source]
              )
            ) AS t(x)
          )
      `, [
        a.title_original, a.title_ru, a.summary_original, a.summary_ru,
        a.source, a.source_id, a.source_type, a.url, a.content_hash,
        [a.source], a.published_at, a.lang_original, a.matched_tags,
      ]);
      saved++;
    } catch (err: any) {
      console.error('[Finnhub] Save error:', err.message);
      skipped++;
    }
  }

  console.log(`[Finnhub] Saved: ${saved}, URL dup: ${urlDup}, Error skip: ${skipped}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
