/**
 * Verify-скрипт для ТЗ M6: Матчинг событий к тегам.
 * Запуск: npm run verify:calendarM6
 */

const { setCommonEnv, setup: setupEnv } = require('./lib/calendar-verify-env');
setCommonEnv();

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

// DB-зависимые модули загружаются после bootstrap в setup().
let query;
let getMskDateString;
let rebuildCanonical;
let rewriteCanonicalFromRaw;
let ingestProviderSlice;
let adminRouter;
let express;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function setup() {
  await setupEnv();

  // DB-зависимые модули загружаются после инициализации окружения.
  require(path.join(distDir, 'config', 'db-sqlite.js'));
  const db = require(path.join(distDir, 'config', 'db.js'));
  query = db.query;

  const calendarModule = require(path.join(distDir, 'services', 'calendar.js'));
  ({ getMskDateString, rebuildCanonical, rewriteCanonicalFromRaw, ingestProviderSlice, flushCanonicalRewrites } = calendarModule);

  adminRouter = require(path.join(distDir, 'routes', 'admin.js')).default;
  express = require('express');

  // Дополнительная таблица, специфичная для M6.
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

function parseTagIds(row) {
  try {
    return JSON.parse(row.tag_ids || '[]');
  } catch {
    return [];
  }
}

async function resetCalendarTables() {
  await query(`DELETE FROM calendar_events_raw`);
  await query(`DELETE FROM calendar_events`);
  await query(`DELETE FROM calendar_sources`);
  await query(`DELETE FROM calendar_meta`);
  await query(`DELETE FROM calendar_settings`);
  await query(`DELETE FROM smart_tag_cache`);
  llmCallCount = 0;
}

async function main() {
  try {
    await setup();
    const app = createApp();
    const server = app.listen(0);
    const base = '/api/admin';

    const serverDate = await getMskDateString();
    console.log(`[m6] serverDate=${serverDate}`);

    // === Test 1: «Заседание ЦБ РФ» без тикера → tag_ids содержит «цб», matched_via = keyword ===
    await resetCalendarTables();
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('manual', ?, 'ср', 'Заседание ЦБ РФ', 'Другое', 'expected', 'ПАО ЦБ РФ', 'UNKNOWN', datetime('now'))`,
      [serverDate]
    );
    await rebuildCanonical();

    const cbRow = await query(`SELECT * FROM calendar_events WHERE title = 'Заседание ЦБ РФ'`);
    assert(cbRow.rows.length === 1, 'test1: expected one canonical CB row');
    const cbTags = parseTagIds(cbRow.rows[0]);
    assert(cbTags.includes('цб'), `test1: tag_ids should include "цб", got ${cbRow.rows[0].tag_ids}`);
    assert(cbRow.rows[0].matched_via === 'keyword', `test1: matched_via should be keyword, got ${cbRow.rows[0].matched_via}`);
    assert(llmCallCount === 0, `test1: LLM should not be called for keyword match, calls=${llmCallCount}`);
    console.log('[m6] test1 passed: CB event keyword-matched to "цб"');

    // === Test 2: событие Лукойла → тег lkoh через LLM fallback, matched_via = llm ===
    await resetCalendarTables();
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('manual', ?, 'ср', 'Отчёт Лукойла', 'МСФО', 'expected', 'ПАО Лукойл', 'UNKNOWN', datetime('now'))`,
      [serverDate]
    );
    await rebuildCanonical();

    const lkohRow = await query(`SELECT * FROM calendar_events WHERE title = 'Отчёт Лукойла'`);
    assert(lkohRow.rows.length === 1, 'test2: expected one canonical LUKOIL row');
    const lkohTags = parseTagIds(lkohRow.rows[0]);
    assert(lkohTags.includes('lkoh'), `test2: tag_ids should include "lkoh", got ${lkohRow.rows[0].tag_ids}`);
    assert(lkohRow.rows[0].matched_via === 'llm', `test2: matched_via should be llm, got ${lkohRow.rows[0].matched_via}`);
    assert(llmCallCount === 1, `test2: LLM should be called once for LUKOIL, calls=${llmCallCount}`);
    console.log('[m6] test2 passed: LUKOIL event LLM-matched to "lkoh"');

    // === Test 3: повторная пересборка → LLM не вызывается (кэш матчера) ===
    llmCallCount = 0;
    await rebuildCanonical();
    assert(llmCallCount === 0, `test3: repeat rebuild should not call LLM, calls=${llmCallCount}`);
    const lkohAfterRebuild = await query(`SELECT * FROM calendar_events WHERE title = 'Отчёт Лукойла'`);
    assert(lkohAfterRebuild.rows.length === 1, 'test3: canonical row should persist after repeat rebuild');
    assert(parseTagIds(lkohAfterRebuild.rows[0]).includes('lkoh'), 'test3: lkoh tag should persist');
    console.log('[m6] test3 passed: repeat rebuild uses LLM cache, no API calls');

    // === Test 4: dry_run ingest не вызывает LLM ===
    await resetCalendarTables();
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('legacy', ?, 'ср', 'Заседание ЦБ РФ', 'Другое', 'expected', 'ПАО ЦБ РФ', 'UNKNOWN', datetime('now'))`,
      [serverDate]
    );
    const dryRunRows = [{
      source: 'global',
      date: serverDate,
      weekday: 'ср',
      title: 'Отчёт Лукойла',
      kind: 'МСФО',
      status: 'expected',
      company: 'ПАО Лукойл',
      ticker: 'UNKNOWN',
    }];
    await ingestProviderSlice('global', dryRunRows, true);
    assert(llmCallCount === 0, `test4: dry_run should not call LLM, calls=${llmCallCount}`);
    // dry_run не должен был записать канон
    const afterDryRun = await query(`SELECT COUNT(*) as c FROM calendar_events WHERE title = 'Отчёт Лукойла'`);
    assert(Number(afterDryRun.rows[0].c) === 0, 'test4: dry_run should not write canonical');
    console.log('[m6] test4 passed: dry_run skips matching and writing');

    // === Test 5: tombstoned событие не матчится и не дергает LLM ===
    await resetCalendarTables();
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('manual', ?, 'ср', 'Заседание ЦБ РФ', 'Другое', 'expected', 'ПАО ЦБ РФ', 'UNKNOWN', datetime('now'))`,
      [serverDate]
    );
    await rebuildCanonical();
    const beforeTomb = await query(`SELECT COUNT(*) as c FROM calendar_events WHERE title = 'Заседание ЦБ РФ'`);
    assert(Number(beforeTomb.rows[0].c) === 1, 'test5: event should exist before delete');

    const deleteRes = await request(
      server,
      'DELETE',
      `${base}/calendar/events/${encodeURIComponent(serverDate)}/${encodeURIComponent('Заседание ЦБ РФ')}/${encodeURIComponent('Другое')}`
    );
    assert(deleteRes.status === 200, `test5: delete should return 200, got ${deleteRes.status}`);

    await flushCanonicalRewrites();
    llmCallCount = 0;
    // deleteCalendarEventGroup уже вызвал rebuildCanonical внутри tx; дополнительный rebuild — для проверки.
    await rebuildCanonical();
    assert(llmCallCount === 0, `test5: tombstoned event should not trigger LLM, calls=${llmCallCount}`);
    const afterTomb = await query(`SELECT COUNT(*) as c FROM calendar_events WHERE title = 'Заседание ЦБ РФ'`);
    assert(Number(afterTomb.rows[0].c) === 0, 'test5: tombstoned event should not be in canonical');
    console.log('[m6] test5 passed: tombstoned event excluded from matching');

    // === Test 6: GET /events и детальный GET отдают tag_ids/matched_via ===
    await resetCalendarTables();
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('manual', ?, 'ср', 'Заседание ЦБ РФ', 'Другое', 'expected', 'ПАО ЦБ РФ', 'UNKNOWN', datetime('now'))`,
      [serverDate]
    );
    await query(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('manual', ?, 'ср', 'Отчёт Лукойла', 'МСФО', 'expected', 'ПАО Лукойл', 'UNKNOWN', datetime('now'))`,
      [serverDate]
    );
    await rebuildCanonical();

    const listRes = await request(server, 'GET', `${base}/calendar/events`);
    assert(listRes.status === 200, `test6: list should return 200, got ${listRes.status}`);
    const cbListEvent = listRes.body.events.find((e) => e.title === 'Заседание ЦБ РФ');
    const lkohListEvent = listRes.body.events.find((e) => e.title === 'Отчёт Лукойла');
    assert(cbListEvent, 'test6: CB event should be in list');
    assert(lkohListEvent, 'test6: LUKOIL event should be in list');
    assert(cbListEvent.tag_ids && cbListEvent.tag_ids.includes('цб'), 'test6: list CB tag_ids should include "цб"');
    assert(lkohListEvent.tag_ids && lkohListEvent.tag_ids.includes('lkoh'), 'test6: list LUKOIL tag_ids should include "lkoh"');

    const detailRes = await request(
      server,
      'GET',
      `${base}/calendar/events/${encodeURIComponent(serverDate)}/${encodeURIComponent('Отчёт Лукойла')}/${encodeURIComponent('МСФО')}`
    );
    assert(detailRes.status === 200, `test6: detail GET should return 200, got ${detailRes.status}`);
    assert(detailRes.body.event.tag_ids && detailRes.body.event.tag_ids.includes('lkoh'), 'test6: detail tag_ids should include "lkoh"');
    assert(
      detailRes.body.event.companies.length > 0 && detailRes.body.event.companies[0].tag_ids,
      'test6: detail companies should expose tag_ids'
    );
    console.log('[m6] test6 passed: list and detail expose tag_ids');

    // === Test 7: после боевого ingest нет строк с matched_via IS NULL ===
    await resetCalendarTables();
    const liveRows = [
      {
        source: 'global',
        date: serverDate,
        weekday: 'ср',
        title: 'Заседание ЦБ РФ',
        kind: 'Другое',
        status: 'expected',
        company: 'ПАО ЦБ РФ',
        ticker: 'UNKNOWN',
      },
      {
        source: 'global',
        date: serverDate,
        weekday: 'ср',
        title: 'Отчёт Лукойла',
        kind: 'МСФО',
        status: 'expected',
        company: 'ПАО Лукойл',
        ticker: 'UNKNOWN',
      },
    ];
    llmCallCount = 0;
    const liveRes = await ingestProviderSlice('global', liveRows, false);
    assert(liveRes.queued === true, 'test7: live ingest should return queued=true');
    await flushCanonicalRewrites();
    const liveCanonical = (await query(`SELECT tag_ids FROM calendar_events`)).rows;
    assert(liveCanonical.length === 2, `test7: expected 2 canonical rows, got ${liveCanonical.length}`);
    const nullCount = await query(`SELECT COUNT(*) as c FROM calendar_events WHERE matched_via IS NULL`);
    assert(Number(nullCount.rows[0].c) === 0, `test7: expected 0 rows with matched_via IS NULL, got ${nullCount.rows[0].c}`);
    assert(
      liveCanonical.every((r) => r.tag_ids && JSON.parse(r.tag_ids).length > 0),
      'test7: all canonical rows should carry non-empty tag_ids'
    );
    console.log('[m6] test7 passed: live ingest writes tags atomically, no NULL matched_via');

    // === Test 8: GET settings returns default true on empty table ===
    await resetCalendarTables();
    const settingsDefaultRes = await request(server, 'GET', `${base}/calendar/settings`);
    assert(settingsDefaultRes.status === 200, `test8: GET settings should return 200, got ${settingsDefaultRes.status}`);
    assert(settingsDefaultRes.body.llm_enabled === true, `test8: default llm_enabled should be true, got ${settingsDefaultRes.body.llm_enabled}`);
    console.log('[m6] test8 passed: default llm_enabled is true');

    // === Test 9: LLM off — keyword still works, non-keyword gets no tags, no LLM calls ===
    await resetCalendarTables();
    const putOffRes = await request(server, 'PUT', `${base}/calendar/settings`, { llm_enabled: false });
    assert(putOffRes.status === 200, `test9: PUT settings off should return 200, got ${putOffRes.status}`);
    assert(putOffRes.body.llm_enabled === false, `test9: PUT should return false, got ${putOffRes.body.llm_enabled}`);

    const offRows = [
      {
        source: 'global',
        date: serverDate,
        weekday: 'ср',
        title: 'Заседание ЦБ РФ',
        kind: 'Другое',
        status: 'expected',
        company: 'ПАО ЦБ РФ',
        ticker: 'UNKNOWN',
      },
      {
        source: 'global',
        date: serverDate,
        weekday: 'ср',
        title: 'Отчёт Лукойла',
        kind: 'МСФО',
        status: 'expected',
        company: 'ПАО Лукойл',
        ticker: 'UNKNOWN',
      },
    ];
    llmCallCount = 0;
    await ingestProviderSlice('global', offRows, false);
    await flushCanonicalRewrites();
    const cbOff = await query(`SELECT * FROM calendar_events WHERE title = 'Заседание ЦБ РФ'`);
    assert(cbOff.rows.length === 1, 'test9: CB row should exist');
    assert(cbOff.rows[0].matched_via === 'keyword', `test9: CB should be keyword, got ${cbOff.rows[0].matched_via}`);
    assert(JSON.parse(cbOff.rows[0].tag_ids || '[]').includes('цб'), 'test9: CB tag_ids should include "цб"');
    const lkohOff = await query(`SELECT * FROM calendar_events WHERE title = 'Отчёт Лукойла'`);
    assert(lkohOff.rows.length === 1, 'test9: LUKOIL row should exist');
    assert(lkohOff.rows[0].matched_via === null, `test9: LUKOIL matched_via should be null when LLM off, got ${lkohOff.rows[0].matched_via}`);
    assert(JSON.parse(lkohOff.rows[0].tag_ids || '[]').length === 0, 'test9: LUKOIL tag_ids should be empty when LLM off');
    assert(llmCallCount === 0, `test9: LLM should not be called when off, calls=${llmCallCount}`);
    console.log('[m6] test9 passed: LLM off disables Layer 2, Layer 1 keyword works');

    // === Test 10: LLM on again — retro-fill previously unmatched events ===
    llmCallCount = 0;
    const putOnRes = await request(server, 'PUT', `${base}/calendar/settings`, { llm_enabled: true });
    assert(putOnRes.status === 200, `test10: PUT settings on should return 200, got ${putOnRes.status}`);
    assert(putOnRes.body.llm_enabled === true, `test10: PUT should return true, got ${putOnRes.body.llm_enabled}`);

    await query(`DELETE FROM smart_tag_cache`); // clear cache so rebuild has to call LLM
    await query(`DELETE FROM calendar_events`); // drop canonical to force rewrite
    await rewriteCanonicalFromRaw();

    const lkohOn = await query(`SELECT * FROM calendar_events WHERE title = 'Отчёт Лукойла'`);
    assert(lkohOn.rows.length === 1, 'test10: LUKOIL row should exist after rebuild');
    assert(lkohOn.rows[0].matched_via === 'llm', `test10: LUKOIL matched_via should be llm after retro-fill, got ${lkohOn.rows[0].matched_via}`);
    assert(JSON.parse(lkohOn.rows[0].tag_ids || '[]').includes('lkoh'), 'test10: LUKOIL tag_ids should include lkoh after retro-fill');
    assert(llmCallCount === 1, `test10: LLM should be called once for previously unmatched text, calls=${llmCallCount}`);
    console.log('[m6] test10 passed: LLM on retro-fills unmatched events');

    // === Test 11: persistence — value stored in DB ===
    const dbValue = await query(`SELECT value FROM calendar_settings WHERE key = 'llm_enabled'`);
    assert(dbValue.rows.length === 1, 'test11: llm_enabled setting should persist in DB');
    assert(dbValue.rows[0].value === 'true', `test11: persisted value should be 'true', got ${dbValue.rows[0].value}`);
    console.log('[m6] test11 passed: llm_enabled persists in calendar_settings');

    // === Test 12: invalid PUT rejected ===
    const putInvalidRes = await request(server, 'PUT', `${base}/calendar/settings`, { llm_enabled: 'maybe' });
    assert(putInvalidRes.status === 400, `test12: invalid PUT should return 400, got ${putInvalidRes.status}`);
    console.log('[m6] test12 passed: invalid llm_enabled rejected');

    server.close();

    // === Test 13: регрессии M1–M5 ===
    console.log('[m6] regression M1...');
    execSync('node scripts/calendar-m1-verify.js', { stdio: 'inherit' });
    console.log('[m6] regression M2...');
    execSync('node scripts/calendar-m2-verify.js', { stdio: 'inherit' });
    console.log('[m6] regression M3...');
    execSync('node scripts/calendar-m3-verify.js', { stdio: 'inherit' });
    console.log('[m6] regression M4...');
    execSync('node scripts/calendar-m4-verify.js', { stdio: 'inherit' });
    console.log('[m6] regression M5...');
    execSync('node scripts/calendar-m5-verify.js', { stdio: 'inherit' });

    console.log('\n[M6 VERIFY] ALL TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('[M6 VERIFY] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
