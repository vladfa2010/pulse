/**
 * ТЗ-170, Задача 3 — починка уже сохранённых mojibake-title в course_materials.
 *
 * multer/busboy отдавал originalname в Latin-1, браузер шлёт UTF-8 →
 * в course_materials.title зашита кракозябра («ÐÐ´Ð¸Ð½Ð°Ñ...»).
 *
 * Что делает:
 *   1. Выбирает строки, где title содержит маркеры mojibake
 *      (кириллица в UTF-8, прочитанная как Latin-1, всегда даёт Ð/Ñ).
 *   2. Перекодирует тем же decodeUploadName, что и рантайм (latin1→utf8).
 *   3. UPDATE только если результат отличается и не содержит �.
 *      Идемпотентно: повторный запуск — no-op.
 *
 * Storage-ключи (url) НЕ трогаем: файл лежит под UUID-именем, ключ технический.
 *
 * Запуск (на VDS, после npm run build и деплоя):
 *   node scripts/fix-material-names-mojibake.js
 *
 * Код выхода: 0 — ок (в т.ч. «нечего чинить»), 1 — ошибка прогона.
 */

const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');

// Маркеры: байты 0xD0/0xD1 (Ð/Ñ) — неизбежный след кириллического UTF-8,
// прочитанного как Latin-1. LIKE с экранированием под postgres.
const MOJIBAKE_SQL = `SELECT id, title FROM course_materials
  WHERE title LIKE '%' || chr(208) || '%' OR title LIKE '%' || chr(209) || '%'
  ORDER BY created_at ASC`;

async function main() {
  const { query } = require(path.join(DIST, 'config', 'db'));
  const { decodeUploadName } = require(path.join(DIST, 'utils', 'filename'));

  const rows = (await query(MOJIBAKE_SQL, [])).rows;
  if (rows.length === 0) {
    console.log('[FixNames] кандидатов с маркерами mojibake не найдено — нечего чинить');
    return;
  }
  console.log(`[FixNames] кандидатов с маркерами Ð/Ñ: ${rows.length} — проверяю`);

  let fixed = 0;
  let skipped = 0;
  for (const r of rows) {
    const decoded = decodeUploadName(String(r.title ?? ''));
    if (decoded === r.title || decoded.includes('�')) {
      skipped++; // Ð/Ñ встретились в легальном имени (guard) — не трогаем
      continue;
    }
    await query(`UPDATE course_materials SET title = $1 WHERE id = $2`, [decoded, r.id]);
    fixed++;
    console.log(`[FixNames] ${r.id}: "${r.title}" → "${decoded}"`);
  }
  console.log(`[FixNames] готово: исправлено ${fixed}, пропущено ${skipped}. Повторный запуск — no-op.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[FixNames] ошибка прогона:', err?.message || err);
    process.exit(1);
  });
