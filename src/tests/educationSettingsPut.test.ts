/**
 * =============================================================================
 * PULSE — ТЗ-174: регрессионный тест формы PUT /api/admin/education/settings
 * =============================================================================
 *
 * Прогон против живого API (паттерн теста ТЗ-159). Настройка возвращается в
 * исходное значение в finally — тест идемпотентен.
 *
 * Проверяет (краш админки при переключении LLM-ранкера, ТЗ-172 → ТЗ-174):
 *   1. PUT {match_llm_enabled: !orig} → 200.
 *   2. Тело ответа содержит те же ключи, что GET /settings:
 *      match_llm_enabled (boolean, === отправленному), match_master_enabled
 *      (boolean), llm_today.used (number), llm_today.limit (number).
 *   3. Набор ключей GET и PUT идентичен (фронт подставляет ответ в состояние).
 *   4. Невалидное тело (не boolean) → 400.
 *   5. Возврат исходного значения → 200 и подтверждение через GET.
 *
 * Запуск:
 *   API_URL=https://pulse.inside-trade.ru/api \
 *   ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> \
 *   npx ts-node src/tests/educationSettingsPut.test.ts
 */

const API_URL = process.env.API_URL || 'https://pulse.inside-trade.ru/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const bad = (name: string, detail?: any) => { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); };

async function req(method: string, path: string, token: string, body?: any): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const isBool = (v: unknown) => typeof v === 'boolean';
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('Нужны ADMIN_EMAIL и ADMIN_PASSWORD в env');
    process.exit(1);
  }

  const login = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!login.ok) {
    console.error('Логин админа не удался:', login.status);
    process.exit(1);
  }
  const loginData: any = await login.json();
  const token = loginData.token as string;

  const PATH = '/admin/education/settings';
  const getRes = await req('GET', PATH, token);
  if (getRes.status !== 200) {
    bad('GET /settings доступен', { status: getRes.status });
    finish();
    return;
  }
  const orig = getRes.data.match_llm_enabled;
  if (!isBool(orig)) {
    bad('GET: match_llm_enabled — boolean', getRes.data);
    finish();
    return;
  }
  ok('GET /settings доступен, исходное значение зафиксировано');

  const getKeys = Object.keys(getRes.data).filter((k) => k !== 'ok').sort();

  const target = !orig;
  try {
    const putRes = await req('PUT', PATH, token, { match_llm_enabled: target });
    if (putRes.status !== 200) {
      bad('PUT → 200', { status: putRes.status, body: putRes.data });
    } else {
      ok('PUT → 200');
      const d = putRes.data;
      if (d.match_llm_enabled === target && isBool(d.match_llm_enabled)) ok('PUT: match_llm_enabled === отправленному (boolean)');
      else bad('PUT: match_llm_enabled === отправленному', d.match_llm_enabled);
      if (isBool(d.match_master_enabled)) ok('PUT: match_master_enabled — boolean');
      else bad('PUT: match_master_enabled — boolean', d.match_master_enabled);
      if (isNum(d.llm_today?.used)) ok('PUT: llm_today.used — number');
      else bad('PUT: llm_today.used — number', d.llm_today);
      if (isNum(d.llm_today?.limit)) ok('PUT: llm_today.limit — number');
      else bad('PUT: llm_today.limit — number', d.llm_today);
      const putKeys = Object.keys(d).filter((k) => k !== 'ok').sort();
      if (JSON.stringify(putKeys) === JSON.stringify(getKeys)) ok('ключи PUT === ключам GET');
      else bad('ключи PUT === ключам GET', { get: getKeys, put: putKeys });
    }

    const badRes = await req('PUT', PATH, token, { match_llm_enabled: 'yes' });
    if (badRes.status === 400) ok('PUT с не-boolean → 400');
    else bad('PUT с не-boolean → 400', { status: badRes.status });
  } finally {
    const restore = await req('PUT', PATH, token, { match_llm_enabled: orig });
    const after = await req('GET', PATH, token);
    if (restore.status === 200 && after.data.match_llm_enabled === orig) {
      ok('настройка возвращена в исходное значение');
    } else {
      bad('настройка возвращена в исходное значение', { restore: restore.status, now: after.data.match_llm_enabled, orig });
    }
  }

  finish();
}

function finish() {
  console.log(`\nИТОГ: PASS=${passed} FAIL=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Тест упал с исключением:', err);
  process.exit(1);
});

// Модуль (без этого tsc склеивает файл с mdCourseImportEndpoint.test.ts
// в одну глобальную область — коллизия API_URL/ADMIN_EMAIL/…).
export {};
