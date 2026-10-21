/**
 * =============================================================================
 * PULSE — ТЗ-190: статистика безопасности /mcp и ежедневный алертинг
 * =============================================================================
 *
 * Прогон: USE_SQLITE=true npx ts-node --transpile-only src/tests/mcpSecurity.test.ts
 *
 * Покрытие:
 *   1. recordMcpRequest/AuthFail/AuthLimited/TokenLimited + flush — дельты
 *      корректно аккумулируются в mcp_security_daily, уникальные IP — в
 *      mcp_security_daily_ips (дедуп).
 *   2. evaluateMcpSecurityDay: доля 401 > 10 % → алерт auth_fail_share;
 *      повторный прогон того же дня алерт НЕ дублирует (UNIQUE(day, metric)).
 *   3. Спокойный день (доля 401 в норме, 429 в норме, трафик как обычно) →
 *      алертов нет.
 *   4. Всплеск 429 (> max(10, 10× базовая линия)) → алерт rate_limit_429.
 *   5. Всплеск запросов (> max(100, 10× базовая линия)) → алерт request_spike.
 *   6. День с трафиком < MIN_DAILY_REQUESTS оценке не подлежит.
 */

process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
// Глушим транспорты на случай локального .env
process.env.RESEND_API_KEY = '';
process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = '';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';

// Динамические импорты (ниже, в main()) — DB_FILE в db-sqlite вычисляется при
// загрузке модуля, статический импорт опередил бы установку SQLITE_FILE.
let query: typeof import('../config/db').query;
let mskDay: typeof import('../mcp/securityStats').mskDay;
let recordMcpRequest: typeof import('../mcp/securityStats').recordMcpRequest;
let recordMcpAuthFail: typeof import('../mcp/securityStats').recordMcpAuthFail;
let recordMcpAuthLimited: typeof import('../mcp/securityStats').recordMcpAuthLimited;
let recordMcpTokenLimited: typeof import('../mcp/securityStats').recordMcpTokenLimited;
let flushMcpSecurityStats: typeof import('../mcp/securityStats').flushMcpSecurityStats;
let evaluateMcpSecurityDay: typeof import('../services/mcpSecurity').evaluateMcpSecurityDay;
let MIN_DAILY_REQUESTS: number;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

async function seedDay(day: string, c: { requests: number; fail401: number; auth429: number; token429: number }) {
  await query(
    `INSERT INTO mcp_security_daily (day, requests_total, auth_fail_401, auth_limited_429, token_limited_429)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [day, c.requests, c.fail401, c.auth429, c.token429],
  );
}

async function main(): Promise<void> {
  process.env.SQLITE_FILE = require('os').tmpdir() + `/mcp-security-test-${Date.now()}.db`;
  const sqlite = await import('../config/db-sqlite');
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();

  ({ query } = await import('../config/db'));
  const securityStats = await import('../mcp/securityStats');
  ({ mskDay, recordMcpRequest, recordMcpAuthFail, recordMcpAuthLimited, recordMcpTokenLimited, flushMcpSecurityStats } = securityStats);
  const mcpSecurity = await import('../services/mcpSecurity');
  ({ evaluateMcpSecurityDay, MIN_DAILY_REQUESTS } = mcpSecurity);

  await query(`CREATE TABLE IF NOT EXISTS mcp_security_daily (
    day DATE PRIMARY KEY,
    requests_total INTEGER NOT NULL DEFAULT 0,
    auth_fail_401 INTEGER NOT NULL DEFAULT 0,
    auth_limited_429 INTEGER NOT NULL DEFAULT 0,
    token_limited_429 INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT (datetime('now')),
    updated_at TIMESTAMP DEFAULT (datetime('now'))
  )`);
  await query(`CREATE TABLE IF NOT EXISTS mcp_security_daily_ips (
    day DATE NOT NULL,
    ip VARCHAR(45) NOT NULL,
    PRIMARY KEY (day, ip)
  )`);
  await query(`CREATE TABLE IF NOT EXISTS mcp_security_alerts (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    day DATE NOT NULL,
    metric VARCHAR(40) NOT NULL,
    value DOUBLE PRECISION NOT NULL,
    threshold DOUBLE PRECISION,
    detail TEXT,
    created_at TIMESTAMP DEFAULT (datetime('now')),
    UNIQUE(day, metric)
  )`);

  // ── 1. Счётчики + flush ─────────────────────────────────────────────────
  const today = mskDay();
  for (let i = 0; i < 100; i++) recordMcpRequest(`10.0.0.${i % 10}`);
  for (let i = 0; i < 15; i++) recordMcpAuthFail();
  recordMcpAuthLimited();
  recordMcpTokenLimited();
  await flushMcpSecurityStats();

  const row1 = await query('SELECT * FROM mcp_security_daily WHERE day = $1', [today]);
  const r1 = row1.rows[0];
  check('flush: requests_total=100', Number(r1?.requests_total) === 100, r1);
  check('flush: auth_fail_401=15', Number(r1?.auth_fail_401) === 15, r1);
  check('flush: auth_limited_429=1, token_limited_429=1', Number(r1?.auth_limited_429) === 1 && Number(r1?.token_limited_429) === 1, r1);
  const ips1 = await query('SELECT COUNT(*) AS n FROM mcp_security_daily_ips WHERE day = $1', [today]);
  check('flush: 10 уникальных IP за день', Number(ips1.rows[0]?.n) === 10, ips1.rows[0]);

  // ── 2. Доля 401 > 10 % → алерт, идемпотентность ─────────────────────────
  const dBad = mskDay(-1);
  for (let i = 2; i <= 8; i++) await seedDay(mskDay(-i), { requests: 200, fail401: 5, auth429: 0, token429: 0 });
  await seedDay(dBad, { requests: 200, fail401: 40, auth429: 0, token429: 0 }); // 20 %

  const evalBad = await evaluateMcpSecurityDay(dBad);
  check('алерт auth_fail_share при доле 20 %', evalBad.alerts.some((a) => a.metric === 'auth_fail_share'), evalBad.alerts);
  const alertsAfter1 = await query('SELECT COUNT(*) AS n FROM mcp_security_alerts WHERE day = $1', [dBad]);
  check('в ленте ровно 1 алерт за день', Number(alertsAfter1.rows[0]?.n) === 1, alertsAfter1.rows[0]);

  const evalBad2 = await evaluateMcpSecurityDay(dBad);
  check('повторный прогон не дублирует алерт', evalBad2.alerts.length === 0, evalBad2.alerts);
  const alertsAfter2 = await query('SELECT COUNT(*) AS n FROM mcp_security_alerts WHERE day = $1', [dBad]);
  check('в ленте всё ещё 1 алерт', Number(alertsAfter2.rows[0]?.n) === 1, alertsAfter2.rows[0]);

  // ── 3. Спокойный день → алертов нет ─────────────────────────────────────
  const dQuiet = mskDay(-10);
  for (let i = 11; i <= 17; i++) await seedDay(mskDay(-i), { requests: 200, fail401: 5, auth429: 0, token429: 0 });
  await seedDay(dQuiet, { requests: 210, fail401: 5, auth429: 0, token429: 0 });
  const evalQuiet = await evaluateMcpSecurityDay(dQuiet);
  check('спокойный день: алертов нет', evalQuiet.alerts.length === 0, evalQuiet.alerts);

  // ── 4. Всплеск 429 ──────────────────────────────────────────────────────
  const d429 = mskDay(-20);
  for (let i = 21; i <= 27; i++) await seedDay(mskDay(-i), { requests: 200, fail401: 0, auth429: 0, token429: 0 });
  await seedDay(d429, { requests: 250, fail401: 0, auth429: 15, token429: 0 }); // порог max(10, 0)=10
  const eval429 = await evaluateMcpSecurityDay(d429);
  check('алерт rate_limit_429 при 15 срабатываниях', eval429.alerts.some((a) => a.metric === 'rate_limit_429'), eval429.alerts);

  // ── 5. Всплеск запросов ─────────────────────────────────────────────────
  const dSpike = mskDay(-30);
  for (let i = 31; i <= 37; i++) await seedDay(mskDay(-i), { requests: 20, fail401: 1, auth429: 0, token429: 0 });
  await seedDay(dSpike, { requests: 500, fail401: 5, auth429: 0, token429: 0 }); // порог max(100, 200)=200
  const evalSpike = await evaluateMcpSecurityDay(dSpike);
  check('алерт request_spike при 500 против базовых 20', evalSpike.alerts.some((a) => a.metric === 'request_spike'), evalSpike.alerts);

  // ── 6. Малотрафиковый день пропускается ─────────────────────────────────
  const dLow = mskDay(-40);
  await seedDay(dLow, { requests: MIN_DAILY_REQUESTS - 1, fail401: 40, auth429: 0, token429: 0 });
  const evalLow = await evaluateMcpSecurityDay(dLow);
  check(`день с трафиком < ${MIN_DAILY_REQUESTS} не оценивается`, evalLow.alerts.length === 0, evalLow.alerts);

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});

export {}; // модуль: изоляция от глобальных имён других *.test.ts-скриптов
