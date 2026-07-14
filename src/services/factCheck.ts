/**
 * =============================================================================
 * PULSE — Fact-Check Service
 * =============================================================================
 *
 * On-demand факт-чекинг новостей через Kimi API ($web_search).
 *
 * Pipeline:
 *   queued → extracting_claims → searching → verifying → done
 *
 * Worker: polling fact_check_jobs каждые 10 сек, max 1 concurrent job.
 */

import axios from 'axios';
import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_BASE_URL = 'https://api.moonshot.ai/v1';
const FACT_CHECK_MODEL = process.env.FACT_CHECK_MODEL || 'kimi-k2.6';

const POLL_INTERVAL_SECONDS = 10;
const MAX_CONCURRENT_JOBS = 1;
const API_DELAY_MS = 500;
const KIMI_MAX_RETRIES = 4;
const JOB_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60000, 300000, 900000]; // 1min, 5min, 15min

// ─── Types ─────────────────────────────────────────────────────────────────

export interface Claim {
  id: number;
  text: string;
  category: string;
  search_query: string;
}

export interface VerifiedClaim extends Claim {
  verdict: 'confirmed' | 'partly_true' | 'unconfirmed' | 'false';
  explanation: string;
  source: string;
  confidence: number;
  sources?: { name: string; url: string }[];
}

export interface FactCheckSource {
  name: string;
  url: string;
}

export interface FactCheckResult {
  verdict: 'reliable' | 'partly_reliable' | 'unreliable' | 'unverified' | null;
  claims: VerifiedClaim[];
  sources: FactCheckSource[];
  confidence: number;
  checked_at: string;
  model: string;
  error: string | null;
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

export async function createFactCheckJob(newsId: string, userId: string): Promise<string | null> {
  try {
    const result = await query(
      `INSERT INTO fact_check_jobs (news_id, user_id, status, attempts)
       VALUES ($1, $2, 'queued', 0)
       ON CONFLICT (news_id, user_id) DO UPDATE
         SET status = 'queued', attempts = 0, error_message = NULL, next_retry_at = NULL, updated_at = ${nowSql()}
       RETURNING id`,
      [newsId, userId]
    );
    await query(
      `UPDATE news SET fact_check_status = 'in_progress', fact_check_result = NULL WHERE id = $1`,
      [newsId]
    );
    return result.rows[0]?.id || null;
  } catch (err: any) {
    console.error('[FactCheck] createJob error:', err.message);
    return null;
  }
}

export async function getFactCheckJob(jobId: string) {
  const result = await query(`SELECT * FROM fact_check_jobs WHERE id = $1`, [jobId]);
  return result.rows[0] || null;
}

export async function getNextQueuedJob(): Promise<any | null> {
  const timeFilter = USE_SQLITE
    ? "(next_retry_at IS NULL OR next_retry_at <= datetime('now'))"
    : '(next_retry_at IS NULL OR next_retry_at <= NOW())';
  const result = await query(
    `SELECT * FROM fact_check_jobs
     WHERE status = 'queued' AND ${timeFilter}
     ORDER BY created_at ASC
     LIMIT 1`,
    []
  );
  return result.rows[0] || null;
}

export async function updateJobStatus(jobId: string, status: string): Promise<void> {
  await query(
    `UPDATE fact_check_jobs SET status = $1, updated_at = ${nowSql()} WHERE id = $2`,
    [status, jobId]
  );
}

export async function updateJobFailed(jobId: string, errorMessage: string, attempts: number): Promise<void> {
  await query(
    `UPDATE fact_check_jobs
     SET status = 'failed', error_message = $1, attempts = $2, updated_at = ${nowSql()}
     WHERE id = $3`,
    [errorMessage, attempts, jobId]
  );
}

export async function rescheduleJob(jobId: string, nextRetryAt: Date): Promise<void> {
  await query(
    `UPDATE fact_check_jobs
     SET status = 'queued', next_retry_at = $1, updated_at = ${nowSql()}
     WHERE id = $2`,
    [USE_SQLITE ? nextRetryAt.toISOString() : nextRetryAt, jobId]
  );
}

export async function updateNewsFactCheck(
  newsId: string,
  status: 'not_checked' | 'in_progress' | 'checked',
  result: FactCheckResult | null
): Promise<void> {
  // ВСЕГДА JSON.stringify — для SQLite и PostgreSQL
  const resultValue = result ? JSON.stringify(result) : null;
  await query(
    `UPDATE news SET fact_check_status = $1, fact_check_result = $2 WHERE id = $3`,
    [status, resultValue, newsId]
  );
}

export async function getNewsForFactCheck(newsId: string): Promise<any | null> {
  const result = await query(
    `SELECT id, title_ru, summary_ru, url FROM news WHERE id = $1`,
    [newsId]
  );
  return result.rows[0] || null;
}

// ─── LLM helpers ────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function kimiChatWithRetry(messages: any[], tools?: any[]): Promise<any> {
  if (!KIMI_API_KEY) throw new Error('KIMI_API_KEY not configured');

  let lastError: any;
  for (let attempt = 1; attempt <= KIMI_MAX_RETRIES; attempt++) {
    try {
      const payload: any = {
        model: FACT_CHECK_MODEL,
        messages,
        max_tokens: 16384,
        // temperature убран — используем дефолт API
      };

      // tools — только для web_search
      if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = 'auto';
        // thinking disabled ТОЛЬКО для web_search calls
        payload.thinking = { type: 'disabled' };
      }
      // Для обычных вызовов (extract, verify) — thinking НЕ передаём

      // ЛОГИРОВАНИЕ: запрос
      console.log('[FactCheckLLM] REQUEST payload:', JSON.stringify({
        model: payload.model,
        hasTools: !!payload.tools,
        hasThinking: !!payload.thinking,
        messagesCount: payload.messages.length,
        lastMessageRole: payload.messages[payload.messages.length - 1]?.role,
      }));

      const timeoutMs = (tools && tools.length > 0) ? 300000 : 120000;

      const res = await axios.post(
        `${KIMI_BASE_URL}/chat/completions`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${KIMI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: timeoutMs,
        }
      );

      // ЛОГИРОВАНИЕ: ответ
      const msg = res.data?.choices?.[0]?.message;
      console.log('[FactCheckLLM] RESPONSE:', JSON.stringify({
        finish_reason: res.data?.choices?.[0]?.finish_reason,
        hasToolCalls: !!msg?.tool_calls,
        toolCallsCount: msg?.tool_calls?.length || 0,
        contentPreview: (msg?.content || '').slice(0, 100),
      }));

      return msg;
    } catch (err: any) {
      lastError = err;
      const status = err.response?.status;

      // ЛОГИРОВАНИЕ: ошибка
      console.error('[FactCheckLLM] ERROR:', JSON.stringify({
        status,
        statusText: err.response?.statusText,
        errorData: err.response?.data,
        message: err.message,
        attempt,
      }));

      const isRetryable = status === 429 || status === 502 || status === 503 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (!isRetryable || attempt === KIMI_MAX_RETRIES) throw err;
      const wait = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
      console.log(`[FactCheckLLM] Retrying in ${wait}ms...`);
      await delay(wait);
    }
  }
  throw lastError;
}

async function runWebSearchLoop(messages: any[]): Promise<string> {
  let finishReason: string | null = null;
  let lastContent = '';

  while (finishReason === null || finishReason === 'tool_calls') {
    const msg = await kimiChatWithRetry(messages, [
      { type: 'builtin_function', function: { name: '$web_search' } },
    ]);
    finishReason = msg.finish_reason;
    lastContent = msg.content || '';

    if (finishReason === 'tool_calls' && msg.tool_calls) {
      messages.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.tool_calls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      });
      for (const tc of msg.tool_calls) {
        // Round-trip: parse → stringify (as per Kimi API docs)
        const toolArgs = JSON.parse(tc.function.arguments);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(toolArgs),
        });
      }
    }
  }
  return lastContent;
}

function parseLlmJson(content: string): any | null {
  let raw = (content || '').trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Try to extract first JSON object
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* ignore */ }
    }
    return null;
  }
}

// ─── Pipeline ───────────────────────────────────────────────────────────────

const SYSTEM_CLAIMS = `Ты — факт-чекер. Проанализируй текст новости и извлеки ВСЕ проверяемые факты.

Правила:
- Только проверяемые факты, не оценочные суждения.
- Каждый claim атомарный (один факт = одно утверждение).
- search_query — конкретный запрос для поисковика.
- Максимум 10 claims (если больше — оставь 10 наиболее значимых).

Формат ответа — JSON:
{
  "claims": [
    {
      "id": 1,
      "text": "утверждение",
      "category": "person|date|number|quote|event|organization",
      "search_query": "поисковый запрос"
    }
  ]
}`;

async function extractClaims(articleText: string): Promise<Claim[]> {
  const msg = await kimiChatWithRetry([
    { role: 'system', content: SYSTEM_CLAIMS },
    { role: 'user', content: `Текст новости:\n${articleText.slice(0, 8000)}` },
  ]);
  const parsed = parseLlmJson(msg.content || '');
  const claims = Array.isArray(parsed?.claims) ? parsed.claims : [];
  return claims
    .filter((c: any) => c.text && c.search_query)
    .map((c: any, idx: number) => ({
      id: c.id || idx + 1,
      text: String(c.text),
      category: String(c.category || 'fact'),
      search_query: String(c.search_query),
    }))
    .slice(0, 10);
}

const SYSTEM_SEARCH = `Ты — исследователь. Найди независимые источники для проверки следующих фактов.
Для каждого факта найди релевантные источники и кратко суммируй, что говорят.

Факты для проверки:
{{claims}}`;

async function searchClaimsBatch(claims: Claim[]): Promise<string> {
  const claimsText = claims.map((c) => `[${c.id}] ${c.search_query}`).join('\n');
  const messages = [
    { role: 'user', content: SYSTEM_SEARCH.replace('{{claims}}', claimsText) },
  ];
  return runWebSearchLoop(messages);
}

const SYSTEM_VERIFY = `Ты — верификатор фактов. Сравни утверждение с найденными источниками.

Формат ответа — JSON:
{
  "verdict": "confirmed|partly_true|unconfirmed|false",
  "explanation": "1-2 предложения обоснования",
  "source": "конкретный источник",
  "confidence": 0-100,
  "sources": [{"name": "название источника", "url": "https://..."}]
}

Правила вердикта:
- confirmed: факт прямо подтверждён авторитетным источником.
- partly_true: частично верно, есть искажение или упрощение.
- unconfirmed: источников недостаточно или они не авторитетны.
- false: прямое противоречие авторитетным источникам.`;

async function verifyClaim(claim: Claim, searchResult: string): Promise<VerifiedClaim> {
  const msg = await kimiChatWithRetry([
    { role: 'system', content: SYSTEM_VERIFY },
    { role: 'user', content: `Утверждение: ${claim.text}\n\nИсточники:\n${searchResult}` },
  ]);
  const parsed = parseLlmJson(msg.content || '');
  const verdicts = ['confirmed', 'partly_true', 'unconfirmed', 'false'];
  const verdict = verdicts.includes(parsed?.verdict) ? parsed.verdict : 'unconfirmed';
  return {
    ...claim,
    verdict: verdict as VerifiedClaim['verdict'],
    explanation: String(parsed?.explanation || ''),
    source: String(parsed?.source || ''),
    confidence: Math.min(100, Math.max(0, Number(parsed?.confidence || 0))),
    sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
  };
}

function computeVerdict(claims: VerifiedClaim[]): FactCheckResult['verdict'] {
  if (claims.length === 0) return 'unverified';
  const total = claims.length;
  const confirmed = claims.filter((c) => c.verdict === 'confirmed').length;
  const partly = claims.filter((c) => c.verdict === 'partly_true').length;
  const falseCount = claims.filter((c) => c.verdict === 'false').length;
  const unconfirmed = claims.filter((c) => c.verdict === 'unconfirmed').length;

  if (falseCount > 0 || unconfirmed / total > 0.5) return 'unreliable';
  if (confirmed / total >= 0.8 && partly <= 1) return 'reliable';
  if (confirmed + partly > 0) return 'partly_reliable';
  return 'unverified';
}

function extractUniqueSources(claims: VerifiedClaim[]): FactCheckSource[] {
  const map = new Map<string, string>();
  for (const claim of claims) {
    if (Array.isArray(claim.sources)) {
      for (const s of claim.sources) {
        if (s.name && s.url) map.set(s.url, s.name);
      }
    }
  }
  return Array.from(map.entries()).map(([url, name]) => ({ name, url }));
}

export async function processFactCheckJob(jobId: string): Promise<void> {
  const job = await getFactCheckJob(jobId);
  if (!job) return;

  const news = await getNewsForFactCheck(job.news_id);
  if (!news) {
    await updateJobFailed(jobId, 'Новость не найдена', job.attempts + 1);
    return;
  }

  try {
    await updateJobStatus(jobId, 'extracting_claims');
    const text = [news.title_ru, news.summary_ru].filter(Boolean).join('\n');

    const claims = await extractClaims(text);
    console.log('[FactCheckWorker] Claims extracted:', claims.length);
    claims.forEach((c: Claim) => console.log(`  [${c.id}] ${c.text.slice(0, 60)}`));

    if (claims.length === 0) {
      console.log('[FactCheckWorker] No claims found, marking as unverified');
      const result: FactCheckResult = {
        verdict: 'unverified',
        claims: [],
        sources: [],
        confidence: 0,
        checked_at: new Date().toISOString(),
        model: FACT_CHECK_MODEL,
        error: null,
      };
      await updateJobStatus(jobId, 'done');
      await updateNewsFactCheck(job.news_id, 'checked', result);
      console.log('[FactCheckWorker] News fact_check updated to checked (unverified)');
      return;
    }

    await updateJobStatus(jobId, 'searching');
    const searchResult = await searchClaimsBatch(claims);
    console.log('[FactCheckWorker] Search result length:', searchResult.length, 'chars');
    if (searchResult.length > 0) {
      console.log('[FactCheckWorker] Search result preview:', searchResult.slice(0, 800));
    } else {
      console.log('[FactCheckWorker] Search result is EMPTY');
    }
    await delay(API_DELAY_MS);

    await updateJobStatus(jobId, 'verifying');
    const verifiedClaims: VerifiedClaim[] = [];
    for (const claim of claims) {
      const verdict = await verifyClaim(claim, searchResult);
      console.log(`[FactCheckWorker] Claim [${claim.id}] verdict: ${verdict.verdict}, confidence: ${verdict.confidence}, sources: ${verdict.sources?.length || 0}`);
      verifiedClaims.push(verdict);
      await delay(API_DELAY_MS);
    }

    console.log('[FactCheckWorker] Verified claims:', verifiedClaims.length);

    const result: FactCheckResult = {
      verdict: computeVerdict(verifiedClaims),
      claims: verifiedClaims,
      sources: extractUniqueSources(verifiedClaims),
      confidence: Math.round(
        verifiedClaims.reduce((s, c) => s + (c.confidence || 0), 0) / verifiedClaims.length
      ),
      checked_at: new Date().toISOString(),
      model: FACT_CHECK_MODEL,
      error: null,
    };

    console.log('[FactCheckWorker] Result computed:', { verdict: result.verdict, claims: result.claims.length });

    await updateJobStatus(jobId, 'done');
    console.log('[FactCheckWorker] Job status updated to done');

    await updateNewsFactCheck(job.news_id, 'checked', result);
    console.log('[FactCheckWorker] News fact_check updated to checked');
  } catch (error: any) {
    const attempts = (job.attempts || 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FactCheckWorker] Job ${jobId} failed (attempt ${attempts}):`, message);
    await updateJobFailed(jobId, message, attempts);

    if (attempts < JOB_MAX_ATTEMPTS) {
      const retryDelay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
      await rescheduleJob(jobId, new Date(Date.now() + retryDelay));
    } else {
      // Record final error on news row so UI can show it
      const errorResult: FactCheckResult = {
        verdict: null,
        claims: [],
        sources: [],
        confidence: 0,
        checked_at: new Date().toISOString(),
        model: FACT_CHECK_MODEL,
        error: message,
      };
      await updateNewsFactCheck(job.news_id, 'checked', errorResult);
    }
  }
}

// ─── Cron ───────────────────────────────────────────────────────────────────

let isProcessing = false;

async function processFactCheckQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  try {
    for (let i = 0; i < MAX_CONCURRENT_JOBS; i++) {
      const job = await getNextQueuedJob();
      if (!job) break;
      console.log(`[FactCheckWorker] Processing job ${job.id} for news ${job.news_id}`);
      await processFactCheckJob(job.id);
    }
  } catch (error) {
    console.error('[FactCheckWorker] Queue processing error:', error);
  } finally {
    isProcessing = false;
  }
}

export function startFactCheckCron(): void {
  console.log('[FactCheckWorker] Starting worker (every 10s)');
  setTimeout(() => {
    processFactCheckQueue().catch(() => {});
  }, 5000);

  setInterval(() => {
    processFactCheckQueue().catch(() => {});
  }, POLL_INTERVAL_SECONDS * 1000);
}
