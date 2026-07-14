/**
 * =============================================================================
 * PULSE — Fact-Check Service (v2)
 * =============================================================================
 *
 * On-demand факт-чекинг новостей через Kimi API ($web_search).
 *
 * Pipeline v2 (end-to-end):
 *   queued → in_progress → done
 *
 * Один вызов: Kimi сама решает, какие факты проверять, сколько раз искать
 * и какой дать вердикт.
 *
 * Worker: polling fact_check_jobs каждые 10 сек, max 1 concurrent job.
 */

import axios from 'axios';
import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
const FACT_CHECK_MODEL = process.env.FACT_CHECK_MODEL || 'kimi-k2.6';

const POLL_INTERVAL_SECONDS = 10;
const MAX_CONCURRENT_JOBS = 1;
const KIMI_MAX_RETRIES = 4;
const KIMI_TIMEOUT_MS = 300000;
const JOB_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60000, 300000, 900000]; // 1min, 5min, 15min
const MAX_WEB_SEARCH_ITERATIONS = 5;

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

async function kimiChat(messages: any[], tools?: any[]): Promise<any> {
  if (!KIMI_API_KEY) throw new Error('KIMI_API_KEY not configured');

  let lastError: any;
  for (let attempt = 1; attempt <= KIMI_MAX_RETRIES; attempt++) {
    try {
      const payload: any = {
        model: FACT_CHECK_MODEL,
        messages,
        max_tokens: 16384,
      };

      if (tools && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = 'auto';
        payload.thinking = { type: 'disabled' };
      }

      const res = await axios.post(
        `${KIMI_BASE_URL}/chat/completions`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${KIMI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          timeout: KIMI_TIMEOUT_MS,
        }
      );

      return res.data?.choices?.[0]?.message;
    } catch (err: any) {
      lastError = err;
      const status = err.response?.status;
      const isRetryable = status === 429 || status === 502 || status === 503 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (!isRetryable || attempt === KIMI_MAX_RETRIES) throw err;
      const wait = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
      console.log(`[FactCheckLLM] Attempt ${attempt}/${KIMI_MAX_RETRIES} failed (status=${status}), retrying in ${wait}ms...`);
      await delay(wait);
    }
  }
  throw lastError;
}

function parseLlmJson(content: string): any | null {
  let raw = (content || '').trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* ignore */ }
    }
    return null;
  }
}

// ─── End-to-end fact-check ──────────────────────────────────────────────────

const SYSTEM_FACTCHECK = `Ты — факт-чекер. Проверь текст новости через веб-поиск.

Процесс:
1. Извлеки проверяемые факты из текста
2. Найди независимые источники через $web_search
3. Сравни факты с источниками
4. Дай общий вердикт

Формат — строго JSON:
{
  "verdict": "reliable|partly_reliable|unreliable|unverified",
  "claims": [
    {
      "id": 1,
      "text": "утверждение",
      "verdict": "confirmed|partly_true|unconfirmed|false",
      "explanation": "обоснование",
      "sources": [{"name": "источник", "url": "https://..."}],
      "confidence": 0-100
    }
  ],
  "sources": [{"name": "источник", "url": "https://..."}],
  "confidence": 0-100
}`;

function normalizeClaim(c: any): VerifiedClaim {
  const verdicts = ['confirmed', 'partly_true', 'unconfirmed', 'false'];
  return {
    id: Number(c?.id) || 0,
    text: String(c?.text || ''),
    category: String(c?.category || 'fact'),
    search_query: String(c?.search_query || ''),
    verdict: verdicts.includes(c?.verdict) ? c.verdict : 'unconfirmed',
    explanation: String(c?.explanation || ''),
    source: String(c?.source || ''),
    confidence: Math.min(100, Math.max(0, Number(c?.confidence || 0))),
    sources: Array.isArray(c?.sources) ? c.sources : [],
  };
}

function normalizeFactCheckResult(parsed: any): FactCheckResult {
  const verdicts = ['reliable', 'partly_reliable', 'unreliable', 'unverified'];
  return {
    verdict: verdicts.includes(parsed?.verdict) ? parsed.verdict : 'unverified',
    claims: Array.isArray(parsed?.claims) ? parsed.claims.map(normalizeClaim) : [],
    sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
    confidence: Math.min(100, Math.max(0, Number(parsed?.confidence || 0))),
    checked_at: new Date().toISOString(),
    model: FACT_CHECK_MODEL,
    error: null,
  };
}

async function factCheckEndToEnd(articleText: string): Promise<FactCheckResult> {
  const messages: any[] = [
    { role: 'system', content: SYSTEM_FACTCHECK },
    { role: 'user', content: `Текст новости:\n${articleText.slice(0, 8000)}` },
  ];

  const tools = [
    { type: 'builtin_function', function: { name: '$web_search' } },
  ];

  for (let i = 0; i < MAX_WEB_SEARCH_ITERATIONS; i++) {
    const msg = await kimiChat(messages, tools);
    messages.push(msg);

    const finishReason = msg?.finish_reason;
    console.log(`[FactCheckLLM] Iteration: ${i}, finish_reason: ${finishReason}`);

    if (msg?.tool_calls) {
      console.log('[FactCheckLLM] Tool calls:', msg.tool_calls.length);
    }

    if (finishReason !== 'tool_calls') break;

    for (const toolCall of msg.tool_calls || []) {
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: toolCall.function.arguments, // echo as-is
      });
    }
  }

  const lastMsg = messages[messages.length - 1];
  const parsed = parseLlmJson(lastMsg?.content || '{}');

  console.log('[FactCheckWorker] Content preview:', (lastMsg?.content || '').slice(0, 200));

  return normalizeFactCheckResult(parsed);
}

// ─── Worker ─────────────────────────────────────────────────────────────────

export async function processFactCheckJob(jobId: string): Promise<void> {
  const job = await getFactCheckJob(jobId);
  if (!job) return;

  const news = await getNewsForFactCheck(job.news_id);
  if (!news) {
    await updateJobFailed(jobId, 'Новость не найдена', job.attempts + 1);
    return;
  }

  try {
    await updateJobStatus(jobId, 'in_progress');
    const text = [news.title_ru, news.summary_ru].filter(Boolean).join('\n');

    const result = await factCheckEndToEnd(text);

    await updateJobStatus(jobId, 'done');
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
