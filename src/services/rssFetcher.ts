import { RSS_SOURCES, RssSource } from './rssSources';
import { query } from '../config/db';
import { normalizeUrl } from '../utils/normalizeUrl';
import crypto from 'crypto';
import http from 'http';
import https from 'https';

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Keep-Alive Agent — reuse TCP connections across RSS fetches
// 36 sources → 1-2 TCP connections instead of 36 handshakes
// ═══════════════════════════════════════════════════════════════════════════
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

function getAgentForUrl(url: string): http.Agent | https.Agent | undefined {
  if (url.startsWith('https:')) return httpsAgent;
  if (url.startsWith('http:')) return httpAgent;
  return undefined;
}

// In-memory cache for last_fetched_at per source (avoids DB query inside fetch loop)
const sourceMetaCache: Map<string, Date> = new Map();
let metaCacheLoaded = false;

async function loadSourceMetaCache(): Promise<void> {
  if (metaCacheLoaded) return;
  try {
    const result = await query(`SELECT source_id, last_fetched_at FROM rss_source_meta`, []);
    for (const row of result.rows) {
      if (row.last_fetched_at) {
        sourceMetaCache.set(row.source_id, new Date(row.last_fetched_at));
      }
    }
    metaCacheLoaded = true;
    console.log(`[RSS] Loaded meta cache for ${sourceMetaCache.size} sources`);
  } catch {
    // Table may not exist yet — ignore
    metaCacheLoaded = true;
  }
}

export function getSourceLastFetched(sourceId: string): Date | undefined {
  return sourceMetaCache.get(sourceId);
}

export async function updateSourceLastFetched(sourceId: string, fetchedAt: Date): Promise<void> {
  sourceMetaCache.set(sourceId, fetchedAt);
  try {
    await query(
      `INSERT INTO rss_source_meta (source_id, last_fetched_at) VALUES ($1, $2)
       ON CONFLICT (source_id) DO UPDATE SET last_fetched_at = EXCLUDED.last_fetched_at`,
      [sourceId, fetchedAt.toISOString()]
    );
  } catch (err: any) {
    console.warn(`[RSS] Failed to update meta for ${sourceId}:`, err.message);
  }
}

const FETCH_TIMEOUT = 25000;
const BATCH_SIZE = 4;
const BATCH_DELAY = 1500;

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

// Normalize pubDate to UTC regardless of server timezone
// RSS sources may have: explicit offset (+0300), GMT, or no timezone at all
function normalizePubDate(pubDate: string, sourceLang: 'ru' | 'en'): Date {
  const str = pubDate.trim();

  // Already has timezone offset (+0300, GMT, etc.) — JavaScript parses correctly
  if (/[+-]\d{4}|\bGMT\b|\bUTC\b/i.test(str)) {
    return new Date(str);
  }

  // ISO format without timezone: 2026-05-29T22:25:25
  // Assume Moscow +0300 for RU sources, UTC for EN sources
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(str)) {
    const offset = sourceLang === 'ru' ? '+03:00' : '+00:00';
    return new Date(str + offset);
  }

  // RSS standard format without timezone: Fri, 29 May 2026 22:25:25
  if (/^\w{3},\s+\d{1,2}\s+\w{3}\s+\d{4}/.test(str)) {
    const offset = sourceLang === 'ru' ? ' +0300' : ' +0000';
    return new Date(str + offset);
  }

  // Fallback — try native parse (may depend on server timezone!)
  return new Date(str);
}

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
      publishedAt: pubDate ? normalizePubDate(pubDate, source.lang) : new Date(),
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

async function fetchSource(source: RssSource): Promise<ParsedArticle[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const agent = getAgentForUrl(source.url);

    const response = await fetch(source.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PULSE RSS Bot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
      ...(agent ? { dispatcher: agent as any } : {}),
    } as any);

    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`RSS failed [${source.id}]: HTTP ${response.status}`);
      return [];
    }

    const text = await response.text();
    const articles = parseRSS(text, source);

    // Filter: skip articles older than last successful fetch for this source
    const lastFetched = sourceMetaCache.get(source.id);
    if (lastFetched) {
      const filtered = articles.filter(a => a.publishedAt > lastFetched);
      if (filtered.length < articles.length) {
        console.log(`[RSS] ${source.id}: ${filtered.length}/${articles.length} articles newer than ${lastFetched.toISOString()}`);
      }
      return filtered;
    }

    return articles;
  } catch (err: any) {
    const code = err.name === 'AbortError' ? 'TIMEOUT' : (err.code || 'ERROR');
    console.warn(`RSS failed [${source.id}]: ${code}`);
    return [];
  }
}

export async function fetchAllRSS(): Promise<ParsedArticle[]> {
  // Load source metadata cache before fetching
  await loadSourceMetaCache();

  const allArticles: ParsedArticle[] = [];
  const fetchTime = new Date(); // UTC timestamp of this fetch

  for (let i = 0; i < RSS_SOURCES.length; i += BATCH_SIZE) {
    const batch = RSS_SOURCES.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(s => fetchSource(s)));

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const source = batch[j];
      if (result.status === 'fulfilled') {
        allArticles.push(...result.value);
        // Update last_fetched_at for successfully parsed sources
        await updateSourceLastFetched(source.id, fetchTime);
      }
    }

    if (i + BATCH_SIZE < RSS_SOURCES.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  const seen = new Set<string>();
  return allArticles.filter(a => {
    const key = `${a.title}|${a.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

const USE_SQLITE = process.env.USE_SQLITE === 'true';

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
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (url) DO NOTHING`,
          [a.title, a.title_ru || a.title, a.summary_ru || a.summary, a.source, a.sourceId, a.url, urlNormalized, contentHash, a.publishedAt.toISOString(), a.lang]
        );
      }
      count++;
    } catch (err) {
      // Skip duplicates / errors
    }
  }
  return count;
}
