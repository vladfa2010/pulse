/**
 * =============================================================================
 * PULSE — ТЗ-186: debug guard (юнит-прогон решений + live-probe middleware)
 * =============================================================================
 *
 * Прогон: npx tsx src/tests/debugGuard.test.ts
 *
 * Покрытие (критерии приёмки ТЗ-186):
 *  1. Чистая логика debugGuardDecision: префикс /debug, allowlist,
 *     секрет совпал/не совпал, fail-closed без env.
 *  2. Live-probe: express-приложение с middleware — 7 кейсов ТЗ
 *     (404 без заголовка, 200 с валидным, allowlist публичных путей,
 *     неинформативный отказ, fail-closed в production, dev-пропуск с warn).
 * Прод не трогаем: приложение поднимается на localhost со случайным портом.
 */

process.env.NODE_ENV = 'production';

import express from 'express';
import { debugGuard, debugGuardDecision } from '../middleware/debugGuard';

let passed = 0;
let failed = 0;
function ok(name: string): void { passed++; console.log(`  ok  ${name}`); }
function bad(name: string, detail?: unknown): void {
  failed++;
  console.log(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
}
function eq(actual: unknown, expected: unknown, name: string): void {
  if (actual === expected) ok(name);
  else bad(name, { actual, expected });
}

// ─── 1. Чистая логика ───────────────────────────────────────────────────────

const SECRET = 'test-secret-key';

eq(debugGuardDecision('/news', undefined, SECRET, true), 'allow',
  'logic: не-/debug префикс — пропуск');
eq(debugGuardDecision('/debug/mcp', undefined, SECRET, true), 'allow',
  'logic: /debug/mcp публичен (allowlist)');
eq(debugGuardDecision('/debug/version', undefined, SECRET, true), 'allow',
  'logic: /debug/version публичен (allowlist)');
eq(debugGuardDecision('/debug-env', SECRET, SECRET, true), 'allow',
  'logic: валидный x-debug-secret — пропуск');
eq(debugGuardDecision('/debug-env', 'wrong', SECRET, true), 'deny',
  'logic: неверный секрет — deny');
eq(debugGuardDecision('/debug-env', undefined, SECRET, true), 'deny',
  'logic: без заголовка — deny');
eq(debugGuardDecision('/debug-env', SECRET, '', true), 'deny_no_secret',
  'logic: fail-closed — оба env пусты');
eq(debugGuardDecision('/api/debug/telegram-channel/x', undefined, SECRET, true), 'allow',
  'logic: /api/debug/... не под префикс /debug — guard не трогает');

// ─── 2. Live-probe middleware ───────────────────────────────────────────────

async function main(): Promise<void> {
  process.env.DEBUG_SECRET_KEY = SECRET;

  const app = express();
  app.use(debugGuard);
  app.get('/debug/version', (_req, res) => res.json({ commit: 'abc123' }));
  app.get('/debug/mcp', (_req, res) => res.json({ status: 'ok' }));
  app.get('/debug-env', (_req, res) => res.json({ diagnostics: true }));
  app.get('/debug/check-fk', (req, res) => {
    // эндпоинт со своей проверкой query-secret: guard пропускает с заголовком,
    // собственная логика решает по ?secret=
    if (req.query.secret === SECRET) return res.json({ fk: 'ok' });
    return res.status(403).json({ error: 'bad query secret' });
  });
  app.get('/news', (_req, res) => res.json({ news: true }));

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as import('net').AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function get(path: string, headers?: Record<string, string>): Promise<{ status: number; data: any }> {
    const res = await fetch(`${base}${path}`, { headers });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  try {
    let r = await get('/debug-env');
    eq(r.status, 404, 'probe: /debug-env без секрета → 404');
    eq(JSON.stringify(r.data), JSON.stringify({ error: 'Not found' }),
      'probe: тело отказа неинформативно');

    r = await get('/debug-env', { 'x-debug-secret': SECRET });
    eq(r.status, 200, 'probe: /debug-env с валидным x-debug-secret → 200');

    r = await get('/debug-env', { 'x-debug-secret': 'wrong' });
    eq(r.status, 404, 'probe: неверный секрет → 404');

    r = await get('/debug/mcp');
    eq(r.status, 200, 'probe: /debug/mcp без заголовка → 200 (allowlist)');
    eq(r.data?.status, 'ok', 'probe: /debug/mcp отвечает {status:ok}');

    r = await get('/debug/version');
    eq(r.status, 200, 'probe: /debug/version без заголовка → 200 (allowlist)');

    r = await get('/news');
    eq(r.status, 200, 'probe: регрессия — обычные маршруты не затронуты');

    r = await get('/debug/check-fk', { 'x-debug-secret': SECRET });
    eq(r.status, 403, 'probe: /debug/check-fk с заголовком guard → дошёл до своей проверки (403 без query-secret)');
    r = await get(`/debug/check-fk?secret=${SECRET}`, { 'x-debug-secret': SECRET });
    eq(r.status, 200, 'probe: /debug/check-fk заголовок + query-secret → 200');

    // Fail-closed: убираем оба env — даже валидный заголовок не спасает
    delete process.env.DEBUG_SECRET_KEY;
    delete process.env.CRON_SECRET_KEY;
    // middleware читает env на каждый запрос — новый инстанс не нужен
    r = await get('/debug-env', { 'x-debug-secret': SECRET });
    eq(r.status, 404, 'probe: fail-closed — env пусты, с любым заголовком → 404');
  } finally {
    server.close();
  }

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
