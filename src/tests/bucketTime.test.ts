/**
 * =============================================================================
 * PULSE — ТЗ-218: юнит-прогон границ бакетов (services/bucketTime.ts)
 * =============================================================================
 *
 * Прогон: npx tsx src/tests/bucketTime.test.ts
 * Границы: 05:59 МСК → бакет ночи открыт; 06:00 МСК → ночь закрыта;
 * переход через сутки; полуинтервал [start, end) для новости на границе.
 */

import { floorToBucket, closedBucketsSince, bucketKey } from '../services/bucketTime';

let passed = 0;
let failed = 0;
function ok(name: string): void { passed++; console.log(`  ok  ${name}`); }
function bad(name: string, detail?: unknown): void { failed++; console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
function eq(actual: unknown, expected: unknown, name: string): void {
  if (actual === expected) ok(name); else bad(name, { actual, expected });
}

// UTC-инстанты, соответствующие МСК-времени (MSK = UTC+3)
// Date.UTC нормализует перенос: часы h-3 < 0 → предыдущий календарный день UTC
const msk = (h: number, m = 0, dayShift = 0): Date =>
  new Date(Date.UTC(2026, 10, 20 + dayShift, h - 3, m));

// bucketKey
eq(bucketKey(0), 'night', 'key: 0 → night');
eq(bucketKey(5), 'night', 'key: 5 → night');
eq(bucketKey(6), 'morning', 'key: 6 → morning');
eq(bucketKey(12), 'day', 'key: 12 → day');
eq(bucketKey(18), 'evening', 'key: 18 → evening');
eq(bucketKey(23), 'evening', 'key: 23 → evening');

// floorToBucket внутри бакетов
let b = floorToBucket(msk(2, 30));
eq(b.key, 'night', '02:30 МСК → бакет ночи');
eq(b.start.getTime(), msk(0).getTime(), 'ночь start = 00:00 МСК');
eq(b.end.getTime(), msk(6).getTime(), 'ночь end = 06:00 МСК');

b = floorToBucket(msk(7));
eq(b.key, 'morning', '07:00 МСК → утро');
eq(b.start.getTime(), msk(6).getTime(), 'утро start = 06:00 МСК');

b = floorToBucket(msk(13));
eq(b.key, 'day', '13:00 МСК → день');
eq(b.start.getTime(), msk(12).getTime(), 'день start = 12:00 МСК');

b = floorToBucket(msk(19));
eq(b.key, 'evening', '19:00 МСК → вечер');
eq(b.start.getTime(), msk(18).getTime(), 'вечер start = 18:00 МСК');

// ровно на границе 06:00 → Ночь (полуинтервал [start, end))
b = floorToBucket(msk(6, 0));
eq(b.key, 'night', '06:00 ровно → Ночь, не Утро (критерий ТЗ-218)');

// closedBucketsSince: сейчас 05:59 — ночь открыта (end 06:00 > now)
let closed = closedBucketsSince(msk(5, 59), msk(0));
eq(closed.length, 0, '05:59 МСК → ночь ещё открыта, закрытых нет');

// сейчас 06:00 — ночь закрыта
closed = closedBucketsSince(msk(6, 0), msk(0));
eq(closed.length, 1, '06:00 МСК → одна закрытая (Ночь)');
eq(closed[0].key, 'night', 'закрытая — Ночь');

// сейчас 07:00 (+1 день), from = 05:00 — за 26ч: утро 21-го ещё открыто (end 12:00 > now)
closed = closedBucketsSince(msk(7, 0, 1), msk(5, 0));
eq(closed.length, 4, 'за 26ч: 4 закрытых (утро целевых суток ещё открыто)');
eq(closed[0].key, 'morning', 'первый — Утро (ночь была открыта на from)');
const keys = closed.map((c) => c.key).join(',');
eq(keys, 'morning,day,evening,night', 'порядок через сутки корректен');

// последовательность start: каждый следующий = end предыдущего
let contiguous = true;
for (let i = 1; i < closed.length; i++) {
  if (closed[i].start.getTime() !== closed[i - 1].end.getTime()) contiguous = false;
}
eq(contiguous, true, 'цепочка бакетов непрерывна');

console.log(`\nИтого: ${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
