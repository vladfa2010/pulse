import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';

const YANDEX_API_KEY = process.env.YANDEX_API_KEY;

export interface YandexSource {
  title: string;
  url: string;
  snippet: string;
  engine: 'yandex';
}

export async function yandexSearch(query: string): Promise<YandexSource[]> {
  if (!YANDEX_API_KEY) {
    console.log('[YandexSearch] No API key configured');
    return [];
  }

  try {
    const res = await axios.post(
      'https://searchapi.api.cloud.yandex.net/v2/web/search',
      {
        query: {
          searchType: 'SEARCH_TYPE_RU',
          queryText: query.slice(0, 400),
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

    return results;
  } catch (err: any) {
    console.error('[YandexSearch] Error:', err.message);
    return [];
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
