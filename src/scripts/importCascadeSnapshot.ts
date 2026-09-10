/**
 * ТЗ-91 (этап 1, задача 8) — Импорт исторических каскадов из сендбокса.
 *
 * Run: npx ts-node --transpile-only src/scripts/importCascadeSnapshot.ts
 *
 * Вход: cascade_import.json в КОРНЕ РЕПО (передаёт владелец, ~427 КБ):
 *   { "cascades": [ { news_ids, tags, verdict, max_sim, ... }, ... ],
 *     "story_candidates": [ ... ] }
 * Поле news_ids — реальные id таблицы news (окно 2026-06-07 → 2026-09-05 UTC).
 *
 * Логика:
 *   1. Идемпотентность: обнулить news.cluster_id у импортных кластеров и
 *      удалить их (ON DELETE CASCADE снесёт cluster_items).
 *   2. Для каждого элемента — строка в clusters (kind='cascade' / 'story_candidate',
 *      source='sandbox-import', first/last_published_at — min/max published_at
 *      по найденным news_ids, size — число найденных id).
 *   3. Связи в cluster_items (lag_min = разница с first_published_at в минутах).
 *   4. news.cluster_id — только если NULL (новость может входить в несколько
 *      импортных кластеров; первую привязку не перезаписываем).
 *   5. id из json, которых нет в news, — считаем и выводим (ожидается ~0).
 *
 * Существующие строки clusters с source='realtime' не трогаем.
 * Только PostgreSQL. Запускать после миграции news_embeddings_v1.sql.
 */

import * as fs from 'fs';
import * as path from 'path';
import { pool, query } from '../config/db';

const INPUT_FILE = path.join(process.cwd(), 'cascade_import.json');

interface SnapshotItem {
  news_ids: string[];
  tags?: string[];
  verdict?: string;
  max_sim?: number;
  [key: string]: unknown;
}

interface Snapshot {
  cascades?: SnapshotItem[];
  story_candidates?: SnapshotItem[];
  [key: string]: unknown;
}

async function importCascadeSnapshot(): Promise<void> {
  console.log('[CascadeImport] Старт импорта каскадов (ТЗ-91, задача 8)...');

  if (!pool) {
    console.error('[CascadeImport] Ошибка: нужен PostgreSQL (pool недоступен, возможно USE_SQLITE).');
    process.exit(1);
  }

  if (!fs.existsSync(INPUT_FILE)) {
    console.error(
      `[CascadeImport] Файл не найден: ${INPUT_FILE}\n` +
      '[CascadeImport] Положите cascade_import.json (передаёт владелец) в корень репо и запустите скрипт снова.'
    );
    process.exit(1);
  }

  const snapshot = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf-8')) as Snapshot;
  const groups: Array<{ kind: string; items: SnapshotItem[] }> = [
    { kind: 'cascade', items: snapshot.cascades || [] },
    { kind: 'story_candidate', items: snapshot.story_candidates || [] },
  ];
  const totalItems = groups.reduce((s, g) => s + g.items.length, 0);
  console.log(`[CascadeImport] В файле: cascades=${snapshot.cascades?.length || 0}, story_candidates=${snapshot.story_candidates?.length || 0}`);

  const client = await pool.connect();
  let importedClusters = 0;
  let importedItems = 0;
  const missingIds = new Set<string>();

  try {
    await client.query('BEGIN');

    // ─── Идемпотентность: снести прошлый импорт ──────────────────────────────
    console.log('[CascadeImport] Идемпотентность: удаляю прошлый sandbox-import...');
    await client.query(`
      UPDATE news SET cluster_id = NULL
      WHERE cluster_id IN (SELECT id FROM clusters WHERE source = 'sandbox-import')
    `);
    const delRes = await client.query(`DELETE FROM clusters WHERE source = 'sandbox-import'`);
    console.log(`[CascadeImport] Удалено старых импортных кластеров: ${delRes.rowCount}`);

    for (const group of groups) {
      for (const item of group.items) {
        const ids: string[] = Array.isArray(item.news_ids) ? item.news_ids.filter(Boolean) : [];
        if (ids.length === 0) continue;

        // Ищем существующие новости и их published_at
        const newsRes = await client.query(
          `SELECT id, published_at FROM news WHERE id = ANY($1::uuid[])`,
          [ids]
        );
        const found = newsRes.rows as Array<{ id: string; published_at: Date }>;
        const foundIds = new Set(found.map((r) => String(r.id)));
        for (const id of ids) {
          if (!foundIds.has(String(id))) missingIds.add(String(id));
        }
        if (found.length === 0) continue;

        const firstPub = found.reduce((min, r) => (r.published_at < min ? r.published_at : min), found[0].published_at);
        const lastPub = found.reduce((max, r) => (r.published_at > max ? r.published_at : max), found[0].published_at);

        // Строка кластера
        const clRes = await client.query(
          `INSERT INTO clusters (kind, tags, verdict, max_sim, first_published_at, last_seen_at, size, source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'sandbox-import')
           RETURNING id`,
          [
            group.kind,
            Array.isArray(item.tags) && item.tags.length > 0 ? item.tags : null,
            item.verdict != null ? String(item.verdict) : null,
            item.max_sim != null ? Number(item.max_sim) : null,
            firstPub,
            lastPub,
            found.length,
          ]
        );
        const clusterId = clRes.rows[0].id;

        // Связи (lag_min = минуты от first_published_at)
        for (const r of found) {
          const lagMin = Math.max(0, Math.round((r.published_at.getTime() - firstPub.getTime()) / 60000));
          await client.query(
            `INSERT INTO cluster_items (cluster_id, news_id, lag_min) VALUES ($1, $2, $3)
             ON CONFLICT (cluster_id, news_id) DO NOTHING`,
            [clusterId, r.id, lagMin]
          );
          importedItems++;

          // news.cluster_id — только если NULL (первую привязку не перезаписываем)
          await client.query(`UPDATE news SET cluster_id = $1 WHERE id = $2 AND cluster_id IS NULL`, [clusterId, r.id]);
        }

        importedClusters++;
        if (importedClusters % 200 === 0) {
          console.log(`[CascadeImport] Прогресс: ${importedClusters}/${totalItems} кластеров...`);
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  console.log(`[CascadeImport] Готово. Кластеров импортировано: ${importedClusters}, связей: ${importedItems}`);
  if (missingIds.size > 0) {
    console.log(`[CascadeImport] ВНИМАНИЕ: id из json, не найденные в news: ${missingIds.size}`);
    console.log(`[CascadeImport] Первые 20: ${Array.from(missingIds).slice(0, 20).join(', ')}`);
  } else {
    console.log('[CascadeImport] Все id из json найдены в news.');
  }
  process.exit(0);
}

importCascadeSnapshot().catch((err) => {
  console.error('[CascadeImport] Фатальная ошибка:', err);
  process.exit(1);
});
