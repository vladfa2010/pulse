/**
 * Verify-скрипт для ТЗ M5: Редактор и ручной срез.
 * Запуск: npm run verify:calendarM5
 */

process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = '/tmp/calendar_m5_verify.db';
process.env.ENCRYPTION_KEY = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef12345678';
process.env.CRON_SECRET_KEY = 'test-cron-secret';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.OPENAI_API_KEY = 'test-openai';
process.env.VAPID_PUBLIC_KEY = 'BJxHf6RkzS4y2p9qQ8v1mN0oL3uT5wY7aB9cD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0wX1yZ2aB3cD4eF5gH6iJ7k';
process.env.VAPID_PRIVATE_KEY = 'cE0w5k8mX2p9qR4sT7uV0wY3aB6cD9fG1hI4jK7lM0nO3pQ6rS9tV2wX5yZ8aB1c';
process.env.TELEGRAM_BOT_TOKEN = 'test:token12345';

const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, '..', 'dist');

// Подменяем axios.post до загрузки модулей, чтобы Telegram-алерты "отправлялись" без сети.
const axios = require('axios');
axios.post = async () => ({ data: { ok: true, result: { message_id: 1 } } });

const { initSQLite, initSQLiteSchema } = require(path.join(distDir, 'config', 'db-sqlite.js'));
const { query } = require(path.join(distDir, 'config', 'db.js'));
const { runCalendarV2Migrations, getMskDateString } = require(path.join(distDir, 'services', 'calendar.js'));
const adminRouter = require(path.join(distDir, 'routes', 'admin.js')).default;
const express = require('express');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function setup() {
  if (fs.existsSync('/tmp/calendar_m5_verify.db')) fs.unlinkSync('/tmp/calendar_m5_verify.db');
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
  await query(`CREATE TABLE IF NOT EXISTS calendar_sources (source VARCHAR(20) PRIMARY KEY, uploaded_at TIMESTAMP, last_stale_alert_at TIMESTAMP, last_warnings TEXT)`);
  await query(`CREATE TABLE IF NOT EXISTS calendar_meta (id INTEGER PRIMARY KEY CHECK (id = 1), uploaded_at TIMESTAMP DEFAULT (datetime('now')), last_stale_alert_at TIMESTAMP)`);
  await runCalendarV2Migrations();

  // admin-пользователь для прохождения adminMiddleware
  await query(
    `INSERT INTO users (id, email, username, password_hash, is_admin)
     VALUES ('admin1', 'admin@test', 'admin', 'x', 1)`
  );
}

function createToken(userId) {
  return jwt.sign({ userId, email: 'admin@test' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin', adminRouter);
  return app;
}

async function request(server, method, path, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + createToken('admin1'),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        if (data) {
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function readFixture(name) {
  const fixturesDir = path.join(__dirname, '..', 'tests', 'calendarAdapters', 'fixtures');
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

async function loadInvestmint(server, base) {
  const investRaw = readFixture('investmint.json');
  const investPost = await request(server, 'POST', `${base}/calendar/investmint`, investRaw);
  assert(investPost.status === 200, 'investmint POST should return 200');
}

async function findCanonicalEvent(ticker, title, kind) {
  const result = await query(
    `SELECT * FROM calendar_events WHERE ticker = $1 AND title = $2 AND kind = $3`,
    [ticker, title, kind]
  );
  return result.rows[0] || null;
}

async function findRawEvent(source, ticker, title, kind) {
  const result = await query(
    `SELECT * FROM calendar_events_raw WHERE source = $1 AND ticker = $2 AND title = $3 AND kind = $4`,
    [source, ticker, title, kind]
  );
  return result.rows[0] || null;
}

async function main() {
  try {
    await setup();
    const app = createApp();
    const server = app.listen(0);
    const base = '/api/admin';

    const serverDate = await getMskDateString();
    console.log(`[m5] serverDate=${serverDate}`);

    // === Test 1: create manual override; provider raw untouched; manual wins in canonical ===
    await loadInvestmint(server, base);

    // Pick a provider event with expected status to override.
    const providerEvent = await query(
      `SELECT date, weekday, title, kind, status, company, ticker FROM calendar_events WHERE status = 'expected' LIMIT 1`
    );
    assert(providerEvent.rows.length > 0, 'test1: need at least one expected provider canonical event');
    const pe = providerEvent.rows[0];

    const overrideBody = {
      date: pe.date,
      weekday: pe.weekday,
      title: pe.title,
      kind: pe.kind,
      status: 'confirmed', // change status
      companies: [{ name: pe.company, ticker: pe.ticker }],
    };
    const createRes = await request(server, 'POST', `${base}/calendar/events`, overrideBody);
    assert(createRes.status === 200, `test1: create override should return 200, got ${createRes.status}`);

    const providerRawAfter = await query(
      `SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'investmint' AND ticker = $1 AND title = $2`,
      [pe.ticker, pe.title]
    );
    assert(Number(providerRawAfter.rows[0].c) > 0, 'test1: provider raw rows must remain untouched');

    const manualRawCount = await query(
      `SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'manual' AND title = $1 AND kind = $2`,
      [pe.title, pe.kind]
    );
    assert(Number(manualRawCount.rows[0].c) > 0, 'test1: manual raw rows should exist');

    const canonicalAfter = await findCanonicalEvent(pe.ticker, pe.title, pe.kind);
    assert(canonicalAfter, 'test1: canonical event should exist after override');
    assert(canonicalAfter.status === 'confirmed', `test1: manual status should win, got ${canonicalAfter.status}`);
    const sources = JSON.parse(canonicalAfter.sources || '[]');
    assert(sources.includes('manual'), 'test1: canonical sources should include manual');
    console.log('[m5] test1 passed: manual override wins, provider raw untouched');

    // === Test 2: update status without key change; provider raw untouched ===
    const updateStatusBody = {
      date: pe.date,
      weekday: pe.weekday,
      title: pe.title,
      kind: pe.kind,
      status: 'expected',
      companies: [{ name: pe.company, ticker: pe.ticker }],
    };
    const updateStatusRes = await request(
      server,
      'PUT',
      `${base}/calendar/events/${encodeURIComponent(pe.date)}/${encodeURIComponent(pe.title)}/${encodeURIComponent(pe.kind)}`,
      updateStatusBody
    );
    assert(updateStatusRes.status === 200, `test2: status update should return 200, got ${updateStatusRes.status}`);

    const providerRawAfter2 = await query(
      `SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'investmint' AND ticker = $1 AND title = $2`,
      [pe.ticker, pe.title]
    );
    assert(Number(providerRawAfter2.rows[0].c) === Number(providerRawAfter.rows[0].c), 'test2: provider raw rows must remain untouched');

    const canonicalAfter2 = await findCanonicalEvent(pe.ticker, pe.title, pe.kind);
    assert(canonicalAfter2.status === 'expected', `test2: updated status should be expected, got ${canonicalAfter2.status}`);
    console.log('[m5] test2 passed: status update without key change');

    // === Test 3: update title/ticker; old key tombstoned; canonical has only new event ===
    const oldTicker = pe.ticker;
    const oldTitle = pe.title;
    const oldDate = pe.date;
    const oldKind = pe.kind;
    const newTicker = 'NEWTK';
    const newTitle = 'New Manual Title';
    const updateKeyBody = {
      date: oldDate,
      weekday: pe.weekday,
      title: newTitle,
      kind: oldKind,
      status: 'expected',
      companies: [{ name: 'New Company', ticker: newTicker }],
    };
    const updateKeyRes = await request(
      server,
      'PUT',
      `${base}/calendar/events/${encodeURIComponent(oldDate)}/${encodeURIComponent(oldTitle)}/${encodeURIComponent(oldKind)}`,
      updateKeyBody
    );
    assert(updateKeyRes.status === 200, `test3: key change update should return 200, got ${updateKeyRes.status}`);

    const oldCanonical = await findCanonicalEvent(oldTicker, oldTitle, oldKind);
    assert(!oldCanonical, 'test3: old key should be removed from canonical');

    const newCanonical = await findCanonicalEvent(newTicker, newTitle, oldKind);
    assert(newCanonical, 'test3: new key should appear in canonical');

    const tombstones = await query(
      `SELECT * FROM calendar_events_raw WHERE source = 'manual' AND ticker = '__deleted__' AND date = $1 AND title = $2`,
      [oldDate, oldTicker]
    );
    assert(tombstones.rows.length > 0, 'test3: tombstone row should exist for old key');
    console.log('[m5] test3 passed: key change creates tombstone, canonical has only new event');

    // === Test 4: delete event; it disappears from canonical; reloading provider file does NOT resurrect it ===
    const deleteTarget = newCanonical;
    const deleteRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/${encodeURIComponent(deleteTarget.date)}/${encodeURIComponent(deleteTarget.title)}/${encodeURIComponent(deleteTarget.kind)}`
    );
    assert(deleteRes.status === 200, `test4: delete should return 200, got ${deleteRes.status}`);

    const canonicalAfterDelete = await findCanonicalEvent(newTicker, newTitle, oldKind);
    assert(!canonicalAfterDelete, 'test4: deleted event should disappear from canonical');

    // Reload investmint: the deleted event must not resurrect.
    await loadInvestmint(server, base);
    const canonicalAfterReload = await findCanonicalEvent(newTicker, newTitle, oldKind);
    assert(!canonicalAfterReload, 'test4: deleted event should not resurrect after provider reload');
    console.log('[m5] test4 passed: delete prevents resurrection after provider reload');

    // === Test 5: delete possible_duplicate event; both pair rows removed from canonical ===
    // Reset and create a possible duplicate: same ticker/company with two kinds from one provider.
    await query(`DELETE FROM calendar_events_raw`);
    await query(`DELETE FROM calendar_events`);
    await query(`DELETE FROM calendar_sources`);
    await query(`DELETE FROM calendar_meta`);

    const dupDate = serverDate;
    const dupWeekday = 'пн';
    const dupTicker = 'DUPTK';
    const dupCompany = 'Dup Company';
    const dupTitle = 'Dup Event';
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('investmint', $1, $2, $3, 'МСФО', 'expected', $4, $5, datetime('now'))`,
      [dupDate, dupWeekday, dupTitle, dupCompany, dupTicker]
    );
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('investmint', $1, $2, $3, 'РСБУ', 'expected', $4, $5, datetime('now'))`,
      [dupDate, dupWeekday, dupTitle, dupCompany, dupTicker]
    );
    await query(
      `INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at, last_warnings)
       VALUES ('investmint', datetime('now'), NULL, '[]')
       ON CONFLICT (source) DO UPDATE SET uploaded_at = datetime('now')`
    );
    const { rebuildCanonical } = require(path.join(distDir, 'services', 'calendar.js'));
    await rebuildCanonical();

    const dupRowsBefore = await query(
      `SELECT COUNT(*) as c FROM calendar_events WHERE ticker = $1`,
      [dupTicker]
    );
    assert(Number(dupRowsBefore.rows[0].c) === 2, `test5: expected 2 possible_duplicate rows, got ${dupRowsBefore.rows[0].c}`);

    const dupAdmin = await query(
      `SELECT date, title, kind FROM calendar_events WHERE ticker = $1 AND possible_duplicate = 1 LIMIT 1`,
      [dupTicker]
    );
    assert(dupAdmin.rows.length > 0, 'test5: need a possible_duplicate admin event');
    const dupEvent = dupAdmin.rows[0];

    const deleteDupRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/${encodeURIComponent(dupEvent.date)}/${encodeURIComponent(dupEvent.title)}/${encodeURIComponent(dupEvent.kind)}`
    );
    assert(deleteDupRes.status === 200, `test5: delete possible_duplicate should return 200, got ${deleteDupRes.status}`);

    const dupRowsAfter = await query(
      `SELECT COUNT(*) as c FROM calendar_events WHERE ticker = $1`,
      [dupTicker]
    );
    assert(Number(dupRowsAfter.rows[0].c) === 0, `test5: both possible_duplicate rows should be removed, got ${dupRowsAfter.rows[0].c}`);
    console.log('[m5] test5 passed: delete possible_duplicate removes both pair rows');

    // === Test 6: ?tombstones=true returns tombstone; restore brings event back ===
    // After test5 we have a tombstone for DUPTK. List tombstones and restore it.
    const tombstonesList = await request(server, 'GET', `${base}/calendar/events?tombstones=true`);
    assert(tombstonesList.status === 200, `test6: tombstones list should return 200, got ${tombstonesList.status}`);
    assert(Array.isArray(tombstonesList.body.events), 'test6: tombstones events should be array');
    const dupTombstone = tombstonesList.body.events.find(
      (e) => e.date === dupDate && e.title === dupTicker
    );
    assert(dupTombstone, 'test6: tombstone should appear in tombstones list');
    assert(dupTombstone.kind === 'Другое', 'test6: tombstone kind should be Другое');
    assert(dupTombstone.companies.length === 1, 'test6: tombstone should have one company');
    assert(dupTombstone.companies[0].ticker === '__deleted__', 'test6: tombstone company ticker should be __deleted__');

    const restoreRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/tombstone?date=${encodeURIComponent(dupDate)}&title=${encodeURIComponent(dupTicker)}&company=${encodeURIComponent(dupCompany)}`
    );
    assert(restoreRes.status === 200, `test6: restore should return 200, got ${restoreRes.status}`);

    const dupRowsAfterRestore = await query(
      `SELECT COUNT(*) as c FROM calendar_events WHERE ticker = $1`,
      [dupTicker]
    );
    assert(Number(dupRowsAfterRestore.rows[0].c) === 2, `test6: restored event should have 2 rows, got ${dupRowsAfterRestore.rows[0].c}`);
    console.log('[m5] test6 passed: tombstones list and restore');

    // === Test 7: delete UNKNOWN-ticker event (fallback company key) works ===
    const unknownDate = serverDate;
    const unknownWeekday = 'пн';
    const unknownCompany = 'Unknown Co';
    const unknownTitle = 'Unknown Event';
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('manual', $1, $2, $3, 'Другое', 'expected', $4, 'UNKNOWN', datetime('now'))`,
      [unknownDate, unknownWeekday, unknownTitle, unknownCompany]
    );
    await rebuildCanonical();

    const unknownBefore = await query(
      `SELECT * FROM calendar_events WHERE title = $1 AND company = $2`,
      [unknownTitle, unknownCompany]
    );
    assert(unknownBefore.rows.length > 0, 'test7: UNKNOWN event should exist before delete');

    const deleteUnknownRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/${encodeURIComponent(unknownDate)}/${encodeURIComponent(unknownTitle)}/${encodeURIComponent('Другое')}`
    );
    assert(deleteUnknownRes.status === 200, `test7: delete UNKNOWN should return 200, got ${deleteUnknownRes.status}`);

    const unknownAfter = await query(
      `SELECT * FROM calendar_events WHERE title = $1 AND company = $2`,
      [unknownTitle, unknownCompany]
    );
    assert(unknownAfter.rows.length === 0, 'test7: UNKNOWN event should disappear from canonical');

    const unknownTombstone = await query(
      `SELECT * FROM calendar_events_raw WHERE source = 'manual' AND ticker = '__deleted__' AND date = $1 AND title = '' AND company = $2`,
      [unknownDate, unknownCompany]
    );
    assert(unknownTombstone.rows.length > 0, 'test7: UNKNOWN tombstone should use empty title + company fallback');
    console.log('[m5] test7 passed: UNKNOWN-ticker delete uses company fallback key');

    server.close();

    // === Regression: M1/M2/M3/M4 verify scripts still pass ===
    console.log('[m5] regression M1...');
    execSync('node scripts/calendar-m1-verify.js', { stdio: 'inherit' });
    console.log('[m5] regression M2...');
    execSync('node scripts/calendar-m2-verify.js', { stdio: 'inherit' });
    console.log('[m5] regression M3...');
    execSync('node scripts/calendar-m3-verify.js', { stdio: 'inherit' });
    console.log('[m5] regression M4...');
    execSync('node scripts/calendar-m4-verify.js', { stdio: 'inherit' });

    console.log('\n[M5 VERIFY] ALL TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('[M5 VERIFY] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
