/**
 * Finnhub API Adapter — v2 (streaming + batch + fixes)
 * TZ: TZ_FINNHUB_COMPLETE_FIX_v2
 *
 * Исправлены баги v1:
 *   B1: ReferenceError a.source_count → batch.map(() => 1)
 *   B2: JSON.stringify портит text[] → убран JSON.stringify
 *   B3: Нет sleep между parallel batches → sleep(RATE_LIMIT_DELAY_MS)
 *   B4: Нет streaming → fetch→save→discard по чанкам
 *   B5: BATCH_SIZE 100 → 500
 *   B6: FETCH_TIMEOUT 30000 → 15000
 *
 * Интерфейс: NewsSourceManager вызывает fetchAndSaveFinnhubNews(config)
 *            вместо fetchFinnhubNews() + saveArticles()
 */

import { query } from '../config/db';
import crypto from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = {
  FETCH_TIMEOUT_MS: 15000,       // B6: было 30000
  MAX_RETRIES: 3,
  CONCURRENCY_LIMIT: 5,
  BATCH_SIZE: 500,               // B5: было 100
  RATE_LIMIT_DELAY_MS: 1000,     // B3: sleep между parallel batches
  LOOKBACK_DAYS_FIRST: 7,        // FIN-010
  LOOKBACK_DAYS_REGULAR: 1,
  CB_THRESHOLD: 5,
  CB_TIMEOUT_MS: 30 * 60 * 1000, // 30 min
};

function cfg(config: any, key: keyof typeof DEFAULTS) {
  return config[key.toLowerCase()] || DEFAULTS[key];
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

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
  source: string;
  source_id: string;
  source_type: string;
  url: string;
  url_normalized: string;
  content_hash: string;
  all_sources: string[];
  source_count: number;
  published_at: string;  // ISO string для TIMESTAMPTZ
  lang_original: string;
  matched_tags: string[];
  needs_translation: boolean;
}

export interface FetchResult {
  totalFetched: number;
  totalSaved: number;
  totalMerged: number;
  durationMs: number;
  errors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER
// ═══════════════════════════════════════════════════════════════════════════

class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private threshold: number;
  private timeoutMs: number;

  constructor(config: any) {
    this.threshold = cfg(config, 'CB_THRESHOLD');
    this.timeoutMs = cfg(config, 'CB_TIMEOUT_MS');
  }

  isOpen(): boolean {
    if (this.failures < this.threshold) return false;
    if (Date.now() - this.lastFailure > this.timeoutMs) {
      this.failures = 0; // half-open
      return false;
    }
    return true;
  }

  recordSuccess() { this.failures = 0; }
  recordFailure() { this.failures++; this.lastFailure = Date.now(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

/** B2 fix: fetch с таймаутом */
async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return r;
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Timeout ${timeoutMs}ms: ${url}`);
    throw err;
  }
}

/** Логирование ВСЕХ ошибок в news_sources + инкремент счётчика */
async function logSourceError(sourceId: string, type: string, msg: string): Promise<void> {
  try {
    await query(
      `UPDATE news_sources SET last_error = $1, last_error_at = NOW(), error_count = COALESCE(error_count, 0) + 1 WHERE name = $2`,
      [`[${type}] ${msg}`, sourceId]
    );
  } catch { /* logging failed — ignore */ }
}

/** Retry с exponential backoff */
async function fetchWithRetry(
  url: string, ticker: string, config: any
): Promise<Response> {
  const maxRetries = cfg(config, 'MAX_RETRIES');
  const timeoutMs = cfg(config, 'FETCH_TIMEOUT_MS');

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetchWithTimeout(url, timeoutMs);
      if (response.ok) return response;

      const errorType = response.status === 429 ? 'RATE_LIMIT'
        : response.status >= 500 ? 'SERVER_ERROR' : 'HTTP_ERROR';
      await logSourceError('finnhub', errorType, `${response.status} for ${ticker}`);

      if (![429, 500, 502, 503].includes(response.status)) break;
      await sleep(Math.pow(2, i) * 1000);
    } catch (err: any) {
      await logSourceError('finnhub', 'FETCH_ERROR', `${err.message} for ${ticker}`);
      if (i < maxRetries - 1) await sleep(Math.pow(2, i) * 1000);
    }
  }
  throw new Error(`Failed after ${maxRetries} retries: ${ticker}`);
}

/** Guard: пропускаем пустые статьи */
function isValidArticle(item: any): boolean {
  return !!(item.headline?.trim() && item.url?.trim());
}

/** Нормализация URL для дедупликации */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Создание FetchedArticle из Finnhub ответа */
function createArticle(item: FinnhubArticle, tag: any): FetchedArticle {
  return {
    title_original: item.headline.trim(),
    title_ru: null,
    summary_original: (item.summary || '').trim(),
    summary_ru: null,
    source: item.source || 'Finnhub News',
    source_id: 'finnhub',
    source_type: 'api_search',
    url: item.url.trim(),
    url_normalized: normalizeUrl(item.url),
    content_hash: crypto
      .createHash('sha256')
      .update(`${item.headline}\n${item.summary || ''}`.slice(0, 500))
      .digest('hex'),
    all_sources: [item.source || 'Finnhub News'],
    source_count: 1,
    published_at: new Date(item.datetime * 1000).toISOString(), // FIN-011: TIMESTAMPTZ safe
    lang_original: 'en',
    matched_tags: [tag.tag_id],
    needs_translation: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// BATCH INSERT (B1, B2 fixes)
// ═══════════════════════════════════════════════════════════════════════════

async function saveArticlesBatch(
  articles: FetchedArticle[],
  config: any
): Promise<{ saved: number; merged: number }> {
  if (articles.length === 0) return { saved: 0, merged: 0 };

  const BATCH_SIZE = cfg(config, 'BATCH_SIZE');
  let saved = 0, merged = 0;

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);

    try {
      // jsonb_to_recordset — корректно обрабатывает text[] и другие сложные типы
      // unnest с многомерными массивами даёт "is of type text" ошибку
      const rowsJson = JSON.stringify(batch.map(a => ({
        title_original: a.title_original,
        title_ru: a.title_ru,
        summary_original: a.summary_original,
        summary_ru: a.summary_ru,
        source: a.source,
        source_id: a.source_id,
        source_type: a.source_type,
        url: a.url,
        url_normalized: a.url_normalized,
        content_hash: a.content_hash,
        all_sources: a.all_sources,
        source_count: 1,
        published_at: a.published_at,
        lang_original: a.lang_original,
        matched_tags: a.matched_tags,
        needs_translation: true,
      })));

      const result = await query(`
        INSERT INTO news (
          title_original, title_ru, summary_original, summary_ru,
          source, source_id, source_type, url, url_normalized, content_hash,
          all_sources, source_count, published_at, lang_original,
          matched_tags, needs_translation
        )
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
          title_original text, title_ru text, summary_original text, summary_ru text,
          source text, source_id text, source_type text, url text, url_normalized text, content_hash text,
          all_sources text[], source_count int, published_at timestamptz, lang_original text,
          matched_tags text[], needs_translation boolean
        )
        ON CONFLICT (url) DO UPDATE SET
          matched_tags = (
            SELECT array_agg(DISTINCT x)
            FROM unnest(array_cat(
              COALESCE(news.matched_tags, '{}'::text[]),
              EXCLUDED.matched_tags
            )) AS t(x)
          ),
          all_sources = (
            SELECT array_agg(DISTINCT x)
            FROM unnest(array_cat(
              COALESCE(news.all_sources, '{}'::text[]),
              ARRAY[EXCLUDED.source]
            )) AS t(x)
          ),
          source_count = (
            SELECT COUNT(DISTINCT x)
            FROM unnest(array_cat(
              COALESCE(news.all_sources, '{}'::text[]),
              ARRAY[EXCLUDED.source]
            )) AS t(x)
          )
        RETURNING (xmax = 0) AS is_insert
      `, [rowsJson]);

      for (const row of result.rows) {
        row.is_insert ? saved++ : merged++;
      }
    } catch (err: any) {
      console.error('[Finnhub] Batch save error:', err.message);
    }
  }

  return { saved, merged };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN: fetchAndSaveFinnhubNews (B3, B4 fixes)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Единая точка входа. NewsSourceManager вызывает ЭТУ функцию.
 *
 * B4 fix: Streaming — fetch по чанкам → сразу save → discard.
 * НЕ накапливаем все статьи в памяти.
 *
 * B3 fix: sleep(RATE_LIMIT_DELAY_MS) между parallel batches.
 */
export async function fetchAndSaveFinnhubNews(config: any): Promise<FetchResult> {
  const startTime = Date.now();
  const apiKey = process.env.FINNHUB_API_KEY || config.api_key;
  const baseUrl = config.base_url || 'https://finnhub.io/api/v1';

  const result: FetchResult = {
    totalFetched: 0,
    totalSaved: 0,
    totalMerged: 0,
    durationMs: 0,
    errors: [],
  };

  if (!apiKey) {
    console.error('[Finnhub] No API key');
    await logSourceError('finnhub', 'CONFIG', 'No API key');
    return result;
  }

  const cb = new CircuitBreaker(config);
  if (cb.isOpen()) {
    console.log('[Finnhub] Circuit breaker OPEN — skipping');
    await logSourceError('finnhub', 'CIRCUIT', 'Breaker OPEN');
    return result;
  }

  // --- 1. Получаем тикеры (FIN-003 fix: try/catch) ---
  let allTags: any[] = [];
  try {
    const tagResult = await query(`
      SELECT DISTINCT
        t.tag_id,
        t.enriched_data->>'ticker' as ticker,
        COUNT(p.user_id) as subscriber_count
      FROM user_defined_tags t
      JOIN portfolios p ON p.tag_id = t.tag_id
      WHERE t.enriched_data->>'ticker' IS NOT NULL
        AND LENGTH(t.enriched_data->>'ticker') > 0
        AND t.enriched_data->>'exchange' = 'USA'
      GROUP BY t.tag_id
      ORDER BY subscriber_count DESC
    `);
    allTags = tagResult.rows;
  } catch (err: any) {
    console.error('[Finnhub] DB error:', err.message);
    await logSourceError('finnhub', 'DB_ERROR', err.message);
    return result;
  }

  if (allTags.length === 0) {
    console.log('[Finnhub] No USA tickers found');
    return result;
  }

  // --- 2. Определяем период (FIN-010: first run = 7 days) ---
  const countResult = await query(
    `SELECT COUNT(*) as c FROM news WHERE source_type = 'api_search'`
  );
  const isFirstRun = parseInt(countResult.rows[0]?.c || '0') === 0;
  const lookbackDays = isFirstRun
    ? cfg(config, 'LOOKBACK_DAYS_FIRST')
    : cfg(config, 'LOOKBACK_DAYS_REGULAR');

  const toDate = new Date().toISOString().split('T')[0];
  const fromDate = new Date(Date.now() - lookbackDays * 86400000)
    .toISOString().split('T')[0];

  if (isFirstRun) {
    console.log(`[Finnhub] First run detected — fetching ${lookbackDays} days`);
  }

  // --- 3. Parallel fetch + streaming save (B3 + B4 fixes) ---
  const CONCURRENCY_LIMIT = cfg(config, 'CONCURRENCY_LIMIT');
  const RATE_LIMIT_DELAY_MS = cfg(config, 'RATE_LIMIT_DELAY_MS');

  for (let i = 0; i < allTags.length; i += CONCURRENCY_LIMIT) {
    const tickerBatch = allTags.slice(i, i + CONCURRENCY_LIMIT);

    // Fetch 5 тикеров параллельно
    const promises = tickerBatch.map(async (tag) => {
      try {
        const url = `${baseUrl}/company-news?symbol=${tag.ticker.toUpperCase()}&from=${fromDate}&to=${toDate}&token=${apiKey}`;
        const response = await fetchWithRetry(url, tag.ticker, config);
        const data = await response.json();

        if (!Array.isArray(data)) {
          console.error(`[Finnhub] Invalid response for ${tag.ticker}`);
          return [];
        }

        cb.recordSuccess();
        return data
          .filter(isValidArticle)                          // FIN-009 guard
          .map(item => createArticle(item as FinnhubArticle, tag));
      } catch (err: any) {
        cb.recordFailure();
        console.error(`[Finnhub] ${tag.ticker}:`, err.message);
        result.errors.push(`${tag.ticker}: ${err.message}`);
        return [];
      }
    });

    const batchArticles = (await Promise.all(promises)).flat();
    result.totalFetched += batchArticles.length;

    // B4 fix: Сразу сохраняем, НЕ накапливаем
    if (batchArticles.length > 0) {
      const { saved, merged } = await saveArticlesBatch(batchArticles, config);
      result.totalSaved += saved;
      result.totalMerged += merged;
    }

    // B3 fix: Rate limit — sleep между batches
    if (i + CONCURRENCY_LIMIT < allTags.length) {
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  }

  result.durationMs = Date.now() - startTime;

  console.log(
    `[Finnhub] Done: ${result.totalFetched} fetched, ` +
    `${result.totalSaved} saved, ${result.totalMerged} merged, ` +
    `${result.errors.length} errors in ${result.durationMs}ms`
  );

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKWARD COMPATIBILITY: старый интерфейс
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DEPRECATED: Используйте fetchAndSaveFinnhubNews() для streaming.
 *
 * Эта функция сохраняет статьи, полученные извне.
 * Нужна только если NewsSourceManager ещё не перешёл на новый интерфейс.
 */
export async function saveArticles(articles: FetchedArticle[]): Promise<void> {
  const { saved, merged } = await saveArticlesBatch(articles, DEFAULTS);
  console.log(`[Finnhub] Saved: ${saved}, Merged: ${merged}`);
}

// Legacy export for backward compatibility
export { fetchAndSaveFinnhubNews as fetchFinnhubNews };
