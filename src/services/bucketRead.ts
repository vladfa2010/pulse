/**
 * =============================================================================
 * PULSE — Просмотр бакетов «Пока вас не было» (ТЗ-218, Задача 5)
 * =============================================================================
 *
 * Просмотр = архивация: строка в user_bucket_reads (sentinel epoch для
 * «Вчера») + массовая пометка новостей окна прочитанными (user_news_reads).
 * Идемпотентно (ON CONFLICT DO NOTHING). Окно ≤24ч, теги только свои —
 * из portfolios юзера, не из запроса.
 */

import { query } from '../config/db';
import { floorToBucket, closedBucketsSince } from './bucketTime';
import type { BucketKey } from './bucketTime';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

async function userTagIds(userId: string): Promise<string[]> {
  const res = await query(
    `SELECT tag_id FROM portfolios WHERE user_id = $1 AND is_frozen = ${USE_SQLITE ? '0' : 'FALSE'}`,
    [userId]
  );
  return res.rows.map((r: any) => r.tag_id);
}

function tagConds(tagIds: string[], params: unknown[], alias = 'n'): string {
  if (USE_SQLITE) {
    const conds = tagIds.map(() => `${alias}.matched_tags LIKE ?`);
    for (const t of tagIds) params.push(`%"${t}"%`);
    return conds.join(' OR ');
  }
  params.push(tagIds);
  return `${alias}.matched_tags && $${params.length}::text[]`;
}

/** Массово пометить новости окна прочитанными. Возвращает число новых записей. */
async function markWindowRead(userId: string, tagIds: string[], start: Date | null, end: Date): Promise<number> {
  const params: unknown[] = [];
  const tc = tagConds(tagIds, params);
  const ph = (v: unknown) => { params.push(v); return USE_SQLITE ? '?' : `$${params.length}`; };
  const notRead = USE_SQLITE
    ? 'NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = ? AND r.news_id = n.id)'
    : `NOT EXISTS (SELECT 1 FROM user_news_reads r WHERE r.user_id = ${ph(userId)} AND r.news_id = n.id)`;
  if (USE_SQLITE) params.push(userId);
  const timeConds: string[] = [];
  if (start) {
    timeConds.push(`n.published_at > ${ph(USE_SQLITE ? start.toISOString().replace('T', ' ').slice(0, 19) : start.toISOString())}`);
  }
  timeConds.push(`n.published_at <= ${ph(USE_SQLITE ? end.toISOString().replace('T', ' ').slice(0, 19) : end.toISOString())}`);

  const res = await query(
    USE_SQLITE
      ? `INSERT INTO user_news_reads (user_id, news_id, read_at)
         SELECT ${'?'}, n.id, datetime('now')
         FROM news n
         WHERE ${tc} AND ${timeConds.join(' AND ')} AND ${notRead}
         ON CONFLICT DO NOTHING`
      : `INSERT INTO user_news_reads (user_id, news_id, read_at)
         SELECT ${ph(userId)}, n.id, NOW()
         FROM news n
         WHERE ${tc} AND ${timeConds.join(' AND ')} AND ${notRead}
         ON CONFLICT DO NOTHING`,
    params
  );
  return res.rowCount ?? 0;
}

async function insertBucketRead(userId: string, bucketStart: Date, bucketEnd: Date): Promise<void> {
  await query(
    USE_SQLITE
      ? `INSERT INTO user_bucket_reads (user_id, bucket_start, bucket_end, viewed_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT (user_id, bucket_start) DO NOTHING`
      : `INSERT INTO user_bucket_reads (user_id, bucket_start, bucket_end, viewed_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, bucket_start) DO NOTHING`,
    [userId, bucketStart.toISOString(), bucketEnd.toISOString()]
  );
}

/**
 * Просмотр бакета по ключу. Резолвит окно из фиксированных границ за 24ч;
 * отказывает, если бакет ещё открыт/отсутствует. Для 'older' — окно
 * (-∞, now-24h) + sentinel bucket_start = epoch.
 */
export async function markBucketRead(userId: string, key: BucketKey | 'older'): Promise<number> {
  const tagIds = await userTagIds(userId);
  if (tagIds.length === 0) return 0;

  const now = new Date();
  if (key === 'older') {
    const end = new Date(now.getTime() - 24 * 3600 * 1000);
    const marked = await markWindowRead(userId, tagIds, null, end);
    await insertBucketRead(userId, new Date(0), end);
    return marked;
  }

  // ближайший закрытый бакет с этим ключом за последние 24ч
  const closed = closedBucketsSince(now, new Date(now.getTime() - 24 * 3600 * 1000));
  const target = [...closed].reverse().find((b) => b.key === key);
  if (!target) {
    throw Object.assign(new Error('bucket not closed'), { code: 'bucket_not_closed' });
  }
  const marked = await markWindowRead(userId, tagIds, target.start, target.end);
  await insertBucketRead(userId, target.start, target.end);
  return marked;
}

/** Read-all: архивация всех закрытых непросмотренных бакетов за 24ч + sentinel. */
export async function archiveAllBuckets(userId: string): Promise<void> {
  const tagIds = await userTagIds(userId);
  if (tagIds.length === 0) return;
  const now = new Date();
  const closed = closedBucketsSince(now, new Date(now.getTime() - 24 * 3600 * 1000));
  const viewedRes = await query(
    `SELECT bucket_start FROM user_bucket_reads WHERE user_id = $1`,
    [userId]
  );
  const viewed = new Set(viewedRes.rows.map((r: any) => String(new Date(r.bucket_start).getTime())));
  let hasOlderSentinel = viewed.has(String(0));

  for (const b of closed) {
    if (viewed.has(String(b.start.getTime()))) continue;
    await markWindowRead(userId, tagIds, b.start, b.end);
    await insertBucketRead(userId, b.start, b.end);
  }
  if (!hasOlderSentinel) {
    await insertBucketRead(userId, new Date(0), new Date(now.getTime() - 24 * 3600 * 1000));
  }
}
