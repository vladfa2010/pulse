/**
 * ТЗ-103, критерий приёмки №3 — бэкфилл эмбеддингов курсов.
 *
 * Считает эмбеддинг КАЖДОГО существующего курса (не удалённого) через тот же
 * путь, что и триггеры Задачи 1: title + '\n' + description + '\n' + названия
 * уроков (обрезка 1000) → embedBatch (TEI) → courses.embedding.
 *
 * Запуск (на сервере/VDS, после применения lms_v3_matching.sql):
 *   npm run build
 *   EMBEDDINGS_URL=http://embeddings:80 node scripts/backfill-course-embeddings.js
 *
 * Идемпотентен: перезапись уже посчитанных эмбеддингов безвредна.
 * Ошибки по отдельному курсу (TEI недоступен и т.п.) логируются, прогон
 * продолжается; код выхода 0 при частичных ошибках, 1 — если упал весь прогон.
 */

const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');

async function main() {
  const { query } = require(path.join(DIST, 'config', 'db'));
  const { computeCourseEmbedding } = require(path.join(DIST, 'services', 'education', 'match'));

  const courses = await query(
    `SELECT id, title FROM courses WHERE deleted_at IS NULL ORDER BY created_at ASC`,
    [],
  );
  if (courses.rows.length === 0) {
    console.log('[Backfill] courses: 0 — нечего считать');
    return;
  }
  console.log(`[Backfill] courses: ${courses.rows.length} — считаю эмбеддинги`);

  let done = 0;
  let failed = 0;
  for (const c of courses.rows) {
    try {
      await computeCourseEmbedding(c.id);
      done++;
      console.log(`[Backfill] ${done}/${courses.rows.length} ok: ${c.title}`);
    } catch (err) {
      failed++;
      console.warn(`[Backfill] FAIL course ${c.id} («${c.title}»): ${err?.message}`);
    }
  }
  console.log(`[Backfill] готово: ${done} ok, ${failed} failed из ${courses.rows.length}`);
  if (done === 0 && courses.rows.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[Backfill] fatal:', err?.message || err);
  process.exit(1);
});
