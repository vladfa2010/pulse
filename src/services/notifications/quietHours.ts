/**
 * PULSE — Тихие часы. Фикс бага с часовым поясом.
 *
 * Раньше: isQuietHours() использовал new Date().getHours() — локальное время
 * СЕРВЕРА (на Render = UTC), а пользователь задаёт часы в UI, ожидая МСК.
 * Дефолт 22:00–08:00 фактически блокировал 01:00–11:00 МСК (все утренние дайджесты).
 *
 * Теперь: сравнение всегда идёт в московском времени.
 */

const MSK_OFFSET_HOURS = 3;

export function isQuietHoursMsk(start: string, end: string, now: Date = new Date()): boolean {
  const mskTotalMinutes =
    (((now.getUTCHours() + MSK_OFFSET_HOURS) % 24) * 60) + now.getUTCMinutes();

  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return mskTotalMinutes >= startMinutes && mskTotalMinutes <= endMinutes;
  }
  // Интервал через полночь (напр. 22:00–08:00)
  return mskTotalMinutes >= startMinutes || mskTotalMinutes <= endMinutes;
}

/** Вспомогательная функция для проверки строки времени. */
export function parseTimeMinutes(time: string): number | null {
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

export function isQuietHoursForProduct(
  product: string,
  start: string,
  end: string,
  now: Date = new Date()
): boolean {
  // Transactional billing не должен откладываться тихими часами
  if (product === 'billing') return false;
  return isQuietHoursMsk(start, end, now);
}

export function isQuietHoursNow(start: string, end: string): boolean {
  return isQuietHoursMsk(start, end);
}

export function formatMskTime(now: Date = new Date()): string {
  const mskHours = (now.getUTCHours() + MSK_OFFSET_HOURS) % 24;
  const mskMinutes = now.getUTCMinutes();
  return `${String(mskHours).padStart(2, '0')}:${String(mskMinutes).padStart(2, '0')}`;
}

export function getMskDate(now: Date = new Date()): Date {
  return new Date(now.getTime() + MSK_OFFSET_HOURS * 60 * 60 * 1000);
}

export function isMskWeekend(now: Date = new Date()): boolean {
  const mskDay = getMskDate(now).getUTCDay();
  return mskDay === 0 || mskDay === 6;
}

export { isQuietHoursMsk as isQuietHours };
