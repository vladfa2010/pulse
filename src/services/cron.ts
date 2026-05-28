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
import { smartMatchTags, analyzeSentimentLLM, analyzeTagImpact, TagImpact } from './smartTagMatcher';

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
  const logId = await logCronStart('rss');
  const errors: string[] = [];
  console.log('[Cron] Starting RSS fetch at', new Date().toISOString());

  // 1. Fetch RSS (с защитой от ошибок)
  let articles: any[] = [];
  try {
    articles = await fetchAllRSS();
  } catch (err: any) {
    console.error('[Cron] RSS fetch failed:', err.message);
    return;
  }

  console.log(`[Cron] Fetched ${articles.length} articles`);

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
  console.log(`[Cron] LLM sentiment: ${llmAvailable ? 'ENABLED' : 'DISABLED (keyword-based)'}`);

  // Analyze sentiment + smart tag matching
  const processed = [];
  for (const a of articles) {
    const title_ru = a.title_ru || a.title;
    const summary_ru = a.summary_ru || a.summary;
    const text = `${title_ru} ${summary_ru}`;

    // Sentiment: LLM if key exists, otherwise keyword-based (fast, no timeouts)
    let sentiment: 'positive' | 'negative' | 'neutral';
    let sentiment_source: 'llm' | 'keyword';
    if (llmAvailable) {
      try {
        sentiment = await analyzeSentimentLLM(title_ru, summary_ru);
        sentiment_source = 'llm';
      } catch {
        sentiment = analyzeSentiment(text);
        sentiment_source = 'keyword';
      }
    } else {
      sentiment = analyzeSentiment(text);
      sentiment_source = 'keyword';
    }

    // Smart matching: keywords → LLM → related tags
    const matched_tags = await smartMatchTags(title_ru, summary_ru);

    // Tag impact: LLM only if key exists
    let tag_impact: TagImpact[] = [];
    if (llmAvailable && matched_tags.length > 0) {
      try {
        tag_impact = await analyzeTagImpact(title_ru, summary_ru, matched_tags);
      } catch {
        tag_impact = matched_tags.map(t => ({ tag: t, impact: 'neutral' as const, reasoning: '' }));
      }
    }

    processed.push({
      ...a,
      title_ru,
      summary_ru,
      sentiment,
      sentiment_source,
      matched_tags,
      tag_impact,
    });
  }

  // 4. Save to DB (с защитой от дубликатов по content_hash)
  let saved = 0;
  let merged = 0;

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
          await query(
            `INSERT OR IGNORE INTO news (id, title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, all_sources, source_count, published_at, lang_original, sentiment, sentiment_source, matched_tags, tag_impact)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [crypto.randomUUID(), a.title, title_ru, summary_ru, a.source, a.sourceId, a.url, urlNormalized, contentHash, JSON.stringify([a.source]), 1, a.publishedAt.toISOString(), a.lang, a.sentiment, a.sentiment_source, JSON.stringify(a.matched_tags || []), JSON.stringify(a.tag_impact || [])]
          );
          saved++;
        }
      } else {
        // PostgreSQL: INSERT с ON CONFLICT (content_hash) DO UPDATE
        // Ключевой момент: дубликат по content_hash → добавляем источник, НЕ создаём новую запись
        const result = await query(
          `INSERT INTO news (title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, all_sources, source_count, published_at, lang_original, sentiment, sentiment_source, matched_tags, tag_impact)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15, $16)
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
          [a.title, title_ru, summary_ru, a.source, a.sourceId, a.url, urlNormalized, contentHash, [a.source], 1, a.publishedAt, a.lang, a.sentiment, a.sentiment_source, a.matched_tags || [], JSON.stringify(a.tag_impact || [])]
        );

        if (result.rows.length > 0 && result.rows[0].is_insert === true) {
          saved++;      // Новая запись
        } else {
          merged++;     // Дубликат — обновили all_sources
        }
      }
    } catch (e: any) {
      console.error(`[Cron] Save error for article "${a.title?.slice(0, 40)}": ${e.message?.slice(0, 100)}`);
    }
  }

  console.log(`[Cron] Saved ${saved} new, merged ${merged} duplicates (total ${processed.length})`);
  await logCronFinish(logId, processed.length, saved, merged, errors);
}

// ═══════════════════════════════════════════════════════════════════════════
// Start cron: every 5 minutes (first run delayed by 2 min)
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
}
