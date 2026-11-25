/**
 * =============================================================================
 * PULSE — Бакеты: полный список новостей окна (ТЗ-224, Задача 2)
 * =============================================================================
 *
 * GET /api/buckets/:key/articles — «Развернуть все» в панели бакета.
 * Окно резолвится общим resolveBucketWindow (те же границы, что у
 * markBucketRead: фикс-окна МСК / 'older' плавающее). Список шире
 * непрочитанных: панель = оглавление окна (осознанное правило 4 ТЗ-224) —
 * фильтра по user_news_reads НЕТ. Порядок: каскады первыми, внутри группы
 * source_count DESC, sentiment_score DESC (NULLS LAST) — как в промпте.
 * Hard cap 500 строк; total — COUNT до лимита (для кнопки «Развернуть все (N)».
 * Заголовки санитайзим (ТЗ-222) — консистентно с карточкой.
 */

import { query } from '../config/db';
import { sanitizeNewsTitle } from './newsTitle';
import { resolveBucketWindow } from './bucketRead';
import type { BucketKey } from './bucketTime';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const HARD_CAP = 500;

export interface BucketArticle {
  id: string;
  slug: string | null;
  title: string;
  source: string | null;
  sentiment: string | null;
  source_count: number;
  cascade: boolean;
}

export interface BucketArticlesResult {
  articles: BucketArticle[];
  total: number;
}

export async function getBucketArticles(userId: string, key: BucketKey | 'older'): Promise<BucketArticlesResult> {
  const pr = await query(
    `SELECT tag_id FROM portfolios WHERE user_id = $1 AND is_frozen = ${USE_SQLITE ? '0' : 'FALSE'}`,
    [userId],
  );
  const tagIds = pr.rows.map((r: any) => String(r.tag_id));
  if (tagIds.length === 0) return { articles: [], total: 0 };

  const { start, end } = resolveBucketWindow(key);

  const tagConds: string[] = [];
  const params: unknown[] = [];
  const ph = () => (USE_SQLITE ? '?' : `$${params.length + 1}`);
  if (USE_SQLITE) {
    for (const t of tagIds) {
      tagConds.push(`matched_tags LIKE ${ph()}`);
      params.push(`%"${t}"%`);
    }
  } else {
    tagConds.push(`matched_tags && ${ph()}::text[]`);
    params.push(tagIds);
  }
  const timeConds: string[] = [];
  if (start) {
    timeConds.push(USE_SQLITE ? `published_at > ?` : `published_at > ${ph()}`);
    params.push(USE_SQLITE ? start.toISOString().replace('T', ' ').slice(0, 19) : start.toISOString());
  }
  timeConds.push(USE_SQLITE ? `published_at <= ?` : `published_at <= ${ph()}`);
  params.push(USE_SQLITE ? end.toISOString().replace('T', ' ').slice(0, 19) : end.toISOString());
  const nullsLast = USE_SQLITE ? '' : ' NULLS LAST';
  const where = `(${tagConds.join(' OR ')}) AND ${timeConds.join(' AND ')}`;

  const res = await query(
    `SELECT id, slug, COALESCE(title_ru, title_original) AS title, source, sentiment, source_count, cluster_id
     FROM news
     WHERE ${where}
     ORDER BY (cluster_id IS NOT NULL) DESC, source_count DESC, sentiment_score DESC${nullsLast}
     LIMIT ${HARD_CAP}`,
    params,
  );
  const countRes = await query(`SELECT COUNT(*) AS count FROM news WHERE ${where}`, params);
  const total = Number(countRes.rows[0]?.count ?? 0);

  return {
    articles: res.rows.map((r: any) => ({
      id: String(r.id),
      slug: r.slug ?? null,
      title: sanitizeNewsTitle(r.title) ?? r.title ?? '',
      source: r.source ?? null,
      sentiment: r.sentiment ?? null,
      source_count: Number(r.source_count ?? 1),
      cascade: r.cluster_id != null,
    })),
    total,
  };
}
