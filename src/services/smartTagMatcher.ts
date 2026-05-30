/**
 * =============================================================================
 * PULSE — Smart Tag Matcher (3-layer matching)
 * =============================================================================
 *
 * Architecture: ONLY user-defined tags. No hardcoded keywords.
 *
 * Layer 1: Keyword matching via user-defined tags from DB
 * Layer 2: LLM smart matching (ONLY if Layer 1 finds nothing — saves tokens)
 * Layer 3: LLM-based related tags (dynamic, no hardcoded mappings)
 *
 * Flow:
 *   1. Fetch enriched user-defined tags with keywords from DB
 *   2. Layer 1: keyword matching on title + summary (enriched keywords ~85-90% coverage)
 *   3. Layer 2: call LLM ONLY if Layer 1 found no matches
 *   4. Union: Layer 1 results ∪ Layer 2 results (deduplicated)
 *   5. Cache LLM results to avoid repeated calls
 *   6. For related tags → LLM suggests semantically connected tags
 */

import axios from 'axios';
import { query } from '../config/db';
import { getAllUserDefinedTags, getAllTagNames } from './tagManager';

const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'moonshot-v1-32k';

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: Keyword Matching (user-defined tags only)
// ═══════════════════════════════════════════════════════════════════════════

// Cache user tags from DB (refresh every 60s)
let userTagsCache: Record<string, string[]> = {};
let userTagsCacheTime = 0;
const USER_TAGS_CACHE_TTL = 60 * 1000;

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

  // Only user-defined tags from DB — no hardcoded keywords
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
  const tagList = availableTags.map(id => `- ${id}`).join('\n');

  return `Analyze this news article and determine which of the following tags apply.

Article title: ${title.slice(0, 200)}
Article summary: ${summary.slice(0, 400)}

Available tags:
${tagList}

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

  if (availableTags.length === 0) {
    console.log('[SmartTags] No tags in DB, skipping LLM matching');
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
    const jsonMatch = content.match(/\[\s\S]*?\]/);
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
// Layer 3: LLM-Based Related Tags (replaces hardcoded RELATED_TAGS)
// ═══════════════════════════════════════════════════════════════════════════

// Cache for related tags (tagId → relatedTagIds)
const relatedTagsCache: Map<string, { tags: string[]; time: number }> = new Map();
const RELATED_TAGS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Get related tags for a given tag using LLM.
 * Dynamically determines semantic connections — no hardcoded mappings.
 */
export async function getRelatedTags(tagId: string, allTagIds?: string[]): Promise<string[]> {
  // Check cache first
  const cached = relatedTagsCache.get(tagId);
  if (cached && Date.now() - cached.time < RELATED_TAGS_CACHE_TTL) {
    return cached.tags;
  }

  if (!KIMI_API_KEY) {
    return [];
  }

  // Fetch all tag IDs if not provided
  const availableTags = allTagIds || await getAllTagNames();

  // Exclude the tag itself
  const otherTags = availableTags.filter(t => t !== tagId);
  if (otherTags.length === 0) {
    return [];
  }

  const prompt = `Given the tag "${tagId}", which of the following tags are semantically related or commonly associated with it?

Candidate tags: ${otherTags.join(', ')}

Instructions:
1. Return ONLY a JSON array of related tag IDs
2. Tags are related if they belong to the same sector, industry, or are commonly mentioned together
3. Be selective — return only strongly related tags (0-5 tags)
4. Return empty array [] if no strong connections exist

Response format: ["tag1", "tag2"] or []`;

  try {
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 150,
      },
      {
        headers: {
          'Authorization': `Bearer ${KIMI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\[\s\S]*?\]/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const validTags = parsed.filter((t: string) => otherTags.includes(t));
        // Cache result
        relatedTagsCache.set(tagId, { tags: validTags, time: Date.now() });
        console.log(`[RelatedTags] LLM related for "${tagId}": ${validTags.join(', ') || 'none'}`);
        return validTags;
      }
    }
  } catch (err: any) {
    console.log(`[RelatedTags] LLM error for "${tagId}": ${err.message?.slice(0, 100)}`);
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

  // Layer 1: Keyword matching (user-defined tags from DB) — всегда выполняем
  const keywordTags = await matchTagsByKeywords(fullText);

  // Layer 2: LLM matching — ТОЛЬКО если Layer 1 ничего не нашёл (оптимизация)
  // Обогащённые keywords в Layer 1 покрывают ~85-90% случаев
  let llmTags: string[] = [];
  if (keywordTags.length === 0 && options.useLLM !== false && KIMI_API_KEY) {
    const availableTags = await getAllTagNames();
    llmTags = await callLLMForTags(title, summary, availableTags);
  }

  // Union: Layer 1 ∪ Layer 2 (deduplicate)
  const allTags = [...new Set([...keywordTags, ...llmTags])];

  if (allTags.length > 0) {
    const sources: string[] = [];
    if (keywordTags.length > 0) sources.push(`keyword: ${keywordTags.join(',')}`);
    if (llmTags.length > 0) sources.push(`LLM-fallback: ${llmTags.join(',')}`);
    console.log(`[SmartTags] ${allTags.join(', ')} (${sources.join(' + ')}) for "${title.slice(0, 50)}..."`);
  }

  return allTags;
}

// ═══════════════════════════════════════════════════════════════════════════
// LLM Sentiment Analysis — Investment Analyst Score (-10 to +10)
// ═══════════════════════════════════════════════════════════════════════════

export interface SentimentResult {
  sentiment: 'positive' | 'negative' | 'neutral';
  score: number; // -10 to +10
  reasoning: string; // 2 paragraphs from LLM (what happened + why it matters)
}

// Parse sentiment score + reasoning from LLM response
function parseSentimentResponse(content: string): { score: number; reasoning: string } {
  let score = 0;
  let reasoning = '';
  try {
    const match = content.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      score = typeof parsed.score === 'number' ? Math.max(-10, Math.min(10, Math.round(parsed.score))) : 0;
      reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 500) : '';
    }
  } catch {
    const numMatch = content.match(/(-?\d+)/);
    if (numMatch) {
      score = Math.max(-10, Math.min(10, parseInt(numMatch[1])));
    }
  }
  return { score, reasoning };
}

export async function analyzeSentimentLLM(title: string, summary: string): Promise<SentimentResult> {
  if (!KIMI_API_KEY) {
    console.log('[SentimentLLM] No KIMI_API_KEY');
    return { sentiment: 'neutral', score: 0, reasoning: '' };
  }

  const prompt = `You are an experienced investment analyst. Evaluate the sentiment of this financial news article regarding the company/companies mentioned.

Title: ${title.slice(0, 200)}
Summary: ${summary.slice(0, 400)}

Rate the sentiment on a scale from -10 to +10:
-10 = Maximum negative (bankruptcy, massive fraud, catastrophic loss)
-5  = Strong negative (major losses, sanctions, scandal)
-1  = Mild negative (minor setback, weak results)
 0  = Neutral (no significant impact, routine news)
+1  = Mild positive (small contract, minor growth)
+5  = Strong positive (major deal, strong earnings, breakthrough)
+10 = Maximum positive (acquisition at premium, record profits, game-changer)

Return ONLY a JSON object in this exact format:
{"score": 5, "reasoning": "Paragraph 1: what happened.\\n\\nParagraph 2: why it matters to investors"}

Rules:
1. Consider the article ONLY from an investor's perspective
2. A "layoff" announcement is usually negative for employees but may be positive for investors (cost cutting)
3. A "lawsuit" is negative regardless of who initiated it
4. Routine operations or minor updates = 0
5. reasoning: Write 2 paragraphs separated by \\n\\n. Paragraph 1 = what happened (facts). Paragraph 2 = investment significance (why investors care)
6. Return ONLY valid JSON, no markdown, no extra text`;

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
        headers: { 'Authorization': `Bearer ${KIMI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: KIMI_MODEL.startsWith('kimi-k') ? 30000 : 10000,
      }
    );

    const content = response.data?.choices?.[0]?.message?.content || '';
    console.log(`[SentimentLLM] Raw: "${content.slice(0, 120)}..." for "${title.slice(0, 30)}..."`);

    const { score, reasoning } = parseSentimentResponse(content);

    let sentiment: 'positive' | 'negative' | 'neutral';
    if (score <= -1) sentiment = 'negative';
    else if (score >= 1) sentiment = 'positive';
    else sentiment = 'neutral';

    console.log(`[SentimentLLM] Score: ${score}, reasoning: ${reasoning.slice(0, 60)}... → ${sentiment}`);
    return { sentiment, score, reasoning };
  } catch (err: any) {
    console.error(`[SentimentLLM] Error: ${err.message?.slice(0, 100)}`);
    return { sentiment: 'neutral', score: 0, reasoning: '' };
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
    const jsonMatch = content.match(/\[\s\S]*?\]/);
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
