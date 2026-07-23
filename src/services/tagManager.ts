/**
 * =============================================================================
 * PULSE — User Tag Manager
 * =============================================================================
 *
 * Управление пользовательскими тегами:
 *   - Создание тега с авто-генерацией keywords
 *   - Хранение в БД
 *   - Использование в smart matching
 */

import { query } from '../config/db';
import axios from 'axios';
import { invalidateUserTagsCache } from './smartTagMatcher';
import { backfillTagMatches } from './tagBackfill';

const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'moonshot-v1-32k';

// Допустимые типы тегов
export const TAG_TYPES = [
  'company',    // Компания / эмитент (Apple, Tesla, Сбер)
  'ticker',     // Биржевой тикер (AAPL, TSLA, SBER)
  'sector',     // Сектор экономики (Технологии, Фарма, Энергетика)
  'trend',      // Тренд / тема (AI, Крипто, ESG, Космос)
  'person',     // Ключевая персона (Илон Маск, Пауэлл)
  'commodity',  // Сырьё / товар (Золото, Нефть, Медь)
  'index',      // Фондовый индекс (S&P 500, NASDAQ, MOEX)
  'currency',   // Валюта (USD, EUR, BTC)
] as const;

export type TagType = typeof TAG_TYPES[number];

// Русские названия типов (для UI)
export const TAG_TYPE_LABELS: Record<TagType, string> = {
  company:   'Компания',
  ticker:    'Тикер',
  sector:    'Сектор',
  trend:     'Тренд',
  person:    'Персона',
  commodity: 'Сырьё',
  index:     'Индекс',
  currency:  'Валюта',
};

// ═══════════════════════════════════════════════════════════════════════════
// Tag Enrichment — LLM-powered enrichment (ONE call per tag creation)
// ═══════════════════════════════════════════════════════════════════════════

export interface TagEnrichment {
  tag_type: TagType;           // company, ticker, sector, etc.
  ticker?: string;             // AAPL, SBER, NVDA (if applicable)
  website?: string;            // Official website — LEGACY, = websites[0], kept in sync automatically
  websites?: string[];          // NEW: official site FIRST + related sites (IR, newsroom). 1-5 items.
  wikipedia_url?: string;     // NEW: Wikipedia article URL (admin-only)
  country?: string;            // NEW: country name in RUSSIAN (e.g. "Россия", "США"). Derived from geo_countries[0].
  isin?: string;               // NEW: International Securities Identification Number (12 chars)
  sectors?: string[];          // NEW: industries/sectors in RUSSIAN, 1-5 items, most important FIRST
  trends?: string[];           // NEW: major trends/themes in RUSSIAN, 0-5 items
  geo_countries?: string[];    // NEW: countries of presence/registration in RUSSIAN, HQ country FIRST, 1-5 items
  geo_regions?: string[];      // NEW: key regions/states/oblasts in RUSSIAN, 0-5 items
  geo_cities?: string[];       // NEW: key cities in RUSSIAN, HQ city FIRST, 0-5 items
  related_entities: string[];  // Related companies/sectors/people
  synonyms_en: string[];       // English synonyms & aliases
  synonyms_ru: string[];       // Russian synonyms & aliases
  key_products: string[];      // Key products, services, terms
  description_ru: string;      // 2-paragraph description in Russian
}

/**
 * Enrich tag via LLM (SINGLE call per tag creation).
 * Returns: type, ticker, related entities, synonyms, key products.
 * This is called ONCE when tag is created — not per-news.
 */
export async function enrichTagViaLLM(tagName: string): Promise<TagEnrichment | null> {
  if (!KIMI_API_KEY) {
    console.log('[TagEnrich] No KIMI_API_KEY, skipping enrichment');
    return null;
  }

  const systemPrompt = `You are a financial data enrichment system. Your task is to research entities using web search and return structured data.

You MUST use $web_search to find current information about the tag before responding. Do not rely on your training data.

When you receive a tag name, you MUST:
1. Use $web_search to search the web
2. LANGUAGE RULE: If the tag contains Cyrillic letters (а-я, ё) — search query MUST be in Russian
3. If the tag is in Russian, use query format: "{tagName} компания тикер биржа сайт описание"
4. If the tag is in English, use query format: "{tagName} company stock ticker exchange website description"
5. Search for: official website, stock ticker, stock exchange, description, key products
6. Return ONLY valid JSON

CRITICAL: Russian tags → Russian search queries. English tags → English search queries.

If the entity is not found, return null for optional fields.
NEVER guess or use your training data. ALWAYS search first.

Markets to consider:
- US: NASDAQ, NYSE (AAPL, TSLA, NVDA)
- Russia: Moscow Exchange (MOEX), SPB Exchange (SBER, GAZP, YDEX, TCSG)
- If a company trades on multiple exchanges, include the primary ticker and note Russian listing.
- Currency context: companies may report in RUB, USD, or EUR — use the appropriate currency.

Rules:
1. ALWAYS search the web first using $web_search
2. Return ONLY valid JSON, no markdown, no extra text
3. description_ru: Write 2 paragraphs in RUSSIAN. Paragraph 1 = what the company/person/sector is (origin, founding). Paragraph 2 = current status, main activities, stock exchange if applicable. Use \\n\\n between paragraphs.
4. website: Official company/person website URL starting with https://. null if unknown or not a company/person. This is the LEGACY field; it MUST always equal websites[0].
5. If tag is a person: ticker=null, website=personal site or Wikipedia link, related_entities=their companies, key_products=their initiatives
6. If tag is a sector/index/trend: ticker=null, website=null, related_entities=major constituents
7. synonyms_ru must include common Russian transliterations, nicknames, and short forms
8. All arrays must have at least 3 items, at most 15 items, EXCEPT sectors (1-5), trends (0-5), websites (1-5)
9. tag_type MUST be one of: company, ticker, sector, trend, person, commodity, index, currency
10. description_ru must be written in natural, fluent Russian (not translated from English)
11. Use CURRENT data as of 2026 — stock exchange listings, company status, ownership should reflect 2026 reality
12. For Russian companies: always include MOEX ticker, Russian website (.ru domain), and Russian competitors in related_entities
13. If the tag is a Russian company or person, ensure description_ru references Russian context (founded in Russia, Moscow Exchange listing, ruble reporting)
14. synonyms_ru MUST include common Russian short names, diminutives, and transliterations (e.g., "Сбер", "Газпром", "Яндекс", "Тинькофф" → "Т-Банк")
15. For Russian banks/fintech: key_products should include Russian product names (e.g., "СберБанк Онлайн", "Тинькофф Инвестиции", "Яндекс.Плюс")
16. websites: official website FIRST, then key related sites (investor relations, newsroom/press). 1-5 items. All URLs must start with https://. For non-company tags return a single authoritative source or null.
17. website: ALWAYS equal to websites[0] (legacy field, kept in sync automatically).
18. wikipedia_url: full URL of the Wikipedia article. Language matches the tag: Russian tag → ru.wikipedia.org, English tag → en.wikipedia.org. null if no article exists.
19. country: country name in RUSSIAN (e.g. "Россия", "США", "Китай"). For persons — country of primary activity. null for trend/currency/commodity/index tags. MUST ALWAYS equal geo_countries[0] (legacy field, kept in sync automatically).
20. isin: International Securities Identification Number (12 chars, e.g. US0378331005, RU0009029540). null if the tag is not a traded security.
21. sectors: industries/sectors the entity operates in, in RUSSIAN (e.g. ["Финансы", "Банковское дело"], ["Технологии", "Потребительская электроника"]). 1-5 items, most important FIRST. For pure sector tags return the parent sector. Empty array if not applicable.
22. trends: major trends/themes the entity is exposed to, in RUSSIAN (e.g. ["Искусственный интеллект", "Цифровизация"]). 0-5 items. Empty array if none.
23. geo_countries: countries where the entity is based or operates, in RUSSIAN (e.g. ["Россия"], ["США", "Китай"]). 1-5 items, HQ country FIRST. For trend/currency/commodity/index tags — empty array.
24. geo_regions: key regions/states/oblasts of presence, in RUSSIAN (e.g. ["Московская область"], ["Калифорния", "Техас"]). 0-5 items.
25. geo_cities: key cities, HQ city FIRST, in RUSSIAN (e.g. ["Москва"], ["Купертино"]). 0-5 items.

Return ONLY a JSON object with this exact structure (placeholders only, do not fill with example data):
{
  "tag_type": "<type>",        // One of: company, ticker, sector, trend, person, commodity, index, currency
  "ticker": "<ticker or null>",             // Stock ticker if applicable, else null
  "website": "<url or null>",  // Official company website. MUST equal websites[0]. null if not a company/person, or unknown
  "websites": ["<url1>", "<url2>"], // 1-5 URLs, official site FIRST, then IR/press/newsroom. null for non-company tags if unknown
  "wikipedia_url": "<url or null>", // Full Wikipedia article URL or null
  "country": "<country or null>", // Country name in RUSSIAN or null. MUST equal geo_countries[0].
  "isin": "<ISIN or null>", // 12-char ISIN or null
  "sectors": ["<sector1>", "<sector2>"], // Industries in RUSSIAN, 1-5 items, most important first. Empty array if not applicable
  "trends": ["<trend1>", "<trend2>"], // Trends in RUSSIAN, 0-5 items. Empty array if none
  "geo_countries": ["<country1>"], // Countries in RUSSIAN, 1-5 items, HQ first. Empty array if not applicable.
  "geo_regions": ["<region1>"], // Regions in RUSSIAN, 0-5 items.
  "geo_cities": ["<city1>"], // Cities in RUSSIAN, 0-5 items, HQ city first.
  "related_entities": ["<entity1>", "<entity2>"],  // Related companies, sectors, or people (5-10 items)
  "synonyms_en": ["<syn1>", "<syn2>"],  // English synonyms/aliases (5-10 items)
  "synonyms_ru": ["<син1>", "<син2>"],       // Russian synonyms/aliases (5-10 items)
  "key_products": ["<product1>", "<product2>"],  // Key products/services (5-10 items)
  "description_ru": "<2 paragraphs in Russian>"
}

Example 1 — US company "Apple" (ILLUSTRATION ONLY):
{
  "tag_type": "company",
  "ticker": "AAPL",
  "website": "https://www.apple.com",
  "websites": ["https://www.apple.com", "https://investor.apple.com"],
  "wikipedia_url": "https://en.wikipedia.org/wiki/Apple_Inc.",
  "country": "США",
  "isin": "US0378331005",
  "sectors": ["Технологии", "Потребительская электроника", "Программное обеспечение"],
  "trends": ["Искусственный интеллект", "Носимые устройства"],
  "geo_countries": ["США"],
  "geo_regions": ["Калифорния"],
  "geo_cities": ["Купертино"],
  "related_entities": ["Microsoft", "Google", "Samsung", "Amazon", "TSMC"],
  "synonyms_en": ["Apple Inc", "iPhone maker", "Cupertino"],
  "synonyms_ru": ["Эпл", "эппл", "яблочная компания"],
  "key_products": ["iPhone", "iPad", "Mac", "App Store", "Apple Watch"],
  "description_ru": "Apple — американская технологическая корпорация, специализирующаяся на производстве потребительской электроники, программного обеспечения и онлайн-сервисов. Компания была основана Стивом Джобсом, Стивом Возняком и Рональдом Уэйном в 1976 году в Калифорнии.\\n\\nСегодня Apple является одной из крупнейших компаний мира по рыночной капитализации. Её основные продукты включают смартфоны iPhone, компьютеры Mac, планшеты iPad, а также сервисы App Store, Apple Music и iCloud. Акции компании торгуются на NASDAQ под тикером AAPL."
}

Example 2 — Russian company "Сбербанк" (ILLUSTRATION ONLY):
{
  "tag_type": "company",
  "ticker": "SBER",
  "website": "https://www.sberbank.ru",
  "websites": ["https://www.sberbank.ru", "https://www.sberbank.com"],
  "wikipedia_url": "https://ru.wikipedia.org/wiki/Сбербанк_России",
  "country": "Россия",
  "isin": "RU0009029540",
  "sectors": ["Финансы", "Банковское дело", "Финтех"],
  "trends": ["Искусственный интеллект", "Цифровизация"],
  "geo_countries": ["Россия"],
  "geo_regions": ["Московская область", "Ленинградская область"],
  "geo_cities": ["Москва", "Санкт-Петербург"],
  "related_entities": ["Центральный банк РФ", "Т-Банк", "ВТБ", "Альфа-Банк", "Московская биржа", "Российский фондовый рынок"],
  "synonyms_en": ["Sberbank", "Sber", "Sberbank of Russia"],
  "synonyms_ru": ["Сбер", "Сбербанк России", "ПАО Сбербанк", "сбер"],
  "key_products": ["СберБанк Онлайн", "СберПрайм", "СберСтрахование", "ипотека", "кредитные карты", "вклады"],
  "description_ru": "Сбербанк — крупнейший банк России и один из ведущих финансовых институтов Восточной Европы. Контролируется Центральным банком РФ (около 50% акций). Основан в 1841 году как Сберегательная казна.\\n\\nСегодня Сбербанк обслуживает более 100 млн клиентов в России и СНГ. Основные направления: розничный банкинг, корпоративный бизнес, страхование, инвестиции, экосистема цифровых сервисов (СберБанк Онлайн, СберМаркет, Самокат). Акции торгуются на Московской бирже под тикером SBER, также GDR на Лондонской бирже (временно приостановлены)."
}

CRITICAL: The examples above are for ILLUSTRATION ONLY.
For the requested tag you must research and return the REAL data using $web_search.
If you don't know the entity, return null for optional fields and a generic description.
NEVER return Apple/Microsoft/Google data for an unrelated tag.
DO NOT copy the example data.`;

  const isRussian = /[а-яё]/i.test(tagName);
  const searchQuery = isRussian
    ? `${tagName} компания тикер биржа сайт описание`
    : `${tagName} company stock ticker exchange website description`;

  const userPrompt = isRussian
    ? `Исследуй сущность: "${tagName}"

Выполни $web_search с запросом (обязательно на русском языке): "${searchQuery}"

Верни JSON:
- tag_type: company | ticker | person | sector | trend | commodity | index | currency
- ticker: биржевой тикер или null
- website: официальный сайт или null
- related_entities: 3-10 связанных компаний/персон
- synonyms_en: английские синонимы
- synonyms_ru: русские синонимы и сокращения
- key_products: ключевые продукты/услуги
- description_ru: 2 абзаца на русском (история + текущий статус)

Только JSON. Если не найдено — null для опциональных полей.`
    : `Research entity: "${tagName}"

Use $web_search with query: "${searchQuery}"

Return JSON:
- tag_type: company | ticker | person | sector | trend | commodity | index | currency
- ticker: stock symbol or null
- website: official URL or null
- related_entities: 3-10 related entities
- synonyms_en: English aliases
- synonyms_ru: Russian aliases
- key_products: main products/services
- description_ru: 2 paragraphs in Russian (origin + current status)

Return ONLY JSON. If not found, use null for optional fields.`;

  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const isKimiK = KIMI_MODEL.startsWith('kimi-k');

  try {
    // --- Round 1: force web search ---
    console.log(`[TagEnrichSearch] Starting web search for "${tagName}"...`);

    let response = await llmRequestWithRetry(
      () => axios.post(
        'https://api.moonshot.ai/v1/chat/completions',
        {
          model: KIMI_MODEL,
          messages,
          temperature: 0.1,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
          thinking: isKimiK ? { type: 'disabled' } : undefined,
          tools: [
            {
              type: 'builtin_function',
              function: { name: '$web_search' },
            },
          ],
          tool_choice: {
            type: 'builtin_function',
            function: { name: '$web_search' },
          },
        },
        {
          headers: {
            'Authorization': `Bearer ${KIMI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      ),
      'TagEnrichSearch'
    );

    // --- Round 2: if search was called, feed results back ---
    const choice = response.data?.choices?.[0];
    const toolCalls = choice?.message?.tool_calls || [];

    if (toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: choice.message.content || '',
        tool_calls: toolCalls,
      });

      for (const toolCall of toolCalls) {
        if (toolCall.function?.name === '$web_search') {
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolCall.function.arguments),
          });
        }
      }

      console.log(`[TagEnrichFinal] Processing search results for "${tagName}"...`);

      response = await llmRequestWithRetry(
        () => axios.post(
          'https://api.moonshot.ai/v1/chat/completions',
          {
            model: KIMI_MODEL,
            messages,
            temperature: 0.1,
            max_tokens: 2000,
            response_format: { type: 'json_object' },
            thinking: isKimiK ? { type: 'disabled' } : undefined,
          },
          {
            headers: {
              'Authorization': `Bearer ${KIMI_API_KEY}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        ),
        'TagEnrichFinal'
      );
    }

    const content = response.data?.choices?.[0]?.message?.content || '';

    const parsed = parseLlmJson(content);
    if (!parsed) {
      console.log(`[TagEnrich] Could not parse LLM response for "${tagName}" (length=${content.length})`);
      return null;
    }

    // Validate that the response is actually about the requested entity
    const nameVariants = getTranslitVariants(tagName).map(v => v.toLowerCase());
    const descLower = (parsed.description_ru || parsed.description || '').toLowerCase();
    const tickerLower = (parsed.ticker || '').toLowerCase();
    const allSynonyms = [
      ...(Array.isArray(parsed.synonyms_ru) ? parsed.synonyms_ru : []),
      ...(Array.isArray(parsed.synonyms_en) ? parsed.synonyms_en : []),
    ].map((s: string) => s.toLowerCase());

    const hasNameMatch = nameVariants.some(name =>
      descLower.includes(name) ||
      tickerLower === name ||
      allSynonyms.some((s: string) => s.includes(name) || name.includes(s))
    );

    if (descLower && !hasNameMatch) {
      console.log(`[TagEnrich] Mismatch for "${tagName}" — got data for unrelated entity`);
      return null;
    }

    // Validate and normalize
    const enrichment: TagEnrichment = {
      tag_type: TAG_TYPES.includes(parsed.tag_type) ? parsed.tag_type : 'company',
      ticker: parsed.ticker || undefined,
      website: parsed.website || (Array.isArray(parsed.websites) && parsed.websites.length > 0 ? parsed.websites[0] : undefined),
      websites: Array.isArray(parsed.websites) ? parsed.websites : (parsed.website ? [parsed.website] : undefined),
      wikipedia_url: parsed.wikipedia_url || undefined,
      country: parsed.country || (Array.isArray(parsed.geo_countries) && parsed.geo_countries.length > 0 ? parsed.geo_countries[0] : undefined),
      isin: parsed.isin || undefined,
      sectors: Array.isArray(parsed.sectors) ? parsed.sectors : undefined,
      trends: Array.isArray(parsed.trends) ? parsed.trends : undefined,
      geo_countries: Array.isArray(parsed.geo_countries) ? parsed.geo_countries : (parsed.country ? [parsed.country] : undefined),
      geo_regions: Array.isArray(parsed.geo_regions) ? parsed.geo_regions : undefined,
      geo_cities: Array.isArray(parsed.geo_cities) ? parsed.geo_cities : undefined,
      related_entities: Array.isArray(parsed.related_entities) ? parsed.related_entities : [],
      synonyms_en: Array.isArray(parsed.synonyms_en) ? parsed.synonyms_en : [],
      synonyms_ru: Array.isArray(parsed.synonyms_ru) ? parsed.synonyms_ru : [],
      key_products: Array.isArray(parsed.key_products) ? parsed.key_products : [],
      description_ru: parsed.description_ru || parsed.description || '',
    };

    console.log(`[TagEnrich] Enriched "${tagName}": type=${enrichment.tag_type}, ticker=${enrichment.ticker || 'none'}, synonyms=${enrichment.synonyms_en.length + enrichment.synonyms_ru.length}, products=${enrichment.key_products.length}`);
    return enrichment;
  } catch (err: any) {
    console.log(`[TagEnrich] LLM error for "${tagName}": ${err.message?.slice(0, 100)}`);
  }

  return null;
}

// ─── Robust LLM JSON parser ────────────────────────────────────────────────

function parseLlmJson(content: string): any | null {
  let raw = content.trim();

  // Strip markdown code fences if present
  raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();

  // Try direct parse first (works when response_format is respected)
  try {
    return JSON.parse(raw);
  } catch {
    // fall through
  }

  // Fallback 1: extract the outermost JSON object greedily
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // fall through
    }
  }

  // Fallback 2: escape raw physical newlines/tabs that were not JSON-escaped
  try {
    let fixed = raw.replace(/\\\\/g, '__ESC__');
    fixed = fixed.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    fixed = fixed.replace(/__ESC__/g, '\\\\');
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

// ─── Retry helper for LLM requests ─────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function llmRequestWithRetry<T>(
  fn: () => Promise<T>,
  label: string
): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const status = err.response?.status;
      const isRetryable = status === 429 || status === 502 || status === 503 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';

      if (!isRetryable) {
        throw err;
      }

      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(`[${label}] Attempt ${attempt}/${MAX_RETRIES} failed (status=${status}). Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[${label}] All ${MAX_RETRIES} attempts failed. Giving up.`);
        throw err;
      }
    }
  }
  throw lastError;
}

/**
 * Build enriched keywords from TagEnrichment + generateTagKeywords.
 * Combines: base keywords + LLM synonyms + key products + related entities.
 */
export function buildEnrichedKeywords(tagName: string, enrichment: TagEnrichment | null): string[] {
  // Base keywords (translit + declensions)
  const baseKeywords = generateTagKeywords(tagName);

  if (!enrichment) {
    return baseKeywords;
  }

  // LLM-enriched keywords
  // NOTE: related_entities are NOT included here (see TODO.md #1)
  // They are displayed in UI but NOT used for matching to prevent
  // false positives (e.g. "Sberbank" news tagged as "Yandex")
  const enriched: string[] = [
    ...baseKeywords,
    // Synonyms (both languages, lowercase)
    ...(enrichment.synonyms_en || []).map(s => s.toLowerCase()),
    ...(enrichment.synonyms_ru || []).map(s => s.toLowerCase()),
    // Key products (both languages, lowercase)
    ...(enrichment.key_products || []).map(s => s.toLowerCase()),
  ];

  // Add ticker as keyword if present
  if (enrichment.ticker) {
    enriched.push(enrichment.ticker.toLowerCase());
  }

  // Deduplicate + filter
  return [...new Set(enriched)].filter(k => k.length > 1);
}

// Генерация keywords для нового тега (правила + базовые формы)
export function generateTagKeywords(tagName: string): string[] {
  const lower = tagName.toLowerCase().trim();

  // Базовый набор: само название + транслит + варианты
  const keywords: string[] = [lower];

  // Добавляем транслитерацию (простая)
  const translitMap: Record<string, string> = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
    'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'j', 'к': 'k', 'л': 'l', 'м': 'm',
    'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
    'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '',
    'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
  };

  // Проверяем, кириллица ли
  const hasCyrillic = /[а-яё]/i.test(lower);
  const hasLatin = /[a-z]/i.test(lower);

  if (hasCyrillic) {
    // Транслитерируем в латиницу
    let translit = '';
    for (const char of lower) {
      translit += translitMap[char] || char;
    }
    keywords.push(translit);
  }

  if (hasLatin) {
    // Транслитерируем в кириллицу (обратная)
    const reverseMap: Record<string, string> = {
      'a': 'а', 'b': 'б', 'v': 'в', 'g': 'г', 'd': 'д', 'e': 'е', 'yo': 'ё',
      'zh': 'ж', 'z': 'з', 'i': 'и', 'j': 'й', 'k': 'к', 'l': 'л', 'm': 'м',
      'n': 'н', 'o': 'о', 'p': 'п', 'r': 'р', 's': 'с', 't': 'т', 'u': 'у',
      'f': 'ф', 'h': 'х', 'c': 'ц', 'ch': 'ч', 'sh': 'ш', 'sch': 'щ',
      'y': 'ы', 'yu': 'ю', 'ya': 'я',
    };
    // Простая обратная транслитерация
    let cyrillic = lower;
    for (const [lat, cyr] of Object.entries(reverseMap)) {
      cyrillic = cyrillic.replace(new RegExp(lat, 'g'), cyr);
    }
    if (cyrillic !== lower) {
      keywords.push(cyrillic);
    }
  }

  // Добавляем варианты склонений (простые суффиксы)
  const suffixes = ['а', 'у', 'е', 'ом', 'ов', 'ам', 'ах'];
  for (const suffix of suffixes) {
    keywords.push(lower + suffix);
  }

  // Уникальные + фильтруем пустые
  return [...new Set(keywords)].filter(k => k.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM Auto-Detection: определяем тип тега по названию
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Автоопределение типа тега через LLM (Kimi API).
 * Отправляем название → получаем один из TAG_TYPES.
 * Fallback: 'company' если LLM недоступен.
 */
export async function detectTagTypeViaLLM(tagName: string): Promise<TagType> {
  if (!KIMI_API_KEY) {
    console.log('[TagTypeDetect] No KIMI_API_KEY, fallback to company');
    return 'company';
  }

  const prompt = `You are a financial tag classifier. Analyze the tag name and return the most appropriate type.

Tag name: "${tagName}"

Available types:
- company: Company / corporation / business entity (Apple, Tesla, Sberbank, Gazprom)
- ticker: Stock exchange ticker symbol (AAPL, TSLA, SBER, NVDA, GAZP)
- sector: Economic sector / industry (Technology, Healthcare, Energy, Finance, Real Estate)
- trend: Trend / theme / technology trend (AI, Crypto, ESG, Metaverse, Web3, Green Energy)
- person: Key person / figure in business or finance (Elon Musk, Powell, Zuckerberg)
- commodity: Raw material / commodity / physical good (Gold, Oil, Copper, Wheat, Silver)
- index: Stock market index / benchmark (S&P 500, NASDAQ, MOEX, Dow Jones)
- currency: Currency / fiat or crypto (USD, EUR, Bitcoin, Ethereum, Yuan)

Rules:
1. Return ONLY the type name, nothing else
2. Ticker symbols are usually 1-5 uppercase Latin letters (AAPL, SBER)
3. If ambiguous, prefer "company" over "ticker"
4. Return ONLY one word from the list above

Response format: company (or ticker, sector, trend, person, commodity, index, currency)`;

  try {
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: KIMI_MODEL.startsWith('kimi-k') ? 1 : 0.1,
        max_tokens: 10,
      },
      {
        headers: {
          'Authorization': `Bearer ${KIMI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content?.toLowerCase().trim() || '';
    console.log(`[TagTypeDetect] LLM raw: "${content}" for "${tagName}"`);

    // Extract type from response
    for (const type of TAG_TYPES) {
      if (content.includes(type)) {
        console.log(`[TagTypeDetect] Detected: "${type}" for "${tagName}"`);
        return type;
      }
    }

    // Heuristic fallback (no LLM or ambiguous response)
    return heuristicTagType(tagName);
  } catch (err: any) {
    console.log(`[TagTypeDetect] LLM error: ${err.message?.slice(0, 100)}`);
    return heuristicTagType(tagName);
  }
}

/**
 * Heuristic type detection (fast, local, no API).
 * Used as fallback when LLM is unavailable.
 */
export function heuristicTagType(tagName: string): TagType {
  const lower = tagName.toLowerCase().trim();

  // Ticker: 1-5 uppercase Latin letters (or lowercase)
  if (/^[a-z]{1,5}$/i.test(lower) && !/^(the|and|for|new|big|top)$/i.test(lower)) {
    // Could be ticker or short company name → check against known patterns
    // Most 1-5 letter uppercase symbols are tickers
    return 'ticker';
  }

  // Person: contains name patterns
  const personPatterns = [/(^|\s)(musk|bezos|zuckerberg|buffett|gates|jobs|cook|elon|jeff|mark|warren|bill|tim|путин|медведев|набиуллина|тип)|^(илон|марк|джефф|уоррен|тим|сатья)/i];
  if (personPatterns.some(p => p.test(lower))) {
    return 'person';
  }

  // Currency: common currency names/codes
  const currencyPatterns = [/^(usd|eur|gbp|jpy|rub|cny|btc|eth|bnb|xrp|usdt|bnb|sol|адollar|евро|фунт|йена|рубль|юань|биткоин|эфириум)$/i];
  if (currencyPatterns.some(p => p.test(lower))) {
    return 'currency';
  }

  // Index: contains index patterns
  if (/\b(s&p|nasdaq|dow|moex|rts|msci|ftse|cac|dax|hang\s*seng)\b/i.test(lower)) {
    return 'index';
  }

  // Commodity: raw materials
  const commodityPatterns = [/^(gold|silver|oil|crude|brent|copper|aluminum|wheat|corn|gas|natural|uranium|platinum|palladium|золото|серебро|нефть|медь|алюминий|пшеница|кукуруза|газ|уран|платина|палладий)$/i];
  if (commodityPatterns.some(p => p.test(lower))) {
    return 'commodity';
  }

  // Sector: broad industry terms
  const sectorPatterns = [/^(tech|technology|healthcare|pharma|finance|banking|energy|utilities|consumer|industrial|materials|realestate|телеком|фарма|финансы|энергетика|недвижимость|телекоммуникации|потребительские|промышленность|материалы)$/i];
  if (sectorPatterns.some(p => p.test(lower))) {
    return 'sector';
  }

  // Default: company
  return 'company';
}

// ═══════════════════════════════════════════════════════════════════════════
// Transliteration helpers for tag deduplication (latin ↔ cyrillic)
// ═══════════════════════════════════════════════════════════════════════════

const TRANSLIT_MAP: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo',
  'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'j', 'к': 'k', 'л': 'l', 'м': 'm',
  'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u',
  'ф': 'f', 'х': 'h', 'ц': 'c', 'ч': 'ch', 'ш': 'sh', 'щ': 'sch', 'ъ': '',
  'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya',
};

const REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(TRANSLIT_MAP).map(([k, v]) => [v, k])
);

function toLatin(str: string): string {
  return str.toLowerCase().split('').map(c => TRANSLIT_MAP[c] || c).join('');
}

function toCyrillic(str: string): string {
  let result = str.toLowerCase();
  const multi: [string, string][] = [['sch', 'щ'], ['zh', 'ж'], ['ch', 'ч'], ['sh', 'ш'], ['yo', 'ё'], ['yu', 'ю'], ['ya', 'я']];
  for (const [lat, cyr] of multi) {
    result = result.split(lat).join(cyr);
  }
  return result.split('').map(c => REVERSE_MAP[c] || c).join('');
}

export function getTranslitVariants(name: string): string[] {
  const lower = name.toLowerCase().trim();
  const hasCyrillic = /[а-яё]/.test(lower);
  const hasLatin = /[a-z]/.test(lower);

  const variants = new Set<string>();
  variants.add(lower);

  if (hasCyrillic) {
    variants.add(toLatin(lower));
  }
  if (hasLatin) {
    variants.add(toCyrillic(lower));
  }

  return [...variants];
}

// Создать пользовательский тег
// Если tagType = 'auto' или пустой — тип определяется эвристически, обогащение идёт в фоне.
// При добавлении существующего тега user_defined_tags НЕ модифицируется.
export async function createUserTag(userId: string, tagId: string, tagName: string, tagType: string): Promise<{ success: boolean; finalTagId?: string; resolvedTagName?: string; detectedType?: TagType; enrichment?: TagEnrichment; enriched?: boolean; backgroundEnrichmentStarted?: boolean; alreadySubscribed?: boolean }> {
  try {
    // 1. Точное совпадение по tag_id (например, при клике по конкретной карточке)
    let existingResult = await query(
      `SELECT tag_id, tag_name, tag_type, enriched_data, keywords, created_by
       FROM user_defined_tags
       WHERE tag_id = $1
       LIMIT 1`,
      [tagId]
    );

    // 2. Точное совпадение по LOWER(tag_name)
    if (existingResult.rows.length === 0) {
      existingResult = await query(
        `SELECT tag_id, tag_name, tag_type, enriched_data, keywords, created_by
         FROM user_defined_tags
         WHERE LOWER(tag_name) = LOWER($1)
         LIMIT 1`,
        [tagName]
      );
    }

    // 3. Транслит-варианты (latin ↔ cyrillic): sberbank ↔ сбербанк
    if (existingResult.rows.length === 0) {
      const variants = getTranslitVariants(tagName);
      if (variants.length > 1) {
        const namePlaceholders = variants.map((_, i) => `$${i + 1}`).join(',');
        const idPlaceholders = variants.map((_, i) => `$${i + 1 + variants.length}`).join(',');
        existingResult = await query(
          `SELECT tag_id, tag_name, tag_type, enriched_data, keywords, created_by
           FROM user_defined_tags
           WHERE LOWER(tag_name) IN (${namePlaceholders})
              OR tag_id IN (${idPlaceholders})
           LIMIT 1`,
          [...variants, ...variants]
        );
      }
    }

    // 4. Поиск по ticker в enriched_data (например, пользователь ввёл тикер, а в базе тег по имени)
    if (existingResult.rows.length === 0) {
      existingResult = await query(
        `SELECT tag_id, tag_name, tag_type, enriched_data, keywords, created_by
         FROM user_defined_tags
         WHERE enriched_data->>'ticker' ILIKE $1
         LIMIT 1`,
        [tagName.trim()]
      );
    }

    let finalType: string;
    let finalTagId = tagId;
    let resolvedTagName = tagName;
    let detectedType: TagType | undefined;
    let enrichment: TagEnrichment | null = null;
    let enriched = false;
    let backgroundEnrichmentStarted = false;
    let isNewTag = false;

    if (existingResult.rows.length > 0) {
      // --- Тег уже есть: НЕ трогаем user_defined_tags ---
      const existing = existingResult.rows[0];
      finalTagId = existing.tag_id;
      resolvedTagName = existing.tag_name;
      finalType = existing.tag_type;
      detectedType = existing.tag_type as TagType;
      enrichment = existing.enriched_data || null;
      enriched = !!existing.enriched_data;
      console.log(`[TagManager] Tag already exists by name/id "${existing.tag_name}" (${finalTagId}), subscribing user ${userId}`);
    } else {
      // --- Тега нет: создаём сразу, обогащаем в фоне ---
      if (!tagType || tagType === 'auto') {
        finalType = heuristicTagType(tagName);
        detectedType = finalType as TagType;
      } else {
        finalType = tagType;
      }

      // Validate type
      if (!TAG_TYPES.includes(finalType as TagType)) {
        finalType = 'company';
      }

      // Base keywords — синхронно, без LLM
      const keywords = generateTagKeywords(tagName);

      // Save tag with empty enrichment (no ON CONFLICT UPDATE)
      try {
        await query(
          `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords, enriched_data, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tagId, tagName, finalType, keywords, null, userId]
        );
        isNewTag = true;
        backgroundEnrichmentStarted = true;
        console.log(`[TagManager] Created tag "${tagId}": type=${finalType}, keywords=${keywords.length}, background enrichment started`);

        // Fire-and-forget background enrichment (use finalTagId in case it was resolved)
        backgroundEnrichTag(finalTagId, tagName).catch(err => {
          console.error(`[TagEnrich] Background enrichment failed for "${tagName}":`, err.message);
        });
      } catch (err: any) {
        if (err.code === '23505') {
          // Race condition: другой пользователь создал тег между SELECT и INSERT
          const raceResult = await query(
            `SELECT tag_id, tag_name, tag_type, enriched_data FROM user_defined_tags WHERE tag_id = $1 LIMIT 1`,
            [tagId]
          );
          if (raceResult.rows.length === 0) {
            const raceNameResult = await query(
              `SELECT tag_id, tag_name, tag_type, enriched_data FROM user_defined_tags WHERE LOWER(tag_name) = LOWER($1) LIMIT 1`,
              [tagName]
            );
            if (raceNameResult.rows.length > 0) {
              raceResult.rows = raceNameResult.rows;
            }
          }
          finalTagId = raceResult.rows[0]?.tag_id || tagId;
          resolvedTagName = raceResult.rows[0]?.tag_name || tagName;
          finalType = raceResult.rows[0]?.tag_type || finalType;
          detectedType = finalType as TagType;
          enrichment = raceResult.rows[0]?.enriched_data || null;
          enriched = !!raceResult.rows[0]?.enriched_data;
          console.log(`[TagManager] Tag "${tagId}" created by another user, using existing ${finalTagId} type=${finalType}`);
        } else {
          throw err;
        }
      }
    }

    // 5. Проверяем, не подписан ли уже пользователь на этот тег
    const alreadySubscribedResult = await query(
      `SELECT tag_name FROM portfolios WHERE user_id = $1 AND tag_id = $2 LIMIT 1`,
      [userId, finalTagId]
    );
    if (alreadySubscribedResult.rows.length > 0) {
      return {
        success: true,
        finalTagId,
        resolvedTagName,
        detectedType,
        enrichment: enrichment || undefined,
        enriched,
        backgroundEnrichmentStarted: false,
        alreadySubscribed: true,
      };
    }

    // 6. Подписка в портфель (используем каноническое resolvedTagName)
    await query(
      `INSERT INTO portfolios (user_id, tag_id, tag_name, tag_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, tag_id) DO NOTHING`,
      [userId, finalTagId, resolvedTagName, finalType]
    );

    // 7. Wake up no-tags articles только если тег был действительно создан сейчас
    if (isNewTag) {
      invalidateUserTagsCache();
      wakeUpNoTagsArticles().catch((err: any) => {
        console.error('[TagManager] wakeUpNoTagsArticles error:', err.message);
      });
    }

    return {
      success: true,
      finalTagId,
      resolvedTagName,
      detectedType,
      enrichment: enrichment || undefined,
      enriched,
      backgroundEnrichmentStarted,
      alreadySubscribed: false,
    };
  } catch (err: any) {
    console.error('[TagManager] Error creating tag:', err.message);
    return { success: false };
  }
}

// Асинхронное (фоновое) обогащение только что созданного тега.
// Запускается fire-and-forget из createUserTag — НЕ блокирует HTTP-ответ.
async function backgroundEnrichTag(tagId: string, tagName: string): Promise<void> {
  console.log(`[TagEnrich] Background enrichment started for "${tagName}" (${tagId})`);

  try {
    const enrichment = await enrichTagViaLLM(tagName);
    if (!enrichment) {
      console.log(`[TagEnrich] No enrichment data from LLM for "${tagName}"`);
      return;
    }

    const baseKeywords = generateTagKeywords(tagName);
    const enhancedKeywords = buildEnrichedKeywords(tagName, enrichment);
    const allKeywords = [...new Set([...baseKeywords, ...enhancedKeywords])]
      .filter(k => k.length >= 2 && k.length <= 50);

    const finalType = enrichment.tag_type || heuristicTagType(tagName);

    await query(
      `UPDATE user_defined_tags
       SET enriched_data = $1,
           keywords = $2,
           tag_type = $3
       WHERE tag_id = $4`,
      [JSON.stringify(enrichment), allKeywords, finalType, tagId]
    );

    // Обновить кэш тегов и разбудить no-tags-новости для повторного матчинга с новыми keywords
    invalidateUserTagsCache();
    wakeUpNoTagsArticles().catch((err: any) => {
      console.error('[TagManager] wakeUpNoTagsArticles error:', err.message);
    });

    // Запустить ретро-скан существующих новостей по новым keywords
    backfillTagMatches(tagId, { dryRun: false }).catch((err: any) => {
      console.error('[TagManager] backfillTagMatches error:', err.message);
    });

    console.log(`[TagEnrich] Background enrichment completed for "${tagName}" (${tagId}): type=${finalType}, keywords=${allKeywords.length}`);
  } catch (err: any) {
    console.error(`[TagEnrich] Background enrichment failed for "${tagName}" (${tagId}):`, err.message);
    // Не бросаем ошибку — обогащение факультативно
  }
}

// Получить все теги пользователя (стандартные + созданные)
export async function getUserTags(userId: string): Promise<any[]> {
  try {
    const result = await query(
      `SELECT tag_id, tag_name, tag_type FROM portfolios WHERE user_id = $1`,
      [userId]
    );
    return result.rows;
  } catch {
    return [];
  }
}

// Получить все пользовательские теги для smart matching (Layer 1)
// Returns enriched keywords: base + LLM synonyms + key products + related entities
export async function getAllUserDefinedTags(): Promise<Record<string, string[]>> {
  try {
    const result = await query(
      `SELECT tag_id, keywords, enriched_data FROM user_defined_tags`,
      []
    );
    const tags: Record<string, string[]> = {};
    for (const row of result.rows) {
      // Use enriched keywords if available, otherwise fall back to stored keywords
      if (row.enriched_data) {
        try {
          const enrichment: TagEnrichment =
            typeof row.enriched_data === 'string' ? JSON.parse(row.enriched_data) : row.enriched_data;
          tags[row.tag_id] = buildEnrichedKeywords(row.tag_id, enrichment);
          continue;
        } catch (err: any) {
          console.error('[TagManager] getAllUserDefinedTags parse error:', err.message);
          // JSON parse failed, fall through to stored keywords
        }
      }
      tags[row.tag_id] = row.keywords || [row.tag_id];
    }
    return tags;
  } catch {
    return {};
  }
}

// Получить список всех tag_id для LLM matching
export async function getAllTagNames(): Promise<string[]> {
  try {
    const result = await query(
      `SELECT tag_id FROM user_defined_tags ORDER BY tag_id`,
      []
    );
    return result.rows.map((row: any) => row.tag_id);
  } catch {
    return [];
  }
}

/**
 * Rebuild stored keywords from enriched_data.
 * Call this whenever enriched_data changes (admin edits, enrichment updates).
 */
export async function rebuildKeywordsFromEnrichment(tagId: string): Promise<string[]> {
  const result = await query(
    `SELECT tag_name, enriched_data FROM user_defined_tags WHERE tag_id = $1`,
    [tagId]
  );
  if (result.rows.length === 0) {
    return [];
  }

  const tagName = result.rows[0].tag_name || tagId;
  let enrichment = result.rows[0].enriched_data;
  if (typeof enrichment === 'string') {
    try { enrichment = JSON.parse(enrichment); } catch { enrichment = null; }
  }

  const keywords = buildEnrichedKeywords(tagName, enrichment || null);
  await query(
    `UPDATE user_defined_tags SET keywords = $1 WHERE tag_id = $2`,
    [keywords, tagId]
  );
  return keywords;
}

/**
 * Wake up articles previously marked as 'no-tags' so the news processor
 * can re-check them against newly created/updated tags.
 */
export async function wakeUpNoTagsArticles(): Promise<number> {
  invalidateUserTagsCache();
  try {
    const result = await query(
      `UPDATE news
       SET needs_translation = TRUE
       WHERE sentiment_source = 'no-tags'
         AND (matched_tags IS NULL OR matched_tags = '{}')
       RETURNING id`,
      []
    );
    const count = result.rows.length;
    if (count > 0) {
      console.log(`[TagManager] Woke up ${count} no-tags articles for re-check`);
    }
    return count;
  } catch (err: any) {
    console.error('[TagManager] wakeUpNoTagsArticles error:', err.message);
    return 0;
  }
}
