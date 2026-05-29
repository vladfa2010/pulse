import { RSS_SOURCES, RssSource } from './rssSources';
import { query } from '../config/db';
import { normalizeUrl } from '../utils/normalizeUrl';
import crypto from 'crypto';

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
    console.warn(`RSS failed [${source.id}]: ${code}`);
    return [];
  }
}

export async function fetchAllRSS(): Promise<ParsedArticle[]> {
  const allArticles: ParsedArticle[] = [];

  for (let i = 0; i < RSS_SOURCES.length; i += BATCH_SIZE) {
    const batch = RSS_SOURCES.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(fetchSource));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        allArticles.push(...result.value);
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
