/**
 * =============================================================================
 * PULSE — ПРАВКА-2 к ТЗ-191: новостной фон (сантимент) недельного графика
 * =============================================================================
 *
 * Прогон: USE_SQLITE=true npx ts-node --transpile-only src/tests/weeklySentiment.test.ts
 *
 * Покрытие (тесты 1–3 из ТЗ, чистая функция без БД/HTTP):
 *   1. Бакеты 4 ч покрывают окно недели (~42), знак бакета соответствует
 *      балансу pos/neg внутри него; события вне окна отброшены.
 *   2. Сглаживание trailing-окном 12 ч: одиночная негативная новость при
 *      нейтральном фоне не даёт бакета −1; окно ходит за событиями.
 *   3. Деградация: 9 новостей → null; ровно 10 → серия. Пусто → null.
 */

import {
  buildSentimentSeries,
  SENTIMENT_BUCKET_MS,
  SENTIMENT_MIN_NEWS,
  type WeeklySentimentEvent,
} from '../services/weeklySentiment';

// Понедельник 13.10.2026 00:00 МСК = 12.10.2026 21:00 UTC
const WEEK_START = new Date('2026-10-12T21:00:00.000Z');

/** Событие со сдвигом offsetMs от начала недели */
function ev(offsetMs: number, sentiment: string): WeeklySentimentEvent {
  return { published_at: new Date(WEEK_START.getTime() + offsetMs).toISOString(), sentiment };
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

/** Серия округляет score до 3 знаков — сравниваем с округлённым ожиданием */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function main() {
  // 1. Бакеты покрывают окно, знак = баланс pos/neg, вне окна отброшено
  {
    const events: WeeklySentimentEvent[] = [
      // бакет 0: 1 pos + 3 neg → сырой (1−3)/4 = −0,5
      ev(1 * 3600e3, 'positive'), ev(2 * 3600e3, 'negative'), ev(3 * 3600e3, 'negative'), ev(3.5 * 3600e3, 'negative'),
      // бакет 1: 2 pos + 1 neutral → (2−0)/3 ≈ 0,667
      ev(SENTIMENT_BUCKET_MS + 1 * 3600e3, 'positive'), ev(SENTIMENT_BUCKET_MS + 2 * 3600e3, 'positive'), ev(SENTIMENT_BUCKET_MS + 3 * 3600e3, 'neutral'),
      // добиваем до лимита в бакете 2 (3 neutral) и 3 (3 neutral)
      ...[0, 1, 2].map((i) => ev(2 * SENTIMENT_BUCKET_MS + i * 3600e3, 'neutral')),
      ...[0, 1, 2].map((i) => ev(3 * SENTIMENT_BUCKET_MS + i * 3600e3, 'neutral')),
      // вне окна: до начала и на границе конца — не считаются
      ev(-3600e3, 'negative'),
      ev(7 * 24 * 3600e3, 'positive'),
    ];
    const series = buildSentimentSeries(events, WEEK_START);
    check('10 новостей в окне → серия есть', Array.isArray(series));
    if (!series) return;
    check('окно недели = 42 бакета', series.length === 42, series.length);
    check('якорь бакетов — начало недели', series[0].t === WEEK_START.toISOString(), series[0].t);
    check('шаг бакетов 4 ч', series[1].t === new Date(WEEK_START.getTime() + SENTIMENT_BUCKET_MS).toISOString());
    // сглаживание: бакет 0 (окно [0]) = −0,5; бакет 1 (окно [0..1] непустые) = (−0,5+0,667)/2 ≈ 0,083
    check('знак бакета 0 — по балансу pos/neg (−0,5 в окне [0])', series[0].score === -0.5, series[0].score);
    check('бакет 1 — среднее непустых окна [0..1]', series[1].score === round3((-0.5 + 2 / 3) / 2), series[1].score);
    check('бакет 2 — окно [0..2], все непустые', series[2].score === round3((-0.5 + 2 / 3 + 0) / 3), series[2].score);
    check('бакет 3 — окно [1..3]: (0,667+0+0)/3', series[3].score === round3((2 / 3) / 3), series[3].score);
    check('после событий фон 0 (нейтрально)', series[41].score === 0, series[41].score);
    check('граница конца окна: событие ровно на t1 отброшено', !series.some((p) => p.score === 1));
  }

  // 2. Сглаживание: одиночная негативная новость при нейтральном фоне не даёт −1
  {
    const events: WeeklySentimentEvent[] = [
      ...Array.from({ length: 9 }, (_, i) => ev(i * 10 * 60e3, 'neutral')), // 9 нейтральных в бакете 0
      ev(SENTIMENT_BUCKET_MS + 3600e3, 'negative'), // 1 негативная в бакете 1
    ];
    const series = buildSentimentSeries(events, WEEK_START);
    check('нейтральный фон + 1 негатив → серия есть', Array.isArray(series));
    if (!series) return;
    check('бакет 0 — чистый нейтральный фон (0)', series[0].score === 0, series[0].score);
    check('бакет 1 окно [0..1]: (0 + (−1))/2 = −0,5 — размазано, не −1', series[1].score === -0.5, series[1].score);
    check('бакет 3 (окно [1..3]): всё ещё −1 — trailing ходит за событием', series[3].score === -1, series[3].score);
    check('бакет 4 (окно [2..4]): событие вышло из окна → 0', series[4].score === 0, series[4].score);
  }

  // 3. Деградация: < лимита → null
  {
    check('9 новостей → null', buildSentimentSeries(
      Array.from({ length: 9 }, (_, i) => ev(i * 3600e3, 'positive')), WEEK_START) === null);
    check('пусто → null', buildSentimentSeries([], WEEK_START) === null);
    const ten = buildSentimentSeries(
      Array.from({ length: SENTIMENT_MIN_NEWS }, (_, i) => ev(i * 3600e3, 'negative')), WEEK_START);
    check('ровно 10 новостей → серия', Array.isArray(ten));
    // 10 новостей со сдвигом 0–9 ч лежат в бакетах 0–2 (4+4+2), все raw = −1
    check('бакет 0 (окно [0]) = −1', ten !== null && ten[0].score === -1, ten?.[0].score);
    check('бакет 2 (окно [0..2], все непустые) = −1', ten !== null && ten[2].score === -1, ten?.[2].score);
    check('бакет 3 (окно [1..3], непустые 1–2) = −1', ten !== null && ten[3].score === -1, ten?.[3].score);
    check('бакет 5 (окно [3..5] пусто) = 0', ten !== null && ten[5].score === 0, ten?.[5].score);
  }

  // 4. Live-окно: конец = now, бакеты до now
  {
    const liveEnd = new Date(WEEK_START.getTime() + 2 * SENTIMENT_BUCKET_MS + 3600e3);
    const series = buildSentimentSeries(
      Array.from({ length: 10 }, (_, i) => ev(i * 30 * 60e3, 'positive')), WEEK_START, liveEnd);
    check('live: серия покрывает окно до now (3 бакета)', Array.isArray(series) && series?.length === 3, series?.length);
    check('live: знак по балансу (+1 при всех positive)', series !== null && series[0].score === 1, series?.[0].score);
  }
}

main();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

export {};
