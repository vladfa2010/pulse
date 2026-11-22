/**
 * =============================================================================
 * PULSE — Границы бакетов «Пока вас не было» (ТЗ-218)
 * =============================================================================
 *
 * Бакеты фиксированные, по МСК: ночь 00–06, утро 06–12, день 12–18, вечер 18–24.
 * Границы считаются от UTC+3 (тот же подход, что quietHours.ts — арифметика
 * по UTC, без Intl/таймзон БД; DST в РФ отменён). Чистые функции, без БД.
 */

export const MSK_OFFSET_HOURS = 3;
export const BUCKET_HOURS = 6;

export type BucketKey = 'night' | 'morning' | 'day' | 'evening';
export type BucketRange = { start: Date; end: Date; key: BucketKey };

export function bucketKey(startMskHours: number): BucketKey {
  const h = ((startMskHours % 24) + 24) % 24;
  if (h < 6) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'day';
  return 'evening';
}

/** Московское «время суток» в минутах от полуночи МСК для UTC-инстанта. */
function mskMinutesOfDay(d: Date): number {
  return (((d.getUTCHours() + MSK_OFFSET_HOURS) % 24) * 60) + d.getUTCMinutes();
}

/**
 * Окно бакета, содержащее московское время `d`.
 * Принадлежность — полуинтервалу (start, end]: новость, опубликованная ровно
 * на границе 06:00, принадлежит бакету «Ночь», а не «Утро» (критерий приёмки
 * ТЗ-218). Следствие: 00:00 ровно принадлежит вчерашнему «Вечеру».
 */
export function floorToBucket(d: Date): BucketRange {
  const total = mskMinutesOfDay(d);
  const startMin = Math.floor(total / (BUCKET_HOURS * 60)) * BUCKET_HOURS * 60;
  let start = new Date(d.getTime() - total * 60000 + startMin * 60000);
  if (total % (BUCKET_HOURS * 60) === 0) {
    // ровно на границе — принадлежит предыдущему бакету (start, end]
    start = new Date(start.getTime() - BUCKET_HOURS * 3600000);
  }
  const end = new Date(start.getTime() + BUCKET_HOURS * 3600000);
  return { start, end, key: bucketKey(start.getUTCHours() + MSK_OFFSET_HOURS) };
}

/**
 * Закрытые бакеты в полуинтервале [from, now): бакет закрыт, если его end ≤ now.
 * Идут по возрастанию range_start (ночь раньше утра).
 */
export function closedBucketsSince(now: Date, from: Date): BucketRange[] {
  const out: BucketRange[] = [];
  let b = floorToBucket(from);
  if (b.start < from) {
    // from внутри бакета — начинаем со следующего
    const start = b.end;
    b = { start, end: new Date(start.getTime() + BUCKET_HOURS * 3600000), key: bucketKey(start.getUTCHours() + MSK_OFFSET_HOURS) };
  }
  while (b.end <= now) {
    out.push(b);
    const start = b.end;
    b = { start, end: new Date(start.getTime() + BUCKET_HOURS * 3600000), key: bucketKey(start.getUTCHours() + MSK_OFFSET_HOURS) };
  }
  return out;
}
