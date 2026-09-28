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
  // English_* — мультиязычное семейство. В словарь включаем ТОЛЬКО подтверждённые
  // probe'ом голоса (2026-09-28): Graceful_Lady реально работает; прочие
  // английские имена из ранней редакции ТЗ вернули 2054 и были удалены.
  English_Graceful_Lady: { id: 'English_Graceful_Lady', labelRu: 'Graceful Lady', labelEn: 'English Graceful Lady', gender: 'f', age: 'middle', language: ['en', 'ru'], tone: 'calm', voiceType: 'system' },
};

// Валидация voice_id (radioSettings + routes/radio.ts) — производная от словаря.
export const MINIMAX_VOICE_IDS: readonly string[] = Object.keys(MINIMAX_VOICES);

export const MINIMAX_VOICE_IDS_SET: ReadonlySet<string> = new Set(MINIMAX_VOICE_IDS);

// ═══ TZ70: фоновая музыка между блоками новостей ═══
// Папка с треками. На VDS проброшена в контейнер через bind-mount
// (/opt/pulse/docker-compose.yml: /opt/pulse/music:/opt/pulse/music) — без mount
// файлы писались бы в overlay-слой и терялись бы при recreate контейнера.
export const PULSE_MUSIC_DIR = process.env.PULSE_MUSIC_DIR || '/opt/pulse/music';

// Имя файла несёт метаданные: N_title_YY_tempo_genre.mp3
// (пример: 3_market_pulse_26_fast_dubstep.mp3).
export const PULSE_MUSIC_FILENAME_REGEX = /^(\d+)_(.+?)(\d{2})_(slow|medium|fast)_([a-z0-9]+)\.mp3$/;
export const PULSE_MUSIC_MAX_FILENAME_LEN = 200; // H-4: overlong input отсекаем
export const PULSE_MUSIC_MAX_FILES = 50;
export const PULSE_MUSIC_MAX_FILE_SIZE = 50 * 1024 * 1024;        // 50 МБ на файл
export const PULSE_MUSIC_MAX_FOLDER_SIZE = 2 * 1024 * 1024 * 1024; // 2 ГБ — disk cap (H-1)
export const PULSE_MUSIC_RANGE_PARTS_LIMIT = 10; // max range-parts в одном Range header (M-1)
