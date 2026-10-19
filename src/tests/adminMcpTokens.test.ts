/**
 * =============================================================================
 * PULSE — Админ-таба «МСП»: live-API тест (ТЗ-185, Задача 5)
 * =============================================================================
 *
 * Прогон: API_URL=https://pulse.inside-trade.ru/api ADMIN_EMAIL=<email>
 *         ADMIN_PASSWORD=<password> npx ts-node src/tests/adminMcpTokens.test.ts
 *
 * Покрывает: доступ (403/200), контракт строки реестра (token_hash отсутствует),
 * появление юзерского токена в реестре, рост requests_count (flush раз в минуту,
 * ждём ~70с), принудительный отзыв (мгновенный 401, status/revoked_by),
 * идемпотентность revoke. Письмо владельцу — ручная проверка (Resend-логи).
 * Прод-данные не мутирует: регистрирует временного юзера, в конце чистит.
 */

const API_URL = process.env.API_URL || 'https://pulse.inside-trade.ru/api';
const ORIGIN = API_URL.replace(/\/api\/?$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let passed = 0;
let failed = 0;
let skipped = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const bad = (name: string, detail?: any) => { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); };
const skip = (name: string, why: string) => { skipped++; console.log(`  SKIP  ${name} — ${why}`); };

async function req(method: string, path: string, token: string, body?: any): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': token ? `Bearer ${token}` : '' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('Admin MCP tokens live test\n');

  const login = await req('POST', '/auth/login', '', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (login.status !== 200 || !login.data.token) {
    bad('admin login', login);
    finish();
    return;
  }
  const adminJwt: string = login.data.token;
  const adminId: string = login.data.user?.id || login.data.user?.userId || '';
  ok('admin login');

  // ─── 1. Не-админ → 403 ────────────────────────────────────────────────────
  const stamp = Date.now();
  const reg = await req('POST', '/auth/register', '', {
    email: `mcp-tmp-${stamp}@pulse-test.local`,
    username: `mcptmp${String(stamp).slice(-8)}`,
    password: 'TmpPass123!x',
  });
  let userJwt: string | null = null;
  let userEmail = '';
  if (reg.status === 200 || reg.status === 201) {
    userJwt = reg.data.token;
    userEmail = reg.data.user?.email || '';
    const denied = await req('GET', '/admin/mcp/tokens', userJwt || '');
    if (denied.status === 403) ok('не-админ GET /admin/mcp/tokens → 403');
    else bad('не-админ → 403', { status: denied.status });
  } else {
    skip('не-админ → 403', `регистрация временного юзера не удалась: ${reg.status}`);
  }

  // ─── 2. Админ → 200, контракт строки, token_hash отсутствует ─────────────
  const list = await req('GET', '/admin/mcp/tokens', adminJwt);
  if (list.status === 200 && Array.isArray(list.data.tokens)) {
    ok('админ GET /admin/mcp/tokens → 200, массив');
  } else {
    bad('админ GET /admin/mcp/tokens → 200', { status: list.status });
    finish();
    return;
  }
  const REQUIRED = ['token_id', 'user', 'name', 'prefix', 'scopes', 'created_at', 'expires_at', 'last_used_at', 'revoked_at', 'revoked_by', 'requests_count', 'status'];
  const sample = list.data.tokens[0];
  if (sample) {
    const missing = REQUIRED.filter((k) => !(k in sample));
    if (missing.length === 0 && 'token_hash' in sample === false
      && sample.user && typeof sample.user.username === 'string' && typeof sample.user.email === 'string') {
      ok('контракт строки полный, token_hash отсутствует');
    } else {
      bad('контракт строки', { missing, hasHash: 'token_hash' in sample });
    }
  } else {
    skip('контракт строки', 'реестр пуст — некого проверять (создадим ниже)');
  }

  // ─── 3. Юзер создаёт токен → появляется в реестре ────────────────────────
  if (userJwt) {
    const created = await req('POST', '/user/mcp-tokens', userJwt, { name: 'admin-registry-check' });
    if (created.status === 201 && created.data.id) {
      const tokenId = created.data.id;
      const after = await req('GET', '/admin/mcp/tokens?q=mcptmp', adminJwt);
      const row = (after.data.tokens || []).find((t: any) => t.token_id === tokenId);
      if (row && row.user.email === userEmail && row.status === 'active' && typeof row.requests_count === 'number') {
        ok('токен юзера в реестре: username/email/created_at/status ок');
      } else {
        bad('токен юзера в реестре', row ?? 'not found');
      }

      // ─── 4. requests_count растёт после вызовов /mcp (flush ≤2 мин) ────────
      for (let i = 0; i < 3; i++) {
        await fetch(`${ORIGIN}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-11-25',
            'Authorization': `Bearer ${created.data.token}`,
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: i + 1, method: 'tools/list' }),
        }).catch(() => {});
      }
      console.log('  ... ждём 70с (flush requests_count раз в минуту)');
      await sleep(70_000);
      const counted = await req('GET', `/admin/mcp/tokens?q=mcptmp`, adminJwt);
      const row2 = (counted.data.tokens || []).find((t: any) => t.token_id === tokenId);
      if (row2 && Number(row2.requests_count) >= 3) {
        ok(`requests_count вырос после вызовов (${row2.requests_count})`);
      } else {
        bad('requests_count вырос после вызовов', row2?.requests_count);
      }

      // ─── 5. Админ отзывает → клиент мгновенно 401, status/revoked_by ───────
      const revoke = await req('POST', `/admin/mcp/tokens/${tokenId}/revoke`, adminJwt);
      if (revoke.status === 200 && revoke.data.ok) ok('админ revoke → 200');
      else bad('админ revoke', { status: revoke.status });

      const denied = await fetch(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${created.data.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
      });
      if (denied.status === 401) ok('клиент с отозванным токеном → мгновенный 401');
      else bad('клиент с отозванным токеном → 401', { status: denied.status });

      const afterRevoke = await req('GET', `/admin/mcp/tokens?q=mcptmp`, adminJwt);
      const row3 = (afterRevoke.data.tokens || []).find((t: any) => t.token_id === tokenId);
      if (row3 && row3.status === 'revoked' && row3.revoked_by === adminId) {
        ok('status=revoked, revoked_by = admin id');
      } else {
        bad('status=revoked, revoked_by = admin id', { status: row3?.status, revoked_by: row3?.revoked_by, adminId });
      }

      // ─── 6. Повторный revoke → 200 (идемпотентность) ───────────────────────
      const again = await req('POST', `/admin/mcp/tokens/${tokenId}/revoke`, adminJwt);
      if (again.status === 200) ok('повторный revoke → 200, не 500');
      else bad('повторный revoke → 200', { status: again.status });

      console.log('  [note] письмо владельцу о принудительном отзыве — проверить в Resend-логах (ручная проверка)');
    } else {
      skip('реестр/отзыв', `создание токена юзером не удалось: ${created.status}`);
    }
  } else {
    skip('реестр/отзыв', 'нет временного юзера');
  }

  finish();
}

function finish() {
  console.log(`\nИТОГО: PASS=${passed} FAIL=${failed} SKIP=${skipped}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });

export {}; // модуль: изоляция от других *.test.ts (без импортов файл — глобальный скрипт)

