/**
 * =============================================================================
 * PULSE — Radio Routes (ТЗ-42)
 * =============================================================================
 *
 * Радио — тонкий голосовой рендер поверх данных Pulse (RADIO.md v4).
 * Этот роут — весь новый backend радио:
 *
 *   POST /api/radio/tts    → Прокси Minimax TTS (модель в env MINIMAX_TTS_MODEL, дефолт speech-2.8-hd, ключ только на сервере)
 *   GET  /api/radio/config → Серверные флаги радио (для любого авторизованного
 *                            пользователя, НЕ adminMiddleware — блокер Б2 ревью)
 *
 * Управление флагами (админка, запись в БД) — ТЗ-45: таблица `_radio_settings`,
 * сервис `src/services/radioSettings.ts`, admin endpoints `/api/admin/radio-flags`.
 * Дефолты ниже остались только как fallback-список голосов для TTS.
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { radioTtsLimiter, checkRateLimit } from '../middleware/rateLimit';
import { recordTtsResult } from '../services/radioMetrics';
import { getRadioFlags } from '../services/radioSettings';
import {
  MINIMAX_TTS_MODEL,
  cacheGetPublic,
  getOrFetchMp3,
} from '../services/radioMp3Cache';

const router = Router();

// ТЗ-65: экспортировано для prewarm (radioMp3CachePrewarm.ts) — один источник
// URL/логики декодирования для всего TTS-стека.
export const MINIMAX_TTS_URL = 'https://api.minimax.io/v1/t2a_v2';
// ТЗ-61: модель выбирается через env MINIMAX_TTS_MODEL. Дефолт — speech-2.8-hd
// (последняя HD: 40 языков, 10 эмоций, sound tags для пауз). Проверено на ключе:
// обе модели (2.8-hd и 02-hd) отвечают 200 на t2a_v2. Откат на старую —
// задать MINIMAX_TTS_MODEL=speech-02-hd в env, без деплоя.
// Значение импортируется из radioMp3Cache.ts (единый источник, ТЗ-63 аудит):
// участвует и в upstream-запросе, и в ключе mp3-кеша.
const TTS_TIMEOUT_MS = 30_000;
const MAX_TEXT_LENGTH = 2000;

// Белый список голосов Minimax TTS (из прототипа radio-app/src/lib/minimax.ts). Все 8 совместимы и с 2.8-hd.
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
    ? `[Radio] MINIMAX ready (model=${MINIMAX_TTS_MODEL}, voices=${MINIMAX_VOICE_IDS.size})`
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

// POST /api/radio/tts — прокси Minimax TTS с backend mp3-кешем (ТЗ-63).
// Body: { text, voice_id?, speed?, pitch? } → 200 audio/mpeg (mp3).
// Ограничения: text ≤ 2000 символов, speed 0.5–2.0, pitch −12..+12.
// Нет MINIMAX_API_KEY → 503 tts_not_configured; ошибка апстрима → 502 tts_upstream.
// Сервис выключен админом → 503 radio_service_disabled (ТЗ-46): код отличен от
// tts_not_configured, фронт НЕ фолбэчит на браузерный голос, а останавливает эфир.
// Ответ маркируется X-Radio-Cache: HIT | MISS (фронт игнорирует, для диагностики).
//
// Цепочка (ТЗ-63):
//   authMiddleware → kill-switch → валидация → cache hit? (отдать, лимитер НЕ трогаем)
//     → apiKey check → radioTtsLimiter (checkRateLimit, ТОЛЬКО на cache miss)
//     → getOrFetchMp3 (single-flight: параллельные miss с одним ключом = 1 upstream)
//     → upstream Minimax T2A (fetchAndDecodeMinimax — бросает при ошибке, кэш не пишем).
//
// Лимитер ПОСЛЕ authMiddleware — key по userId; вызывается вручную из handler.
router.post('/tts', authMiddleware, async (req: AuthRequest, res) => {
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

  // Голос по умолчанию — из флагов БД (ТЗ-45), не из code-defaults.
  // Эффективные значения вычисляем до кеш-проверки — они входят в ключ.
  const ttsStartedAt = Date.now();
  const effectiveVoiceId = voice_id || flags.minimax_host_voice;
  const effectiveSpeed = speed ?? 1.0;
  const effectivePitch = pitch ?? 0;

  // ТЗ-63: cache check ДО лимитера. Cache hit = бесплатно (микросекунды CPU),
  // лимитер не считает — иначе активный юзер с mp3-кешем упирался бы в 429.
  const cached = cacheGetPublic(text, effectiveVoiceId, effectiveSpeed, effectivePitch);
  if (cached) {
    recordTtsResult('ok', Date.now() - ttsStartedAt, 'hit');
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(cached.length));
    res.set('X-Radio-Cache', 'HIT');
    res.send(cached);
    return;
  }

  // Cache miss — применяем лимитер. 100 req/мин на cache miss = реальный upstream.
  const allowed = await checkRateLimit(req, res, radioTtsLimiter);
  if (!allowed) return; // 429 уже отправлен лимитером

  try {
    // fetcher создаёт СВОЙ AbortController + timeout внутри (аудит замечание 2):
    // shared single-flight fetch не отменяется по disconnect отдельных ждущих —
    // abort одного caller'а завалил бы всех, кто делит promise. Отключение
    // клиента во время T2A (1–3 с) upstream не рубит: результат дописывается
    // в кэш и пойдёт следующим. Предохранитель — только таймаут 30 с.
    const { buffer } = await getOrFetchMp3(
      text,
      effectiveVoiceId,
      effectiveSpeed,
      effectivePitch,
      () => {
        const localController = new AbortController();
        const localTimeout = setTimeout(() => localController.abort(), TTS_TIMEOUT_MS);
        return fetchAndDecodeMinimax(
          apiKey, text, effectiveVoiceId, effectiveSpeed, effectivePitch, localController.signal,
        ).finally(() => clearTimeout(localTimeout));
      },
    );

    recordTtsResult('ok', Date.now() - ttsStartedAt, 'miss');
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', String(buffer.length));
    res.set('X-Radio-Cache', 'MISS');
    res.send(buffer);
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.error('[RadioTTS] Minimax timeout');
    } else {
      console.error('[RadioTTS] Upstream call failed:', err.message);
    }
    recordTtsResult('502', Date.now() - ttsStartedAt);
    res.status(502).json({ error: 'tts_upstream' });
  }
});

/**
 * ТЗ-63 (аудит блокер 3): вынесенный апстрим-вызов к Minimax T2A.
 *
 * БРОСАЕТ ошибку при !upstream.ok или при data.base_resp.status_code !== 0,
 * чтобы getOrFetchMp3 НЕ записал мусор в кэш (инвариант «upstream error →
 * пробрасываем, кэш НЕ пишем»). Возвращает декодированный mp3-буфер.
 *
 * ТЗ-65: экспортирован — переиспользуется prewarm'ом кеша.
 */
export async function fetchAndDecodeMinimax(
  apiKey: string,
  text: string,
  voiceId: string,
  speed: number,
  pitch: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const upstream = await fetch(MINIMAX_TTS_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MINIMAX_TTS_MODEL,
      text: text.trim(),
      voice_setting: { voice_id: voiceId, speed, pitch },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3' },
    }),
    signal,
  });

  if (!upstream.ok) {
    console.error(`[RadioTTS] Minimax HTTP ${upstream.status}`);
    throw new Error(`Minimax HTTP ${upstream.status}`);
  }

  const data: any = await upstream.json();
  if (data?.base_resp?.status_code !== 0 || !data?.data?.audio) {
    console.error(`[RadioTTS] Minimax error: ${data?.base_resp?.status_msg || 'no audio'}`);
    throw new Error(`Minimax: ${data?.base_resp?.status_msg || 'no audio'}`);
  }

  return Buffer.from(data.data.audio, 'hex');
}

export default router;
