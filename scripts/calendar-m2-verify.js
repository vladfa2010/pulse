/**
 * Verify-скрипт для ТЗ М2: модуль адаптеров провайдеров.
 * Запуск: npm run verify:calendarAdapters
 */

const fs = require('fs');
const path = require('path');
const {
  investmintAdapter,
  smartlabAdapter,
  bcsAdapter,
  detectAdapter,
  toRawRows,
} = require(path.join(__dirname, '..', 'dist', 'services', 'calendarAdapters', 'index.js'));

const fixturesDir = path.join(__dirname, '..', 'tests', 'calendarAdapters', 'fixtures');
const referencePath = path.join(__dirname, '..', 'tests', 'calendarAdapters', 'reference', 'frontend.js');
const { parseInvestmintCalendar, parseSmartlabCalendar } = require(referencePath);

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
}

function eventKey(e) {
  const tickers = e.companies.map(c => c.ticker).sort().join(',')
  return `${e.date}|${e.title}|${e.kind}|${e.status}|${tickers}`
}

function flattenInvestmintFrontend(days) {
  const events = []
  for (const day of days) {
    for (const g of day.groups) {
      events.push({ date: day.date, weekday: day.weekday, title: g.title, kind: g.kind, status: g.status, companies: g.companies })
    }
  }
  return events
}

function flattenSmartlabFrontend(result) {
  const events = []
  for (const day of result.days) {
    for (const g of day.groups) {
      events.push({ date: day.date, weekday: day.weekday, title: g.title, kind: g.kind, status: g.status, companies: g.companies })
    }
  }
  return events
}

function parity(backendEvents, frontendEvents, label) {
  const be = backendEvents.map(eventKey).sort()
  const fe = frontendEvents.map(eventKey).sort()
  assert(be.length === fe.length, `${label} parity length mismatch: backend=${be.length}, frontend=${fe.length}`)
  for (let i = 0; i < be.length; i++) {
    assert(be[i] === fe[i], `${label} parity mismatch at ${i}: backend=${be[i]} frontend=${fe[i]}`)
  }
  console.log(`[parity] ${label}: ${be.length} events match`)
}

function main() {
  // 1. Investmint fixture
  const investRaw = readFixture('investmint.json');
  const investScore = investmintAdapter.detect(investRaw);
  const smartOnInvest = smartlabAdapter.detect(investRaw);
  console.log(`[investmint] detect=${investScore.toFixed(2)}, smartlab-on-investmint=${smartOnInvest.toFixed(2)}`);
  assert(investScore >= 0.5, `investmint detect expected >=0.5, got ${investScore}`);
  assert(smartOnInvest < 0.5, `smartlab on investmint expected <0.5, got ${smartOnInvest}`);

  const investRes = investmintAdapter.parse(investRaw);
  console.log(`[investmint] events=${investRes.events.length}, skipped=${investRes.warnings.skipped}`);
  assert(investRes.events.length > 0, 'investmint events expected >0');
  assert(investRes.warnings.invalidDates === 0, `investmint invalidDates expected 0, got ${investRes.warnings.invalidDates}`);
  const weekdayMismatches = investRes.warnings.details.filter(d => d.includes('weekday mismatch'));
  assert(weekdayMismatches.length === 0, `investmint weekday mismatches expected 0, got ${weekdayMismatches.length}: ${weekdayMismatches.join('; ')}`);
  // СД по дивидендам → СД
  assert(
    investRes.events.some(e => e.title.toLowerCase().includes('дивиденд') && e.kind === 'СД'),
    'investmint: СД по дивидендам should be СД'
  );
  assert(
    investRes.events.every(e => e.companies.length > 0),
    'investmint: every event should have at least one company'
  );

  // Parity investmint
  parity(investRes.events, flattenInvestmintFrontend(parseInvestmintCalendar(investRaw)), 'investmint');

  // 2. Smartlab fixture
  const smartRaw = readFixture('smartlab.json');
  const smartScore = smartlabAdapter.detect(smartRaw);
  const investOnSmart = investmintAdapter.detect(smartRaw);
  console.log(`[smartlab] detect=${smartScore.toFixed(2)}, investmint-on-smartlab=${investOnSmart.toFixed(2)}`);
  assert(smartScore >= 0.5, `smartlab detect expected >=0.5, got ${smartScore}`);
  assert(investOnSmart < 0.5, `investmint on smartlab expected <0.5, got ${investOnSmart}`);

  const smartRes = smartlabAdapter.parse(smartRaw);
  console.log(`[smartlab] events=${smartRes.events.length}, noTicker=${smartRes.warnings.noTicker}`);
  assert(smartRes.events.length > 0, 'smartlab events expected >0');
  assert(smartRes.warnings.noTicker > 0, `smartlab noTicker expected >0, got ${smartRes.warnings.noTicker}`);
  assert(
    smartRes.events.some(e => e.companies.some(c => c.ticker === 'UNKNOWN')),
    'smartlab expected at least one UNKNOWN ticker'
  );
  // СД по дивидендам → СД
  assert(
    smartRes.events.some(e => e.title.toLowerCase().includes('дивиденд') && e.kind === 'СД'),
    'smartlab: СД по дивидендам should be СД'
  );

  // Parity smartlab
  parity(smartRes.events, flattenSmartlabFrontend(parseSmartlabCalendar(smartRaw)), 'smartlab');

  // 3. toRawRows shape and contents
  const investRows = toRawRows(investRes.events, 'investmint');
  assert(investRows.length > 0, 'investmint toRawRows expected >0');
  const expectedInvestRowCount = investRes.events.reduce((sum, e) => sum + e.companies.length, 0);
  assert(investRows.length === expectedInvestRowCount, `investmint row count mismatch: expected ${expectedInvestRowCount}, got ${investRows.length}`);
  assert(
    investRows.every(r => r.source === 'investmint' && r.date && r.title && r.kind && r.company && r.ticker),
    'investmint raw rows shape invalid'
  );
  assert(
    investRows.every(r => r.ticker === r.ticker.toUpperCase()),
    'investment tickers must be uppercase in raw rows'
  );
  const investKeys = new Set(investRows.map(r => `${r.date}|${r.title}|${r.kind}|${r.company}|${r.ticker}`));
  assert(investKeys.size === investRows.length, 'investmint raw rows contain duplicates');

  const smartRows = toRawRows(smartRes.events, 'smartlab');
  assert(smartRows.length > 0, 'smartlab toRawRows expected >0');
  assert(
    smartRows.every(r => r.source === 'smartlab' && r.status && r.company && r.ticker),
    'smartlab raw rows shape invalid'
  );

  // 3a. smartlab status must respect detectStatus (synthetic expected title)
  const syntheticSmartlab = [
    { date: '28.08.2026', title: 'MGKL: Ожидается презентация отчёта' },
  ];
  const syntheticRes = smartlabAdapter.parse(syntheticSmartlab);
  assert(syntheticRes.events.length === 1, 'synthetic smartlab expected 1 event');
  assert(syntheticRes.events[0].status === 'expected', 'smartlab expected title must yield status expected');
  assert(syntheticRes.events[0].title === 'Ожидается презентация отчёта', 'smartlab title should strip ticker prefix');

  // 4. Registry detect
  const d1 = detectAdapter(investRaw);
  assert(d1.adapter && d1.adapter.source === 'investmint', 'registry should pick investmint');
  assert(!d1.ambiguous, 'investmint should not be ambiguous');

  const d2 = detectAdapter(smartRaw);
  assert(d2.adapter && d2.adapter.source === 'smartlab', 'registry should pick smartlab');
  assert(!d2.ambiguous, 'smartlab should not be ambiguous');

  const chimera = [
    { date: '28 августа ср', events: [] },
    { date: '28.08.2026', title: 'Event' },
  ];
  const d3 = detectAdapter(chimera);
  assert(d3.ambiguous, 'chimera should be ambiguous');

  const unknown = [{ foo: 'bar' }];
  const d4 = detectAdapter(unknown);
  assert(d4.adapter === null && !d4.ambiguous, 'unknown should not match');

  // 5. BCS slot
  assert(bcsAdapter.detect(investRaw) === 0, 'bcs detect should be 0');
  try {
    bcsAdapter.parse(investRaw);
    assert(false, 'bcs parse should throw');
  } catch (e) {
    assert(e.message.includes('not implemented'), 'bcs parse message expected');
  }

  console.log('\n[M2 VERIFY] ALL TESTS PASSED');
}

main();
