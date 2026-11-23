/**
 * =============================================================================
 * PULSE — ТЗ-205.1, Задача 3: backfill og.jpg для существующих обложек
 * =============================================================================
 *
 * Для каждой обложки courses/course_paths, чья cover_url оканчивается на .webp,
 * читает webp из storage и пишет парную производную <uuid>.og.jpg (1200×630
 * jpeg — ТЗ-205.1). Идемпотентно: существующий og.jpg → skip. Ничего не
 * удаляет и не меняет в БД (деривация пути детерминирована из cover_url).
 *
 * Запуск (на VDS, из каталога бэкенда, после деплоя ТЗ-205.1):
 *   # сухой прогон — только лог, без записи (дефолт):
 *   npx ts-node --transpile-only scripts/backfill-og-covers.ts
 *   # боевой прогон:
 *   npx ts-node --transpile-only scripts/backfill-og-covers.ts --apply
 */
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import { query } from '../src/config/db';
import { putBuffer, UPLOADS_DIR } from '../src/services/storage/driver';
import { ogJpgPathFromCover } from '../src/utils/ogMeta';

const APPLY = process.argv.includes('--apply');

function absFromRel(relPath: string): string {
  // тот же маппинг, что в driver: /media/<kind>/<file> → UPLOADS_DIR/<kind>/<file>
  return path.join(UPLOADS_DIR, relPath.replace(/^\/media\//, ''));
}

interface Row { cover_url: string }

async function main() {
  const res = await query(
    `SELECT cover_url FROM courses WHERE cover_url LIKE '%.webp'
     UNION
     SELECT cover_url FROM course_paths WHERE cover_url LIKE '%.webp'`,
    []
  );
  console.log(`[BackfillOG] обложек .webp: ${res.rows.length}, apply=${APPLY}`);

  let done = 0, skipped = 0, failed = 0;
  for (const row of res.rows as Row[]) {
    const ogRel = ogJpgPathFromCover(row.cover_url);
    if (!ogRel) { skipped++; continue; }
    const ogAbs = absFromRel(ogRel);
    try {
      if (fs.existsSync(ogAbs)) { skipped++; continue; } // идемпотентность
      const webpBuf = await fs.promises.readFile(absFromRel(row.cover_url));
      // og.jpg 1200×630 — те же параметры, что в compressCoverImage.ogJpg
      const sharp = (await import('sharp')).default;
      const ogJpg = await sharp(webpBuf)
        .resize({ width: 1200, height: 630, fit: 'cover', position: 'attention' })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer();
      if (!APPLY) { done++; continue; } // dry-run: посчитали, не пишем
      await putBuffer(ogJpg, 'courses', 'cover.og.jpg', { relPath: ogRel });
      done++;
    } catch (err: any) {
      failed++;
      console.warn(`[BackfillOG] ${ogRel}: ${err.message?.slice(0, 100)}`);
    }
  }
  console.log(`[BackfillOG] готово: ${done} обработано, ${skipped} пропущено (есть/не webp), ${failed} ошибок`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error('[BackfillOG] fatal:', err.message); process.exit(1); });
