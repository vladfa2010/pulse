/**
 * =============================================================================
 * PULSE — Динамика эффективности источников (ТЗ-186, задача 2)
 * =============================================================================
 *
 * Ночной срез статистики «Ресерч: кто первый» (/cascade-research, ТЗ-93):
 * тот же CTE (ranked/firsts/per_source/first_counts/window_clusters), но окно
 * параметризовано концом суток D (МСК) вместо NOW(): срез за дату D =
 * окно [(D+1)::date − 7 дней, (D+1)::date) по МСК. Метрики скорости каскада
 * (median_second_lag и т.п.) НЕ снимаем — для динамики источников не нужны.
 *
 * Джоба read-only кроме source_stats_daily. Пересчёт последних 3 срезов
 * каждую ночь: каскады дорисовываются часами, свежие срезы без пересчёта
 * занижали бы цифры. Запуск — cron 05:40 МСК (startSourceStatsCron, после
 * виральности 05:30 из ТЗ-185) или разовый вызов runSourceStatsDaily()
 * (критерий приёмки ТЗ-186 №2).
 */

import { query } from '../config/db';

const WINDOW_DAYS = 7;

export interface SourceStatsSliceResult {
  stat_date: string;   // 'YYYY-MM-DD'
  rows: number;        // строк записано (источников в срезе)
  clusters_total: number;
}

/**
 * Срез за дату D ('YYYY-MM-DD'): статистика по окну «последние 7 дней,
 * заканчивая концом суток D (МСК)». Конец окна детерминирован:
 * полночь (D+1) по календарю МСК как timestamptz
 * (((D+1)::date)::timestamp AT TIME ZONE 'Europe/Moscow') — тот же приём,
 * что в heatmapDaily/tagMarket (обратное преобразование к
 * `published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow'`).
 * Запись — INSERT ... ON CONFLICT (stat_date, source, window_days) DO UPDATE
 * (идемпотентно, computed_at обновляется).
 */
export async function computeSourceStats(endDate: string): Promise<SourceStatsSliceResult> {
  const result = await query(
    `WITH bounds AS (
       SELECT (($1::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow') AS window_end
     ),
     items AS (
       SELECT ci.cluster_id, n.source, ci.lag_min
       FROM cluster_items ci
       JOIN news n ON n.id = ci.news_id
       JOIN clusters c ON c.id = ci.cluster_id
       CROSS JOIN bounds b
       WHERE c.first_published_at >= b.window_end - INTERVAL '${WINDOW_DAYS} days'
         AND c.first_published_at < b.window_end
     ),
     ranked AS (
       SELECT *, row_number() OVER (PARTITION BY cluster_id ORDER BY lag_min ASC, source) AS rn
       FROM items
     ),
     firsts AS (
       SELECT cluster_id, source AS first_source FROM ranked WHERE rn = 1
     ),
     per_source AS (
       SELECT r.source,
              count(*) AS participations,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY r.lag_min)
                FILTER (WHERE r.lag_min > 0) AS median_lag_not_first
       FROM ranked r
       GROUP BY r.source
     ),
     first_counts AS (
       SELECT first_source AS source, count(*) AS first_count
       FROM firsts
       GROUP BY first_source
     ),
     window_clusters AS (
       SELECT count(*) AS n FROM clusters
       CROSS JOIN bounds b
       WHERE first_published_at >= b.window_end - INTERVAL '${WINDOW_DAYS} days'
         AND first_published_at < b.window_end
     )
     INSERT INTO source_stats_daily
       (stat_date, source, first_count, participations, median_lag_not_first_min,
        clusters_total, share, computed_at)
     SELECT $1::date,
            ps.source,
            COALESCE(fc.first_count, 0),
            ps.participations,
            ROUND(ps.median_lag_not_first)::int,
            wc.n,
            CASE WHEN wc.n > 0
                 THEN COALESCE(fc.first_count, 0)::double precision / wc.n
                 ELSE 0
            END,
            NOW()
     FROM per_source ps
     LEFT JOIN first_counts fc ON fc.source = ps.source
     CROSS JOIN window_clusters wc
     ON CONFLICT (stat_date, source, window_days) DO UPDATE
     SET first_count = EXCLUDED.first_count,
         participations = EXCLUDED.participations,
         median_lag_not_first_min = EXCLUDED.median_lag_not_first_min,
         clusters_total = EXCLUDED.clusters_total,
         share = EXCLUDED.share,
         computed_at = NOW()
     RETURNING clusters_total`,
    [endDate]
  );

  const clustersTotal = result.rows.length > 0 ? Number(result.rows[0].clusters_total) : 0;
  return { stat_date: endDate, rows: result.rows.length, clusters_total: clustersTotal };
}

/** Дата за daysAgo суток назад по календарю МСК в формате 'YYYY-MM-DD'. */
function moscowDateDaysAgo(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
}

/**
 * Разовый прогон: пересчёт срезов за вчера / позавчера / 3 дня назад подряд.
 * Падение одного среза не отменяет остальные (лог + дальше).
 */
export async function runSourceStatsDaily(): Promise<void> {
  const startedAt = Date.now();
  console.log('[SourceStats] старт пересчёта срезов (вчера, позавчера, 3 дня назад)');

  const offsets = [1, 2, 3];
  for (const offset of offsets) {
    const statDate = moscowDateDaysAgo(offset);
    try {
      const r = await computeSourceStats(statDate);
      console.log(`[SourceStats] stat_date=${r.stat_date}: записано строк: ${r.rows}, clusters_total=${r.clusters_total}`);
    } catch (err: any) {
      console.warn(`[SourceStats] stat_date=${statDate}: ошибка среза — ${err.message?.slice(0, 150)} (остальные срезы продолжаются)`);
    }
  }

  console.log(`[SourceStats] прогон завершён за ${Date.now() - startedAt}мс`);
}
