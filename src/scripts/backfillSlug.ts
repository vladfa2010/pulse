// ═══════════════════════════════════════════════════════════════════════════
// One-time backfill: generate slugs for existing news articles
// Run after migration: npx ts-node src/scripts/backfillSlug.ts
// ═══════════════════════════════════════════════════════════════════════════

import { query } from '../config/db';
import { slugify } from '../utils/slugify';

async function backfillSlugs() {
  const result = await query(`SELECT id, title_original, title_ru FROM news WHERE slug IS NULL`);
  console.log(`[Backfill] ${result.rows.length} articles without slug`);

  for (const row of result.rows) {
    const title = row.title_original || row.title_ru || 'news';
    let slug = slugify(title, row.id);

    try {
      await query(`UPDATE news SET slug = $1 WHERE id = $2`, [slug, row.id]);
      console.log(`[Backfill] ${row.id} → ${slug}`);
    } catch (err: any) {
      if (/unique constraint/i.test(err.message)) {
        const longSlug = slug + row.id.replace(/-/g, '').substring(8, 12);
        await query(`UPDATE news SET slug = $1 WHERE id = $2`, [longSlug, row.id]);
        console.log(`[Backfill] ${row.id} → ${longSlug} (collision resolved)`);
      } else {
        console.error(`[Backfill] ${row.id} failed:`, err.message);
      }
    }
  }

  console.log('[Backfill] Done');
  process.exit(0);
}

backfillSlugs().catch((err) => {
  console.error(err);
  process.exit(1);
});
