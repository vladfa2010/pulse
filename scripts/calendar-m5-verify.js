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
process.env.KIMI_API_KEY = 'test-kimi-key';
process.env.KIMI_MODEL = 'moonshot-v1-32k';
process.env.VAPID_PUBLIC_KEY = 'BJxHf6RkzS4y2p9qQ8v1mN0oL3uT5wY7aB9cD1eF2gH3iJ4kL5mN6oP7qR8sT9uV0wX1yZ2aB3cD4eF5gH6iJ7k';
process.env.VAPID_PRIVATE_KEY = 'cE0w5k8mX2p9qR4sT7uV0wY3aB6cD9fG1hI4jK7lM0nO3pQ6rS9tV2wX5yZ8aB1c';
process.env.TELEGRAM_BOT_TOKEN = 'test:token12345';

const fs = require('fs');
const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');
const { execSync } = require('child_process');

const distDir = path.join(__dirname, '..', 'dist');

let llmCallCount = 0;

// Подменяем axios.post до загрузки модулей: Telegram — ok, Moonshot — мок.
const axios = require('axios');
axios.post = async (url, data, config) => {
  if (typeof url === 'string' && url.includes('moonshot')) {
    llmCallCount++;
    const messages = data && data.messages ? data.messages : [];
    const prompt = messages.length > 0 ? messages[messages.length - 1].content || '' : '';
    if (prompt.includes('Лукойл') || prompt.includes('lukoil')) {
      return { data: { choices: [{ message: { content: '["lkoh"]' } }] } };
    }
    return { data: { choices: [{ message: { content: '[]' } }] } };
  }
  return { data: { ok: true, result: { message_id: 1 } } };
};

const { initSQLite, initSQLiteSchema } = require(path.join(distDir, 'config', 'db-sqlite.js'));
const { query } = require(path.join(distDir, 'config', 'db.js'));
const { runCalendarV2Migrations, getMskDateString, rebuildCanonical } = require(path.join(distDir, 'services', 'calendar.js'));
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
    matched_via TEXT,
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

  // Убираем шум из-за отсутствия таблиц тегов в SQLite-harness
  await query(`CREATE TABLE IF NOT EXISTS user_defined_tags (
    tag_id TEXT PRIMARY KEY,
    tag_name TEXT NOT NULL,
    tag_type TEXT DEFAULT 'company',
    keywords TEXT,
    enriched_data TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  await query(`CREATE TABLE IF NOT EXISTS smart_tag_cache (
    text_hash TEXT PRIMARY KEY,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // admin-пользователь для прохождения adminMiddleware
  await query(
    `INSERT INTO users (id, email, username, password_hash, is_admin)
     VALUES ('admin1', 'admin@test', 'admin', 'x', 1)`
  );

  await seedTags();
}

async function seedTags() {
  await query(`DELETE FROM user_defined_tags`);
  await query(`DELETE FROM smart_tag_cache`);

  // Тег «цб» с обогащением: синонимы позволяют матчить без ручного словаря.
  const cbEnriched = JSON.stringify({
    tag_type: 'sector',
    synonyms_ru: ['Центральный банк', 'Банк России'],
    synonyms_en: ['Central Bank of Russia'],
    key_products: [],
    related_entities: [],
  });
  await query(
    `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords, enriched_data, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['цб', 'Центральный банк', 'sector', '[]', cbEnriched, 'admin1']
  );

  // Тег «lkoh» без обогащения: только тикер как keyword, поэтому "Лукойл" по имени
  // не сматчится на keyword и уйдёт в LLM-фолбэк.
  await query(
    `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords, enriched_data, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ['lkoh', 'Лукойл', 'company', JSON.stringify(['lkoh']), null, 'admin1']
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
      agent: new http.Agent({ keepAlive: false }),
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
    assert(tombstones.rows[0].tombstone_key === `${oldDate}|${oldTicker.toUpperCase()}`, 'test3: tombstone_key should match stable canonical key');
    assert(tombstones.rows[0].original_title === oldTitle, 'test3: original_title should be preserved');
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
      (e) => e.date === dupDate && e.title === dupTitle
    );
    assert(dupTombstone, 'test6: tombstone should appear in tombstones list');
    assert(dupTombstone.kind === dupEvent.kind, `test6: tombstone kind should be ${dupEvent.kind}`);
    assert(dupTombstone.companies.length === 1, 'test6: tombstone should have one company');
    assert(dupTombstone.companies[0].ticker === '__deleted__', 'test6: tombstone company ticker should be __deleted__');
    assert(dupTombstone.deleted_ticker === dupTicker, `test6: deleted_ticker should be ${dupTicker}, got ${dupTombstone.deleted_ticker}`);

    // Restore must use the deleted_ticker exposed by the list, not external knowledge.
    const restoreRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/tombstone?date=${encodeURIComponent(dupDate)}&title=${encodeURIComponent(dupTombstone.deleted_ticker)}&company=${encodeURIComponent(dupCompany)}&original_title=${encodeURIComponent(dupTitle)}`
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
    assert(unknownTombstone.rows[0].tombstone_key === `${unknownDate}|n:${unknownCompany.toLowerCase()}`, 'test7: UNKNOWN tombstone_key should use normalized company fallback');
    assert(unknownTombstone.rows[0].original_title === unknownTitle, 'test7: UNKNOWN original_title should be preserved');

    // Frontend sends the company name as title for UNKNOWN tombstones because the
    // tombstones list displays title = company. Restore must fall back to the
    // company-keyed tombstone when the title-as-ticker lookup deletes 0 rows.
    const restoreUnknownRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/tombstone?date=${encodeURIComponent(unknownDate)}&title=${encodeURIComponent(unknownCompany)}&company=${encodeURIComponent(unknownCompany)}&original_title=${encodeURIComponent(unknownTitle)}`
    );
    assert(restoreUnknownRes.status === 200, `test7: UNKNOWN restore should return 200, got ${restoreUnknownRes.status}`);

    const unknownRestored = await query(
      `SELECT * FROM calendar_events WHERE title = $1 AND company = $2`,
      [unknownTitle, unknownCompany]
    );
    assert(unknownRestored.rows.length > 0, 'test7: UNKNOWN event should be restored to canonical');
    console.log('[m5] test7 passed: UNKNOWN-ticker delete uses company fallback key and restores correctly');

    // === Test 8: Bug C — restore disambiguates multiple tombstones with same key by original_title ===
    await query(`DELETE FROM calendar_events_raw WHERE source = 'manual' AND ticker = '__deleted__'`);
    const bugCDate = serverDate;
    const bugCWeekday = 'пн';
    const bugCCompany = 'Shared Co';
    const bugCTitle1 = 'Event One';
    const bugCTitle2 = 'Event Two';
    const bugCKey = `${bugCDate}|n:${bugCCompany.toLowerCase()}`;
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at, tombstone_key, original_title)
       VALUES ('manual', $1, $2, '', 'Другое', 'expected', $3, '__deleted__', datetime('now'), $4, $5)`,
      [bugCDate, bugCWeekday, bugCCompany, bugCKey, bugCTitle1]
    );
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at, tombstone_key, original_title)
       VALUES ('manual', $1, $2, '', 'Другое', 'expected', $3, '__deleted__', datetime('now'), $4, $5)`,
      [bugCDate, bugCWeekday, bugCCompany, bugCKey, bugCTitle2]
    );
    await rebuildCanonical();

    const restoreBugC = await request(
      server,
      'DELETE',
      `${base}/calendar/events/tombstone?date=${encodeURIComponent(bugCDate)}&title=&company=${encodeURIComponent(bugCCompany)}&original_title=${encodeURIComponent(bugCTitle1)}`
    );
    assert(restoreBugC.status === 200, `test8: restore by original_title should return 200, got ${restoreBugC.status}`);

    const remainingTombstones = await query(
      `SELECT * FROM calendar_events_raw WHERE source = 'manual' AND ticker = '__deleted__' AND tombstone_key = $1 ORDER BY original_title`,
      [bugCKey]
    );
    assert(remainingTombstones.rows.length === 1, `test8: exactly one tombstone should remain, got ${remainingTombstones.rows.length}`);
    assert(remainingTombstones.rows[0].original_title === bugCTitle2, 'test8: remaining tombstone should be the other event');
    console.log('[m5] test8 passed: restore disambiguates tombstones by original_title');

    // === Test 9: CRUD create calls LLM for new text; tag matched via llm ===
    await query(`DELETE FROM calendar_events_raw`);
    await query(`DELETE FROM calendar_events`);
    await query(`DELETE FROM calendar_sources`);
    await query(`DELETE FROM calendar_meta`);
    await query(`DELETE FROM smart_tag_cache`);
    llmCallCount = 0;

    const uniqueTitle = 'Отчёт LLM Cache Test Лукойла';
    const uniqueBody = {
      date: serverDate,
      weekday: 'пн',
      title: uniqueTitle,
      kind: 'МСФО',
      status: 'expected',
      companies: [{ name: 'ПАО Лукойл', ticker: 'UNKNOWN' }],
    };
    const createUniqueRes = await request(server, 'POST', `${base}/calendar/events`, uniqueBody);
    assert(createUniqueRes.status === 200, `test9: create unique event should return 200, got ${createUniqueRes.status}`);

    const uniqueRow = await query(`SELECT * FROM calendar_events WHERE title = $1`, [uniqueTitle]);
    assert(uniqueRow.rows.length === 1, 'test9: unique canonical row should exist');
    assert(JSON.parse(uniqueRow.rows[0].tag_ids || '[]').includes('lkoh'), `test9: tag_ids should include lkoh, got ${uniqueRow.rows[0].tag_ids}`);
    assert(uniqueRow.rows[0].matched_via === 'llm', `test9: matched_via should be llm, got ${uniqueRow.rows[0].matched_via}`);
    assert(llmCallCount === 1, `test9: LLM should be called once for new text, calls=${llmCallCount}`);
    console.log('[m5] test9 passed: CRUD create triggers LLM for new text');

    // === Test 10: delete then restore same event → LLM not called (cache) ===
    const deleteUniqueRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/${encodeURIComponent(serverDate)}/${encodeURIComponent(uniqueTitle)}/${encodeURIComponent('МСФО')}`
    );
    assert(deleteUniqueRes.status === 200, `test10: delete unique event should return 200, got ${deleteUniqueRes.status}`);

    // For UNKNOWN-ticker tombstones the list exposes title = company and deleted_ticker = ''.
    const restoreList = await request(server, 'GET', `${base}/calendar/events?tombstones=true`);
    assert(restoreList.status === 200, `test10: tombstones list should return 200, got ${restoreList.status}`);
    const uniqueTombstone = restoreList.body.events.find(
      (e) => e.date === serverDate && e.original_title === uniqueTitle
    );
    assert(uniqueTombstone, 'test10: unique tombstone should appear in list');

    llmCallCount = 0;
    const restoreUniqueRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/tombstone?date=${encodeURIComponent(serverDate)}&title=${encodeURIComponent(uniqueTombstone.companies[0].name)}&company=${encodeURIComponent(uniqueTombstone.companies[0].name)}&original_title=${encodeURIComponent(uniqueTitle)}`
    );
    assert(restoreUniqueRes.status === 200, `test10: restore unique event should return 200, got ${restoreUniqueRes.status}`);

    const restoreRow = await query(`SELECT * FROM calendar_events WHERE title = $1`, [uniqueTitle]);
    assert(restoreRow.rows.length === 1, 'test10: restored canonical row should exist');
    assert(JSON.parse(restoreRow.rows[0].tag_ids || '[]').includes('lkoh'), `test10: tag_ids should include lkoh, got ${restoreRow.rows[0].tag_ids}`);
    assert(restoreRow.rows[0].matched_via === 'llm', `test10: matched_via should be llm, got ${restoreRow.rows[0].matched_via}`);
    assert(llmCallCount === 0, `test10: LLM should not be called for cached text, calls=${llmCallCount}`);
    console.log('[m5] test10 passed: CRUD restore uses LLM cache');

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
