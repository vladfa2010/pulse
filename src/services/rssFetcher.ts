import { RSS_SOURCES, RssSource } from './rssSources';
import { query } from '../config/db';
import { normalizeUrl } from '../utils/normalizeUrl';
import crypto from 'crypto';

// CORS proxy only needed in browser — server makes direct requests
const CORS_PROXY = '';
const FETCH_TIMEOUT = 25000; // Render has slow outbound network
const BATCH_SIZE = 4;
const BATCH_DELAY = 1500; // 1.5s pause between batches

export interface ParsedArticle {
  title: string;
  summary: string;
  title_ru?: string;
  summary_ru?: string;
  url: string;
  publishedAt: Date;
  source: string;
  sourceId: string;
  lang: 'ru' | 'en';
}

// Quick XML parse — extract items
function parseRSS(xml: string, source: RssSource): ParsedArticle[] {
  const articles: ParsedArticle[] = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

  for (const item of items.slice(0, 20)) {
    const title = extractTag(item, 'title');
    const description = extractTag(item, 'description');
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');

    if (!title) continue;

    articles.push({
      title: stripHtml(title),
      summary: stripHtml(description || title).slice(0, 300),
      url: link || '',
      publishedAt: pubDate ? new Date(pubDate) : new Date(),
      source: source.name,
      sourceId: source.id,
      lang: source.lang,
    });
  }

  return articles;
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// Fetch single source with timeout using native fetch (Node 20+)
async function fetchSource(source: RssSource): Promise<ParsedArticle[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    
    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PULSE RSS Bot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      console.warn(`RSS failed [${source.id}]: HTTP ${response.status}`);
      return [];
    }
    
    const text = await response.text();
    return parseRSS(text, source);
  } catch (err: any) {
    const code = err.name === 'AbortError' ? 'TIMEOUT' : (err.code || 'ERROR');
    console.warn(`RSS failed [${source.id}]: ${code} — ${err.message?.substring(0, 80)}`);
    return [];
  }
}

// Batch fetch all sources
export async function fetchAllRSS(): Promise<ParsedArticle[]> {
  const allArticles: ParsedArticle[] = [];
  let processed = 0;

  console.log(`[RSS] Starting fetch of ${RSS_SOURCES.length} sources, batch size ${BATCH_SIZE}, timeout ${FETCH_TIMEOUT}ms`);

  for (let i = 0; i < RSS_SOURCES.length; i += BATCH_SIZE) {
    const batch = RSS_SOURCES.slice(i, i + BATCH_SIZE);
    const batchNames = batch.map(s => s.id).join(', ');
    console.log(`[RSS] Batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(RSS_SOURCES.length/BATCH_SIZE)}: ${batchNames}`);
    
    const results = await Promise.allSettled(batch.map(fetchSource));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allArticles.push(...result.value);
      }
    }
    
    processed += batch.length;
    console.log(`[RSS] Progress: ${processed}/${RSS_SOURCES.length} sources, ${allArticles.length} articles so far`);

    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(RSS_SOURCES.length / BATCH_SIZE);
    console.log(`[RSS] Batch ${batchNum}/${totalBatches} done (${Math.min(i + BATCH_SIZE, RSS_SOURCES.length)}/${RSS_SOURCES.length} sources), ${allArticles.length} articles so far`);

    if (i + BATCH_SIZE < RSS_SOURCES.length) {
      console.log(`[RSS] Pausing ${BATCH_DELAY}ms before next batch...`);
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  // Remove duplicates by title+source
  const seen = new Set<string>();
  return allArticles.filter(a => {
    const key = `${a.title}|${a.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Simple UUID v4 generator
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Save articles to DB
export async function saveArticles(articles: ParsedArticle[]): Promise<number> {
  let count = 0;
  for (const a of articles) {
    try {
      const urlNormalized = normalizeUrl(a.url || '');
      const contentHash = crypto.createHash('md5').update(`${a.title_ru || a.title}_${a.summary_ru || a.summary}`.slice(0, 500)).digest('hex');

      if (USE_SQLITE) {
        await query(
          `INSERT OR IGNORE INTO news (id, title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, published_at, lang_original)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [uuidv4(), a.title, a.title_ru || a.title, a.summary_ru || a.summary, a.source, a.sourceId, a.url, urlNormalized, contentHash, a.publishedAt.toISOString(), a.lang]
        );
      } else {
        await query(
          `INSERT INTO news (title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, published_at, lang_original)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           