/**
 * =============================================================================
 * PULSE — Конфигурация радио (ТЗ-66-lite, 2026-09-26)
 * =============================================================================
 *
 * Единый источник правды для статических констант Minimax TTS: URL, модель,
 * белый список голосов. Раньше размазано по routes/radio.ts (const'ы),
 * services/radioMp3Cache.ts (модель) и services/radioSettings.ts (whitelist).
 *
 * ВАЖНО: дефолт модели через `||`, а не `??` — compose-маппинг
 * MINIMAX_TTS_MODEL: ${MINIMAX_TTS_MODEL} при отсутствии переменной в .env
 * прокидывает ПУСТУЮ строку, `??` её не ловит (баг, hotfix ad5fc6f).
 */

export const MINIMAX_TTS_URL = 'https://api.minimax.io/v1/t2a_v2';

// ТЗ-61: модель через env MINIMAX_TTS_MODEL, дефолт speech-2.8-hd
// (последняя HD: 40 языков, 10 эмоций, sound tags для пауз). Проверено на
// ключе: обе модели (2.8-hd и 02-hd) отвечают 200 на t2a_v2. Откат —
// MINIMAX_TTS_MODEL=speech-02-hd в env, без деплоя.
export const MINIMAX_TTS_MODEL = process.env.MINIMAX_TTS_MODEL || 'speech-2.8-hd';

// Белый список голосов Minimax TTS (из прототипа radio-app). Все 10 совместимы
// и с 2.8-hd. Без него чужой voice_id уезжал бы в Minimax → 502 вместо 400.
//
// ТЗ68: список расширен до библиотеки MINIMAX_VOICES с метаданными для админки.
// ВАЖНО: сюда включаются ТОЛЬКО реально существующие голоса Minimax — словарь
// одновременно является валидацией флагов (radioSettings) и /tts. Проба голосов
// вне списка идёт через preview, а доступность в аккаунте измеряется probe'ом
// (services/radioVoices.ts), который проставляет inAccount поверх этих записей.
export interface MinimaxVoiceMeta {
  id: string
  labelRu: string
  labelEn: string
  gender: 'm' | 'f' | 'n'
  age: 'young' | 'middle' | 'mature'
  language: string[]
  tone: 'neutral' | 'energetic' | 'calm' | 'warm' | 'dramatic'
  voiceType?: 'system' | 'voice_cloning' | 'voice_generation'
  /** Доступен в этом Minimax-аккаунте (probe /v1/t2a_v2). undefined = не измерен. */
  inAccount?: boolean
}

export const MINIMAX_VOICES: Record<string, MinimaxVoiceMeta> = {
  // presenter_* — голоса эфира (Михаил/Татьяна)
  presenter_male:   { id: 'presenter_male',   labelRu: 'Михаил',  labelEn: 'Presenter Male',   gender: 'm', age: 'middle', language: ['ru'], tone: 'neutral', voiceType: 'system' },
  presenter_female: { id: 'presenter_female', labelRu: 'Татьяна', labelEn: 'Presenter Female', gender: 'f', age: 'middle', language: ['ru'], tone: 'neutral', voiceType: 'system' },
  // audiobook_* — тёплые «книжные» голоса
  audiobook_male_1:   { id: 'audiobook_male_1',   labelRu: 'Audiobook М', labelEn: 'Audiobook Male 1',   gender: 'm', age: 'middle', language: ['ru'], tone: 'warm',     voiceType: 'system' },
  audiobook_female_1: { id: 'audiobook_female_1', labelRu: 'Audiobook Ж', labelEn: 'Audiobook Female 1', gender: 'f', age: 'middle', language: ['ru'], tone: 'warm',     voiceType: 'system' },
  audiobook_male_2:   { id: 'audiobook_male_2',   labelRu: 'Audiobook М 2', labelEn: 'Audiobook Male 2',   gender: 'm', age: 'mature', language: ['ru'], tone: 'dramatic', voiceType: 'system' },
  audiobook_female_2: { id: 'audiobook_female_2', labelRu: 'Audiobook Ж 2', labelEn: 'Audiobook Female 2', gender: 'f', age: 'mature', language: ['ru'], tone: 'dramatic', voiceType: 'system' },
  // male-qn-* / female-* — китайские системные голоса
  'male-qn-qingse':   { id: 'male-qn-qingse',   labelRu: 'Цинсэ',   labelEn: 'Male Qingse',   gender: 'm', age: 'young', language: ['zh'], tone: 'energetic', voiceType: 'system' },
  'male-qn-jingying': { id: 'male-qn-jingying', labelRu: 'ЦзинИн',  labelEn: 'Male Jingying', gender: 'm', age: 'young', language: ['zh'], tone: 'neutral',   voiceType: 'system' },
  'female-shaonv':    { id: 'female-shaonv',    labelRu: 'Шаонюй',  labelEn: 'Female Shaonv', gender: 'f', age: 'young', language: ['zh'], tone: 'energetic', voiceType: 'system' },
  'female-yujie':     { id: 'female-yujie',     labelRu: 'Юйцзе',   labelEn: 'Female Yujie',  gender: 'f', age: 'young', language: ['zh'], tone: 'neutral',   voiceType: 'system' },
  // English_* — мультиязычное семейство (поддерживает и русский текст)
  English_Graceful_Lady: { id: 'English_Graceful_Lady', labelRu: 'Graceful Lady', labelEn: 'English Graceful Lady', gender: 'f', age: 'middle', language: ['en', 'ru'], tone: 'calm',    voiceType: 'system' },
  English_Proactive_Girl: { id: 'English_Proactive_Girl', labelRu: 'Proactive Girl', labelEn: 'English Proactive Girl', gender: 'f', age: 'young', language: ['en', 'ru'], tone: 'energetic', voiceType: 'system' },
  English_Cheerful_Girl: { id: 'English_Cheerful_Girl', labelRu: 'Cheerful Girl', labelEn: 'English Cheerful Girl', gender: 'f', age: 'young', language: ['en', 'ru'], tone: 'energetic', voiceType: 'system' },
  English_Lively_Girl: { id: 'English_Lively_Girl', labelRu: 'Lively Girl', labelEn: 'English Lively Girl', gender: 'f', age: 'young', language: ['en', 'ru'], tone: 'energetic', voiceType: 'system' },
  English_Gentle_Girl: { id: 'English_Gentle_Girl', labelRu: 'Gentle Girl', labelEn: 'English Gentleful Girl', gender: 'f', age: 'young', language: ['en', 'ru'], tone: 'calm',    voiceType: 'system' },
  English_Friendly_Guy: { id: 'English_Friendly_Guy', labelRu: 'Friendly Guy', labelEn: 'English Friendly Guy', gender: 'm', age: 'young', language: ['en', 'ru'], tone: 'warm',    voiceType: 'system' },
  English_Calm_Guy: { id: 'English_Calm_Guy', labelRu: 'Calm Guy', labelEn: 'English Calm Guy', gender: 'm', age: 'middle', language: ['en', 'ru'], tone: 'calm',    voiceType: 'system' },
  English_Casual_Guy: { id: 'English_Casual_Guy', labelRu: 'Casual Guy', labelEn: 'English Casual Guy', gender: 'm', age: 'young', language: ['en', 'ru'], tone: 'neutral', voiceType: 'system' },
  English_Lively_Guy: { id: 'English_Lively_Guy', labelRu: 'Lively Guy', labelEn: 'English Lively Guy', gender: 'm', age: 'young', language: ['en', 'ru'], tone: 'energetic', voiceType: 'system' },
  English_Rational_Man: { id: 'English_Rational_Man', labelRu: 'Rational Man', labelEn: 'English Rational Man', gender: 'm', age: 'middle', language: ['en', 'ru'], tone: 'neutral', voiceType: 'system' },
  English_Mature_Man: { id: 'English_Mature_Man', labelRu: 'Mature Man', labelEn: 'English Mature Man', gender: 'm', age: 'mature', language: ['en', 'ru'], tone: 'calm',    voiceType: 'system' },
};

// Валидация voice_id (radioSettings + routes/radio.ts) — производная от словаря.
export const MINIMAX_VOICE_IDS: readonly string[] = Object.keys(MINIMAX_VOICES);

export const MINIMAX_VOICE_IDS_SET: ReadonlySet<string> = new Set(MINIMAX_VOICE_IDS);
