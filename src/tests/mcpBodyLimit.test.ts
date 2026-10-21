/**
 * =============================================================================
 * PULSE — ТЗ-189: лимит тела запроса на /mcp (1 МБ)
 * =============================================================================
 *
 * Прогон: USE_SQLITE=true npx ts-node --transpile-only src/tests/mcpBodyLimit.test.ts
 *
 * Локальный тест: поднимает express-приложение с реальным mountMcp и
 * проверяет цепочку парсеров. Паттерн — app.listen + fetch, как в
 * weeklyReportPage.test.ts (supertest в проекте нет).
 *
 * Покрытие:
 *   1. POST /mcp, тело ~1.5 МБ (валидный JSON) без токена → 413 — лимит
 *      срабатывает ДО auth (порядок middleware, риск из ТЗ).
 *   2. POST /mcp, тело ~10 КБ без токена → НЕ 413 (парсинг прошёл), дошло
 *      до цепочки auth → 401.
 *   3. GET /mcp (SSE-ветка без тела) → НЕ 413.
 *   4. Регрессия type-callback: мини-приложение с тем же wiring, что в
 *      src/index.ts (глобальный 15-МБ парсер, /mcp исключён через type), POST
 *      2 МБ на /api/*-роут → парсится глобальным лимитом, доходит до роута
 *      (type-callback не разлился на API).
 *      Копия wiring — осознанно: фактический index.ts тяжело поднять локально;
 *      боевую проверку даёт live-curl после деплоя.
 */

process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

import express from 'express';
import { mountMcp } from '../mcp';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const MB = 1024 * 1024;

/** Валидный JSON нужного размера: поле blob добивается до целевого веса тела */
function jsonBodyOfSize(bytes: number): string {
  const base = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { blob: '' } };
  const overhead = JSON.stringify(base).length;
  base.params.blob = 'a'.repeat(Math.max(0, bytes - overhead));
  return JSON.stringify(base);
}

async function postRaw(port: number, path: string, rawBody: string, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: rawBody,
  });
  return { status: res.status };
}

async function main(): Promise<void> {
  // ── Приложение 1: реальный mountMcp (проверка 1-МБ лимитера) ──────────────
  const app = express();
  mountMcp(app);
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  // 1. 1.5 МБ без токена → 413 до auth
  const big = await postRaw(port, '/mcp', jsonBodyOfSize(Math.round(1.5 * MB)));
  check('POST /mcp 1.5 МБ без токена → 413 (лимит до auth)', big.status === 413, big.status);

  // 2. 10 КБ без токена → не 413, дошло до auth → 401
  const small = await postRaw(port, '/mcp', jsonBodyOfSize(10 * 1024));
  check('POST /mcp 10 КБ без токена → 401 (не 413)', small.status === 401, small.status);

  // 3. GET /mcp (SSE, без тела) → не 413
  const getRes = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET' });
  check('GET /mcp без тела → не 413', getRes.status !== 413, getRes.status);

  await new Promise((r) => server.close(r));

  // ── Приложение 2: регрессия type-callback (тот же wiring, что src/index.ts) ──
  const app2 = express();
  app2.use(express.json({
    limit: '15mb',
    type: (req) => {
      const p = (req.url || '').split('?')[0];
      if (p === '/mcp' || p.startsWith('/mcp/')) return false;
      const ct = req.headers['content-type'] || '';
      return typeof ct === 'string' && ct.includes('json');
    },
  }));
  mountMcp(app2);
  app2.post('/api/echo-size', (req, res) => {
    res.json({ parsed: typeof req.body === 'object' && req.body !== null });
  });
  const server2 = await new Promise<any>((resolve) => {
    const s = app2.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port2 = server2.address().port;

  // 4a. 2 МБ на /api/* → глобальный 15-МБ парсер принял, дошло до роута
  const apiBig = await postRaw(port2, '/api/echo-size', jsonBodyOfSize(2 * MB));
  check('POST /api/* 2 МБ → не 413 (глобальный лимит 15 МБ цел)', apiBig.status === 200, apiBig.status);

  // 4b. 1.5 МБ на /mcp → по-прежнему 413 (локальный лимит, глобальный type-callback)
  const mcpBig = await postRaw(port2, '/mcp', jsonBodyOfSize(Math.round(1.5 * MB)));
  check('POST /mcp 1.5 МБ (со skip у глобального) → всё равно 413', mcpBig.status === 413, mcpBig.status);

  // 4c. 10 КБ на /mcp → 401, тело распарсено ЛОКАЛЬНЫМ парсером (req.body дошёл до auth)
  const mcpSmall = await postRaw(port2, '/mcp', jsonBodyOfSize(10 * 1024));
  check('POST /mcp 10 КБ → 401 (локальный парсер отработал)', mcpSmall.status === 401, mcpSmall.status);

  await new Promise((r) => server2.close(r));

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
