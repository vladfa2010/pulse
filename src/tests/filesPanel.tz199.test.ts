/**
 * =============================================================================
 * PULSE — ТЗ-199: галерея файлов в админке (тесты драйвера + usage-скана)
 * =============================================================================
 *
 * Чистый юнит-прогон без HTTP (критерий 7 ТЗ — path traversal проверяется
 * на guard-функции; auth на всех эндпоинтах — adminMiddleware, как везде):
 *   1. Драйвер (реальный fs на temp UPLOADS_DIR):
 *      - listFiles по kind и по всем четырём каталогам;
 *      - removeFile → манифест <trashName>.path с исходным relPath;
 *      - listTrash: манифест не попадает в выдачу, старый формат без
 *        манифеста → originalRelPath=null, deletedAt/expiresAt из префикса;
 *      - restoreFile: ок / 409 (путь занят) / 400 (нет манифеста);
 *      - purgeTrashFile: файл и манифест исчезают навсегда;
 *      - normalizeMediaPath: traversal и посторонние kind → StorageError 400.
 *   2. Usage-скан (SQLite, сидированные courses/course_paths/course_lessons/
 *      course_materials): обложка курса, обложка программы, картинка конспекта,
 *      editorial-материал, UGC-заявка (pending), сирота; удалённый курс не
 *      засчитывает обложку как привязку.
 *
 * Запуск:  TS_NODE_TRANSPILE_ONLY=true npx ts-node src/tests/filesPanel.tz199.test.ts
 * (transpile-only — у sql.js нет типов для ts-node, тот же режим, что и у
 * weeklyReportChart.test.ts на локальной машине; tsc --noEmit проходит штатно)
 */

// ВАЖНО: env ставим ДО любых импортов модулей (драйвер читает при загрузке)
process.env.STORAGE_DRIVER = 'local';
process.env.SIGNED_URL_SECRET = 'test-secret-test-secret-test-secret-0001';
process.env.USE_SQLITE = 'true';
// Дев-станции с забитым диском (<10% свободно): проверку места отключаем,
// в тесте она не предмет (env-override задокументирован в driver.ts, S6).
process.env.STORAGE_MIN_FREE_PCT = '0';

import fs from 'fs';
import os from 'os';
import path from 'path';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const DAY = 24 * 60 * 60 * 1000;

async function runDriverTests(): Promise<void> {
  console.log('\nТЗ-199.1 Драйвер (temp UPLOADS_DIR):');

  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz199-uploads-'));
  process.env.UPLOADS_DIR = uploadsDir;
  const driver = await import('../services/storage/driver');

  // Bootstrap-каталоги (без bootstrapStorage — не поднимаем таймеры)
  for (const d of ['courses', 'materials', 'ugc', 'content', 'tmp/trash', 'quarantine']) {
    fs.mkdirSync(path.join(uploadsDir, d), { recursive: true });
  }

  // 1. listFiles: запись по kind и сводный листинг
  const putA = await driver.putBuffer(Buffer.from('cover-a'), 'courses', 'a.webp');
  const putB = await driver.putBuffer(Buffer.from('material-b'), 'materials', 'b.pdf');
  const putC = await driver.putBuffer(Buffer.from('content-c'), 'content', 'c.png');

  const coursesFiles = await driver.listFiles('courses');
  check('listFiles(courses) видит загруженный файл',
    coursesFiles.some((f) => f.relPath === putA.relPath && f.size === Buffer.from('cover-a').length),
    coursesFiles);

  const allFiles = await driver.listFiles();
  check('listFiles() без kind — все четыре каталога',
    allFiles.length === 3 &&
    [putA, putB, putC].every((p) => allFiles.some((f) => f.relPath === p.relPath)),
    allFiles.map((f) => f.relPath));
  check('listFiles() отсортирован по relPath',
    allFiles.every((f, i) => i === 0 || allFiles[i - 1].relPath <= f.relPath));

  // 2. removeFile + манифест
  await driver.removeFile(putA.relPath);
  const afterDelete = await driver.listFiles('courses');
  check('после removeFile файла нет в kind-каталоге',
    !afterDelete.some((f) => f.relPath === putA.relPath));
  const trashAfterDelete = await driver.listTrash();
  const trashed = trashAfterDelete.find((t) => t.originalRelPath === putA.relPath);
  check('removeFile → файл в trash с манифестом исходного relPath', !!trashed, trashAfterDelete);
  check('trashName — плоское имя с префиксом <ts>-',
    !!trashed && /^\d{10,}-/.test(trashed.trashName), trashed?.trashName);
  check('deletedAt из префикса, expiresAt = deletedAt + 30 дней',
    !!trashed && trashed.deletedAt !== null && trashed.expiresAt !== null &&
    Math.abs(trashed.expiresAt!.getTime() - trashed.deletedAt!.getTime() - 30 * DAY) < 1000,
    trashed);

  // 3. Старый формат trash (запись до ТЗ-199, без манифеста)
  const legacyName = `${Date.now() - 5 * DAY}-legacy.png`;
  fs.writeFileSync(path.join(uploadsDir, 'tmp', 'trash', legacyName), Buffer.from('old'));
  const trashWithLegacy = await driver.listTrash();
  const legacy = trashWithLegacy.find((t) => t.trashName === legacyName);
  check('старая запись без манифеста — originalRelPath=null, restore возможен только для новых',
    !!legacy && legacy.originalRelPath === null);
  check('манифесты .path не попадают в выдачу корзины',
    trashWithLegacy.every((t) => !t.trashName.endsWith('.path')),
    trashWithLegacy.map((t) => t.trashName));

  // 4. restoreFile: ок
  const restoreRes = await driver.restoreFile(trashed!.trashName);
  check('restoreFile вернул исходный relPath', restoreRes.relPath === putA.relPath, restoreRes);
  const afterRestore = await driver.listFiles('courses');
  check('после restore файл снова в kind-каталоге',
    afterRestore.some((f) => f.relPath === putA.relPath));
  const trashAfterRestore = await driver.listTrash();
  check('после restore запись исчезла из корзины',
    !trashAfterRestore.some((t) => t.trashName === trashed!.trashName));

  // 5. restoreFile: 409 — путь занят
  await driver.removeFile(putB.relPath);
  const trashedB = (await driver.listTrash()).find((t) => t.originalRelPath === putB.relPath)!;
  fs.writeFileSync(path.join(uploadsDir, 'materials', path.basename(putB.relPath)), Buffer.from('occupied'));
  let restore409: any = null;
  try {
    await driver.restoreFile(trashedB.trashName);
  } catch (err: any) {
    restore409 = err;
  }
  check('restore в занятый путь → StorageError 409',
    restore409 instanceof driver.StorageError && restore409.status === 409, restore409?.status);

  // 6. restoreFile: 400 — нет манифеста
  let restore400: any = null;
  try {
    await driver.restoreFile(legacyName);
  } catch (err: any) {
    restore400 = err;
  }
  check('restore без манифеста → StorageError 400',
    restore400 instanceof driver.StorageError && restore400.status === 400, restore400?.status);

  // 7. purgeTrashFile — навсегда (файл + манифест)
  await driver.purgeTrashFile(trashedB.trashName);
  const trashAfterPurge = await driver.listTrash();
  check('purge: запись исчезла из корзины',
    !trashAfterPurge.some((t) => t.trashName === trashedB.trashName));
  check('purge: файла физически нет в tmp/trash',
    !fs.existsSync(path.join(uploadsDir, 'tmp', 'trash', trashedB.trashName)) &&
    !fs.existsSync(path.join(uploadsDir, 'tmp', 'trash', `${trashedB.trashName}.path`)));

  // 8. normalizeMediaPath: guard от path traversal (критерий 7 ТЗ-199)
  const okPath = driver.normalizeMediaPath('/media/courses/abc.webp');
  check('normalizeMediaPath: валидный путь проходит', okPath === '/media/courses/abc.webp', okPath);
  for (const bad of ['../../etc/passwd', '/etc/passwd', '/media/tmp/x.png', 'media/courses/x', '/media/courses/../secret', '', '/media/../x']) {
    let threw: any = null;
    try {
      driver.normalizeMediaPath(bad);
    } catch (err: any) {
      threw = err;
    }
    check(`normalizeMediaPath: "${bad}" → StorageError 400`,
      threw instanceof driver.StorageError && threw.status === 400, bad);
  }

  // 9. sanitizeTrashName
  for (const bad of ['../x', 'a/b', 'a\\b', 'x.path', '']) {
    let threw: any = null;
    try {
      driver.sanitizeTrashName(bad);
    } catch (err: any) {
      threw = err;
    }
    check(`sanitizeTrashName: "${bad}" → StorageError 400`,
      threw instanceof driver.StorageError && threw.status === 400, bad);
  }

  fs.rmSync(uploadsDir, { recursive: true, force: true });
}

async function runUsageTests(): Promise<void> {
  console.log('\nТЗ-199.2 Usage-скан (SQLite, сидированные привязки):');

  process.env.SQLITE_FILE = path.join(os.tmpdir(), `tz199-usage-${Date.now()}.db`);
  const sqlite = await import('../config/db-sqlite');
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();

  const { scanFileUsages } = await import('../services/education/fileUsage');

  // Курсы: живой с обложкой, удалённый с обложкой (привязка «битая»)
  await sqlite.query(
    `INSERT INTO courses (id, title, slug, cover_url, status, deleted_at)
     VALUES ('c1', 'Курс живой', 'c1', '/media/courses/cover1.webp', 'published', NULL)`, []);
  await sqlite.query(
    `INSERT INTO courses (id, title, slug, cover_url, status, deleted_at)
     VALUES ('c-del', 'Курс удалён', 'c-del', '/media/courses/cover-del.webp', 'published', '2026-10-01 00:00:00')`, []);
  // Программа с обложкой
  await sqlite.query(
    `INSERT INTO course_paths (id, title, slug, cover_url, status, created_at, updated_at)
     VALUES ('p1', 'Программа 1', 'p1', '/media/courses/path-cover.webp', 'published', '2026-09-01', '2026-09-01')`, []);
  // Урок с картинкой конспекта
  await sqlite.query(
    `INSERT INTO course_lessons (id, course_id, position, title, kind, text_content)
     VALUES ('l1', 'c1', 1, 'Урок с картинкой', 'text', '<p><img src="/media/content/img1.png"></p>')`, []);
  // Материалы: editorial + UGC-заявка на проверке
  await sqlite.query(
    `INSERT INTO course_materials (id, course_id, kind, title, url, origin, status)
     VALUES ('m1', 'c1', 'file', 'Методичка', '/media/materials/doc1.pdf', 'editorial', 'approved')`, []);
  await sqlite.query(
    `INSERT INTO course_materials (id, course_id, kind, title, url, origin, status)
     VALUES ('m2', 'c1', 'file', 'Файл пользователя', '/media/ugc/ugc1.pdf', 'user', 'pending')`, []);

  const paths = [
    '/media/courses/cover1.webp',
    '/media/courses/cover-del.webp',
    '/media/courses/path-cover.webp',
    '/media/content/img1.png',
    '/media/materials/doc1.pdf',
    '/media/ugc/ugc1.pdf',
    '/media/content/orphan.png',
  ];
  const map = await scanFileUsages(sqlite.query, paths);
  const usage = (p: string) => map.get(p) || [];

  const cover = usage('/media/courses/cover1.webp');
  check('обложка курса → course_cover с id и title курса',
    cover.length === 1 && cover[0].type === 'course_cover' && cover[0].id === 'c1' && cover[0].title === 'Курс живой',
    cover);

  check('обложка удалённого курса — сирота (deleted_at IS NULL в скане)',
    usage('/media/courses/cover-del.webp').length === 0);

  const pathCover = usage('/media/courses/path-cover.webp');
  check('обложка программы → path_cover, без course_id (бейдж некликабелен)',
    pathCover.length === 1 && pathCover[0].type === 'path_cover' && pathCover[0].course_id === null,
    pathCover);

  const lesson = usage('/media/content/img1.png');
  check('картинка конспекта → lesson_content с уроком и курсом',
    lesson.length === 1 && lesson[0].type === 'lesson_content' &&
    lesson[0].id === 'l1' && lesson[0].title === 'Урок с картинкой' &&
    lesson[0].course_id === 'c1' && lesson[0].course_title === 'Курс живой',
    lesson);

  const mat = usage('/media/materials/doc1.pdf');
  check('editorial-материал → material с курсом',
    mat.length === 1 && mat[0].type === 'material' && mat[0].origin === 'editorial' && mat[0].course_id === 'c1',
    mat);

  const ugc = usage('/media/ugc/ugc1.pdf');
  check('UGC-заявка → material с origin=user и статусом pending',
    ugc.length === 1 && ugc[0].origin === 'user' && ugc[0].status === 'pending', ugc);

  check('сирота — пустой usage', usage('/media/content/orphan.png').length === 0);
  check('пустой список путей → пустая карта', (await scanFileUsages(sqlite.query, [])).size === 0);

  fs.rmSync(process.env.SQLITE_FILE, { force: true });
}

async function main(): Promise<void> {
  await runDriverTests();
  await runUsageTests();
  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
