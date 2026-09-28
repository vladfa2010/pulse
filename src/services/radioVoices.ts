/**
 * =============================================================================
 * PULSE — Сервис голосов Minimax TTS (ТЗ68)
 * =============================================================================
 *
 * Три задачи:
 *  1. getAvailableVoices()  — динамический список голосов через POST /v1/get_voice
 *     (system + voice_cloning + voice_generation), merge с локальными
 *     метаданными MINIMAX_VOICES (config/radio.ts), probe доступности в аккаунте
 *     для голосов словаря. In-memory кэш 24 часа (JSON 10–50 КБ).
 *     Fallback при недоступности API — статический словарь (source: 'static').
 *  2. generatePreviewMp3()  — синхронный TTS для тестового прослушивания в
 *     админке. БЕЗ кэша (превью всегда свежее), БЕЗ rate-limit (adminMiddleware
 *     достаточно). Status 2054 (voice id not exist) — отдельная ошибка
 *     VoiceNotInAccountError → роут отдаёт 503 с понятным сообщением.
 *  3. getCustomVoices()     — клонированные/сгенерированные голоса (ТЗ69-заглушка).
 *
 * Документация: https://platform.minimax.io/docs/api-reference/voice-management-get
 */

import {
  MINIMAX_VOICES,
  MinimaxVoiceMeta,
  MINIMAX_TTS_URL,
  MINIMAX_TTS_MODEL,
} from '../config/radio';

const MINIMAX_GET_VOICES_URL = 'https://api.minimax.io/v1/get_voice';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 часа — JSON 10–50 КБ ничего не весит
const PROBE_TEXT = 'Тест'; // минимальный платный текст для probe
const PROBE_CONCURRENCY = 8;

interface CachedVoices {
  fetchedAt: number;
  source: 'minimax' | 'static';
  voices: MinimaxVoiceMeta[];
}

let cache: CachedVoices | null = null;

/** 2054 voice id not exist — голос есть в каталоге, но не в нашем аккаунте. */
export class VoiceNotInAccountError extends Error {
  readonly statusCode = 2054;
  constructor(voiceId: string) {
    super(`voice id not exist: ${voiceId}`);
    this.name = 'VoiceNotInAccountError';
  }
}

// ─── Список голосов ─────────────────────────────────────────────────────────

/** Главный entry: { voices, source }. Свежий кэш → Minimax → static fallback. */
export async function getAvailableVoices(
  apiKey: string | undefined,
): Promise<{ voices: MinimaxVoiceMeta[]; source: 'minimax' | 'static' }> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return { voices: cache.voices, source: cache.source };
  }

  if (apiKey) {
    try {
      const voices = await fetchFromMinimax(apiKey);
      cache = { fetchedAt: Date.now(), source: 'minimax', voices };
      return { voices, source: 'minimax' };
    } catch (err: any) {
      console.warn(`[RadioVoices] get_voice failed: ${err?.message}, using static fallback`);
    }
  }

  const fallback = Object.values(MINIMAX_VOICES);
  cache = { fetchedAt: Date.now(), source: 'static', voices: fallback };
  return { voices: fallback, source: 'static' };
}

/** Экспортировано для verify-скрипта: сброс кэша между кейсами. */
export function resetVoicesCache(): void {
  cache = null;
}

/** POST /v1/get_voice × 3 типа + merge с метаданными + probe словарных голосов. */
async function fetchFromMinimax(apiKey: string): Promise<MinimaxVoiceMeta[]> {
  const types = ['system', 'voice_cloning', 'voice_generation'] as const;
  const allVoices: MinimaxVoiceMeta[] = [];

  for (const voiceType of types) {
    const resp = await fetch(MINIMAX_GET_VOICES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ voice_type: voiceType }),
    });
    if (!resp.ok) {
      throw new Error(`POST /v1/get_voice voice_type=${voiceType} → ${resp.status}`);
    }
    const data: any = await resp.json();
    const list = pickVoiceList(data, voiceType);
    for (const v of list) {
      const voiceId: string = v.voice_id ?? v.id;
      if (!voiceId) continue;
      allVoices.push(mergeVoiceMeta(voiceId, v, voiceType));
    }
  }

  // Словарные голоса — известные голоса аккаунта (работают через t2a_v2), но их
  // НЕТ в каталоге get_voice (каталог ≠ доступные аккаунту). Всегда добавляем
  // их поверх каталога, чтобы админка видела и кураторские, и каталожные.
  for (const meta of Object.values(MINIMAX_VOICES)) {
    if (!allVoices.some((v) => v.id === meta.id)) {
      allVoices.push({ ...meta, voiceType: 'system' });
    }
  }

  await probeInAccount(allVoices, apiKey);
  return allVoices;
}

/**
 * Реальная структура ответа (проверено 2026-09-28): голоса под ключом
 * system_voice для system, под ключом = voice_type для клонированных;
 * voice_generation может быть null. Держим и старые варианты voice_list/voices.
 */
export function pickVoiceList(
  data: any,
  voiceType: string,
): any[] {
  const direct = data?.[voiceType];
  if (Array.isArray(direct)) return direct;
  if (Array.isArray(data?.system_voice) && voiceType === 'system') return data.system_voice;
  if (Array.isArray(data?.voice_list)) return data.voice_list;
  if (Array.isArray(data?.voices)) return data.voices;
  return [];
}

/** Merge записи Minimax с локальным словарём метаданных (экспортировано для тестов). */
export function mergeVoiceMeta(
  voiceId: string,
  apiVoice: any,
  voiceType: 'system' | 'voice_cloning' | 'voice_generation',
): MinimaxVoiceMeta {
  const local = (MINIMAX_VOICES as Record<string, MinimaxVoiceMeta>)[voiceId];
  const name: string = apiVoice?.voice_name ?? voiceId;
  // description — string[] («An expressive adult male voice…») — точный
  // источник для эвристики gender, если голоса нет в словаре.
  const description = Array.isArray(apiVoice?.description)
    ? apiVoice.description.join(' ')
    : String(apiVoice?.description ?? '');
  return {
    id: voiceId,
    labelRu: local?.labelRu ?? humanize(voiceId),
    labelEn: local?.labelEn ?? name,
    gender: local?.gender ?? inferGender(`${name} ${description}`),
    age: local?.age ?? 'middle',
    language: local?.language ?? inferLanguages(voiceId),
    tone: local?.tone ?? 'neutral',
    voiceType,
  };
}

/**
 * Probe доступности: для голосов из локального словаря делаем тихий POST
 * /v1/t2a_v2 с текстом «Тест»; base_resp.status_code === 2054 → inAccount: false.
 * Внешние голосы каталога не пробуем (300+ запросов — медленно), им inAccount
 * остаётся undefined — UI рендерит без красной метки, preview проверит сам.
 * Параллелизм ограничен PROBE_CONCURRENCY, общий таймаут — 30 сек.
 */
async function probeInAccount(voices: MinimaxVoiceMeta[], apiKey: string): Promise<void> {
  const known = voices.filter((v) => MINIMAX_VOICES[v.id]);
  if (!known.length) return;

  const timeout = setTimeout(
    () => console.warn(`[RadioVoices] probe timed out, ${known.length} voices unprobed`),
    30_000,
  );
  try {
    let idx = 0;
    async function worker(): Promise<void> {
      while (idx < known.length) {
        const v = known[idx++];
        try {
          await generatePreviewMp3(PROBE_TEXT, v.id, 1, 0, apiKey);
          v.inAccount = true;
        } catch (err: any) {
          if (err instanceof VoiceNotInAccountError) {
            v.inAccount = false;
          } else {
            // Сеть/5xx — не считаем «нет в аккаунте», оставляем undefined.
            console.warn(`[RadioVoices] probe ${v.id} failed: ${err?.message}`);
          }
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(PROBE_CONCURRENCY, known.length) }, () => worker()),
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Preview ────────────────────────────────────────────────────────────────

/**
 * Синхронный TTS для превью в админке. Без кэша, без rate-limit.
 * Бросает VoiceNotInAccountError при status_code 2054, иначе Error с текстом.
 * data.data.audio — HEX-кодированный mp3 (проверено 2026-09-28 на живом API).
 */
export async function generatePreviewMp3(
  text: string,
  voiceId: string,
  speed: number,
  pitch: number,
  apiKey: string,
): Promise<Buffer> {
  const resp = await fetch(MINIMAX_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MINIMAX_TTS_MODEL,
      text,
      voice_setting: { voice_id: voiceId, speed, pitch, vol: 1 },
      audio_setting: { format: 'mp3', sample_rate: 32000 },
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Minimax TTS HTTP ${resp.status}: ${detail.slice(0, 200)}`);
  }

  const data: any = await resp.json();
  const statusCode: number = data?.base_resp?.status_code ?? -1;
  if (statusCode === 2054) {
    throw new VoiceNotInAccountError(voiceId);
  }
  if (statusCode !== 0 || !data?.data?.audio) {
    throw new Error(`Minimax: ${data?.base_resp?.status_msg || 'no audio'}`);
  }
  return Buffer.from(data.data.audio, 'hex');
}

// ─── Custom voices (ТЗ69-заглушка) ──────────────────────────────────────────

/** Клонированные/сгенерированные голоса. На текущем тарифе обычно пусто. */
export async function getCustomVoices(
  apiKey: string,
): Promise<{ cloned: any[]; generated: any[] }> {
  const fetchType = async (voiceType: string): Promise<any[]> => {
    const resp = await fetch(MINIMAX_GET_VOICES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ voice_type: voiceType }),
    });
    if (!resp.ok) throw new Error(`get_voice ${voiceType} → ${resp.status}`);
    const data: any = await resp.json();
    return pickVoiceList(data, voiceType);
  };
  const [cloned, generated] = await Promise.all([
    fetchType('voice_cloning'),
    fetchType('voice_generation'),
  ]);
  return { cloned, generated };
}

// ─── Эвристики для голосов вне словаря (экспортировано для тестов) ──────────

export function humanize(id: string): string {
  return id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function inferGender(name: string): 'm' | 'f' | 'n' {
  const lower = name.toLowerCase();
  if (/\b(male|man|boy|gentleman|guy|husband)\b/.test(lower)) return 'm';
  if (/\b(female|woman|girl|lady|wife)\b/.test(lower)) return 'f';
  return 'n';
}

export function inferLanguages(voiceId: string): string[] {
  if (voiceId.startsWith('English_')) return ['en'];
  if (/^Chinese|_mandarin/i.test(voiceId)) return ['zh'];
  if (/male-qn|female-/.test(voiceId)) return ['zh'];
  if (/^Japanese/.test(voiceId)) return ['ja'];
  if (/^Korean/.test(voiceId)) return ['ko'];
  return ['en'];
}
