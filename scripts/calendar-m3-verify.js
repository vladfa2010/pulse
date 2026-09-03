/**
 * Verify-скрипт для ТЗ М3: Ingest API и дифф.
 * Запуск: npm run verify:calendarM3
 */

const { setCommonEnv, setup: bootstrapSetup } = require('./lib/calendar-verify-env');
setCommonEnv();

const fs = require('fs');
const path = require('path');
const distDir = path.join(__dirname, '..', 'dist');

// Подменяем axios.post до загрузки модулей, чтобы Telegram-алерты "отправлялись" без сети.
const axios = require('axios');
axios.post = async () => ({ data: { ok: true, result: { message_id: 1 } } });

const fixturesDir = path.join(__dirname, '..', 'tests', 'calendarAdapters', 'fixtures');

let query;
let investmintAdapter;
let smartlabAdapter;
let detectAdapter;
let toRawRows;
let ingestProviderSlice;
let computeDiff;
let getCanonicalSnapshot;
let validateProviderSlice;
let getMskDateString;
let maybeSendProviderStaleAlerts;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

async function setup() {
  await bootstrapSetup();

  // Загружаем модули, зависящие от БД, после инициализации bootstrap.
  ({ query } = require(path.join(distDir, 'config', 'db.js')));
  ({
    investmintAdapter,
    smartlabAdapter,
    detectAdapter,
    toRawRows,
  } = require(path.join(distDir, 'services', 'calendarAdapters', 'index.js')));
  ({
    ingestProviderSlice,
    addDays,
    computeDiff,
    getCanonicalSnapshot,
    validateProviderSlice,
    getMskDateString,
    maybeSendProviderStaleAlerts,
    flushCanonicalRewrites,
  } = require(path.join(distDir, 'services', 'calendar.js')));

  // Дополнительные таблицы, специфичные для этого verify-скрипта.
  await query(`CREATE TABLE IF NOT EXISTS admin_tg_settings (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    admin_user_id TEXT NOT NULL,
    tg_chat_id TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    UNIQUE(admin_user_id)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS smart_tag_cache (
    text_hash TEXT PRIMARY KEY,
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

async function resetCalendarTables() {
  await query(`DELETE FROM calendar_events_raw`);
  await query(`DELETE FROM calendar_events`);
  await query(`DELETE FROM calendar_sources`);
  await query(`DELETE FROM calendar_meta`);
  await query(`DELETE FROM admin_tg_settings`);
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

// Live-ingest: записывает raw, ждёт фоновую пересборку канона, возвращает
// канон + снапшот до загрузки (для diff) + готовый diff.
async function ingestLive(source, rows, warnings) {
  const snapshot = await getCanonicalSnapshot();
  const res = await ingestProviderSlice(source, rows, false, warnings);
  assert(res.queued === true, `ingestLive(${source}): expected queued=true, got ${JSON.stringify(res)}`);
  await flushCanonicalRewrites();
  const snapMap = await getCanonicalSnapshot();
  const canonical = [...snapMap.values()].flat();
  return { canonical, snapshot, diff: computeDiff(snapshot, canonical) };
}

async function loadProviderFixture(source, fixtureName) {
  const raw = readFixture(fixtureName);
  let adapter;
  if (source === 'investmint') adapter = investmintAdapter;
  else if (source === 'smartlab') adapter = smartlabAdapter;
  else throw new Error('unsupported source');
  const { events } = adapter.parse(raw);
  const rows = toRawRows(events, source);
  const { canonical, snapshot, diff } = await ingestLive(source, rows);
  return { events, rows, canonical, snapshot, diff };
}

async function main() {
  try {
    await setup();
    const serverDate = await getMskDateString();
    console.log(`[m3] serverDate=${serverDate}`);

    // === Test 1: загрузка investmint, raw-срез заменён, канон ненулевой ===
    await resetCalendarTables();
    const { diff: diff1 } = await loadProviderFixture('investmint', 'investmint.json');
    assert(diff1.counts.new_events > 0, 'test1: expected new_events > 0');
    const rawInvestCount = await query(`SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'investmint'`);
    assert(Number(rawInvestCount.rows[0].c) > 0, 'test1: investmint raw rows should exist');
    const canonicalCount1 = await query(`SELECT COUNT(*) as c FROM calendar_events`);
    assert(Number(canonicalCount1.rows[0].c) > 0, 'test1: canonical rows should exist');
    console.log('[m3] test1 passed: investmint loaded, new_events=', diff1.counts.new_events);

    // === Test 2: повтор той же загрузки → diff = 0 ===
    const raw2 = readFixture('investmint.json');
    const { events: events2 } = investmintAdapter.parse(raw2);
    const rows2 = toRawRows(events2, 'investmint');
    const snapshot2 = await getCanonicalSnapshot();
    const { canonical: canonical2 } = await ingestLive('investmint', rows2);
    const diff2 = computeDiff(snapshot2, canonical2);
    assert(
      diff2.counts.new_events === 0 &&
      diff2.counts.updated_events === 0 &&
      diff2.counts.confirmed_upgrades === 0 &&
      diff2.counts.confirmations === 0 &&
      diff2.counts.removed_events === 0,
      'test2: repeat upload should produce zero diff'
    );
    console.log('[m3] test2 passed: repeat upload diff=0');

    // === Test 3: smartlab поверх investmint → склейка, confirmations > 0 ===
    const { diff: diff3 } = await loadProviderFixture('smartlab', 'smartlab.json');
    assert(diff3.counts.confirmations > 0, 'test3: expected confirmations > 0 from cross-provider overlap');
    console.log('[m3] test3 passed: smartlab confirmations=', diff3.counts.confirmations);

    // === Test 4: файл без одного события → removed_events > 0 ===
    // М7: ingest не удаляет архив (date < server_date − 14) — поэтому тест
    // строим на синтетических живых датах внутри окна.
    await resetCalendarTables();
    const t4base = new Date(serverDate + 'T00:00:00Z');
    const makeT4Rows = (count) => {
      const rows = [];
      for (let i = 0; i < count; i++) {
        const d = new Date(t4base);
        d.setUTCDate(d.getUTCDate() + i);
        rows.push({
          source: 'investmint',
          date: d.toISOString().slice(0, 10),
          weekday: 'вт',
          title: `T4 event ${i}`,
          kind: 'МСФО',
          status: 'expected',
          company: 'X',
          ticker: 'X',
        });
      }
      return rows;
    };
    const rows4full = makeT4Rows(5);
    await ingestLive('investmint', rows4full);
    // Срез без первого события.
    const snapshot4 = await getCanonicalSnapshot();
    const { canonical: canonical4 } = await ingestLive('investmint', rows4full.slice(1));
    const diff4 = computeDiff(snapshot4, canonical4);
    assert(diff4.counts.removed_events > 0, `test4: expected removed_events > 0, got ${diff4.counts.removed_events}`);
    console.log('[m3] test4 passed: removed_events=', diff4.counts.removed_events);

    // === Test 5: dry_run не пишет, но diff считает ===
    await resetCalendarTables();
    await loadProviderFixture('investmint', 'investmint.json');
    const beforeRaw = await query(`SELECT COUNT(*) as c FROM calendar_events_raw`);
    const beforeCanonical = await query(`SELECT COUNT(*) as c FROM calendar_events`);
    const beforeSources = await query(`SELECT COUNT(*) as c FROM calendar_sources`);
    // dry_run заменит investmint на smartlab.
    const smartRaw = readFixture('smartlab.json');
    const smartEvents = smartlabAdapter.parse(smartRaw).events;
    const smartRows = toRawRows(smartEvents, 'smartlab');
    const snapshot5 = await getCanonicalSnapshot();
    const { canonical: dryCanonical } = await ingestProviderSlice('smartlab', smartRows, true);
    const diff5 = computeDiff(snapshot5, dryCanonical);
    const afterRaw = await query(`SELECT COUNT(*) as c FROM calendar_events_raw`);
    const afterCanonical = await query(`SELECT COUNT(*) as c FROM calendar_events`);
    const afterSources = await query(`SELECT COUNT(*) as c FROM calendar_sources`);
    assert(
      Number(afterRaw.rows[0].c) === Number(beforeRaw.rows[0].c) &&
      Number(afterCanonical.rows[0].c) === Number(beforeCanonical.rows[0].c) &&
      Number(afterSources.rows[0].c) === Number(beforeSources.rows[0].c),
      'test5: dry_run should not modify tables'
    );
    assert(
      diff5.counts.new_events > 0 || diff5.counts.confirmations > 0,
      'test5: dry_run should still compute non-empty diff'
    );
    console.log('[m3] test5 passed: dry_run preserved tables, diff new_events=', diff5.counts.new_events);

    // === Test 6: отклонение битых/пустых/коротких срезов ===
    const emptyRes = validateProviderSlice('investmint', [], serverDate);
    assert(emptyRes.reject, 'test6: empty array should be rejected');

    const fewDaysRaw = [
      { date: '28 августа пт', events: ['МСФО X      А Акрон AKRN'] },
      { date: '29 августа сб', events: ['МСФО Y      С Сбер SBER'] },
      { date: '30 августа вс', events: ['МСФО Z      Л Лукойл LKOH'] },
    ];
    const fewEvents = investmintAdapter.parse(fewDaysRaw).events;
    const fewRes = validateProviderSlice('investmint', fewEvents, serverDate);
    assert(fewRes.reject, 'test6: <5 unique dates should be rejected');

    const unknownRaw = [{ foo: 'bar' }];
    const unknownDetect = detectAdapter(unknownRaw);
    assert(!unknownDetect.adapter && !unknownDetect.ambiguous, 'test6: unknown format should not detect');
    const unknownEvents = [];
    const unknownRes = validateProviderSlice('auto', unknownEvents, serverDate);
    assert(unknownRes.reject, 'test6: unknown format should reject');

    // Данные не пострадали: таблицы остались как после test5.
    const afterBadRaw = await query(`SELECT COUNT(*) as c FROM calendar_events_raw`);
    assert(
      Number(afterBadRaw.rows[0].c) === Number(beforeRaw.rows[0].c),
      'test6: invalid uploads should not touch existing data'
    );
    console.log('[m3] test6 passed: invalid slices rejected');

    // === Test 7: per-provider stale alerts ===
    await resetCalendarTables();
    // Админ для алертов.
    await query(`INSERT INTO users (id, email, username, password_hash, is_admin) VALUES ('admin1', 'admin@test', 'admin', 'x', 1)`);
    await query(`INSERT INTO admin_tg_settings (id, admin_user_id, tg_chat_id, is_active) VALUES ('s1', 'admin1', '12345', 1)`);
    // investmint с покрытием в прошлом.
    await query(`INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at) VALUES ('investmint', datetime('now'), NULL)`);
    await query(`INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
                  VALUES ('investmint', '2026-08-25', 'вт', 'Отчёт', 'МСФО', 'expected', 'X', 'X', datetime('now'))`);
    await maybeSendProviderStaleAlerts();
    const investMeta1 = await query(`SELECT last_stale_alert_at FROM calendar_sources WHERE source = 'investmint'`);
    assert(investMeta1.rows[0].last_stale_alert_at, 'test7: investmint stale alert should update last_stale_alert_at');
    const t1 = investMeta1.rows[0].last_stale_alert_at;
    await maybeSendProviderStaleAlerts();
    const investMeta2 = await query(`SELECT last_stale_alert_at FROM calendar_sources WHERE source = 'investmint'`);
    assert(investMeta2.rows[0].last_stale_alert_at === t1, 'test7: cooldown should prevent second alert');
    // legacy не должен алертиться.
    await query(`INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at) VALUES ('legacy', datetime('now'), NULL)`);
    await query(`INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
                  VALUES ('legacy', '2026-08-25', 'вт', 'Отчёт', 'МСФО', 'expected', 'Y', 'Y', datetime('now'))`);
    await maybeSendProviderStaleAlerts();
    const legacyMeta = await query(`SELECT last_stale_alert_at FROM calendar_sources WHERE source = 'legacy'`);
    assert(!legacyMeta.rows[0].last_stale_alert_at, 'test7: legacy should not be alerted');
    console.log('[m3] test7 passed: per-provider stale alerts');

    // === Test 8: две параллельные загрузки live-окна сериализуются ===
    await resetCalendarTables();
    const serverDate8 = await getMskDateString();
    const liveDateBase = new Date(serverDate8 + 'T00:00:00Z');
    const makeLiveRows = (prefix, count) => {
      const rows = [];
      for (let i = 0; i < count; i++) {
        const d = new Date(liveDateBase);
        d.setUTCDate(d.getUTCDate() + i);
        const date = d.toISOString().slice(0, 10);
        rows.push({
          source: 'investmint',
          date,
          weekday: 'вт',
          title: `${prefix} event ${i}`,
          kind: 'МСФО',
          status: 'expected',
          company: 'X',
          ticker: 'X',
        });
      }
      return rows;
    };
    const rowsA8 = makeLiveRows('A', 5);
    const rowsB8 = makeLiveRows('B', 5);
    const [resA8, resB8] = await Promise.all([
      ingestProviderSlice('investmint', rowsA8, false),
      ingestProviderSlice('investmint', rowsB8, false),
    ]);
    assert(resA8.queued === true && resB8.queued === true, 'test8: live ingest should return queued=true');
    await flushCanonicalRewrites();
    const rawCount8 = await query(`SELECT COUNT(*) as c FROM calendar_events_raw WHERE source = 'investmint'`);
    const canonicalCount8 = await query(`SELECT COUNT(*) as c FROM calendar_events`);
    assert(
      Number(rawCount8.rows[0].c) === rowsA8.length || Number(rawCount8.rows[0].c) === rowsB8.length,
      'test8: parallel ingests should serialize, leaving one slice'
    );
    assert(
      Number(canonicalCount8.rows[0].c) === rowsA8.length || Number(canonicalCount8.rows[0].c) === rowsB8.length,
      'test8: canonical should be consistent with final slice'
    );
    console.log('[m3] test8 passed: parallel ingests serialized, final raw rows=', rawCount8.rows[0].c);

    // === Test 9: last_warnings сохраняются в calendar_sources ===
    await resetCalendarTables();
    const investRaw9 = readFixture('investmint.json');
    const events9 = investmintAdapter.parse(investRaw9).events;
    const rows9 = toRawRows(events9, 'investmint');
    await ingestProviderSlice('investmint', rows9, false, ['warning one', 'warning two']);
    await flushCanonicalRewrites();
    const meta9 = await query(`SELECT last_warnings FROM calendar_sources WHERE source = 'investmint'`);
    const savedWarnings = JSON.parse(meta9.rows[0].last_warnings || '[]');
    assert(
      Array.isArray(savedWarnings) && savedWarnings.length === 2 && savedWarnings[0] === 'warning one',
      'test9: last_warnings should persist in calendar_sources'
    );
    console.log('[m3] test9 passed: last_warnings persisted');

    // === Test 10: mixed-script company names merge by ticker ===
    await resetCalendarTables();
    const rows10 = [
      { source: 'investmint', date: '2026-09-01', weekday: 'вт', title: 'МСФО 2КВ2026', kind: 'МСФО', status: 'expected', company: 'ПАО «Сбербанк»', ticker: 'SBER' },
      { source: 'smartlab', date: '2026-09-01', weekday: 'вт', title: 'МСФО 2КВ2026', kind: 'МСФО', status: 'expected', company: 'Сбербанк', ticker: 'SBER' },
    ];
    await ingestProviderSlice('investmint', [rows10[0]], false);
    await ingestProviderSlice('smartlab', [rows10[1]], false);
    await flushCanonicalRewrites();
    const canonical10 = await query(`SELECT COUNT(*) as c FROM calendar_events WHERE ticker = 'SBER'`);
    assert(Number(canonical10.rows[0].c) === 1, `test10: expected 1 canonical SBER row, got ${canonical10.rows[0].c}`);
    const sources10 = await query(`SELECT sources FROM calendar_events WHERE ticker = 'SBER'`);
    const srcArr = JSON.parse(sources10.rows[0].sources || '[]');
    assert(srcArr.includes('investmint') && srcArr.includes('smartlab'), 'test10: merged row should contain both sources');
    console.log('[m3] test10 passed: mixed-script company names merged');

    console.log('\n[M3 VERIFY] ALL TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('[M3 VERIFY] FAILED:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
