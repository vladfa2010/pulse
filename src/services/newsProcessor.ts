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
  console.log(`[NewsProcessor] Processing ${rawArticles.length} raw articles`);

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
    // НЕ throw — sentiment продолжает работать
    return;
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
      try {
        const results = await analyzeUnifiedBatch(
          chunk.map(({ article, originalIndex }) => ({
            title: (article as any).title_ru || article.title_original,
            summary: (article as any).summary_ru || article.summary_original,
            tags: matchedTagsList[originalIndex],
          }))
        );
        for (let j = 0; j < results.length && j < chunk.length; j++) {
          unifiedResults[chunk[j].originalIndex] = results[j];
        }
      } catch (err: any) {
        console.error('[NewsProcessor] Sentiment batch error:', err.message);
        for (const { originalIndex } of chunk) {
          unifiedResults[originalIndex] = {
            sentiment: 'neutral', score: 0, reasoning: '',
            is_political: false, article_type: 'micro',
            tag_impacts: matchedTagsList[originalIndex].map(t => ({ tag: t, score: 0, reasoning: '' })),
          } as UnifiedResult;
        }
      }
    }
  } else {
    // Fallback: keyword-based (no LLM)
    for (let i = 0; i < articles.length; i++) {
      if (!skipLLM.has(i)) {
        unifiedResults[i] = {
          sentiment: 'neutral', score: 0, reasoning: '',
          is_political: false, article_type: 'micro',
          tag_impacts: matchedTagsList[i].map(t => ({ tag: t, score: 0, reasoning: '' })),
        } as UnifiedResult;
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
            llm_attempts = $12
        WHERE id = $13
      `, [
        (a as any).title_ru,
        (a as any).summary_ru,
        s.sentiment,
        s.score,
        s.reasoning || null,
        (s as any)._llmErrorType || (s as any)._llmSource || 'llm',
        s.is_political,
        s.article_type || 'micro',
        matchedTagsList[i],
        JSON.stringify(s.tag_impacts || []),
        (s as any)._llmErrorMsg || null,
        (s as any)._llmErrorType ? 1 : null,
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
