/**
 * =============================================================================
 * PULSE — ТЗ-157: тест идемпотентного создания урока
 * =============================================================================
 *
 * Прогон против живого API (PG-прод). SQLite-контур покрыт структурно
 * (та же ветка кода + initSQLiteSchema с индексом) и ручным прогоном.
 *
 * Проверяет:
 *   1. Два POST с одним idempotency_key → одна строка; второй ответ
 *      200 already_created:true с тем же id.
 *   2. Гонка: два параллельных POST с одним ключом → один id у обоих.
 *   3. POST без ключа дважды → две строки (прежнее поведение старых клиентов).
 *
 * Уроки создаются в первом доступном курсе и удаляются в конце
 * (эндпоинта DELETE /courses нет — курс не трогаем).
 *
 * Запуск:
 *   API_URL=https://pulse.inside-trade.ru/api \
 *   ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> \
 *   npx ts-node src/tests/lessonIdempotency.test.ts
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
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('Нужны ADMIN_EMAIL и ADMIN_PASSWORD');
    process.exit(1);
  }

  console.log('── Логин админа ──');
  const login = await req('POST', '/auth/login', '', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (login.status !== 200 || !login.data?.token) {
    console.error('Логин админа не удался:', login.status, login.data);
    process.exit(1);
  }
  const token: string = login.data.token;
  ok('логин админа');

  console.log('── Ищу курс для теста ──');
  const courses = await req('GET', '/admin/education/courses', token);
  const first = Array.isArray(courses.data) ? courses.data[0] : courses.data?.courses?.[0];
  if (!first?.id) {
    bad('нет доступных курсов', courses.data);
    process.exit(1);
  }
  const courseId: string = first.id;
  ok(`курс: ${first.title || courseId}`);

  const lessonsPath = `/admin/education/courses/${courseId}/lessons`;
  const uniqTitle = (tag: string) => `TZ-157-test ${tag} ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdLessonIds: string[] = [];

  try {
    // ─── 1. Повтор с тем же ключом ───────────────────────────────────────
    console.log('── Тест 1: повторный POST с одним idempotency_key ──');
    const key1 = crypto.randomUUID();
    const r1 = await req('POST', lessonsPath, token, { title: uniqTitle('t1'), idempotency_key: key1 });
    const r2 = await req('POST', lessonsPath, token, { title: uniqTitle('t1'), idempotency_key: key1 });
    r1.status === 201 && r1.data?.id ? ok(`первый POST: 201, id=${r1.data.id}`) : bad('первый POST', r1);
    r2.status === 200 && r2.data?.already_created === true && r2.data?.id === r1.data?.id
      ? ok('повторный POST: 200 already_created, тот же id')
      : bad('повторный POST', r2);
    if (r1.data?.id) createdLessonIds.push(r1.data.id);

    const list1 = await req('GET', lessonsPath, token);
    const rows = Array.isArray(list1.data) ? list1.data.filter((l: any) => l.id === r1.data?.id) : [];
    rows.length === 1 ? ok('в списке ровно одна строка') : bad('строк в списке', rows.length);

    // ─── 2. Гонка: два параллельных запроса с одним ключом ───────────────
    console.log('── Тест 2: гонка двух параллельных POST ──');
    const key2 = crypto.randomUUID();
    const [g1, g2] = await Promise.all([
      req('POST', lessonsPath, token, { title: uniqTitle('t2'), idempotency_key: key2 }),
      req('POST', lessonsPath, token, { title: uniqTitle('t2'), idempotency_key: key2 }),
    ]);
    const ids = new Set([g1.data?.id, g2.data?.id].filter(Boolean));
    const goodStatuses = [g1, g2].every(r => r.status === 200 || r.status === 201);
    goodStatuses && ids.size === 1 && g1.data?.id
      ? ok(`гонка: оба вернули один id (${g1.data.id}), статусы ${g1.status}/${g2.status}`)
      : bad('гонка', { g1: { status: g1.status, id: g1.data?.id, ac: g1.data?.already_created }, g2: { status: g2.status, id: g2.data?.id, ac: g2.data?.already_created } });
    if (g1.data?.id) createdLessonIds.push(g1.data.id);

    // ─── 3. Без ключа — прежнее поведение ────────────────────────────────
    console.log('── Тест 3: POST без ключа дважды → две строки ──');
    const n1 = await req('POST', lessonsPath, token, { title: uniqTitle('t3a') });
    const n2 = await req('POST', lessonsPath, token, { title: uniqTitle('t3b') });
    n1.status === 201 && n2.status === 201 && n1.data?.id && n2.data?.id && n1.data.id !== n2.data.id
      ? ok('два урока без ключа созданы с разными id')
      : bad('POST без ключа', { n1: n1.status, n2: n2.status });
    if (n1.data?.id) createdLessonIds.push(n1.data.id);
    if (n2.data?.id) createdLessonIds.push(n2.data.id);
  } finally {
    console.log('── Удаляю тестовые уроки ──');
    for (const id of createdLessonIds) {
      const del = await req('DELETE', `/admin/education/lessons/${id}`, token);
      del.status === 200 ? ok(`урок ${id.slice(0, 8)} удалён`) : bad(`удаление урока ${id.slice(0, 8)}`, del);
    }
  }

  console.log(`\nИТОГО: PASS=${passed} FAIL=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
