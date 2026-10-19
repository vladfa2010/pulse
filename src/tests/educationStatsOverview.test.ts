/**
 * =============================================================================
 * PULSE — ТЗ-180: регрессионный тест GET /api/admin/education/stats/overview
 * =============================================================================
 *
 * Прогон против живого API (паттерн теста ТЗ-159/ТЗ-174). Только чтение —
 * тест не мутирует данные и идемпотентен.
 *
 * Проверяет (под-вкладка «Статистика» в табе «Образование» админки):
 *   1. GET без days → 200, period_days = 30 (дефолт).
 *   2. Контракт строки курса: обязательные поля, rate-метрики — null либо 0..1,
 *      enrolled_total >= enrolled_period >= 0, счётчики >= 0.
 *   3. Сортировка по умолчанию: enrolled_period невозрастает.
 *   4. days=7 и days=90 → period_days соответственно 7/90.
 *   5. Невалидный days (не из 7/30/90) → не 500, отдаётся дефолт 30.
 *
 * Запуск:
 *   API_URL=https://pulse.inside-trade.ru/api \
 *   ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> \
 *   npx ts-node src/tests/educationStatsOverview.test.ts
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

const ROW_FIELDS = [
  'id', 'title', 'status', 'type', 'lessons_count',
  'enrolled_total', 'enrolled_period', 'started_period', 'start_rate',
  'completed_total', 'completion_rate',
  'test_attempts_period', 'test_pass_rate', 'avg_test_score',
  'materials_downloads_period', 'active_learners_7d',
];

function checkRow(r: any, i: number): boolean {
  for (const f of ROW_FIELDS) {
    if (!(f in r)) { bad(`строка ${i}: поле ${f} есть`, { row: r }); return false; }
  }
  if (!['published', 'archived'].includes(r.status)) { bad(`строка ${i}: status в {published, archived}`, r.status); return false; }
  if (![r.lessons_count, r.enrolled_total, r.enrolled_period, r.started_period, r.completed_total, r.test_attempts_period, r.materials_downloads_period, r.active_learners_7d].every((v) => isNum(v) && v >= 0)) {
    bad(`строка ${i}: счётчики — неотрицательные числа`, r); return false;
  }
  if (r.enrolled_total < r.enrolled_period) { bad(`строка ${i}: enrolled_total >= enrolled_period`, r); return false; }
  if (!isRate(r.start_rate) || !isRate(r.completion_rate) || !isRate(r.test_pass_rate)) {
    bad(`строка ${i}: rate-метрики null либо 0..1`, { start: r.start_rate, completion: r.completion_rate, pass: r.test_pass_rate }); return false;
  }
  if (!(r.avg_test_score === null || isNum(r.avg_test_score))) { bad(`строка ${i}: avg_test_score null|number`, r.avg_test_score); return false; }
  return true;
}

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

  const PATH = '/admin/education/stats/overview';

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
  if (typeof d30.data.generated_at === 'string' && !Number.isNaN(Date.parse(d30.data.generated_at))) ok('generated_at — валидная ISO-дата');
  else bad('generated_at — валидная ISO-дата', d30.data.generated_at);
  if (Array.isArray(d30.data.courses)) ok('courses — массив');
  else { bad('courses — массив', typeof d30.data.courses); finish(); return; }

  // 2. Контракт строк.
  const rows: any[] = d30.data.courses;
  let rowsOk = true;
  rows.forEach((r, i) => { if (!checkRow(r, i)) rowsOk = false; });
  if (rowsOk) ok(`контракт строк (${rows.length} курсов)`);
  if (rows.length === 0) console.log('  WARN  курсов нет — контракт строк проверен на пустом множестве');

  // 3. Сортировка: enrolled_period невозрастает (тай-брейк по enrolled_total
  //    срабатывает только при равенстве period, монотонность period не ломает).
  let sorted = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i - 1].enrolled_period < rows[i].enrolled_period) { sorted = false; break; }
  }
  if (sorted) ok('сортировка по умолчанию: enrolled_period невозрастает');
  else bad('сортировка по умолчанию: enrolled_period невозрастает', rows.map((r) => r.enrolled_period));

  // 4. Явные периоды.
  for (const d of [7, 90]) {
    const res = await req(`${PATH}?days=${d}`, token);
    if (res.status === 200 && res.data.period_days === d) ok(`days=${d} → period_days=${d}`);
    else bad(`days=${d} → period_days=${d}`, { status: res.status, period_days: res.data?.period_days });
  }

  // 5. Невалидный days — без 500, отдаётся дефолт (код фолбека, не 400).
  const dBad = await req(`${PATH}?days=15`, token);
  if (dBad.status === 200 && dBad.data.period_days === 30) ok('days=15 → фолбек на 30 (без 500)');
  else bad('days=15 → фолбек на 30 (без 500)', { status: dBad.status, period_days: dBad.data?.period_days });

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
