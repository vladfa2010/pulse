/**
 * PULSE — newsReads.ts
 * Общая логика «прочитано» для сайта (routes/news.ts) и Telegram-бота
 * (routes/webhook.ts, кнопка «Прочитал всё»).
 */

import { query } from '../config/db';
import { nowSql } from '../utils/nowSql';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

/**
 * SQL для фильтра по времени (90 дней).
 * Используется и в ленте, и в массовой отметке прочитанным.
 */
export function timeFilterSql(): string {
  return USE_SQLITE
    ? "published_at > datetime('now', '-90 days')"
    : "published_at > NOW() - INTERVAL '90 days'";
}

/**
 * Пометить ВСЕ непрочитанные новости пользователя прочитанными.
 * Покрывает выборку карусели «Это вы ещё не видели» и TG-дайджеста:
 *   matched_tags && активные user_tags, за 90 дней, не в user_news_reads.
 * Идемпотентно. Возвращает число новых пометок.
 */
export async function markAllNewsAsRead(userId: string): Promise<number> {
  const portfolioResult = await query(
    `SELECT tag_id FROM portfolios WHERE user_id = $1 AND is_frozen = ${USE_SQLITE ? '0' : 'FALSE'}`,
    [userId]
  );
  const tagIds = portfolioResult.rows.map((r: any) => r.tag_id);
  if (tagIds.length === 0) return 0;

  if (USE_SQLITE) {
    const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
    const likeParams = tagIds.map(id => `%"${id}"%`);
    const result = await query(
      `INSERT OR IGNORE INTO user_news_reads (user_id, news_id, read_at)
       SELECT ?, id, ${nowSql()}
       FROM news
       WHERE (${conditions})
         AND ${timeFilterSql()}
         AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = ?)`,
      [userId, ...likeParams, userId]
    );
    return (result as any).rowCount ?? 0;
  }

  const result = await query(
    `INSERT INTO user_news_reads (user_id, news_id, read_at)
     SELECT $1, id, ${nowSql()}
     FROM news
     WHERE matched_tags && $2::text[]
       AND ${timeFilterSql()}
       AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = $1)
     ON CONFLICT (user_id, news_id) DO NOTHING`,
    [userId, tagIds]
  );
  return (result as any).rowCount ?? 0;
}
