/**
 * ТЗ-92 — исторический проход кластеризации (после бэкфилла эмбеддингов).
 *
 * Бэкфилл ТЗ-91 считает только векторы; кластеризация реалтайм-пайплайном
 * охватывает новости последних 7 суток (catch-up воркер). Этот скрипт
 * прогоняет кластеризацию по всем новостям с готовым вектором и
 * cluster_id IS NULL — задним числом собирает каскады по всей истории.
 *
 * Run: npx ts-node --transpile-only src/scripts/backfillClusters.ts
 *
 * Резюмируемый (фильтр cluster_id IS NULL), батчи по 200, прогресс каждые 500.
 * ВАЖНО: пары зоны сомнений (T2..T1) идут через LLM-верификатор с суточным
 * лимитом (VERIFIER_DAILY_LIMIT, дефолт 2000) — за один день исторический
 * проход закроет только часть серой зоны, остаток доклеится повторными
 * прогонами (или останется одиночками — по дизайну).
 * Только PostgreSQL. TEI не используется.
 */

import { query } from '../config/db';
import { clusterEmbeddedBatch } from '../services/clustering';

const BATCH = 200;

async function main() {
  console.log('[BackfillClusters] Старт исторического прохода кластеризации (ТЗ-92)...');

  const totalRes = await query(
    `SELECT count(*) AS n FROM news
     WHERE embedding IS NOT NULL AND title_ru IS NOT NULL AND cluster_id IS NULL`
  );
  const total = parseInt(totalRes.rows[0].n, 10);
  console.log(`[BackfillClusters] Новостей к кластеризации: ${total}`);
  if (total === 0) return;

  const idsRes = await query(
    `SELECT id FROM news
     WHERE embedding IS NOT NULL AND title_ru IS NOT NULL AND cluster_id IS NULL
     ORDER BY published_at DESC`
  );
  const ids: string[] = idsRes.rows.map((r: any) => r.id);

  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    await clusterEmbeddedBatch(ids.slice(i, i + BATCH));
    done += BATCH;
    if (done % 1000 < BATCH) {
      console.log(`[BackfillClusters] Прогресс: ${Math.min(done, ids.length)}/${ids.length}`);
    }
  }

  const leftRes = await query(
    `SELECT count(*) AS n FROM news
     WHERE embedding IS NOT NULL AND title_ru IS NOT NULL AND cluster_id IS NULL`
  );
  console.log(`[BackfillClusters] Готово. Осталось без кластера: ${leftRes.rows[0].n} (одиночки / пары без дублей в окне 48ч)`);
}

main().catch((err) => {
  console.error('[BackfillClusters] Фатальная ошибка:', err.message);
  process.exit(1);
});
