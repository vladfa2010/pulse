/**
 * =============================================================================
 * PULSE — Pre-warm MP3-кэша радио (ТЗ-65, блок 5)
 * =============================================================================
 *
 * Перед публичным эфиром (ТЗ-64) или после clear cache админ прогревает кэш
 * одной кнопкой. Греются:
 *   1. Стандартные сегменты (приветствия, прощания, общие фразы календаря).
 *   2. Текущий диалог сводки рынка (radioPodcast, кеш 6ч) — реально горячие
 *      сегменты: 9 реплик × host/guest голоса (аудит замечание 4 к ТЗ-65:
 *      хардкоженные тексты приветствий могут не совпадать с реальными).
 *
 * Использует `getOrFetchMp3()` (ТЗ-63): если ключ уже в кэше — skip, без
 * upstream. Upstream — `fetchAndDecodeMinimax` из routes/radio.ts (один
 * источник URL/модели/декодирования). Параллелизм ограничен 3 (не свалить
 * Minimax). Счётчики hit/miss не трогаем (метрики пишет handler /tts).
 *
 * Голоса — из radioSettings (ТЗ-45), темп 1.05 = дефолт юзерского плеера.
 * Pitch повторяет правило плеера (аудит F2), чтобы ключ кеша совпадал с
 * реальными запросами юзеров.
 */

import { getOrFetchMp3 } from './radioMp3Cache';
import { getMarketDialog } from './radioPodcast';
import { getRadioFlags } from './radioSettings';
import { fetchAndDecodeMinimax } from '../routes/radio';

const TTS_TIMEOUT_MS = 30_000;
const PREWARM_SPEED = 1.05;
const CONCURRENCY = 3;

// Pitch-правило плеера (useSpeech.ts / RadioPage.tsx): если обе роли — один
// голос, «аналитик» звучит выше (pitch 2). Повторяем здесь, чтобы кэш-ключ
// совпадал с реальными запросами юзеров (аудит F2: раньше prewarm грел
// pitch=0, плеер просил pitch=2 → MISS на каждой новой реплике).
const GUEST_PITCH_SAME_VOICE = 2;
const HOST_PITCH = 0;

// Стандартные сегменты эфира (захардкожены — риск Р8 ТЗ-65, дальше можно
// вынести в env RADIO_CACHE_PREWARM_TEXTS)
const COMMON_SEGMENTS = [
  'Доброе утро! С вами радио ПУЛЬС.',
  'Добрый день! С вами радио ПУЛЬС.',
  'Добрый вечер! С вами радио ПУЛЬС.',
  'Продолжаем следить для вас за рынком.',
  'На сегодня значимых событий не запланировано.',
];

export interface PrewarmResult {
  ok: number;
  skipped: number;
  errors: number;
  segments: number; // всего пар текст×голос в очереди
}

async function warmSegment(text: string, voiceId: string, pitch: number): Promise<'ok' | 'skipped' | 'error'> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
  try {
    const r = await getOrFetchMp3(text, voiceId, PREWARM_SPEED, pitch, () =>
      fetchAndDecodeMinimax(
        process.env.MINIMAX_API_KEY || '', text, voiceId, PREWARM_SPEED, pitch,
        controller.signal,
      )
    );
    return r.hit ? 'skipped' : 'ok';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timeout);
  }
}

export async function prewarmCommonSegments(): Promise<PrewarmResult> {
  const flags = await getRadioFlags();
  const sameVoice = flags.minimax_guest_voice === flags.minimax_host_voice;
  const guestPitch = sameVoice ? GUEST_PITCH_SAME_VOICE : 0;
  // [голос, pitch] для каждой роли — общие фразы греем голосом ведущего
  const roleVoices: { voiceId: string; pitch: number }[] = [
    { voiceId: flags.minimax_host_voice, pitch: HOST_PITCH },
    { voiceId: flags.minimax_guest_voice, pitch: guestPitch },
  ];

  const texts = [...COMMON_SEGMENTS];
  // Диалог сводки — если он уже сгенерирован (кеш 6ч), греем его реплики.
  // Каждая реплика — голосом своей роли с pitch роли.
  const dialog = await getMarketDialog();
  const dialogPairs: { text: string; voiceId: string; pitch: number }[] = [];
  if (dialog && dialog.length > 0) {
    for (const seg of dialog) {
      const text = seg.text?.trim();
      if (!text) continue;
      dialogPairs.push({
        text: seg.text,
        voiceId: seg.role === 'guest' ? flags.minimax_guest_voice : flags.minimax_host_voice,
        pitch: seg.role === 'guest' ? guestPitch : HOST_PITCH,
      });
    }
  }

  // Общие фразы — по всем уникальным (голос, pitch) парам
  const seen = new Set<string>();
  const queue: { text: string; voiceId: string; pitch: number }[] = [];
  for (const { voiceId, pitch } of roleVoices) {
    for (const text of texts) {
      const k = `${text.trim()}\x00${voiceId}\x00${pitch}`;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push({ text, voiceId, pitch });
    }
  }
  // Реплики диалога — со своими парами (дедуп против уже нагретого)
  for (const p of dialogPairs) {
    const k = `${p.text.trim()}\x00${p.voiceId}\x00${p.pitch}`;
    if (seen.has(k)) continue;
    seen.add(k);
    queue.push(p);
  }

  const result: PrewarmResult = { ok: 0, skipped: 0, errors: 0, segments: queue.length };

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const seg = queue.shift();
      if (!seg) return;
      const r = await warmSegment(seg.text, seg.voiceId, seg.pitch);
      result[r === 'ok' ? 'ok' : r === 'skipped' ? 'skipped' : 'errors']++;
    }
  });
  await Promise.all(workers);

  return result;
}
