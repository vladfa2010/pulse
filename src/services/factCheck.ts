/**
 * =============================================================================
 * PULSE — Fact-Check Service (v4)
 * =============================================================================
 *
 * On-demand факт-чекинг новостей через Kimi API ($web_search).
 *
 * Pipeline v4 (видимый, 4 шага):
 *   search → analysis → sources → assessment
 *
 * Worker: polling fact_check_jobs каждые 10 сек, max 1 concurrent job.
 *
 * OpenAI SDK используется только как HTTP-клиент для Kimi API.
 * Базовый URL: https://api.moonshot.ai/v1
 */

import OpenAI from 'openai';
import { EventEmitter } from 'events';
import { query } from '../config/db';
import { yandexSearch, YandexSearchType, YandexSource } from './yandexSearch';
import { serperSearch, SerperSource } from './serperSearch';
import { sendFactCheckNotifications } from './factCheckNotifications';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
const FACT_CHECK_MODEL = process.env.FACT_CHECK_MODEL || 'kimi-k2.6';

const client = new OpenAI({
  apiKey: KIMI_API_KEY,
  baseURL: KIMI_BASE_URL,
});

const POLL_INTERVAL_SECONDS = 5;
const MAX_CONCURRENT_JOBS = 3;
const KIMI_MAX_RETRIES = 2;
const JOB_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60000, 300000, 900000]; // 1min, 5min, 15min

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SourceV4 {
  site: string;
  url: string;
  title: string;
  date: string;
  engine?: 'kimi' | 'yandex_ru' | 'yandex_com' | 'serper_ru' | 'serper_en';
}

interface SearchSource {
  title: string;
  url: string;
  snippet: string;
  engine: 'kimi' | 'yandex_ru' | 'yandex_com' | 'serper_ru' | 'serper_en';
}

interface EngineStatus {
  engine: 'kimi' | 'yandex_ru' | 'yandex_com' | 'serper_ru' | 'serper_en';
  status: 'ok' | 'error';
  sources: number;
  error?: string;
}

export interface AssessmentV4 {
  credibility_score: number;
  credibility_label: 'Высокая' | 'Средняя' | 'Низкая' | 'Критическая';
  tone: 'нейтральная' | 'позитивная' | 'негативная' | 'манипулятивная';
  facts_verified: 'да' | 'частично' | 'нет';
  has_opinion_bias: boolean;
  missing_context: string;
  manipulation_risks: string;
  verdict: string;
}

export interface PipelineV4Result {
  analysis: string;
  sources: SourceV4[];
  assessment: AssessmentV4;
  engineStatuses: EngineStatus[];
}

export interface FactCheckResultV4 {
  version: 4;
  analysis: string;
  sources: SourceV4[];
  assessment: AssessmentV4;
  engines?: EngineStatus[];
  checked_at: string;
  model: string;
  error: string | null;
}

export interface FactCheckStageV4 {
  stage: 'search' | 'analysis' | 'sources' | 'assessment';
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
  result: FactCheckResultV4 | null
): Promise<void> {
  const resultValue = result ? JSON.stringify(result) : null;
  await query(
    `UPDATE news SET fact_check_status = $1, fact_check_result = $2 WHERE id = $3`,
    [status, resultValue, newsId]
  );
}

export async function getNewsForFactCheck(newsId: string): Promise<any | null> {
  const result = await query(
    `SELECT id, title_ru, title_original, summary_ru, url FROM news WHERE id = $1`,
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
      const params: any = {
        model: FACT_CHECK_MODEL,
        messages: messages as any,
        max_tokens: 16384,
        extra_body: { thinking: { type: 'disabled' } },
      };
      if (tools?.length) {
        params.tools = tools as any;
        params.tool_choice = 'auto';
      }
      const completion = await client.chat.completions.create(params);
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

function parseFactCheckResult(raw: any): FactCheckResultV4 | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw as FactCheckResultV4;
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

// ─── Prompts ────────────────────────────────────────────────────────────────

const SYSTEM_ANALYSIS = `Ты новостной аналитик. Давай развернутый анализ темы на русском языке. Используй markdown: жирный текст для ключевых фактов, заголовки для структуры. Анализируй контекст, причины, последствия.`;

const SYSTEM_SOURCES = `Извлеки источники из результатов поиска. Отвечай ТОЛЬКО JSON: {"sources": [{"site": "название", "url": "https://...", "title": "заголовок", "date": "YYYY-MM-DD", "engine": "kimi|yandex_ru|yandex_com|serper_ru|serper_en"}]}. Перечисли ВСЕ источники.`;

const SYSTEM_ASSESSMENT = `Ты эксперт по медиаграмотности. Оцени текст на основе анализа и источников. JSON: {"credibility_score": 0-100, "credibility_label": "Высокая"|"Средняя"|"Низкая"|"Критическая", "tone": "нейтральная"|"позитивная"|"негативная"|"манипулятивная", "facts_verified": "да"|"частично"|"нет", "has_opinion_bias": true|false, "missing_context": "...", "manipulation_risks": "...", "verdict": "2-3 предложения"}`;

const WEB_SEARCH_TOOL = { type: 'builtin_function', function: { name: '$web_search' } };

// ─── Pipeline v4 ────────────────────────────────────────────────────────────

function normalizeSource(s: any): SourceV4 {
  const validEngines = ['kimi', 'yandex_ru', 'yandex_com', 'serper_ru', 'serper_en'];
  const engine = validEngines.includes(s?.engine) ? s.engine : undefined;
  return {
    site: String(s?.site || ''),
    url: String(s?.url || ''),
    title: String(s?.title || ''),
    date: String(s?.date || ''),
    engine,
  };
}

function normalizeAssessment(parsed: any): AssessmentV4 {
  const labels = ['Высокая', 'Средняя', 'Низкая', 'Критическая'];
  const tones = ['нейтральная', 'позитивная', 'негативная', 'манипулятивная'];
  const facts = ['да', 'частично', 'нет'];
  const label = labels.includes(parsed?.credibility_label) ? parsed.credibility_label : 'Средняя';
  const score = Math.min(100, Math.max(0, Number(parsed?.credibility_score ?? 50)));

  return {
    credibility_score: score,
    credibility_label: label,
    tone: tones.includes(parsed?.tone) ? parsed.tone : 'нейтральная',
    facts_verified: facts.includes(parsed?.facts_verified) ? parsed.facts_verified : 'частично',
    has_opinion_bias: Boolean(parsed?.has_opinion_bias),
    missing_context: String(parsed?.missing_context || ''),
    manipulation_risks: String(parsed?.manipulation_risks || ''),
    verdict: String(parsed?.verdict || ''),
  };
}

async function step1MultiSearch(
  messages: any[],
  articleText: string,
  titleRu: string,
  titleOriginal: string | null | undefined,
  newsId: string,
  userId: string,
  sessionId: string
): Promise<{ sources: SearchSource[]; engineStatuses: EngineStatus[] }> {
  emitStage(newsId, userId, 'search', { status: 'searching' });

  const engineStatuses: EngineStatus[] = [];
  let allSources: SearchSource[] = [];

  // ─── Kimi $web_search ───
  emitStage(newsId, userId, 'search', { status: 'kimi_search' });
  try {
    const kimiMsg = await kimiChat(messages, [WEB_SEARCH_TOOL]);
    messages.push(kimiMsg);

    let kimiSources: SearchSource[] = [];
    if (kimiMsg.tool_calls) {
      for (const tc of kimiMsg.tool_calls) {
        const args = JSON.parse(tc.function.arguments);
        kimiSources = (args.results || []).map((r: any) => ({
          title: String(r.title || ''),
          url: String(r.url || ''),
          snippet: String(r.snippet || ''),
          engine: 'kimi' as const,
        }));

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: JSON.stringify(args),
        });
      }
    }

    allSources.push(...kimiSources);
    engineStatuses.push({ engine: 'kimi', status: 'ok', sources: kimiSources.length });
    emitStage(newsId, userId, 'search', { status: 'kimi_done', sources: kimiSources.length });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    engineStatuses.push({ engine: 'kimi', status: 'error', sources: 0, error: message });
    emitStage(newsId, userId, 'search', { status: 'kimi_error', error: message });
  }

  // ─── Yandex RU ───
  emitStage(newsId, userId, 'search', { status: 'yandex_ru_search' });
  const yandexRuResult = await yandexSearch(articleText.slice(0, 400), 'SEARCH_TYPE_RU');

  if (!yandexRuResult.error && yandexRuResult.sources.length > 0) {
    allSources.push(...(yandexRuResult.sources as YandexSource[]));
    engineStatuses.push({ engine: 'yandex_ru', status: 'ok', sources: yandexRuResult.sources.length });
    emitStage(newsId, userId, 'search', { status: 'yandex_ru_done', sources: yandexRuResult.sources.length });
  } else if (yandexRuResult.error) {
    engineStatuses.push({ engine: 'yandex_ru', status: 'error', sources: 0, error: yandexRuResult.error });
    emitStage(newsId, userId, 'search', { status: 'yandex_ru_error', error: yandexRuResult.error });
  } else {
    engineStatuses.push({ engine: 'yandex_ru', status: 'ok', sources: 0 });
    emitStage(newsId, userId, 'search', { status: 'yandex_ru_done', sources: 0 });
  }

  // ─── Yandex COM ───
  emitStage(newsId, userId, 'search', { status: 'yandex_com_search' });
  const yandexComResult = await yandexSearch(articleText.slice(0, 400), 'SEARCH_TYPE_COM');

  if (!yandexComResult.error && yandexComResult.sources.length > 0) {
    allSources.push(...(yandexComResult.sources as YandexSource[]));
    engineStatuses.push({ engine: 'yandex_com', status: 'ok', sources: yandexComResult.sources.length });
    emitStage(newsId, userId, 'search', { status: 'yandex_com_done', sources: yandexComResult.sources.length });
  } else if (yandexComResult.error) {
    engineStatuses.push({ engine: 'yandex_com', status: 'error', sources: 0, error: yandexComResult.error });
    emitStage(newsId, userId, 'search', { status: 'yandex_com_error', error: yandexComResult.error });
  } else {
    engineStatuses.push({ engine: 'yandex_com', status: 'ok', sources: 0 });
    emitStage(newsId, userId, 'search', { status: 'yandex_com_done', sources: 0 });
  }

  // ─── Serper RU + EN (Google News) ───
  emitStage(newsId, userId, 'search', { status: 'serper_search' });
  const { sources: serperSources, engineStatuses: serperStatuses } = await serperSearch(titleRu, titleOriginal);

  if (serperSources.length > 0) {
    allSources.push(
      ...serperSources.map((s) => ({
        title: s.title,
        url: s.url,
        snippet: [s.snippet, s.date, s.site].filter(Boolean).join(' | '),
        engine: s.engine,
      }))
    );
  }
  for (const es of serperStatuses) {
    engineStatuses.push(es);
    const statusKey = es.status === 'ok' && es.sources > 0 ? 'done' : es.status === 'error' ? 'error' : 'done';
    emitStage(newsId, userId, 'search', {
      status: `${es.engine}_${statusKey}`,
      sources: es.sources,
      ...(es.error ? { error: es.error } : {}),
    });
  }

  // ─── Dedup по URL ───
  const seen = new Set<string>();
  const deduped = allSources.filter((s) => {
    if (!s.url || seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });

  // ─── Сохраняем + отправляем в context ───
  await updateFactCheckSession(sessionId, {
    status: 'search',
    sources_json: JSON.stringify(deduped),
    sources_count: deduped.length,
  });

  emitStage(newsId, userId, 'search', {
    status: 'done',
    sources: deduped.length,
    engines: engineStatuses,
    items: deduped.slice(0, 20),
  });

  if (deduped.length > 0) {
    // Kimi-источники уже в messages через tool response — не дублируем их полностью
    const nonKimi = deduped.filter((s) => s.engine !== 'kimi');
    const kimiSources = deduped.filter((s) => s.engine === 'kimi');
    const contextParts: string[] = [];

    if (kimiSources.length > 0) {
      contextParts.push(`[Kimi] ${kimiSources.length} источников (см. tool response)`);
    }

    const labels: Record<string, string> = {
      yandex_ru: 'Yandex RU',
      yandex_com: 'Yandex COM',
      serper_ru: 'Serper RU',
      serper_en: 'Serper EN',
    };

    for (const seg of ['yandex_ru', 'yandex_com', 'serper_ru', 'serper_en'] as const) {
      const segSources = nonKimi.filter((s) => s.engine === seg);
      if (segSources.length > 0) {
        contextParts.push(
          `[${labels[seg]}] ${segSources.length} источников:\n${segSources
            .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}\n${s.snippet?.slice(0, 200)}`)
            .join('\n\n')}`
        );
      }
    }

    messages.push({
      role: 'user',
      content: `Найденные источники (${deduped.length}):\n${contextParts.join('\n\n')}`,
    });
  }

  return { sources: deduped, engineStatuses };
}

async function step2Analysis(
  messages: any[],
  newsId: string,
  userId: string,
  sessionId: string
): Promise<string> {
  emitStage(newsId, userId, 'analysis', { status: 'analyzing' });

  const analysisMessages = [
    ...messages,
    { role: 'system', content: SYSTEM_ANALYSIS },
  ];

  const msg = await kimiChat(analysisMessages);
  const analysis = msg.content || '';

  // Делаем анализ доступным для Steps 3-4
  messages.push({ role: 'assistant', content: analysis });

  emitStage(newsId, userId, 'analysis', {
    status: 'done',
    preview: analysis.slice(0, 200),
  });

  await updateFactCheckSession(sessionId, {
    status: 'analysis',
    final_reasoning: analysis,
  });

  return analysis;
}

async function step3Sources(
  messages: any[],
  rawSources: SearchSource[],
  newsId: string,
  userId: string,
  sessionId: string
): Promise<SourceV4[]> {
  emitStage(newsId, userId, 'sources', { status: 'extracting' });

  const sourcesMessages = [
    ...messages,
    { role: 'system', content: SYSTEM_SOURCES },
  ];

  const msg = await kimiChat(sourcesMessages);
  const parsed = parseLlmJson(msg.content || '{}');
  const sources: SourceV4[] = Array.isArray(parsed?.sources)
    ? parsed.sources.map(normalizeSource)
    : [];

  // Восстанавливаем engine по достоверным данным из Step 1 (rawSources)
  // Приоритет: точный URL → домен → оставляем как есть
  const engineByUrl = new Map<string, 'kimi' | 'yandex_ru' | 'yandex_com' | 'serper_ru' | 'serper_en'>();
  for (const rs of rawSources) {
    if (rs.url && !engineByUrl.has(rs.url)) {
      engineByUrl.set(rs.url, rs.engine);
    }
  }

  const engineByDomain = new Map<string, 'kimi' | 'yandex_ru' | 'yandex_com' | 'serper_ru' | 'serper_en'>();
  for (const rs of rawSources) {
    if (rs.url) {
      try {
        const domain = new URL(rs.url).hostname.replace(/^www\./, '');
        if (!engineByDomain.has(domain)) {
          engineByDomain.set(domain, rs.engine);
        }
      } catch { /* ignore */ }
    }
  }

  for (const s of sources) {
    if (s.url) {
      const byUrl = engineByUrl.get(s.url);
      if (byUrl) {
        s.engine = byUrl;
      } else {
        try {
          const domain = new URL(s.url).hostname.replace(/^www\./, '');
          const byDomain = engineByDomain.get(domain);
          if (byDomain) s.engine = byDomain;
        } catch { /* ignore */ }
      }
    }
  }

  emitStage(newsId, userId, 'sources', {
    status: 'done',
    count: sources.length,
    items: sources,
  });

  await updateFactCheckSession(sessionId, {
    status: 'sources',
    sources_json: JSON.stringify(sources),
    sources_count: sources.length,
  });

  return sources;
}

async function step4Assessment(
  messages: any[],
  articleText: string,
  analysis: string,
  sources: SourceV4[],
  newsId: string,
  userId: string,
  sessionId: string
): Promise<AssessmentV4> {
  emitStage(newsId, userId, 'assessment', { status: 'assessing' });

  const assessmentMessages = [
    ...messages,
    { role: 'system', content: SYSTEM_ASSESSMENT },
    {
      role: 'user',
      content: `Оцени этот текст новости:\n\n---ОРИГИНАЛЬНЫЙ ТЕКСТ---\n${articleText}\n\n---АНАЛИЗ---\n${analysis}\n\n---ИСТОЧНИКИ---\n${sources.map((s) => `[${s.site}] ${s.title} — ${s.url}`).join('\n')}`,
    },
  ];

  const msg = await kimiChat(assessmentMessages);
  const parsed = parseLlmJson(msg.content || '{}');
  const assessment = normalizeAssessment(parsed);

  emitStage(newsId, userId, 'assessment', {
    status: 'done',
    ...assessment,
  });

  await updateFactCheckSession(sessionId, {
    status: 'assessment',
    final_verdict: assessment.credibility_label,
    final_confidence: assessment.credibility_score,
    final_reasoning: assessment.verdict,
  });

  return assessment;
}

export async function runFactCheckPipelineV4(
  newsId: string,
  userId: string,
  articleText: string,
  titleRu: string,
  titleOriginal: string | null | undefined,
  sessionId: string
): Promise<PipelineV4Result> {
  const messages: any[] = [
    { role: 'system', content: 'Ты помощник, который ищет информацию в интернете и анализирует новости.' },
    { role: 'user', content: `Проанализируй эту тему:\n\n${articleText.slice(0, 8000)}` },
  ];

  const { sources: rawSources, engineStatuses } = await step1MultiSearch(
    messages,
    articleText,
    titleRu,
    titleOriginal,
    newsId,
    userId,
    sessionId
  );
  const analysis = await step2Analysis(messages, newsId, userId, sessionId);
  const sources = await step3Sources(messages, rawSources, newsId, userId, sessionId);
  const assessment = await step4Assessment(messages, articleText, analysis, sources, newsId, userId, sessionId);

  return { analysis, sources, assessment, engineStatuses };
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

  const text = [news.title_ru, news.summary_ru].filter(Boolean).join('\n');

  // Проверяем, есть ли готовый результат по этой новости (любой пользователь)
  const cachedResult = await query(
    `SELECT fact_check_result FROM news
     WHERE id = $1 AND fact_check_status = 'checked' AND fact_check_result IS NOT NULL`,
    [job.news_id]
  );
  if (cachedResult.rows.length > 0) {
    const existing = parseFactCheckResult(cachedResult.rows[0].fact_check_result);
    if (existing && !existing.error) {
      const factCheckResult: FactCheckResultV4 = {
        ...existing,
        checked_at: new Date().toISOString(),
      };
      await updateJobStatus(jobId, 'done');
      await updateNewsFactCheck(job.news_id, 'checked', factCheckResult);
      const emitter = getEmitter(job.news_id, job.user_id);
      emitter?.emit('complete');
      sendFactCheckNotifications({ userId: job.user_id, newsId: job.news_id, result: factCheckResult }).catch((err) =>
        console.error('[FactCheckWorker] Cached result notification error:', err)
      );
      console.log(`[FactCheckWorker] Cached result reused for news ${job.news_id}`);
      return;
    }
  }

  const session = await createFactCheckSession(job.news_id, job.user_id);

  try {
    const result = await runFactCheckPipelineV4(
      job.news_id,
      job.user_id,
      text,
      news.title_ru || '',
      news.title_original,
      session.id
    );

    const factCheckResult: FactCheckResultV4 = {
      version: 4,
      ...result,
      engines: result.engineStatuses,
      checked_at: new Date().toISOString(),
      model: FACT_CHECK_MODEL,
      error: null,
    };

    await updateJobStatus(jobId, 'done');
    await updateNewsFactCheck(job.news_id, 'checked', factCheckResult);

    await updateFactCheckSession(session.id, {
      status: 'completed',
      final_verdict: result.assessment.credibility_label,
      final_confidence: result.assessment.credibility_score,
      final_reasoning: result.assessment.verdict,
      completed_at: new Date().toISOString(),
    });

    const emitter = getEmitter(job.news_id, job.user_id);
    emitter?.emit('complete');

    sendFactCheckNotifications({ userId: job.user_id, newsId: job.news_id, result: factCheckResult }).catch((err) =>
      console.error('[FactCheckWorker] Notification error:', err)
    );

    console.log('[FactCheckWorker] News fact_check updated to checked (v4)');
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
      const errorResult: FactCheckResultV4 = {
        version: 4,
        analysis: '',
        sources: [],
        assessment: {
          credibility_score: 0,
          credibility_label: 'Критическая',
          tone: 'нейтральная',
          facts_verified: 'нет',
          has_opinion_bias: false,
          missing_context: '',
          manipulation_risks: '',
          verdict: `Ошибка проверки: ${message}`,
        },
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
      let job: any | null = null;
      let attempts = 0;
      const maxAttempts = 3;
      while (attempts < maxAttempts && job === null) {
        try {
          job = await getNextQueuedJob();
          break;
        } catch (err: any) {
          attempts++;
          if (attempts >= maxAttempts) {
            throw err;
          }
          console.warn(`[FactCheckWorker] getNextQueuedJob failed (attempt ${attempts}/${maxAttempts}): ${err.message?.slice(0, 100)}`);
          await new Promise(r => setTimeout(r, 500));
        }
      }
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
