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

const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'moonshot-v1-8k';

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
        temperature: 0.1,
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
// Если tagType = 'auto' или пустой — определяем через LLM
export async function createUserTag(userId: string, tagId: string, tagName: string, tagType: string): Promise<{ success: boolean; detectedType?: TagType }> {
  try {
    // Auto-detect type if requested
    let finalType = tagType;
    let detectedType: TagType | undefined;

    if (!tagType || tagType === 'auto') {
      detectedType = await detectTagTypeViaLLM(tagName);
      finalType = detectedType;
    }

    // Validate type
    if (!TAG_TYPES.includes(finalType as TagType)) {
      finalType = 'company';
    }

    // Сохраняем тег в общую таблицу тегов
    const keywords = generateTagKeywords(tagName);

    await query(
      `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tag_id) DO NOTHING`,
      [tagId, tagName, finalType, keywords, userId]
    );

    // Добавляем в портфель пользователя
    await query(
      `INSERT INTO portfolios (user_id, tag_id, tag_name, tag_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, tag_id) DO NOTHING`,
      [userId, tagId, tagName, finalType]
    );

    return { success: true, detectedType };
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

// Получить все пользовательские теги для smart matching
export async function getAllUserDefinedTags(): Promise<Record<string, string[]>> {
  try {
    const result = await query(
      `SELECT tag_id, keywords FROM user_defined_tags`,
      []
    );
    const tags: Record<string, string[]> = {};
    for (const row of result.rows) {
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
