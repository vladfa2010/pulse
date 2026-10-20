/**
 * PULSE — Weekly Report: агрегированная статистика (ТЗ-184).
 *
 * Отдельные COUNT-запросы БЕЗ лимита: точные числа при любом объёме новостей.
 * Окна сравнения (по конвенции GREATEST(fetched_at, published_at), как в
 * сортировке отчёта):
 *   - текущая неделя:  последние 7 дней
 *   - прошлая неделя:  предыдущие 7 дней
 *   - месяц:           последние 30 дней, monthAvg = month_total/30*7
 *
 * Запросы принимают инжектируемый QueryFn (см. seoRebuild.ts) — production
 * передаёт query из config/db, тесты — sqlite.query без поднятия PG.
 * Postgres — приоритет (прод); SQLite-вариант — по аналогии с существующими
 * USE_SQLITE ветками (json_each вместо unnest, scalar max вместо GREATEST).
 */

import { query } from '../../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export type WeeklyQueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

export interface WeeklyStatsTagRow {
  tagId: string;
  tagName: string;
  current: number;
  prevWeek: number;
  monthAvg: number;   // среднее число новостей за неделю за последние 30 дней
}

export interface WeeklyStatsDayRow {
  date: string;       // YYYY-MM-DD
  count: number;
}

export interface WeeklyStats {
  perTag: WeeklyStatsTagRow[];
  perDay: WeeklyStatsDayRow[];      // ровно 7 дней, от текущей недели
  sentiment: {
    positive: number; negative: number; neutral: number;         // текущая неделя
    prevPositive: number; prevNegative: number; prevNeutral: number; // прошлая
  };
  kpis: {
    totalDeltaWeekPct: number | null;   // null если прошлая неделя = 0
    totalDeltaMonthPct: number | null;  // null если месячное среднее = 0
    topTagId: string | null;            // максимальный current (tie → prevWeek)
    peakDay: string | null;             // день с максимумом новостей
  };
}

export interface WeeklyStatsTagRef {
  tagId: string;
  tagName: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toIso(d: Date): string {
  return d.toISOString();
}

// SQLite хранит даты как 'YYYY-MM-DD HH:MM:SS' (datetime('now')) — пороги
// приводим к тому же текстовому формату, чтобы границы окон сравнивались
// лексикографически корректно (' ' и 'T' на одной позиции не эквивалентны).
function toSqlite(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function toDb(d: Date): string {
  return USE_SQLITE ? toSqlite(d) : toIso(d);
}

/** Сумма текущей недели по тональности = «всего новостей» по тегам юзера */
export function statsCurrentTotal(stats: WeeklyStats): number {
  const { positive, negative, neutral } = stats.sentiment;
  return positive + negative + neutral;
}

/** Сумма прошлой недели по тональности */
export function statsPrevTotal(stats: WeeklyStats): number {
  const { prevPositive, prevNegative, prevNeutral } = stats.sentiment;
  return prevPositive + prevNegative + prevNeutral;
}

/**
 * Агрегаты по активным тегам пользователя.
 * Теги без новостей в текущей неделе, но с новостями в прошлой/месяце —
 * включаются (current=0): юзер видит «у тебя пропал поток по X».
 */
export async function computeWeeklyStats(
  q: WeeklyQueryFn,
  tags: WeeklyStatsTagRef[],
  now: Date = new Date()
): Promise<WeeklyStats> {
  const tagIds = tags.map(t => t.tagId);
  const tagNames: Record<string, string> = {};
  for (const t of tags) tagNames[t.tagId] = t.tagName;

  const currentStart = new Date(now.getTime() - 7 * DAY_MS);
  const prevStart = new Date(now.getTime() - 14 * DAY_MS);
  const monthStart = new Date(now.getTime() - 30 * DAY_MS);

  const [perTagRows, perDayRows, sentimentRows] = await Promise.all([
    queryPerTag(q, tagIds, currentStart, prevStart, monthStart),
    queryPerDay(q, tagIds, currentStart),
    querySentiment(q, tagIds, currentStart, prevStart, monthStart),
  ]);

  // perTag: только теги юзера; нет новостей за 30 дней → строка отсутствует → current=0
  const perTagMap = new Map<string, { current: number; prevWeek: number; monthTotal: number }>();
  for (const r of perTagRows.rows) {
    perTagMap.set(r.tag, {
      current: Number(r.current) || 0,
      prevWeek: Number(r.prev_week) || 0,
      monthTotal: Number(r.month_total) || 0,
    });
  }
  const perTag: WeeklyStatsTagRow[] = tags.map(t => {
    const agg = perTagMap.get(t.tagId);
    return {
      tagId: t.tagId,
      tagName: t.tagName,
      current: agg?.current ?? 0,
      prevWeek: agg?.prevWeek ?? 0,
      monthAvg: agg ? (agg.monthTotal / 30) * 7 : 0,
    };
  });

  // perDay: ровно 7 дней текущей недели, пустые дни — 0
  const countsByDay = new Map<string, number>();
  for (const r of perDayRows.rows) {
    countsByDay.set(r.day, Number(r.cnt) || 0);
  }
  const perDay: WeeklyStatsDayRow[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(currentStart.getTime() + (i + 1) * DAY_MS);
    const key = d.toISOString().slice(0, 10);
    perDay.push({ date: key, count: countsByDay.get(key) ?? 0 });
  }

  // sentiment: текущая + прошлая неделя
  const sentiment = {
    positive: 0, negative: 0, neutral: 0,
    prevPositive: 0, prevNegative: 0, prevNeutral: 0,
  };
  let monthTotalAll = 0;
  for (const r of sentimentRows.rows) {
    const s = r.sentiment === 'positive' ? 'positive' : r.sentiment === 'negative' ? 'negative' : 'neutral';
    const cur = Number(r.current_cnt) || 0;
    const prev = Number(r.prev_cnt) || 0;
    sentiment[s] += cur;
    (sentiment as any)['prev' + s[0].toUpperCase() + s.slice(1)] += prev;
    monthTotalAll += Number(r.month_cnt) || 0;
  }

  // kpis
  const currentTotal = statsCurrentTotal({ sentiment } as WeeklyStats);
  const prevTotal = statsPrevTotal({ sentiment } as WeeklyStats);
  const monthAvgTotal = (monthTotalAll / 30) * 7;

  const sorted = [...perTag].sort((a, b) =>
    b.current - a.current || b.prevWeek - a.prevWeek || a.tagName.localeCompare(b.tagName)
  );
  const topTagId = sorted.length > 0 ? sorted[0].tagId : null;

  let peakDay: string | null = null;
  let peakCount = -1;
  for (const d of perDay) {
    if (d.count > peakCount) {
      peakCount = d.count;
      peakDay = d.date;
    }
  }

  return {
    perTag,
    perDay,
    sentiment,
    kpis: {
      totalDeltaWeekPct: prevTotal > 0 ? ((currentTotal - prevTotal) / prevTotal) * 100 : null,
      totalDeltaMonthPct: monthAvgTotal > 0 ? ((currentTotal - monthAvgTotal) / monthAvgTotal) * 100 : null,
      topTagId,
      peakDay,
    },
  };
}

/** Обёртка с дефолтным query из config/db (production-путь) */
export async function computeWeeklyStatsForTags(
  tags: WeeklyStatsTagRef[],
  now?: Date
): Promise<WeeklyStats> {
  return computeWeeklyStats(query, tags, now);
}

// ── ТЗ-191: live-режим «Текущая неделя» (календарная неделя, будни-к-будням) ──

// МСК = UTC+3 фиксированно (DST отменён в 2014) — та же конвенция, что в services/calendar.ts
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Понедельник 00:00 Europe/Moscow текущей недели как UTC-инстанс.
 * Привязка снапшота к календарной неделе (ТЗ-191 решение 5).
 */
export function weekStartMsk(now: Date = new Date()): Date {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const dow = msk.getUTCDay(); // 0=вс .. 6=сб
  const shift = dow === 0 ? 6 : dow - 1;
  const monday = new Date(msk.getTime() - shift * DAY_MS);
  monday.setUTCHours(0, 0, 0, 0);
  return new Date(monday.getTime() - MSK_OFFSET_MS);
}

/** YYYY-MM-DD понедельника текущей недели по МСК (значение колонки week_start) */
export function weekStartMskDate(now: Date = new Date()): string {
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const dow = msk.getUTCDay(); // 0=вс .. 6=сб
  const shift = dow === 0 ? 6 : dow - 1;
  const monday = new Date(msk.getTime() - shift * DAY_MS);
  monday.setUTCHours(0, 0, 0, 0);
  // UTC-геттеры от сдвинутой даты = календарная дата по МСК
  return monday.toISOString().slice(0, 10);
}

/** Прошедшие будние дни текущей недели: пн=1 … сб=6, воскресенье — тоже 6 */
export function elapsedWeekdays(now: Date = new Date()): number {
  const dow = new Date(now.getTime() + MSK_OFFSET_MS).getUTCDay();
  return dow === 0 ? 6 : dow;
}

export interface LiveWeeklyStats extends WeeklyStats {
  /** сколько будних дней текущей недели уже прошло (длина perDay) */
  elapsedDays: number;
}

/**
 * Агрегаты live-режима: окна по КАЛЕНДАРНОЙ неделе, а не скользящие 7 дней.
 * Сравнение будни-к-будням (ТЗ-191 решение 8): «прошлая неделя» обрезана по тем
 * же дням недели (среда → пн–ср прошлой недели), поэтому процентные дельты
 * на неполной неделе не считаем — только абсолютные числа (tempo).
 * monthAvg считаем по прежнему скользящему 30-дневному окну (контекст без дельт).
 */
export async function computeLiveWeeklyStats(
  q: WeeklyQueryFn,
  tags: WeeklyStatsTagRef[],
  now: Date = new Date()
): Promise<LiveWeeklyStats> {
  const weekStart = weekStartMsk(now);
  const prevStart = new Date(weekStart.getTime() - 7 * DAY_MS);
  const prevEnd = new Date(now.getTime() - 7 * DAY_MS); // те же будни прошлой недели
  const monthStart = new Date(now.getTime() - 30 * DAY_MS);
  const elapsed = elapsedWeekdays(now);

  const [perTagRows, perDayRows, sentimentRows] = await Promise.all([
    queryLivePerTag(q, tags.map(t => t.tagId), weekStart, prevStart, prevEnd, monthStart, now),
    queryLivePerDay(q, tags.map(t => t.tagId), weekStart, now),
    queryLiveSentiment(q, tags.map(t => t.tagId), weekStart, prevStart, prevEnd, monthStart, now),
  ]);

  const perTagMap = new Map<string, { current: number; prevWeek: number; monthTotal: number }>();
  for (const r of perTagRows.rows) {
    perTagMap.set(r.tag, {
      current: Number(r.current) || 0,
      prevWeek: Number(r.prev_week) || 0,
      monthTotal: Number(r.month_total) || 0,
    });
  }
  const perTag: WeeklyStatsTagRow[] = tags.map(t => {
    const agg = perTagMap.get(t.tagId);
    return {
      tagId: t.tagId,
      tagName: t.tagName,
      current: agg?.current ?? 0,
      prevWeek: agg?.prevWeek ?? 0,
      monthAvg: agg ? (agg.monthTotal / 30) * 7 : 0,
    };
  });

  // perDay: только прошедшие будни текущей недели, пустые дни — 0.
  // Бакеты — МСК-даты (окна недели по МСК; UTC-бакеты съезжали у границ суток).
  const countsByDay = new Map<string, number>();
  for (const r of perDayRows.rows) {
    countsByDay.set(r.day, Number(r.cnt) || 0);
  }
  const perDay: WeeklyStatsDayRow[] = [];
  for (let i = 0; i < elapsed; i++) {
    const key = new Date(weekStart.getTime() + i * DAY_MS + MSK_OFFSET_MS)
      .toISOString().slice(0, 10);
    perDay.push({ date: key, count: countsByDay.get(key) ?? 0 });
  }

  const sentiment = {
    positive: 0, negative: 0, neutral: 0,
    prevPositive: 0, prevNegative: 0, prevNeutral: 0,
  };
  let monthTotalAll = 0;
  for (const r of sentimentRows.rows) {
    const s = r.sentiment === 'positive' ? 'positive' : r.sentiment === 'negative' ? 'negative' : 'neutral';
    sentiment[s] += Number(r.current_cnt) || 0;
    (sentiment as any)['prev' + s[0].toUpperCase() + s.slice(1)] += Number(r.prev_cnt) || 0;
    monthTotalAll += Number(r.month_cnt) || 0;
  }

  const sorted = [...perTag].sort((a, b) =>
    b.current - a.current || b.prevWeek - a.prevWeek || a.tagName.localeCompare(b.tagName)
  );

  let peakDay: string | null = null;
  let peakCount = -1;
  for (const d of perDay) {
    if (d.count > peakCount) {
      peakCount = d.count;
      peakDay = d.date;
    }
  }

  return {
    perTag,
    perDay,
    sentiment,
    elapsedDays: elapsed,
    kpis: {
      // ТЗ-191: на неполной неделе процентные дельты не считаем (сравнение будни-к-будням — только tempo)
      totalDeltaWeekPct: null,
      totalDeltaMonthPct: null,
      topTagId: sorted.length > 0 ? sorted[0].tagId : null,
      peakDay,
    },
  };
}

async function queryLivePerTag(
  q: WeeklyQueryFn,
  tagIds: string[],
  weekStart: Date,
  prevStart: Date,
  prevEnd: Date,
  monthStart: Date,
  now: Date
) {
  if (USE_SQLITE) {
    const ph = tagIds.map(() => '?').join(',');
    return q(
      `SELECT je.value AS tag,
              SUM(CASE WHEN max(n.fetched_at, n.published_at) > ? AND max(n.fetched_at, n.published_at) <= ? THEN 1 ELSE 0 END) AS current,
              SUM(CASE WHEN max(n.fetched_at, n.published_at) > ? AND max(n.fetched_at, n.published_at) <= ? THEN 1 ELSE 0 END) AS prev_week,
              COUNT(*) AS month_total
       FROM news n, json_each(n.matched_tags) je
       WHERE je.value IN (${ph})
         AND max(n.fetched_at, n.published_at) > ?
       GROUP BY je.value`,
      [toDb(weekStart), toDb(now), toDb(prevStart), toDb(prevEnd), ...tagIds, toDb(monthStart)]
    );
  }
  return q(
    `SELECT u.tag,
            COUNT(*) FILTER (WHERE GREATEST(n.fetched_at, n.published_at) > $2
                             AND GREATEST(n.fetched_at, n.published_at) <= $6) AS current,
            COUNT(*) FILTER (WHERE GREATEST(n.fetched_at, n.published_at) > $3
                             AND GREATEST(n.fetched_at, n.published_at) <= $4) AS prev_week,
            COUNT(*) AS month_total
     FROM news n
     CROSS JOIN LATERAL unnest(n.matched_tags) AS u(tag)
     WHERE u.tag = ANY($1::text[])
       AND GREATEST(n.fetched_at, n.published_at) > $5
     GROUP BY u.tag`,
    [tagIds, toIso(weekStart), toIso(prevStart), toIso(prevEnd), toIso(monthStart), toIso(now)]
  );
}

async function queryLivePerDay(
  q: WeeklyQueryFn,
  tagIds: string[],
  weekStart: Date,
  now: Date
) {
  if (USE_SQLITE) {
    const ph = tagIds.map(() => '?').join(',');
    return q(
      `SELECT date(max(n.fetched_at, n.published_at), '+3 hours') AS day, COUNT(*) AS cnt
       FROM news n
       WHERE EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value IN (${ph}))
         AND max(n.fetched_at, n.published_at) > ?
         AND max(n.fetched_at, n.published_at) <= ?
       GROUP BY day`,
      [...tagIds, toDb(weekStart), toDb(now)]
    );
  }
  return q(
    `SELECT to_char(date_trunc('day', GREATEST(fetched_at, published_at) AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM-DD') AS day,
            COUNT(*) AS cnt
     FROM news
     WHERE matched_tags && $1::text[]
       AND GREATEST(fetched_at, published_at) > $2
       AND GREATEST(fetched_at, published_at) <= $3
     GROUP BY day`,
    [tagIds, toIso(weekStart), toIso(now)]
  );
}

async function queryLiveSentiment(
  q: WeeklyQueryFn,
  tagIds: string[],
  weekStart: Date,
  prevStart: Date,
  prevEnd: Date,
  monthStart: Date,
  now: Date
) {
  if (USE_SQLITE) {
    const ph = tagIds.map(() => '?').join(',');
    return q(
      `SELECT COALESCE(n.sentiment, 'neutral') AS sentiment,
              SUM(CASE WHEN max(n.fetched_at, n.published_at) > ? AND max(n.fetched_at, n.published_at) <= ? THEN 1 ELSE 0 END) AS current_cnt,
              SUM(CASE WHEN max(n.fetched_at, n.published_at) > ? AND max(n.fetched_at, n.published_at) <= ? THEN 1 ELSE 0 END) AS prev_cnt,
              COUNT(*) AS month_cnt
       FROM news n
       WHERE EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value IN (${ph}))
         AND max(n.fetched_at, n.published_at) > ?
       GROUP BY sentiment`,
      [toDb(weekStart), toDb(now), toDb(prevStart), toDb(prevEnd), ...tagIds, toDb(monthStart)]
    );
  }
  return q(
    `SELECT COALESCE(sentiment, 'neutral') AS sentiment,
            COUNT(*) FILTER (WHERE GREATEST(fetched_at, published_at) > $2
                             AND GREATEST(fetched_at, published_at) <= $6) AS current_cnt,
            COUNT(*) FILTER (WHERE GREATEST(fetched_at, published_at) > $3
                             AND GREATEST(fetched_at, published_at) <= $4) AS prev_cnt,
            COUNT(*) AS month_cnt
     FROM news
     WHERE matched_tags && $1::text[]
       AND GREATEST(fetched_at, published_at) > $5
     GROUP BY sentiment`,
    [tagIds, toIso(weekStart), toIso(prevStart), toIso(prevEnd), toIso(monthStart), toIso(now)]
  );
}

// ── SQL: Postgres приоритет, SQLite по аналогии ────────────────────────────

async function queryPerTag(
  q: WeeklyQueryFn,
  tagIds: string[],
  currentStart: Date,
  prevStart: Date,
  monthStart: Date
) {
  if (USE_SQLITE) {
    const ph = tagIds.map(() => '?').join(',');
    return q(
      `SELECT je.value AS tag,
              SUM(CASE WHEN max(n.fetched_at, n.published_at) > ? THEN 1 ELSE 0 END) AS current,
              SUM(CASE WHEN max(n.fetched_at, n.published_at) > ? AND max(n.fetched_at, n.published_at) <= ? THEN 1 ELSE 0 END) AS prev_week,
              COUNT(*) AS month_total
       FROM news n, json_each(n.matched_tags) je
       WHERE je.value IN (${ph})
         AND max(n.fetched_at, n.published_at) > ?
       GROUP BY je.value`,
      [toDb(currentStart), toDb(prevStart), toDb(currentStart), ...tagIds, toDb(monthStart)]
    );
  }
  return q(
    `SELECT u.tag,
            COUNT(*) FILTER (WHERE GREATEST(n.fetched_at, n.published_at) > $2) AS current,
            COUNT(*) FILTER (WHERE GREATEST(n.fetched_at, n.published_at) > $3
                             AND GREATEST(n.fetched_at, n.published_at) <= $2) AS prev_week,
            COUNT(*) AS month_total
     FROM news n
     CROSS JOIN LATERAL unnest(n.matched_tags) AS u(tag)
     WHERE u.tag = ANY($1::text[])
       AND GREATEST(n.fetched_at, n.published_at) > $4
     GROUP BY u.tag`,
    [tagIds, toIso(currentStart), toIso(prevStart), toIso(monthStart)]
  );
}

async function queryPerDay(
  q: WeeklyQueryFn,
  tagIds: string[],
  currentStart: Date
) {
  if (USE_SQLITE) {
    const ph = tagIds.map(() => '?').join(',');
    return q(
      `SELECT date(max(n.fetched_at, n.published_at)) AS day, COUNT(*) AS cnt
       FROM news n
       WHERE EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value IN (${ph}))
         AND max(n.fetched_at, n.published_at) > ?
       GROUP BY day`,
      [...tagIds, toDb(currentStart)]
    );
  }
  return q(
    `SELECT to_char(date_trunc('day', GREATEST(fetched_at, published_at)), 'YYYY-MM-DD') AS day,
            COUNT(*) AS cnt
     FROM news
     WHERE matched_tags && $1::text[]
       AND GREATEST(fetched_at, published_at) > $2
     GROUP BY day`,
    [tagIds, toIso(currentStart)]
  );
}

async function querySentiment(
  q: WeeklyQueryFn,
  tagIds: string[],
  currentStart: Date,
  prevStart: Date,
  monthStart: Date
) {
  if (USE_SQLITE) {
    const ph = tagIds.map(() => '?').join(',');
    return q(
      `SELECT COALESCE(n.sentiment, 'neutral') AS sentiment,
              SUM(CASE WHEN max(n.fetched_at, n.published_at) > ? THEN 1 ELSE 0 END) AS current_cnt,
              SUM(CASE WHEN max(n.fetched_at, n.published_at) > ? AND max(n.fetched_at, n.published_at) <= ? THEN 1 ELSE 0 END) AS prev_cnt,
              COUNT(*) AS month_cnt
       FROM news n
       WHERE EXISTS (SELECT 1 FROM json_each(n.matched_tags) je WHERE je.value IN (${ph}))
         AND max(n.fetched_at, n.published_at) > ?
       GROUP BY sentiment`,
      [toDb(currentStart), toDb(prevStart), toDb(currentStart), ...tagIds, toDb(monthStart)]
    );
  }
  return q(
    `SELECT COALESCE(sentiment, 'neutral') AS sentiment,
            COUNT(*) FILTER (WHERE GREATEST(fetched_at, published_at) > $2) AS current_cnt,
            COUNT(*) FILTER (WHERE GREATEST(fetched_at, published_at) > $3
                             AND GREATEST(fetched_at, published_at) <= $2) AS prev_cnt,
            COUNT(*) AS month_cnt
     FROM news
     WHERE matched_tags && $1::text[]
       AND GREATEST(fetched_at, published_at) > $4
     GROUP BY sentiment`,
    [tagIds, toIso(currentStart), toIso(prevStart), toIso(monthStart)]
  );
}
