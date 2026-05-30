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
// BATCH mode: 10 articles per request (10x speedup)
// ═══════════════════════════════════════════════════════════════════════════

export interface SentimentResult {
  sentiment: 'positive' | 'negative' | 'neutral';
  score: number; // -10 to +10
  reasoning: string; // 2 paragraphs from LLM (what happened + why it matters)
}

interface BatchArticle {
  title: string;
  summary: string;
}

const BATCH_SIZE = 10;

export async function analyzeSentimentBatch(articles: BatchArticle[]): Promise<SentimentResult[]> {
  if (!KIMI_API_KEY) {
    console.log('[SentimentBatch] No KIMI_API_KEY');
    return articles.map(() => ({ sentiment: 'neutral' as const, score: 0, reasoning: '' }));
  }

  const results: SentimentResult[] = [];

  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(articles.length / BATCH_SIZE);

    try {
      console.log(`[SentimentBatch] Processing batch ${batchNum}/${totalBatches} (${batch.length} articles)`);
      const batchResults = await analyzeSentimentBatchChunk(batch);
      results.push(...batchResults);
    } catch (err: any) {
      console.error(`[SentimentBatch] Batch ${batchNum} failed: ${err.message?.slice(0, 100)}`);
      // Fallback: keyword-based for this batch
      for (const a of batch) {
        const sentiment = analyzeSentimentFallback(`${a.title} ${a.summary}`);
        results.push({
          sentiment,
          score: sentiment === 'positive' ? 5 : sentiment === 'negative' ? -5 : 0,
          reasoning: '',
        });
      }
    }
  }

  return results;
}

async function analyzeSentimentBatchChunk(batch: BatchArticle[]): Promise<SentimentResult[]> {
  // Build numbered prompt
  let articlesText = '';
  batch.forEach((a, i) => {
    articlesText += `\n[${i + 1}] Title: ${a.title.slice(0, 150)}\nSummary: ${a.summary.slice(0, 250)}\n`;
  });

  const prompt = `You are an experienced investment analyst. Evaluate the sentiment of ${batch.length} financial news articles from an investor's perspective.

${articlesText}

For each article, rate sentiment on scale -10 to +10:
-10 = Catastrophic (bankruptcy, massive fraud)
-5 = Strong negative (major losses, sanctions)
-1 = Mild negative (minor setback)
0 = Neutral (no significant impact)
+1 = Mild positive (small contract, minor growth)
+5 = Strong positive (major deal, strong earnings)
+10 = Maximum positive (acquisition at premium, record profits)

Return ONLY a JSON array in this exact format (one object per article, in same order):
[
  {"score": 5, "reasoning": "What happened.\\n\\nWhy it matters to investors."},
  {"score": -3, "reasoning": "What happened.\\n\\nWhy it matters to investors."}
]

Rules:
1. Return EXACTLY ${batch.length} objects — same order as articles above
2. Each reasoning: 2 paragraphs separated by \\n\\n. P1 = facts. P2 = investment significance.
3. Consider ONLY investor perspective (layoff may be positive for investors = cost cutting)
4. Lawsuits = always negative
5. Return ONLY JSON array, no markdown, no extra text`;

  const response = await axios.post(
    'https://api.moonshot.ai/v1/chat/completions',
    {
      model: KIMI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 200 * batch.length, // ~200 tokens per article
    },
    {
      headers: { 'Authorization': `Bearer ${KIMI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 30000, // 30s for batch
    }
  );

  const content = response.data?.choices?.[0]?.message?.content || '';
  console.log(`[SentimentBatch] Raw: "${content.slice(0, 200)}..."`);

  // Parse JSON array
  const results: SentimentResult[] = [];
  try {
    const match = content.match(/\[[\s\S]*?\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const score = typeof item.score === 'number'
            ? Math.max(-10, Math.min(10, Math.round(item.score)))
            : 0;
          const reasoning = typeof item.reasoning === 'string'
            ? item.reasoning.slice(0, 500)
            : '';
          let sentiment: 'positive' | 'negative' | 'neutral';
          if (score <= -1) sentiment = 'negative';
          else if (score >= 1) sentiment = 'positive';
          else sentiment = 'neutral';
          results.push({ sentiment, score, reasoning });
        }
      }
    }
  } catch (e) {
    console.error(`[SentimentBatch] Parse error: ${(e as Error).message?.slice(0, 100)}`);
  }

  // Fill missing results with fallback
  while (results.length < batch.length) {
    const idx = results.length;
    const a = batch[idx];
    const sentiment = analyzeSentimentFallback(`${a.title} ${a.summary}`);
    results.push({
      sentiment,
      score: sentiment === 'positive' ? 5 : sentiment === 'negative' ? -5 : 0,
      reasoning: '',
    });
  }

  // Trim if too many
  const finalResults = results.slice(0, batch.length);
  console.log(`[SentimentBatch] Batch done: ${finalResults.length} results`);
  return finalResults;
}

// Fallback keyword-based sentiment (local, no API)
function analyzeSentimentFallback(text: string): 'positive' | 'negative' | 'neutral' {
  const positiveWords = ['рост', 'прибыль', 'рекорд', 'превысил', 'успех', 'позитив', 'повышение', 'рали', 'bull'];
  const negativeWords = ['падение', 'убыток', 'кризис', 'снижение', 'крах', 'негатив', 'санкции', 'bear', 'крах'];

  const lower = text.toLowerCase();
  let score = 0;
  positiveWords.forEach(w => { if (lower.includes(w)) score++ });
  negativeWords.forEach(w => { if (lower.includes(w)) score-- });

  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

// ═══════════════════════════════════════════════════════════════════════════
// Single-article sentiment (kept for backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════

export async function analyzeSentimentLLM(title: string, summary: string): Promise<SentimentResult> {
  const results = await analyzeSentimentBatch([{ title, summary }]);
  return results[0];
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
