/**
 * =============================================================================
 * PULSE — Реалтайм-кластеризация новостей (ТЗ-92, задача 2; доработки ТЗ-95)
 * =============================================================================
 *
 * Встраивается в пайплайн NewsProcessor fire-and-forget (задача 1) и в
 * догоняющий cron-воркер (задача 4). Фиче-флаг: CLUSTERING_ENABLED=true.
 *
 * Поток embedAndClusterBatch(newsIds):
 *   1. SELECT новостей → текст по единому формату ТЗ-91 (embeddingText).
 *   2. embedBatch (TEI) → UPDATE news SET embedding.
 *   3. Для каждой новости — advisory-xact-лок ('cluster:' || id): новость уже
 *      обрабатывается другим воркером → skip (ТЗ-95 задача 1б — дедупликация
 *      гонки NewsProcessor ↔ catch-up cron).
 *   4. top-10 кандидатов по HNSW в окне 48 ч.
 *   5. Числовое вето ДО трёх зон (измерено на боевой БД: сводки ПВО разных
 *      дней дают sim до 0.944 — без вето авто-склейка слипала бы разные дни).
 *   6. Рубрик-черный список: заголовки-дайджесты не участвуют в склейке.
 *   7. Трёхзонная логика: >= T1 авто-склейка; T2..T1 — LLM-верификатор
 *      (с summary ОБЕИХ новостей, ТЗ-95 задача 3); < T2 — одиночка.
 *   8. Приклеивание с окном жизни 36 ч (CLUSTER_GAP_HOURS): идемпотентный
 *      size через ON CONFLICT (ТЗ-95 задача 1а), verdict не деградирует
 *      ниже ранга max_sim (ТЗ-95 задача 2).
 *
 * PG-only: SQLite-режим не поддерживаем (как и в ТЗ-91); pool === null —
 * ошибка конфигурации, fail-loud (ТЗ-95 задача 1в).
 */

import { PoolClient } from 'pg';
import { query, pool } from '../config/db';
import { embedBatch, embeddingText, EMBEDDING_MAX_BATCH } from './embeddings';
import { verifyPair } from './clusterVerifier';
import {
  CLUSTER_T1,
  CLUSTER_T2,
  CLUSTER_GAP_HOURS,
  CANDIDATE_WINDOW_HOURS,
} from '../config/clustering';
import { significantNumbers, numericVeto, isRubricTitle } from './clusteringRules';

// Реэкспорт правил (ТЗ-95 задача 4): внешние импорты из clustering.ts
// продолжают работать, чистые функции живут в clusteringRules.ts.
export { significantNumbers, numericVeto, isRubricTitle };

// ═══════════════════════════════════════════════════════════════════════════
// Вспомогательное
// ═══════════════════════════════════════════════════════════════════════════

interface NewsRow {
  id: string;
  title_ru: string | null;
  summary_ru: string | null;
  source: string | null;
  published_at: string;
}

interface Candidate {
  id: string;
  title_ru: string | null;
  summary_ru: string | null;
  cluster_id: string | null;
  source: string | null;
  published_at: string;
  sim: number;
}

function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

function verdictBySim(sim: number): string {
  if (sim >= CLUSTER_T1) return 'сильный';
  if (sim >= CLUSTER_T2) return 'средний';
  return 'сомнительный';
}

/** Ранг вердикта: 'сильный' (≥ T1) > 'средний' (≥ T2) > 'сомнительный' —
 *  для не-деградирующего UPDATE (ТЗ-95 задача 2). */
function verdictRank(v: string): number {
  if (v === 'сильный') return 3;
  if (v === 'средний') return 2;
  return 1;
}

// ═══════════════════════════════════════════════════════════════════════════
// Advisory-лок обработки новости (ТЗ-95, задача 1б)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Оборачивает обработку одной новости в транзакцию с advisory-xact-локом
 * ('cluster:' || id). Лок снимается на COMMIT/ROLLBACK — session-level с
 * пулом соединений протёк бы. Не взяли лок → новость уже обрабатывается
 * другим воркером (NewsProcessor ↔ catch-up cron) → skip с логом.
 * Порядок локов единый: advisory → row (дедлок невозможен).
 * Соединение пула занято на всё время обработки (включая сетевые вызовы
 * LLM) — осознанно, см. риски §4 ТЗ-95.
 */
async function withNewsLock(newsId: string, fn: (client: PoolClient) => Promise<void>): Promise<void> {
  if (!pool) {
    throw new Error('[Clustering] pool недоступен — проверьте конфигурацию БД');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lockRes = await client.query(
      `SELECT pg_try_advisory_xact_lock(hashtextextended('cluster:' || $1, 42)) AS ok`,
      [newsId]
    );
    if (!lockRes.rows[0].ok) {
      await client.query('ROLLBACK');
      console.log(`[Clustering] новость ${newsId} уже в обработке, skip`);
      return;
    }
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Приклеивание (внутри транзакции withNewsLock: блокировка строки-кандидата
// сериализует конкурентных приклеивателей)
// ═══════════════════════════════════════════════════════════════════════════

async function attachToCluster(
  news: NewsRow,
  candidate: Candidate,
  sim: number,
  client: PoolClient
): Promise<void> {
  if (!pool) {
    // fail-loud (ТЗ-95 задача 1в): молчаливый пропуск кластеризации недопустим
    throw new Error('[Clustering] pool недоступен — проверьте конфигурацию БД');
  }

  // Блокируем строку кандидата: перечитываем его cluster_id в транзакции
  const candRes = await client.query(
    'SELECT id, cluster_id, published_at FROM news WHERE id = $1 FOR UPDATE',
    [candidate.id]
  );
  if (candRes.rows.length === 0) {
    return; // кандидат исчез — нечего приклеивать (откат делает withNewsLock)
  }
  const candClusterId: string | null = candRes.rows[0].cluster_id;

  let clusterId: string;

  if (candClusterId) {
    clusterId = candClusterId;
    // Окно жизни: кластер живёт, если last_seen_at в пределах GAP от новости
    const clRes = await client.query(
      'SELECT last_seen_at, first_published_at FROM clusters WHERE id = $1 FOR UPDATE',
      [clusterId]
    );
    if (clRes.rows.length === 0) {
      return;
    }
    const lastSeen = new Date(clRes.rows[0].last_seen_at).getTime();
    const pub = new Date(news.published_at).getTime();
    if (Math.abs(pub - lastSeen) > CLUSTER_GAP_HOURS * 3600 * 1000) {
      console.log(
        `[Clustering] кластер ${clusterId} мёртв (gap ${((pub - lastSeen) / 3600000).toFixed(1)}ч > ${CLUSTER_GAP_HOURS}ч) — новость ${news.id} остаётся одиночкой`
      );
      return;
    }
    const firstPub = clRes.rows[0].first_published_at;
    const lagMin = Math.max(
      0,
      Math.round((new Date(news.published_at).getTime() - new Date(firstPub).getTime()) / 60000)
    );
    // Идемпотентный size (ТЗ-95 задача 1а): INSERT первым, UPDATE только при
    // rowCount === 1. Уникальный индекс cluster_items(cluster_id, news_id)
    // сериализует конкурентные вставки — двойной инкремент невозможен.
    const insRes = await client.query(
      'INSERT INTO cluster_items (cluster_id, news_id, lag_min) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [clusterId, news.id, lagMin]
    );
    if (insRes.rowCount === 1) {
      // verdict не деградирует (ТЗ-95 задача 2): применяем новый вердикт,
      // только если его ранг не ниже текущего. max_sim — через GREATEST,
      // поэтому инвариант: verdict = verdictBySim(max_sim).
      await client.query(
        `UPDATE clusters SET
           size = size + 1,
           last_seen_at = GREATEST(last_seen_at, $2::timestamptz),
           max_sim = GREATEST(COALESCE(max_sim, 0), $3::real),
           verdict = CASE
             WHEN CASE $4 WHEN 'сильный' THEN 3 WHEN 'средний' THEN 2 ELSE 1 END
                  >= CASE verdict WHEN 'сильный' THEN 3 WHEN 'средний' THEN 2 ELSE 1 END
             THEN $4 ELSE verdict END
         WHERE id = $1`,
        [clusterId, news.published_at, sim, verdictBySim(sim)]
      );
      await client.query('UPDATE news SET cluster_id = $1 WHERE id = $2', [clusterId, news.id]);
    }
    // rowCount === 0 → новость уже член кластера: UPDATE пропускаем целиком
  } else {
    // Кандидат без кластера — создаём кластер на двоих.
    // first_published_at = published_at кандидата (первоисточник).
    const firstPub = candidate.published_at;
    const insRes = await client.query(
      `INSERT INTO clusters (kind, source, max_sim, verdict, first_published_at, last_seen_at, size)
       VALUES ('cascade', 'realtime', $1::real, $2, $3::timestamptz, $4::timestamptz, 2)
       RETURNING id`,
      [sim, verdictBySim(sim), firstPub, news.published_at]
    );
    clusterId = insRes.rows[0].id;
    const firstMs = firstPub ? new Date(firstPub).getTime() : new Date(news.published_at).getTime();
    const items = [
      { id: candidate.id, at: firstMs },
      { id: news.id, at: new Date(news.published_at).getTime() },
    ];
    for (const it of items) {
      await client.query(
        'INSERT INTO cluster_items (cluster_id, news_id, lag_min) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [clusterId, it.id, Math.max(0, Math.round((it.at - firstMs) / 60000))]
      );
    }
    await client.query('UPDATE news SET cluster_id = $1 WHERE id = $2', [clusterId, candidate.id]);
    await client.query('UPDATE news SET cluster_id = $1 WHERE id = $2', [clusterId, news.id]);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Главный вход
// ═══════════════════════════════════════════════════════════════════════════

export async function embedAndClusterBatch(newsIds: string[]): Promise<void> {
  if (!Array.isArray(newsIds) || newsIds.length === 0) return;

  const res = await query(
    `SELECT id, title_ru, summary_ru, source, published_at
     FROM news
     WHERE id = ANY($1::uuid[])
       AND title_ru IS NOT NULL
       AND embedding IS NULL`,
    [newsIds]
  );
  const newsList = res.rows as NewsRow[];
  if (newsList.length === 0) return;

  // 1–2. Эмбеддинг батчами ≤ 32 и запись векторов
  const vectors = new Map<string, number[]>();
  for (let i = 0; i < newsList.length; i += EMBEDDING_MAX_BATCH) {
    const slice = newsList.slice(i, i + EMBEDDING_MAX_BATCH);
    const batchVectors = await embedBatch(
      slice.map((n) => embeddingText(n.title_ru, n.summary_ru))
    );
    slice.forEach((n, k) => vectors.set(n.id, batchVectors[k]));
  }
  for (const [id, v] of vectors) {
    await query('UPDATE news SET embedding = $1::vector WHERE id = $2', [
      vectorLiteral(v),
      id,
    ]);
  }

  // 3–8. Кандидаты, вето, зоны, приклеивание — по одной новости последовательно,
  // каждая под advisory-локом (дедупликация гонки с catch-up cron, ТЗ-95)
  for (const news of newsList) {
    try {
      await withNewsLock(news.id, async (client) => {
        await clusterOne(news, vectors.get(news.id)!, client);
      });
    } catch (err: any) {
      console.warn(`[Clustering] новость ${news.id} пропущена (non-fatal):`, err.message);
    }
  }
}

/**
 * Исторический проход (после бэкфилла ТЗ-91): кластеризация новостей, у
 * которых вектор УЖЕ есть (embedAndClusterBatch их пропускает — выбирает
 * только embedding IS NULL). Вектор читается из БД, TEI не дёргается.
 * Используется скриптом src/scripts/backfillClusters.ts.
 */
export async function clusterEmbeddedBatch(newsIds: string[]): Promise<void> {
  if (!Array.isArray(newsIds) || newsIds.length === 0) return;

  const res = await query(
    `SELECT id, title_ru, summary_ru, source, published_at, embedding::text AS embedding_text
     FROM news
     WHERE id = ANY($1::uuid[])
       AND title_ru IS NOT NULL
       AND embedding IS NOT NULL
       AND cluster_id IS NULL`,
    [newsIds]
  );
  for (const row of res.rows) {
    try {
      await withNewsLock(row.id, async (client) => {
        await clusterOne(row as NewsRow, parseVectorLiteral(row.embedding_text), client);
      });
    } catch (err: any) {
      console.warn(`[Clustering] новость ${row.id} пропущена (non-fatal):`, err.message);
    }
  }
}

/** '[0.1,0.2,...]' (текстовая форма vector из pg) → number[] */
function parseVectorLiteral(s: string): number[] {
  return s
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((x) => Number(x));
}

async function clusterOne(news: NewsRow, vector: number[], client: PoolClient): Promise<void> {
  if (isRubricTitle(news.title_ru || '')) {
    return; // рубрики-дайджесты не участвуют в склейке
  }

  const pub = new Date(news.published_at);
  const from = new Date(pub.getTime() - CANDIDATE_WINDOW_HOURS * 3600 * 1000);

  const candRes = await client.query(
    `SELECT n.id, n.title_ru, n.summary_ru, n.cluster_id, n.source, n.published_at,
            1 - (n.embedding <=> $1::vector) AS sim
     FROM news n
     WHERE n.embedding IS NOT NULL
       AND n.id <> $2
       AND n.published_at > $3::timestamptz
       AND n.published_at <= $4::timestamptz
     ORDER BY n.embedding <=> $1::vector
     LIMIT 10`,
    [vectorLiteral(vector), news.id, from.toISOString(), pub.toISOString()]
  );
  const candidates = candRes.rows as Candidate[];

  // Лучший кандидат, прошедший числовое вето
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (isRubricTitle(c.title_ru || '')) continue; // рубрики не сид кластера
    if (numericVeto(news.title_ru || '', c.title_ru || '')) continue;
    best = c;
    break; // кандидаты отсортированы по sim DESC — первый прошедший вето и есть лучший
  }
  if (!best) return;

  if (best.sim >= CLUSTER_T1) {
    await attachToCluster(news, best, best.sim, client);
    return;
  }

  if (best.sim >= CLUSTER_T2) {
    const verdict = await verifyPair(
      {
        id: news.id,
        title: news.title_ru || '',
        summary: news.summary_ru || '',
        source: news.source || undefined,
        publishedAt: new Date(news.published_at).toISOString(),
      },
      {
        id: best.id,
        title: best.title_ru || '',
        summary: best.summary_ru || '', // ТЗ-95 задача 3: верификатор видит оба summary
        source: best.source || undefined,
        publishedAt: new Date(best.published_at).toISOString(),
      },
      best.sim
    );
    if (verdict.sameEvent) {
      await attachToCluster(news, best, best.sim, client);
    }
    return;
  }

  // sim < T2 — одиночка, кластеры из одной новости не создаём
}
