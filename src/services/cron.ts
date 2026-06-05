/**
 * =============================================================================
 * PULSE — RSS Cron Service (с защитой от дубликатов + подсчёт источников)
 * =============================================================================
 *
 * Логика:
 *   1. Загружаем RSS (32 источника, batch по 5)
 *   2. Переводим EN → RU
 *   3. Анализируем sentiment
 *   4. Нормализуем URL
 *   5. Считаем content_hash (MD5 от title_ru + summary_ru)
 *   6. Сохраняем в БД:
 *      - content_hash UNIQUE
 *      - ON CONFLICT (content_hash) DO UPDATE → добавляем источник в all_sources
 *      - Одна новость = одна запись, дубликаты обновляют all_sources
 *
 * Schedule: каждые 15 минут
 * First run: через 2 минуты после старта сервера
 */

import cron from 'node-cron';
import { fetchAllRSS } from './rssFetcher';
import { translateBatch } from './translate';
import { query } from '../config/db';
import { normalizeUrl } from '../utils/normalizeUrl';
import crypto from 'crypto';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ═══════════════════════════════════════════════════════════════════════════
// Smart Tag Matching (imported from smartTagMatcher)
// ═══════════════════════════════════════════════════════════════════════════
import { smartMatchTags, analyzeSentimentLLM, analyzeSentimentBatch, analyzeTagImpact, analyzeTagImpactBatch, analyzeUnifiedBatch, TagImpact, SentimentResult, UnifiedResult } from './smartTagMatcher';
import { populateNewsTagLinks } from './enrichment';
import { broadcastNews } from './sse';

// ═══════════════════════════════════════════════════════════════════════════
// analyzeSentiment — простой анализ на основе ключевых слов
// ═══════════════════════════════════════════════════════════════════════════
function analyzeSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const positiveWords = ['рост', 'прибыль', 'рекорд', 'превысил', 'успех', 'позитив', 'повышение', 'рост', 'рали', 'bull'];
  const negativeWords = ['падение', 'убыток', 'кризис', 'снижение', 'крах', 'негатив', 'санкции', 'bear', 'крах'];

  const lower = text.toLowerCase();
  let score = 0;

  positiveWords.forEach(w => { if (lower.includes(w)) score++ });
  negativeWords.forEach(w => { if (lower.includes(w)) score-- });

  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

// ═══════════════════════════════════════════════════════════════════════════
// processArticles — главная функция: fetch → translate → analyze → save
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// Log cron run to database for monitoring
// ═══════════════════════════════════════════════════════════════════════════
async function logCronStart(taskName: string): Promise<number> {
  const USE_SQLITE = process.env.USE_SQLITE === 'true';
  try {
    if (USE_SQLITE) {
      const result = await query(`INSERT INTO cron_log (task_name, status) VALUES (?, 'running') RETURNING id`, [taskName]);
      return result.rows[0]?.id;
    } else {
      const result = await query(`INSERT INTO cron_log (task_name, status) VALUES ($1, 'running') RETURNING id`, [taskName]);
      return result.rows[0]?.id;
    }
  } catch {
    return 0; // Silent fail — don't break cron if logging fails
  }
}

async function logCronFinish(logId: number, fetched: number, saved: number, merged: number, errors: string[]) {
  if (!logId) return;
  const USE_SQLITE = process.env.USE_SQLITE === 'true';
  try {
    if (USE_SQLITE) {
      await query(
        `UPDATE cron_log SET finished_at = datetime('now'), articles_fetched = ?, articles_saved = ?, articles_merged = ?, errors = ?, status = ? WHERE id = ?`,
        [fetched, saved, merged, errors.join('; ') || null, errors.length > 0 ? 'warning' : 'success', logId]
      );
    } else {
      await query(
        `UPDATE cron_log SET finished_at = NOW(), articles_fetched = $1, articles_saved = $2, articles_merged = $3, errors = $4, status = $5 WHERE id = $6`,
        [fetched, saved, merged, errors.join('; ') || null, errors.length > 0 ? 'warning' : 'success', logId]
      );
    }
  } catch {
    // Silent fail
  }
}

export async function processArticles() {
  // Job lock: prevents parallel execution across instances
  const acquired = await acquireCronLock('rss-aggregator');
  if (!acquired) {
    console.log('[Cron] ⏳ Another instance is already running. Skipping.');
    return;
  }

  try {
    await processArticlesLocked();
  } finally {
    await releaseCronLock('rss-aggregator');
  }
}

async function processArticlesLocked() {
  const logId = await logCronStart('rss');
  const errors: string[] = [];
  let articles: any[] = [];
  let processed: any[] = [];
  let saved = 0;
  let merged = 0;

  try {
    console.log('[Cron] Starting RSS fetch at', new Date().toISOString());

    // 1. Fetch RSS (с защитой от ошибок)
    try {
      articles = await fetchAllRSS();
    } catch (err: any) {
      console.error('[Cron] RSS fetch failed:', err.message);
      errors.push(`fetch: ${err.message}`);
      return; // Exit early — finally still runs
    }

  // Limit to 100 freshest articles per run (prevent LLM timeout overload)
  articles = articles
    .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
    .slice(0, 100);
  
  console.log(`[Cron] Fetched ${articles.length} articles (limited to 100 freshest)`);

  if (articles.length === 0) {
    console.warn('[Cron] ⚠️ ZERO articles fetched from ALL sources. Check /debug-rss for per-source diagnostics');
    errors.push('zero_articles: No articles fetched from any source');
    return; // Early exit — finally still runs
  }

  // Update fetched count immediately
  await query(`UPDATE cron_log SET articles_fetched = $1 WHERE id = $2`, [articles.length, logId]);

  // 2. Translate EN → RU
  const toTranslate = articles.filter(a => a.lang === 'en');
  if (toTranslate.length > 0) {
    const titles = toTranslate.map(a => a.title);
    const summaries = toTranslate.map(a => a.summary);

    try {
      const translatedTitles = await translateBatch(titles);
      const translatedSummaries = await translateBatch(summaries);

      toTranslate.forEach((a, i) => {
        a.title_ru = translatedTitles[i] || a.title;
        a.summary_ru = translatedSummaries[i] || a.summary;
      });
    } catch {
      toTranslate.forEach(a => {
        a.title_ru = a.title;
        a.summary_ru = a.summary;
      });
    }
  }

  // 3. Check if LLM is available (check once, not per article)
  const llmAvailable = !!process.env.KIMI_API_KEY;
  console.log(`[Cron] LLM sentiment: ${llmAvailable ? 'ENABLED (batch x5)' : 'DISABLED (keyword-based)'}`);

  // 3a-c. UNIFIED BATCH — 1 LLM request = sentiment + tag_impact + is_political (v7.16)
  console.log('[Cron] Starting smart tag matching...');
  const matchStart = Date.now();
  const matchedTagsList: string[][] = [];
  for (const a of articles) {
    const title_ru = a.title_ru || a.title;
    const summary_ru = a.summary_ru || a.summary;
    const tags = await smartMatchTags(title_ru, summary_ru);
    matchedTagsList.push(tags);
  }
  console.log(`[Cron] Tag matching done: ${matchedTagsList.filter(t => t.length > 0).length}/${articles.length} with tags in ${Date.now() - matchStart}ms`);

  // Unified LLM batch — sentiment + tag_impact + is_political in ONE request
  console.log('[Cron] Starting UNIFIED batch (sentiment + tag_impact + is_political)...');
  const unifiedStart = Date.now();
  let unifiedResults: UnifiedResult[] = [];
  
  // Оптимизация: исключаем дубликаты у которых уже есть reasoning
  // Проверяем content_hash в БД — если есть reasoning, не вызываем LLM
  const skipLLM = new Set<number>(); // индексы статей которые пропускаем
  if (llmAvailable) {
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      const contentHash = crypto.createHash('sha256').update(a.title + '\n' + (a.summary || '')).digest('hex');
      const existingCheck = await query(
        `SELECT sentiment_reasoning, sentiment_source 
         FROM news 
         WHERE content_hash = $1 
         LIMIT 1`,
        [contentHash]
      );
      const existing = existingCheck.rows[0];
      if (existing && existing.sentiment_reasoning && 
          (existing.sentiment_source === 'llm' || existing.sentiment_source === 'llm-partial')) {
        console.log(`[Cron] LLM skip: duplicate with reasoning — ${a.title_ru?.slice(0, 50)}...`);
        skipLLM.add(i);
        // Загружаем реальные данные из БД для дубликата
        const dupData = await query(
          `SELECT sentiment, sentiment_score, sentiment_reasoning, is_political, article_type, tag_impact
           FROM news WHERE content_hash = $1 LIMIT 1`,
          [contentHash]
        );
        const dup = dupData.rows[0];
        unifiedResults[i] = {
          sentiment: dup?.sentiment || 'neutral',
          score: dup?.sentiment_score || 0,
          reasoning: dup?.sentiment_reasoning || '',
          is_political: dup?.is_political || false,
          article_type: dup?.article_type || 'micro',
          tag_impacts: dup?.tag_impact || matchedTagsList[i].map(t => ({ tag: t, score: 0, reasoning: '' })),
          _llmSource: 'llm',
        } as UnifiedResult;
      }
    }
  }
  
  // Build list of articles that need LLM with their original indices
  const needLLMWithIndex: { article: typeof articles[0]; originalIndex: number }[] = [];
  for (let i = 0; i < articles.length; i++) {
    if (!skipLLM.has(i)) {
      needLLMWithIndex.push({ article: articles[i], originalIndex: i });
    }
  }
  console.log(`[Cron] LLM optimization: ${articles.length} total, ${needLLMWithIndex.length} need LLM, ${skipLLM.size} skipped (duplicates)`);

  if (llmAvailable && needLLMWithIndex.length > 0) {
    const BATCH_SIZE = 5;
    const totalBatches = Math.ceil(needLLMWithIndex.length / BATCH_SIZE);
    for (let batchStart = 0; batchStart < needLLMWithIndex.length; batchStart += BATCH_SIZE) {
      const chunk = needLLMWithIndex.slice(batchStart, batchStart + BATCH_SIZE);
      const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
      const batchStartTime = Date.now();

      try {
        console.log(`[Cron] Batch ${batchNum}/${totalBatches}: ${chunk.length} articles`);
        const results = await analyzeUnifiedBatch(
          chunk.map(({ article, originalIndex }) => ({
            title: article.title_ru || article.title,
            summary: article.summary_ru || article.summary,
            tags: matchedTagsList[originalIndex],
          }))
        );

        // Distribute results back to unifiedResults by originalIndex
        for (let j = 0; j < results.length && j < chunk.length; j++) {
          unifiedResults[chunk[j].originalIndex] = results[j];
        }

        // Record successful batch
        const successCount = results.filter((u: any) => u._llmSource !== 'llm-empty' && !u._llmErrorType).length;
        const partialCount = results.filter((u: any) => u._llmSource === 'llm-partial').length;
        const status = partialCount > 0 ? 'partial' : 'success';
        await query(`
          INSERT INTO llm_batches (started_at, articles_count, results_count, status, duration_ms)
          VALUES (NOW(), $1, $2, $3, $4)
        `, [chunk.length, successCount + partialCount, status, Date.now() - batchStartTime]).catch(() => {
          // Silent fail — metrics are best-effort
        });

      } catch (err: any) {
        const errorType: string =
          err.code === 'ETIMEDOUT' ? 'llm-timeout' :
          err.code === 'ECONNRESET' ? 'llm-error' :
          err.response?.status === 429 ? 'llm-rate-limit' :
          err.response?.status === 502 ? 'llm-error' :
          err.response?.status === 503 ? 'llm-error' :
          'llm-error';
        const errorMsg: string = err.message?.slice(0, 200) || 'Unknown LLM error';
        console.error(`[Cron] Batch ${batchNum}/${totalBatches} failed: ${errorType} — ${errorMsg}`);

        // Record failed batch
        await query(`
          INSERT INTO llm_batches (started_at, articles_count, results_count, status, error_type, error_message, duration_ms)
          VALUES (NOW(), $1, 0, 'error', $2, $3, $4)
        `, [chunk.length, errorType, errorMsg, Date.now() - batchStartTime]).catch(() => {});

        // Fallback only for articles in this chunk
        for (const { originalIndex } of chunk) {
          unifiedResults[originalIndex] = {
            sentiment: 'neutral' as const, score: 0, reasoning: '', is_political: false, article_type: 'micro' as const,
            tag_impacts: matchedTagsList[originalIndex].map((t: string) => ({ tag: t, score: 0, reasoning: '' })),
            _llmErrorType: errorType,
            _llmErrorMsg: errorMsg,
            _llmBatchSize: chunk.length,
            _llmResultsCount: 0,
          } as UnifiedResult;
        }
      }
    }
  } else {
    // Fallback for all non-duplicate articles
    for (let i = 0; i < articles.length; i++) {
      if (!skipLLM.has(i)) {
        unifiedResults[i] = {
          sentiment: 'neutral' as const, score: 0, reasoning: '', is_political: false, article_type: 'micro' as const,
          tag_impacts: matchedTagsList[i].map((t: string) => ({ tag: t, score: 0, reasoning: '' })),
        };
      }
    }
  }
  console.log(`[Cron] Unified batch done: ${unifiedResults.length} results in ${Date.now() - unifiedStart}ms`);

  // 3d. Merge all results
  processed = [];
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const u = unifiedResults[i] || { sentiment: 'neutral' as const, score: 0, reasoning: '', is_political: false, tag_impacts: [] };

    // Determine sentiment_source: _llmErrorType (from catch) > _llmSource (from partial/empty) > 'llm' (success) > 'keyword'
    const sentimentSource = (u as any)._llmErrorType || (u as any)._llmSource || (llmAvailable ? 'llm' : 'keyword');

    processed.push({
      ...a,
      title_ru: a.title_ru || a.title,
      summary_ru: a.summary_ru || a.summary,
      sentiment: u.sentiment,
      sentiment_score: u.score,
      sentiment_reasoning: u.reasoning || null,
      sentiment_source: sentimentSource,
      llm_error: (u as any)._llmErrorMsg || null,
      llm_attempts: (u as any)._llmErrorType ? 1 : null,  // null при успехе — deferred не берёт
      llm_raw_preview: (u as any)._llmRaw || null,
      llm_batch_size: (u as any)._llmBatchSize || null,
      llm_results_count: (u as any)._llmResultsCount || null,
      is_political: u.is_political,
      article_type: u.article_type || 'micro',
      matched_tags: matchedTagsList[i],
      tag_impact: u.tag_impacts || [],
    });
  }

  // 4. Save to DB (с защитой от дубликатов по content_hash)
  saved = 0;
  merged = 0;

  for (const a of processed) {
    try {
      const urlNormalized = normalizeUrl(a.url || '');
      const title_ru = a.title_ru || a.title;
      const summary_ru = a.summary_ru || a.summary;
      const contentHash = crypto.createHash('md5').update(`${title_ru}_${summary_ru}`.slice(0, 500)).digest('hex');

      if (USE_SQLITE) {
        // SQLite: проверяем content_hash → UPDATE или INSERT
        const existing = await query('SELECT id, all_sources FROM news WHERE content_hash = ? LIMIT 1', [contentHash]);
        if (existing.rows.length > 0) {
          // Дубликат — добавляем источник если новый
          const sources: string[] = JSON.parse(existing.rows[0].all_sources || '[]');
          if (!sources.includes(a.source)) {
            sources.push(a.source);
            await query(`UPDATE news SET all_sources = ?, source_count = ?,
              sentiment = COALESCE(sentiment, ?),
              sentiment_score = COALESCE(sentiment_score, ?),
              sentiment_reasoning = COALESCE(sentiment_reasoning, ?),
              sentiment_source = COALESCE(sentiment_source, ?)
              WHERE id = ?`,
              [JSON.stringify(sources), sources.length,
               a.sentiment, a.sentiment_score, a.sentiment_reasoning, a.sentiment_source,
               existing.rows[0].id]);
            merged++;
          }
        } else {
          // Новая новость
          const newId = crypto.randomUUID();
          await query(
            `INSERT OR IGNORE INTO news (id, title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, all_sources, source_count, published_at, lang_original, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, llm_error, llm_attempts, llm_raw_preview, llm_batch_size, llm_results_count, is_political, article_type, matched_tags, tag_impact)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId, a.title, title_ru, summary_ru, a.source, a.sourceId, a.url, urlNormalized, contentHash, JSON.stringify([a.source]), 1, a.publishedAt.toISOString(), a.lang, a.sentiment, a.sentiment_score, a.sentiment_reasoning, a.sentiment_source, a.llm_error, a.llm_attempts, a.llm_raw_preview, a.llm_batch_size, a.llm_results_count, a.is_political ? 1 : 0, a.article_type || 'micro', JSON.stringify(a.matched_tags || []), JSON.stringify(a.tag_impact || [])]
          );
          saved++;
          // Broadcast to SSE subscribers
          broadcastNews({ id: newId, title_ru, summary_ru, source: a.source, published_at: a.publishedAt, sentiment: a.sentiment, matched_tags: a.matched_tags, url: a.url });
        }
      } else {
        // PostgreSQL: INSERT с ON CONFLICT (content_hash) DO UPDATE
        // FIX v3: CASE WHEN вместо COALESCE — обновляем sentiment-поля ТОЛЬКО если предыдущий результат был LLM-ошибкой
        const result = await query(
          `INSERT INTO news (title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, all_sources, source_count, published_at, lang_original, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, llm_error, llm_attempts, llm_raw_preview, llm_batch_size, llm_results_count, is_political, article_type, matched_tags, tag_impact)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
           ON CONFLICT (content_hash) DO UPDATE
             SET all_sources = CASE
               WHEN news.all_sources @> ARRAY[EXCLUDED.source]::text[] THEN news.all_sources
               ELSE array_append(news.all_sources, EXCLUDED.source)
             END,
             source_count = CASE
               WHEN news.all_sources @> ARRAY[EXCLUDED.source]::text[] THEN news.source_count
               ELSE news.source_count + 1
             END,
             sentiment = CASE
               WHEN news.sentiment_source LIKE 'llm-%' AND news.sentiment_source != 'llm-partial' THEN EXCLUDED.sentiment
               ELSE news.sentiment
             END,
             sentiment_score = CASE
               WHEN news.sentiment_source LIKE 'llm-%' AND news.sentiment_source != 'llm-partial' THEN EXCLUDED.sentiment_score
               ELSE news.sentiment_score
             END,
             sentiment_reasoning = CASE
               WHEN news.sentiment_source LIKE 'llm-%' AND news.sentiment_source != 'llm-partial' THEN EXCLUDED.sentiment_reasoning
               ELSE news.sentiment_reasoning
             END,
             sentiment_source = CASE
               WHEN news.sentiment_source LIKE 'llm-%' AND news.sentiment_source != 'llm-partial' THEN EXCLUDED.sentiment_source
               ELSE news.sentiment_source
             END,
             llm_error = EXCLUDED.llm_error,
             llm_attempts = CASE
               WHEN news.sentiment_source LIKE 'llm-%' THEN COALESCE(news.llm_attempts, 0) + 1
               ELSE COALESCE(news.llm_attempts, 0)
             END,
             last_retry_at = NOW(),
             llm_raw_preview = EXCLUDED.llm_raw_preview,
             llm_batch_size = EXCLUDED.llm_batch_size,
             llm_results_count = EXCLUDED.llm_results_count
           RETURNING id, (xmax = 0) as is_insert`,
          [a.title, title_ru, summary_ru, a.source, a.sourceId, a.url, urlNormalized, contentHash, [a.source], 1, a.publishedAt, a.lang, a.sentiment, a.sentiment_score, a.sentiment_reasoning, a.sentiment_source, a.llm_error, a.llm_attempts, a.llm_raw_preview, a.llm_batch_size, a.llm_results_count, a.is_political, a.article_type || 'micro', a.matched_tags || [], JSON.stringify(a.tag_impact || [])]
        );

        if (result.rows.length > 0 && result.rows[0].is_insert === true) {
          saved++;      // Новая запись
          const newsId = result.rows[0].id;
          // Broadcast to SSE subscribers
          broadcastNews({ id: newsId || null, title_ru, summary_ru, source: a.source, published_at: a.publishedAt, sentiment: a.sentiment, matched_tags: a.matched_tags, url: a.url });

          // Populate news_tag_links для статей с реальным LLM-анализом
          // llm-partial тоже имеет валидные tag_impacts (часть статей проанализирована)
          // Fire-and-forget: НЕ await, чтобы не блокировать цикл и не исчерпать pool
          if ((a.sentiment_source === 'llm' || a.sentiment_source === 'llm-partial') 
              && a.tag_impact && a.tag_impact.length > 0) {
            populateNewsTagLinks(
              newsId,
              a.matched_tags || [],
              a.tag_impact
            ).catch(err => {
              console.error(`[Cron] populateNewsTagLinks async failed for ${newsId}: ${err.message?.slice(0, 100)}`);
            });
          }
        } else {
          merged++;     // Дубликат — обновили all_sources
        }
      }
    } catch (e: any) {
      console.error(`[Cron] Save error for article "${a.title?.slice(0, 40)}": ${e.message?.slice(0, 100)}`);
    }
  }

    console.log(`[Cron] Saved ${saved} new, merged ${merged} duplicates (total ${processed.length})`);
  } catch (err: any) {
    console.error(`[Cron] Fatal error in processArticlesLocked: ${err.message}`);
    errors.push(`fatal: ${err.message}`);
  } finally {
    // Гарантированно логируем финиш — даже при ошибке
    await logCronFinish(logId, processed.length, saved, merged, errors);
    console.log(`[Cron] Finished. Logged: ${processed.length} processed, ${saved} saved, ${merged} merged, ${errors.length} errors`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Cron Job Lock — prevents parallel runs via PostgreSQL
// ═══════════════════════════════════════════════════════════════════════════

const LOCK_TTL_MINUTES = 10; // Lock auto-expires after 10 min (cron runs in ~2-3 min, 5+5 = safety margin)
const INSTANCE_ID = `${process.env.RENDER_INSTANCE_ID || 'local'}-${process.pid}-${Date.now()}`;

// PostgreSQL vs SQLite datetime helpers (for cron lock SQL)
const IS_SQLITE = process.env.USE_SQLITE === 'true';
const SQL_NOW = IS_SQLITE ? "datetime('now')" : 'NOW()';
const SQL_INTERVAL_10MIN = IS_SQLITE
  ? "datetime('now', '+10 minutes')"
  : "NOW() + INTERVAL '10 minutes'";

async function acquireCronLock(jobName: string): Promise<boolean> {
  try {
    // Try to acquire: either the lock is free OR expired
    const result = await query(`
      INSERT INTO cron_locks (job_name, locked_at, locked_by, expires_at)
      VALUES ($1, ${SQL_NOW}, $2, ${SQL_INTERVAL_10MIN})
      ON CONFLICT (job_name) DO UPDATE
        SET locked_at = ${SQL_NOW},
            locked_by = EXCLUDED.locked_by,
            expires_at = ${SQL_INTERVAL_10MIN}
        WHERE cron_locks.expires_at < ${SQL_NOW}
      RETURNING locked_by
    `, [jobName, INSTANCE_ID]);

    const acquired = result.rows.length > 0 && result.rows[0].locked_by === INSTANCE_ID;
    if (acquired) {
      console.log(`[CronLock] ✅ Acquired lock for "${jobName}" (instance: ${INSTANCE_ID.slice(0, 30)}...)`);
    } else {
      console.log(`[CronLock] ⏳ Lock "${jobName}" is held by another instance. Skipping this run.`);
    }
    return acquired;
  } catch (err: any) {
    console.error(`[CronLock] Error acquiring lock: ${err.message?.slice(0, 100)}`);
    return false; // Fail-safe: don't run if lock fails
  }
}

async function releaseCronLock(jobName: string): Promise<void> {
  try {
    await query(`
      DELETE FROM cron_locks
      WHERE job_name = $1 AND locked_by = $2
    `, [jobName, INSTANCE_ID]);
    console.log(`[CronLock] 🔓 Released lock for "${jobName}" (row deleted)`);
  } catch (err: any) {
    console.error(`[CronLock] Error releasing lock: ${err.message?.slice(0, 100)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Start cron: every 5 minutes (first run delayed by 2 min)
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// DEFERRED PROCESSOR — retry failed articles automatically (Stage 4)
// ═══════════════════════════════════════════════════════════════════════════

export async function processDeferredArticles(): Promise<void> {
  // Проверяем есть ли ключ API
  const llmAvailable = !!process.env.KIMI_API_KEY;
  if (!llmAvailable) {
    return; // LLM выключен — нечего retry'ить
  }

  // Берём статьи с ошибкой, которые давно не пробовали и < 3 attempts
  const failed = await query(`
    SELECT id, title_ru, summary_ru, matched_tags
    FROM news
    WHERE llm_error IS NOT NULL
      AND llm_attempts IS NOT NULL
      AND llm_attempts < 3
      AND (last_retry_at IS NULL OR last_retry_at < NOW() - INTERVAL '30 minutes')
    ORDER BY published_at DESC
    LIMIT 20
  `);

  if (failed.rows.length === 0) return;

  console.log(`[Deferred] Processing ${failed.rows.length} failed articles (attempts < 3)`);
  let succeeded = 0;
  let failedAgain = 0;

  // Обрабатываем батчами по 10 (как обычный unified batch)
  for (let i = 0; i < failed.rows.length; i += 5) {
    const batch = failed.rows.slice(i, i + 5);
    try {
      const results = await analyzeUnifiedBatch(
        batch.map((a: any) => ({
          title: a.title_ru,
          summary: a.summary_ru,
          tags: a.matched_tags || [],
        }))
      );

      // UPDATE каждой статьи
      for (let j = 0; j < batch.length; j++) {
        const article = batch[j];
        const r = results[j];
        await query(`
          UPDATE news
          SET sentiment = $1,
              sentiment_score = $2,
              sentiment_reasoning = $3,
              sentiment_source = $4,
              llm_error = NULL,
              last_retry_at = NOW(),
              tag_impact = $5,
              is_political = $6,
              article_type = $7
          WHERE id = $8
        `, [r.sentiment, r.score, r.reasoning || null,
            (r as any)._llmSource || 'llm',
            JSON.stringify(r.tag_impacts || []),
            r.is_political, r.article_type || 'micro', article.id]);
        succeeded++;
      }
    } catch (err: any) {
      // Просто increment attempts — повторим позже
      for (const article of batch) {
        await query(`
          UPDATE news
          SET llm_attempts = COALESCE(llm_attempts, 0) + 1,
              last_retry_at = NOW(),
              llm_error = $1
          WHERE id = $2
        `, [err.message?.slice(0, 200), article.id]);
        failedAgain++;
      }
    }
  }

  console.log(`[Deferred] Done: ${succeeded} succeeded, ${failedAgain} failed again`);

  // Alert if too many failures
  if (failedAgain > succeeded && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID) {
    try {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_ADMIN_CHAT_ID,
          text: `⚠️ Deferred Processor Alert\nFailed: ${failedAgain}, Succeeded: ${succeeded}\nCheck: /admin/llm-dashboard`,
        }),
      });
    } catch {
      // Silently fail — alert is best-effort
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CRON SETUP
// ═══════════════════════════════════════════════════════════════════════════

export function startCron() {
  console.log('[Cron] RSS aggregator scheduled every 5 minutes');

  cron.schedule('*/5 * * * *', async () => {
    try {
      await processArticles();
    } catch (err: any) {
      console.error('[Cron] RSS process failed:', err.message);
    }
  });

  // Delayed first run: wait 2 minutes after startup
  setTimeout(() => {
    processArticles().catch((err: any) => {
      console.error('[Cron] Initial RSS fetch failed:', err.message);
    });
  }, 2 * 60 * 1000);

  // DEFERRED PROCESSOR: retry failed articles every 10 minutes
  console.log('[Cron] Deferred processor scheduled every 10 minutes');
  cron.schedule('*/10 * * * *', async () => {
    try {
      await processDeferredArticles();
    } catch (err: any) {
      console.error('[Cron] Deferred processor failed:', err.message);
    }
  });
}

