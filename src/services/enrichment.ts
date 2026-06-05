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
 * Enrichment task — одна статья для обогащения.
 */
export interface EnrichmentTask {
  newsId: string;
  matchedTags: string[];
  tagImpacts: TagImpact[];
}

/**
 * BATCH-версия: обогащает ВСЕ статьи в ОДНОЙ транзакции с ОДНИМ соединением.
 * 
 * КРИТИЧЕСКОЕ ОТЛИЧИЕ от populateNewsTagLinks:
 *   - Одно pool.connect() на весь batch вместо N соединений на N статей
 *   - Нет deadlock даже при 60+ статях (pool size = 10)
 *   - 2 unnest-запроса на все статьи, не 2N
 * 
 * Использование: собирать tasks[] в цикле save, вызвать batch ПОСЛЕ цикла.
 * 
 * @param tasks — массив задач обогащения (по одной на статью)
 */
export async function populateNewsTagLinksBatch(
  tasks: EnrichmentTask[],
): Promise<void> {
  // SQLite не поддерживает pool.connect() — пропускаем
  if (!pool) {
    console.log(`[Enrichment] SQLite mode — skipping batch enrichment for ${tasks.length} tasks`);
    return;
  }

  // Нечего обогащать
  if (tasks.length === 0) return;

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // ── 1. Keyword-ссылки: ВСЕ статьи одним unnest ──
    // Флэттим: [{newsId, matchedTags: [A,B]}, {newsId2, matchedTags: [C]}] →
    //   news_ids = [newsId, newsId, newsId2], tags = [A, B, C]
    const keywordNewsIds: string[] = [];
    const keywordTags: string[] = [];
    
    for (const task of tasks) {
      for (const tag of task.matchedTags) {
        keywordNewsIds.push(task.newsId);
        keywordTags.push(tag);
      }
    }

    if (keywordNewsIds.length > 0) {
      await client.query(
        `INSERT INTO news_tag_links (news_id, tag_id, link_source)
         SELECT news_id, tag_id, 'keyword'
         FROM unnest($1::text[], $2::text[])
           AS t(news_id, tag_id)
         ON CONFLICT (news_id, tag_id, link_source) DO NOTHING`,
        [keywordNewsIds, keywordTags]
      );
    }

    // ── 2. LLM impact-ссылки: ВСЕ статьи одним unnest ──
    // Флэттим с фильтром пустых impact
    const llmNewsIds: string[] = [];
    const llmTags: string[] = [];
    const llmScores: number[] = [];
    const llmReasonings: string[] = [];

    for (const task of tasks) {
      const validImpacts = task.tagImpacts.filter(
        ti => !(ti.score === 0 && (!ti.reasoning || ti.reasoning.trim() === ''))
      );
      for (const ti of validImpacts) {
        llmNewsIds.push(task.newsId);
        llmTags.push(ti.tag);
        llmScores.push(ti.score);
        llmReasonings.push(ti.reasoning);
      }
    }

    if (llmNewsIds.length > 0) {
      await client.query(
        `INSERT INTO news_tag_links 
           (news_id, tag_id, impact_score, impact_reasoning, link_source)
         SELECT news_id, tag, score, reasoning, 'llm_impact'
         FROM unnest($1::text[], $2::text[], $3::int[], $4::text[])
           AS t(news_id, tag, score, reasoning)
         ON CONFLICT (news_id, tag_id, link_source) DO UPDATE SET
           impact_score = EXCLUDED.impact_score,
           impact_reasoning = EXCLUDED.impact_reasoning`,
        [llmNewsIds, llmTags, llmScores, llmReasonings]
      );
    }

    // ── 3. Помечаем ВСЕ статьи как обогащённые (v2) ──
    // Batch UPDATE через unnest — одним запросом
    const allNewsIds = tasks.map(t => t.newsId);
    await client.query(
      `UPDATE news 
       SET enrichment_version = 2 
       WHERE id = ANY($1::text[])`,
      [allNewsIds]
    );

    await client.query('COMMIT');
    const totalKeyword = keywordNewsIds.length;
    const totalLlm = llmNewsIds.length;
    console.log(`[Enrichment] Batch enriched ${tasks.length} articles: ${totalKeyword} keyword + ${totalLlm} llm_impact links (1 connection)`);
  } catch (e: any) {
    await client.query('ROLLBACK');
    console.error(`[Enrichment] Batch FAILED for ${tasks.length} articles:`, e.message);
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Одиночная статья — ОБЪЯВЛЕНА УСТАРЕВШЕЙ. Используйте populateNewsTagLinksBatch.
 * 
 * Оставлена для обратной совместимости. Делает то же самое, но с N соединений.
 * НЕ ИСПОЛЬЗОВАТЬ в цикле — deadlock при pool size < N статей.
 */
export async function populateNewsTagLinks(
  newsId: string,
  matchedTags: string[],
  tagImpacts: TagImpact[],
): Promise<void> {
  return populateNewsTagLinksBatch([{ newsId, matchedTags, tagImpacts }]);
}
