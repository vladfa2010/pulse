/**
 * =============================================================================
 * PULSE — Sentiment Index Service (MVP)
 * =============================================================================
 *
 * Логика:
 *   - Индекс = кумулятивная сумма vote_value за текущий календарный день по МСК.
 *   - У каждого пользователя персональное 30-минутное окно после голоса.
 *   - IMOEX для MVP — mock/flat line; сессия 10:00–19:00 МСК.
 */

import { query } from '../config/db';
import { getImoex5minForDay, ImoexCandle, extendWithFlatLine } from './imoexAdapter';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const VOTE_COOLDOWN_MINUTES = 30;
const SBER_MOCK_VALUE = 300;
const IMOEX_CACHE_TTL_MS = 5 * 60 * 1000;

export interface MoscowDayBounds {
  dateStr: string;
  start: Date;
  end: Date;
}

export interface IndexPoint {
  time: string; // ISO
  value: number;
}

export interface ImoexData {
  current: number;
  sessionActive: boolean;
  sessionStart: string; // ISO
  sessionEnd: string; // ISO
  candles: ImoexCandle[];
}

/**
 * Возвращает границы текущего дня по московскому времени в UTC.
 */
export function getMoscowDayBounds(now: Date = new Date()): MoscowDayBounds {
  const mskOffset = 3 * 60 * 60 * 1000;
  const mskTime = new Date(now.getTime() + mskOffset);
  const y = mskTime.getUTCFullYear();
  const m = mskTime.getUTCMonth();
  const d = mskTime.getUTCDate();

  // Start of MSK day in UTC
  const start = new Date(Date.UTC(y, m, d) - mskOffset);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

  return { dateStr, start, end };
}

function formatPg(date: Date): string {
  return date.toISOString();
}

/**
 * Текущее значение индекса (сумма голосов за день).
 */
export async function getCurrentIndex(date: Date = new Date()): Promise<number> {
  const { start, end } = getMoscowDayBounds(date);
  const result = await query(
    `SELECT COALESCE(SUM(vote_value), 0) as idx FROM sentiment_votes WHERE created_at >= $1 AND created_at < $2`,
    [formatPg(start), formatPg(end)]
  );
  return parseInt(result.rows[0]?.idx || '0', 10);
}

/**
 * История индекса за день — точка старта + после каждого голоса.
 */
export async function getIndexHistory(date: Date = new Date()): Promise<IndexPoint[]> {
  const { start, end } = getMoscowDayBounds(date);
  const result = await query(
    `SELECT created_at, vote_value FROM sentiment_votes WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at ASC`,
    [formatPg(start), formatPg(end)]
  );

  const points: IndexPoint[] = [{ time: start.toISOString(), value: 0 }];
  let cumulative = 0;
  for (const row of result.rows) {
    cumulative += parseInt(row.vote_value, 10);
    points.push({ time: new Date(row.created_at).toISOString(), value: cumulative });
  }
  return points;
}

/**
 * Количество голосов за день.
 */
export async function getVotesCountToday(): Promise<number> {
  const { start, end } = getMoscowDayBounds();
  const result = await query(
    `SELECT COUNT(*) as c FROM sentiment_votes WHERE created_at >= $1 AND created_at < $2`,
    [formatPg(start), formatPg(end)]
  );
  return parseInt(result.rows[0]?.c || '0', 10);
}

/**
 * Получить или создать окно пользователя.
 */
export async function getUserWindow(userId: string) {
  const result = await query(`SELECT * FROM sentiment_user_windows WHERE user_id = $1`, [userId]);
  if (result.rows.length > 0) return result.rows[0];

  await query(
    `INSERT INTO sentiment_user_windows (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  );
  const again = await query(`SELECT * FROM sentiment_user_windows WHERE user_id = $1`, [userId]);
  return again.rows[0];
}

/**
 * Проверить, может ли пользователь голосовать.
 */
export function canVote(windowRow: any): boolean {
  if (!windowRow || !windowRow.next_vote_at) return true;
  return new Date(windowRow.next_vote_at).getTime() <= Date.now();
}

/**
 * Оставшееся время до следующего голоса в секундах.
 */
export function secondsUntilNextVote(windowRow: any): number {
  if (!windowRow || !windowRow.next_vote_at) return 0;
  const diff = new Date(windowRow.next_vote_at).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 1000));
}

/**
 * Записать голос и обновить окно пользователя.
 */
export async function recordVote(userId: string, value: number): Promise<{
  newIndex: number;
  nextVoteAt: Date;
  secondsUntilNext: number;
  sync: boolean;
}> {
  if (![-1, 0, 1].includes(value)) {
    throw new Error('Invalid vote value');
  }

  const windowRow = await getUserWindow(userId);
  if (!canVote(windowRow)) {
    throw new Error('Vote cooldown');
  }

  const now = new Date();
  const beforeIndex = await getCurrentIndex(now);
  const afterIndex = beforeIndex + value;

  // Тикеры из портфеля на момент голоса (для будущих метрик)
  const portfolio = await query(`SELECT tag_id FROM portfolios WHERE user_id = $1`, [userId]);
  const tickers = portfolio.rows.map(r => r.tag_id);

  await query(
    `INSERT INTO sentiment_votes (user_id, vote_value, created_at, tickers, index_at_vote)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, value, formatPg(now), JSON.stringify(tickers), beforeIndex]
  );

  const nextVoteAt = new Date(now.getTime() + VOTE_COOLDOWN_MINUTES * 60 * 1000);
  const sync = Math.sign(value) === Math.sign(afterIndex);

  await query(
    `UPDATE sentiment_user_windows
     SET last_vote_at = $1,
         next_vote_at = $2,
         vote_count_today = vote_count_today + 1,
         total_votes_all_time = total_votes_all_time + 1,
         total_votes_count = total_votes_count + 1,
         sync_count = sync_count + $3,
         impact_sum = impact_sum + $4,
         updated_at = $5
     WHERE user_id = $6`,
    [formatPg(now), formatPg(nextVoteAt), sync ? 1 : 0, value, formatPg(now), userId]
  );

  return {
    newIndex: afterIndex,
    nextVoteAt,
    secondsUntilNext: VOTE_COOLDOWN_MINUTES * 60,
    sync,
  };
}

/**
 * Общие метрики сообщества.
 */
export async function getCommunityMetrics(): Promise<{
  onlineNow: number;
  votesToday: number;
  distribution: { positive: number; neutral: number; negative: number };
}> {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const onlineResult = await query(
    `SELECT COUNT(*) as c FROM sentiment_user_windows WHERE next_vote_at > $1`,
    [formatPg(now)]
  );
  const votesToday = await getVotesCountToday();

  const distResult = await query(
    `SELECT vote_value, COUNT(*) as c FROM sentiment_votes WHERE created_at >= $1 GROUP BY vote_value`,
    [formatPg(hourAgo)]
  );

  const distribution = { positive: 0, neutral: 0, negative: 0 };
  for (const row of distResult.rows) {
    const v = parseInt(row.vote_value, 10);
    const count = parseInt(row.c, 10);
    if (v === 1) distribution.positive = count;
    else if (v === 0) distribution.neutral = count;
    else if (v === -1) distribution.negative = count;
  }

  return {
    onlineNow: parseInt(onlineResult.rows[0]?.c || '0', 10),
    votesToday,
    distribution,
  };
}

async function getCachedImoex(dateStr: string): Promise<{ candles: ImoexCandle[]; updatedAt: Date | null }> {
  const result = await query(`SELECT imoex_candles, imoex_updated_at FROM sentiment_index_cache WHERE date = $1`, [dateStr]);
  if (result.rows.length === 0) return { candles: [], updatedAt: null };
  let candles: ImoexCandle[] = result.rows[0].imoex_candles || [];
  if (typeof candles === 'string') {
    try { candles = JSON.parse(candles); } catch { candles = []; }
  }
  return { candles, updatedAt: result.rows[0].imoex_updated_at ? new Date(result.rows[0].imoex_updated_at) : null };
}

async function saveImoexCache(dateStr: string, candles: ImoexCandle[]): Promise<void> {
  await query(
    `INSERT INTO sentiment_index_cache (date, imoex_candles, imoex_updated_at, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (date) DO UPDATE
       SET imoex_candles = EXCLUDED.imoex_candles,
           imoex_updated_at = EXCLUDED.imoex_updated_at,
           updated_at = EXCLUDED.updated_at`,
    [dateStr, JSON.stringify(candles), formatPg(new Date()), formatPg(new Date())]
  );
}

export async function refreshImoexCache(date: Date = new Date()): Promise<ImoexCandle[]> {
  const { dateStr } = getMoscowDayBounds(date);
  const candles = await getImoex5minForDay(date);
  if (candles.length > 0) {
    await saveImoexCache(dateStr, candles);
  }
  return candles;
}

/**
 * IMOEX: реальные 5-минутные свечи из MOEX ISS + flat line за пределами сессии.
 * Если данных нет или кэш протух — пытаемся обновить. Fallback — mock.
 */
export async function getImoexData(now: Date = new Date()): Promise<ImoexData> {
  const { dateStr } = getMoscowDayBounds(now);
  const sessionStart = new Date(`${dateStr}T10:00:00+03:00`);
  const sessionEnd = new Date(`${dateStr}T19:00:00+03:00`);
  const sessionActive = now >= sessionStart && now < sessionEnd;

  let { candles, updatedAt } = await getCachedImoex(dateStr);
  if (!updatedAt || now.getTime() - updatedAt.getTime() > IMOEX_CACHE_TTL_MS) {
    try {
      candles = await refreshImoexCache(now);
    } catch (err: any) {
      console.error('[IMOEX] refresh error:', err.message);
    }
  }

  if (candles.length === 0) {
    // Если сегодня ещё не торговалось (ночь/выходные) — подтягиваем закрытие предыдущего дня
    const prevDate = new Date(getMoscowDayBounds(now).start.getTime() - 24 * 60 * 60 * 1000);
    const { dateStr: prevDateStr } = getMoscowDayBounds(prevDate);
    const prevCached = await getCachedImoex(prevDateStr);

    if (prevCached.candles.length > 0) {
      const lastClose = prevCached.candles[prevCached.candles.length - 1].close;
      const { start, end } = getMoscowDayBounds(now);
      const flat = extendWithFlatLine(
        [{ time: start.toISOString(), open: lastClose, high: lastClose, low: lastClose, close: lastClose }],
        start,
        end
      );
      return {
        current: lastClose,
        sessionActive,
        sessionStart: sessionStart.toISOString(),
        sessionEnd: sessionEnd.toISOString(),
        candles: flat,
      };
    }

    return {
      current: SBER_MOCK_VALUE,
      sessionActive,
      sessionStart: sessionStart.toISOString(),
      sessionEnd: sessionEnd.toISOString(),
      candles: [],
    };
  }

  // Текущее значение — последний close, независимо от активности сессии (flat line)
  const current = candles[candles.length - 1].close;
  return {
    current,
    sessionActive,
    sessionStart: sessionStart.toISOString(),
    sessionEnd: sessionEnd.toISOString(),
    candles,
  };
}

/**
 * История голосов пользователя (для фронта, этап 1 — последние 20).
 */
export async function getUserVoteHistory(userId: string, limit: number = 20) {
  const result = await query(
    `SELECT created_at, vote_value, index_at_vote FROM sentiment_votes
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map(r => ({
    time: new Date(r.created_at).toISOString(),
    value: parseInt(r.vote_value, 10),
    indexAfter: parseInt(r.index_at_vote, 10) + parseInt(r.vote_value, 10),
  }));
}

/**
 * Ежедневный сброс vote_count_today и обновление streak.
 * Вызывается из cron в 00:00 МСК.
 */
export async function resetDailyWindows(): Promise<void> {
  const { dateStr } = getMoscowDayBounds();
  const yesterday = new Date(getMoscowDayBounds().start.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  // Пользователи, голосовавшие вчера
  const votedYesterday = await query(
    `SELECT DISTINCT user_id FROM sentiment_votes WHERE created_at >= $1 AND created_at < $2`,
    [formatPg(yesterday), formatPg(getMoscowDayBounds().start)]
  );
  const votedSet = new Set(votedYesterday.rows.map(r => r.user_id));

  const allWindows = await query(`SELECT user_id, last_streak_date, streak_days FROM sentiment_user_windows`);
  for (const row of allWindows.rows) {
    const voted = votedSet.has(row.user_id);
    let newStreak = 0;
    if (voted) {
      // Если уже был streak за вчера — продолжаем, иначе с 1
      const hadYesterday = row.last_streak_date && row.last_streak_date.toString().slice(0, 10) === yesterdayStr;
      newStreak = hadYesterday ? (row.streak_days || 0) + 1 : 1;
    }
    await query(
      `UPDATE sentiment_user_windows
       SET vote_count_today = 0,
           streak_days = $1,
           max_streak_days = GREATEST(max_streak_days, $1),
           last_streak_date = $2,
           updated_at = $3
       WHERE user_id = $4`,
      [newStreak, dateStr, formatPg(new Date()), row.user_id]
    );
  }
}
