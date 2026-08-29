process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = '/tmp/calendar_m1_verify.db';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef12345678';
process.env.CRON_SECRET_KEY = 'test-cron-secret';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.OPENAI_API_KEY = 'test-openai';
process.env.VAPID_PUBLIC_KEY = 'BJxHf6RkzS4y2p9qQ8v1mN0oL3uT5wY7aB9cD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0wX1yZ2aB3cD4eF5gH6iJ7k';
process.env.VAPID_PRIVATE_KEY = 'cE0w5k8mX2p9qR4sT7uV0wY3aB6cD9fG1hI4jK7lM0nO3pQ6rS9tV2wX5yZ8aB1c';

const fs = require('fs');
const path = require('path');
const distDir = path.join(__dirname, '..', 'dist');
const { initSQLite, initSQLiteSchema } = require(path.join(distDir, 'config', 'db-sqlite.js'));
const { query } = require(path.join(distDir, 'config', 'db.js'));
const {
  runCalendarV2Migrations,
  saveCalendarSnapshot,
  mergeCalendarSnapshot,
  createCalendarEventGroup,
  updateCalendarEventGroup,
  deleteCalendarEventGroup,
  getCalendarEventGroup,
} = require(path.join(distDir, 'services', 'calendar.js'));

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function setup() {
  if (fs.existsSync('/tmp/calendar_m1_verify.db')) fs.unlinkSync('/tmp/calendar_m1_verify.db');
  await initSQLite();
  await initSQLiteSchema();
  await query(`CREATE TABLE IF NOT EXISTS calendar_events (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    date DATE NOT NULL,
    weekday VARCHAR(2) NOT NULL,
    title TEXT NOT NULL,
    kind VARCHAR(10) NOT NULL,
    status VARCHAR(10) NOT NULL,
    company VARCHAR(100) NOT NULL,
    ticker VARCHAR(10) NOT NULL,
    uploaded_at TIMESTAMP DEFAULT (datetime('now')),
    sources TEXT,
    possible_duplicate INTEGER DEFAULT 0,
    tag_ids TEXT,
    UNIQUE (date, title, kind, ticker)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date)`);
  await query(`CREATE TABLE IF NOT EXISTS calendar_events_raw (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    source VARCHAR(20) NOT NULL,
    date DATE NOT NULL,
    weekday VARCHAR(2) NOT NULL,
    title TEXT NOT NULL,
    kind VARCHAR(10) NOT NULL,
    status VARCHAR(10) NOT NULL,
    company VARCHAR(100) NOT NULL,
    ticker VARCHAR(10) NOT NULL,
    uploaded_at TIMESTAMP DEFAULT (datetime('now'))
  )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cal_raw_source ON calendar_events_raw(source)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_cal_raw_key ON calendar_events_raw(date, ticker)`);
  await query(`CREATE TABLE IF NOT EXISTS calendar_sources (source VARCHAR(20) PRIMARY KEY, uploaded_at TIMESTAMP, last_stale_alert_at TIMESTAMP)`);
  await query(`CREATE TABLE IF NOT EXISTS calendar_meta (id INTEGER PRIMARY KEY CHECK (id = 1), uploaded_at TIMESTAMP DEFAULT (datetime('now')), last_stale_alert_at TIMESTAMP)`);
  await runCalendarV2Migrations();
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
    let updated = await getCalendarEventGroup('2026-09-02', 'Ручное событие обновл', 'СД');
    assert(updated && updated.companies.length === 2, 'updated manual event should have 2 companies');

    // Test 6: delete raw group removes from canonical and does not resurrect on next merge/rebuild
    await deleteCalendarEventGroup('2026-09-02', 'Ручное событие обновл', 'СД');
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
