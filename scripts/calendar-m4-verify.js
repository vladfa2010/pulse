/**
 * Verify-скрипт для ТЗ M4: Админка мультиисточника.
 * Запуск: npm run verify:calendarM4
 */

process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = '/tmp/calendar_m4_verify.db';
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
  if (fs.existsSync('/tmp/calendar_m4_verify.db')) fs.unlinkSync('/tmp/calendar_m4_verify.db');
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
    uploaded_at TIMESTAMP DEFAULT (datetime('now')),
    tombstone_key TEXT,
    original_title TEXT
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

async function main() {
  try {
    await setup();
    const app = createApp();
    const server = app.listen(0);
    const base = '/api/admin';

    const serverDate = await getMskDateString();
    console.log(`[m4] serverDate=${serverDate}`);

    // === Test 1: GET /sources на пустой базе ===
    const sourcesEmpty = await request(server, 'GET', `${base}/calendar/sources`);
    assert(sourcesEmpty.status === 200, 'test1: /sources should return 200');
    assert(Array.isArray(sourcesEmpty.body), 'test1: /sources should return array');
    const manualEmpty = sourcesEmpty.body.find((s) => s.source === 'manual');
    assert(manualEmpty, 'test1: manual source should exist');
    assert(manualEmpty.feed === false, 'test1: manual feed=false');
    assert(manualEmpty.adapter_ready === false, 'test1: manual adapter_ready=false');
    assert(typeof manualEmpty.days === 'number', 'test1: manual days should be number');
    assert(typeof manualEmpty.events_count === 'number', 'test1: manual events_count should be number');
    assert(Array.isArray(manualEmpty.last_warnings), 'test1: manual last_warnings should be array');
    const bcsMeta = sourcesEmpty.body.find((s) => s.source === 'bcs');
    assert(bcsMeta, 'test1: bcs source should exist');
    assert(bcsMeta.feed === true, 'test1: bcs feed=true');
    assert(bcsMeta.adapter_ready === false, 'test1: bcs adapter_ready=false');
    const globalMeta = sourcesEmpty.body.find((s) => s.source === 'global');
    assert(globalMeta, 'test1: global source should exist');
    assert(globalMeta.feed === true, 'test1: global feed=true');
    assert(globalMeta.adapter_ready === false, 'test1: global adapter_ready=false');
    const investMeta = sourcesEmpty.body.find((s) => s.source === 'investmint');
    assert(investMeta, 'test1: investmint source should exist');
    assert(investMeta.feed === true, 'test1: investmint feed=true');
    assert(investMeta.adapter_ready === true, 'test1: investmint adapter_ready=true');
    console.log('[m4] test1 passed: /sources fields on empty DB');

    // === Test 2: загрузка investmint через POST /:source, проверка parsed.no_ticker/skipped ===
    const investRaw = readFixture('investmint.json');
    const investPost = await request(server, 'POST', `${base}/calendar/investmint`, investRaw);
    assert(investPost.status === 200, 'test2: investmint POST should return 200');
    assert(investPost.body.parsed, 'test2: parsed object should exist');
    assert(typeof investPost.body.parsed.no_ticker === 'number', 'test2: parsed.no_ticker should be number');
    assert(typeof investPost.body.parsed.skipped === 'number', 'test2: parsed.skipped should be number');
    assert(investPost.body.parsed.days > 0, 'test2: parsed.days > 0');
    assert(investPost.body.parsed.events > 0, 'test2: parsed.events > 0');
    console.log('[m4] test2 passed: investmint POST parsed fields', investPost.body.parsed);

    // === Test 3: GET /sources после investmint ===
    const sourcesAfterInvest = await request(server, 'GET', `${base}/calendar/sources`);
    const investSourceAfter = sourcesAfterInvest.body.find((s) => s.source === 'investmint');
    assert(investSourceAfter.events_count > 0, 'test3: investmint events_count > 0');
    assert(investSourceAfter.days > 0, 'test3: investmint days > 0');
    assert(investSourceAfter.uploaded_at, 'test3: investmint uploaded_at set');
    const rawDaysCheck = await query(
      `SELECT COUNT(DISTINCT date) as days FROM calendar_events_raw WHERE source = 'investmint'`
    );
    assert(
      investSourceAfter.days === Number(rawDaysCheck.rows[0].days),
      'test3: days equals COUNT(DISTINCT date)'
    );
    console.log('[m4] test3 passed: /sources days matches DB');

    // === Test 4: GET /events — sources и possible_duplicate ===
    const eventsList = await request(server, 'GET', `${base}/calendar/events`);
    assert(eventsList.status === 200, 'test4: /events should return 200');
    assert(Array.isArray(eventsList.body.events), 'test4: events should be array');
    assert(eventsList.body.total > 0, 'test4: total > 0');
    const eventWithSources = eventsList.body.events.find((e) => Array.isArray(e.sources) && e.sources.length > 0);
    assert(eventWithSources, 'test4: at least one event should have sources');
    assert(
      eventsList.body.events.every((e) => typeof e.possible_duplicate === 'boolean'),
      'test4: every event should have possible_duplicate boolean'
    );
    console.log('[m4] test4 passed: /events sources and possible_duplicate');

    // === Test 5: detail GET /events/:date/:title/:kind companies[].sources ===
    const first = eventWithSources;
    const detail = await request(
      server,
      'GET',
      `${base}/calendar/events/${encodeURIComponent(first.date)}/${encodeURIComponent(first.title)}/${encodeURIComponent(first.kind)}`
    );
    assert(detail.status === 200, 'test5: detail GET should return 200');
    assert(detail.body.event, 'test5: event should exist');
    assert(Array.isArray(detail.body.event.companies), 'test5: companies should be array');
    assert(detail.body.event.companies.length > 0, 'test5: companies not empty');
    assert(
      detail.body.event.companies.every((c) => Array.isArray(c.sources)),
      'test5: every company should have sources array'
    );
    const canonicalSources = detail.body.event.companies.map((c) => c.sources).flat();
    assert(
      canonicalSources.some((s) => first.sources.includes(s)),
      'test5: detail sources overlap with list sources'
    );
    console.log('[m4] test5 passed: detail companies[].sources');

    // === Test 6: ?possible_duplicate=true фильтр ===
    const duplicates = await request(server, 'GET', `${base}/calendar/events?possible_duplicate=true`);
    assert(duplicates.status === 200, 'test6: possible_duplicate filter should return 200');
    assert(
      duplicates.body.events.every((e) => e.possible_duplicate === true),
      'test6: all returned events should be possible duplicates'
    );
    console.log('[m4] test6 passed: possible_duplicate filter');

    // === Test 7: POST на bcs возвращает 400 "источник пока не поддерживается" ===
    const bcsPost = await request(server, 'POST', `${base}/calendar/bcs`, {});
    assert(bcsPost.status === 400, 'test7: bcs POST should return 400');
    assert(bcsPost.body.error === 'источник пока не поддерживается', 'test7: bcs error message mismatch');
    console.log('[m4] test7 passed: bcs POST returns 400');

    // === Test 8: DELETE /sources/investmint возвращает 400 ===
    const deleteInvest = await request(server, 'DELETE', `${base}/calendar/sources/investmint`);
    assert(deleteInvest.status === 400, 'test8: DELETE investmint should return 400');
    console.log('[m4] test8 passed: DELETE investmint returns 400');

    // === Test 9: DELETE /sources/legacy ===
    // Берём одну investmint-каноническую строку для склейки с legacy.
    const investCanonical = await query(
      `SELECT date, weekday, title, kind, company, ticker
       FROM calendar_events
       WHERE sources = '["investmint"]'
       LIMIT 1`
    );
    assert(investCanonical.rows.length > 0, 'test9: need at least one investmint-only canonical row');
    const merged = investCanonical.rows[0];

    // Создаём legacy-строку, которая склеится с investmint, и отдельную legacy-группу.
    const legacyRows = [
      {
        source: 'legacy',
        date: merged.date,
        weekday: merged.weekday,
        title: merged.title,
        kind: merged.kind,
        status: 'expected',
        company: merged.company,
        ticker: merged.ticker,
      },
      {
        source: 'legacy',
        date: '2026-09-02',
        weekday: 'ср',
        title: 'Legacy Only Event',
        kind: 'Другое',
        status: 'confirmed',
        company: 'Only Legacy',
        ticker: 'LEGACY',
      },
    ];
    for (const row of legacyRows) {
      await query(
        `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, datetime('now'))`,
        [row.source, row.date, row.weekday, row.title, row.kind, row.status, row.company, row.ticker]
      );
    }
    await query(
      `INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at, last_warnings)
       VALUES ('legacy', datetime('now'), NULL, '[]')
       ON CONFLICT (source) DO UPDATE SET uploaded_at = datetime('now')`
    );

    // Пересобираем канон с legacy, чтобы diff показал удаление
    const { rebuildCanonical } = require(path.join(distDir, 'services', 'calendar.js'));
    await rebuildCanonical();

    const legacyCountBefore = await query(`SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'legacy'`);
    assert(Number(legacyCountBefore.rows[0].c) === 2, 'test9: expected 2 legacy raw rows before delete');

    const deleteLegacy = await request(server, 'DELETE', `${base}/calendar/sources/legacy`);
    assert(deleteLegacy.status === 200, 'test9: DELETE legacy should return 200');
    assert(typeof deleteLegacy.body.removed_events === 'number', 'test9: removed_events should be number');
    assert(deleteLegacy.body.removed_events === 1, `test9: expected removed_events=1, got ${deleteLegacy.body.removed_events}`);

    const legacyCountAfter = await query(`SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'legacy'`);
    assert(Number(legacyCountAfter.rows[0].c) === 0, 'test9: legacy raw rows should be removed');
    const legacySourceAfter = await query(`SELECT COUNT(*) as c FROM calendar_sources WHERE source = 'legacy'`);
    assert(Number(legacySourceAfter.rows[0].c) === 0, 'test9: legacy source meta should be removed');

    // Склеенная с investmint группа должна остаться (sources содержит investmint)
    const mergedAfter = await query(
      `SELECT sources FROM calendar_events
       WHERE ticker = $1 AND title = $2 AND kind = $3`,
      [merged.ticker, merged.title, merged.kind]
    );
    assert(mergedAfter.rows.length > 0, 'test9: merged group should remain');
    const mergedSources = JSON.parse(mergedAfter.rows[0].sources || '[]');
    assert(mergedSources.includes('investmint'), 'test9: merged group should still include investmint');

    // Отдельная legacy-группа должна уйти
    const onlyLegacy = await query(`SELECT COUNT(*) as c FROM calendar_events WHERE ticker = 'LEGACY'`);
    assert(Number(onlyLegacy.rows[0].c) === 0, 'test9: standalone legacy group should be removed');

    console.log('[m4] test9 passed: DELETE legacy works correctly');

    server.close();

    // === Test 10: регрессия M1/M2/M3 ===
    console.log('[m4] regression M1...');
    execSync('node scripts/calendar-m1-verify.js', { stdio: 'inherit' });
    console.log('[m4] regression M2...');
    execSync('node scripts/calendar-m2-verify.js', { stdio: 'inherit' });
    console.log('[m4] regression M3...');
    execSync('node scripts/calendar-m3-verify.js', { stdio: 'inherit' });

    console.log('\n[M4 VERIFY] ALL TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('[M4 VERIFY] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
