/**
 * =============================================================================
 * PULSE — ТЗ-170: кракозябра в именах загружаемых файлов (UTF-8 → Latin-1)
 * =============================================================================
 *
 * Чистый юнит-прогон: без HTTP и БД.
 *
 * Проверяет decodeUploadName:
 *   1. Mojibake («ÐÐ´Ð¸Ð½Ð°Ñ...») → перекодировка в читаемый UTF-8.
 *   2. ASCII-имена не трогаются.
 *   3. Пустая строка — как есть.
 *   4. Корректная кириллица (без Latin-1 диапазона) — не трогается.
 *   5. Легальный Latin-1 («résumé.pdf») с невалидной перекодировкой —
 *      guard на replacement-char возвращает исходник.
 *
 * Запуск:  npx ts-node src/tests/uploadFilename.test.ts
 */

import { decodeUploadName } from '../utils/filename';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
}

// Mojibake — то, что реально отдаёт multer для UTF-8 имени из браузера
const mojibake = Buffer.from('Вечерняя торговая сессия MOEX.pdf', 'utf8').toString('latin1');

console.log('ТЗ-170 decodeUploadName:');

check('mojibake → читаемое имя',
  decodeUploadName(mojibake), 'Вечерняя торговая сессия MOEX.pdf');
check('ASCII без изменений',
  decodeUploadName('report.pdf'), 'report.pdf');
check('пустая строка без изменений',
  decodeUploadName(''), '');
check('корректная кириллица не трогается',
  decodeUploadName('Отчёт за сентябрь.pdf'), 'Отчёт за сентябрь.pdf');
check('легальный Latin-1 с невалидной перекодировкой — исходник (guard на �)',
  decodeUploadName('résumé.pdf'), 'résumé.pdf');

console.log(`\nИтого: ${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
