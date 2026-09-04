/**
 * DB TZ Verify — регрессионная проверка работы с датами в двух таймзонах.
 *
 * История: normalizeDbDate() читала UTC-геттеры, а pg парсит колонку DATE
 * как ЛОКАЛЬНУЮ полночь → в TZ восточнее UTC даты календаря сдвигались
 * на −1 день при пересборке канона (поймано PG-стендом 2026-09-05).
 * На проде (TZ=UTC) баг не проявлялся — поэтому тест гоняет обе TZ.
 *
 * Механика: родительский процесс дважды форкает себя с TZ=UTC и
 * TZ=Asia/Yekaterinburg (+05), дочерние печатают JSON результатов,
 * родитель сравнивает их между собой и с эталоном.
 *
 * Запуск: node scripts/db-tz-verify.js
 */

const { fork } = require('child_process');

const TIMEZONES = ['UTC', 'Asia/Yekaterinburg'];

if (process.env.TZ_VERIFY_CHILD === '1') {
  // ─── Дочерний процесс: считаем значения в текущей TZ ───
  process.env.USE_SQLITE = 'true'; // никакой сети/БД — только pure-функции
  const { normalizeDbDate } = require('../dist/services/calendar.js');

  const out = {
    tz: process.env.TZ,
    // pg отдаёт DATE как локальную полночь — эмулируем конструктором локальной даты
    dateLocalMidnight: normalizeDbDate(new Date(2026, 7, 5, 0, 0, 0)),
    // строка проходит как есть в обеих СУБД
    dateString: normalizeDbDate('2026-08-05'),
    // крайний случай: смена месяца
    dateMonthEdge: normalizeDbDate(new Date(2026, 7, 1, 0, 0, 0)),
    // конец года
    dateYearEdge: normalizeDbDate(new Date(2026, 11, 31, 0, 0, 0)),
  };
  console.log(JSON.stringify(out));
  process.exit(0);
}

// ─── Родительский процесс ───
function runChild(tz) {
  return new Promise((resolve, reject) => {
    const child = fork(__filename, [], {
      env: { ...process.env, TZ: tz, TZ_VERIFY_CHILD: '1' },
      silent: true,
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) return reject(new Error(`child ${tz} exited with ${code}`));
      const line = stdout.trim().split('\n').pop();
      try {
        resolve(JSON.parse(line));
      } catch (e) {
        reject(new Error(`child ${tz} bad output: ${line}`));
      }
    });
  });
}

function fail(msg) {
  console.error(`[TZ VERIFY] FAILED: ${msg}`);
  process.exit(1);
}

async function main() {
  const results = [];
  for (const tz of TIMEZONES) {
    const r = await runChild(tz);
    results.push(r);
    console.log(`[TZ VERIFY] ${tz}:`, JSON.stringify(r));
  }

  const [utc, local] = results;

  // 1. Паритет между TZ: одни и те же входы дают одни и те же строки
  for (const key of ['dateLocalMidnight', 'dateString', 'dateMonthEdge', 'dateYearEdge']) {
    if (utc[key] !== local[key]) {
      fail(`${key}: TZ mismatch — UTC=${utc[key]} ${local.tz}=${local[key]}`);
    }
  }
  console.log('[TZ VERIFY] parity UTC vs +05 OK');

  // 2. Эталонные значения
  const expected = {
    dateLocalMidnight: '2026-08-05',
    dateString: '2026-08-05',
    dateMonthEdge: '2026-08-01',
    dateYearEdge: '2026-12-31',
  };
  for (const [k, v] of Object.entries(expected)) {
    if (utc[k] !== v || local[k] !== v) {
      fail(`${k}: expected ${v}, got UTC=${utc[k]} ${local.tz}=${local[k]}`);
    }
  }
  console.log('[TZ VERIFY] reference values OK');

  console.log('\n[TZ VERIFY] ALL TESTS PASSED');
  process.exit(0);
}

main().catch(e => fail(e.message));
