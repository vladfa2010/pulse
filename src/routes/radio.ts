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
 * Управление флагами (админка, запись в БД) — ТЗ-45: таблица `_radio_settings`,
 * сервис `src/services/radioSettings.ts`, admin endpoints `/api/admin/radio-flags`.
 * Дефолты ниже остались только как fallback-список голосов для TTS.
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { radioTtsLimiter } from '../middleware/rateLimit';
import { recordTtsResult } from '../services/radioMetrics';
import { getRadioFlags } from '../services/radioSettings';

const router = Router();

const MINIMAX_TTS_URL = 'https://api.minimax.io/v1/t2a_v2';
const MINIMAX_MODEL = 'speech-02-hd';
const TTS_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 2000;

// Белый список голосов speech-02-hd (из прототипа radio-app/src/lib/minimax.ts).
// Без него чужой voice_id уезжал бы в Minimax → 502 вместо понятного 400.
const MINIMAX_VOICE_IDS = new Set([
  'presenter_male', 'presenter_female',
  'audiobook_male_1', 'audiobook_female_1',
  'audiobook_male_2', 'audiobook_female_2',
  'male-qn-qingse', 'female-shaonv',
  'male-qn-jingying', 'female-yujie',
]);

// Boot-лог состояния TTS (по образцу webPush.ts): без ключа сервер не молчит —
// каждый запрос давал бы 503, причина должна быть видна в логах сразу.
console.log(
  process.env.MINIMAX_API_KEY
    ? '[Radio] MINIMAX ready'
    : '[Radio] MINIMAX_API_KEY not set, /api/radio/tts returns 503'
);

// GET /api/radio/config — флаги радио для фронта каждого юзера.
// Существующий публичный GET /api/features не подходит — boolean-only registry.
// Флаги глобальные и одинаковые для всех — кэшируем на 5 мин (= useQuery TTL,
// ТЗ-43), чтобы прокси/CDN не долбили бэк ревалидациями.
// ТЗ-45: значения из БД (_radio_settings, сервис с кэшем TTL 60 с),
// формат ответа не менялся (префикс radio_) + новое поле minimax_configured.
router.get('/config', authMiddleware, async (_req: AuthRequest, res) => {
  const flags = await getRadioFlags();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({
    radio_service_enabled: flags.service_enabled,
    radio_voice_provider: flags.voice_provider,
    radio_minimax_host_voice: flags.minimax_host_voice,
    radio_minimax_guest_voice: flags.minimax_guest_voice,
    radio_default_mode: flags.default_mode,
    minimax_configured: !!process.env.MINIMAX_API_KEY,
  });
});

// POST /api/radio/tts — прокси Minimax TTS.
// Body: { text, voice_id?, speed?, pitch? } → 200 audio/mpeg (mp3).
// Ограничения: text ≤ 2000 символов, speed 0.5–2.0, pitch −12..+12.
// Нет MINIMAX_API_KEY → 503 tts_not_configured; ошибка апстрима → 502 tts_upstream.
// Сервис выключен админом → 503 radio_service_disabled (ТЗ-46): код отличен от
// tts_not_configured, фронт НЕ фолбэчит на браузерный голос, а останавливает эфир.
// Лимитер ПОСЛЕ authMiddleware — per-user (keyGenerator по userId).
router.post('/tts', authMiddleware, radioTtsLimiter, async (req: AuthRequest, res) => {
  // Kill-switch сервиса — в начале handler, до валидации входа и до проверки ключа:
  // иначе выключенное админом радио продолжало бы звучать браузерным TTS на фронте.
  // В TTS-метрики (radioMetrics) НЕ пишем: это политическое отклонение, не сбой
  // upstream (зафиксировано в ТЗ-46 §5; учёт таких запросов — ТЗ-47).
  const flags = await getRadioFlags();
  if (!flags.service_enabled) {
    res.status(503).json({ error: 'radio_service_disabled' });
    return;
  }

  // Сначала валидация входа (400 независимо от наличия ключа), потом конфигурация
  const { text, voice_id, speed, pitch } = req.body || {};
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: 'invalid_text', maxLength: MAX_TEXT_LENGTH });
    return;
  }
  if (voice_id !== undefined && (typeof voice_id !== 'string' || !MINIMAX_VOICE_IDS.has(voice_id))) {
    res.status(400).json({ error: 'invalid_voice_id', allowed: [...MINIMAX_VOICE_IDS] });
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
    recordTtsResult('503');
    res.status(503).json({ error: 'tts_not_configured' });
    return;
  }

  // Голос по умолчанию — из флагов БД (ТЗ-45), не из code-defaults
  const ttsStartedAt = Date.now();
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
          voice_id: voice_id || flags.minimax_host_voice,
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
      recordTtsResult('502', Date.now() - ttsStartedAt);
      res.status(502).json({ error: 'tts_upstream' });
      return;
    }

    const data: any = await upstream.json();
    if (data?.base_resp?.status_code !== 0 || !data?.data?.audio) {
      console.error(`[RadioTTS] Minimax error: ${data?.base_resp?.status_msg || 'no audio'}`);
      recordTtsResult('502', Date.now() - ttsStartedAt);
      res.status(502).json({ error: 'tts_upstream' });
      return;
    }

    // Minimax отдаёт mp3 hex-encoded в data.audio — декодируем, отдаём бинарно
    const audio = Buffer.from(data.data.audio, 'hex');
    recordTtsResult('ok', Date.now() - ttsStartedAt);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(audio.length));
    res.send(audio);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.error('[RadioTTS] Minimax timeout');
    } else {
      console.error('[RadioTTS] Upstream call failed:', err.message);
    }
    recordTtsResult('502', Date.now() - ttsStartedAt);
    res.status(502).json({ error: 'tts_upstream' });
  } finally {
    clearTimeout(timeout);
  }
});

export default router;
