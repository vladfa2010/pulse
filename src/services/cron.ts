import cron from 'node-cron';
import { fetchAllRSS, saveArticles } from './rssFetcher';
import { translateBatch } from './translate';
import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Simple UUID v4 generator
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Tag keywords for matching
const TAG_KEYWORDS: Record<string, string[]> = {
  sber: ['сбер', 'сбербанк', 'sber'],
  gazp: ['газпром', 'gazprom'],
  yndx: ['яндекс', 'yandex'],
  aapl: ['apple', 'эпл'],
  tsla: ['tesla', 'тесла'],
  nvda: ['nvidia', 'нвидиа'],
  msft: ['microsoft', 'майкрософт'],
  googl: ['google', 'алфавет', 'alphabet'],
  tech: ['технологии', 'technology', 'ai', 'it'],
  finance: ['финансы', 'finance', 'банк'],
  energy: ['энергетика', 'energy', 'нефть', 'oil'],
  crypto: ['крипто', 'crypto', 'bitcoin', 'биткоин'],
  crusoe: ['crusoe'],
  spacex: ['spacex', 'space x'],
  cashea: ['cashea'],
  vastdata: ['vastdata', 'vast data'],
};

// Detect sentiment
function detectSentiment(text: string): 'positive' | 'negative' | 'neutral' {
  const t = text.toLowerCase();
  const positive = ['рост', 'прибыль', 'рекорд', 'рост', 'рост', 'gain', 'rise', 'surge', 'rally', 'profit', 'growth', 'up'];
  const negative = ['снижение', 'падение', 'убыток', 'кризис', 'loss', 'fall', 'drop', 'crash', 'decline', 'down'];

  let pos = 0, neg = 0;
  positive.forEach(w => { if (t.includes(w)) pos++; });
  negative.forEach(w => { if (t.includes(w)) neg++; });

  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

// Match tags for article
function matchTags(title: string, summary: string): string[] {
  const text = (title + ' ' + summary).toLowerCase();
  const matched: string[] = [];
  for (const [tagId, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some(kw => text.includes(kw))) {
      matched.push(tagId);
    }
  }
  return matched;
}

// Process and store articles
async function processArticles() {
  console.log('[Cron] Starting RSS fetch at', new Date().toISOString());

  // 1. Fetch RSS (wrapped in try/catch — one failed source shouldn't stop everything)
  let articles: any[] = [];
  try {
    articles = await fetchAllRSS();
  } catch (err: any) {
    console.error('[Cron] RSS fetch failed:', err.message);
    return;  // Exit gracefully — try again in 15 minutes
  }
  console.log(`[Cron] Fetched ${articles.length} articles`);

  // 2. Translate EN articles
  const enArticles = articles.filter(a => a.lang === 'en');
  if (enArticles.length > 0) {
    const titles = enArticles.map(a => a.title);
    const summaries = enArticles.map(a => a.summary);
    const allTexts = [...titles, ...summaries];

    try {
      const translated = await translateBatch(allTexts);
      const half = translated.length / 2;
      for (let i = 0; i < enArticles.length; i++) {
        enArticles[i].title_ru = translated[i] || enArticles[i].title;
        enArticles[i].summary_ru = translated[i + half] || enArticles[i].summary;
      }
    } catch {
      // Keep original if translation fails
      for (const a of enArticles) {
        a.title_ru = a.title;
        a.summary_ru = a.summary;
      }
    }
  }

  // 3. Match tags & detect sentiment
  const processed = articles.map(a => ({
    ...a,
    matched_tags: matchTags(a.title_ru || a.title, a.summary_ru || a.summary),
    sentiment: detectSentiment(a.title_ru || a.title),
  }));

  // 4. Save to DB
  let saved = 0;
  for (const a of processed) {
    try {
      if (USE_SQLITE) {
        await query(
          `INSERT OR IGNORE INTO news (id, title_original, title_ru, summary_ru, source, source_id, url, published_at, lang_original, sentiment, matched_tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [uuidv4(), a.title, a.title_ru || a.title, a.summary_ru || a.summary, a.source, a.sourceId, a.url, a.publishedAt.toISOString(), a.lang, a.sentiment, JSON.stringify(a.matched_tags)]
        );
      } else {
        await query(
          `INSERT INTO news (title_original, title_ru, summary_ru, source, source_id, url, published_at, lang_original, sentiment, matched_tags)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT DO NOTHING`,
          [a.title, a.title_ru || a.title, a.summary_ru || a.summary, a.source, a.sourceId, a.url, a.publishedAt, a.lang, a.sentiment, a.matched_tags]
        );
      }
      saved++;
    } catch {
      // Skip duplicates
    }
  }

  console.log(`[Cron] Saved ${saved} new articles`);

  // 5. Clean old news (>14 days)
  if (USE_SQLITE) {
    await query(`DELETE FROM news WHERE created_at < datetime('now', '-14 days')`);
  } else {
    await query(`DELETE FROM news WHERE created_at < NOW() - INTERVAL '14 days'`);
  }
}

// Start cron: every 15 minutes
export function startCron() {
  console.log('[Cron] RSS aggregator scheduled every 15 minutes');
  // Schedule: run every 15 minutes (but NOT immediately on startup)
  // First run will be at next 15-min boundary (:00, :15, :30, :45)
  cron.schedule('*/15 * * * *', async () => {
    try {
      await processArticles();
    } catch (err: any) {
      console.error('[Cron] RSS process failed:', err.message);
    }
  });
  // Delayed first run: wait 2 minutes after startup (avoid overload on deploy)
  setTimeout(() => {
    processArticles().catch((err: any) => {
      console.error('[Cron] Initial RSS fetch failed:', err.message);
    });
  }, 2 * 60 * 1000);
}
