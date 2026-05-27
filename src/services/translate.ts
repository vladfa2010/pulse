import axios from 'axios';
import { query } from '../config/db';

const KIMI_API_KEY = process.env.KIMI_API_KEY;

// ═══════════════════════════════════════════════════════════════════════════
// Kimi Translation (primary)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Enhanced system prompt for high-quality Russian financial translation
// ═══════════════════════════════════════════════════════════════════════════
const TRANSLATION_PROMPT = `You are a senior financial news editor translating English headlines into Russian for a premium investment platform PULSE.

STRICT RULES:
1. Use professional business Russian — confident, precise, editorial quality
2. Preserve ALL names, tickers, numbers, dates, percentages, dollar amounts exactly
3. Use Russian financial terminology: "акции" (not "стоки"), "прибыль" (not "профит"), "выручка", "капитализация", "дивиденды", "облигации", "фьючерсы"
4. Short headlines preferred — under 90 characters if possible
5. Active voice, strong verbs, no filler words
6. Adapt idioms to Russian business context, don't translate literally

EXAMPLES:
- "Apple Earnings Beat Expectations, Stock Jumps 5%" → "Apple превзошла прогнозы по прибыли, акции взлетели на 5%"
- "Fed Signals Potential Rate Cuts in September" → "ФРС намекнула на возможное снижение ставок в сентябре"
- "Tesla Shares Plunge After Weak Delivery Numbers" → "Акции Tesla рухнули на фоне слабых данных по поставкам"
- "Oil Prices Hit 6-Month High on Supply Concerns" → "Нефть обновила 6-месячный максимум из-за опасений по поставкам"

Return ONLY a JSON array of translated strings in the SAME ORDER as input. No commentary, no markdown, just JSON array.`;

export async function translateWithKimi(texts: string[]): Promise<string[]> {
  if (!KIMI_API_KEY) {
    console.log('[Translate] No KIMI_API_KEY, skipping translation');
    return texts;
  }

  const results: string[] = [];
  const BATCH = 3; // Smaller batch for better quality context

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const validTexts = batch.filter(t => t && t.length > 2);

    if (validTexts.length === 0) {
      results.push(...batch);
      continue;
    }

    // Формируем нумерованный список для лучшего порядка
    const numberedInput = validTexts.map((t, idx) => `${idx + 1}. ${t}`).join('\n');

    try {
      const response = await axios.post(
        'https://api.moonshot.ai/v1/chat/completions',
        {
          model: 'moonshot-v1-32k', // More capable model
          messages: [
            {
              role: 'system',
              content: TRANSLATION_PROMPT,
            },
            {
              role: 'user',
              content: `Translate these ${validTexts.length} financial news headlines to Russian. Return as JSON array in same order:\n${numberedInput}`
            }
          ],
          temperature: 0.3, // More natural than 0.1
          max_tokens: 3000,
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
          // Clean up: remove numbering if model added it
          const cleaned = parsed.map((s: string) => s.replace(/^\d+\.\s*/, '').trim());
          let validIdx = 0;
          for (const original of batch) {
            if (original && original.length > 2 && validIdx < cleaned.length) {
              results.push(cleaned[validIdx]);
              validIdx++;
            } else {
              results.push(original);
            }
          }
          console.log(`[Translate] Kimi translated ${validTexts.length} texts (moonshot-v1-32k)`);
          continue;
        }
      }

      // Fallback: try line-by-line parsing
      const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('[') && !l.trim().startsWith(']'));
      if (lines.length === validTexts.length) {
        const cleaned = lines.map((s: string) => s.replace(/^\d+\.\s*["']?|["']?,?\s*$/g, '').trim());
        let validIdx = 0;
        for (const original of batch) {
          if (original && original.length > 2 && validIdx < cleaned.length) {
            results.push(cleaned[validIdx]);
            validIdx++;
          } else {
            results.push(original);
          }
        }
        console.log(`[Translate] Kimi line-parsed ${validTexts.length} texts`);
        continue;
      }

      console.log('[Translate] Kimi parse failed, returning originals');
      results.push(...batch);

    } catch (err: any) {
      console.error(`[Translate] Kimi error: ${err.message?.slice(0, 100)}`);
      results.push(...batch);
    }

    // Delay between batches
    if (i + BATCH < texts.length) {
      await new Promise(r => setTimeout(r, 800));
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
