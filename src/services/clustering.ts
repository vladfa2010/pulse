/**
 * =============================================================================
 * PULSE — Реалтайм-кластеризация новостей (ТЗ-92, задача 2)
 * =============================================================================
 *
 * Встраивается в пайплайн NewsProcessor fire-and-forget (задача 1) и в
 * догоняющий cron-воркер (задача 4). Фиче-флаг: CLUSTERING_ENABLED=true.
 *
 * Поток embedAndClusterBatch(newsIds):
 *   1. SELECT новостей → текст по единому формату ТЗ-91 (embeddingText).
 *   2. embedBatch (TEI) → UPDATE news SET embedding.
 *   3. Для каждой новости — top-10 кандидатов по HNSW в окне 48 ч.
 *   4. Числовое вето ДО трёх зон (измерено на боевой БД: сводки ПВО разных
 *      дней дают sim до 0.944 — без вето авто-склейка слипала бы разные дни).
 *   5. Рубрик-черный список: заголовки-дайджесты не участвуют в склейке.
 *   6. Трёхзонная логика: >= T1 авто-склейка; T2..T1 — LLM-верификатор;
 *      < T2 — одиночка (кластеры из одной новости не создаём).
 *   7. Приклеивание с окном жизни 36 ч (CLUSTER_GAP_HOURS).
 *
 * PG-only: SQLite-режим не поддерживаем (как и в ТЗ-91).
 */

import { query, pool } from '../config/db';
import { embedBatch, embeddingText, EMBEDDING_MAX_BATCH } from './embeddings';
import { verifyPair } from './clusterVerifier';
import {
  CLUSTER_T1,
  CLUSTER_T2,
  CLUSTER_GAP_HOURS,
  CANDIDATE_WINDOW_HOURS,
  RUBRIC_BLACKLIST,
} from '../config/clustering';

// ═══════════════════════════════════════════════════════════════════════════
// Числовое вето (референс _cascades_full.py:29-30, 76-77)
// ═══════════════════════════════════════════════════════════════════════════

const NON_SIGNIFICANT_NUMS = new Set(['2025', '2026', '2027']);

/** Значимые числа заголовка: длина >= 2 и не год. Числа < 10 не значимы —
 *  иначе ложная склейка по «топ-3», «5 причин» (Методология §5). */
export function significantNumbers(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(/\d+/g)) {
    const n = m[0];
    if (n.length >= 2 && !NON_SIGNIFICANT_NUMS.has(n)) {
      out.add(n);
    }
  }
  return out;
}

/** true = пара отбрасывается: оба заголовка имеют значимые числа и их
 *  пересечение пусто (разные факты: «сбито 516 БПЛА» ≠ «сбито 130 БПЛА»). */
export function numericVeto(a: string, b: string): boolean {
  const sa = significantNumbers(a);
  const sb = significantNumbers(b);
  if (sa.size === 0 || sb.size === 0) return false;
  for (const n of sa) {
    if (sb.has(n)) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Рубрик-черный список (референс _cascades_full.py:38-44)
// ═══════════════════════════════════════════════════════════════════════════

/** lower() после обрезки ведущих эмодзи/символов; дайджест-заголовки
 *  не участвуют в склейке ни сидом, ни дублём. */
export function isRubricTitle(title: string): boolean {
  const t = title
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}\s]+/u, '')   // эмодзи/префиксы Telegram-источников
    .trim();
  return RUBRIC_BLACKLIST.some((r) => t.startsWith(r));
}

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

// ═══════════════════════════════════════════════════════════════════════════
// Приклеивание (транзакция: блокировка строки-кандидата сериализует
// конкурентных приклеивателей — catch-up воркер и NewsProcessor могут
// пересекаться по расписанию)
// ═══════════════════════════════════════════════════════════════════════════

async function attachToCluster(
  news: NewsRow,
  candidate: Candidate,
  sim: number
): Promise<void> {
  if (!pool) {
    console.warn('[Clustering] pool недоступен (SQLite?) — приклеивание пропущено');
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Блокируем строку кандидата: перечитываем его cluster_id в транзакции
    const candRes = await client.query(
      'SELECT id, cluster_id, published_at FROM news WHERE id = $1 FOR UPDATE',
      [candidate.id]
    );
    if (candRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
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
        await client.query('ROLLBACK');
        return;
      }
      const lastSeen = new Date(clRes.rows[0].last_seen_at).getTime();
      const pub = new Date(news.published_at).getTime();
      if (Math.abs(pub - lastSeen) > CLUSTER_GAP_HOURS * 3600 * 1000) {
        console.log(
          `[Clustering] кластер ${clusterId} мёртв (gap ${((pub - lastSeen) / 3600000).toFixed(1)}ч > ${CLUSTER_GAP_HOURS}ч) — новость ${news.id} остаётся одиночкой`
        );
        await client.query('ROLLBACK');
        return;
      }
      const firstPub = clRes.rows[0].first_published_at;
      await client.query(
        `UPDATE clusters SET
           size = size + 1,
           last_seen_at = GREATEST(last_seen_at, $2::timestamptz),
           max_sim = GREATEST(COALESCE(max_sim, 0), $3::real),
           verdict = $4
         WHERE id = $1`,
        [clusterId, news.published_at, sim, verdictBySim(sim)]
      );
      const lagMin = Math.max(
        0,
        Math.round((new Date(news.published_at).getTime() - new Date(firstPub).getTime()) / 60000)
      );
      await client.query(
        'INSERT INTO cluster_items (cluster_id, news_id, lag_min) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [clusterId, news.id, lagMin]
      );
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
    }

    await client.query('UPDATE news SET cluster_id = $1 WHERE id = $2', [clusterId, news.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
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

  // 3–7. Кандидаты, вето, зоны, приклеивание — по одной новости последовательно
  for (const news of newsList) {
    try {
      await clusterOne(news, vectors.get(news.id)!);
    } catch (err: any) {
      console.warn(`[Clustering] новость ${news.id} пропущена (non-fatal):`, err.message);
    }
  }
}

async function clusterOne(news: NewsRow, vector: number[]): Promise<void> {
  if (isRubricTitle(news.title_ru || '')) {
    return; // рубрики-дайджесты не участвуют в склейке
  }

  const pub = new Date(news.published_at);
  const from = new Date(pub.getTime() - CANDIDATE_WINDOW_HOURS * 3600 * 1000);

  const candRes = await query(
    `SELECT n.id, n.title_ru, n.cluster_id, n.source, n.published_at,
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
    await attachToCluster(news, best, best.sim);
    return;
  }

  if (best.sim >= CLUSTER_T2) {
    const verdict = await verifyPair(
      {
        id: news.id,
        title: news.title_ru || '',
        summary: news.summary_ru || '',
        source: news.source || undefined,
        publishedAt: news.published_at,
      },
      {
        id: best.id,
        title: best.title_ru || '',
        summary: '',
        source: best.source || undefined,
        publishedAt: best.published_at,
      },
      best.sim
    );
    if (verdict.sameEvent) {
      await attachToCluster(news, best, best.sim);
    }
    return;
  }

  // sim < T2 — одиночка, кластеры из одной новости не создаём
}
