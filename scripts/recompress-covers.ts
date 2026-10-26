/**
 * =============================================================================
 * PULSE — ТЗ-198, Задача 3: разовое пережатие существующих обложек
 * =============================================================================
 *
 * Пробегает courses.cover_url и course_paths.cover_url, где путь НЕ оканчивается
 * на .webp, читает файл из storage, прогоняет тот же пайплайн, что и при загрузке
 * (≤1920px, WebP q82), сохраняет как cover.webp, обновляет cover_url,
 * старый файл — в tmp/trash (retention 30 дней, откат ручками из trash).
 *
 * Запуск (на VDS, из каталога бэкенда, после деплоя ТЗ-198):
 *   # сначала сухой прогон — только лог, без записи:
 *   npx ts-node --transpile-only scripts/recompress-covers.ts --dry-run
 *   # боевой прогон (вне пика):
 *   npx ts-node --transpile-only scripts/recompress-covers.ts
 *
 * Идемпотентен: повторный прогон не найдёт не-webp обложек.
 * Ошибки по отдельной записи логируются, прогон продолжается.
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import { query } from '../src/config/db';
import { putBuffer, removeFile, UPLOADS_DIR } from '../src/services/storage/driver';
import { compressCoverImage } from '../src/utils/coverImage';

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

interface CoverRow {
  table: 'courses' | 'course_paths';
  idKey: 'course_id' | 'path_id';
  id: string;
  coverUrl: string;
}

async function fetchCovers(): Promise<CoverRow[]> {
  const courses = await query(
    `SELECT id, cover_url FROM courses
     WHERE cover_url IS NOT NULL AND lower(cover_url) NOT LIKE '%.webp'`,
  );
  const pathsR = await query(
    `SELECT id, cover_url FROM course_paths
     WHERE cover_url IS NOT NULL AND lower(cover_url) NOT LIKE '%.webp'`,
  );
  return [
    ...courses.rows.map((r: any) => ({
      table: 'courses' as const, idKey: 'course_id' as const, id: String(r.id), coverUrl: String(r.cover_url),
    })),
    ...pathsR.rows.map((r: any) => ({
      table: 'course_paths' as const, idKey: 'path_id' as const, id: String(r.id), coverUrl: String(r.cover_url),
    })),
  ];
}

function absFromRelLocal(relPath: string): string {
  const rel = relPath.replace(/^\/+/, '');
  const withoutMedia = rel.startsWith('media/') ? rel.slice('media/'.length) : rel;
  const abs = path.resolve(UPLOADS_DIR, withoutMedia);
  if (abs !== UPLOADS_DIR && !abs.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
    throw new Error(`путь вне storage: ${relPath}`);
  }
  return abs;
}

async function main() {
  const rows = await fetchCovers();
  console.log(`[Recompress] найдено обложек не-webp: ${rows.length}${DRY_RUN ? ' (DRY-RUN — запись выключена)' : ''}`);
  if (rows.length === 0) return;

  let done = 0;
  let failed = 0;
  let savedBytes = 0;
  let inBytes = 0;
  for (const row of rows) {
    try {
      const abs = absFromRelLocal(row.coverUrl);
      const input = await fs.promises.readFile(abs);
      const output = await compressCoverImage(input);
      inBytes += input.length;
      savedBytes += Math.max(0, input.length - output.length);
      if (DRY_RUN) {
        done++;
        console.log(`[Recompress] ${done}/${rows.length} dry: ${row.table}/${row.id} ${row.coverUrl} ` +
          `(${input.length} → ${output.length} байт)`);
        continue;
      }
      const put = await putBuffer(output, 'courses', 'cover.webp');
      await query(
        `UPDATE ${row.table} SET cover_url = $1, updated_at = now() WHERE id = $2`,
        [put.relPath, row.id],
      );
      await removeFile(row.coverUrl);
      done++;
      console.log(`[Recompress] ${done}/${rows.length} ok: ${row.table}/${row.id} ` +
        `${row.coverUrl} → ${put.relPath} (${input.length} → ${put.size} байт)`);
    } catch (err: any) {
      failed++;
      console.warn(`[Recompress] FAIL ${row.table}/${row.id} (${row.coverUrl}): ${err?.message}`);
    }
  }

  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  console.log(`[Recompress] готово: ${done} ok, ${failed} failed из ${rows.length}; ` +
    `вход ${mb(inBytes)} МБ → выход ${mb(inBytes - savedBytes)} МБ (экономия ${mb(savedBytes)} МБ)`);
  if (done === 0 && rows.length > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[Recompress] фатальная ошибка:', err);
    process.exit(1);
  })
  .finally(() => process.exit());
