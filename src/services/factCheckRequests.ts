/**
 * =============================================================================
 * PULSE — Ad-hoc Fact-Check Requests Service (TZ_FACTCHECK_PAGE v1.3)
 * =============================================================================
 *
 * Проверка произвольного ввода пользователя (текст / ссылка / картинка / файл)
 * через существующий LLM-pipeline v4 (services/factCheck.ts).
 *
 * Что делает:
 *   - извлечение контента: extractFromUrl() (axios, ≤3 МБ, 20s), extractFromFile()
 *     (Kimi Files API, purpose file-extract — OCR/парсинг, тот же KIMI_API_KEY);
 *   - дедупликация по sha256(input_type + ':' + normalized) — повтор отдаёт
 *     скопированный результат (reused: true), LLM не вызывается;
 *   - валидация входа: слой 1 (правила, §6) и слой 2 (LLM-префильтр, env
 *     FACT_CHECK_PREFILTER, default true, fail-open при ошибке/непарсимости);
 *   - воркер startFactCheckRequestCron(): опрос queued каждые 5 сек, до 3
 *     последовательно, ретраи 1/5/15 мин (next_retry_at, максимум 3 попытки);
 *   - recoverStuckRequests() на старте: in_progress → queued, next_retry_at=NULL,
 *     attempts=attempts+1 (защита от бесконечного crash-loop, §15 п.10).
 *
 * Приватность v1: все проверки частные (is_public принудительно FALSE),
 * публикация в общую ленту — v2 вместе с модерацией.
 *
 * SSE-эмиттеры — общий реестр из services/factCheck.ts, ключ requestId+userId
 * (§15 п.7: UUID-коллизий с news id нет).
 *
 * Уведомления (email/Telegram) для ad-hoc проверок в v1 НЕ отправляются.
 */

import axios from 'axios';
import crypto from 'crypto';
import { query } from '../config/db';
import { nowSql } from '../utils/nowSql';
import { runFactCheckPipelineV4, getEmitter, FactCheckResultV4 } from './factCheck';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_BASE_URL = process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1';
const FACT_CHECK_MODEL = process.env.FACT_CHECK_MODEL || 'kimi-k2.6';

const POLL_INTERVAL_SECONDS = 5;
const MAX_CONCURRENT_REQUESTS = 3;
const REQUEST_MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [60000, 300000, 900000]; // 1min, 5min, 15min

const EXTRACTED_TEXT_MAX = 8000;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ─── Types ─────────────────────────────────────────────────────────────────

export type FactCheckInputType = 'text' | 'url' | 'image' | 'file';

export interface ExtractedContent {
  title: string;
  text: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

export function parseResultJson(raw: any): any | null {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

// ─── Извлечение контента ────────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

/**
 * extractFromUrl — скачивает страницу и извлекает заголовок + текст.
 * axios GET: timeout 20s, до 3 МБ, браузерный UA.
 * Заголовок: og:title → <title>. Текст: абзацы <p> ≥ 40 символов,
 * fallback — текст <body>. Минимум 100 символов, иначе ошибка.
 */
export async function extractFromUrl(url: string): Promise<ExtractedContent> {
  const response = await axios.get(url, {
    timeout: 20000,
    maxContentLength: 3 * 1024 * 1024,
    responseType: 'text',
    transformResponse: [(data) => data], // не даём axios парсить JSON
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
    },
  });

  const html: string = typeof response.data === 'string' ? response.data : String(response.data || '');
  if (!html.trim()) {
    throw new Error('Страница вернула пустой ответ');
  }

  // Заголовок: og:title → <title>
  let title = '';
  const ogMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
  if (ogMatch?.[1]) title = decodeEntities(ogMatch[1]).trim();
  if (!title) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch?.[1]) title = stripTags(titleMatch[1]).trim();
  }

  // Абзацы <p> ≥ 40 символов
  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRegex.exec(html)) !== null) {
    const text = stripTags(m[1]);
    if (text.length >= 40) paragraphs.push(text);
  }

  let text = paragraphs.join('\n\n').trim();

  // Fallback — текст <body>
  if (text.length < 100) {
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    text = stripTags(bodyMatch?.[1] || html);
  }

  if (text.length < 100) {
    throw new Error('Не удалось извлечь текст со страницы (меньше 100 символов)');
  }

  return {
    title: title || text.slice(0, 120),
    text: text.slice(0, EXTRACTED_TEXT_MAX),
  };
}

/**
 * extractFromFile — base64 → Kimi Files API (purpose file-extract, OCR/парсинг).
 * Бинарное содержимое нигде не сохраняется: в БД уходит только имя файла
 * и извлечённый текст (§2 п.6, приёмка №7).
 */
export async function extractFromFile(
  fileBase64: string,
  fileName: string,
  mime: string
): Promise<ExtractedContent> {
  if (!KIMI_API_KEY) throw new Error('KIMI_API_KEY not configured');

  const buffer = Buffer.from(fileBase64, 'base64');
  if (buffer.length === 0) throw new Error('Пустой файл');

  const form = new FormData();
  form.append('purpose', 'file-extract');
  form.append('file', new Blob([buffer], { type: mime || 'application/octet-stream' }), fileName || 'file');

  const headers: Record<string, string> = { Authorization: `Bearer ${KIMI_API_KEY}` };
  const upload = await axios.post(`${KIMI_BASE_URL}/files`, form, {
    timeout: 120000,
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  const fileId = upload.data?.id;
  if (!fileId) throw new Error('Kimi Files API не вернул id файла');

  const content = await axios.get(`${KIMI_BASE_URL}/files/${fileId}/content`, {
    timeout: 120000,
    headers,
  });

  let text = '';
  const data = content.data;
  if (typeof data === 'string') {
    text = data;
  } else if (Array.isArray(data?.content)) {
    text = data.content.map((c: any) => c?.text || '').join('\n');
  } else {
    text = data?.text || data?.content || '';
  }
  text = String(text || '').trim();

  if (text.length < 100) {
    throw new Error('Не удалось извлечь текст из файла (меньше 100 символов)');
  }

  return {
    title: fileName || 'Файл',
    text: text.slice(0, EXTRACTED_TEXT_MAX),
  };
}

// ─── Нормализация и дедупликация (§15 п.6) ─────────────────────────────────

/**
 * Нормализация для input_hash:
 *   text — trim + схлопнуть повторные whitespace + Unicode NFC, БЕЗ lower-case
 *          (регистр в русском значим, ложные совпадения хуже промахов);
 *   url — scheme://host(lower)/path без query/fragment/utm-меток и trailing slash;
 *   image/file — хэш считается от extracted_text (дедуп по содержимому).
 */
export function normalizeForHash(inputType: FactCheckInputType, raw: string): string {
  if (inputType === 'url') {
    try {
      const u = new URL(raw.trim());
      const scheme = u.protocol.replace(':', '').toLowerCase();
      const host = u.host.toLowerCase();
      let path = u.pathname.replace(/\/+$/, '');
      return `${scheme}://${host}${path}`;
    } catch {
      return raw.trim();
    }
  }
  // text / image / file (для image/file сюда приходит extracted_text)
  return raw.trim().replace(/\s+/g, ' ').normalize('NFC');
}

export function computeInputHash(inputType: FactCheckInputType, normalized: string): string {
  return crypto.createHash('sha256').update(`${inputType}:${normalized}`).digest('hex');
}

// ─── Валидация слоя 1 (§6) ─────────────────────────────────────────────────

const FRIENDLY_VALIDATION_ERROR =
  'Это не похоже на утверждение, которое можно проверить. Вставьте конкретный факт, цитату или ссылку на статью.';

/**
 * Слой 1 — правила (до очереди):
 *   - длина 20–8000 символов;
 *   - ≥ 3 слов;
 *   - не один повторяющийся символ;
 *   - наличие букв;
 *   - не эмодзи-спам.
 * Возвращает null, если текст прошёл, иначе — сообщение об ошибке.
 */
export function validateVerifiableText(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 20 || trimmed.length > EXTRACTED_TEXT_MAX) {
    return FRIENDLY_VALIDATION_ERROR;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 3) {
    return FRIENDLY_VALIDATION_ERROR;
  }
  if (/^(.)\1+$/s.test(trimmed.replace(/\s+/g, ''))) {
    return FRIENDLY_VALIDATION_ERROR;
  }
  const letters = (trimmed.match(/[a-zA-Zа-яА-ЯёЁ]/g) || []).length;
  if (letters === 0) {
    return FRIENDLY_VALIDATION_ERROR;
  }
  const emoji = (trimmed.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  if (emoji > letters) {
    return FRIENDLY_VALIDATION_ERROR;
  }
  return null;
}

// ─── Валидация слоя 2 — LLM-префильтр (§6, §15 п.3) ────────────────────────

const PREFILTER_ENABLED = (process.env.FACT_CHECK_PREFILTER || 'true') !== 'false';

const PREFILTER_SYSTEM = `Ты классификатор коротких вводов. Определи тип ввода пользователя и ответь ОДНИМ словом из списка: FACT (проверяемое фактическое утверждение), OPINION (мнение, оценка, эмоция), NONSENSE (бессвязный набор символов), QUESTION (вопрос).`;

/**
 * Слой 2 — один дешёвый LLM-вызов (max_tokens 10): FACT / OPINION / NONSENSE / QUESTION.
 * FACT → null (пропуск в очередь). OPINION/NONSENSE/QUESTION → сообщение для 422.
 * При ошибке или непарсимом ответе — fail-open: null + лог [FactCheckPrefilter] unparsed.
 */
export async function prefilterVerifiableText(text: string): Promise<string | null> {
  if (!PREFILTER_ENABLED) return null;
  if (!KIMI_API_KEY) return null;

  try {
    const response = await axios.post(
      `${KIMI_BASE_URL}/chat/completions`,
      {
        model: FACT_CHECK_MODEL,
        max_tokens: 10,
        temperature: 0,
        messages: [
          { role: 'system', content: PREFILTER_SYSTEM },
          { role: 'user', content: text.slice(0, 2000) },
        ],
      },
      { timeout: 30000, headers: { Authorization: `Bearer ${KIMI_API_KEY}` } }
    );

    const content: string = response.data?.choices?.[0]?.message?.content || '';
    // Парсим первое слово в upper-case (response_format json_object не требуем)
    const first = content.trim().split(/\s+/)[0]?.replace(/[^A-ZА-Я]/gi, '').toUpperCase() || '';

    if (first === 'FACT') return null;
    if (first === 'OPINION') {
      return 'Это мнение, а не факт. Фактчекинг проверяет проверяемые утверждения — попробуйте сформулировать конкретный факт.';
    }
    if (first === 'QUESTION') {
      return 'Это вопрос, а не утверждение. Вставьте утверждение, которое можно проверить.';
    }
    if (first === 'NONSENSE') {
      return 'Не удалось распознать утверждение в этом тексте. Вставьте конкретный факт или ссылку на статью.';
    }

    // Непарсимый ответ — fail-open: пропускаем в очередь
    console.warn(`[FactCheckPrefilter] unparsed: "${content.slice(0, 80)}"`);
    return null;
  } catch (err: any) {
    // Ошибка префильтра — fail-open: не блокируем проверку
    console.warn(`[FactCheckPrefilter] unparsed (error): ${err?.message?.slice(0, 120)}`);
    return null;
  }
}

// ─── DB helpers: fact_check_requests ────────────────────────────────────────

export async function findCheckedByHash(inputHash: string): Promise<any | null> {
  const result = await query(
    `SELECT * FROM fact_check_requests
     WHERE input_hash = $1 AND status = 'checked' AND result IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [inputHash]
  );
  return result.rows[0] || null;
}

/**
 * Создание записи. Если по input_hash есть готовый результат — создаём новую
 * запись с user_id заказчика и скопированным результатом (reused: true),
 * LLM не вызывается.
 */
export async function createRequest(params: {
  userId: string;
  inputType: FactCheckInputType;
  inputRaw: string | null;
  title: string;
  extractedText: string;
  inputHash: string;
}): Promise<{ id: string; reused: boolean }> {
  const existing = await findCheckedByHash(params.inputHash);
  if (existing) {
    const newId = uuidv4();
    await query(
      `INSERT INTO fact_check_requests
         (id, user_id, input_type, input_raw, input_hash, title, extracted_text,
          status, result, error_message, is_public, attempts, next_retry_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'checked', $8, NULL, FALSE, 0, NULL)`,
      [
        newId,
        params.userId,
        params.inputType,
        params.inputRaw,
        params.inputHash,
        existing.title || params.title,
        existing.extracted_text || params.extractedText,
        typeof existing.result === 'string' ? existing.result : JSON.stringify(existing.result),
      ]
    );
    return { id: newId, reused: true };
  }

  const id = uuidv4();
  await query(
    `INSERT INTO fact_check_requests
       (id, user_id, input_type, input_raw, input_hash, title, extracted_text,
        status, is_public, attempts, next_retry_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', FALSE, 0, NULL)`,
    [
      id,
      params.userId,
      params.inputType,
      params.inputRaw,
      params.inputHash,
      params.title,
      params.extractedText.slice(0, EXTRACTED_TEXT_MAX),
    ]
  );
  return { id, reused: false };
}

export async function getRequestById(id: string): Promise<any | null> {
  const result = await query(`SELECT * FROM fact_check_requests WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

// Оставлено для v2 (публикация проверок). В v1 не вызывается — PATCH /:id/visibility
// отвечает заглушкой 403 visibility_locked (§7.6).
export async function setRequestVisibility(_id: string, _isPublic: boolean): Promise<void> {
  // no-op в v1
}

/**
 * GET /feed — общая лента. Публичная. В v1 — ТОЛЬКО проверенные новости PULSE
 * (fact_check_status='checked'). Пользовательских проверок в ленте нет,
 * user_id в выдаче отсутствует (приёмка №8). Фильтр verifiable=false (§6 слой 3).
 */
export async function listPublicFeed(limit: number, offset: number): Promise<any[]> {
  const result = await query(
    `SELECT id, title_ru, summary_ru, url, fact_check_result, published_at, created_at
     FROM news
     WHERE fact_check_status = 'checked' AND fact_check_result IS NOT NULL
     ORDER BY published_at DESC NULLS LAST
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const items: any[] = [];
  for (const row of result.rows) {
    const parsed = parseResultJson(row.fact_check_result);
    if (!parsed) continue;
    // Слой 3: verifiable=false не попадает в общую ленту
    if (parsed?.assessment?.verifiable === false) continue;
    items.push({
      kind: 'news',
      id: row.id,
      title: row.title_ru || '',
      snippet: (row.summary_ru || '').slice(0, 500),
      url: row.url || null,
      status: 'checked',
      result: parsed,
      published_at: row.published_at,
      created_at: row.created_at,
    });
  }
  return items;
}

/**
 * GET /my — ad-hoc проверки пользователя (все статусы) + заказанные им проверки
 * новостей (fact_check_jobs JOIN news, kind: 'news'). Объединённые список
 * по дате создания.
 */
export async function listMyChecks(userId: string, limit: number, offset: number): Promise<any[]> {
  const [requests, jobs] = await Promise.all([
    query(
      `SELECT id, input_type, title, status, result, error_message, is_public, created_at
       FROM fact_check_requests WHERE user_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [userId, limit + offset]
    ),
    query(
      `SELECT n.id AS news_id, n.title_ru, n.url, n.fact_check_status, n.fact_check_result,
              j.status AS job_status, j.created_at AS job_created_at
       FROM fact_check_jobs j JOIN news n ON n.id = j.news_id
       WHERE j.user_id = $1
       ORDER BY j.created_at DESC LIMIT $2`,
      [userId, limit + offset]
    ),
  ]);

  const items: any[] = [
    ...requests.rows.map((r: any) => ({
      kind: 'request',
      id: r.id,
      input_type: r.input_type,
      title: r.title,
      status: r.status,
      result: parseResultJson(r.result),
      error_message: r.error_message,
      is_public: r.is_public === true || r.is_public === 1,
      created_at: r.created_at,
    })),
    ...jobs.rows.map((j: any) => ({
      kind: 'news',
      id: j.news_id,
      title: j.title_ru || '',
      url: j.url || null,
      status: j.fact_check_status === 'checked' ? 'checked' : j.job_status,
      result: parseResultJson(j.fact_check_result),
      created_at: j.job_created_at,
    })),
  ];

  items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return items.slice(offset, offset + limit);
}

// ─── Worker ─────────────────────────────────────────────────────────────────

async function getNextQueuedRequest(): Promise<any | null> {
  const timeFilter = USE_SQLITE
    ? "(next_retry_at IS NULL OR next_retry_at <= datetime('now'))"
    : '(next_retry_at IS NULL OR next_retry_at <= NOW())';
  const result = await query(
    `SELECT * FROM fact_check_requests
     WHERE status = 'queued' AND ${timeFilter}
     ORDER BY created_at ASC
     LIMIT 1`,
    []
  );
  return result.rows[0] || null;
}

async function processFactCheckRequest(requestId: string): Promise<void> {
  const request = await getRequestById(requestId);
  if (!request) return;

  await query(
    `UPDATE fact_check_requests SET status = 'in_progress', updated_at = ${nowSql()} WHERE id = $1`,
    [requestId]
  );

  try {
    // Ad-hoc проверка: sessionId = null — записи в fact_check_sessions не создаём
    const result = await runFactCheckPipelineV4(
      request.id,
      request.user_id,
      request.extracted_text,
      request.title || '',
      null,
      null
    );

    const factCheckResult: FactCheckResultV4 = {
      version: 4,
      ...result,
      engines: result.engineStatuses,
      checked_at: new Date().toISOString(),
      model: FACT_CHECK_MODEL,
      error: null,
    };

    await query(
      `UPDATE fact_check_requests
       SET status = 'checked', result = $1, error_message = NULL, updated_at = ${nowSql()}
       WHERE id = $2`,
      [JSON.stringify(factCheckResult), requestId]
    );

    getEmitter(request.id, request.user_id)?.emit('complete');
    console.log(`[FactCheckRequestWorker] Request ${requestId} checked`);
  } catch (error: any) {
    const attempts = (request.attempts || 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FactCheckRequestWorker] Request ${requestId} failed (attempt ${attempts}):`, message);

    if (attempts < REQUEST_MAX_ATTEMPTS) {
      const retryDelay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
      const nextRetry = new Date(Date.now() + retryDelay);
      await query(
        `UPDATE fact_check_requests
         SET status = 'queued', attempts = $1, next_retry_at = $2, error_message = $3, updated_at = ${nowSql()}
         WHERE id = $4`,
        [attempts, USE_SQLITE ? nextRetry.toISOString() : nextRetry, message, requestId]
      );
    } else {
      await query(
        `UPDATE fact_check_requests
         SET status = 'failed', attempts = $1, error_message = $2, updated_at = ${nowSql()}
         WHERE id = $3`,
        [attempts, message, requestId]
      );
    }

    getEmitter(request.id, request.user_id)?.emit('error', message);
  }
}

let isProcessing = false;

async function processFactCheckRequestQueue(): Promise<void> {
  if (isProcessing) return;
  isProcessing = true;
  try {
    for (let i = 0; i < MAX_CONCURRENT_REQUESTS; i++) {
      const request = await getNextQueuedRequest();
      if (!request) break;
      console.log(`[FactCheckRequestWorker] Processing request ${request.id}`);
      await processFactCheckRequest(request.id);
    }
  } catch (error) {
    console.error('[FactCheckRequestWorker] Queue processing error:', error);
  } finally {
    isProcessing = false;
  }
}

/**
 * recoverStuckRequests — на старте процесса, без порога по времени (любой
 * in_progress на момент старта зависший по определению). next_retry_at=NULL,
 * attempts=attempts+1 — защита от бесконечного crash-loop (§15 п.10).
 */
export async function recoverStuckRequests(): Promise<void> {
  try {
    const result = await query(
      `UPDATE fact_check_requests
       SET status = 'queued', next_retry_at = NULL, attempts = attempts + 1, updated_at = ${nowSql()}
       WHERE status = 'in_progress'`
    );
    const count = result.rowCount ?? 0;
    if (count > 0) {
      console.log(`[FactCheckRequestWorker] Recovered ${count} stuck request(s)`);
    }
  } catch (err: any) {
    console.error('[FactCheckRequestWorker] recoverStuckRequests error:', err.message);
  }
}

export function startFactCheckRequestCron(): void {
  console.log('[FactCheckRequestWorker] Starting worker (every 5s)');
  recoverStuckRequests().catch(() => {});
  setTimeout(() => {
    processFactCheckRequestQueue().catch(() => {});
  }, 3000);
  setInterval(() => {
    processFactCheckRequestQueue().catch(() => {});
  }, POLL_INTERVAL_SECONDS * 1000);
}
