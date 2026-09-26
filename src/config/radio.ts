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
export const MINIMAX_VOICE_IDS: readonly string[] = [
  'presenter_male', 'presenter_female',
  'audiobook_male_1', 'audiobook_female_1',
  'audiobook_male_2', 'audiobook_female_2',
  'male-qn-qingse', 'female-shaonv',
  'male-qn-jingying', 'female-yujie',
];

export const MINIMAX_VOICE_IDS_SET: ReadonlySet<string> = new Set(MINIMAX_VOICE_IDS);
