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
  console.log(`[Cron] LLM sentiment: ${llmAvailable ? 'ENABLED (batch x10)' : 'DISABLED (keyword-based)'}`);

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
  if (llmAvailable) {
    try {
      unifiedResults = await analyzeUnifiedBatch(
        articles.map((a, i) => ({
          title: a.title_ru || a.title,
          summary: a.summary_ru || a.summary,
          tags: matchedTagsList[i],
        }))
      );
    } catch (err: any) {
      console.error(`[Cron] Unified batch failed: ${err.message?.slice(0, 100)}`);
      unifiedResults = articles.map((a, i) => ({
        sentiment: 'neutral' as const, score: 0, reasoning: '', is_political: false,
        tag_impacts: matchedTagsList[i].map(t => ({ tag: t, impact: 'neutral' as const, reasoning: '' })),
      }));
    }
  } else {
    unifiedResults = articles.map((a, i) => ({
      sentiment: 'neutral' as const, score: 0, reasoning: '', is_political: false,
      tag_impacts: matchedTagsList[i].map(t => ({ tag: t, impact: 'neutral' as const, reasoning: '' })),
    }));
  }
  console.log(`[Cron] Unified batch done: ${unifiedResults.length} results in ${Date.now() - unifiedStart}ms`);

  // 3d. Merge all results
  processed = [];
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const u = unifiedResults[i] || { sentiment: 'neutral' as const, score: 0, reasoning: '', is_political: false, tag_impacts: [] };

    processed.push({
      ...a,
      title_ru: a.title_ru || a.title,
      summary_ru: a.summary_ru || a.summary,
      sentiment: u.sentiment,
      sentiment_score: u.score,
      sentiment_reasoning: u.reasoning || null,
      sentiment_source: llmAvailable ? 'llm' as const : 'keyword' as const,
      is_political: u.is_political,
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
            await query('UPDATE news SET all_sources = ?, source_count = ? WHERE id = ?',
              [JSON.stringify(sources), sources.length, existing.rows[0].id]);
            merged++;
          }
        } else {
          // Новая новость
          const newId = crypto.randomUUID();
          await query(
            `INSERT OR IGNORE INTO news (id, title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, all_sources, source_count, published_at, lang_original, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, matched_tags, tag_impact)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [newId, a.title, title_ru, summary_ru, a.source, a.sourceId, a.url, urlNormalized, contentHash, JSON.stringify([a.source]), 1, a.publishedAt.toISOString(), a.lang, a.sentiment, a.sentiment_score, a.sentiment_reasoning, a.sentiment_source, a.is_political ? 1 : 0, JSON.stringify(a.matched_tags || []), JSON.stringify(a.tag_impact || [])]
          );
          saved++;
          // Broadcast to SSE subscribers
          broadcastNews({ id: newId, title_ru, summary_ru, source: a.source, published_at: a.publishedAt, sentiment: a.sentiment, matched_tags: a.matched_tags, url: a.url });
        }
      } else {
        // PostgreSQL: INSERT с ON CONFLICT (content_hash) DO UPDATE
        // Ключевой момент: дубликат по content_hash → добавляем источник, НЕ создаём новую запись
        const result = await query(
          `INSERT INTO news (title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, all_sources, source_count, published_at, lang_original, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, matched_tags, tag_impact)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
           ON CONFLICT (content_hash) DO UPDATE
             SET all_sources = CASE
               WHEN news.all_sources @> ARRAY[EXCLUDED.source]::text[] THEN news.all_sources
               ELSE array_append(news.all_sources, EXCLUDED.source)
             END,
             source_count = CASE
               WHEN news.all_sources @> ARRAY[EXCLUDED.source]::text[] THEN news.source_count
               ELSE news.source_count + 1
             END
           RETURNING (xmax = 0) as is_insert`,
          [a.title, title_ru, summary_ru, a.source, a.sourceId, a.url, urlNormalized, contentHash, [a.source], 1, a.publishedAt, a.lang, a.sentiment, a.sentiment_score, a.sentiment_reasoning, a.sentiment_source, a.is_political, a.matched_tags || [], JSON.stringify(a.tag_impact || [])]
        );

        if (result.rows.length > 0 && result.rows[0].is_insert === true) {
          saved++;      // Новая запись
          // Broadcast to SSE subscribers
          broadcastNews({ id: result.rows[0].id || null, title_ru, summary_ru, source: a.source, published_at: a.publishedAt, sentiment: a.sentiment, matched_tags: a.matched_tags, url: a.url });
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

const LOCK_TTL_MINUTES = 15; // Lock auto-expires after 15 min (cron runs in ~2-3 min, 15 = safety margin)
const INSTANCE_ID = `${process.env.RENDER_INSTANCE_ID || 'local'}-${process.pid}-${Date.now()}`;

// PostgreSQL vs SQLite datetime helpers (for cron lock SQL)
const IS_SQLITE = process.env.USE_SQLITE === 'true';
const SQL_NOW = IS_SQLITE ? "datetime('now')" : 'NOW()';
const SQL_INTERVAL_15MIN = IS_SQLITE
  ? "datetime('now', '+15 minutes')"
  : "NOW() + INTERVAL '15 minutes'";

async function acquireCronLock(jobName: string): Promise<boolean> {
  try {
    // Try to acquire: either the lock is free OR expired
    const result = await query(`
      INSERT INTO cron_locks (job_name, locked_at, locked_by, expires_at)
      VALUES ($1, ${SQL_NOW}, $2, ${SQL_INTERVAL_15MIN})
      ON CONFLICT (job_name) DO UPDATE
        SET locked_at = ${SQL_NOW},
            locked_by = EXCLUDED.locked_by,
            expires_at = ${SQL_INTERVAL_15MIN}
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
// Start cron: every 15 minutes (first run delayed by 2 min)
// ═══════════════════════════════════════════════════════════════════════════
export function startCron() {
  console.log('[Cron] RSS aggregator scheduled every 15 minutes');

  cron.schedule('*/15 * * * *', async () => {
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
}
