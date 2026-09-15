/**
 * =============================================================================
 * PULSE — Ad-hoc Fact-Check Request Routes (TZ_FACTCHECK_PAGE v1.3)
 * =============================================================================
 *
 * Монтируется в index.ts как app.use('/api/fact-check', factCheckRequestsRoutes).
 *
 * Endpoints:
 *   POST   /api/fact-check                 — запуск проверки (Premium+; is_public игнорируется)
 *   GET    /api/fact-check/feed            — общая лента (публичный; v1 — только проверенные новости PULSE)
 *   GET    /api/fact-check/my              — мои проверки (auth: requests + заказанные новости)
 *   GET    /api/fact-check/:id             — статус/результат (owner; чужим всегда 403 в v1)
 *   GET    /api/fact-check/:id/stream      — SSE прогресс (owner-only, ?token=)
 *   PATCH  /api/fact-check/:id/visibility  — ⛔ заглушка 403 visibility_locked в v1
 *
 * Приватность v1: все пользовательские проверки частные (is_public всегда FALSE),
 * в общую ленту не попадают, по прямой ссылке чужим — 403 (§2 п.4, §7.4).
 */

import { Router } from 'express';
import { EventEmitter } from 'events';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import requirePremium from '../middleware/requirePremium';
import { setEmitter, removeEmitter } from '../services/factCheck';
import {
  FactCheckInputType,
  ExtractedContent,
  extractFromUrl,
  extractFromFile,
  normalizeForHash,
  computeInputHash,
  validateVerifiableText,
  prefilterVerifiableText,
  findCheckedByHash,
  createRequest,
  getRequestById,
  listPublicFeed,
  listMyChecks,
  parseResultJson,
} from '../services/factCheckRequests';

const router = Router();

const VALID_INPUT_TYPES: FactCheckInputType[] = ['text', 'url', 'image', 'file'];
const URL_REGEX = /^https?:\/\/\S+$/;

function parseLimitOffset(req: any, defaultLimit: number, maxLimit: number): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit), 10) || defaultLimit, 1), maxLimit);
  const offset = Math.max(parseInt(String(req.query.offset), 10) || 0, 0);
  return { limit, offset };
}

function bool(v: any): boolean {
  return v === true || v === 1;
}

// POST /api/fact-check — запуск ad-hoc проверки
router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    if (!(await requirePremium(req, res))) return;

    const { input_type, text, url, file_base64, file_name, mime } = req.body || {};

    if (!VALID_INPUT_TYPES.includes(input_type)) {
      return res.status(400).json({ error: 'Неизвестный тип ввода. Ожидается text, url, image или file.' });
    }
    // ⛔ v1: поле is_public из тела игнорируется — сервер всегда пишет false (§7.1)

    let extracted: ExtractedContent;
    let inputRaw: string | null = null;

    if (input_type === 'text') {
      if (typeof text !== 'string' || !text.trim()) {
        return res.status(400).json({ error: 'Вставьте текст для проверки.' });
      }
      extracted = { title: text.trim().slice(0, 120), text: text.trim() };
    } else if (input_type === 'url') {
      if (typeof url !== 'string' || !URL_REGEX.test(url.trim())) {
        return res.status(400).json({ error: 'Вставьте корректную ссылку (http:// или https://).' });
      }
      if (url.length > 2000) {
        return res.status(400).json({ error: 'Ссылка слишком длинная.' });
      }
      inputRaw = url.trim();
      try {
        extracted = await extractFromUrl(inputRaw);
      } catch (err: any) {
        return res.status(422).json({
          error: `Не удалось извлечь текст по ссылке: ${err.message}. Попробуйте вставить текст статьи вручную.`,
          extraction_failed: true,
        });
      }
    } else {
      // image | file — требуется согласие на передачу файла оператору ИИ (§5)
      const userResult = await query(
        `SELECT ai_file_consent_at FROM users WHERE id = $1`,
        [userId]
      );
      if (!userResult.rows[0]?.ai_file_consent_at) {
        return res.status(403).json({
          error: 'Для проверки файлов нужно согласие на передачу файла оператору ИИ.',
          consent_required: true,
        });
      }
      if (typeof file_base64 !== 'string' || !file_base64) {
        return res.status(400).json({ error: 'Файл не передан.' });
      }
      inputRaw = typeof file_name === 'string' && file_name ? file_name : 'file';
      try {
        extracted = await extractFromFile(file_base64, inputRaw, typeof mime === 'string' ? mime : 'application/octet-stream');
      } catch (err: any) {
        return res.status(422).json({
          error: `Не удалось извлечь текст из файла: ${err.message}. Попробуйте вставить текст вручную.`,
          extraction_failed: true,
        });
      }
    }

    // Слой 1 — правила валидации (§6)
    const validationError = validateVerifiableText(extracted.text);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const extractedText = extracted.text.slice(0, 8000);
    // Для image/file дедуп по содержимому — хэш от extracted_text (§15 п.6)
    const hashSource = input_type === 'url' ? inputRaw! : extractedText;
    const inputHash = computeInputHash(input_type, normalizeForHash(input_type, hashSource));

    // Дедуп: повтор → новая запись с результатом оригинала, reused: true, LLM не вызывается
    const existing = await findCheckedByHash(inputHash);
    if (existing) {
      const { id } = await createRequest({
        userId,
        inputType: input_type,
        inputRaw,
        title: extracted.title,
        extractedText,
        inputHash,
      });
      return res.status(200).json({
        id,
        status: 'checked',
        reused: true,
        title: existing.title || extracted.title,
        extracted_text: String(existing.extracted_text || '').slice(0, 500),
        result: parseResultJson(existing.result),
      });
    }

    // Слой 2 — LLM-префильтр (перед очередью; fail-open внутри)
    const prefilterError = await prefilterVerifiableText(extractedText);
    if (prefilterError) {
      return res.status(422).json({ error: prefilterError, not_verifiable: true });
    }

    const { id } = await createRequest({
      userId,
      inputType: input_type,
      inputRaw,
      title: extracted.title,
      extractedText,
      inputHash,
    });

    return res.status(201).json({
      id,
      status: 'queued',
      reused: false,
      title: extracted.title,
      extracted_text: extractedText.slice(0, 500),
      result: null,
    });
  } catch (err: any) {
    console.error('[FactCheckRequestRoute] POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fact-check/feed — общая лента (публичная; v1 — только проверенные новости PULSE)
router.get('/feed', async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req, 30, 100);
    const items = await listPublicFeed(limit, offset);
    // user_id в выдаче отсутствует (приёмка №8)
    return res.json({ items });
  } catch (err: any) {
    console.error('[FactCheckRequestRoute] feed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fact-check/my — мои проверки (auth)
router.get('/my', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { limit, offset } = parseLimitOffset(req, 50, 100);
    const items = await listMyChecks(userId, limit, offset);
    return res.json({ items });
  } catch (err: any) {
    console.error('[FactCheckRequestRoute] my error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fact-check/:id — статус/результат (owner; в v1 чужим всегда 403)
router.get('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const request = await getRequestById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Проверка не найдена' });
    }

    const isOwner = request.user_id === userId;
    if (!isOwner) {
      // Все пользовательские проверки частные (v1) — публичных нет
      return res.status(403).json({ error: 'Эта проверка частная' });
    }

    return res.json({
      id: request.id,
      input_type: request.input_type,
      title: request.title,
      extracted_text: request.extracted_text,
      status: request.status,
      result: parseResultJson(request.result),
      error_message: request.error_message,
      is_public: bool(request.is_public),
      created_at: request.created_at,
      updated_at: request.updated_at,
    });
  } catch (err: any) {
    console.error('[FactCheckRequestRoute] GET /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fact-check/:id/stream — SSE прогресс (owner-only, авторизация ?token=)
router.get('/:id/stream', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const request = await getRequestById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Проверка не найдена' });
    }
    if (request.user_id !== userId) {
      return res.status(403).json({ error: 'Эта проверка частная' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (data: any) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Уже завершённой — сразу complete/error
    if (request.status === 'checked') {
      send({ type: 'complete' });
      return res.end();
    }
    if (request.status === 'failed') {
      send({ type: 'error', message: request.error_message || 'Проверка завершилась с ошибкой' });
      return res.end();
    }

    const emitter = new EventEmitter();
    setEmitter(request.id, userId, emitter);

    emitter.on('stage', (stage: string, payload: any) => {
      send({ stage, payload, timestamp: Date.now() });
    });
    emitter.on('complete', () => {
      send({ type: 'complete' });
      res.end();
    });
    emitter.on('error', (message: string) => {
      send({ type: 'error', message });
      res.end();
    });

    req.on('close', () => {
      emitter.removeAllListeners();
      removeEmitter(request.id, userId);
    });
  } catch (err: any) {
    console.error('[FactCheckRequestRoute] SSE error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/fact-check/:id/visibility — ⛔ отключён в v1 (§7.6)
router.patch('/:id/visibility', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const request = await getRequestById(req.params.id);
    if (!request) {
      return res.status(404).json({ error: 'Проверка не найдена' });
    }
    if (request.user_id !== userId) {
      return res.status(403).json({ error: 'Эта проверка частная' });
    }
    // Заглушка: публикация в общую ленту — v2 вместе с модерацией (§2 п.4)
    return res.status(403).json({
      error: 'visibility_locked',
      message: 'Публикация в общую ленту будет доступна в следующих версиях',
    });
  } catch (err: any) {
    console.error('[FactCheckRequestRoute] PATCH visibility error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
