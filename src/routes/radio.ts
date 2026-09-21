/**
 * =============================================================================
 * PULSE — Radio Routes (ТЗ-42)
 * =============================================================================
 *
 * Радио — тонкий голосовой рендер поверх данных Pulse (RADIO.md v4).
 * Этот роут — весь новый backend радио:
 *
 *   POST /api/radio/tts    → Прокси Minimax speech-02-hd (ключ только на сервере)
 *   GET  /api/radio/config → Серверные флаги радио (для любого авторизованного
 *                            пользователя, НЕ adminMiddleware — блокер Б2 ревью)
 *
 * Управление флагами (админка, запись в БД) — не входит в v1: значения меняются
 * правкой дефолтов ниже и деплоем (откат за минуту — зафиксированный trade-off).
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { radioTtsLimiter } from '../middleware/rateLimit';

const router = Router();

const MINIMAX_TTS_URL = 'https://api.minimax.io/v1/t2a_v2';
const MINIMAX_MODEL = 'speech-02-hd';
const TTS_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 2000;

// Boot-лог состояния TTS (по образцу webPush.ts): без ключа сервер не молчит —
// каждый запрос давал бы 503, причина должна быть видна в логах сразу.
console.log(
  process.env.MINIMAX_API_KEY
    ? '[Radio] MINIMAX ready'
    : '[Radio] MINIMAX_API_KEY not set, /api/radio/tts returns 503'
);

// Серверные флаги радио (ТЗ-42, задача 2). Дефолты в коде.
const RADIO_FLAGS = {
  radio_auto_read_enabled: true,
  radio_voice_provider: 'browser',
  radio_minimax_host_voice: 'presenter_male',
  radio_minimax_guest_voice: 'presenter_female',
  radio_default_mode: 'reflect',
} as const;

// GET /api/radio/config — флаги радио для фронта каждого юзера.
// Существующий публичный GET /api/features не подходит — boolean-only registry.
router.get('/config', authMiddleware, (_req: AuthRequest, res) => {
  res.json(RADIO_FLAGS);
});

// POST /api/radio/tts — прокси Minimax TTS.
// Body: { text, voice_id?, speed?, pitch? } → 200 audio/mpeg (mp3).
// Ограничения: text ≤ 2000 символов, speed 0.5–2.0, pitch −12..+12.
// Нет MINIMAX_API_KEY → 503 tts_not_configured; ошибка апстрима → 502 tts_upstream.
// Лимитер ПОСЛЕ authMiddleware — per-user (keyGenerator по userId).
router.post('/tts', authMiddleware, radioTtsLimiter, async (req: AuthRequest, res) => {
  // Сначала валидация входа (400 независимо от наличия ключа), потом конфигурация
  const { text, voice_id, speed, pitch } = req.body || {};
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: 'invalid_text', maxLength: MAX_TEXT_LENGTH });
    return;
  }
  if (speed !== undefined && (typeof speed !== 'number' || speed < 0.5 || speed > 2.0)) {
    res.status(400).json({ error: 'invalid_speed', min: 0.5, max: 2.0 });
    return;
  }
  if (pitch !== undefined && (typeof pitch !== 'number' || pitch < -12 || pitch > 12)) {
    res.status(400).json({ error: 'invalid_pitch', min: -12, max: 12 });
    return;
  }

  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: 'tts_not_configured' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  // Клиент отключился во время ожидания Minimax — гасим upstream-запрос,
  // не ждём остаток таймаута и не считаем трафик (writableEnded — ответ уже
  // отправлен, это штатное закрытие, а не разрыв).
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const upstream = await fetch(MINIMAX_TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MINIMAX_MODEL,
        text: text.trim(),
        voice_setting: {
          voice_id: voice_id || RADIO_FLAGS.radio_minimax_host_voice,
          speed: speed ?? 1.0,
          pitch: pitch ?? 0,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
        },
      }),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      console.error(`[RadioTTS] Minimax HTTP ${upstream.status}`);
      res.status(502).json({ error: 'tts_upstream' });
      return;
    }

    const data: any = await upstream.json();
    if (data?.base_resp?.status_code !== 0 || !data?.data?.audio) {
      console.error(`[RadioTTS] Minimax error: ${data?.base_resp?.status_msg || 'no audio'}`);
      res.status(502).json({ error: 'tts_upstream' });
      return;
    }

    // Minimax отдаёт mp3 hex-encoded в data.audio — декодируем, отдаём бинарно
    const audio = Buffer.from(data.data.audio, 'hex');
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(audio.length));
    res.send(audio);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.error('[RadioTTS] Minimax timeout');
    } else {
      console.error('[RadioTTS] Upstream call failed:', err.message);
    }
    res.status(502).json({ error: 'tts_upstream' });
  } finally {
    clearTimeout(timeout);
  }
});

export default router;
