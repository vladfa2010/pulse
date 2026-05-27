/**
 * =============================================================================
 * PULSE — Smart Tag Matcher (3-layer matching)
 * =============================================================================
 *
 * Layer 1: Keyword matching (fast, 60-70% coverage)
 * Layer 2: LLM smart matching (for articles without keyword hits)
 * Layer 3: Semantic related tags (nvidia → tech, ai)
 *
 * Flow:
 *   1. Try keyword matching on title + summary
 *   2. If no matches → call LLM to analyze relevance
 *   3. LLM returns which tags apply (with confidence scores)
 *   4. Cache LLM results to avoid repeated calls
 */

import axios from 'axios';
import { query } from '../config/db';
import { getAllUserDefinedTags } from './tagManager';

const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'moonshot-v1-8k';
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: Enhanced Keyword Matching (with synonyms + related terms)
// ═══════════════════════════════════════════════════════════════════════════

export const TAG_KEYWORDS: Record<string, string[]> = {
  // Companies
  'sber': ['сбербанк', 'сбер', 'sberbank', 'sber', 'сбербанка', 'сбережбанк', 'сбера', 'сберу'],
  'gazprom': ['газпром', 'gazprom', 'газпрому', 'газпрома', 'газпромовск'],
  'yandex': ['яндекс', 'yandex', 'яндекса', 'яндексу'],
  'nvda': ['nvidia', 'nvda', 'енвидиа', 'видеокарт', 'geforce', 'rtx ', 'gpu ', 'графическ'],
  'tesla': ['tesla', 'тесла', 'musk', 'маск', 'elon', 'элон', 'модель 3', 'model 3', 'cybertruck', 'электромобил'],
  'apple': ['apple', 'эпл', 'iphone', 'ipad', 'macbook', 'mac ', 'ios', 'app store', 'тим кук'],
  'samsung': ['samsung', 'самсунг', 'galaxy'],
  'microsoft': ['microsoft', 'майкрософт', 'azure', 'windows'],
  'google': ['google', 'гугл', 'alphabet', 'android'],
  'amazon': ['amazon', 'амазон', 'aws', 'bezoz', 'безос'],
  'meta': ['meta', 'facebook', 'instagram', 'whatsapp', 'цукерберг', 'zuckerberg'],

  // Sectors
  'tech': ['технолог', 'technology', 'tech ', 'it-компан', 'айти', 'цифров', 'digital', 'software', 'hardware', 'startup', 'стартап', 'silicon valley'],
  'oil': ['нефт', 'нефть', 'oil', 'газ', 'газов', 'opec', 'опек', 'баррел', 'barrel', 'нфт', 'добыч', 'трубопровод'],
  'gold': ['золот', 'gold', 'золото', 'драгметал', 'серебр', 'silver', 'precious metal'],
  'bank': ['банк', 'bank', 'банковск', 'кредит', 'депозит', 'ипотек', 'ставк', 'цб ', 'центробанк', 'central bank'],
  'realestate': ['недвижимост', 'real estate', 'жиль', 'ипотек', 'квартиру', 'застройщик', 'строительств'],

  // Trends
  'crypto': ['криптовалют', 'bitcoin', 'биткоин', 'ethereum', 'эфириум', 'блокчейн', 'blockchain', 'altcoin', 'binance', 'coinbase', 'майнинг', 'defi', 'nft ', 'web3'],
  'ai': ['искусственный интеллект', 'ии ', 'нейросет', 'chatgpt', 'gpt', 'llm', 'machine learning', 'openai', 'anthropic', 'claude', 'midjourney', 'stable diffusion', 'искин', 'большой языковой модел', 'generative ai'],
  'fed': ['фрс', 'федеральный резерв', 'fed', 'federal reserve', 'powell', 'паунел', 'процентн', 'ставка', 'ставки', 'inflation', 'инфляц', 'доллар', 'usd', 'treasury', 'казначейств'],
  'greentech': ['зелен', 'green', 'эколог', 'eco', 'возобновляем', 'renewable', 'solar', 'wind', 'carbon', 'углерод', 'climate', 'климат'],
  'space': ['космос', 'space', 'космическ', 'спутник', 'rocket', 'ракет', 'mars', 'марс', 'orbital', 'наса', 'nasa', 'роскосмос'],
};

// Related tags — when user adds tag X, suggest these
export const RELATED_TAGS: Record<string, string[]> = {
  'nvda': ['tech', 'ai', 'gaming'],
  'tesla': ['tech', 'ai', 'elon'],
  'apple': ['tech', 'ai'],
  'google': ['tech', 'ai'],
  'microsoft': ['tech', 'ai'],
  'meta': ['tech', 'ai'],
  'sber': ['bank', 'tech', 'ai'],
  'crypto': ['tech', 'fed', 'bank'],
  'ai': ['tech', 'nvda', 'google', 'microsoft'],
  'fed': ['bank', 'gold', 'crypto'],
  'oil': ['gold', 'fed'],
  'gold': ['fed', 'oil'],
  'gazprom': ['oil', 'gold'],
  'yandex': ['tech', 'ai'],
  'space': ['tech', 'ai'],
  'greentech': ['tech', 'oil', 'gold'],
  'amazon': ['tech', 'ai'],
  'samsung': ['tech', 'ai'],
};

// Get related tags for a given tag ID
export function getRelatedTags(tagId: string): string[] {
  return RELATED_TAGS[tagId] || [];
}

// Layer 1: Keyword matching
// Кэш пользовательских тегов (обновляется при вызове)
let userTagsCache: Record<string, string[]> = {};
let userTagsCacheTime = 0;
const USER_TAGS_CACHE_TTL = 60 * 1000; // 1 минута

async function getCachedUserTags(): Promise<Record<string, string[]>> {
  const now = Date.now();
  if (now - userTagsCacheTime > USER_TAGS_CACHE_TTL) {
    userTagsCache = await getAllUserDefinedTags();
    userTagsCacheTime = now;
  }
  return userTagsCache;
}

export async function matchTagsByKeywords(text: string): Promise<string[]> {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  // Layer 1a: Стандартные теги
  for (const [tagId, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
      if (!matched.includes(tagId)) {
        matched.push(tagId);
      }
    }
  }

  // Layer 1b: Пользовательские теги
  const userTags = await getCachedUserTags();
  for (const [tagId, keywords] of Object.entries(userTags)) {
    if (keywords.some(kw => lower.includes(kw.toLowerCase()))) {
      if (!matched.includes(tagId)) {
        matched.push(tagId);
      }
    }
  }

  return matched;
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: LLM Smart Matching
// ═══════════════════════════════════════════════════════════════════════════

interface LLMTagResult {
  tagId: string;
  confidence: number; // 0-1
  reasoning: string;
}

// Cache for LLM results (hash of text → tags)
async function getLLMCache(textHash: string): Promise<string[] | null> {
  try {
    const result = await query(
      `SELECT tags FROM smart_tag_cache WHERE text_hash = $1 AND created_at > NOW() - INTERVAL '7 days'`,
      [textHash]
    );
    if (result.rows.length > 0) {
      return result.rows[0].tags;
    }
  } catch { /* ignore */ }
  return null;
}

async function saveLLMCache(textHash: string, tags: string[]): Promise<void> {
  try {
    await query(
      `INSERT INTO smart_tag_cache (text_hash, tags) VALUES ($1, $2)
       ON CONFLICT (text_hash) DO UPDATE SET tags = $2, created_at = NOW()`,
      [textHash, tags]
    );
  } catch { /* ignore */ }
}

// Build LLM prompt for tag matching
function buildTagPrompt(title: string, summary: string, availableTags: string[]): string {
  const tagDescriptions = availableTags.map(id => {
    const keywords = TAG_KEYWORDS[id];
    return `- ${id}${keywords ? ` (${keywords.slice(0, 3).join(', ')})` : ''}`;
  }).join('\n');

  return `Analyze this news article and determine which of the following tags apply.

Article title: ${title.slice(0, 200)}
Article summary: ${summary.slice(0, 400)}

Available tags:
${tagDescriptions}

Instructions:
1. Return ONLY a JSON array of tag IDs that apply to this article
2. Be strict — only include tags that are clearly relevant
3. Consider both direct mentions and strong thematic connections
4. Return empty array [] if no tags match

Response format: ["tag1", "tag2"] or []`;
}

// Call Kimi API for smart matching
async function callLLMForTags(title: string, summary: string, availableTags: string[]): Promise<string[]> {
  if (!KIMI_API_KEY) {
    console.log('[SmartTags] No KIMI_API_KEY, skipping LLM matching');
    return [];
  }

  const prompt = buildTagPrompt(title, summary, availableTags);
  const textHash = Buffer.from(title + summary).toString('base64').slice(0, 64);

  // Check cache first
  const cached = await getLLMCache(textHash);
  if (cached) {
    console.log('[SmartTags] LLM cache hit');
    return cached;
  }

  try {
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: KIMI_MODEL.startsWith('kimi-k') ? 1 : 0.1,
        max_tokens: 200,
      },
      {
        headers: {
          'Authorization': `Bearer ${KIMI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: KIMI_MODEL.startsWith('kimi-k') ? 30000 : 15000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';

    // Extract JSON array from response
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        // Filter only valid tag IDs
        const validTags = parsed.filter((t: string) => availableTags.includes(t));
        console.log(`[SmartTags] LLM returned tags: ${validTags.join(', ')}`);
        await saveLLMCache(textHash, validTags);
        return validTags;
      }
    }
  } catch (err: any) {
    console.log(`[SmartTags] LLM error: ${err.message?.slice(0, 100)}`);
  }

  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// Main function: 3-layer matching
// ═══════════════════════════════════════════════════════════════════════════

export async function smartMatchTags(
  title: string,
  summary: string,
  options: { useLLM?: boolean } = {}
): Promise<string[]> {
  const fullText = `${title} ${summary}`;

  // Layer 1: Keyword matching (standard + user-defined tags)
  const keywordTags = await matchTagsByKeywords(fullText);

  if (keywordTags.length > 0) {
    console.log(`[SmartTags] Keyword match: ${keywordTags.join(', ')} for "${title.slice(0, 50)}..."`);
    return keywordTags;
  }

  // Layer 2: LLM matching (only if no keyword match AND useLLM is true)
  if (options.useLLM !== false && KIMI_API_KEY) {
    const availableTags = Object.keys(TAG_KEYWORDS);
    const llmTags = await callLLMForTags(title, summary, availableTags);
    if (llmTags.length > 0) {
      console.log(`[SmartTags] LLM match: ${llmTags.join(', ')} for "${title.slice(0, 50)}..."`);
      return llmTags;
    }
  }

  // No match found
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM Sentiment Analysis (more accurate than keyword-based)
// ═══════════════════════════════════════════════════════════════════════════

export async function analyzeSentimentLLM(title: string, summary: string): Promise<'positive' | 'negative' | 'neutral'> {
  if (!KIMI_API_KEY) {
    console.log('[SentimentLLM] No KIMI_API_KEY');
    return 'neutral';
  }

  const prompt = `Analyze the sentiment of this financial news article.

Title: ${title.slice(0, 200)}
Summary: ${summary.slice(0, 400)}

Return ONLY one word: positive, negative, or neutral.`;

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
        headers: { 'Authorization': `Bearer ${KIMI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: KIMI_MODEL.startsWith('kimi-k') ? 30000 : 10000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content?.toLowerCase() || '';
    console.log(`[SentimentLLM] Raw: "${content}" for "${title.slice(0, 30)}..."`);
    if (content.includes('positive')) return 'positive';
    if (content.includes('negative')) return 'negative';
    return 'neutral';
  } catch (err: any) {
    console.error(`[SentimentLLM] Error: ${err.message?.slice(0, 100)}`);
    return 'neutral';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tag Impact Analysis — how does the news affect each tag?
// ═══════════════════════════════════════════════════════════════════════════

export interface TagImpact {
  tag: string;
  impact: 'positive' | 'negative' | 'neutral';
  reasoning: string;
}

export async function analyzeTagImpact(title: string, summary: string, tags: string[]): Promise<TagImpact[]> {
  if (!KIMI_API_KEY || tags.length === 0) {
    return tags.map(t => ({ tag: t, impact: 'neutral', reasoning: '' }));
  }

  const prompt = `Analyze how this financial news article affects the following tags.

Article title: ${title.slice(0, 200)}
Article summary: ${summary.slice(0, 400)}

Tags to analyze: ${tags.join(', ')}

For each tag, determine if the news is positive, negative, or neutral for it.
Example: "Tesla stock drops 10%" → tesla: negative, nvda: neutral

Return ONLY a JSON array:
[{"tag":"tesla","impact":"negative","reasoning":"Stock price dropped"}, ...]`;

  try {
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: KIMI_MODEL.startsWith('kimi-k') ? 1 : 0.1,
        max_tokens: 500,
      },
      {
        headers: { 'Authorization': `Bearer ${KIMI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: KIMI_MODEL.startsWith('kimi-k') ? 30000 : 15000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    console.log(`[TagImpact] Raw: ${content.slice(0, 200)}`);
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const result = parsed
          .filter((p: any) => tags.includes(p.tag))
          .map((p: any) => ({
            tag: p.tag,
            impact: ['positive', 'negative'].includes(p.impact) ? p.impact : 'neutral',
            reasoning: p.reasoning || '',
          }));
        console.log(`[TagImpact] Result: ${JSON.stringify(result)}`);
        return result;
      }
    }
  } catch (err: any) {
    console.error(`[TagImpact] Error: ${err.message?.slice(0, 100)}`);
  }

  return tags.map(t => ({ tag: t, impact: 'neutral', reasoning: '' }));
}
