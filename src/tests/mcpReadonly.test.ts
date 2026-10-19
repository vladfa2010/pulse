/**
 * =============================================================================
 * PULSE — MCP read-only: live-API тест (ТЗ-183, Задача 6)
 * =============================================================================
 *
 * Прогон: API_URL=https://pulse.inside-trade.ru/api ADMIN_EMAIL=<email>
 *         ADMIN_PASSWORD=<password> npx ts-node src/tests/mcpReadonly.test.ts
 *
 * Тест самодостаточный: логинится админом, выпускает MCP-токены через API ЛК,
 * проверяет контур /mcp (JSON-RPC 2025-11-25 stateless), в конце отзывает
 * все созданные токены. Прод-данные не мутирует (только свои токены).
 *
 * Опционально: MCP_TOKEN — готовый юзер-токен (иначе тест создаст сам).
 * RUN_AUTH_FLOOD=1 — проверка mcpAuthLimiter (20 неудач → 429); по умолчанию
 * ВЫКЛючено: заблокирует IP теста на 15 минут (лимитер по IP).
 */

const API_URL = process.env.API_URL || 'https://pulse.inside-trade.ru/api';
const ORIGIN = API_URL.replace(/\/api\/?$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN_AUTH_FLOOD = process.env.RUN_AUTH_FLOOD === '1';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const bad = (name: string, detail?: any) => { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); };

async function req(method: string, path: string, token: string, body?: any): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': token ? `Bearer ${token}` : '' },
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
      'Accept': 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-11-25',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
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

async function callTool(token: string, name: string, args: any): Promise<any> {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  return r.data?.result ?? r.data?.error ?? null;
}

async function main() {
  console.log('MCP read-only live test\n');

  // ─── Подготовка: JWT админа ───────────────────────────────────────────────
  const login = await req('POST', '/auth/login', '', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (login.status !== 200 || !login.data.token) {
    bad('admin login', login);
    console.log(`\nИТОГО: PASS=${passed} FAIL=${failed}`);
    process.exit(1);
  }
  const jwt: string = login.data.token;
  ok('admin login');

  // ─── Токены: выпуск через API ЛК ─────────────────────────────────────────
  const created: string[] = [];
  const createToken = async (name: string): Promise<{ id: string; token: string } | null> => {
    const r = await req('POST', '/user/mcp-tokens', jwt, { name });
    if (r.status !== 201 || !r.data.token) return null;
    created.push(r.data.id);
    return { id: r.data.id, token: r.data.token };
  };

  const adminTok = await createToken('test-mcp-admin');
  if (!adminTok) { bad('создание админ-токена'); finish(); return; }
  ok('создание админ-токена (201, token в ответе)');

  const userTok = process.env.MCP_TOKEN
    ? { id: 'external', token: process.env.MCP_TOKEN }
    : await createToken('test-mcp-user');
  if (!userTok) { bad('создание юзер-токена'); finish(); return; }
  ok('создание юзер-токена');

  try {
    // ─── 1. Разграничение ролей ────────────────────────────────────────────
    const listUser = await mcp(userTok.token, 'tools/list');
    const userTools = toolNames(listUser);
    // ВАЖНО: без MCP_TOKEN «юзер-токен» выпускается тем же JWT админа → принадлежит
    // владельцу-админу и осознанно получает admin_* (scopes по is_admin владельца).
    // Изоляцию не-админа проверяем только с внешним не-админским токеном (или локально).
    const userIsAdmin = userTools.some(t => t.startsWith('admin_'));
    if (userIsAdmin && !process.env.MCP_TOKEN) {
      ok('tools/list юзер-токен: токен владельца-админа — admin_* на месте (изоляция не-админа: локальный smoke / MCP_TOKEN)');
    } else if (listUser.status === 200 && userTools.length > 0 && !userIsAdmin) {
      ok('tools/list юзер-токен: базовые есть, admin_* скрыты');
    } else {
      bad('tools/list юзер-токен', { status: listUser.status, tools: userTools });
    }

    const callAdminAsUser = await mcp(userTok.token, 'tools/call', { name: 'admin_metrics', arguments: {} });
    if (!userIsAdmin && callAdminAsUser.data?.error?.code === -32602) {
      ok('вызов admin_* с юзер-токеном → -32602');
    } else if (userIsAdmin && !callAdminAsUser.data?.error) {
      ok('вызов admin_* токеном владельца-админа → данные (ожидаемо)');
    } else {
      bad('вызов admin_* с юзер-токеном', callAdminAsUser.data);
    }

    const listAdmin = await mcp(adminTok.token, 'tools/list');
    const adminTools = toolNames(listAdmin);
    if (adminTools.includes('admin_metrics') && adminTools.includes('admin_radio_cache')
      && adminTools.includes('news_search')) {
      ok(`tools/list админ-токен: базовые + admin_metrics + admin_radio_cache (всего ${adminTools.length})`);
    } else {
      bad('tools/list админ-токен', adminTools);
    }

    // ─── 2. Smoke: news_search непустой на прод-данных ─────────────────────
    const search = await callTool(userTok.token, 'news_search', { query: 'сбер', limit: 5 });
    const searchText = search?.content?.[0]?.text ?? '';
    if (!search?.isError && searchText.includes('"count"') && !searchText.includes('"count": 0')) {
      ok('news_search «сбер» → непустой результат');
    } else {
      // фолбэк: без query — любые свежие новости
      const anyRes = await callTool(userTok.token, 'news_search', { limit: 3 });
      const anyText = anyRes?.content?.[0]?.text ?? '';
      if (!anyRes?.isError && anyText.includes('"count"') && !anyText.includes('"count": 0')) {
        ok('news_search (без query) → непустой результат');
      } else {
        bad('news_search непустой', anyText.slice(0, 120));
      }
    }

    const progress = await callTool(userTok.token, 'education_my_progress', {});
    if (!progress?.isError && progress?.content?.[0]?.text?.includes('"count"')) {
      ok('education_my_progress → отвечает');
    } else {
      bad('education_my_progress', progress);
    }

    // ─── 3. Поверхность аутентификации (ИБ-2) ──────────────────────────────
    const noToken = await mcp(null, 'tools/list');
    if (noToken.status === 401) ok('без токена → 401');
    else bad('без токена → 401', { status: noToken.status });

    const queryToken = await fetch(`${ORIGIN}/mcp?token=${userTok.token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list' }),
    });
    if (queryToken.status === 401) ok('токен в ?token= → 401 (ИБ-2)');
    else bad('токен в ?token= → 401', { status: queryToken.status });

    const garbage = await mcp('pulse_mcp_deadbeef'.padEnd(58, '0'), 'tools/list');
    if (garbage.status === 401 && !garbage.raw.includes('pulse_mcp_deadbeef')) {
      ok('мусорный токен → 401 без эха токена');
    } else {
      bad('мусорный токен → 401 без эха', { status: garbage.status });
    }

    // ─── 4. Zod strict (ИБ-7, ИБ-4) ────────────────────────────────────────
    const extraKey = await callTool(userTok.token, 'news_search', { query: 'сбер', evil: 1 });
    if (extraKey?.isError && JSON.stringify(extraKey).includes('Unrecognized key')) {
      ok('лишний ключ аргументов → отказ (strict)');
    } else {
      bad('лишний ключ аргументов → отказ', extraKey);
    }

    const idor = await callTool(userTok.token, 'education_my_progress', { user_id: 'x' });
    if (idor?.isError && JSON.stringify(idor).includes('Unrecognized key')) {
      ok('user_id аргументом → отказ (IDOR, ИБ-4)');
    } else {
      bad('user_id аргументом → отказ', idor);
    }

    // ─── 5. Админ-инструмент реально работает с админ-токеном ──────────────
    const metrics = await callTool(adminTok.token, 'admin_metrics', { section: 'overview', days: 30 });
    if (!metrics?.isError && metrics?.content?.[0]?.text?.includes('"data"')) {
      ok('admin_metrics с админ-токеном → данные');
    } else {
      bad('admin_metrics с админ-токеном', metrics);
    }

    // ─── 6. Отзыв → мгновенный 401 ─────────────────────────────────────────
    const delUser = await req('DELETE', `/user/mcp-tokens/${created.find(() => true) === userTok.id ? userTok.id : ''}`, jwt);
    // отзываем отдельный токен для проверки (не тот, что нужен дальше)
    const temp = await createToken('test-mcp-revoke-check');
    if (temp) {
      const del = await req('DELETE', `/user/mcp-tokens/${temp.id}`, jwt);
      if (del.status === 200) ok('DELETE /user/mcp-tokens/:id → 200');
      else bad('DELETE revoke', { status: del.status });
      const after = await mcp(temp.token, 'tools/list');
      if (after.status === 401) ok('отозванный токен → мгновенный 401');
      else bad('отозванный токен → 401', { status: after.status });
      created.splice(created.indexOf(temp.id), 1);
    }

    // ─── 7. Лимит 5 активных токенов → 6-й = 409 ───────────────────────────
    if (!process.env.MCP_TOKEN) {
      const extras: string[] = [];
      let sixth: { status: number; data: any } | null = null;
      for (let i = 0; i < 6; i++) {
        const r = await req('POST', '/user/mcp-tokens', jwt, { name: `test-mcp-limit-${i}` });
        if (r.status === 201 && r.data.id) { extras.push(r.data.id); created.push(r.data.id); }
        else sixth = r;
      }
      if (sixth?.status === 409 && typeof sixth.data?.error === 'string') {
        ok('6-й активный токен → 409 с понятным сообщением');
      } else {
        bad('6-й активный токен → 409', sixth);
      }
      for (const id of extras) {
        await req('DELETE', `/user/mcp-tokens/${id}`, jwt);
        created.splice(created.indexOf(id), 1);
      }
    }

    // ─── 8. mcpAuthLimiter: 20 неудач / 15 мин на IP (опционально) ─────────
    if (RUN_AUTH_FLOOD) {
      let lastStatus = 0;
      for (let i = 0; i < 22; i++) {
        const r = await mcp('pulse_mcp_flood000000000000000000000000000000000000000000', 'tools/list');
        lastStatus = r.status;
      }
      if (lastStatus === 429) ok('20 неудачных auth → 429 (mcpAuthLimiter)');
      else bad('20 неудачных auth → 429', { lastStatus });
    }

    void delUser;
  } finally {
    // ─── Очистка: отзываем все созданные токены ────────────────────────────
    for (const id of created) {
      await req('DELETE', `/user/mcp-tokens/${id}`, jwt).catch(() => {});
    }
    console.log(`\n[cleanup] отозвано токенов: ${created.length}`);
  }

  finish();
}

function finish() {
  console.log(`\nИТОГО: PASS=${passed} FAIL=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

export {}; // модуль: изоляция от других *.test.ts (без импортов файл — глобальный скрипт)

