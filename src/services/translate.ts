import axios from 'axios';
import { query } from '../config/db';

const KIMI_API_KEY = process.env.KIMI_API_KEY;

// ═══════════════════════════════════════════════════════════════════════════
// Kimi Translation (primary)
// ═══════════════════════════════════════════════════════════════════════════

export async function translateWithKimi(texts: string[]): Promise<string[]> {
  if (!KIMI_API_KEY) {
    console.log('[Translate] No KIMI_API_KEY, skipping translation');
    return texts;
  }

  const results: string[] = [];
  const BATCH = 5; // Kimi: 5 текстов за раз

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const validTexts = batch.filter(t => t && t.length > 2);

    if (validTexts.length === 0) {
      results.push(...batch);
      continue;
    }

    // Формируем JSON-запрос
    const jsonInput = JSON.stringify(validTexts);

    try {
      const response = await axios.post(
        'https://api.moonshot.cn/v1/chat/completions',
        {
          model: 'moonshot-v1-8k',
          messages: [
            {
              role: 'system',
              content: 'You are a professional translator. Translate English financial news to Russian. Return ONLY a JSON array of translated strings, same order. Preserve names, tickers, numbers. No extra text.'
            },
            {
              role: 'user',
              content: `Translate to Russian: ${jsonInput}`
            }
          ],
          temperature: 0.1,
          max_tokens: 2000,
        },
        {
          headers: {
            'Authorization': `Bearer ${KIMI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );

      const content = response.data?.choices?.[0]?.message?.content || '';

      // Extract JSON array
      const jsonMatch = content.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.length === validTexts.length) {
          // Map back to original positions
          let validIdx = 0;
          for (const original of batch) {
            if (original && original.length > 2 && validIdx < parsed.length) {
              results.push(parsed[validIdx]);
              validIdx++;
            } else {
              results.push(original);
            }
          }
          console.log(`[Translate] Kimi translated ${validTexts.length} texts`);
          continue;
        }
      }

      // Fallback: return originals
      console.log('[Translate] Kimi parse failed, returning originals');
      results.push(...batch);

    } catch (err: any) {
      console.error(`[Translate] Kimi error: ${err.message?.slice(0, 100)}`);
      results.push(...batch);
    }

    // Delay between batches
    if (i + BATCH < texts.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// translateBatch — main entry point
// ═══════════════════════════════════════════════════════════════════════════

export async function translateBatch(texts: string[]): Promise<string[]> {
  // Skip if no Kimi key
  if (!KIMI_API_KEY) {
    return texts;
  }

  // Filter: only translate EN texts (contain latin chars, no cyrillic)
  const toTranslate: { index: number; text: string }[] = [];
  const results: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const hasCyrillic = /[а-яё]/i.test(text);
    const hasLatin = /[a-z]/i.test(text);

    if (hasLatin && !hasCyrillic && text.length > 5) {
      toTranslate.push({ index: i, text });
    } else {
      results[i] = text; // Already Russian or short
    }
  }

  if (toTranslate.length === 0) {
    return texts;
  }

  console.log(`[Translate] ${toTranslate.length} texts need translation`);

  // Translate via Kimi
  const textsToTranslate = toTranslate.map(t => t.text);
  const translated = await translateWithKimi(textsToTranslate);

  // Map back
  for (let i = 0; i < toTranslate.length; i++) {
    const { index } = toTranslate[i];
    results[index] = translated[i] || texts[index];
  }

  return results;
}
