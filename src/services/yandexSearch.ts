import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

const YANDEX_API_KEY = process.env.YANDEX_SEARCH_API_KEY || process.env.YANDEX_API_KEY;

export interface YandexSource {
  title: string;
  url: string;
  snippet: string;
  engine: 'yandex';
}

interface YandexSearchResult {
  sources: YandexSource[];
  error?: string;
}

export async function yandexSearch(query: string): Promise<YandexSearchResult> {
  if (!YANDEX_API_KEY) {
    const msg = 'No API key configured';
    console.log('[YandexSearch]', msg);
    return { sources: [], error: msg };
  }

  const safeQuery = query.slice(0, 400).trim();
  console.log(`[YandexSearch] Query: "${safeQuery.slice(0, 80)}..."`);

  try {
    const res = await axios.post(
      'https://searchapi.api.cloud.yandex.net/v2/web/search',
      {
        query: {
          searchType: 'SEARCH_TYPE_RU',
          queryText: safeQuery,
        },
      },
      {
        headers: {
          Authorization: `Api-Key ${YANDEX_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const rawB64 = res.data.rawData || '';
    if (!rawB64) {
      console.log('[YandexSearch] Empty rawData in response');
      return { sources: [] };
    }

    const xmlStr = Buffer.from(rawB64, 'base64').toString('utf-8');
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xmlStr);

    const results: YandexSource[] = [];
    const groups = parsed?.yandexsearch?.response?.results?.grouping?.group || [];

    for (const group of groups) {
      const doc = group.doc;
      if (!doc) continue;
      const url = doc.url || '';
      if (!url) continue;

      results.push({
        title: extractXmlText(doc.title),
        url,
        snippet: extractXmlText(doc.passages),
        engine: 'yandex',
      });
    }

    console.log(`[YandexSearch] Found ${results.length} results`);
    return { sources: results };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[YandexSearch] Error:', message);
    return { sources: [], error: message };
  }
}

function extractXmlText(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(extractXmlText).join(' ');
  return Object.values(node)
    .map((v: any) => (typeof v === 'string' ? v : extractXmlText(v)))
    .join('')
    .replace(/<\/?hlword>/g, '');
}
