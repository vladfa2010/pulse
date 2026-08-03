/**
 * PULSE — Digest Content Builder (чистый).
 *
 * Извлечено из digest.ts. Здесь НЕТ ничего про Telegram/Email/Push —
 * только "какие статьи показать юзеру". Форматирование и доставка —
 * в formatters.ts и каналах.
 *
 * Окно выборки — per-channel: каждый канал передаёт свой last_sent_at,
 * поэтому отправка в TG больше не "съедает" окно для почты и наоборот.
 */

import { query } from '../../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

const HARD_TAG_CAP = 200; // защита от тяжёлых запросов, не per-plan

export interface DigestArticle {
  id?: string;
  title: string;
  url: string;
  sentiment: string;
  source: string;
  tag: string;
  tagId: string;
  publishedAt?: Date;
  fetchedAt?: Date;
}

export interface DigestContent {
  articles: DigestArticle[];
  totalUnread: number;
}

/**
 * @param userId     пользователь
 * @param maxTags    лимит тегов из Entitlement (null = без plan-лимита, ручной /now)
 * @param since      last_sent_at этого канала (null = первый запуск → окно 24ч)
 */
export async function buildDigestContent(
  userId: string,
  maxTags: number | null,
  since: Date | null,
  context: string = 'scheduled'
): Promise<DigestContent> {
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
    console.log(`[Digest:${context}] No tags for user ${userId}`);
    return { articles: [], totalUnread: 0 };
  }

  const tagRows = portfolioResult.rows;
  const tagIds = tagRows.map(r => r.tag_id);
  const tagNames: Record<string, string> = {};
  for (const r of tagRows) tagNames[r.tag_id] = r.tag_name;

  // Гибридный фильтр: fetched_at для API-источников, published_at для RSS.
  // RSS-окно — от last_sent_at ЭТОГО канала, чтобы ничего не терялось.
  const rssSince = since ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sinceFetched = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const maxAge = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  console.log(
    `[Digest:${context}] user=${userId} tags=${tagIds.length} limit=${limit} ` +
    `since=${since?.toISOString() ?? 'null(24h fallback)'}`
  );

  let articlesResult;
  if (USE_SQLITE) {
    const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
    const likeParams = tagIds.map(id => `%"${id}"%`);
    articlesResult = await query(
      `SELECT id, COALESCE(title_ru, title_original) as title, url, sentiment, source, matched_tags, published_at, fetched_at
       FROM news
       WHERE (${conditions})
         AND (fetched_at > ? OR published_at > ?)
         AND published_at > ?
         AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = ?)
       ORDER BY fetched_at DESC
       LIMIT 20`,
      [...likeParams, sinceFetched.toISOString(), rssSince.toISOString(), maxAge.toISOString(), userId]
    );
  } else {
    articlesResult = await query(
      `SELECT id, COALESCE(title_ru, title_original) as title, url, sentiment, source, matched_tags, published_at, fetched_at
       FROM news
       WHERE matched_tags && $1::text[]
         AND (fetched_at > $2 OR published_at > $3)
         AND published_at > $4
         AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = $5)
       ORDER BY GREATEST(fetched_at, published_at) DESC
       LIMIT 20`,
      [tagIds, sinceFetched.toISOString(), rssSince.toISOString(), maxAge.toISOString(), userId]
    );
  }

  console.log(`[Digest:${context}] user=${userId} candidateCount=${articlesResult.rows.length}`);

  const articles: DigestArticle[] = articlesResult.rows.map(row => {
    const matchedTags = row.matched_tags || [];
    const matchedTag = tagIds.find(t => matchedTags.includes(t)) || matchedTags[0] || '';
    return {
      id: row.id,
      title: row.title,
      url: row.url,
      sentiment: row.sentiment || 'neutral',
      source: row.source,
      tag: tagNames[matchedTag] || matchedTag,
      tagId: matchedTag,
      publishedAt: row.published_at ? new Date(row.published_at) : undefined,
      fetchedAt: row.fetched_at ? new Date(row.fetched_at) : undefined,
    };
  });

  return { articles, totalUnread: articles.length };
}

export async function buildDigestContentForUser(
  userId: string,
  maxTags: number | null,
  since: Date | null,
  context: string = 'scheduled'
): Promise<DigestContent> {
  return buildDigestContent(userId, maxTags, since, context);
}

export function filterUnreadArticles(
  articles: DigestArticle[],
  readIds: Set<string>
): DigestArticle[] {
  return articles.filter(a => a.id && !readIds.has(a.id));
}

export { buildDigestContent as default };
