/**
 * ТЗ-150 задача 7.2 — verify-скрипт keyset-батчинга wakeUpNoTagsArticles.
 *
 * Проверяет на стенде (только test/staging БД!):
 *   1. Цикл keyset-батчинга завершается (не зацикливается) на ≥5000 no-tags строк.
 *   2. Порог батча N+1 строго больше порога батча N (монотонность keyset).
 *   3. total равен числу no-tags строк на момент старта.
 *   4. Повторный прогон сразу после завершения возвращает 0.
 *
 * БЕЗОПАСНОСТЬ: скрипт отказывается работать против продакшн-БД.
 * Имя БД из DATABASE_URL должно содержать 'test' или 'staging',
 * либо требуется явный env ALLOW_NON_TEST_DB=1.
 *
 * SQL keyset-цикла ДОЛЖЕН соответствовать tagManager.ts wakeUpNoTagsArticles —
 * при правке фикса правь оба места.
 *
 * По стилю scripts/probe_tz45.js: plain JS, pg Pool, IIFE, exit(1) при ошибке.
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const BATCH_SIZE = 1000; // WAKEUP_BATCH_SIZE из tagManager.ts

let failures = 0;
function pass(msg) { console.log('PASS ' + msg); }
function fail(msg) { failures++; console.log('FAIL ' + msg); }

// 1. Guard: только test/staging БД
let dbName = '';
try {
  dbName = new URL(DATABASE_URL).pathname.replace(/^\//, '').split('?')[0];
} catch {
  console.error('FAIL не удалось разобрать DATABASE_URL');
  process.exit(1);
}
const isTestDb = /test|staging/i.test(dbName);
if (!isTestDb && process.env.ALLOW_NON_TEST_DB !== '1') {
  console.error(`FAIL БД "${dbName}" не похожа на test/staging. Отказ: это verify-скрипт, продакшн трогать нельзя. Задай ALLOW_NON_TEST_DB=1 только если осознанно проверяешь непродакшн стенд.`);
  process.exit(1);
}

const isLocalhost = /^(localhost|127\.0\.0\.1|::1)$/.test(new URL(DATABASE_URL).hostname);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocalhost ? false : { rejectUnauthorized: false },
});

const TS = Date.now();
const SENTINEL_PREFIX = `wakeup-verify-${TS}`;

const NO_TAGS_COUNT_SQL = `
  SELECT count(*)::int AS count FROM news
  WHERE sentiment_source = 'no-tags' AND (matched_tags IS NULL OR matched_tags = '{}')`;

// SQL ДОЛЖЕН соответствовать tagManager.ts wakeUpNoTagsArticles (строки ~1148-1163)
// — при правке фикса правь оба места.
const WAKEUP_BATCH_SQL = `
  WITH pick AS (
    SELECT id FROM news
    WHERE sentiment_source = 'no-tags'
      AND (matched_tags IS NULL OR matched_tags = '{}')
      AND ($2::uuid IS NULL OR id > $2::uuid)
    ORDER BY id
    LIMIT $1
  )
  UPDATE news
  SET needs_translation = TRUE
  FROM pick
  WHERE news.id = pick.id
  RETURNING news.id`;

async function runKeysetLoop() {
  let total = 0;
  let lastId = null;
  const batchThresholds = [];
  const maxIterations = 2 * Math.ceil((await countNoTags() + BATCH_SIZE * 2) / BATCH_SIZE) + 10;
  for (let i = 0; ; i++) {
    if (i > maxIterations) {
      throw new Error(`зацикливание: более ${maxIterations} итераций`);
    }
    const result = await pool.query(WAKEUP_BATCH_SQL, [BATCH_SIZE, lastId]);
    const batch = result.rows.length;
    total += batch;
    if (batch === 0) break;
    lastId = result.rows[result.rows.length - 1].id;
    batchThresholds.push(lastId);
  }
  return { total, batchThresholds };
}

async function countNoTags() {
  const r = await pool.query(NO_TAGS_COUNT_SQL);
  return r.rows[0].count;
}

(async () => {
  const startNoTags = await countNoTags();
  console.log(`no-tags строк на старте: ${startNoTags}`);

  // 2. Seed: доводим до max(start + 5500, 5500) sentinel-строк
  const target = Math.max(startNoTags + 5500, 5500);
  const toInsert = target - startNoTags;
  const sentinelIds = [];
  if (toInsert > 0) {
    const values = [];
    const params = [];
    for (let n = 0; n < toInsert; n++) {
      const base = params.length;
      params.push(
        `${SENTINEL_PREFIX}-${n}`,          // url (UNIQUE)
        `${SENTINEL_PREFIX}-${n}`,          // content_hash (UNIQUE)
      );
      values.push(`(gen_random_uuid(), 'wakeup verify sentinel', $${base + 1}, $${base + 2}, now(), 'no-tags', '{}'::text[], false)`);
    }
    const r = await pool.query(
      `INSERT INTO news (id, title_ru, url, content_hash, published_at, sentiment_source, matched_tags, needs_translation)
       VALUES ${values.join(',')}
       RETURNING id`,
      params
    );
    sentinelIds.push(...r.rows.map(row => row.id));
    console.log(`seed: вставлено ${r.rows.length} sentinel-строк`);
  }
  const expectedTotal = await countNoTags();
  console.log(`ожидаемый total (no-tags после seed): ${expectedTotal}`);

  let cycleOk = false;
  try {
    // 3-4. Первый прогон
    const t0 = Date.now();
    const { total, batchThresholds } = await runKeysetLoop();
    const ms = Date.now() - t0;
    console.log(`первый прогон: total=${total}, батчей: ${batchThresholds.length}, за ${ms} мс`);

    if (total === expectedTotal) pass(`total (${total}) равен числу no-tags на старте`);
    else fail(`total (${total}) != no-tags на старте (${expectedTotal})`);

    let monotone = true;
    for (let i = 1; i < batchThresholds.length; i++) {
      if (!(batchThresholds[i] > batchThresholds[i - 1])) { monotone = false; break; }
    }
    if (batchThresholds.length === 0) monotone = true;
    if (monotone) pass('пороги батчей монотонно растут (keyset id > lastId)');
    else fail(`пороги батчей НЕ монотонны: ${batchThresholds.join(', ')}`);

    // 5. Все sentinel-строки получили needs_translation=true
    const sentCheck = await pool.query(
      `SELECT count(*)::int AS count FROM news WHERE url LIKE $1 AND needs_translation = TRUE`,
      [`${SENTINEL_PREFIX}-%`]
    );
    const sentTotal = sentinelIds.length;
    if (sentCheck.rows[0].count === sentTotal) {
      pass(`все sentinel-строки (${sentTotal}) получили needs_translation=true`);
    } else {
      fail(`needs_translation=true у ${sentCheck.rows[0].count} из ${sentTotal} sentinel-строк`);
    }

    // wakeup сам sentiment_source НЕ меняет (см. комментарий в tagManager.ts:
    // «UPDATE не меняет sentiment_source») — в проде woken-строки забирает news
    // processor, меняя sentiment_source / matched_tags. Эмулируем drain, затем
    // проверяем отсутствие «круга по тем же id».
    const drained = await pool.query(
      `UPDATE news SET sentiment_source = 'wakeup-verify-drained', matched_tags = $1
       WHERE url LIKE $2 AND sentiment_source = 'no-tags'`,
      ['{wakeup-verify}', `${SENTINEL_PREFIX}-%`]
    );
    console.log(`имитация news processor: drained ${drained.rowCount} sentinel-строк`);

    // 6. Повторный прогон: «круга по тем же id» быть не должно. Проверяем,
    // что не вернулось ни одной строки, обработанных первым прогоном:
    // повторный total == числу no-tags, существовавших ДО seed (чужие строки
    // стенда мы не трогаем и не drain'им — это не наши данные).
    const second = await runKeysetLoop();
    if (second.total === startNoTags) pass(`повторный прогон вернул total=${second.total} (обработанные строки не повторяются; новых no-tags нет)`);
    else fail(`повторный прогон вернул total=${second.total} (ожидалось ${startNoTags} — "круг по тем же id")`);

    cycleOk = failures === 0;
  } finally {
    // 7. Cleanup sentinel-строк в любом случае
    const del = await pool.query(`DELETE FROM news WHERE url LIKE $1`, [`${SENTINEL_PREFIX}-%`]);
    console.log(`cleanup: удалено ${del.rowCount} sentinel-строк`);
    await pool.end();
  }

  if (cycleOk) {
    console.log('WAKEUP VERIFY: OK');
    process.exit(0);
  } else {
    console.log('WAKEUP VERIFY: FAILED');
    process.exit(1);
  }
})().catch(e => {
  console.error('FAIL исключение:', e.message);
  console.log('WAKEUP VERIFY: FAILED');
  process.exit(1);
});
