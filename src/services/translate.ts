import axios from 'axios';
import { query } from '../config/db';

const KIMI_API_KEY = process.env.KIMI_API_KEY;

// Model selection via env var:
//   moonshot-v1-8k  — fast, cheap, flexible temperature (default)
//   kimi-k2.5       — best quality, temperature MUST be 1, ~5x more tokens
const KIMI_MODEL = process.env.KIMI_MODEL || 'moonshot-v1-8k';

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
  // k2.5 needs temp=1 (not configurable) and uses more tokens — smaller batch
  const isK2 = KIMI_MODEL.startsWith('kimi-k');
  const BATCH = isK2 ? 3 : 5;
  const TEMP = isK2 ? 1 : 0.3;

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
          model: KIMI_MODEL,
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
          temperature: TEMP,
          max_tokens: isK2 ? 4000 : 3000,
        },
        {
          headers: {
            'Authorization': `Bearer ${KIMI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: isK2 ? 60000 : 30000,
        }
      );

      let content = response.data?.choices?.[0]?.message?.content || '';

      // k2.5 may return JSON inside markdown code blocks — extract it
      if (content.includes('```json')) {
        const codeMatch = content.match(/```json\n?([\s\S]*?)```/);
        if (codeMatch) content = codeMatch[1].trim();
      } else if (content.includes('```')) {
        const codeMatch = content.match(/```\n?([\s\S]*?)```/);
        if (codeMatch) content = codeMatch[1].trim();
      }

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
          console.log(`[Translate] ${KIMI_MODEL} translated ${validTexts.length} texts`);
          continue;
        }
      }

      // Fallback: try line-by-line parsing
      const lines = content.split('\n').filter((l: string) => l.trim() && !l.trim().startsWith('[') && !l.trim().startsWith(']'));
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
        console.log(`[Translate] ${KIMI_MODEL} line-parsed ${validTexts.length} texts`);
        continue;
      }

      console.log(`[Translate] ${KIMI_MODEL} parse failed, returning originals`);
      results.push(...batch);

    } catch (err: any) {
      console.error(`[Translate] ${KIMI_MODEL} error: ${err.message?.slice(0, 100)}`);
      results.push(...batch);
    }

    // Delay between batches
    if (i + BATCH < texts.length) {
      await new Promise(r => setTimeout(r, isK2 ? 1000 : 500));
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
