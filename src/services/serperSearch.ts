import axios from 'axios';

const SERPER_API_KEY = process.env.SERPER_API_KEY;
const SERPER_ENDPOINT = 'https://google.serper.dev/news';

export type SerperEngine = 'serper_ru' | 'serper_en';

export interface SerperSource {
  title: string;
  url: string;
  snippet: string;
  date: string;
  site: string;
  engine: SerperEngine;
}

interface SerperEngineStatus {
  engine: SerperEngine;
  status: 'ok' | 'error';
  sources: number;
  error?: string;
}

export interface SerperSearchResult {
  sources: SerperSource[];
  engineStatuses: SerperEngineStatus[];
}

function isEnglish(text: string | null | undefined): boolean {
  if (!text) return false;
  return /^[\x00-\x7F\s\p{P}]+$/u.test(text.trim());
}

async function searchSerperSegment(
  query: string,
  gl: string,
  hl: string,
  engineLabel: SerperEngine
): Promise<{ sources: SerperSource[]; error?: string }> {
  if (!SERPER_API_KEY) {
    const msg = 'No Serper API key configured';
    console.log(`[Serper ${engineLabel}]`, msg);
    return { sources: [], error: msg };
  }

  const safeQuery = query.slice(0, 400).trim();
  console.log(`[Serper ${engineLabel}] Query: "${safeQuery.slice(0, 80)}..."`);

  try {
    const res = await axios.post(
      SERPER_ENDPOINT,
      {
        q: safeQuery,
        gl,
        hl,
        num: 10,
        autocorrect: true,
      },
      {
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const news = res.data?.news || [];
    const results: SerperSource[] = news
      .map((n: any) => ({
        title: String(n.title || ''),
        url: String(n.link || ''),
        snippet: String(n.snippet || ''),
        date: String(n.date || ''),
        site: String(n.source || ''),
        engine: engineLabel,
      }))
      .filter((s: SerperSource) => s.url);

    console.log(`[Serper ${engineLabel}] Found ${results.length} results`);
    return { sources: results };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Serper ${engineLabel}] Error:`, message);
    return { sources: [], error: message };
  }
}

/**
 * Serper News — последовательный поиск RU → EN
 * @param title_ru Русский перевод (всегда ищем)
 * @param title_original Оригинальный заголовок (EN-запрос только если EN)
 */
export async function serperSearch(
  title_ru: string,
  title_original: string | null | undefined
): Promise<SerperSearchResult> {
  const sources: SerperSource[] = [];
  const engineStatuses: SerperEngineStatus[] = [];

  // Шаг 1: RU-запрос (всегда)
  const ruRes = await searchSerperSegment(title_ru, 'ru', 'ru', 'serper_ru');
  if (!ruRes.error && ruRes.sources.length > 0) {
    sources.push(...ruRes.sources);
    engineStatuses.push({ engine: 'serper_ru', status: 'ok', sources: ruRes.sources.length });
  } else if (ruRes.error) {
    engineStatuses.push({ engine: 'serper_ru', status: 'error', sources: 0, error: ruRes.error });
  } else {
    engineStatuses.push({ engine: 'serper_ru', status: 'ok', sources: 0 });
  }

  // Шаг 2: EN-запрос (только если оригинал на английском)
  if (isEnglish(title_original)) {
    const enRes = await searchSerperSegment(title_original!, 'us', 'en', 'serper_en');
    if (!enRes.error && enRes.sources.length > 0) {
      sources.push(...enRes.sources);
      engineStatuses.push({ engine: 'serper_en', status: 'ok', sources: enRes.sources.length });
    } else if (enRes.error) {
      engineStatuses.push({ engine: 'serper_en', status: 'error', sources: 0, error: enRes.error });
    } else {
      engineStatuses.push({ engine: 'serper_en', status: 'ok', sources: 0 });
    }
  }

  return { sources, engineStatuses };
}
