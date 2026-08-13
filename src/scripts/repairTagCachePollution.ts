// ═══════════════════════════════════════════════════════════════════════════
// One-time repair: fix news articles polluted by smart_tag_cache key collisions.
//
// Root cause: old cache key was base64(title+summary).slice(0,64), covering only
// the first 48 bytes. Telegram sources prefix every article with emoji+hashtags,
// so many unrelated articles shared one cache key and inherited each other's LLM tags.
//
// This script re-runs the current (fixed) tag matcher over the last 7 days of
// tagged articles and rewrites matched_tags / news_tag_links where they differ.
//
// Run:  npx tsx src/scripts/repairTagCachePollution.ts       # dry-run
//       REPAIR=1 npx tsx src/scripts/repairTagCachePollution.ts  # write
// ═══════════════════════════════════════════════════════════════════════════

import { query } from '../config/db';
import { smartMatchTagsBatch } from '../services/smartTagMatcher';
import { populateNewsTagLinksBatch } from '../services/enrichment';
import { getAllTagNames } from '../services/tagManager';

const BATCH_SIZE = 5;
const REPAIR_MODE = process.env.REPAIR === '1';

interface ArticleRow {
  id: string;
  title_original: string | null;
  title_ru: string | null;
  summary_original: string | null;
  summary_ru: string | null;
  matched_tags: string[] | null;
  tag_impact: any;
  published_at: string;
}

function chunks<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function cleanTagImpact(tagImpact: any, keepTags: string[]): any {
  if (!tagImpact || !Array.isArray(tagImpact)) return [];
  return tagImpact.filter((ti: any) => ti && keepTags.includes(ti.tag));
}

async function main() {
  console.log(`[Repair] Mode: ${REPAIR_MODE ? 'WRITE' : 'DRY-RUN'} (set REPAIR=1 to apply changes)`);

  const availableTags = await getAllTagNames();
  console.log(`[Repair] Available tags: ${availableTags.length}`);

  const result = await query(`
    SELECT id,
           title_original,
           title_ru,
           summary_original,
           summary_ru,
           matched_tags,
           tag_impact,
           published_at
    FROM news
    WHERE published_at > NOW() - INTERVAL '7 days'
      AND array_length(matched_tags, 1) > 0
    ORDER BY published_at DESC
  `);

  const articles: ArticleRow[] = result.rows;
  console.log(`[Repair] Articles to check: ${articles.length}`);

  let scanned = 0;
  let changed = 0;

  const batches = chunks(articles, BATCH_SIZE);

  for (const batch of batches) {
    const items = batch.map(a => ({
      title: a.title_ru || a.title_original || '',
      summary: a.summary_ru || a.summary_original || '',
    }));

    const newTagsList = await smartMatchTagsBatch(items, { availableTags });

    for (let i = 0; i < batch.length; i++) {
      const article = batch[i];
      const oldTags = article.matched_tags || [];
      const newTags = [...new Set(newTagsList[i])].sort();
      scanned++;

      if (arraysEqual(oldTags, newTags)) {
        continue;
      }

      changed++;
      const removed = oldTags.filter((t: string) => !newTags.includes(t));
      const added = newTags.filter((t: string) => !oldTags.includes(t));

      console.log(
        `[Repair] ${article.id} published=${article.published_at}\n` +
        `  old: ${oldTags.join(', ')}\n` +
        `  new: ${newTags.join(', ')}\n` +
        `  -${removed.length} ${removed.join(', ') || '-'} | +${added.length} ${added.join(', ') || '-'}`
      );

      if (!REPAIR_MODE) continue;

      const cleanedImpact = cleanTagImpact(article.tag_impact, newTags);

      // Update news row
      await query(
        `UPDATE news
         SET matched_tags = $1,
             tag_impact = $2
         WHERE id = $3`,
        [newTags, JSON.stringify(cleanedImpact), article.id]
      );

      // Rebuild news_tag_links atomically for this article
      await query(`DELETE FROM news_tag_links WHERE news_id = $1`, [article.id]);

      if (newTags.length > 0) {
        await populateNewsTagLinksBatch([{
          newsId: article.id,
          matchedTags: newTags,
          tagImpacts: [],
        }]);
      }
    }
  }

  console.log(`[Repair] Done. Scanned: ${scanned}, changed: ${changed}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[Repair] Fatal error:', err);
  process.exit(1);
});
