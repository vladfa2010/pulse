/**
 * ТЗ-92 — исторический проход кластеризации (после бэкфилла эмбеддингов).
 * ТЗ-181: кандидаты — и с переведёнными, и с непереведёнными новостями
 * (title_ru IS NULL, title_original заполнен); опциональный аргумент — окно
 * дней назад от NOW() для прицельного прогона (свежие сначала).
 *
 * Бэкфилл ТЗ-91 считает только векторы; кластеризация реалтайм-пайплайном
 * охватывает новости последних 7 суток (catch-up воркер). Этот скрипт
 * прогоняет кластеризацию по всем новостям с готовым вектором и
 * cluster_id IS NULL — задним числом собирает каскады по всей истории.
 *
 * Run: npx ts-node --transpile-only src/scripts/backfillClusters.ts [дней]
 *   без аргумента — вся история; с аргументом (например 14) — последние 14 суток.
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
  // ТЗ-181 §4.3: опциональное окно дней для прицельного прогона
  const sinceDays = Number(process.argv[2] || 0);
  const windowClause = sinceDays > 0 ? 'AND published_at > NOW() - $1::int * INTERVAL \'1 day\'' : '';
  const windowParams = sinceDays > 0 ? [sinceDays] : [];

  console.log(`[BackfillClusters] Старт исторического прохода кластеризации (ТЗ-92, фильтр ТЗ-181)${sinceDays > 0 ? `, окно: ${sinceDays} суток` : ''}...`);

  const totalRes = await query(
    `SELECT count(*) AS n FROM news
     WHERE embedding IS NOT NULL
       AND (title_ru IS NOT NULL OR title_original IS NOT NULL)
       AND cluster_id IS NULL
       ${windowClause}`,
    windowParams
  );
  const total = parseInt(totalRes.rows[0].n, 10);
  console.log(`[BackfillClusters] Новостей к кластеризации: ${total}`);
  if (total === 0) return;

  const idsRes = await query(
    `SELECT id FROM news
     WHERE embedding IS NOT NULL
       AND (title_ru IS NOT NULL OR title_original IS NOT NULL)
       AND cluster_id IS NULL
       ${windowClause}
     ORDER BY published_at DESC`,
    windowParams
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
     WHERE embedding IS NOT NULL
       AND (title_ru IS NOT NULL OR title_original IS NOT NULL)
       AND cluster_id IS NULL
       ${windowClause}`,
    windowParams
  );
  console.log(`[BackfillClusters] Готово. Осталось без кластера: ${leftRes.rows[0].n} (одиночки / пары без дублей в окне 48ч)`);
}

main().catch((err) => {
  console.error('[BackfillClusters] Фатальная ошибка:', err.message);
  process.exit(1);
});
