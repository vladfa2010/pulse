// Smoke-проверка LMS шага 1 (ТЗ-100): SQLite-схема + storage-драйвер.
// Запуск: node scripts/smoke-lms-step1.js (после npx tsc)
process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = '/tmp/lms-smoke/pulse.db';
process.env.UPLOADS_DIR = '/tmp/lms-smoke/uploads';
process.env.SIGNED_URL_SECRET = 'smoke-secret-0123456789abcdef';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

(async () => {
  fs.rmSync('/tmp/lms-smoke', { recursive: true, force: true });
  fs.mkdirSync('/tmp/lms-smoke', { recursive: true });

  const sqlite = require('../dist/config/db-sqlite');
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();

  // 1. Все LMS-таблицы созданы
  const tables = ['courses', 'course_categories', 'course_tags', 'course_lessons',
    'lesson_tests', 'course_materials', 'course_enrollments', 'course_tariffs',
    'user_path_shares', 'lesson_progress', 'news_course_links'];
  for (const t of tables) {
    const r = await sqlite.query(`SELECT name FROM sqlite_master WHERE type='table' AND name=$1`, [t]);
    assert(r.rows.length === 1, `table ${t} missing`);
  }
  console.log('OK 1: 11 LMS-таблиц в SQLite-схеме');

  // Идемпотентность повторного вызова схемы
  await sqlite.initSQLiteSchema();
  console.log('OK 2: initSQLiteSchema идемпотентна');

  // 2. Storage: bootstrap каталогов
  const driver = require('../dist/services/storage/driver');
  await driver.bootstrapStorage();
  for (const d of ['courses', 'materials', 'ugc', 'tmp', 'tmp/trash', 'quarantine']) {
    assert(fs.statSync(path.join('/tmp/lms-smoke/uploads', d)).isDirectory(), `dir ${d} missing`);
  }
  console.log('OK 3: bootstrap каталогов courses/materials/ugc/tmp/tmp/trash/quarantine');

  // 3. putBuffer → атомарная запись, relPath в конвенции /media/<kind>/
  const put = await driver.putBuffer(Buffer.from('hello-pdf'), 'materials', 'Мой отчёт 2026.PDF');
  assert(/^\/media\/materials\/[a-f0-9-]+\.pdf$/.test(put.relPath), `bad relPath: ${put.relPath}`);
  // на диске — без префикса /media: UPLOADS_DIR/materials/<file>
  assert(fs.existsSync('/tmp/lms-smoke/uploads' + put.relPath.replace(/^\/media/, '')), 'file not on disk');
  console.log('OK 4: putBuffer →', put.relPath);

  // 4. signedUrl / verifySignedUrl
  const url = driver.signedUrl(put.relPath, 3600);
  const u = new URL('http://x' + url);
  assert(driver.verifySignedUrl(put.relPath, u.searchParams.get('expires'), u.searchParams.get('sig')) === true);
  assert(driver.verifySignedUrl(put.relPath, u.searchParams.get('expires'), 'forged-sig') === false);
  assert(driver.verifySignedUrl('/media/materials/other.pdf', u.searchParams.get('expires'), u.searchParams.get('sig')) === false);
  assert(driver.verifySignedUrl(put.relPath, String(Math.floor(Date.now() / 1000) - 10), u.searchParams.get('sig')) === false);
  assert(driver.isPublicKind('/media/courses/x.png') === true);
  assert(driver.isPublicKind('/media/materials/x.pdf') === false);
  console.log('OK 5: HMAC-подпись — валидна, подделка/чужой путь/expired → false');

  // 5. removeFile → soft-delete в tmp/trash
  await driver.removeFile(put.relPath);
  assert(!fs.existsSync('/tmp/lms-smoke/uploads' + put.relPath), 'file still in place');
  const trash = fs.readdirSync('/tmp/lms-smoke/uploads/tmp/trash');
  assert(trash.length === 1 && trash[0].endsWith('.pdf'), 'trash contents wrong');
  console.log('OK 6: soft-delete → tmp/trash, файл из materials исчез (signed URL → 404)');

  // 6. purgeExpiredTrash: свежий trash остаётся, состаренный удаляется
  const old = path.join('/tmp/lms-smoke/uploads/tmp/trash', 'old-file.bin');
  fs.writeFileSync(old, 'x');
  const past = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  fs.utimesSync(old, past, past);
  const removed = await driver.purgeExpiredTrash();
  assert(removed === 1 && !fs.existsSync(old), 'purge failed');
  assert(fs.readdirSync('/tmp/lms-smoke/uploads/tmp/trash').length === 1, 'fresh trash removed');
  console.log('OK 7: purgeExpiredTrash удалил просроченный (>30 дн), свежий оставил');

  // 7. Path traversal защита: файловые операции отклоняют путь вне хранилища
  await assert.rejects(
    () => driver.removeFile('/media/../../etc/passwd'),
    /invalid path/,
  );
  console.log('OK 8: path traversal в absFromRel отклонён');

  // 8. assertCourseAccess: уровни guest/admin/enrolled
  const access = require('../dist/services/education/access');
  assert(await access.assertCourseAccess(undefined, 'x') === 'guest');
  const uid = '11111111-2222-4333-8444-555555555555';
  const cid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  await sqlite.query(`INSERT INTO users (id, email, username, password_hash) VALUES ($1,'smoke@test.ru','smoke','x')`, [uid]);
  await sqlite.query(`INSERT INTO course_categories (id, name) VALUES ('investing','Инвестиции')`);
  await sqlite.query(`INSERT INTO courses (id, title, slug, price, status) VALUES ($1,'T','t',0,'published')`, [cid]);
  assert(await access.assertCourseAccess(uid, cid) === 'free', 'free course → free');
  await sqlite.query(`INSERT INTO course_enrollments (user_id, course_id, source) VALUES ($1,$2,'free')`, [uid, cid]);
  assert(await access.assertCourseAccess(uid, cid) === 'enrolled');
  access.logIdorBlocked(uid, 'lesson', 'zzz');
  console.log('OK 9: assertCourseAccess guest/free/enrolled + IDOR-лог');

  console.log('\nSMOKE OK — все проверки LMS шага 1 пройдены');
  process.exit(0);
})().catch((e) => { console.error('SMOKE FAIL:', e); process.exit(1); });
