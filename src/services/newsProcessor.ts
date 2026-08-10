/**
 * News Processor — единое окно обработки (Layer 1 + Layer 2)
 * TZ: TZ-31 v5
 *
 * Отвечает за:
 * - Перевод EN → RU (translateBatch)
 * - Sentiment analysis (analyzeUnifiedBatch)
 * - Tag matching (smartMatchTagsBatch)
 * - Tag impact + is_political
 *
 * НЕ отвечает за:
 * - Fetch (это NewsSourceManager)
 * - INSERT новостей (это adapters)
 */

import { query } from '../config/db';
import { translateBatch } from './translate';
import { smartMatchTagsBatch, analyzeUnifiedBatch, UnifiedResult, matchTagsByKeywords } from './smartTagMatcher';
import { getAllTagNames } from './tagManager';
import { sendNewArticlePush } from './push';
import { slugify } from '../utils/slugify';
import { populateNewsTagLinksBatch, EnrichmentTask } from './enrichment';

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
// AbortController state for graceful shutdown
// ═══════════════════════════════════════════════════════════════════════════
let currentController: AbortController | null = null;
let processorShuttingDown = false;

export function markProcessorShutdown(): void {
  processorShuttingDown = true;
  currentController?.abort();
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN: processRawArticles()
// ═══════════════════════════════════════════════════════════════════════════
export async function processRawArticles(): Promise<void> {
  if (processorShuttingDown) {
    console.log('[Processor] shutdown in progress, run skipped');
    return;
  }

  const acquired = await acquireCronLock('news-processor');
  if (!acquired) {
    console.log('[NewsProcessor] ⏳ Skip, another instance running');
    return;
  }

  const controller = new AbortController();
  currentController = controller;

  try {
    await processRawArticlesLocked(controller.signal);
  } finally {
    if (currentController === controller) {
      currentController = null;
    }
    await releaseCronLock('news-processor');
  }
}

const PROCESSOR_BATCH_SIZE = 15;
const CHUNK_SIZE = 5;

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

async function processRawArticlesLocked(signal: AbortSignal): Promise<void> {
  const startAt = Date.now();

  try {
    const rawArticles = await selectRawArticles(PROCESSOR_BATCH_SIZE);
    if (rawArticles.length === 0) {
      console.log('[NewsProcessor] No raw articles to process');
      return;
    }

    const enCount = rawArticles.filter(a => a.lang_original === 'en').length;
    const ruCount = rawArticles.filter(a => a.lang_original === 'ru').length;
    console.log(`[NewsProcessor] Processing ${rawArticles.length} articles (EN:${enCount}, RU:${ruCount})`);

    // 1. Fast keyword pre-filter on ORIGINAL text — 0 tokens.
    //    Only articles with at least one user-defined tag go through LLM.
    const withTags: RawArticle[] = [];
    const withoutTags: RawArticle[] = [];

    for (const article of rawArticles) {
      const hasPreMatched = (article.matched_tags || []).length > 0;
      let keywordTags: string[] = [];
      if (!hasPreMatched) {
        const text = `${article.title_original || ''} ${article.summary_original || ''}`;
        keywordTags = await matchTagsByKeywords(text);
      }

      if (hasPreMatched || keywordTags.length > 0) {
        (article as any)._keywordTags = [...new Set([...(article.matched_tags || []), ...keywordTags])];
        withTags.push(article);
      } else {
        withoutTags.push(article);
      }
    }

    console.log(`[NewsProcessor] Tag pre-filter: withTags=${withTags.length}, withoutTags=${withoutTags.length}`);

    // 2. Articles WITH tags: process in chunks of 5 (checkpoint pattern)
    if (withTags.length > 0) {
      const availableTags = await getAllTagNames();

      let chunkIndex = 0;
      const totalChunks = Math.ceil(withTags.length / CHUNK_SIZE);

      for (const chunk of chunks(withTags, CHUNK_SIZE)) {
        chunkIndex++;
        const chunkStart = Date.now();
        let translateMs = 0;
        let tagsMs = 0;
        let sentimentMs = 0;
        let saveMs = 0;

        try {
          // Translate — best effort, не блокирует sentiment
          const translateStart = Date.now();
          try {
            await translateArticles(chunk, signal);
          } catch (err: any) {
            if (isAbortError(err)) {
              console.log('[NewsProcessor] Translate aborted (shutdown)');
              throw err;
            }
            console.log('[NewsProcessor] Translate skipped (API unavailable), continuing with sentiment');
          }
          translateMs = Date.now() - translateStart;

          // Tag matching — Layer 1 + Layer 2 (batch LLM)
          const tagsStart = Date.now();
          const matchedTagsList = await matchTagsWithLLM(chunk, availableTags, signal);
          tagsMs = Date.now() - tagsStart;

          // Sentiment analysis — для статей с тегами
          const sentimentStart = Date.now();
          const sentimentResults = await analyzeSentiment(chunk, matchedTagsList, signal);
          sentimentMs = Date.now() - sentimentStart;

          // Bulk UPDATE
          const saveStart = Date.now();
          await saveProcessedArticles(chunk, matchedTagsList, sentimentResults);
          saveMs = Date.now() - saveStart;

          // Enrichment: news_tag_links (fire-and-forget)
          const tasks: EnrichmentTask[] = chunk.map((a, i) => ({
            newsId: a.id,
            matchedTags: matchedTagsList[i],
            tagImpacts: (a as any)._tagImpacts ?? [],
          }));
          void populateNewsTagLinksBatch(tasks).catch(err =>
            console.warn('[Enrichment] news_tag_links write failed (non-fatal):', err.message));

        } catch (err: any) {
          if (isAbortError(err)) {
            console.log('[NewsProcessor] Chunk aborted (shutdown)');
            throw err;
          }
          console.error(`[NewsProcessor] Chunk ${chunkIndex}/${totalChunks} failed:`, err.message);
          // Continue with next chunk rather than killing whole run
          continue;
        }

        console.log(`[Processor] chunk ${chunkIndex}/${totalChunks}: translate=${translateMs}ms tags=${tagsMs}ms sentiment=${sentimentMs}ms save=${saveMs}ms`);
      }
    }

    // 3. Articles WITHOUT tags: save raw, skip all LLM. Rechecked when new tags are added.
    if (withoutTags.length > 0) {
      await markNoTags(withoutTags);
    }

    const duration = Date.now() - startAt;
    console.log(`[NewsProcessor] Done: ${rawArticles.length} articles processed in ${duration}ms`);
  } catch (err: any) {
    if (isAbortError(err)) {
      console.log('[NewsProcessor] Run aborted (shutdown)');
      return;
    }
    console.error('[NewsProcessor] Fatal error in processRawArticlesLocked:', err.message?.slice(0, 200));
    throw err;
  }
}

function isAbortError(err: any): boolean {
  return err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED' || err?.message?.includes('aborted');
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
       OR (
         lang_original = 'en'
         AND (title_ru IS NULL OR title_ru = title_original)
         AND sentiment_source IS NOT NULL
         AND COALESCE(llm_attempts, 0) < 3
       )
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
async function translateArticles(articles: RawArticle[], signal: AbortSignal): Promise<void> {
  const toTranslate = articles.filter(
    a => a.lang_original === 'en' &&
         (!((a as any).title_ru) || (a as any).title_ru === a.title_original)
  );
  if (toTranslate.length === 0) return;

  try {
    const titles = toTranslate.map(a => a.title_original);
    const summaries = toTranslate.map(a => a.summary_original);

    const translatedTitles = await translateBatch(titles, signal);
    const translatedSummaries = await translateBatch(summaries, signal);

    for (let i = 0; i < toTranslate.length; i++) {
      const a = toTranslate[i];
      const translatedTitle = translatedTitles[i];
      const translatedSummary = translatedSummaries[i];

      if (translatedTitle && translatedTitle !== a.title_original) {
        (a as any).title_ru = translatedTitle;
      } else {
        // Mark as failed so the article will be retried
        (a as any)._llmError = translatedTitle === a.title_original
          ? 'Translation returned original title (parse issue)'
          : 'Translation returned empty title';
        (a as any)._llmAttempts = ((a as any)._llmAttempts || 0) + 1;
      }

      if (translatedSummary && translatedSummary !== a.summary_original) {
        (a as any).summary_ru = translatedSummary;
      }
    }
  } catch (err: any) {
    if (isAbortError(err)) throw err;
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
// Tag Matching (Layer 1 + Layer 2 LLM, batch mode)
// ═══════════════════════════════════════════════════════════════════════════
async function matchTagsWithLLM(
  articles: RawArticle[],
  availableTags: string[],
  signal: AbortSignal
): Promise<string[][]> {
  const items = articles.map(a => ({
    title: (a as any).title_ru || a.title_original || '',
    summary: (a as any).summary_ru || a.summary_original || '',
    keywordTags: (a as any)._keywordTags || [],
  }));

  const results = await smartMatchTagsBatch(items, { availableTags, signal });

  return results.map((tags, i) => {
    const a = articles[i];
    return [...new Set([...((a as any)._keywordTags || []), ...tags])];
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Sentiment Analysis (batch dedup — 1 запрос, не N)
// ═══════════════════════════════════════════════════════════════════════════
async function analyzeSentiment(
  articles: RawArticle[],
  matchedTagsList: string[][],
  signal: AbortSignal
): Promise<UnifiedResult[]> {

  const llmAvailable = !!process.env.KIMI_API_KEY;
  const unifiedResults: UnifiedResult[] = new Array(articles.length);

  // Batch dedup: 1 запрос вместо N
  const skipLLM = new Set<number>();
  if (llmAvailable) {
    const contentHashes = articles.map(a => a.content_hash);
    const existingResult = await query(
      `SELECT content_hash, sentiment_reasoning, sentiment_source
       FROM news WHERE content_hash = ANY($1::text[])`,
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
    for (let batchStart = 0; batchStart < needLLMWithIndex.length; batchStart += CHUNK_SIZE) {
      if (signal.aborted) {
        console.warn('[NewsProcessor] analyzeSentiment: aborted, falling back to neutral');
        for (const { originalIndex } of needLLMWithIndex.slice(batchStart)) {
          unifiedResults[originalIndex] = {
            sentiment: 'neutral', score: 0, reasoning: '',
            is_political: false, article_type: 'micro',
            tag_impacts: matchedTagsList[originalIndex].map(t => ({ tag: t, score: 0, reasoning: '' })),
            _llmErrorType: 'llm-error',
          } as UnifiedResult;
        }
        break;
      }

      const chunk = needLLMWithIndex.slice(batchStart, batchStart + CHUNK_SIZE);
      const batchStartTime = new Date().toISOString();
      let batchResults: UnifiedResult[] = [];
      try {
        batchResults = await analyzeUnifiedBatch(
          chunk.map(({ article, originalIndex }) => ({
            title: (article as any).title_ru || article.title_original || '',
            summary: (article as any).summary_ru || article.summary_original || '',
            tags: matchedTagsList[originalIndex],
          })),
          signal
        );
      } catch (err: any) {
        if (isAbortError(err)) {
          console.log('[NewsProcessor] Sentiment batch aborted (shutdown)');
          throw err;
        }
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

      // Fill results and propagate tag impacts
      for (let j = 0; j < batchResults.length && j < chunk.length; j++) {
        unifiedResults[chunk[j].originalIndex] = batchResults[j];
        (chunk[j].article as any)._tagImpacts = batchResults[j].tag_impacts || [];
      }

      // Task 8: short response fill
      if (batchResults.length < chunk.length) {
        console.warn(`[NewsProcessor] Sentiment batch short: ${batchResults.length}/${chunk.length}, neutral-fill для остатка`);
        for (let j = batchResults.length; j < chunk.length; j++) {
          const { originalIndex } = chunk[j];
          unifiedResults[originalIndex] = {
            sentiment: 'neutral', score: 0, reasoning: '',
            is_political: false, article_type: 'micro',
            tag_impacts: matchedTagsList[originalIndex].map(t => ({ tag: t, score: 0, reasoning: '' })),
            _llmErrorType: 'llm-error',
          } as UnifiedResult;
        }
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
// UPDATE в БД (bulk with per-article fallback)
// ═══════════════════════════════════════════════════════════════════════════
const ROW_COLS = [
  ['title_ru', 'text'], ['summary_ru', 'text'], ['sentiment', 'text'],
  ['sentiment_score', 'int'], ['sentiment_reasoning', 'text'], ['sentiment_source', 'text'],
  ['is_political', 'boolean'], ['article_type', 'text'], ['matched_tags', 'text[]'],
  ['tag_impact', 'jsonb'], ['llm_error', 'text'], ['llm_attempts', 'int'],
  ['llm_raw_preview', 'text'], ['llm_batch_size', 'int'], ['llm_results_count', 'int'],
  ['id', 'uuid'], ['needs_translation', 'boolean'], ['slug', 'text'],
] as const;

async function saveProcessedArticles(
  articles: RawArticle[],
  matchedTagsList: string[][],
  sentimentResults: UnifiedResult[]
): Promise<void> {
  const rows: any[][] = [];

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const s = sentimentResults[i];

    // Guard: missing sentiment result (batch mismatch)
    if (!s) {
      console.error(`[NewsProcessor] Missing sentiment for ${a.id}, skipping UPDATE`);
      continue;
    }

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

    // If English title was not translated, keep needs_translation = TRUE for retry
    const titleRu = (a as any).title_ru;
    const isTranslationSuccessful = a.lang_original !== 'en' || (!!titleRu && titleRu !== a.title_original);

    // Generate slug once and freeze it (do not overwrite existing slug)
    const slug = slugify(a.title_original || (a as any).title_ru || 'news', a.id);

    rows.push([
      (a as any).title_ru ?? null,
      (a as any).summary_ru ?? null,
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
      !isTranslationSuccessful,
      slug,
    ]);
  }

  if (rows.length === 0) return;

  try {
    const placeholders = rows.map((_, r) => {
      const base = r * ROW_COLS.length;
      return `(${ROW_COLS.map(([, t], i) => `$${base + i + 1}${t ? '::' + t : ''}`).join(', ')})`;
    }).join(', ');

    const params = rows.flat();

    await query(`
      UPDATE news AS n SET
        needs_translation = v.needs_translation,
        title_ru = COALESCE(v.title_ru, n.title_ru, n.title_original),
        summary_ru = COALESCE(v.summary_ru, n.summary_ru, n.summary_original),
        sentiment = v.sentiment,
        sentiment_score = v.sentiment_score,
        sentiment_reasoning = v.sentiment_reasoning,
        sentiment_source = v.sentiment_source,
        is_political = v.is_political,
        article_type = v.article_type,
        matched_tags = v.matched_tags,
        tag_impact = v.tag_impact,
        llm_error = v.llm_error,
        llm_attempts = v.llm_attempts,
        llm_raw_preview = v.llm_raw_preview,
        llm_batch_size = v.llm_batch_size,
        llm_results_count = v.llm_results_count,
        slug = COALESCE(n.slug, v.slug)
      FROM (VALUES ${placeholders}) AS v(
        title_ru, summary_ru, sentiment, sentiment_score, sentiment_reasoning,
        sentiment_source, is_political, article_type, matched_tags, tag_impact,
        llm_error, llm_attempts, llm_raw_preview, llm_batch_size, llm_results_count,
        id, needs_translation, slug
      )
      WHERE n.id = v.id
    `, params);

    console.log(`[NewsProcessor] Bulk updated: ${rows.length}/${articles.length}`);

    // Immediate push for users subscribed to matched tags
    for (let i = 0; i < articles.length; i++) {
      const a = articles[i];
      if (matchedTagsList[i].length > 0) {
        const pushTitle = (a as any).title_ru || a.title_original || 'PULSE — новая новость';
        sendNewArticlePush(a.id, pushTitle, a.source, matchedTagsList[i]).catch(err => {
          console.error(`[NewsProcessor] sendNewArticlePush failed for ${a.id}:`, err.message);
        });
      }
    }
  } catch (err: any) {
    console.error('[NewsProcessor] bulk update failed, falling back to per-article:', err.message);
    await saveProcessedArticlesPerArticle(articles, matchedTagsList, sentimentResults);
  }
}

async function saveProcessedArticlesPerArticle(
  articles: RawArticle[],
  matchedTagsList: string[][],
  sentimentResults: UnifiedResult[]
): Promise<void> {
  let updated = 0;

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const s = sentimentResults[i];

    if (!s) {
      console.error(`[NewsProcessor] Missing sentiment for ${a.id}, skipping UPDATE`);
      continue;
    }

    const translateError = (a as any)._llmError || null;
    const translateAttempts = (a as any)._llmAttempts || 0;
    const sentimentError = (s as any)._llmErrorMsg || null;
    const sentimentErrorType = (s as any)._llmErrorType || null;

    let sentimentSource: string;
    if (translateError && !sentimentError) {
      sentimentSource = 'keyword';
    } else if (sentimentErrorType) {
      sentimentSource = sentimentErrorType;
    } else {
      sentimentSource = (s as any)._llmSource || 'llm';
    }

    const llmError = translateError || sentimentError || null;
    const llmAttempts = translateAttempts + (sentimentErrorType ? 1 : 0);

    const titleRu = (a as any).title_ru;
    const isTranslationSuccessful = a.lang_original !== 'en' || (!!titleRu && titleRu !== a.title_original);
    const slug = slugify(a.title_original || (a as any).title_ru || 'news', a.id);

    try {
      await query(`
        UPDATE news
        SET needs_translation = $17,
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
            llm_results_count = $15,
            slug = COALESCE(news.slug, $18)
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
        !isTranslationSuccessful,
        slug,
      ]);
      updated++;

      if (matchedTagsList[i].length > 0) {
        const pushTitle = (a as any).title_ru || a.title_original || 'PULSE — новая новость';
        sendNewArticlePush(a.id, pushTitle, a.source, matchedTagsList[i]).catch(err => {
          console.error(`[NewsProcessor] sendNewArticlePush failed for ${a.id}:`, err.message);
        });
      }
    } catch (err: any) {
      console.error(`[NewsProcessor] UPDATE failed for ${a.id}:`, err.message);
    }
  }
  console.log(`[NewsProcessor] Per-article updated: ${updated}/${articles.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// No-tags: save raw, skip all LLM. Rechecked when new tags are added.
// ═══════════════════════════════════════════════════════════════════════════
async function markNoTags(articles: RawArticle[]): Promise<void> {
  let updated = 0;
  for (const a of articles) {
    const slug = slugify(a.title_original || (a as any).title_ru || 'news', a.id);
    try {
      await query(`
        UPDATE news
        SET needs_translation = FALSE,
            sentiment_source = 'no-tags',
            sentiment = NULL,
            sentiment_score = NULL,
            sentiment_reasoning = NULL,
            matched_tags = '{}',
            tag_impact = '[]',
            is_political = FALSE,
            article_type = 'micro',
            llm_error = NULL,
            llm_attempts = NULL,
            llm_raw_preview = NULL,
            llm_batch_size = NULL,
            llm_results_count = NULL,
            slug = COALESCE(news.slug, $2)
        WHERE id = $1
      `, [a.id, slug]);
      updated++;
    } catch (err: any) {
      console.error(`[NewsProcessor] markNoTags failed for ${a.id}:`, err.message);
    }
  }
  console.log(`[NewsProcessor] Marked no-tags: ${updated}/${articles.length}`);
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
    await query('DELETE FROM cron_locks WHERE job_name = $1 AND locked_by = $2', [jobName, INSTANCE_ID]);
    console.log(`[CronLock] Released lock for "${jobName}"`);
  } catch (err: any) {
    console.error(`[CronLock] Release error: ${err.message?.slice(0, 100)}`);
  }
}

/*
═══════════════════════════════════════════════════════════════════════════════
LEGACY PIPELINE — commented out 2026-06-18
Old flow: translate -> tag matching -> sentiment for ALL articles.
Preserved for reference / rollback.
═══════════════════════════════════════════════════════════════════════════════

async function processRawArticlesLocked_LEGACY(): Promise<void> {
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
*/
