const { setCommonEnv, setup: setupCalendarEnv } = require('./lib/calendar-verify-env');
setCommonEnv();

const path = require('path');
const distDir = path.join(__dirname, '..', 'dist');

let query;
let saveCalendarSnapshot,
  mergeCalendarSnapshot,
  createCalendarEventGroup,
  updateCalendarEventGroup,
  deleteCalendarEventGroup,
  getCalendarEventGroup,
  flushCanonicalRewrites;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function setup() {
  await setupCalendarEnv();

  const dbModule = require(path.join(distDir, 'config', 'db.js'));
  query = dbModule.query;

  const calendarModule = require(path.join(distDir, 'services', 'calendar.js'));
  saveCalendarSnapshot = calendarModule.saveCalendarSnapshot;
  mergeCalendarSnapshot = calendarModule.mergeCalendarSnapshot;
  createCalendarEventGroup = calendarModule.createCalendarEventGroup;
  updateCalendarEventGroup = calendarModule.updateCalendarEventGroup;
  deleteCalendarEventGroup = calendarModule.deleteCalendarEventGroup;
  getCalendarEventGroup = calendarModule.getCalendarEventGroup;
  flushCanonicalRewrites = calendarModule.flushCanonicalRewrites;

  await query(`CREATE TABLE IF NOT EXISTS smart_tag_cache (
    text_hash TEXT PRIMARY KEY,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

async function main() {
  try {
    await setup();

    // Test 1: save legacy snapshot
    await saveCalendarSnapshot([
      { date: '2026-09-01', weekday: 'вт', groups: [
        { title: 'Отчётность', kind: 'МСФО', status: 'expected', companies: [{ name: 'Сбер', ticker: 'SBER' }] },
        { title: 'Собрание', kind: 'СА', status: 'confirmed', companies: [{ name: 'Лукойл', ticker: 'LKOH' }] },
      ]},
    ]);
    let rows = await query('SELECT date, title, kind, ticker, sources, possible_duplicate FROM calendar_events ORDER BY title');
    assert(rows.rows.length === 2, 'expected 2 canonical rows after legacy save');
    assert(rows.rows.some(r => r.title === 'Отчётность' && r.sources === '["legacy"]'), 'legacy source expected');

    // Test 2: merge adds new companies and new groups
    await mergeCalendarSnapshot([
      { date: '2026-09-01', weekday: 'вт', groups: [
        { title: 'Отчётность', kind: 'МСФО', status: 'expected', companies: [
          { name: 'Сбер', ticker: 'SBER' },
          { name: 'Газпром', ticker: 'GAZP' },
        ]},
        { title: 'Дивиденды', kind: 'Дивиденды', status: 'expected', companies: [{ name: 'Норникель', ticker: 'GMKN' }] },
      ]},
    ]);
    rows = await query('SELECT date, title, kind, ticker, sources, possible_duplicate, status FROM calendar_events ORDER BY title, ticker');
    assert(rows.rows.some(r => r.ticker === 'GAZP'), 'GAZP should be added');
    assert(rows.rows.some(r => r.kind === 'Дивиденды'), 'Дивиденды should exist');
    const sber = rows.rows.find(r => r.ticker === 'SBER');
    assert(sber.sources === '["legacy"]', `expected legacy sources, got ${sber.sources}`);

    // Test 3: fallback confirmed from absorbed Другое upgrades concrete kind
    await mergeCalendarSnapshot([
      { date: '2026-09-01', weekday: 'вт', groups: [
        { title: 'Отчётность', kind: 'Другое', status: 'confirmed', companies: [{ name: 'Сбер', ticker: 'SBER' }] },
      ]},
    ]);
    rows = await query('SELECT * FROM calendar_events WHERE date = $1 AND ticker = $2', ['2026-09-01', 'SBER']);
    const msfo = rows.rows.find(r => r.kind === 'МСФО');
    assert(msfo && msfo.status === 'confirmed', `expected МСФО confirmed after fallback, got ${msfo?.status}`);

    // Test 4: manual CRUD create persists after rebuild
    await createCalendarEventGroup({
      date: '2026-09-02',
      weekday: 'ср',
      title: 'Ручное событие',
      kind: 'СД',
      status: 'expected',
      companies: [{ name: 'Яндекс', ticker: 'YDEX' }],
    });
    await flushCanonicalRewrites();
    let manual = await getCalendarEventGroup('2026-09-02', 'Ручное событие', 'СД');
    assert(manual && manual.companies.some(c => c.ticker === 'YDEX'), 'manual event should exist');

    // Test 5: update raw group survives rebuild
    await updateCalendarEventGroup('2026-09-02', 'Ручное событие', 'СД', {
      date: '2026-09-02',
      weekday: 'ср',
      title: 'Ручное событие обновл',
      kind: 'СД',
      status: 'confirmed',
      companies: [{ name: 'Яндекс', ticker: 'YDEX' }, { name: 'Тинькофф', ticker: 'TCSG' }],
    });
    await flushCanonicalRewrites();
    let updated = await getCalendarEventGroup('2026-09-02', 'Ручное событие обновл', 'СД');
    assert(updated && updated.companies.length === 2, 'updated manual event should have 2 companies');

    // Test 6: delete raw group removes from canonical and does not resurrect on next merge/rebuild
    await deleteCalendarEventGroup('2026-09-02', 'Ручное событие обновл', 'СД');
    await flushCanonicalRewrites();
    const afterDelete = await getCalendarEventGroup('2026-09-02', 'Ручное событие обновл', 'СД');
    assert(!afterDelete, 'deleted event should not exist');
    await mergeCalendarSnapshot([{ date: '2026-09-03', weekday: 'чт', groups: [
      { title: 'Другое событие', kind: 'Другое', status: 'confirmed', companies: [{ name: 'X', ticker: 'UNKNOWN' }] },
    ]}]);
    const afterDelete2 = await getCalendarEventGroup('2026-09-02', 'Ручное событие обновл', 'СД');
    assert(!afterDelete2, 'deleted event should not resurrect after merge');

    // Test 7: possible_duplicate when same ticker has multiple kinds
    await mergeCalendarSnapshot([{ date: '2026-09-04', weekday: 'пт', groups: [
      { title: 'Событие X', kind: 'МСФО', status: 'expected', companies: [{ name: 'A', ticker: 'ABC' }] },
      { title: 'Событие X', kind: 'СД', status: 'expected', companies: [{ name: 'A', ticker: 'ABC' }] },
    ]}]);
    rows = await query('SELECT * FROM calendar_events WHERE date = $1', ['2026-09-04']);
    assert(rows.rows.length === 2, 'expected 2 rows for duplicate kinds');
    assert(rows.rows.every(r => r.possible_duplicate === 1 || r.possible_duplicate === true), 'expected possible_duplicate flag');

    console.log('\n[VERIFY] ALL TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('[VERIFY] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
