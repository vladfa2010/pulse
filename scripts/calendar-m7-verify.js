/**
 * Verify-скрипт для ТЗ М7 (Часть Б): Архив событий календаря.
 *
 * Тесты:
 *  1. Накопление архива — второй ingest без архивной даты не теряет её из канона (баг Б.1)
 *  2. Корректировка в grace — событие server_date−1 перезаписывается в живом окне
 *  3. Годовой файл дважды — raw count стабилен, warning про замороженные дубликаты
 *  4. Томбстоун на архивном — delete/restore работают, ingest не воскрешает удалённое
 *  5. Публичное окно — архив не в GET /api/calendar, есть в GET /api/admin/calendar/history
 *  6. dry_run — превью не показывает ложных removed_events по архиву, таблицы не трогает
 *
 * Запуск: npm run verify:calendarM7
 */

const { setCommonEnv, setup: bootstrapSetup } = require('./lib/calendar-verify-env');
setCommonEnv();

const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');

const distDir = path.join(__dirname, '..', 'dist');

// Подменяем axios.post до загрузки модулей: Telegram — ok, Moonshot — пустой мок.
const axios = require('axios');
axios.post = async () => ({ data: { ok: true, result: { message_id: 1 } } });

let query;
let getMskDateString;
let flushCanonicalRewrites;
let adminRouter;
let calendarRouter;

const express = require('express');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

/** Арифметика дат на строках YYYY-MM-DD (UTC, без локали). */
function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** PG возвращает DATE как Date (локальная полночь), SQLite — строку. Приводим к YYYY-MM-DD. */
function toDateStr(v) {
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

/** YYYY-MM-DD → DD.MM.YYYY (сырой формат smartlab). */
function toSmartlabDate(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return `${d}.${m}.${y}`;
}

/** Собрать raw smartlab-файл: items = [{ date: 'YYYY-MM-DD', ticker, title }]. */
function makeSmartlabFile(items) {
  return items.map((it) => ({
    date: toSmartlabDate(it.date),
    title: `${it.ticker}: ${it.title}`,
  }));
}

async function setup() {
  await bootstrapSetup();

  ({ query } = require(path.join(distDir, 'config', 'db.js')));
  ({ getMskDateString, flushCanonicalRewrites } = require(path.join(distDir, 'services', 'calendar.js')));
  adminRouter = require(path.join(distDir, 'routes', 'admin.js')).default;
  calendarRouter = require(path.join(distDir, 'routes', 'calendar.js')).default;

  await query(`CREATE TABLE IF NOT EXISTS smart_tag_cache (
    text_hash TEXT PRIMARY KEY,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);

  // admin-пользователь для прохождения adminMiddleware (UUID — PG-режим требует валидный uuid)
  const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
  await query(
    `INSERT INTO users (id, email, username, password_hash, is_admin)
     VALUES ('${ADMIN_ID}', 'admin@test', 'admin', 'x', TRUE)`
  );
}

function createToken(userId) {
  return jwt.sign({ userId, email: 'admin@test' }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin', adminRouter);
  app.use('/api/calendar', calendarRouter);
  return app;
}

async function request(server, method, pathName, body, { auth = true } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path: pathName,
      method,
      agent: new http.Agent({ keepAlive: false }),
      headers: { 'Content-Type': 'application/json' },
    };
    if (auth) options.headers['Authorization'] = 'Bearer ' + createToken('00000000-0000-4000-8000-000000000001');
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

async function postSlice(server, base, source, payload, dryRun = false) {
  const qs = dryRun ? '?dry_run=1' : '';
  const res = await request(server, 'POST', `${base}/calendar/${encodeURIComponent(source)}${qs}`, payload);
  // Live-ответ приходит до фоновой пересборки канона — дожидаемся её здесь,
  // чтобы последующие проверки канона были детерминированы.
  if (!dryRun) await flushCanonicalRewrites();
  return res;
}

async function findCanonical(ticker) {
  const result = await query(`SELECT * FROM calendar_events WHERE ticker = $1`, [ticker]);
  return result.rows[0] || null;
}

async function countRaw(ticker) {
  const result = await query(`SELECT COUNT(*) as c FROM calendar_events_raw WHERE ticker = $1`, [ticker]);
  return Number(result.rows[0].c);
}

async function resetCalendarTables() {
  await query(`DELETE FROM calendar_events_raw`);
  await query(`DELETE FROM calendar_events`);
  await query(`DELETE FROM calendar_sources`);
  await query(`DELETE FROM calendar_meta`);
  await flushCanonicalRewrites();
}

async function main() {
  try {
    await setup();
    const app = createApp();
    const server = app.listen(0);
    const base = '/api/admin';

    const serverDate = await getMskDateString();
    console.log(`[m7] serverDate=${serverDate}`);

    const archiveDate = addDaysStr(serverDate, -30); // архив: < server_date − 14
    const graceDate = addDaysStr(serverDate, -1); // живое окно
    const liveDate = addDaysStr(serverDate, 5); // будущее

    // Живые даты-наполнители (каждый файл должен иметь ≥5 уникальных дат)
    const fillerDates = [0, 1, 2, 3].map((i) => addDaysStr(liveDate, i));

    // === Test 1: накопление архива (баг Б.1) ===
    await resetCalendarTables();
    // Файл A: архивная дата + 4 живых даты (5 уникальных дат)
    const fileA = makeSmartlabFile([
      { date: archiveDate, ticker: 'ARCT', title: 'Архивное событие МСФО' },
      ...fillerDates.map((d, i) => ({ date: d, ticker: 'FILL', title: `Наполнитель ${i}` })),
    ]);
    const postA = await postSlice(server, base, 'smartlab', fileA);
    assert(postA.status === 200, `test1: first ingest should return 200, got ${postA.status}: ${JSON.stringify(postA.body)}`);

    const canonicalA = await findCanonical('ARCT');
    assert(canonicalA, 'test1: archive event should be in canonical after first ingest');
    assert(toDateStr(canonicalA.date) === archiveDate, `test1: archive date should be ${archiveDate}, got ${canonicalA.date}`);

    // Файл B: 5 живых дат БЕЗ архивной → date-scoped DELETE не трогает архив,
    // а симуляция канона обязана его включить (фикс Б.1).
    const fileB = makeSmartlabFile([
      ...[0, 1, 2, 3, 4].map((i) => ({ date: addDaysStr(liveDate, i), ticker: 'FILL', title: `Наполнитель ${i}` })),
    ]);
    const postB = await postSlice(server, base, 'smartlab', fileB);
    assert(postB.status === 200, `test1: second ingest should return 200, got ${postB.status}: ${JSON.stringify(postB.body)}`);

    const rawAfterB = await countRaw('ARCT');
    assert(rawAfterB === 1, `test1: archive raw row should survive, got ${rawAfterB}`);
    const canonicalAfterB = await findCanonical('ARCT');
    assert(canonicalAfterB, 'test1: BUG Б.1 — archive event lost from canonical after second ingest');
    console.log('[m7] test1 passed: archive survives second ingest (raw + canonical)');

    // === Test 2: корректировка в grace (replace в живом окне) ===
    const graceDates = [-1, 0, 1, 2, 3].map((i) => addDaysStr(serverDate, i));
    const fileG1 = makeSmartlabFile(
      graceDates.map((d) => ({ date: d, ticker: 'GRCT', title: 'Ожидается МСФО' }))
    );
    const postG1 = await postSlice(server, base, 'smartlab', fileG1);
    assert(postG1.status === 200, `test2: first grace ingest should return 200, got ${postG1.status}`);
    const g1 = await findCanonical('GRCT');
    assert(g1, 'test2: GRCT should be in canonical');
    assert(g1.status === 'expected', `test2: first upload status should be expected, got ${g1.status}`);

    // Перезаливка с подтверждением: тот же ключ, статус меняется
    const fileG2 = makeSmartlabFile(
      graceDates.map((d) => ({ date: d, ticker: 'GRCT', title: 'МСФО' }))
    );
    const postG2 = await postSlice(server, base, 'smartlab', fileG2);
    assert(postG2.status === 200, `test2: second grace ingest should return 200, got ${postG2.status}`);
    const g2rows = await query(`SELECT * FROM calendar_events WHERE ticker = 'GRCT'`);
    assert(g2rows.rows.length === 5, `test2: expected 5 GRCT rows, got ${g2rows.rows.length}`);
    for (const row of g2rows.rows) {
      assert(row.status === 'confirmed', `test2: status should be confirmed after re-upload, got ${row.status}`);
    }
    assert(g2rows.rows.some((r) => toDateStr(r.date) === graceDate), 'test2: grace date row should exist');
    console.log('[m7] test2 passed: live-window replace updates status (expected → confirmed)');

    // === Test 3: годовой файл дважды — дедуп замороженных ===
    await resetCalendarTables();
    const yearDates = [0, 1, 2, 3, 4].map((i) => addDaysStr(serverDate, -(60 - i * 5))); // −60..−40, все архив
    for (const d of yearDates) {
      assert(d < addDaysStr(serverDate, -14), `test3: ${d} should be archive`);
    }
    const fileY = makeSmartlabFile(yearDates.map((d) => ({ date: d, ticker: 'YRCT', title: 'Годовое событие' })));
    const postY1 = await postSlice(server, base, 'smartlab', fileY);
    assert(postY1.status === 200, `test3: first yearly ingest should return 200, got ${postY1.status}`);
    const rawY1 = await countRaw('YRCT');
    assert(rawY1 === 5, `test3: expected 5 raw rows after first upload, got ${rawY1}`);

    const postY2 = await postSlice(server, base, 'smartlab', fileY);
    assert(postY2.status === 200, `test3: second yearly ingest should return 200, got ${postY2.status}`);
    const rawY2 = await countRaw('YRCT');
    assert(rawY2 === 5, `test3: raw count should stay 5 after re-upload, got ${rawY2}`);

    const metaY = await query(`SELECT last_warnings FROM calendar_sources WHERE source = 'smartlab'`);
    const savedWarnings = JSON.parse(metaY.rows[0]?.last_warnings || '[]');
    assert(
      savedWarnings.some((w) => w.includes('замороженных дубликатов: 5')),
      `test3: expected dedup warning, got ${JSON.stringify(savedWarnings)}`
    );
    console.log('[m7] test3 passed: frozen dedup, raw stable, warning persisted');

    // === Test 4: томбстоун на архивном событии ===
    await resetCalendarTables();
    const tombDate = addDaysStr(serverDate, -35);
    const fileT = makeSmartlabFile([
      { date: tombDate, ticker: 'TBCT', title: 'МСФО' },
      ...[0, 1, 2, 3].map((i) => ({ date: addDaysStr(liveDate, i), ticker: 'FILL', title: `Наполнитель ${i}` })),
    ]);
    const postT = await postSlice(server, base, 'smartlab', fileT);
    assert(postT.status === 200, `test4: ingest should return 200, got ${postT.status}`);
    const tBefore = await findCanonical('TBCT');
    assert(tBefore, 'test4: TBCT should be in canonical');

    // Удалить архивное событие через CRUD
    const delRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/${encodeURIComponent(tombDate)}/${encodeURIComponent('МСФО')}/${encodeURIComponent('МСФО')}`
    );
    assert(delRes.status === 200, `test4: delete should return 200, got ${delRes.status}`);
    await flushCanonicalRewrites();
    const tAfterDelete = await findCanonical('TBCT');
    assert(!tAfterDelete, 'test4: deleted archive event should leave canonical');

    // Ingest источника, содержащего удалённое событие, НЕ воскрешает его
    const postT2 = await postSlice(server, base, 'smartlab', fileT);
    assert(postT2.status === 200, `test4: re-ingest should return 200, got ${postT2.status}`);
    const tAfterReingest = await findCanonical('TBCT');
    assert(!tAfterReingest, 'test4: ingest must not resurrect tombstoned archive event');

    // Restore через список tombstones
    const tombList = await request(server, 'GET', `${base}/calendar/events?tombstones=true`);
    assert(tombList.status === 200, `test4: tombstones list should return 200, got ${tombList.status}`);
    const tombstone = (tombList.body.events || []).find(
      (e) => e.date === tombDate && e.deleted_ticker === 'TBCT'
    );
    assert(tombstone, 'test4: tombstone should be listed');
    const restoreRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/tombstone?date=${encodeURIComponent(tombDate)}&title=${encodeURIComponent('TBCT')}&company=${encodeURIComponent('TB Company')}&original_title=${encodeURIComponent('МСФО')}`
    );
    assert(restoreRes.status === 200, `test4: restore should return 200, got ${restoreRes.status}`);
    await flushCanonicalRewrites();
    const tAfterRestore = await findCanonical('TBCT');
    assert(tAfterRestore, 'test4: restored archive event should return to canonical');
    console.log('[m7] test4 passed: archive tombstone delete/restore, ingest respects tombstone');

    // === Test 5: публичное окно vs history ===
    // Состояние: TBCT на tombDate (−35) восстановлено и в каноне.
    const pubRes = await request(server, 'GET', '/api/calendar', undefined, { auth: false });
    assert(pubRes.status === 200, `test5: public calendar should return 200, got ${pubRes.status}`);
    const pubDates = (pubRes.body.days || []).map((d) => d.date);
    assert(!pubDates.includes(tombDate), `test5: archive date ${tombDate} must not be in public calendar`);
    assert(pubDates.includes(liveDate), `test5: live date ${liveDate} should be in public calendar`);

    const histRes = await request(server, 'GET', `${base}/calendar/history?ticker=TBCT`);
    assert(histRes.status === 200, `test5: history should return 200, got ${histRes.status}`);
    const histEvents = histRes.body.events || [];
    assert(
      histEvents.some((e) => e.date === tombDate),
      `test5: archive event should be in history, got ${JSON.stringify(histEvents.map((e) => e.date))}`
    );
    console.log('[m7] test5 passed: archive out of public window, present in /history');

    // === Test 6: dry_run превью без ложных удалений архива ===
    const rawBeforeDry = await query(`SELECT COUNT(*) as c FROM calendar_events_raw`);
    const canonBeforeDry = await query(`SELECT COUNT(*) as c FROM calendar_events`);
    const dryRes = await postSlice(server, base, 'smartlab', fileB, true);
    assert(dryRes.status === 200, `test6: dry_run should return 200, got ${dryRes.status}`);
    assert(
      dryRes.body.diff && dryRes.body.diff.removed_events === 0,
      `test6: dry_run should not report archive removals, got ${JSON.stringify(dryRes.body.diff)}`
    );
    const rawAfterDry = await query(`SELECT COUNT(*) as c FROM calendar_events_raw`);
    const canonAfterDry = await query(`SELECT COUNT(*) as c FROM calendar_events`);
    assert(
      Number(rawAfterDry.rows[0].c) === Number(rawBeforeDry.rows[0].c),
      'test6: dry_run must not touch calendar_events_raw'
    );
    assert(
      Number(canonAfterDry.rows[0].c) === Number(canonBeforeDry.rows[0].c),
      'test6: dry_run must not touch calendar_events'
    );
    console.log('[m7] test6 passed: dry_run preview consistent, no false archive removals');

    console.log('\n[M7 VERIFY] ALL TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('[M7 VERIFY] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
