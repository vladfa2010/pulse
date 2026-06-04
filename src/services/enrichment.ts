// =============================================================================
// PULSE — Article Enrichment
// =============================================================================
// Populate news_tag_links после unified batch LLM-анализа.
// 
// Ключевые свойства:
// - Транзакция через pool.connect() — атомарность INSERT + UPDATE
// - Batch INSERT через unnest() — не N+1
// - Try/catch в cron — при ошибке статья доступна через JSONB fallback

import { pool, query } from '../config/db';

export interface TagImpact {
  tag: string;
  score: number;
  reasoning: string;
}

/**
 * Атомарно создаёт связи статья-тег после LLM-анализа.
 * 
 * Транзакция гарантирует: либо все link'и + enrichment_version=2, либо ничего.
 * Если падает — статья доступна через старый JSONB путь (enrichment_version=1).
 * 
 * @param newsId — UUID статьи в news
 * @param matchedTags — теги от keyword matching (Layer 1)
 * @param tagImpacts — результаты LLM unified batch
 */
export async function populateNewsTagLinks(
  newsId: string,
  matchedTags: string[],
  tagImpacts: TagImpact[],
): Promise<void> {
  // SQLite не поддерживает pool.connect() — пропускаем
  if (!pool) {
    console.log(`[Enrichment] SQLite mode — skipping populateNewsTagLinks for ${newsId}`);
    return;
  }

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // 1. Keyword-ссылки: batch INSERT через unnest
    // Все matched_tags одним запросом, не N+1
    if (matchedTags.length > 0) {
      await client.query(
        `INSERT INTO news_tag_links (news_id, tag_id, link_source)
         SELECT $1, unnest($2::text[]), 'keyword'
         ON CONFLICT (news_id, tag_id, link_source) DO NOTHING`,
        [newsId, matchedTags]
      );
    }

    // 2. LLM impact-ссылки: фильтр пустых + batch INSERT
    // Пропускаем fallback-статьи (score=0 && пустой reasoning)
    const validImpacts = tagImpacts.filter(
      ti => !(ti.score === 0 && (!ti.reasoning || ti.reasoning.trim() === ''))
    );
    
    if (validImpacts.length > 0) {
      await client.query(
        `INSERT INTO news_tag_links 
           (news_id, tag_id, impact_score, impact_reasoning, link_source)
         SELECT $1, tag, score, reasoning, 'llm_impact'
         FROM unnest($2::text[], $3::int[], $4::text[])
           AS t(tag, score, reasoning)
         ON CONFLICT (news_id, tag_id, link_source) DO UPDATE SET
           impact_score = EXCLUDED.impact_score,
           impact_reasoning = EXCLUDED.impact_reasoning`,
        [
          newsId,
          validImpacts.map(t => t.tag),
          validImpacts.map(t => t.score),
          validImpacts.map(t => t.reasoning),
        ]
      );
    }

    // 3. Атомарно помечаем статью как обогащённую (v2)
    await client.query(
      'UPDATE news SET enrichment_version = 2 WHERE id = $1',
      [newsId]
    );

    await client.query('COMMIT');
    console.log(`[Enrichment] Populated ${newsId}: ${matchedTags.length} keyword + ${validImpacts.length} llm_impact links`);
  } catch (e: any) {
    await client.query('ROLLBACK');
    console.error(`[Enrichment] FAILED for ${newsId}:`, e.message);
    throw e;
  } finally {
    client.release();
  }
}
