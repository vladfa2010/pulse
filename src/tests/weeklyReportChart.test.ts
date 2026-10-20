/**
 * =============================================================================
 * PULSE — ТЗ-184: недельный отчёт — инфографика и агрегаты (тесты)
 * =============================================================================
 *
 * Прогоны:
 *   1. Агрегаты (SQLite, сидированные данные, 3 окна):
 *      - perTag: current/prevWeek/monthAvg считаются верно;
 *      - тег с новостями только в прошлой неделе присутствует с current=0;
 *      - тег без новостей вообще — с нулями;
 *      - границы окон: ровно 7 дней → НЕ current, ровно 14 дней → НЕ prev.
 *   2. Отсутствие лимита: 500 новостей на тег за неделю — счётчик 500.
 *   3. Рендер: PNG-сигнатура, retina-размер; кривые данные (нули) не падают;
 *      stats=null → null.
 *   4. Деградация: sendTelegramPhoto отвергнут (axios-stub) → false, warning,
 *      не бросает; форматтеры при stats=null отдают старые счётчики.
 *
 * Postgres-вариант SQL в этом файле не покрыт (нужен живой PG) — запросы
 * идентичны SQLite-веткам по логике окон; прогнать на VPS:
 *   npx ts-node src/tests/weeklyReportChart.test.ts   (с USE_SQLITE=true — локально)
 *
 * Запуск:  USE_SQLITE=true npx ts-node src/tests/weeklyReportChart.test.ts
 */

// ВАЖНО: env ставим ДО любых импортов модулей (USE_SQLITE читается при загрузке)
process.env.USE_SQLITE = 'true';

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { WeeklyStats } from '../services/notifications/weeklyStats';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}
function approx(actual: number, expected: number, eps = 0.01): boolean {
  return Math.abs(actual - expected) < eps;
}

// Фиксированное «сейчас»: границы окон считаются от него и в тесте, и в агрегатах
const NOW = new Date('2026-10-19T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const fmt = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19);
const daysAgo = (n: number, hh = 12, mm = 0, ss = 0) =>
  fmt(new Date(NOW.getTime() - n * DAY - (12 - hh) * 3600_000 - mm * 60_000 - ss * 1000));

let sqlite: any;
let statsMod: typeof import('../services/notifications/weeklyStats');
let chartMod: typeof import('../services/notifications/weeklyChart');
let fmtMod: typeof import('../services/notifications/formatters');

async function seedNews(rows: Array<Partial<{
  id: string; title: string; sentiment: string; matched: string[];
  fetched: string; published: string;
}>>) {
  for (const r of rows) {
    await sqlite.query(
      `INSERT INTO news (id, title_ru, title_original, summary_ru, source, url,
                         published_at, fetched_at, sentiment, matched_tags)
       VALUES (?, ?, '', '', 'test-source', ?, ?, ?, ?, ?)`,
      [r.id, r.title ?? r.id, `https://example.com/${r.id}`, r.published ?? r.fetched!, r.fetched!, r.sentiment ?? 'neutral', JSON.stringify(r.matched ?? [])]
    );
  }
}

async function runAggregateTests(): Promise<void> {
  console.log('\nТЗ-184.1 Агрегаты (SQLite, 3 окна):');

  // tag-a: 3 текущие, 2 прошлонедельные, 4 в окне 14–30 дней,
  // +1 ровно на границе 7 дней (должна попасть в prev), +1 ровно на границе
  // 14 дней (вне current/prev, внутри месяца).
  await seedNews([
    { id: 'a-cur-1', matched: ['tag-a'], sentiment: 'positive', fetched: daysAgo(1) },
    { id: 'a-cur-2', matched: ['tag-a'], sentiment: 'positive', fetched: daysAgo(3) },
    { id: 'a-cur-3', matched: ['tag-a'], sentiment: 'negative', fetched: daysAgo(6, 23) },
    { id: 'a-prev-1', matched: ['tag-a'], sentiment: 'negative', fetched: daysAgo(8) },
    { id: 'a-prev-2', matched: ['tag-a'], sentiment: 'neutral', fetched: daysAgo(10) },
    { id: 'a-month-1', matched: ['tag-a'], sentiment: 'neutral', fetched: daysAgo(16) },
    { id: 'a-month-2', matched: ['tag-a'], sentiment: 'positive', fetched: daysAgo(20) },
    { id: 'a-month-3', matched: ['tag-a'], sentiment: 'neutral', fetched: daysAgo(25) },
    { id: 'a-month-4', matched: ['tag-a'], sentiment: 'negative', fetched: daysAgo(29) },
    // Граница 7 дней ровно: NOT > currentStart → не current, да prev
    { id: 'a-edge-7d', matched: ['tag-a'], sentiment: 'neutral', fetched: daysAgo(7) },
    // Граница 14 дней ровно: NOT > prevStart → не prev, да месяц
    { id: 'a-edge-14d', matched: ['tag-a'], sentiment: 'neutral', fetched: daysAgo(14) },
  ]);
  // tag-b: только прошлая неделя → включается с current=0
  await seedNews([
    { id: 'b-prev-1', matched: ['tag-b'], sentiment: 'positive', fetched: daysAgo(9) },
    { id: 'b-prev-2', matched: ['tag-b'], sentiment: 'neutral', fetched: daysAgo(11) },
    { id: 'b-prev-3', matched: ['tag-b'], sentiment: 'negative', fetched: daysAgo(12) },
    { id: 'b-prev-4', matched: ['tag-b'], sentiment: 'neutral', fetched: daysAgo(13) },
  ]);

  const stats = await statsMod.computeWeeklyStats(
    sqlite.query,
    [
      { tagId: 'tag-a', tagName: 'Сбербанк' },
      { tagId: 'tag-b', tagName: 'Нефть' },
      { tagId: 'tag-c', tagName: 'Газ' },   // без новостей вообще
    ],
    NOW
  );

  const tagA = stats.perTag.find(t => t.tagId === 'tag-a');
  const tagB = stats.perTag.find(t => t.tagId === 'tag-b');
  const tagC = stats.perTag.find(t => t.tagId === 'tag-c');

  check('perTag: tag-a current = 3 (граница 7 дней не входит)', tagA?.current === 3, tagA);
  check('perTag: tag-a prevWeek = 3 (2 + граница 7 дней; граница 14 дней не входит)', tagA?.prevWeek === 3, tagA);
  check('perTag: tag-a monthAvg ≈ 11*7/30 (3+3+4 в месяце + граница 14д)',
    tagA !== undefined && approx(tagA.monthAvg, 11 * 7 / 30), tagA);
  check('perTag: тег только с прошлонедельными новостями присутствует с current=0',
    tagB?.current === 0 && tagB.prevWeek === 4 && tagB.monthAvg > 0, tagB);
  check('perTag: тег без новостей — все нули', tagC?.current === 0 && tagC.prevWeek === 0 && tagC.monthAvg === 0, tagC);
  check('perTag: порядок исходный списка тегов сохранён', stats.perTag.map(t => t.tagId).join(',') === 'tag-a,tag-b,tag-c');

  check('sentiment: текущая неделя pos/neg/neu = 2/1/0',
    stats.sentiment.positive === 2 && stats.sentiment.negative === 1 && stats.sentiment.neutral === 0,
    stats.sentiment);
  check('sentiment: прошлая неделя pos/neg/neu = 1/2/4',
    stats.sentiment.prevPositive === 1 && stats.sentiment.prevNegative === 2 && stats.sentiment.prevNeutral === 4,
    stats.sentiment);

  check('perDay: ровно 7 дней', stats.perDay.length === 7);
  check('perDay: сумма по дням = текущий тотал (3)',
    stats.perDay.reduce((s, d) => s + d.count, 0) === 3, stats.perDay);
  check('kpis: peakDay — день с максимумом новостей',
    stats.kpis.peakDay === stats.perDay.reduce((a, b) => (b.count > a.count ? b : a)).date && stats.kpis.peakDay !== null,
    stats.kpis);

  const curTotal = statsMod.statsCurrentTotal(stats);
  const prevTotal = statsMod.statsPrevTotal(stats);
  check('kpis: currentTotal=3, prevTotal=7', curTotal === 3 && prevTotal === 7, { curTotal, prevTotal });
  check('kpis: totalDeltaWeekPct ≈ (3-7)/7*100',
    stats.kpis.totalDeltaWeekPct !== null && approx(stats.kpis.totalDeltaWeekPct, (3 - 7) / 7 * 100),
    stats.kpis);
  // месяц: tag-a 11 шт + tag-b 4 шт = 15 → среднее 15*7/30 = 3.5
  check('kpis: totalDeltaMonthPct ≈ (3-3.5)/3.5*100',
    stats.kpis.totalDeltaMonthPct !== null && approx(stats.kpis.totalDeltaMonthPct, (3 - 3.5) / 3.5 * 100),
    stats.kpis);
  check('kpis: topTagId = tag-a (максимальный current)', stats.kpis.topTagId === 'tag-a', stats.kpis);

  // null-дельты: юзер без прошлонедельных новостей
  const statsEmpty = await statsMod.computeWeeklyStats(sqlite.query, [{ tagId: 'tag-c', tagName: 'Газ' }], NOW);
  check('kpis: нет новостей → дельты null, topTagId есть (нулевой тег)',
    statsEmpty.kpis.totalDeltaWeekPct === null && statsEmpty.kpis.totalDeltaMonthPct === null
    && statsEmpty.kpis.topTagId === 'tag-c' && statsEmpty.kpis.peakDay !== null,
    statsEmpty.kpis);
}

async function runNoLimitTests(): Promise<void> {
  console.log('\nТЗ-184.2 Отсутствие лимита (500 новостей на тег):');

  const rows: any[] = [];
  for (let i = 0; i < 500; i++) {
    // равномерно по текущей неделе, чтобы не было коллиз id
    const d = new Date(NOW.getTime() - (i % 6 + 0.5) * DAY);
    rows.push({
      id: `lim-${i}`, matched: ['tag-limit'], sentiment: i % 3 === 0 ? 'positive' : 'neutral',
      fetched: fmt(d),
    });
  }
  await seedNews(rows);

  const stats = await statsMod.computeWeeklyStats(sqlite.query, [{ tagId: 'tag-limit', tagName: 'Лимит' }], NOW);
  const tag = stats.perTag[0];
  check('500 новостей за неделю — счётчик ровно 500 (без LIMIT)', tag?.current === 500, tag);
  check('perDay по 500 новостям: сумма = 500', stats.perDay.reduce((s, d) => s + d.count, 0) === 500);
}

async function runRenderTests(): Promise<void> {
  console.log('\nТЗ-184.3 Рендер PNG:');

  const baseStats: WeeklyStats = {
    perTag: [
      { tagId: 't1', tagName: 'Сбербанк & <Россети>', current: 12, prevWeek: 8, monthAvg: 9.3 },
      { tagId: 't2', tagName: 'Нефть', current: 7, prevWeek: 9, monthAvg: 6.5 },
      { tagId: 't3', tagName: 'Газ"пром"', current: 0, prevWeek: 3, monthAvg: 2.1 },
    ],
    perDay: [
      { date: '2026-10-13', count: 2 }, { date: '2026-10-14', count: 5 },
      { date: '2026-10-15', count: 0 }, { date: '2026-10-16', count: 9 },
      { date: '2026-10-17', count: 3 }, { date: '2026-10-18', count: 1 },
      { date: '2026-10-19', count: 6 },
    ],
    sentiment: { positive: 10, negative: 4, neutral: 12, prevPositive: 8, prevNegative: 6, prevNeutral: 10 },
    kpis: { totalDeltaWeekPct: 11.1, totalDeltaMonthPct: -3.2, topTagId: 't1', peakDay: '2026-10-16' },
  };
  const baseContent = {
    period: '12 октября — 19 октября',
    tagSummaries: [],
    totalArticles: 26,
    sentimentBreakdown: { positive: 10, negative: 4, neutral: 12 },
    stats: baseStats,
  };

  const png = await chartMod.renderWeeklyChart(baseContent as any);
  check('рендер вернул Buffer', Buffer.isBuffer(png));
  check('PNG-сигнатура %PNG', !!png && png.slice(1, 4).toString() === 'PNG', png?.slice(0, 8));
  if (png) {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(png).metadata();
    check('retina 2x: ширина 2400 (логические 1200 × density 144)', meta.width === 2400, meta.width);
  }

  // XML-escape: названия с <, &, " не ломают SVG
  check('кривые названия тегов не падают (XML-escape)', !!png);

  // Все нули / пустые данные — не падает, Buffer или null
  const zeroStats: WeeklyStats = {
    perTag: [{ tagId: 'z', tagName: 'Ноль', current: 0, prevWeek: 0, monthAvg: 0 }],
    perDay: [
      { date: '2026-10-13', count: 0 }, { date: '2026-10-14', count: 0 },
      { date: '2026-10-15', count: 0 }, { date: '2026-10-16', count: 0 },
      { date: '2026-10-17', count: 0 }, { date: '2026-10-18', count: 0 },
      { date: '2026-10-19', count: 0 },
    ],
    sentiment: { positive: 0, negative: 0, neutral: 0, prevPositive: 0, prevNegative: 0, prevNeutral: 0 },
    kpis: { totalDeltaWeekPct: null, totalDeltaMonthPct: null, topTagId: 'z', peakDay: '2026-10-13' },
  };
  let zeroResult: Buffer | null = null;
  let zeroThrew = false;
  try {
    zeroResult = await chartMod.renderWeeklyChart({ ...baseContent, stats: zeroStats } as any);
  } catch { zeroThrew = true; }
  check('все нули — не падает', !zeroThrew);
  check('все нули — валидный PNG или null (деградация)', zeroResult === null || zeroResult.slice(1, 4).toString() === 'PNG');

  const noStats = await chartMod.renderWeeklyChart({ ...baseContent, stats: null } as any);
  check('stats=null → null (без картинки)', noStats === null);
}

async function runDegradationTests(): Promise<void> {
  console.log('\nТЗ-184.4 Деградация доставки:');

  // sendTelegramPhoto отвергнут Telegram API → false + warning, без throw.
  // Тот же axios-инстанс, что у telegram.ts — подменяем post.
  process.env.TELEGRAM_BOT_TOKEN = 'test-token-1234567890';
  const axios = (await import('axios')).default;
  const origPost = axios.post;
  let photoCalls = 0;
  (axios as any).post = async (url: string) => {
    if (String(url).includes('/sendPhoto')) {
      photoCalls++;
      const err: any = new Error('Request failed');
      err.response = { status: 400, data: { error_code: 400, description: 'wrong file identifier' } };
      throw err;
    }
    return { data: { ok: true } };
  };

  try {
    const telegram = await import('../services/telegram');
    let warned = false;
    const origWarn = console.warn;
    console.warn = () => { warned = true; };
    let threw = false;
    let result: boolean | null = null;
    try {
      result = await telegram.sendTelegramPhoto('424242', Buffer.from('fake-png'), 'caption');
    } catch { threw = true; }
    console.warn = origWarn;

    check('sendPhoto отвергнут → false, не бросает', result === false && !threw, { result, threw });
    check('в логе warning', warned);
    check('запрос дошёл до axios.post (multipart)', photoCalls === 1, photoCalls);

    // Форматтеры при stats=null — старые счётчики (текст уходит как раньше)
    const contentNoStats: any = {
      period: '12 октября — 19 октября',
      tagSummaries: [{
        tagId: 't1', tagName: 'Сбербанк',
        articles: [
          { title: 'A', summary: '', source: 's', url: 'https://x', publishedAt: NOW, sentiment: 'positive' },
          { title: 'B', summary: '', source: 's', url: 'https://x', publishedAt: NOW, sentiment: 'neutral' },
        ],
      }],
      totalArticles: 2,
      sentimentBreakdown: { positive: 1, negative: 0, neutral: 1 },
      stats: null,
    };
    const text = fmtMod.formatWeeklyReportTelegram(contentNoStats);
    check('текстовый отчёт при stats=null: fallback-счётчики (Всего: 2, тег — 2)',
      text.includes('Всего новостей: 2') && text.includes('Сбербанк — 2'), text.slice(0, 160));
    check('caption-форматтер при stats=null → null (фото не шлём)',
      fmtMod.formatWeeklyReportChartCaption(contentNoStats) === null);
  } finally {
    (axios as any).post = origPost;
  }
}

async function main(): Promise<void> {
  process.env.SQLITE_FILE = path.join(os.tmpdir(), `weekly-report-test-${Date.now()}.db`);
  sqlite = await import('../config/db-sqlite');
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  // Таблица портфеля нужна только билдеру контента; агрегаты трогают только news.
  await sqlite.query(
    `CREATE TABLE IF NOT EXISTS portfolios (
       user_id TEXT, tag_id TEXT, tag_name TEXT, is_frozen BOOLEAN DEFAULT FALSE, created_at TEXT
     )`, []);

  statsMod = await import('../services/notifications/weeklyStats');
  chartMod = await import('../services/notifications/weeklyChart');
  fmtMod = await import('../services/notifications/formatters');

  await runAggregateTests();
  await runNoLimitTests();
  await runRenderTests();
  await runDegradationTests();

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  fs.rmSync(process.env.SQLITE_FILE, { force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
