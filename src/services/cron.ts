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
import { query } from '../config/db';
import { normalizeUrl } from '../utils/normalizeUrl';
import crypto from 'crypto';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

import { populateNewsTagLinksBatch, EnrichmentTask } from './enrichment';
import { broadcastNews } from './sse';
import { analyzeUnifiedBatch, UnifiedResult } from './smartTagMatcher';

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
  // 0. Check if any RSS sources are enabled — before acquiring lock
  try {
    const { query } = await import('../config/db');
    const enabledResult = await query(`
      SELECT COUNT(*) as count FROM news_sources WHERE type = 'rss' AND enabled = true
    `);
    if (parseInt(enabledResult.rows[0].count) === 0) {
      console.log('[Cron] No RSS sources enabled, skipping (no lock needed)');
      return;
    }
  } catch {
    // If query fails, continue to lock attempt
  }

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
  // Cleanup zombie records: finished_at=null older than 15 min = dead processes
  if (!USE_SQLITE) {
    try {
      const cleanup = await query(
        `DELETE FROM cron_log 
         WHERE finished_at IS NULL 
           AND started_at < NOW() - INTERVAL '15 minutes'
         RETURNING id`
      );
      if (cleanup.rows.length > 0) {
        console.log(`[Cron] Cleaned up ${cleanup.rows.length} zombie records`);
      }
    } catch {
      // Silent fail — cleanup is best-effort
    }
  }

  const logId = await logCronStart('rss');
  const errors: string[] = [];
  let articles: any[] = [];
  let saved = 0;
  let merged = 0;

  try {
    console.log('[Cron] Starting RSS fetch at', new Date().toISOString());

    // 1. Fetch RSS — только enabled источники из news_sources
    try {
      const enabledResult = await query(`
        SELECT name, config->>'url' as url, config->>'lang' as lang, config->>'category' as category
        FROM news_sources
        WHERE type = 'rss' AND enabled = true
      `);
      if (enabledResult.rows.length === 0) {
        console.log('[Cron] No RSS sources enabled, skipping');
        return;
      }
      const { RSS_SOURCES } = await import('./rssSources');
      const enabledNames = new Set(enabledResult.rows.map((r: any) => r.name));
      const enabledSources = RSS_SOURCES.filter(s => enabledNames.has(s.id));
      console.log(`[Cron] ${enabledSources.length}/${RSS_SOURCES.length} RSS sources enabled`);

      articles = await fetchAllRSS(enabledSources);
    } catch (err: any) {
      console.error('[Cron] RSS fetch failed:', err.message);
      errors.push(`fetch: ${err.message}`);
      return;
    }

    // Limit to 100 freshest articles per run
    articles = articles
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
      .slice(0, 100);

    console.log(`[Cron] Fetched ${articles.length} articles (limited to 100 freshest)`);

    if (articles.length === 0) {
      console.warn('[Cron] ⚠️ ZERO articles fetched from ALL sources');
      errors.push('zero_articles: No articles fetched from any source');
      return;
    }

    // Update fetched count immediately
    await query(`UPDATE cron_log SET articles_fetched = $1 WHERE id = $2`, [articles.length, logId]);

    // 2. Save to DB — СЫРЫЕ (title_ru=null, sentiment=null, needs_translation=TRUE)
    // News Processor (Layer 1+2) обработает позже: translate → sentiment → tags
    saved = 0;
    merged = 0;
    const enrichmentTasks: EnrichmentTask[] = [];

    for (const a of articles) {
      try {
        const urlNormalized = normalizeUrl(a.url || '');
        const contentHash = crypto.createHash('md5').update(`${a.title}_${a.summary || ''}`.slice(0, 500)).digest('hex');

        if (USE_SQLITE) {
          // SQLite: проверяем content_hash → UPDATE или INSERT
          const existing = await query('SELECT id, all_sources FROM news WHERE content_hash = ? LIMIT 1', [contentHash]);
          if (existing.rows.length > 0) {
            // Дубликат — добавляем источник если новый
            const sources: string[] = JSON.parse(existing.rows[0].all_sources || '[]');
            if (!sources.includes(a.source)) {
              sources.push(a.source);
              await query(
                `UPDATE news SET all_sources = ?, source_count = ? WHERE id = ?`,
                [JSON.stringify(sources), sources.length, existing.rows[0].id]
              );
              merged++;
            }
          } else {
            // Новая новость — СЫРАЯ (title_ru=null, sentiment=null, needs_translation=1)
            const newId = crypto.randomUUID();
            await query(
              `INSERT OR IGNORE INTO news (id, title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, all_sources, source_count, published_at, lang_original, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, llm_error, llm_attempts, llm_raw_preview, llm_batch_size, llm_results_count, is_political, article_type, matched_tags, tag_impact, needs_translation)
               VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '[]', '[]', 1)`,
              [newId, a.title, a.source, a.sourceId, a.url, urlNormalized, contentHash, JSON.stringify([a.source]), 1, a.publishedAt.toISOString(), a.lang]
            );
            saved++;
            broadcastNews({ id: newId, title_ru: a.title, summary_ru: a.summary || '', source: a.source, published_at: a.publishedAt, sentiment: null, matched_tags: [], url: a.url });
          }
        } else {
          // PostgreSQL: INSERT с ON CONFLICT (content_hash) DO UPDATE
          const result = await query(
            `INSERT INTO news (title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, all_sources, source_count, published_at, lang_original, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, llm_error, llm_attempts, llm_raw_preview, llm_batch_size, llm_results_count, is_political, article_type, matched_tags, tag_impact, needs_translation)
             VALUES ($1, NULL, NULL, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}'::text[], '[]'::jsonb, TRUE)
             ON CONFLICT (content_hash) DO UPDATE
               SET all_sources = CASE
                 WHEN news.all_sources @> ARRAY[EXCLUDED.source]::text[] THEN news.all_sources
                 ELSE array_append(news.all_sources, EXCLUDED.source)
               END,
               source_count = CASE
                 WHEN news.all_sources @> ARRAY[EXCLUDED.source]::text[] THEN news.source_count
                 ELSE news.source_count + 1
               END
             RETURNING id, (xmax = 0) as is_insert`,
            [a.title, a.source, a.sourceId, a.url, urlNormalized, contentHash, [a.source], 1, a.publishedAt, a.lang]
          );

          if (result.rows.length > 0 && result.rows[0].is_insert === true) {
            saved++;
            const newsId = result.rows[0].id;
            broadcastNews({ id: newsId || null, title_ru: a.title, summary_ru: a.summary || '', source: a.source, published_at: a.publishedAt, sentiment: null, matched_tags: [], url: a.url });

            // Batch enrichment placeholder (tags will be populated by News Processor)
            enrichmentTasks.push({
              newsId,
              matchedTags: [],
              tagImpacts: [],
            });
          } else {
            merged++;
          }
        }
      } catch (e: any) {
        console.error(`[Cron] Save error for article "${a.title?.slice(0, 40)}": ${e.message?.slice(0, 100)}`);
      }
    }

    console.log(`[Cron] Saved ${saved} new, merged ${merged} duplicates (total ${articles.length})`);

  } catch (err: any) {
    console.error(`[Cron] Fatal error in processArticlesLocked: ${err.message}`);
    errors.push(`fatal: ${err.message}`);
  } finally {
    await logCronFinish(logId, articles.length, saved, merged, errors);
    console.log(`[Cron] Finished. Logged: ${articles.length} fetched, ${saved} saved, ${merged} merged, ${errors.length} errors`);
  }
}

const LOCK_TTL_MINUTES = 10;
const INSTANCE_ID = `${process.env.RENDER_INSTANCE_ID || 'local'}-${process.pid}-${Date.now()}`;

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
