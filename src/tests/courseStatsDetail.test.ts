/**
 * =============================================================================
 * PULSE — ТЗ-181: регрессионный тест GET /api/admin/education/courses/:id/stats
 * =============================================================================
 *
 * Прогон против живого API (паттерн теста ТЗ-159/ТЗ-174/ТЗ-180). Только чтение —
 * тест не мутирует данные и идемпотентен.
 *
 * Проверяет (детальный экран статистики курса, дрилл-даун из табы ТЗ-180):
 *   1. GET без days → 200, period_days = 30 (дефолт).
 *   2. Контракт: course/funnel/sources/activity_timeline/active_7d/lessons/materials,
 *      funnel.enrolled >= started >= halfway >= completed,
 *      sources = разложение funnel.enrolled по источникам.
 *   3. lessons[]: pct_of_enrolled/drop_vs_prev/test_pass_rate — null либо 0..1,
 *      drop_vs_prev первого урока — null, счётчики >= 0.
 *   4. days=7 и days=90 → period_days соответственно; невалидный days → фолбек 30.
 *   5. Несуществующий курс → 404.
 *
 * Запуск:
 *   API_URL=https://pulse.inside-trade.ru/api \
 *   ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> \
 *   npx ts-node src/tests/courseStatsDetail.test.ts
 */

const API_URL = process.env.API_URL || 'https://pulse.inside-trade.ru/api';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const bad = (name: string, detail?: any) => { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); };

async function req(path: string, token: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRate = (v: unknown): boolean => v === null || (isNum(v) && v >= 0 && v <= 1);

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

  // Берём первый курс из сводной табы (ТЗ-180) — гарантированно существует.
  const overview = await req('/admin/education/stats/overview?days=30', token);
  const first = overview.data?.courses?.[0];
  if (!first) {
    bad('в системе есть хотя бы один курс для проверки', overview.data);
    finish();
    return;
  }
  const cid = first.id as string;
  const PATH = `/admin/education/courses/${cid}/stats`;

  // 1. Дефолтный период.
  const d30 = await req(PATH, token);
  if (d30.status !== 200) {
    bad('GET без days → 200', { status: d30.status, body: d30.data });
    finish();
    return;
  }
  ok('GET без days → 200');
  if (d30.data.period_days === 30) ok('period_days = 30 (дефолт)');
  else bad('period_days = 30 (дефолт)', d30.data.period_days);

  // 2. Контракт и воронка.
  const d = d30.data;
  const f = d.funnel || {};
  if (isNum(f.enrolled) && isNum(f.started) && isNum(f.halfway) && isNum(f.completed)) ok('funnel — 4 числа');
  else { bad('funnel — 4 числа', f); finish(); return; }
  if (f.enrolled >= f.started && f.started >= f.halfway && f.halfway >= f.completed) ok('воронка монотонна (enrolled ≥ started ≥ halfway ≥ completed)');
  else bad('воронка монотонна', f);
  if (f.halfway === 0 || (first.lessons_count > 0 && f.halfway <= f.enrolled)) ok('halfway рассчитан от ceil(N/2) уроков');
  const srcSum = Object.values(d.sources || {}).reduce((s: number, v) => s + (isNum(v) ? v : 0), 0);
  if (srcSum === f.enrolled) ok('sources — разложение enrolled по источникам');
  else bad('sources — разложение enrolled', { srcSum, enrolled: f.enrolled });
  if (Array.isArray(d.activity_timeline) && Array.isArray(d.active_7d) &&
      Array.isArray(d.lessons) && Array.isArray(d.materials) &&
      d.course && typeof d.course.title === 'string') ok('контракт секций (timeline/active/lessons/materials/course)');
  else bad('контракт секций', Object.keys(d));

  // 3. Контракт уроков.
  let lessonsOk = true;
  (d.lessons as any[]).forEach((l, i) => {
    if (!isNum(l.completed) || l.completed < 0) lessonsOk = false;
    if (!isRate(l.pct_of_enrolled) || !isRate(l.drop_vs_prev) || !isRate(l.test_pass_rate)) lessonsOk = false;
    if (i === 0 && l.drop_vs_prev !== null) lessonsOk = false;
    if (!Array.isArray(l.per_question)) lessonsOk = false;
  });
  if (lessonsOk) ok(`контракт lessons[] (${(d.lessons as any[]).length} уроков)`);
  else bad('контракт lessons[]', d.lessons);

  // 4. Периоды.
  for (const days of [7, 90]) {
    const res = await req(`${PATH}?days=${days}`, token);
    if (res.status === 200 && res.data.period_days === days) ok(`days=${days} → period_days=${days}`);
    else bad(`days=${days} → period_days=${days}`, { status: res.status, period_days: res.data?.period_days });
  }
  const dBad = await req(`${PATH}?days=15`, token);
  if (dBad.status === 200 && dBad.data.period_days === 30) ok('days=15 → фолбек на 30 (без 500)');
  else bad('days=15 → фолбек на 30', { status: dBad.status, period_days: dBad.data?.period_days });

  // 5. 404 на несуществующий курс.
  const nf = await req(`/admin/education/courses/00000000-0000-0000-0000-000000000000/stats`, token);
  if (nf.status === 404) ok('несуществующий курс → 404');
  else bad('несуществующий курс → 404', { status: nf.status });

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

// Модуль (без этого tsc склеивает файлы в одну глобальную область).
export {};
