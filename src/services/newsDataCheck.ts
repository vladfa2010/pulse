import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

/**
 * Проверка данных при деплое:
 * 1. Сколько новостей за последние 30 дней.
 * 2. Сколько из них связано с тегами через news_tag_links.
 * 3. Топ-10 пользователей по персональным новостям.
 *
 * Запускается при старте сервера и из скрипта `src/scripts/check-news-data.ts`.
 */
export async function logNewsDataCheck(): Promise<void> {
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const sinceIso = since.toISOString();
  let hasError = false;

  let newsLast30d = 0;
  try {
    const newsResult = await query(
      `SELECT COUNT(*) as cnt FROM news WHERE published_at > $1`,
      [sinceIso]
    );
    if (newsResult.rows.length === 0) {
      hasError = true;
      console.error('[DeployCheck] Error counting news_last_30d: query returned no rows');
    } else {
      newsLast30d = Number(newsResult.rows[0]?.cnt || 0);
    }
  } catch (e: any) {
    hasError = true;
    console.error('[DeployCheck] Error counting news_last_30d:', e.message);
  }

  let linkedNews = 0;
  try {
    const linkedResult = await query(
      `SELECT COUNT(DISTINCT ntl.news_id) as cnt
       FROM news_tag_links ntl
       JOIN news n ON n.id = ntl.news_id
       WHERE n.published_at > $1`,
      [sinceIso]
    );
    if (linkedResult.rows.length === 0) {
      hasError = true;
      console.error('[DeployCheck] Error counting linked_news: query returned no rows');
    } else {
      linkedNews = Number(linkedResult.rows[0]?.cnt || 0);
    }
  } catch (e: any) {
    hasError = true;
    console.error('[DeployCheck] Error counting linked_news:', e.message);
  }

  let topUsers: any[] = [];
  try {
    const personalResult = await query(
      `SELECT p.user_id, COUNT(DISTINCT ntl.news_id) as cnt
       FROM portfolios p
       JOIN news_tag_links ntl ON ntl.tag_id = p.tag_id
       JOIN news n ON n.id = ntl.news_id AND n.published_at > $1
       WHERE p.is_frozen = ${USE_SQLITE ? '0' : 'FALSE'}
       GROUP BY p.user_id
       ORDER BY cnt DESC
       LIMIT 10`,
      [sinceIso]
    );
    topUsers = personalResult.rows;
  } catch (e: any) {
    hasError = true;
    console.error('[DeployCheck] Error counting personal news:', e.message);
  }

  console.log(`[DeployCheck] news_last_30d=${newsLast30d}, linked_news=${linkedNews}`);
  if (topUsers.length > 0) {
    console.log(`[DeployCheck] top users by personal news: ${JSON.stringify(topUsers)}`);
  } else {
    console.log('[DeployCheck] no personal news found for any user');
  }

  if (hasError) {
    console.warn('[DeployCheck] WARNING: one or more queries failed — check errors above');
  } else if (newsLast30d === 0 && linkedNews === 0) {
    console.warn('[DeployCheck] WARNING: no news and no links in the last 30 days — stats will be zero');
  } else if (linkedNews === 0) {
    console.warn('[DeployCheck] WARNING: there are news but no news_tag_links — check tag matching pipeline');
  }
}
