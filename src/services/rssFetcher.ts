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

// ═══════════════════════════════════════════════════════════════════════════
// RSS Debug stats — accumulated per fetch cycle for /debug-rss endpoint
// ═══════════════════════════════════════════════════════════════════════════
let lastFetchStats: { source: string; status: string; items: number; filtered: number; kept: number; error?: string; httpStatus?: number }[] = [];

export function getLastFetchStats() {
  return lastFetchStats;
}

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
// RSS sources may have: explicit offset (+0300), GMT, ISO 8601 (Z/+00:00), or no timezone
function normalizePubDate(pubDate: string, sourceLang: 'ru' | 'en'): Date {
  const str = pubDate.trim();

  // ISO 8601 with Z: 2026-05-29T22:25:25Z — JavaScript parses correctly as UTC
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[Zz]$/.test(str)) {
    return new Date(str);
  }

  // ISO 8601 with offset: 2026-05-29T22:25:25+03:00 — JavaScript parses correctly
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(str)) {
    return new Date(str);
  }

  // Already has timezone offset (+0300, GMT, UTC) — JavaScript parses correctly
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
  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) return fallback;

  // Ultimate fallback: now (so article isn't lost)
  console.warn(`[RSS] Unparseable date "${str.slice(0, 50)}", using now`);
  return new Date();
}

function parseRSS(xml: string, source: RssSource): ParsedArticle[] {
  const articles: ParsedArticle[] = [];

  // Detect Atom vs RSS 2.0
  const isAtom = xml.includes('<feed') && xml.includes('<entry');
  const items = isAtom
    ? (xml.match(/<entry>[\s\S]*?<\/entry>/g) || [])
    : (xml.match(/<item>[\s\S]*?<\/item>/g) || []);

  for (const item of items.slice(0, 20)) {
    let title: string;
    let description: string;
    let link: string;
    let pubDate: string;

    if (isAtom) {
      // Atom format
      title = extractTag(item, 'title');
      description = extractTag(item, 'summary') || extractTag(item, 'content');
      link = extractTag(item, 'id');  // Atom uses <id> for URL
      if (!link || !link.startsWith('http')) {
        // Try to find href in <link>
        const linkMatch = item.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/i);
        link = linkMatch ? linkMatch[1] : '';
      }
      pubDate = extractTag(item, 'updated') || extractTag(item, 'published');
    } else {
      // RSS 2.0 format
      title = extractTag(item, 'title');
      description = extractTag(item, 'description');
      link = extractTag(item, 'link');
      pubDate = extractTag(item, 'pubDate');
    }

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
  // Try plain tag first: <title>Foo</title>
  const plainMatch = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  if (plainMatch) return plainMatch[1].trim();

  // Try CDATA: <title><![CDATA[Foo]]></title>
  const cdataMatch = xml.match(new RegExp(`<${tag}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i'));
  if (cdataMatch) return cdataMatch[1].trim();

  // Try with namespace: <dc:title>Foo</dc:title>
  const nsMatch = xml.match(new RegExp(`<[^:]*?:${tag}>([^<]*)</[^:]*?:${tag}>`, 'i'));
  if (nsMatch) return nsMatch[1].trim();

  return '';
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
  const stat: typeof lastFetchStats[0] = { source: source.id, status: 'pending', items: 0, filtered: 0, kept: 0 };
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

    stat.httpStatus = response.status;

    if (!response.ok) {
      stat.status = `http_${response.status}`;
      console.warn(`[RSS] ❌ [${source.id}]: HTTP ${response.status}`);
      lastFetchStats.push(stat);
      return [];
    }

    const text = await response.text();

    // Sanity check: must look like XML
    if (!text.includes('<') || text.length < 50) {
      stat.status = 'not_xml';
      console.warn(`[RSS] ❌ [${source.id}]: Response is not XML (len=${text.length})`);
      lastFetchStats.push(stat);
      return [];
    }

    const articles = parseRSS(text, source);
    stat.items = articles.length;

    // Filter: skip articles older than last successful fetch for this source
    const lastFetched = sourceMetaCache.get(source.id);
    if (lastFetched) {
      const filtered = articles.filter(a => a.publishedAt > lastFetched);
      stat.filtered = articles.length - filtered.length;
      stat.kept = filtered.length;
      stat.status = 'ok';
      if (filtered.length < articles.length) {
        console.log(`[RSS] ✅ [${source.id}]: ${filtered.length}/${articles.length} new (filtered ${stat.filtered} older than ${lastFetched.toISOString()})`);
      } else {
        console.log(`[RSS] ✅ [${source.id}]: ${filtered.length}/${articles.length} new`);
      }
      lastFetchStats.push(stat);
      return filtered;
    }

    stat.kept = articles.length;
    stat.status = 'ok';
    console.log(`[RSS] ✅ [${source.id}]: ${articles.length} articles (no last_fetched filter)`);
    lastFetchStats.push(stat);
    return articles;
  } catch (err: any) {
    const code = err.name === 'AbortError' ? 'TIMEOUT' : (err.code || err.message || 'ERROR');
    stat.status = 'error';
    stat.error = String(code).slice(0, 100);
    console.warn(`[RSS] ❌ [${source.id}]: ${code}`);
    lastFetchStats.push(stat);
    return [];
  }
}

export async function fetchAllRSS(customSources?: RssSource[]): Promise<ParsedArticle[]> {
  // Load source metadata cache before fetching
  await loadSourceMetaCache();

  // Reset stats for this fetch cycle
  lastFetchStats = [];

  const sources = customSources || RSS_SOURCES;
  const allArticles: ParsedArticle[] = [];

  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(s => fetchSource(s)));

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const source = batch[j];
      if (result.status === 'fulfilled') {
        const articles = result.value;
        allArticles.push(...articles);

        // Update last_fetched_at ONLY if we got articles, and to the MAX publishedAt — not fetchTime
        // This ensures we don't skip articles that appeared between the last article time and now
        if (articles.length > 0) {
          const maxPubDate = new Date(Math.max(...articles.map(a => a.publishedAt.getTime())));
          await updateSourceLastFetched(source.id, maxPubDate);
        }
        // If 0 articles: DON'T update last_fetched_at — try again next run
      }
    }

    if (i + BATCH_SIZE < RSS_SOURCES.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  // Deduplicate by title+source
  const seen = new Set<string>();
  const deduped = allArticles.filter(a => {
    const key = `${a.title}|${a.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[RSS] Total: ${allArticles.length} articles from ${lastFetchStats.filter(s => s.kept > 0).length} sources, ${deduped.length} after dedup`);
  return deduped;
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
          `INSERT INTO news (id, title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, published_at, lang_original, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (url) DO UPDATE SET fetched_at = EXCLUDED.fetched_at`,
          [uuidv4(), a.title, a.title_ru || a.title, a.summary_ru || a.summary, a.source, a.sourceId, a.url, urlNormalized, contentHash, a.publishedAt.toISOString(), a.lang, new Date().toISOString()]
        );
      } else {
        await query(
          `INSERT INTO news (title_original, title_ru, summary_ru, source, source_id, url, url_normalized, content_hash, published_at, lang_original, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (url) DO UPDATE SET fetched_at = EXCLUDED.fetched_at`,
          [a.title, a.title_ru || a.title, a.summary_ru || a.summary, a.source, a.sourceId, a.url, urlNormalized, contentHash, a.publishedAt.toISOString(), a.lang, new Date().toISOString()]
        );
      }
      count++;
    } catch (err) {
      // Skip duplicates / errors
    }
  }
  return count;
}
