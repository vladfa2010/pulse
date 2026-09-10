/**
 * ТЗ-91 (этап 1) — Бэкфилл эмбеддингов всей базы новостей.
 *
 * Run: npx ts-node --transpile-only src/scripts/backfillEmbeddings.ts
 *
 * Логика (ТЗ-91, задача 5):
 *   1. Цикл: новости без embedding (с title_ru) батчами по 32, ORDER BY published_at.
 *      Обработанные строки выпадают из фильтра — скрипт резюмируется перезапуском.
 *   2. Каждый батч → embedBatch (TEI) → батч-апдейт одним запросом через unnest.
 *   3. Прогресс каждые 500 новостей (обработано/осталось/скорость).
 *   4. Батч, упавший дважды, пропускается: id в skipped, в конце —
 *      logs/backfill_embeddings_skipped.json.
 *
 * Ожидаемая длительность: 6–15 ч на ~119 тыс. новостей (1 vCPU у контейнера).
 * Запускать ночью (МСК); прерывание безопасно, повторный запуск догоняет.
 *
 * Только PostgreSQL — SQLite-режим (USE_SQLITE) сознательно не поддерживаем.
 */

import * as fs from 'fs';
import * as path from 'path';
import { query } from '../config/db';
import { embedBatch, embeddingText } from '../services/embeddings';

// 16 текстов ≈ ≤4k токенов — помещается в --max-batch-tokens 4096 контейнера
// (16384, указанные в ТЗ, требуют 16 ГБ RAM при прогреве TEI и на VDS 4 ГБ
// не работают; лимит 32 у клиента сохранён — EMBEDDING_MAX_BATCH).
const BATCH_SIZE = 16;
const PROGRESS_EVERY = 500;
const SKIPPED_LOG = path.join(process.cwd(), 'logs', 'backfill_embeddings_skipped.json');

interface SkippedEntry {
  ids: string[];
  reason: string;
}

async function backfillEmbeddings(): Promise<void> {
  console.log('[BackfillEmb] Старт бэкфилла эмбеддингов (ТЗ-91)...');
  const t0 = Date.now();
  let processed = 0;
  const skipped: SkippedEntry[] = [];

  // Защита от бесконечного цикла: количество подряд идущих батчей без прогресса
  let noProgressRounds = 0;

  for (;;) {
    const res = await query(`
      SELECT id, title_ru, summary_ru
      FROM news
      WHERE embedding IS NULL AND title_ru IS NOT NULL
      ORDER BY published_at
      LIMIT ${BATCH_SIZE}
    `);
    const rows = res.rows;
    if (rows.length === 0) break;

    // Строки, у которых текст пуст после обрезки, — не эмбеддятся никогда:
    // отправляем в skipped, иначе они будут бесконечно попадать в выборку.
    const embeddable = rows.filter((r: any) => embeddingText(r.title_ru, r.summary_ru).length > 0);
    const emptyIds = rows.filter((r: any) => embeddingText(r.title_ru, r.summary_ru).length === 0).map((r: any) => String(r.id));
    if (emptyIds.length > 0) {
      skipped.push({ ids: emptyIds, reason: 'empty_text' });
      console.warn(`[BackfillEmb] Пропущено ${emptyIds.length} строк с пустым текстом (помечены skipped)`);
    }

    if (embeddable.length === 0) {
      noProgressRounds++;
      if (noProgressRounds > 10) {
        console.error('[BackfillEmb] Критерий остановки: >10 раундов без прогресса. Прерываю.');
        break;
      }
      continue;
    }

    const texts = embeddable.map((r: any) => embeddingText(r.title_ru, r.summary_ru));

    let vectors: number[][];
    try {
      vectors = await embedBatch(texts);
    } catch (err) {
      // Повторная попытка на уровне скрипта (клиент уже сделал свой retry)
      console.error(`[BackfillEmb] Батч упал: ${(err as Error).message}. Повторная попытка...`);
      try {
        vectors = await embedBatch(texts);
      } catch (err2) {
        console.error(`[BackfillEmb] Батч упал дважды — пропускаю ${embeddable.length} id: ${(err2 as Error).message}`);
        skipped.push({ ids: embeddable.map((r: any) => String(r.id)), reason: 'tei_error' });
        noProgressRounds++;
        if (noProgressRounds > 10) {
          console.error('[BackfillEmb] Критерий остановки: >10 раундов без прогресса. Прерываю.');
          break;
        }
        continue;
      }
    }

    noProgressRounds = 0;

    // Батч-апдейт одним запросом через unnest; JS-массив чисел сериализуется
    // драйвером pg как '{...}' и кастуется в vector через ::vector.
    const ids = embeddable.map((r: any) => r.id);
    const vecStrings = vectors.map((v) => `[${v.join(',')}]`);
    await query(
      `UPDATE news
       SET embedding = u.vec::vector
       FROM unnest($1::uuid[], $2::text[]) AS u(id, vec)
       WHERE news.id = u.id`,
      [ids, vecStrings]
    );

    processed += embeddable.length;

    if (processed % PROGRESS_EVERY < BATCH_SIZE) {
      const remaining = await query(
        `SELECT count(*)::int AS c FROM news WHERE embedding IS NULL AND title_ru IS NOT NULL`
      );
      const elapsedMin = (Date.now() - t0) / 60000;
      const rate = processed / Math.max(elapsedMin, 0.01);
      console.log(
        `[BackfillEmb] Обработано: ${processed} | Осталось: ${remaining.rows[0].c} | ` +
        `Скорость: ${rate.toFixed(0)}/мин | Прошло: ${elapsedMin.toFixed(1)} мин`
      );
    }
  }

  console.log(`[BackfillEmb] Готово. Обработано: ${processed}, пропущено батчей: ${skipped.length}, время: ${((Date.now() - t0) / 60000).toFixed(1)} мин`);

  if (skipped.length > 0) {
    fs.mkdirSync(path.dirname(SKIPPED_LOG), { recursive: true });
    fs.writeFileSync(SKIPPED_LOG, JSON.stringify(skipped, null, 2));
    console.log(`[BackfillEmb] Список skipped сохранён: ${SKIPPED_LOG}`);
  }

  process.exit(0);
}

backfillEmbeddings().catch((err) => {
  console.error('[BackfillEmb] Фатальная ошибка:', err);
  process.exit(1);
});
