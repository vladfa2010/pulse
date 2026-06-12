/**
 * News Processor — единое окно обработки (Layer 1 + Layer 2)
 * TZ: TZ_NEWS_PROCESSOR_v3
 *
 * Отвечает за:
 * - Перевод EN → RU (translateBatch)
 * - Sentiment analysis (analyzeUnifiedBatch)
 * - Tag matching (smartMatchTags)
 * - Tag impact + is_political
 *
 * НЕ отвечает за:
 * - Fetch (это NewsSourceManager)
 * - INSERT новостей (это adapters)
 */

import { query } from '../config/db';
import { translateBatch } from './translate';
import { smartMatchTags, analyzeUnifiedBatch, UnifiedResult } from './smartTagMatcher';

const INSTANCE_ID = `${process.env.HOSTNAME || 'unknown'}-${Date.now()}`;
const SQL_NOW = "NOW()";
const SQL_INTERVAL_10MIN = "NOW() + INTERVAL '10 minutes'";

interface RawArticle {
  id: string;
  title_original: string;
  summary_original: string;
  lang_original: string;
  source: string;
  source_id: string;
  content_hash: string;
  matched_tags: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN: processRawArticles()
// ═══════════════════════════════════════════════════════════════════════════
export async function processRawArticles(): Promise<void> {
  const acquired = await acquireCronLock('news-processor');
  if (!acquired) {
    console.log('[NewsProcessor] ⏳ Skip, another instance running');
    return;
  }

  try {
    await processRawArticlesLocked();
  } finally {
    await releaseCronLock('news-processor');
  }
}

async function processRawArticlesLocked(): Promise<void> {
  const BATCH_SIZE = 50;

  const rawArticles = await selectRawArticles(BATCH_SIZE);
  if (rawArticles.length === 0) {
    console.log('[NewsProcessor] No raw articles to process');
    return;
  }
  const enCount = rawArticles.filter(a => a.lang_original === 'en').length;
  const ruCount = rawArticles.filter(a => a.lang_original === 'ru').length;
  console.log(`[NewsProcessor] Processing ${rawArticles.length} articles (EN:${enCount}, RU:${ruCount})`);

  // 2. Translate — best effort, не блокирует sentiment
  try {
    await translateArticles(rawArticles);
  } catch (err: any) {
    console.log('[NewsProcessor] Translate skipped (API unavailable), continuing with sentiment');
  }

  // 3. Tag matching — ВСЕГДА
  const matchedTagsList = await matchTags(rawArticles);

  // 4. Sentiment analysis — ВСЕГДА, даже если translate упал
  const sentimentResults = await analyzeSentiment(rawArticles, matchedTagsList);

  // 5. UPDATE — needs_translation = FALSE
  await saveProcessedArticles(rawArticles, matchedTagsList, sentimentResults);

  console.log(`[NewsProcessor] Done: ${rawArticles.length} articles processed`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SELECT сырых статей
// ═══════════════════════════════════════════════════════════════════════════
async function selectRawArticles(limit: number): Promise<RawArticle[]> {
  const result = await query(`
    SELECT
      id, title_original, summary_original, lang_original,
      source, source_id, content_hash, matched_tags
    FROM news
    WHERE needs_translation = TRUE
       OR (matched_tags = '{}'::text[] AND sentiment_source IS NULL)
    ORDER BY published_at DESC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  `, [limit]);

  return result.rows.map(row => ({
    id: row.id,
    title_original: row.title_original,
    summary_original: row.summary_original,
    lang_original: row.lang_original,
    source: row.source,
    source_id: row.source_id,
    content_hash: row.content_hash,
    matched_tags: row.matched_tags || [],
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Translate (best effort — НЕ throw, НЕ блокирует sentiment)
// ═══════════════════════════════════════════════════════════════════════════
async function translateArticles(articles: RawArticle[]): Promise<void> {
  const toTranslate = articles.filter(a => a.lang_original === 'en' && !(a as any).title_ru);
  if (toTranslate.length === 0) return;

  try {
    const titles = toTranslate.map(a => a.title_original);
    const summaries = toTranslate.map(a => a.summary_original);

    const translatedTitles = await translateBatch(titles);
    const translatedSummaries = await translateBatch(summaries);

    for (let i = 0; i < toTranslate.length; i++) {
      (toTranslate[i] as any).title_ru = translatedTitles[i] || toTranslate[i].title_original;
      (toTranslate[i] as any).summary_ru = translatedSummaries[i] || toTranslate[i].summary_original;
    }
  } catch (err: any) {
    console.error('[NewsProcessor] Translate error:', err.message);
    // Записываем ошибку LLM для всех статей батча
    const errorMsg = err.message?.slice(0, 500) || 'Translate API error';
    for (const a of toTranslate) {
      (a as any)._llmError = errorMsg;
      (a as any)._llmAttempts = ((a as any)._llmAttempts || 0) + 1;
    }
    // НЕ throw — sentiment продолжает работать
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tag Matching
// ═══════════════════════════════════════════════════════════════════════════
async function matchTags(articles: RawArticle[]): Promise<string[][]> {
  const results: string[][] = [];
  for (const article of articles) {
    const title = (article as any).title_ru || article.title_original;
    const summary = (article as any).summary_ru || article.summary_original;
    const tags = await smartMatchTags(title, summary);
    const merged = [...new Set([...(article.matched_tags || []), ...tags])];
    results.push(merged);
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Sentiment Analysis (batch dedup — 1 запрос, не N)
// ═══════════════════════════════════════════════════════════════════════════
async function analyzeSentiment(
  articles: RawArticle[],
  matchedTagsList: string[][]
): Promise<UnifiedResult[]> {

  const llmAvailable = !!process.env.KIMI_API_KEY;
  const unifiedResults: UnifiedResult[] = new Array(articles.length);

  // Batch dedup: 1 запрос вместо N
  const skipLLM = new Set<number>();
  if (llmAvailable) {
    const contentHashes = articles.map(a => a.content_hash);
    const existingResult = await query(
      `SELECT content_hash, sentiment_reasoning, sentiment_source
       FROM news WHERE content_hash = ANY($1)`,
      [contentHashes]
    );
    const existingMap = new Map(existingResult.rows.map(r => [r.content_hash, r]));

    for (let i = 0; i < articles.length; i++) {
      const existing = existingMap.get(articles[i].content_hash);
      if (existing?.sentiment_reasoning &&
          (existing.sentiment_source === 'llm' || existing.sentiment_source === 'llm-partial')) {
        skipLLM.add(i);
        unifiedResults[i] = {
          sentiment: existing.sentiment || 'neutral',
          score: existing.sentiment_score || 0,
          reasoning: existing.sentiment_reasoning || '',
          is_political: existing.is_political || false,
          article_type: existing.article_type || 'micro',
          tag_impacts: matchedTagsList[i].map(t => ({ tag: t, score: 0, reasoning: '' })),
        } as UnifiedResult;
      }
    }
  }

  const needLLMWithIndex: { article: RawArticle; originalIndex: number }[] = [];
  for (let i = 0; i < articles.length; i++) {
    if (!skipLLM.has(i)) {
      needLLMWithIndex.push({ article: articles[i], originalIndex: i });
    }
  }

  if (llmAvailable && needLLMWithIndex.length > 0) {
    const BATCH_SIZE = 5;
    for (let batchStart = 0; batchStart < needLLMWithIndex.length; batchStart += BATCH_SIZE) {
      const chunk = needLLMWithIndex.slice(batchStart, batchStart + BATCH_SIZE);
      const batchStartTime = new Date().toISOString();
      let batchResults: UnifiedResult[] = [];
      try {
        batchResults = await analyzeUnifiedBatch(
          chunk.map(({ article, originalIndex }) => ({
            title: (article as any).title_ru || article.title_original,
            summary: (article as any).summary_ru || article.summary_original,
            tags: matchedTagsList[originalIndex],
          }))
        );
        for (let j = 0; j < batchResults.length && j < chunk.length; j++) {
          unifiedResults[chunk[j].originalIndex] = batchResults[j];
        }
      } catch (err: any) {
        console.error('[NewsProcessor] Sentiment batch error:', err.message);
        for (const { originalIndex } of chunk) {
          unifiedResults[originalIndex] = {
            sentiment: 'neutral', score: 0, reasoning: '',
            is_political: false, article_type: 'micro',
            tag_impacts: matchedTagsList[originalIndex].map(t => ({ tag: t, score: 0, reasoning: '' })),
            _llmErrorType: 'llm-error',
            _llmErrorMsg: err.message?.slice(0, 500),
          } as UnifiedResult;
        }
        batchResults = chunk.map(({ originalIndex }) => unifiedResults[originalIndex]);
      }

      // Log batch to llm_batches for metrics dashboard
      try {
        const llmSuccess = batchResults.filter(r => r.sentiment && !(r as any)._llmErrorType).length;
        const llmFailed = batchResults.filter(r => (r as any)._llmErrorType).length;
        const llmPartial = batchResults.filter(r => r.sentiment && (r as any)._llmErrorType).length;
        const errorTypes = batchResults
          .filter(r => (r as any)._llmErrorType)
          .reduce((acc: Record<string, number>, r) => {
            const type = (r as any)._llmErrorType || 'unknown';
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          }, {});

        await query(`
          INSERT INTO llm_batches (status, started_at, finished_at, articles_count, success_count, failed_count, partial_count, error_types)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          llmFailed > 0 ? (llmSuccess > 0 ? 'partial' : 'error') : 'success',
          batchStartTime,
          new Date().toISOString(),
          batchResults.length,
          llmSuccess,
          llmFailed,
          llmPartial,
          JSON.stringify(errorTypes),
        ]);
      } catch (logErr: any) {
        console.error('[NewsProcessor] llm_batches log error:', logErr.message);
      }
    }
  } else {
    // Fallback: keyword-based (no LLM)
    const keywordCount = articles.filter((_, i) => !skipLLM.has(i)).length;
    for (let i = 0; i < articles.length; i++) {
      if (!skipLLM.has(i)) {
        unifiedResults[i] = {
          sentiment: 'neutral', score: 0, reasoning: '',
          is_political: false, article_type: 'micro',
          tag_impacts: matchedTagsList[i].map(t => ({ tag: t, score: 0, reasoning: '' })),
        } as UnifiedResult;
      }
    }
    // Log keyword-only batch
    if (keywordCount > 0) {
      try {
        await query(`
          INSERT INTO llm_batches (status, started_at, finished_at, articles_count, success_count, failed_count, partial_count, error_types)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          'keyword-only',
          new Date().toISOString(),
          new Date().toISOString(),
          keywordCount,
          keywordCount,
          0,
          0,
          '{}',
        ]);
      } catch (logErr: any) {
        console.error('[NewsProcessor] llm_batches log error:', logErr.message);
      }
    }
  }

  return unifiedResults;
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE в БД (batch)
// ═══════════════════════════════════════════════════════════════════════════
async function saveProcessedArticles(
  articles: RawArticle[],
  matchedTagsList: string[][],
  sentimentResults: UnifiedResult[]
): Promise<void> {
  let updated = 0;

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const s = sentimentResults[i];

    // Определяем источник sentiment и LLM ошибки
    const translateError = (a as any)._llmError || null;
    const translateAttempts = (a as any)._llmAttempts || 0;
    const sentimentError = (s as any)._llmErrorMsg || null;
    const sentimentErrorType = (s as any)._llmErrorType || null;
    
    // sentiment_source: llm при успехе, keyword при fallback/ошибке
    let sentimentSource: string;
    if (translateError && !sentimentError) {
      // Translate упал, sentiment keyword-based
      sentimentSource = 'keyword';
    } else if (sentimentErrorType) {
      // Sentiment тоже упал
      sentimentSource = sentimentErrorType; // 'llm-error' etc
    } else {
      // Успех
      sentimentSource = (s as any)._llmSource || 'llm';
    }
    
    // LLM ошибка: translate или sentiment
    const llmError = translateError || sentimentError || null;
    const llmAttempts = translateAttempts + (sentimentErrorType ? 1 : 0);
    
    try {
      await query(`
        UPDATE news
        SET needs_translation = FALSE,
            title_ru = COALESCE($1, title_ru, title_original),
            summary_ru = COALESCE($2, summary_ru, summary_original),
            sentiment = $3,
            sentiment_score = $4,
            sentiment_reasoning = $5,
            sentiment_source = $6,
            is_political = $7,
            article_type = $8,
            matched_tags = $9,
            tag_impact = $10,
            llm_error = $11,
            llm_attempts = $12,
            llm_raw_preview = $13,
            llm_batch_size = $14,
            llm_results_count = $15
        WHERE id = $16
      `, [
        (a as any).title_ru,
        (a as any).summary_ru,
        s.sentiment,
        s.score,
        s.reasoning || null,
        sentimentSource,
        s.is_political,
        s.article_type || 'micro',
        matchedTagsList[i],
        JSON.stringify(s.tag_impacts || []),
        llmError,
        llmAttempts || null,
        (s as any)._llmRaw || null,
        (s as any)._llmBatchSize || null,
        (s as any)._llmResultsCount || null,
        a.id,
      ]);
      updated++;
    } catch (err: any) {
      console.error(`[NewsProcessor] UPDATE failed for ${a.id}:`, err.message);
    }
  }
  console.log(`[NewsProcessor] Updated: ${updated}/${articles.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Cron Lock (local copy — self-contained module)
// ═══════════════════════════════════════════════════════════════════════════
async function acquireCronLock(jobName: string): Promise<boolean> {
  try {
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
      console.log(`[CronLock] Acquired lock for "${jobName}"`);
    } else {
      console.log(`[CronLock] Lock "${jobName}" held by another instance`);
    }
    return acquired;
  } catch (err: any) {
    console.error(`[CronLock] Error: ${err.message?.slice(0, 100)}`);
    return false;
  }
}

async function releaseCronLock(jobName: string): Promise<void> {
  try {
    await query(`
      DELETE FROM cron_locks
      WHERE job_name = $1 AND locked_by = $2
    `, [jobName, INSTANCE_ID]);
    console.log(`[CronLock] Released lock for "${jobName}"`);
  } catch (err: any) {
    console.error(`[CronLock] Release error: ${err.message?.slice(0, 100)}`);
  }
}
