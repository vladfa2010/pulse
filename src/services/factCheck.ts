/**
 * =============================================================================
 * PULSE — Fact-Check Service (v3)
 * =============================================================================
 *
 * On-demand факт-чекинг новостей через Kimi API ($web_search / $fetch).
 *
 * Pipeline v3 (видимый):
 *   queries → search → fetch → claims → verdict
 *
 * Worker: polling fact_check_jobs каждые 10 сек, max 1 concurrent job.
 *
 * OpenAI SDK используется только как HTTP-клиент для Kimi API.
 * Базовый URL: https://api.moonshot.ai/v1
 */

import OpenAI from 'openai';
import { EventEmitter } from 'events';
import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
const FACT_CHECK_MODEL = process.env.FACT_CHECK_MODEL || 'kimi-k2.6';

const client = new OpenAI({
  apiKey: KIMI_API_KEY,
  baseURL: KIMI_BASE_URL,
});

const POLL_INTERVAL_SECONDS = 10;
const MAX_CONCURRENT_JOBS = 1;
const KIMI_MAX_RETRIES = 4;
const JOB_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60000, 300000, 900000]; // 1min, 5min, 15min
const MAX_TOOL_ITERATIONS = 5;

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

export interface FactCheckStage {
  stage: 'queries' | 'search' | 'fetch' | 'claims' | 'verdict';
  payload: any;
}

// ─── SSE emitter registry ───────────────────────────────────────────────────

const factCheckEmitters = new Map<string, EventEmitter>();

function emitterKey(newsId: string, userId: string): string {
  return `${newsId.toLowerCase()}_${userId.toLowerCase()}`;
}

export function getEmitter(newsId: string, userId: string): EventEmitter | undefined {
  return factCheckEmitters.get(emitterKey(newsId, userId));
}

export function setEmitter(newsId: string, userId: string, emitter: EventEmitter): void {
  factCheckEmitters.set(emitterKey(newsId, userId), emitter);
}

export function removeEmitter(newsId: string, userId: string): void {
  factCheckEmitters.delete(emitterKey(newsId, userId));
}

function emitStage(newsId: string, userId: string, stage: string, payload: any): void {
  const emitter = getEmitter(newsId, userId);
  if (emitter) {
    emitter.emit('stage', stage, payload);
  }
}

// ─── DB helpers: fact_check_jobs ────────────────────────────────────────────

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

// ─── DB helpers: fact_check_sessions ────────────────────────────────────────

export async function createFactCheckSession(newsId: string, userId: string): Promise<any> {
  const result = await query(
    `INSERT INTO fact_check_sessions (news_id, user_id, status, model)
     VALUES ($1, $2, 'pending', $3)
     RETURNING *`,
    [newsId, userId, FACT_CHECK_MODEL]
  );
  return result.rows[0];
}

type SessionPatch = Partial<{
  status: string;
  queries_json: string;
  sources_json: string;
  sources_count: number;
  fetched_json: string;
  fetched_count: number;
  claims_json: string;
  claims_count: number;
  final_verdict: string | null;
  final_confidence: number;
  final_reasoning: string;
  error_message: string;
  completed_at: string;
}>;

export async function updateFactCheckSession(sessionId: string, patch: SessionPatch): Promise<void> {
  const allowed = [
    'status', 'queries_json', 'sources_json', 'sources_count',
    'fetched_json', 'fetched_count', 'claims_json', 'claims_count',
    'final_verdict', 'final_confidence', 'final_reasoning',
    'error_message', 'completed_at',
  ];

  const keys = Object.keys(patch).filter((k) => allowed.includes(k));
  if (keys.length === 0) return;

  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map((k) => (patch as any)[k]);
  values.push(sessionId);

  await query(
    `UPDATE fact_check_sessions SET ${sets}, updated_at = ${nowSql()} WHERE id = $${values.length}`,
    values
  );
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
      const completion = await client.chat.completions.create({
        model: FACT_CHECK_MODEL,
        messages: messages as any,
        max_tokens: 16384,
        ...(tools?.length ? { tools: tools as any, tool_choice: 'auto' as any } : {}),
      });
      return completion.choices[0].message as any;
    } catch (err: any) {
      lastError = err;
      const status = err.status || err.response?.status;
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

// ─── End-to-end pipeline with visible stages ────────────────────────────────

const SYSTEM_FACTCHECK_V3 = `Ты — факт-чекер. Проанализируй текст новости через веб-поиск.

Этапы работы:
1. Выдели до 8 проверяемых claims из текста (факты, даты, цифры, имена, события).
2. Для каждого claim выполни поиск через $web_search.
3. При необходимости прочти релевантные URL через $fetch.
4. Для каждого claim дай вердикт с обоснованием и источниками.

Вердикты:
- confirmed: подтверждено 2+ независимыми источниками
- partly_true: частично верно, есть уточнения
- unconfirmed: недостаточно данных
- false: опровергнуто авторитетными источниками

Формат — строго JSON:
{
  "claims": [
    {
      "id": 1,
      "text": "утверждение из текста",
      "verdict": "confirmed|partly_true|unconfirmed|false",
      "explanation": "обоснование на 2-4 предложения",
      "sources": [{"name": "Reuters", "url": "https://reuters.com/..."}],
      "confidence": 95
    }
  ],
  "sources": [{"name": "источник", "url": "https://..."}],
  "verdict": "reliable|partly_reliable|unreliable|unverified",
  "confidence": 85
}`;

const WEB_SEARCH_TOOL = { type: 'builtin_function', function: { name: '$web_search' } };
const FETCH_TOOL = { type: 'builtin_function', function: { name: '$fetch' } };

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
  const claims = Array.isArray(parsed?.claims) ? parsed.claims.map(normalizeClaim) : [];
  return {
    verdict: verdicts.includes(parsed?.verdict) ? parsed.verdict : 'unverified',
    claims,
    sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
    confidence: Math.min(100, Math.max(0, Number(parsed?.confidence || 0))),
    checked_at: new Date().toISOString(),
    model: FACT_CHECK_MODEL,
    error: null,
  };
}

export async function* runFactCheckPipeline(
  newsId: string,
  userId: string,
  articleText: string,
  sessionId: string
): AsyncGenerator<FactCheckStage, FactCheckResult, unknown> {
  const messages: any[] = [
    { role: 'system', content: SYSTEM_FACTCHECK_V3 },
    { role: 'user', content: `Текст новости:\n${articleText.slice(0, 8000)}` },
  ];

  // ─── Этап 1: Генерация запросов ───
  yield { stage: 'queries', payload: { status: 'generating' } };
  emitStage(newsId, userId, 'queries', { status: 'generating' });

  const step1 = await kimiChat(messages, [WEB_SEARCH_TOOL]);
  messages.push(step1);

  if (step1.tool_calls) {
    for (const tc of step1.tool_calls) {
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: tc.function.arguments });
    }
  }

  const parsed1 = parseLlmJson(step1.content || '{}');
  const claims = Array.isArray(parsed1?.claims) ? parsed1.claims : [];

  yield { stage: 'queries', payload: { status: 'done', claims: claims.length } };
  emitStage(newsId, userId, 'queries', { status: 'done', claims: claims.length });
  await updateFactCheckSession(sessionId, {
    status: 'queries',
    queries_json: JSON.stringify(claims),
    claims_count: claims.length,
  });

  // ─── Этап 2: Поиск источников ───
  yield { stage: 'search', payload: { status: 'searching' } };
  emitStage(newsId, userId, 'search', { status: 'searching' });

  const step2 = await kimiChat(messages, [WEB_SEARCH_TOOL]);
  messages.push(step2);

  if (step2.tool_calls) {
    for (const tc of step2.tool_calls) {
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: tc.function.arguments });
    }
  }

  const parsed2 = parseLlmJson(step2.content || '{}');
  const sources = Array.isArray(parsed2?.sources) ? parsed2.sources : [];

  yield { stage: 'search', payload: { status: 'done', sources: sources.length, items: sources.slice(0, 10) } };
  emitStage(newsId, userId, 'search', { status: 'done', sources: sources.length, items: sources.slice(0, 10) });
  await updateFactCheckSession(sessionId, {
    status: 'search',
    sources_json: JSON.stringify(sources),
    sources_count: sources.length,
  });

  // ─── Этап 3: Fetch (если модель запросила) ───
  yield { stage: 'fetch', payload: { status: 'fetching' } };
  emitStage(newsId, userId, 'fetch', { status: 'fetching' });

  let fetchCount = 0;
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const step = await kimiChat(messages, [WEB_SEARCH_TOOL, FETCH_TOOL]);
    messages.push(step);

    if (step.finish_reason !== 'tool_calls') break;

    for (const tc of step.tool_calls || []) {
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: tc.function.arguments });
      if (tc.function.name === '$fetch') fetchCount++;
    }

    yield { stage: 'fetch', payload: { status: 'progress', fetched: fetchCount } };
    emitStage(newsId, userId, 'fetch', { status: 'progress', fetched: fetchCount });
  }

  yield { stage: 'fetch', payload: { status: 'done', fetched: fetchCount } };
  emitStage(newsId, userId, 'fetch', { status: 'done', fetched: fetchCount });
  await updateFactCheckSession(sessionId, {
    status: 'fetch',
    fetched_count: fetchCount,
  });

  // ─── Этап 4: Разбор по claims ───
  yield { stage: 'claims', payload: { status: 'analyzing' } };
  emitStage(newsId, userId, 'claims', { status: 'analyzing' });

  const finalMsg = messages[messages.length - 1];
  const parsedFinal = parseLlmJson(finalMsg?.content || '{}');
  const verifiedClaims: VerifiedClaim[] = Array.isArray(parsedFinal?.claims) ? parsedFinal.claims.map(normalizeClaim) : [];

  yield { stage: 'claims', payload: { status: 'done', claims: verifiedClaims } };
  emitStage(newsId, userId, 'claims', { status: 'done', claims: verifiedClaims });
  await updateFactCheckSession(sessionId, {
    status: 'claims',
    claims_json: JSON.stringify(verifiedClaims),
    claims_count: verifiedClaims.length,
  });

  // ─── Этап 5: Вердикт ───
  const result = normalizeFactCheckResult(parsedFinal);
  const reasoning = verifiedClaims.map((c) => c.explanation).join(' ');

  yield { stage: 'verdict', payload: { status: 'done', verdict: result.verdict, confidence: result.confidence, reasoning } };
  emitStage(newsId, userId, 'verdict', { status: 'done', verdict: result.verdict, confidence: result.confidence, reasoning });
  await updateFactCheckSession(sessionId, {
    status: 'verdict',
    final_verdict: result.verdict,
    final_confidence: result.confidence,
    final_reasoning: reasoning,
  });

  console.log('[FactCheckWorker] Content preview:', (finalMsg?.content || '').slice(0, 200));

  return result;
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

  const session = await createFactCheckSession(job.news_id, job.user_id);

  try {
    const text = [news.title_ru, news.summary_ru].filter(Boolean).join('\n');
    const pipeline = runFactCheckPipeline(job.news_id, job.user_id, text, session.id);

    let finalResult: FactCheckResult | undefined;
    let iter = await pipeline.next();
    while (!iter.done) {
      // stage already emitted + saved inside generator
      iter = await pipeline.next();
    }
    finalResult = iter.value;

    if (!finalResult) {
      finalResult = normalizeFactCheckResult(null);
    }

    await updateJobStatus(jobId, 'done');
    await updateNewsFactCheck(job.news_id, 'checked', finalResult);

    await updateFactCheckSession(session.id, {
      status: 'completed',
      final_verdict: finalResult.verdict,
      final_confidence: finalResult.confidence,
      final_reasoning: finalResult.claims.map((c) => c.explanation).join(' '),
      completed_at: new Date().toISOString(),
    });

    const emitter = getEmitter(job.news_id, job.user_id);
    emitter?.emit('complete');

    console.log('[FactCheckWorker] News fact_check updated to checked');
  } catch (error: any) {
    const attempts = (job.attempts || 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FactCheckWorker] Job ${jobId} failed (attempt ${attempts}):`, message);

    await updateJobFailed(jobId, message, attempts);
    await updateFactCheckSession(session.id, {
      status: 'failed',
      error_message: message,
      completed_at: new Date().toISOString(),
    });

    const emitter = getEmitter(job.news_id, job.user_id);
    emitter?.emit('error', message);

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
