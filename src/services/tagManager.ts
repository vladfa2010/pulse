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
  website?: string;            // Official website (e.g. https://www.apple.com)
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

  const prompt = `You are a financial data enrichment system. Analyze this tag and return structured data.

Tag name: "${tagName}"

Return ONLY a JSON object with this exact structure:
{
  "tag_type": "company",        // One of: company, ticker, sector, trend, person, commodity, index, currency
  "ticker": "AAPL",             // Stock ticker if applicable, else null
  "website": "https://www.apple.com",  // Official company website. null if not a company/person, or unknown
  "related_entities": ["Microsoft", "Google"],  // Related companies, sectors, or people (5-10 items)
  "synonyms_en": ["Apple Inc", "iPhone maker", "Cupertino"],  // English synonyms/aliases (5-10 items)
  "synonyms_ru": ["Эпл", "эппл", "яблочная компания"],       // Russian synonyms/aliases (5-10 items)
  "key_products": ["iPhone", "iPad", "Mac", "App Store", "Apple Watch"],  // Key products/services (5-10 items)
  "description_ru": "Apple — американская технологическая корпорация, специализирующаяся на производстве потребительской электроники, программного обеспечения и онлайн-сервисов. Компания была основана Стивом Джобсом, Стивом Возняком и Рональдом Уэйном в 1976 году в Калифорнии.\\n\\nСегодня Apple является одной из крупнейших компаний мира по рыночной капитализации. Её основные продукты включают смартфоны iPhone, компьютеры Mac, планшеты iPad, а также сервисы App Store, Apple Music и iCloud. Акции компании торгуются на NASDAQ под тикером AAPL."
}

Rules:
1. Return ONLY valid JSON, no markdown, no extra text
2. description_ru: Write 2 paragraphs in RUSSIAN. Paragraph 1 = what the company/person/sector is (origin, founding). Paragraph 2 = current status, main activities, stock exchange if applicable. Use \\n\\n between paragraphs.
3. website: Official company/person website URL starting with https://. null if unknown or not a company/person.
4. If tag is a person: ticker=null, website=personal site or Wikipedia link, related_entities=their companies, key_products=their initiatives
5. If tag is a sector/index/trend: ticker=null, website=null, related_entities=major constituents
6. synonyms_ru must include common Russian transliterations and nicknames
7. All arrays must have at least 3 items, at most 15 items
8. tag_type MUST be one of: company, ticker, sector, trend, person, commodity, index, currency
9. description_ru must be written in natural, fluent Russian (not translated from English)
10. Use CURRENT data as of 2026 — stock exchange listings, company status, ownership should reflect 2026 reality`;

// Reset to v1-32k (kimi-k2 may not be available on current plan)
// User can override via KIMI_MODEL env var

  try {
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: KIMI_MODEL.startsWith('kimi-k') ? 0.6 : 0.1,
        max_tokens: 1200,
        thinking: KIMI_MODEL.startsWith('kimi-k') ? { type: 'disabled' } : undefined,
      },
      {
        headers: {
          'Authorization': `Bearer ${KIMI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';

    // Extract JSON object
    const jsonMatch = content.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);

      // Validate and normalize
      const enrichment: TagEnrichment = {
        tag_type: TAG_TYPES.includes(parsed.tag_type) ? parsed.tag_type : 'company',
        ticker: parsed.ticker || undefined,
        website: parsed.website || undefined,
        related_entities: Array.isArray(parsed.related_entities) ? parsed.related_entities : [],
        synonyms_en: Array.isArray(parsed.synonyms_en) ? parsed.synonyms_en : [],
        synonyms_ru: Array.isArray(parsed.synonyms_ru) ? parsed.synonyms_ru : [],
        key_products: Array.isArray(parsed.key_products) ? parsed.key_products : [],
        description_ru: parsed.description_ru || parsed.description || '',
      };

      console.log(`[TagEnrich] Enriched "${tagName}": type=${enrichment.tag_type}, ticker=${enrichment.ticker || 'none'}, synonyms=${enrichment.synonyms_en.length + enrichment.synonyms_ru.length}, products=${enrichment.key_products.length}`);
      return enrichment;
    }
  } catch (err: any) {
    console.log(`[TagEnrich] LLM error for "${tagName}": ${err.message?.slice(0, 100)}`);
  }

  return null;
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

// Создать пользовательский тег
// Если tagType = 'auto' или пустой — определяем через LLM + enrichment
// При добавлении существующего тега user_defined_tags НЕ модифицируется.
export async function createUserTag(userId: string, tagId: string, tagName: string, tagType: string): Promise<{ success: boolean; finalTagId?: string; detectedType?: TagType; enrichment?: TagEnrichment }> {
  try {
    // 1. Сначала ищем точное совпадение по tag_id, затем — по названию.
    //    Это предотвращает подписку на дубль с другим ID при клике по конкретной карточке.
    let existingResult = await query(
      `SELECT tag_id, tag_name, tag_type, enriched_data, keywords, created_by
       FROM user_defined_tags
       WHERE tag_id = $1
       LIMIT 1`,
      [tagId]
    );

    if (existingResult.rows.length === 0) {
      existingResult = await query(
        `SELECT tag_id, tag_name, tag_type, enriched_data, keywords, created_by
         FROM user_defined_tags
         WHERE LOWER(tag_name) = LOWER($1)
         LIMIT 1`,
        [tagName]
      );
    }

    let finalType: string;
    let finalTagId = tagId;
    let detectedType: TagType | undefined;
    let enrichment: TagEnrichment | null = null;
    let isNewTag = false;

    if (existingResult.rows.length > 0) {
      // --- Тег уже есть: НЕ трогаем user_defined_tags ---
      const existing = existingResult.rows[0];
      finalTagId = existing.tag_id;
      finalType = existing.tag_type;
      detectedType = existing.tag_type as TagType;
      enrichment = existing.enriched_data || null;
      console.log(`[TagManager] Tag already exists by name/id "${existing.tag_name}" (${finalTagId}), subscribing user ${userId}`);
    } else {
      // --- Тега нет: создаём с LLM-обогащением ---
      if (!tagType || tagType === 'auto') {
        enrichment = await enrichTagViaLLM(tagName);
        if (enrichment) {
          detectedType = enrichment.tag_type;
          finalType = enrichment.tag_type;
        } else {
          detectedType = await detectTagTypeViaLLM(tagName);
          finalType = detectedType;
        }
      } else {
        finalType = tagType;
      }

      // Validate type
      if (!TAG_TYPES.includes(finalType as TagType)) {
        finalType = 'company';
      }

      // Build enriched keywords (base + LLM synonyms + products)
      const keywords = enrichment
        ? buildEnrichedKeywords(tagName, enrichment)
        : generateTagKeywords(tagName);

      // Save tag with enrichment data (no ON CONFLICT UPDATE)
      try {
        await query(
          `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords, enriched_data, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [tagId, tagName, finalType, keywords, enrichment ? JSON.stringify(enrichment) : null, userId]
        );
        isNewTag = true;
        console.log(`[TagManager] Created tag "${tagId}": type=${finalType}, keywords=${keywords.length}${enrichment ? ', enriched' : ''}`);
      } catch (err: any) {
        if (err.code === '23505') {
          // Race condition: другой пользователь создал тег между SELECT и INSERT
          const raceResult = await query(
            `SELECT tag_id, tag_type FROM user_defined_tags WHERE tag_id = $1 LIMIT 1`,
            [tagId]
          );
          if (raceResult.rows.length === 0) {
            const raceNameResult = await query(
              `SELECT tag_id, tag_type FROM user_defined_tags WHERE LOWER(tag_name) = LOWER($1) LIMIT 1`,
              [tagName]
            );
            if (raceNameResult.rows.length > 0) {
              raceResult.rows = raceNameResult.rows;
            }
          }
          finalTagId = raceResult.rows[0]?.tag_id || tagId;
          finalType = raceResult.rows[0]?.tag_type || finalType;
          detectedType = finalType as TagType;
          enrichment = null;
          console.log(`[TagManager] Tag "${tagId}" created by another user, using existing ${finalTagId} type=${finalType}`);
        } else {
          throw err;
        }
      }
    }

    // 2. Подписка в портфель (всегда, независимо от создания/существования)
    await query(
      `INSERT INTO portfolios (user_id, tag_id, tag_name, tag_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, tag_id) DO NOTHING`,
      [userId, finalTagId, tagName, finalType]
    );

    // 3. Wake up no-tags articles только если тег был действительно создан сейчас
    if (isNewTag) {
      invalidateUserTagsCache();
      wakeUpNoTagsArticles().catch((err: any) => {
        console.error('[TagManager] wakeUpNoTagsArticles error:', err.message);
      });
    }

    return { success: true, finalTagId, detectedType, enrichment: enrichment || undefined };
  } catch (err: any) {
    console.error('[TagManager] Error creating tag:', err.message);
    return { success: false };
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
    `SELECT enriched_data FROM user_defined_tags WHERE tag_id = $1`,
    [tagId]
  );
  if (result.rows.length === 0) {
    return [];
  }

  let enrichment = result.rows[0].enriched_data;
  if (typeof enrichment === 'string') {
    try { enrichment = JSON.parse(enrichment); } catch { enrichment = null; }
  }

  const keywords = buildEnrichedKeywords(tagId, enrichment || null);
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
