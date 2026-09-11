/**
 * =============================================================================
 * PULSE — Unit tests для числового вето и рубрик-чёрного списка (ТЗ-92)
 * =============================================================================
 *
 * Run: npx ts-node src/tests/clusteringVeto.test.ts
 *
 * Кейсы из Методологии: сводки ПВО с разными числами (sim до 0.944 — без
 * вето авто-склейка слипала бы разные дни); «топ-3»/«5 причин» — ложная
 * склейка по мелким числам; дайджесты не участвуют в склейке.
 */

import { numericVeto, isRubricTitle, significantNumbers } from '../services/clustering';

interface TestCase {
  name: string;
  got: unknown;
  want: unknown;
}

const cases: TestCase[] = [
  // significantNumbers
  { name: 'значимые числа: 516 значимо', got: significantNumbers('сбито 516 дронов').has('516'), want: true },
  { name: 'значимые числа: 5 не значимо (длина 1)', got: significantNumbers('5 причин роста').size, want: 0 },
  { name: 'значимые числа: год 2026 исключён', got: significantNumbers('в 2026 году выросли цены').size, want: 0 },
  { name: 'значимые числа: 10 значимо', got: significantNumbers('топ-10 компаний').has('10'), want: true },

  // numericVeto (true = пара отброшена)
  { name: 'вето: 516 дронов ≠ 130 дронов', got: numericVeto('сбито 516 дронов', 'сбито 130 дронов'), want: true },
  { name: 'вето: разные дни сводок 12 vs 13 сентября', got: numericVeto('сводка на 12 сентября', 'сводка на 13 сентября'), want: true },
  { name: 'нет вето: одинаковое число (516 = 516)', got: numericVeto('сбито 516 дронов', 'утром сбили 516 дронов'), want: false },
  { name: 'нет вето: число есть только у одного', got: numericVeto('сбито 516 дронов', 'сбили дроны'), want: false },
  { name: 'нет вето: оба без значимых чисел', got: numericVeto('закрылся пролив', 'пролив закрыт'), want: false },
  { name: 'нет вето: топ-3 vs 5 причин (мелкие числа игнор)', got: numericVeto('топ-3 новости', '5 причин роста'), want: false },

  // isRubricTitle
  { name: 'рубрика: «Что случилось этой ночью»', got: isRubricTitle('Что случилось этой ночью в мире'), want: true },
  { name: 'рубрика: «Итоги торгов»', got: isRubricTitle('Итоги торгов на Мосбирже'), want: true },
  { name: 'рубрика: «Курсы валют на …»', got: isRubricTitle('Курсы валют на 12 сентября'), want: true },
  { name: 'рубрика: с эмодзи-префиксом', got: isRubricTitle('⚠️❗️ Что случилось этой ночью'), want: true },
  { name: 'не рубрика: обычная новость', got: isRubricTitle('Сбер отчитался о рекордной прибыли'), want: false },
];

let failed = 0;
for (const c of cases) {
  const ok = JSON.stringify(c.got) === JSON.stringify(c.want);
  if (!ok) failed++;
  console.log(`${ok ? '✅' : '❌'} ${c.name} — got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`);
}
console.log(`\nTotal: ${cases.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
