/**
 * ТЗ-91 (этап 1, задача 7) — Выгрузка пар для калибровки порогов каскадов.
 *
 * Run: npx ts-node --transpile-only src/scripts/dumpCalibrationPairs.ts
 *
 * Пороги трёх зон (0.92 / 0.80 в Методологии §6) посчитаны под TF-IDF и на
 * эмбеддинги не переносятся. Скрипт готовит данные, анализ делает владелец.
 *
 * Результат: calibration_pairs.csv в корне репо (kind,sim,news_id_a,news_id_b):
 *   - позитивы: все пары новостей внутри импортированных кластеров
 *     (задача 8, source='sandbox-import'), sim = 1 - косинусное расстояние;
 *   - негативы: 10 000 случайных пар новостей с разницей published_at > 3 суток.
 *
 * Запускать только ПОСЛЕ бэкфилла (задача 5) — пары без векторов отсекаются.
 * Только PostgreSQL.
 */

import * as fs from 'fs';
import * as path from 'path';
import { query } from '../config/db';

const NEGATIVE_PAIRS = 10_000;
const NEG_SAMPLE_SIZE = NEGATIVE_PAIRS * 2; // 20000 строк → 10000 пар через offset
const THREE_DAYS_SEC = 3 * 24 * 3600;
const OUT_FILE = path.join(process.cwd(), 'calibration_pairs.csv');

async function dumpCalibrationPairs(): Promise<void> {
  console.log('[CalibPairs] Старт выгрузки пар для калибровки (ТЗ-91, задача 7)...');
  const t0 = Date.now();
  const lines: string[] = [];

  // ─── Позитивы: пары внутри импортированных кластеров ──────────────────────
  console.log('[CalibPairs] Считаю позитивы (пары внутри sandbox-import кластеров)...');
  const posRes = await query(`
    SELECT ci1.news_id AS a, ci2.news_id AS b,
           1 - (n1.embedding <=> n2.embedding) AS sim
    FROM cluster_items ci1
    JOIN cluster_items ci2
      ON ci1.cluster_id = ci2.cluster_id AND ci1.news_id < ci2.news_id
    JOIN clusters c ON c.id = ci1.cluster_id AND c.source = 'sandbox-import'
    JOIN news n1 ON n1.id = ci1.news_id
    JOIN news n2 ON n2.id = ci2.news_id
    WHERE n1.embedding IS NOT NULL AND n2.embedding IS NOT NULL
  `);
  for (const r of posRes.rows) {
    lines.push(`pos,${Number(r.sim).toFixed(6)},${r.a},${r.b}`);
  }
  console.log(`[CalibPairs] Позитивов: ${posRes.rows.length}`);

  // ─── Негативы: случайные пары с разницей published_at > 3 суток ───────────
  // Offset-паринг случайной выборки: 20000 строк → 10000 пар (rn ↔ rn+10000).
  // Так избегаем кросс-джойна всей таблицы (119k² пар).
  console.log('[CalibPairs] Считаю негативы (10 000 случайных пар, Δt > 3 суток)...');
  const negRes = await query(
    `
    WITH s AS (
      SELECT id, embedding, published_at,
             row_number() OVER (ORDER BY random()) AS rn
      FROM news
      WHERE embedding IS NOT NULL
      LIMIT ${NEG_SAMPLE_SIZE}
    )
    SELECT s1.id AS a, s2.id AS b,
           1 - (s1.embedding <=> s2.embedding) AS sim
    FROM s s1
    JOIN s s2 ON s2.rn = s1.rn + ${NEGATIVE_PAIRS}
    WHERE ABS(EXTRACT(EPOCH FROM (s1.published_at - s2.published_at))) > $1
    LIMIT ${NEGATIVE_PAIRS}
    `,
    [THREE_DAYS_SEC]
  );
  for (const r of negRes.rows) {
    lines.push(`neg,${Number(r.sim).toFixed(6)},${r.a},${r.b}`);
  }
  console.log(`[CalibPairs] Негативов: ${negRes.rows.length} (целевое: ${NEGATIVE_PAIRS})`);

  fs.writeFileSync(OUT_FILE, 'kind,sim,news_id_a,news_id_b\n' + lines.join('\n') + '\n');
  console.log(`[CalibPairs] Готово: ${OUT_FILE} (${lines.length} пар, ${((Date.now() - t0) / 1000).toFixed(1)} с)`);
  process.exit(0);
}

dumpCalibrationPairs().catch((err) => {
  console.error('[CalibPairs] Фатальная ошибка:', err);
  process.exit(1);
});
