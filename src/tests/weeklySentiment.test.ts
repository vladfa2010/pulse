/**
 * =============================================================================
 * PULSE — ТЗ-194: накопительное настроение новостей недельного графика
 * =============================================================================
 *
 * Прогон: USE_SQLITE=true npx ts-node --transpile-only src/tests/weeklySentiment.test.ts
 *
 * Покрытие (чистая функция без БД/HTTP):
 *   1. Накопление: значение после каждой новости = предыдущее ±1; порядок строго
 *      published_at; нейтральные не создают точек.
 *   2. Конец = сводке: последний cum равен positive − negative событий источника.
 *   3. Деградация: <2 ненейтральных → null (по ненейтральным, не по всем);
 *      ровно 2 → серия; пусто → null.
 *   4. Live-окно: события вне [start, now) отброшены; кривая — баланс на now.
 *   5. news_id: проходит в точку; у событий без id — null (старые снапшоты).
 */

import {
  buildSentimentSeries,
  SENTIMENT_MIN_NEWS,
  type WeeklySentimentEvent,
} from '../services/weeklySentiment';

// Понедельник 19.10.2026 00:00 МСК = 18.10.2026 21:00 UTC
const WEEK_START = new Date('2026-10-18T21:00:00.000Z');

/** Событие со сдвигом offsetMs от начала недели */
function ev(offsetMs: number, sentiment: string, news_id?: string | null): WeeklySentimentEvent {
  return {
    published_at: new Date(WEEK_START.getTime() + offsetMs).toISOString(),
    sentiment,
    ...(news_id !== undefined ? { news_id } : {}),
  };
}

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

function main() {
  // 1. Накопление: порядок published_at, ±1 после каждой новости, нейтральные без точек
  {
    const events: WeeklySentimentEvent[] = [
      ev(3 * 3600e3, 'positive', 'n3'),   // cum +1
      ev(1 * 3600e3, 'negative', 'n1'),  // раньше по времени → идёт первой: cum −1
      ev(2 * 3600e3, 'neutral', 'n2'),   // не создаёт точки
      ev(4 * 3600e3, 'positive', 'n4'),  // cum 0 → +1
      ev(5 * 3600e3, 'negative', 'n5'),  // cum 0
      // вне окна: до начала и на границе конца — не считаются
      ev(-3600e3, 'positive', 'x1'),
      ev(7 * 24 * 3600e3, 'negative', 'x2'),
    ];
    const series = buildSentimentSeries(events, WEEK_START);
    check('4 ненейтральные в окне → серия', Array.isArray(series));
    if (!series) return;
    check('нейтральные не создают точек (4 ненейтральных → 4 точки)', series.length === 4, series.length);
    check('порядок строго published_at: первая — самая ранняя (n1)',
      series[0].t === ev(1 * 3600e3, 'negative').published_at && series[0].news_id === 'n1', series[0]);
    check('накопление: −1 после негатива', series[0].cum === -1, series[0].cum);
    check('накопление: 0 после позитива (−1+1)', series[1].cum === 0, series[1].cum);
    check('накопление: +1 после позитива (0+1)', series[2].cum === 1, series[2].cum);
    check('t точки = published_at новости', series[2].t === ev(4 * 3600e3, 'positive').published_at, series[2].t);
    check('news_id проходит в точку', series.every((p) => typeof p.news_id === 'string'), series.map((p) => p.news_id));
  }

  // 2. Конец кривой = positive − negative источника (кросс-проверка со сводкой)
  {
    const events: WeeklySentimentEvent[] = [
      ev(1 * 3600e3, 'positive'), ev(2 * 3600e3, 'positive'), ev(3 * 3600e3, 'negative'),
      ev(4 * 3600e3, 'neutral'), ev(5 * 3600e3, 'positive'), ev(6 * 3600e3, 'negative'),
      ev(7 * 3600e3, 'negative'),
    ];
    const series = buildSentimentSeries(events, WEEK_START);
    const pos = events.filter((e) => e.sentiment === 'positive').length;
    const neg = events.filter((e) => e.sentiment === 'negative').length;
    check('последний cum = positive − negative (3−3 = 0)',
      series !== null && series[series.length - 1].cum === pos - neg,
      series?.[series.length - 1].cum);
    const oneWay: WeeklySentimentEvent[] = [
      ev(1 * 3600e3, 'positive'), ev(2 * 3600e3, 'positive'), ev(3 * 3600e3, 'positive'),
      ev(4 * 3600e3, 'negative'),
    ];
    const s2 = buildSentimentSeries(oneWay, WEEK_START);
    check('итог +2 при 3 pos / 1 neg', s2 !== null && s2[s2.length - 1].cum === 2, s2?.[s2.length - 1].cum);
  }

  // 3. Деградация: < SENTIMENT_MIN_NEWS ненейтральных → null (по НЕНЕЙТРАЛЬНЫМ)
  {
    check('1 ненейтральная + куча нейтральных → null (порог по ненейтральным)',
      buildSentimentSeries(
        [ev(3600e3, 'positive'), ...[2, 3, 4, 5, 6].map((h) => ev(h * 3600e3, 'neutral'))],
        WEEK_START) === null);
    check('пусто → null', buildSentimentSeries([], WEEK_START) === null);
    check('все нейтральные → null',
      buildSentimentSeries([ev(3600e3, 'neutral'), ev(2 * 3600e3, 'neutral')], WEEK_START) === null);
    check('ровно 2 ненейтральные → серия', Array.isArray(buildSentimentSeries(
      [ev(3600e3, 'positive'), ev(2 * 3600e3, 'negative')], WEEK_START)));
    check('порог = 2 (SENTIMENT_MIN_NEWS)', SENTIMENT_MIN_NEWS === 2, SENTIMENT_MIN_NEWS);
    const onePos = buildSentimentSeries(
      [ev(3600e3, 'positive'), ev(2 * 3600e3, 'neutral'), ev(3 * 3600e3, 'neutral')], WEEK_START);
    check('1 pos + 2 neutral → null (деградация, хотя новостей 3)', onePos === null, onePos);
  }

  // 4. Live-окно: правая граница = now
  {
    const liveEnd = new Date(WEEK_START.getTime() + 3 * 3600e3);
    const series = buildSentimentSeries(
      [ev(1 * 3600e3, 'positive'), ev(2 * 3600e3, 'positive'), ev(4 * 3600e3, 'positive')],
      WEEK_START, liveEnd);
    check('событие после now отброшено (2 точки)', series !== null && series.length === 2, series?.length);
    check('live: баланс на now = +2', series !== null && series[series.length - 1].cum === 2,
      series?.[series.length - 1].cum);
    const beforeStart = buildSentimentSeries(
      [ev(3600e3, 'positive'), ev(2 * 3600e3, 'positive')],
      new Date(WEEK_START.getTime() + 2 * 3600e3), liveEnd);
    check('события до weekStart отброшены → null', beforeStart === null, beforeStart);
  }

  // 5. news_id: null у событий без id (старые снапшоты), tie-break по исходному порядку
  {
    const series = buildSentimentSeries(
      [ev(3600e3, 'positive'), ev(3600e3, 'negative'), ev(2 * 3600e3, 'positive')], WEEK_START);
    check('события без news_id → null в точках',
      series !== null && series.every((p) => p.news_id === null), series?.map((p) => p.news_id));
    check('равные published_at: исходный порядок сохранён (−1 второй, т.к. шёл вторым)',
      series !== null && series[0].cum === 1 && series[1].cum === 0, series?.map((p) => p.cum));
  }
}

main();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

export {};
