import axios from 'axios';
import { query } from '../config/db';

const TRANSLATION_API_KEY = process.env.TRANSLATION_API_KEY;
const USE_SQLITE = process.env.USE_SQLITE === 'true';

function nowMinusDaysSql(days: number): string {
  return USE_SQLITE
    ? `datetime('now', '-${days} days')`
    : `NOW() - INTERVAL '${days} days'`;
}

// Check cache first
export async function getCachedTranslation(textEn: string): Promise<string | null> {
  try {
    const hash = Buffer.from(textEn).toString('base64').slice(0, 64);
    const result = await query(
      `SELECT text_ru FROM translation_cache WHERE hash = $1 AND created_at > ${nowMinusDaysSql(30)}`,
      [hash]
    );
    return result.rows.length > 0 ? result.rows[0].text_ru : null;
  } catch {
    return null;
  }
}

// Save to cache
export async function saveTranslation(textEn: string, textRu: string): Promise<void> {
  try {
    const hash = Buffer.from(textEn).toString('base64').slice(0, 64);
    if (USE_SQLITE) {
      await query(
        `INSERT OR IGNORE INTO translation_cache (id, hash, text_en, text_ru)
         VALUES ($1, $2, $3, $4)`,
        [crypto.randomUUID ? crypto.randomUUID() : hash.slice(0, 36), hash, textEn, textRu]
      );
    } else {
      await query(
        `INSERT INTO translation_cache (hash, text_en, text_ru)
         VALUES ($1, $2, $3)
         ON CONFLICT (hash) DO NOTHING`,
        [hash, textEn, textRu]
      );
    }
  } catch {
    // Ignore cache errors
  }
}

// Translate via my API (Kimi) — placeholder for integration
export async function translateWithKimi(texts: string[]): Promise<string[]> {
  // TODO: Integrate with actual Kimi API
  // For now, return original texts (will be replaced with actual API call)
  console.log('[Translate] Kimi API call for', texts.length, 'texts');
  return texts;
}

// Fallback: Google Translate (free tier)
export async function translateWithGoogle(texts: string[]): Promise<string[]> {
  try {
    const results = await Promise.all(
      texts.map(async (text) => {
        if (!text || text.length < 2) return text;
        const response = await axios.post(
          'https://translate.googleapis.com/translate_a/single',
          null,
          {
            params: {
              client: 'gtx',
              sl: 'en',
              tl: 'ru',
              dt: 't',
              q: text,
            },
            timeout: 5000,
          }
        );
        return response.data[0][0][0] || text;
      })
    );
    return results;
  } catch {
    return texts;
  }
}

// Main translate function: cache → Kimi → Google
export async function translateBatch(texts: string[]): Promise<string[]> {
  const results: string[] = [];
  const toTranslate: { index: number; text: string }[] = [];

  // Check cache
  for (let i = 0; i < texts.length; i++) {
    const cached = await getCachedTranslation(texts[i]);
    if (cached) {
      results[i] = cached;
    } else {
      toTranslate.push({ index: i, text: texts[i] });
    }
  }

  if (toTranslate.length === 0) return results;

  // Try Kimi API first
  const kimiTexts = toTranslate.map(t => t.text);
  let translated: string[];

  try {
    translated = await translateWithKimi(kimiTexts);
    // If Kimi returns same texts (not translated), try Google
    if (translated[0] === kimiTexts[0]) {
      throw new Error('Kimi did not translate');
    }
  } catch {
    translated = await translateWithGoogle(kimiTexts);
  }

  // Save results and cache
  for (let i = 0; i < toTranslate.length; i++) {
    const { index, text } = toTranslate[i];
    results[index] = translated[i];
    await saveTranslat