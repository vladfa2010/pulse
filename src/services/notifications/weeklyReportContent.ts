/**
 * PULSE — Weekly Report Content Builder.
 *
 * Извлечено из reports.ts. Здесь только "какие статьи показать юзеру".
 * Форматирование и доставка — в formatters.ts и диспетчере.
 */

import { query } from '../../config/db';
import { HARD_TAG_CAP } from './types';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export interface WeeklyReportArticle {
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: Date;
  sentiment: string;
}

export interface WeeklyReportTagSummary {
  tagId: string;
  tagName: string;
  articles: WeeklyReportArticle[];
}

export interface WeeklyReportContent {
  period: string;
  tagSummaries: WeeklyReportTagSummary[];
  totalArticles: number;
  sentimentBreakdown: { positive: number; negative: number; neutral: number };
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/**
 * @param userId  пользователь
 * @param maxTags лимит тегов из Entitlement (null = без plan-лимита)
 */
export async function buildWeeklyReportContent(
  userId: string,
  maxTags: number | null
): Promise<WeeklyReportContent | null> {
  // Cap: min(tagLimit, 200). Бесконечные (-1) и ручной запуск (null) → 200.
  const rawLimit = maxTags ?? HARD_TAG_CAP;
  const limit = rawLimit < 0 ? HARD_TAG_CAP : Math.min(rawLimit, HARD_TAG_CAP);

  // Только активные (не frozen) теги пользователя
  const portfolioResult = await query(
    `SELECT tag_id, tag_name FROM portfolios 
     WHERE user_id = $1 AND is_frozen = FALSE 
     ORDER BY created_at ASC LIMIT $2`,
    [userId, limit]
  );

  if (portfolioResult.rows.length === 0) {
    console.log(`[WeeklyReport] No tags for user ${userId}`);
    return null;
  }

  const tagRows = portfolioResult.rows;
  const tagIds = tagRows.map(r => r.tag_id);
  const tagNames: Record<string, string> = {};
  for (const r of tagRows) tagNames[r.tag_id] = r.tag_name;

  // RSS — 7 дней, API-источники — 8 дней (fetched_at fallback)
  const sincePublished = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sinceFetched = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

  console.log(
    `[WeeklyReport] user=${userId} tags=${tagIds.length} limit=${limit}`
  );

  let newsResult;
  if (USE_SQLITE) {
    const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
    const likeParams = tagIds.map(id => `%;"${id}";%`);
    newsResult = await query(
      `SELECT COALESCE(title_ru, title_original) as title,
              COALESCE(summary_ru, summary_original) as summary,
              source, url, published_at, sentiment, matched_tags
       FROM news
       WHERE (${conditions})
         AND (fetched_at > ? OR published_at > ?)
       ORDER BY fetched_at DESC
       LIMIT 200`,
      [...likeParams, sinceFetched.toISOString(), sincePublished.toISOString()]
    );
  } else {
    newsResult = await query(
      `SELECT COALESCE(title_ru, title_original) as title,
              COALESCE(summary_ru, summary_original) as summary,
              source, url, published_at, sentiment, matched_tags
       FROM news
       WHERE matched_tags && $1::text[]
         AND (fetched_at > $2 OR published_at > $3)
       ORDER BY GREATEST(fetched_at, published_at) DESC
       LIMIT 200`,
      [tagIds, sinceFetched.toISOString(), sincePublished.toISOString()]
    );
  }

  const articles = newsResult.rows;
  if (articles.length === 0) {
    console.log(`[WeeklyReport] user=${userId} no articles`);
    return null;
  }

  // Группировка по тегу
  const tagMap = new Map<string, WeeklyReportTagSummary>();
  for (const row of tagRows) {
    tagMap.set(row.tag_id, { tagId: row.tag_id, tagName: row.tag_name, articles: [] });
  }

  const sentimentBreakdown = { positive: 0, negative: 0, neutral: 0 };

  for (const row of articles) {
    const sentiment = row.sentiment || 'neutral';
    sentimentBreakdown[sentiment as keyof typeof sentimentBreakdown]++;

    for (const tagId of row.matched_tags || []) {
      if (tagMap.has(tagId)) {
        tagMap.get(tagId)!.articles.push({
          title: row.title,
          summary: row.summary,
          source: row.source,
          url: row.url,
          publishedAt: row.published_at ? new Date(row.published_at) : new Date(),
          sentiment,
        });
      }
    }
  }

  const tagSummaries = Array.from(tagMap.values()).filter(t => t.articles.length > 0);
  if (tagSummaries.length === 0) {
    console.log(`[WeeklyReport] user=${userId} no matching tags with articles`);
    return null;
  }

  return {
    period: `${formatDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))} — ${formatDate(new Date())}`,
    tagSummaries,
    totalArticles: articles.length,
    sentimentBreakdown,
  };
}

export { buildWeeklyReportContent as default };
