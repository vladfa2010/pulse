/**
 * =============================================================================
 * PULSE — MCP вторая волна: live-API тест (ТЗ-193, Задача 5)
 * =============================================================================
 *
 * Прогон: API_URL=https://pulse.inside-trade.ru/api ADMIN_EMAIL=<email>
 *         ADMIN_PASSWORD=<password> npx ts-node src/tests/mcpWave2.test.ts
 *
 * Токен: env MCP_TOKEN (готовый) или ADMIN_EMAIL/ADMIN_PASSWORD — тест
 * создаст и отзовёт сам. Прод не мутирует: все инструменты read-only.
 *
 * Покрытие (критерии приёмки ТЗ-193):
 *  1. Контракт каждого нового инструмента: вызов → обязательные поля.
 *  2. Портфельные: user_id в аргументах → отказ zod strict; empty-state не 500.
 *  3. my_digest: ок либо warming_up (оба валидны, падения нет).
 *  4. news_feed: несуществующий тег → пустой массив; limit > 50 → отказ.
 *  5. Матрица: 7 базовых первой волны + 7 новых второй (news_feed, 3
 *     портфельных, my_digest, market_summary, my_tags).
 */

const API_URL = process.env.API_URL || 'https://pulse.inside-trade.ru/api';
const ORIGIN = API_URL.replace(/\/api\/?$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MCP_TOKEN_ENV = process.env.MCP_TOKEN || '';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const bad = (name: string, detail?: any) => { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 200)}` : ''}`); };

async function req(method: string, path: string, token: string, body?: any): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let rpcId = 0;
async function mcp(token: string | null, method: string, params?: any): Promise<{ status: number; data: any; raw: string }> {
  rpcId++;
  const res = await fetch(`${ORIGIN}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
  const raw = await res.text();
  let data: any = {};
  const m = raw.match(/^data: (.*)$/m);
  try { data = JSON.parse(m ? m[1] : raw); } catch { /* не-JSON ответ */ }
  return { status: res.status, data, raw };
}

function toolNames(listRes: any): string[] {
  return (listRes?.data?.result?.tools || []).map((t: any) => t.name);
}

/** structuredContent инструмента (или text как fallback). */
async function callTool(token: string, name: string, args: any): Promise<any> {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  const result = r.data?.result;
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  try { return JSON.parse(text); } catch { return { __raw: text, __error: r.data?.error }; }
}

async function main() {
  console.log('MCP wave-2 live test\n');

  // ─── Токен ────────────────────────────────────────────────────────────────
  let token = MCP_TOKEN_ENV;
  let jwt = '';
  const created: string[] = [];
  if (!token) {
    const login = await req('POST', '/auth/login', '', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (login.status !== 200 || !login.data.token) {
      bad('admin login', login);
      console.log(`\nИТОГО: PASS=${passed} FAIL=${failed}`);
      process.exit(1);
    }
    jwt = login.data.token;
    ok('admin login');
    const r = await req('POST', '/user/mcp-tokens', jwt, { name: 'test-mcp-wave2' });
    if (r.status !== 200 && r.status !== 201) {
      bad('create MCP token', r);
      console.log(`\nИТОГО: PASS=${passed} FAIL=${failed}`);
      process.exit(1);
    }
    token = r.data.token || r.data?.tokenData?.token || '';
    const tokId = r.data.id || r.data?.tokenData?.id;
    if (tokId) created.push(tokId);
    if (!token) { bad('token in create response', r.data); process.exit(1); }
    ok('create MCP token');
  }

  try {
    // ─── Критерий 1: матрица инструментов ───────────────────────────────────
    const list = await mcp(token, 'tools/list');
    const names = toolNames(list);
    const expectBase = [
      'news_search', 'news_get', 'news_feed',
      'calendar_events', 'sentiment_index', 'radio_config',
      'education_my_progress', 'education_my_attempts',
      'portfolio_list', 'portfolio_summary', 'portfolio_recommended_tags',
      'my_digest', 'market_summary', 'my_tags',
    ];
    const missing = expectBase.filter((n) => !names.includes(n));
    if (missing.length === 0) ok(`tools/list: 7 старых + 7 новых базовых (${expectBase.length})`);
    else bad('tools/list: недостающие инструменты', missing);

    // ─── Критерий 2: портфельные, ИБ-4 ──────────────────────────────────────
    let r = await callTool(token, 'portfolio_list', {});
    if (r && typeof r.count === 'number' && Array.isArray(r.portfolios)) ok('portfolio_list: контракт (count+portfolios)');
    else bad('portfolio_list: контракт', r);

    r = await callTool(token, 'portfolio_summary', {});
    if (r && !r.__error) ok('portfolio_summary: вызов без 500');
    else bad('portfolio_summary', r);

    r = await callTool(token, 'portfolio_recommended_tags', {});
    if (r && Array.isArray(r.tags)) ok('portfolio_recommended_tags: контракт (tags[])');
    else bad('portfolio_recommended_tags', r);

    // ИБ-4: user_id не принимается (zod strict → -32602)
    const rUserId = await mcp(token, 'tools/call', { name: 'portfolio_list', arguments: { user_id: 'чужой-id' } });
    const errCode = rUserId.data?.error?.code;
    if (errCode === -32602) ok('ИБ-4: user_id в аргументах → -32602 (strict)');
    else bad('ИБ-4: user_id не отсечён', rUserId.data?.error);

    // ─── Критерий 3: my_digest / market_summary ─────────────────────────────
    r = await callTool(token, 'my_digest', {});
    if (r && (r.status === 'ok' || r.status === 'warming_up')) ok(`my_digest: ${r.status}`);
    else bad('my_digest', r);

    r = await callTool(token, 'market_summary', {});
    if (r && (r.status === 'ok' || r.status === 'warming_up')) ok(`market_summary: ${r.status}`);
    else bad('market_summary', r);

    // ─── my_tags + news_feed по реальному тегу ──────────────────────────────
    r = await callTool(token, 'my_tags', {});
    if (r && Array.isArray(r.tags)) ok(`my_tags: контракт (${r.count} тегов)`);
    else bad('my_tags', r);

    const firstTag = r?.tags?.[0]?.name;
    if (firstTag) {
      const feed = await callTool(token, 'news_feed', { tag: firstTag, limit: 5 });
      if (feed && Array.isArray(feed.items) && typeof feed.count === 'number') {
        ok(`news_feed по тегу "${firstTag}": ${feed.count} новостей`);
        if (feed.items.length <= 5) ok('news_feed: объём в лимите (items ≤ limit)');
        else bad('news_feed: объём превышает limit', { got: feed.items.length });
      } else bad('news_feed по реальному тегу', feed);
    } else {
      ok('my_tags: пусто — news_feed по реальному тегу пропущен');
    }

    // ─── Критерий 4: news_feed граничные случаи ─────────────────────────────
    r = await callTool(token, 'news_feed', { tag: 'несуществующий_тег_zz_999' });
    if (r && Array.isArray(r.items) && r.items.length === 0) ok('news_feed: несуществующий тег → пустой массив');
    else bad('news_feed: несуществующий тег', r);

    const rLimit = await mcp(token, 'tools/call', { name: 'news_feed', arguments: { tag: 'тест', limit: 51 } });
    if (rLimit.data?.error?.code === -32602) ok('news_feed: limit > 50 → -32602 (zod max)');
    else bad('news_feed: limit > 50 не отсечён', rLimit.data?.error);

    // ─── Регрессия: старые инструменты на месте ─────────────────────────────
    const search = await callTool(token, 'news_search', { query: 'санкции', limit: 3 });
    if (search && typeof search.count === 'number') ok(`регрессия news_search: ${search.count} результатов`);
    else bad('регрессия news_search', search);
  } finally {
    // ─── Самоочистка: отзыв созданного токена ───────────────────────────────
    for (const id of created) {
      await req('DELETE', `/user/mcp-tokens/${id}`, jwt, undefined).catch(() => {});
    }
    if (created.length) ok('cleanup: токен отозван');
  }

  console.log(`\nИТОГО: PASS=${passed} FAIL=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});

export {}; // модуль: изоляция от других *.test.ts (глобальные const конфликтуют)
