/**
 * Verify-скрипт для ТЗ «Свободная загрузка событий в ручной срез (manual-upload)» v1.1.
 * Запуск: npm run verify:calendarManual
 */

const { setCommonEnv, setup: setupCalendarEnv } = require('./lib/calendar-verify-env');
setCommonEnv();

const path = require('path');
const http = require('http');
const jwt = require('jsonwebtoken');
const { execSync } = require('child_process');
const axios = require('axios');
axios.post = async () => ({ data: { ok: true, result: { message_id: 1 } } });

const distDir = path.join(__dirname, '..', 'dist');

let query;
let getMskDateString;
let addDays;
let flushCanonicalRewrites;
let adminRouter;
let express;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function setup() {
  await setupCalendarEnv();

  const dbModule = require(path.join(distDir, 'config', 'db.js'));
  query = dbModule.query;

  const calendarModule = require(path.join(distDir, 'services', 'calendar.js'));
  getMskDateString = calendarModule.getMskDateString;
  addDays = calendarModule.addDays;
  flushCanonicalRewrites = calendarModule.flushCanonicalRewrites;

  adminRouter = require(path.join(distDir, 'routes', 'admin.js')).default;
  express = require('express');

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

async function request(server, method, pathName, body) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path: pathName,
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

async function upload(server, base, items, dryRun = false) {
  const qs = dryRun ? '?dry_run=1' : '';
  const res = await request(server, 'POST', `${base}/calendar/manual/upload${qs}`, items);
  if (!dryRun) await flushCanonicalRewrites();
  return res;
}

async function resetCalendarTables() {
  await query(`DELETE FROM calendar_events_raw`);
  await query(`DELETE FROM calendar_events`);
  await query(`DELETE FROM calendar_sources`);
  await query(`DELETE FROM calendar_meta`);
  await flushCanonicalRewrites();
}

async function countRaw(source) {
  const r = await query(`SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = $1`, [source]);
  return Number(r.rows[0].c);
}

async function main() {
  try {
    await setup();
    const app = createApp();
    const server = app.listen(0);
    const base = '/api/admin';

    const serverDate = await getMskDateString();
    console.log(`[manual] serverDate=${serverDate}`);
    const d = (offset) => addDays(serverDate, offset);
    const archiveDate = addDays(serverDate, -30); // архив: < server_date − 14

    // === Test 1: западня закрыта — 1 событие на 1 дату → 200, в каноне ===
    await resetCalendarTables();
    const one = [{ date: d(1), title: 'HNFG: День инвестора по итогам II кв 2026' }];
    const res1 = await upload(server, base, one);
    assert(res1.status === 200, `test1: expected 200, got ${res1.status}: ${JSON.stringify(res1.body)}`);
    assert(res1.body.added === 1, `test1: expected added=1, got ${JSON.stringify(res1.body)}`);
    const canon1 = await query(`SELECT * FROM calendar_events WHERE ticker = 'HNFG'`);
    assert(canon1.rows.length === 1, `test1: HNFG should be in canonical, got ${canon1.rows.length}`);
    console.log('[manual] test1 passed: single event / single day accepted');

    // === Test 2: merge, не replace — существующее (включая архив) нетронуто ===
    await resetCalendarTables();
    // Архивная manual-строка (замороженная) + чужой срез investmint
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('manual', $1, 'пн', 'Архивное событие', 'МСФО', 'confirmed', 'OLD', 'OLDT', datetime('now'))`,
      [archiveDate]
    );
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('investmint', $1, 'пн', 'Событие инвестминта', 'МСФО', 'expected', 'INV', 'INVT', datetime('now'))`,
      [d(2)]
    );
    const res2 = await upload(server, base, [
      { date: d(1), title: 'NEW: Новое событие' },
      { date: d(3), title: 'NEW2: Ещё одно' },
    ]);
    assert(res2.body.added === 2, `test2: expected added=2, got ${JSON.stringify(res2.body)}`);
    const oldAfter = await query(`SELECT COUNT(*) as c FROM calendar_events_raw WHERE ticker = 'OLDT'`);
    assert(Number(oldAfter.rows[0].c) === 1, 'test2: archive manual row must survive');
    const invAfter = await query(`SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'investmint'`);
    assert(Number(invAfter.rows[0].c) === 1, 'test2: foreign slice must be untouched');
    const manualCount2 = await countRaw('manual');
    assert(manualCount2 === 3, `test2: expected 3 manual raw rows, got ${manualCount2}`);
    console.log('[manual] test2 passed: merge keeps archive and foreign slices');

    // === Test 3: дедуп — повторная заливка → added=0, duplicates=N ===
    const file3 = [
      { date: d(1), title: 'NEW: Новое событие' },
      { date: d(3), title: 'NEW2: Ещё одно' },
      { date: d(5), title: 'DUP3: Третье событие' },
    ];
    const res3a = await upload(server, base, file3);
    assert(res3a.body.added === 1 && res3a.body.duplicates === 2, `test3: first partial upload wrong: ${JSON.stringify(res3a.body)}`);
    const rawBefore3 = await countRaw('manual');
    const res3b = await upload(server, base, file3);
    assert(res3b.body.added === 0, `test3: expected added=0, got ${JSON.stringify(res3b.body)}`);
    assert(res3b.body.duplicates === 3, `test3: expected duplicates=3, got ${JSON.stringify(res3b.body)}`);
    const rawAfter3 = await countRaw('manual');
    assert(rawAfter3 === rawBefore3, `test3: raw must not grow (${rawBefore3} -> ${rawAfter3})`);
    console.log('[manual] test3 passed: re-upload deduped, raw stable');

    // === Test 4: воскрешение — tombstone → заливка → resurrected=1 ===
    const del4 = await request(
      server, 'DELETE',
      `${base}/calendar/events/${encodeURIComponent(d(5))}/${encodeURIComponent('Третье событие')}/${encodeURIComponent('Другое')}`
    );
    assert(del4.status === 200, `test4: delete should return 200, got ${del4.status}: ${JSON.stringify(del4.body)}`);
    await flushCanonicalRewrites();
    const tomb4 = await query(
      `SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'manual' AND ticker = '__deleted__'`
    );
    assert(Number(tomb4.rows[0].c) === 1, `test4: expected 1 tombstone, got ${tomb4.rows[0].c}`);
    const canon4before = await query(`SELECT COUNT(*) as c FROM calendar_events WHERE ticker = 'DUP3'`);
    assert(Number(canon4before.rows[0].c) === 0, 'test4: tombstoned event must leave canonical');
    const res4 = await upload(server, base, [{ date: d(5), title: 'DUP3: Третье событие' }]);
    assert(res4.body.resurrected === 1, `test4: expected resurrected=1, got ${JSON.stringify(res4.body)}`);
    assert(res4.body.added === 0, `test4: expected added=0 (live row survived delete), got ${JSON.stringify(res4.body)}`);
    assert(res4.body.duplicates === 0, `test4: expected duplicates=0, got ${JSON.stringify(res4.body)}`);
    const tomb4after = await query(
      `SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'manual' AND ticker = '__deleted__'`
    );
    assert(Number(tomb4after.rows[0].c) === 0, 'test4: tombstone should be removed after resurrection');
    const canon4 = await query(`SELECT COUNT(*) as c FROM calendar_events WHERE ticker = 'DUP3'`);
    assert(Number(canon4.rows[0].c) === 1, 'test4: resurrected event should be back in canonical');
    console.log('[manual] test4 passed: tombstone resurrected by upload');

    // === Test 5: dry_run — счётчики корректны, БД не изменилась ===
    const file5 = [
      { date: d(7), title: 'DRY1: Сухое событие' },
      { date: d(7), title: 'DRY1: Сухое событие' }, // дубль внутри файла
    ];
    const rawBefore5 = await countRaw('manual');
    const canonBefore5 = await query(`SELECT COUNT(*) as c FROM calendar_events`);
    const res5 = await upload(server, base, file5, true);
    assert(res5.status === 200, `test5: dry_run should return 200, got ${res5.status}`);
    assert(res5.body.dry_run === true, 'test5: dry_run flag should be true');
    assert(res5.body.added === 1, `test5: expected added=1 (in-file dup), got ${JSON.stringify(res5.body)}`);
    assert(res5.body.duplicates === 1, `test5: expected duplicates=1, got ${JSON.stringify(res5.body)}`);
    const rawAfter5 = await countRaw('manual');
    const canonAfter5 = await query(`SELECT COUNT(*) as c FROM calendar_events`);
    assert(rawAfter5 === rawBefore5, `test5: raw must not change on dry_run (${rawBefore5} -> ${rawAfter5})`);
    assert(
      Number(canonAfter5.rows[0].c) === Number(canonBefore5.rows[0].c),
      'test5: canonical must not change on dry_run'
    );
    console.log('[manual] test5 passed: dry_run previews without writes');

    // === Test 6: автоопределение — kind/status, префикс ТИКЕР, fallback company ===
    await resetCalendarTables();
    const file6 = [
      { date: d(1), title: 'SBER: Отчёт по МСФО за 2 кв 2026' }, // prefix + МСФО
      { date: d(1), title: 'Ожидается совет директоров' },        // keyword status + kind СД, без тикера
      { date: d(2), title: 'LKOH: Дивиденды за 9М 2026', company: 'ПАО Лукойл', kind: 'Дивиденды', status: 'expected' }, // явные поля
    ];
    const res6 = await upload(server, base, file6);
    assert(res6.body.added === 3 && res6.body.invalid.length === 0, `test6: ${JSON.stringify(res6.body)}`);
    const r6a = await query(`SELECT * FROM calendar_events_raw WHERE source = 'manual' AND ticker = 'SBER'`);
    assert(r6a.rows.length === 1, 'test6: SBER row should exist');
    assert(r6a.rows[0].title === 'Отчёт по МСФО за 2 кв 2026', `test6: prefix stripped, got "${r6a.rows[0].title}"`);
    assert(r6a.rows[0].kind === 'МСФО', `test6: kind МСФО, got ${r6a.rows[0].kind}`);
    assert(r6a.rows[0].status === 'confirmed', `test6: status confirmed, got ${r6a.rows[0].status}`);
    assert(r6a.rows[0].company === 'SBER', `test6: company fallback to ticker, got ${r6a.rows[0].company}`);
    const r6b = await query(`SELECT * FROM calendar_events_raw WHERE source = 'manual' AND ticker = 'UNKNOWN'`);
    assert(r6b.rows.length === 1, 'test6: UNKNOWN-ticker row should exist');
    assert(r6b.rows[0].kind === 'СД', `test6: kind СД from "совет директоров", got ${r6b.rows[0].kind}`);
    assert(r6b.rows[0].status === 'expected', `test6: status expected from "Ожидается", got ${r6b.rows[0].status}`);
    assert(r6b.rows[0].company === 'Ожидается совет директоров', `test6: company fallback to title, got ${r6b.rows[0].company}`);
    const r6c = await query(`SELECT * FROM calendar_events_raw WHERE source = 'manual' AND ticker = 'LKOH'`);
    assert(r6c.rows.length === 1 && r6c.rows[0].company === 'ПАО Лукойл' && r6c.rows[0].status === 'expected',
      `test6: explicit fields respected, got ${JSON.stringify(r6c.rows[0])}`);
    console.log('[manual] test6 passed: kind/status auto-detect, prefix, company fallback');

    // === Test 7: пограничные — invalid date, пустой массив, не-массив ===
    const res7a = await upload(server, base, [
      { date: '32.13.2026', title: 'Битая дата' },
      { date: d(1), title: '' },
      { date: d(1), title: 'LKOH: Валидное' },
      { date: d(1), title: 'X: Плохой kind', kind: 'Непонятно' },
    ]);
    assert(res7a.status === 200, `test7: mixed file should return 200, got ${res7a.status}`);
    assert(res7a.body.added === 1, `test7: expected added=1, got ${JSON.stringify(res7a.body)}`);
    assert(res7a.body.invalid.length === 3, `test7: expected 3 invalid, got ${JSON.stringify(res7a.body.invalid)}`);
    const reasons7 = res7a.body.invalid.map((i) => i.reason).join(' | ');
    assert(reasons7.includes('invalid date: 32.13.2026'), `test7: invalid date reason, got: ${reasons7}`);
    assert(reasons7.includes('empty title'), `test7: empty title reason, got: ${reasons7}`);
    assert(reasons7.includes('unknown kind'), `test7: unknown kind reason, got: ${reasons7}`);
    const res7b = await request(server, 'POST', `${base}/calendar/manual/upload`, []);
    assert(res7b.status === 400, `test7: empty array should be 400, got ${res7b.status}`);
    const res7c = await request(server, 'POST', `${base}/calendar/manual/upload`, { not: 'array' });
    assert(res7c.status === 400, `test7: non-array should be 400, got ${res7c.status}`);
    console.log('[manual] test7 passed: invalid items collected, empty/non-array rejected');

    server.close();

    // === Test 8: регресс M1–M7 ===
    for (let i = 1; i <= 7; i++) {
      console.log(`[manual] regression M${i}...`);
      execSync(`node scripts/calendar-m${i}-verify.js`, { stdio: 'inherit' });
    }

    console.log('\n[MANUAL-UPLOAD VERIFY] ALL TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('[MANUAL-UPLOAD VERIFY] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
