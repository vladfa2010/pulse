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

// Создать пользовательский тег
export async function createUserTag(userId: string, tagId: string, tagName: string, tagType: string): Promise<boolean> {
  try {
    // Сохраняем тег в общую таблицу тегов
    const keywords = generateTagKeywords(tagName);

    await query(
      `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tag_id) DO NOTHING`,
      [tagId, tagName, tagType, keywords, userId]
    );

    // Добавляем в портфель пользователя
    await query(
      `INSERT INTO portfolios (user_id, tag_id, tag_name, tag_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, tag_id) DO NOTHING`,
      [userId, tagId, tagName, tagType]
    );

    return true;
  } catch (err: any) {
    console.error('[TagManager] Error creating tag:', err.message);
    return false;
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
