/**
 * =============================================================================
 * PULSE — Алерты MP3-кэша радио в Telegram (ТЗ-65, блок 6)
 * =============================================================================
 *
 * Каждые 5 минут (через startRadioCacheMaintenance) проверяет метрики кеша и
 * шлёт TG-алерт админам через notifyAdminsSystemAlert при breach порогов.
 * Debounce: каждый тип алерта не чаще 1 раза в час.
 *
 * Пороги — env с дефолтами (без миграций БД):
 *   RADIO_CACHE_ALERT_ENABLED         (default true)
 *   RADIO_CACHE_ALERT_HIT_RATE_MIN    (default 50, %)
 *   RADIO_CACHE_ALERT_BYTES_MAX_PCT   (default 90, % лимита по байтам)
 *   RADIO_CACHE_ALERT_INFLIGHT_MAX    (default 50)
 */

import { notifyAdminsSystemAlert } from './adminAlerts';
import { getRadioTtsMetrics } from './radioMetrics';
import { getRadioMp3CacheStats } from './radioMp3Cache';

interface AlertState {
  lastHitRateAlert: number;
  lastBytesAlert: number;
  lastInflightAlert: number;
}

const DEBOUNCE_MS = 60 * 60 * 1000; // 1 час между повторами одного типа
const state: AlertState = {
  lastHitRateAlert: 0,
  lastBytesAlert: 0,
  lastInflightAlert: 0,
};

const ENABLED = process.env.RADIO_CACHE_ALERT_ENABLED !== 'false';
const HIT_MIN = parseFloat(process.env.RADIO_CACHE_ALERT_HIT_RATE_MIN || '50');
const BYTES_PCT_MAX = parseFloat(process.env.RADIO_CACHE_ALERT_BYTES_MAX_PCT || '90');
const INFLIGHT_MAX = parseInt(process.env.RADIO_CACHE_ALERT_INFLIGHT_MAX || '50', 10);

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

export async function checkCacheAlerts(): Promise<void> {
  if (!ENABLED) return;

  const cache = getRadioMp3CacheStats();
  const tts = getRadioTtsMetrics();
  const now = Date.now();

  // Hit rate — алерт только при накоплении статистики (минимум 100 запросов),
  // иначе холодный старт после recreate давал бы ложные срабатывания.
  const total = tts.cache_hit + tts.cache_miss;
  if (total > 100) {
    const hitRate = (tts.cache_hit / total) * 100;
    if (hitRate < HIT_MIN && now - state.lastHitRateAlert > DEBOUNCE_MS) {
      state.lastHitRateAlert = now;
      await notifyAdminsSystemAlert(
        `⚠️ <b>MP3 Cache hit rate упал</b>\n` +
        `Hit rate: ${hitRate.toFixed(1)}% (порог: ${HIT_MIN}%)\n` +
        `Hit: ${tts.cache_hit} / Miss: ${tts.cache_miss}\n` +
        `Возможно, идёт холодный старт или сменился ключ кэша.`
      );
    }
  }

  // Cache almost full
  const bytesPct = (cache.bytes / cache.maxBytes) * 100;
  if (bytesPct > BYTES_PCT_MAX && now - state.lastBytesAlert > DEBOUNCE_MS) {
    state.lastBytesAlert = now;
    await notifyAdminsSystemAlert(
      `⚠️ <b>MP3 Cache почти заполнен</b>\n` +
      `Занято: ${bytesPct.toFixed(1)}% (порог: ${BYTES_PCT_MAX}%)\n` +
      `Записей: ${cache.entries} / ${cache.maxEntries}\n` +
      `Размер: ${formatBytes(cache.bytes)} / ${formatBytes(cache.maxBytes)}`
    );
  }

  // High inflight — возможен miss storm / DDoS
  if (cache.inflight > INFLIGHT_MAX && now - state.lastInflightAlert > DEBOUNCE_MS) {
    state.lastInflightAlert = now;
    await notifyAdminsSystemAlert(
      `⚠️ <b>MP3 Cache: высокий inflight</b>\n` +
      `Сейчас: ${cache.inflight} (порог: ${INFLIGHT_MAX})\n` +
      `Много одновременных запросов — возможно cache miss storm или DDoS.`
    );
  }
}
