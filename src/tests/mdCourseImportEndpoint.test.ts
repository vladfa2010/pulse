/**
 * =============================================================================
 * PULSE — ТЗ-159 v3: тест эндпоинта импорта курса из Markdown
 * =============================================================================
 *
 * Прогон против живого API (PG-прод, паттерн теста ТЗ-157). Созданные уроки
 * удаляются в finally, исходное описание курса восстанавливается.
 *
 * Проверяет:
 *   1. dry_run → 200 с превью (course_description/buttons_count/test), в БД
 *      строк не прибавилось, описание курса не тронуто.
 *   2. Реальный импорт 3 уроков → 201, positions = max+1..max+3, tests_created=1,
 *      description_updated=true, description курса заменён, buttons у урока,
 *      has_test у урока с :::test.
 *   3. Повтор того же файла → 200, skipped_existing=3, description_updated=true,
 *      дублей нет, has_test не задвоился.
 *   4. Файл без преамбулы → description_updated=false, описание не изменилось.
 *   5. Файл с ошибкой (видео mail.ru) → 400 со списком details, 0 новых строк,
 *      описание не тронуто.
 *
 * Запуск:
 *   API_URL=https://pulse.inside-trade.ru/api \
 *   ADMIN_EMAIL=<email> ADMIN_PASSWORD=<password> \
 *   npx ts-node src/tests/mdCourseImportEndpoint.test.ts
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

async function uploadMd(path: string, token: string, filename: string, content: string, dryRun = false): Promise<{ status: number; data: any }> {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'text/markdown' }), filename);
  if (dryRun) fd.append('dry_run', 'true');
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: fd,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const GOOD_MD = `Описание курса **для теста** ТЗ-159.

# Вводный урок

Текст первого урока с **жирным**.

:::button label="В терминал" url=/terminal color=violet

---

# Урок с видео и тестом
---
is_free: true
duration_min: 12
video_url: https://www.youtube.com/watch?v=dQw4w9WgXcQ
---
Конспект урока с видео.

| A | B |
|---|---|
| 1 | 2 |

:::test pass=80
? Столица России?
- ( ) Казань
- (x) Москва
:::

# Третий урок

:::chart ticker=SBER exchange=MOEX tf=d1 range=3M
`;

const NO_PREAMBLE_MD = `# Урок без преамбулы

Просто текст, описание курса не трогаем.
`;

const BAD_MD = `# Хороший урок

Текст.

# Урок с плохим видео
---
video_url: https://my.mail.ru/video/x
---
Текст урока.
`;

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

  const importPath = `/admin/education/courses/${courseId}/import-md`;
  const lessonsPath = `/admin/education/courses/${courseId}/lessons`;
  const createdLessonIds: string[] = [];
  // Исходное описание курса — вернём в finally (импорт его заменяет).
  let originalDescription: string | null = null;

  const countLessons = async (): Promise<number> => {
    const list = await req('GET', lessonsPath, token);
    return Array.isArray(list.data) ? list.data.length : -1;
  };
  const fetchDescription = async (): Promise<string> => {
    const c = await req('GET', `/admin/education/courses/${courseId}`, token);
    return String(c.data?.description ?? '');
  };
  const fetchLessons = async (): Promise<any[]> => {
    const list = await req('GET', lessonsPath, token);
    return Array.isArray(list.data) ? list.data : [];
  };

  try {
    originalDescription = await fetchDescription();
    const before = await countLessons();

    // ─── 1. dry_run ──────────────────────────────────────────────────────
    console.log('── Тест 1: dry_run — превью без записи ──');
    const dry = await uploadMd(importPath, token, 'tz159-dry.md', GOOD_MD, true);
    dry.status === 200 && dry.data?.dry_run === true && Array.isArray(dry.data?.lessons)
      ? ok(`dry_run: 200, уроков в превью ${dry.data.lessons.length}`)
      : bad('dry_run', dry);
    dry.data?.course_description?.will_update === true && dry.data?.course_description?.chars > 0
      ? ok(`dry_run: описание будет заменено (chars=${dry.data.course_description.chars}, сейчас ${dry.data.course_description.current_chars})`)
      : bad('dry_run course_description', dry.data?.course_description);
    dry.data?.lessons?.[0]?.buttons_count === 1
      ? ok('dry_run: buttons_count=1 у первого урока')
      : bad('dry_run buttons_count', dry.data?.lessons?.[0]);
    dry.data?.lessons?.[1]?.test?.questions === 1 && dry.data?.lessons?.[1]?.test?.pass_score === 80
      ? ok('dry_run: тест урока 2 (1 вопрос, порог 80)')
      : bad('dry_run test', dry.data?.lessons?.[1]);
    const afterDry = await countLessons();
    afterDry === before
      ? ok(`dry_run: строк не прибавилось (${before} → ${afterDry})`)
      : bad('dry_run изменил список уроков', { before, afterDry });
    (await fetchDescription()) === originalDescription
      ? ok('dry_run: описание курса не тронуто')
      : bad('dry_run изменил описание курса', { originalDescription });

    // ─── 2. Реальный импорт ──────────────────────────────────────────────
    console.log('── Тест 2: реальный импорт 3 уроков ──');
    const imp = await uploadMd(importPath, token, 'tz159-import.md', GOOD_MD);
    imp.status === 201 && imp.data?.created === 3 && imp.data?.tests_created === 1 && imp.data?.description_updated === true
      ? ok(`импорт: 201, created=${imp.data.created}, tests_created=${imp.data.tests_created}, description_updated=true`)
      : bad('импорт', imp);
    for (const l of imp.data?.lessons || []) {
      if (l?.id) createdLessonIds.push(l.id);
    }
    const positions = (imp.data?.lessons || []).map((l: any) => l.position).sort((a: number, b: number) => a - b);
    positions.length === 3 && positions.every((p: number, i: number) => p === before + i + 1)
      ? ok(`positions = max+1..max+3 (${positions.join(',')})`)
      : bad('positions', positions);
    const kinds = (imp.data?.lessons || []).map((l: any) => l.kind);
    kinds[1] === 'video_text' && kinds[0] === 'text' && kinds[2] === 'text'
      ? ok(`kind: ${kinds.join(',')}`)
      : bad('kind', kinds);
    const afterImp = await countLessons();
    afterImp === before + 3
      ? ok(`в списке +3 урока (${before} → ${afterImp})`)
      : bad('число уроков после импорта', { before, afterImp });
    const newDesc = await fetchDescription();
    newDesc.includes('для теста')
      ? ok('описание курса заменено из преамбулы')
      : bad('описание курса не заменилось', { newDesc });
    const lessonsNow = await fetchLessons();
    const withButton = lessonsNow.find((l: any) => l.title === 'Вводный урок');
    Array.isArray(withButton?.buttons) && withButton.buttons.length === 1 && withButton.buttons[0].label === 'В терминал'
      ? ok('кнопка урока в карточке (label «В терминал»)')
      : bad('buttons в карточке урока', withButton?.buttons);
    const withTest = lessonsNow.find((l: any) => l.title === 'Урок с видео и тестом');
    withTest?.has_test === true
      ? ok('has_test у урока с :::test')
      : bad('has_test', withTest);

    // ─── 3. Повтор того же файла ─────────────────────────────────────────
    console.log('── Тест 3: повторная загрузка того же файла ──');
    const again = await uploadMd(importPath, token, 'tz159-import.md', GOOD_MD);
    again.status === 200 && again.data?.skipped_existing === 3 && again.data?.created === 0 && again.data?.description_updated === true
      ? ok('повтор: 200, skipped_existing=3, created=0, description_updated=true')
      : bad('повтор', again);
    const dupIds = new Set((again.data?.lessons || []).map((l: any) => l.id));
    dupIds.size === 3 && (imp.data?.lessons || []).every((l: any) => dupIds.has(l.id))
      ? ok('повтор вернул те же id — дублей нет')
      : bad('id повтора не совпали с первым импортом', { first: imp.data?.lessons?.map((l: any) => l.id), again: again.data?.lessons?.map((l: any) => l.id) });
    const afterAgain = await countLessons();
    afterAgain === afterImp
      ? ok(`строк не прибавилось (${afterImp} → ${afterAgain})`)
      : bad('повтор создал дубли', { afterImp, afterAgain });
    const lessonsAfterAgain = await fetchLessons();
    lessonsAfterAgain.filter((l: any) => l.title === 'Урок с видео и тестом' && l.has_test).length === 1
      ? ok('has_test не задвоился')
      : bad('has_test задвоился', lessonsAfterAgain.filter((l: any) => l.title === 'Урок с видео и тестом'));

    // ─── 4. Файл без преамбулы — описание не трогаем ─────────────────────
    console.log('── Тест 4: файл без преамбулы ──');
    const imp2 = await uploadMd(importPath, token, 'tz159-nopreamble.md', NO_PREAMBLE_MD);
    imp2.status === 201 && imp2.data?.created === 1 && imp2.data?.description_updated === false
      ? ok('импорт без преамбулы: description_updated=false')
      : bad('импорт без преамбулы', imp2);
    for (const l of imp2.data?.lessons || []) {
      if (l?.id) createdLessonIds.push(l.id);
    }
    (await fetchDescription()) === newDesc
      ? ok('описание курса не изменилось')
      : bad('описание изменилось при файле без преамбулы', { expected: newDesc, got: await fetchDescription() });

    // ─── 5. Файл с ошибкой ───────────────────────────────────────────────
    console.log('── Тест 5: файл с ошибкой (видео mail.ru) ──');
    const badRes = await uploadMd(importPath, token, 'tz159-bad.md', BAD_MD);
    badRes.status === 400 && Array.isArray(badRes.data?.details) && badRes.data.details.length > 0
      ? ok(`400 со списком ошибок: ${badRes.data.details.join(' | ')}`)
      : bad('400/details', badRes);
    const afterBad = await countLessons();
    afterBad === afterAgain + 1
      ? ok('ошибочный файл ничего не создал')
      : bad('ошибочный файл создал уроки', { expected: afterAgain + 1, got: afterBad });
  } finally {
    console.log('── Удаляю тестовые уроки ──');
    for (const id of new Set(createdLessonIds)) {
      const del = await req('DELETE', `/admin/education/lessons/${id}`, token);
      del.status === 200 ? ok(`урок ${id.slice(0, 8)} удалён`) : bad(`удаление урока ${id.slice(0, 8)}`, del);
    }
    if (originalDescription !== null) {
      const restore = await req('PUT', `/admin/education/courses/${courseId}`, token, { description: originalDescription });
      restore.status === 200 ? ok('исходное описание курса восстановлено') : bad('восстановление описания', restore);
    }
  }

  console.log(`\nИТОГО: PASS=${passed} FAIL=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Модуль (без этого tsc склеивает файл с lessonIdempotency.test.ts
// в одну глобальную область — коллизия API_URL/ADMIN_EMAIL/…).
export {};
