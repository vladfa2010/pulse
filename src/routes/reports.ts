/**
 * =============================================================================
 * PULSE — Еженедельный отчёт как страница платформы: API (ТЗ-191, Задача 3)
 * =============================================================================
 *
 * Префикс /api/reports (монтируется после app.use(apiLimiter) — лимит
 * применяется автоматически). Авторизация — своя, эндпоинтная:
 *
 *   - сессия: JWT (optionalAuth разбирает токен, НЕ бросает 401) + СВЕЖИЙ
 *     is_blocked из users (authMiddleware это не делает — конвенция ТЗ-120/183);
 *   - magic-link ?k=: только архивные отчёты, SHA-256 + привязка к отчёту +
 *     7 дней; live-режим — сессия only.
 *
 * Порядок проверок архива (важно): is_blocked → владелец/админ → чужой 404
 * (не палим чужие id). Magic-link невалиден/протух → 401.
 *
 * Графики: tag_id только ВЫБИРАЕТ тег внутри payload, символ инструмента
 * строго из данных тега (SSRF-гард — пользовательский ввод в маркет-запрос
 * не попадает). Деградация: 200 {chart: null} / {chart: null, reason}.
 */

import { Router } from 'express';
import { query } from '../config/db';
import { optionalAuth } from '../middleware/optionalAuth';
import type { AuthRequest } from '../middleware/auth';
import * as marketRouter from '../services/market/marketRouter';
import type { MarketCandle } from '../services/market/utils';
import {
  micTimezone,
  dateInTz,
  addDays,
} from '../services/market/exchangeTimezones';
import {
  isCalendarEmpty,
  getMskDateString,
  addDays as addDaysCal,
} from '../services/calendar';
import { getEntitlement } from '../services/notifications/entitlement';
import { buildWeeklyReportContent } from '../services/notifications/weeklyReportContent';
import {
  computeLiveWeeklyStats,
  statsCurrentTotal,
  statsPrevTotal,
  weekStartMsk,
  weekStartMskDate,
  elapsedWeekdays,
} from '../services/notifications/weeklyStats';
import {
  getWeeklyReportSnapshot,
  getCurrentWeekSnapshot,
  listWeeklyReports,
  getTagEventsFromSnapshot,
  validateReportAccessToken,
  WeeklyReportSnapshot,
  WeeklyTagEvent,
} from '../services/notifications/weeklyReportSnapshot';

const router = Router();

// JWT разбираем опционально: сессия ИЛИ magic-link (?k=), решение — в хендлерах
router.use(optionalAuth);

// ── Кэши (in-memory, конвенция cacheGet/cacheSet из marketPublic.ts) ───────

const LIVE_CACHE_TTL_MS = 5 * 60 * 1000;        // live-контент/chart: 5 мин
const ARCHIVE_CHART_CACHE_TTL_MS = 24 * 3600 * 1000; // архив: неделя закрыта
const AHEAD_CACHE_TTL_MS = 60 * 60 * 1000;      // «впереди»: 1 ч

const liveCache = new Map<string, { at: number; payload: any }>();
const archiveChartCache = new Map<string, { at: number; payload: any }>();
const liveChartCache = new Map<string, { at: number; payload: any }>();
const aheadCache = new Map<string, { at: number; payload: any }>();

function cacheGet(store: Map<string, { at: number; payload: any }>, key: string, ttl: number): any | null {
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.payload;
  return null;
}

function cacheSet(store: Map<string, { at: number; payload: any }>, key: string, payload: any): void {
  if (store.size > 2000) store.clear(); // грубая эвикция: данных немного
  store.set(key, { at: Date.now(), payload });
}

// ── Доступ ──────────────────────────────────────────────────────────────────

interface SessionAccess { ok: true; userId: string; isAdmin: boolean }
type SessionAccessResult = SessionAccess | { ok: false; status: number };

/**
 * Сессионный доступ (live-эндпоинты + база архивной проверки).
 * Порядок: нет сессии → 401; свежий is_blocked → 403.
 */
async function checkSessionAccess(req: AuthRequest): Promise<SessionAccessResult> {
  const userId = req.user?.userId;
  if (!userId) return { ok: false, status: 401 };
  const result = await query(`SELECT is_blocked, is_admin FROM users WHERE id = $1`, [userId]);
  if (result.rows.length === 0) return { ok: false, status: 401 };
  if (result.rows[0].is_blocked) return { ok: false, status: 403 };
  return { ok: true, userId, isAdmin: !!result.rows[0].is_admin };
}

interface ArchiveAccess { ok: true; snapshot: WeeklyReportSnapshot; isAdmin: boolean; isOwner: boolean }
type ArchiveAccessResult = ArchiveAccess | { ok: false; status: number };

/**
 * Доступ к архивному отчёту: сессия (is_blocked → владелец/админ → чужой 404)
 * или валидный magic-link ?k= этого отчёта (иначе 401).
 */
async function checkArchiveAccess(req: AuthRequest, reportId: string): Promise<ArchiveAccessResult> {
  const k = typeof req.query.k === 'string' ? req.query.k : null;

  if (k) {
    const valid = await validateReportAccessToken(reportId, k);
    if (!valid) return { ok: false, status: 401 };
    const snapshot = await getWeeklyReportSnapshot(reportId);
    if (!snapshot) return { ok: false, status: 404 };
    return { ok: true, snapshot, isAdmin: false, isOwner: false };
  }

  const session = await checkSessionAccess(req);
  if (!session.ok) return session;
  const snapshot = await getWeeklyReportSnapshot(reportId);
  if (!snapshot) return { ok: false, status: 404 };
  if (snapshot.userId !== session.userId && !session.isAdmin) {
    return { ok: false, status: 404 }; // чужой id не палим
  }
  return { ok: true, snapshot, isAdmin: session.isAdmin, isOwner: snapshot.userId === session.userId };
}

// ── Графики (SSRF-гард: символ строго из тега, tag_id только выбирает тег) ──

interface TagInstrument {
  ticker: string;
  mic: string;
}

/**
 * Инструмент тега из user_defined_tags (конвенция TZ-3, как buildInstrumentsForTags).
 * Вызывается ТОЛЬКО для tag_id, найденного внутри payload — запросный параметр
 * в маркет-запрос не попадает никогда.
 */
async function resolveTagInstrument(tagId: string): Promise<TagInstrument | null> {
  let result;
  try {
    result = await query(
      `SELECT enriched_data FROM user_defined_tags WHERE tag_id = $1`,
      [tagId]
    );
  } catch (err: any) {
    // таблица/данные недоступны — деградация как «тег без инструмента»
    console.warn(`[Reports] resolveTagInstrument failed for ${tagId}:`, err.message);
    return null;
  }
  if (result.rows.length === 0) return null;
  let data = result.rows[0].enriched_data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }
  if (!data || typeof data !== 'object') return null;
  const symbol = data.symbol || null;
  const ticker = data.ticker || null;
  const mic = data.mic || null;
  if (symbol) {
    const parts = String(symbol).split('@');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { ticker: parts[0], mic: parts[1] };
    }
    return null;
  }
  if (ticker && mic) return { ticker: String(ticker), mic: String(mic) };
  return null;
}

const FINAM_DEGRADE_CODES = new Set([
  'finam_no_key',
  'finam_maintenance',
  'finam_auth_failed',
  'finam_rate_limited',
]);

interface WeekChartParams {
  store: Map<string, { at: number; payload: any }>;
  cacheKey: string;
  ttl: number;
  tagId: string;
  tagName: string;
  /** префикс синтетических id маркеров (клик → якорь новости по url) */
  markerIdPrefix: string;
  events: WeeklyTagEvent[];
  /** понедельник недели 00:00 МСК как UTC-инстанс */
  weekStartUtc: Date;
  /** для live: правая граница = сегодня; для архива — вся неделя (d0+6) */
  liveEnd?: Date;
}

/**
 * Недельный M5-график одного тега — механика по образцу GET /api/market/cascade-chart
 * (ТЗ-97): один вызов getIntraday5minRange, таймзона биржи, деградация 200.
 */
async function buildWeekChart(params: WeekChartParams): Promise<{
  chart: any;
  news_markers: any[];
  week_change_pct: number | null;
  reason?: string;
}> {
  const { tagId, tagName, events, weekStartUtc, liveEnd } = params;

  const cached = cacheGet(params.store, params.cacheKey, params.ttl);
  if (cached) return cached;

  const empty = (extra: any = {}) => {
    const payload = { chart: null, news_markers: [], week_change_pct: null, ...extra };
    cacheSet(params.store, params.cacheKey, payload);
    return payload;
  };

  const instrument = await resolveTagInstrument(tagId);
  if (!instrument) return empty();

  const tz = micTimezone(instrument.mic);
  const d0 = dateInTz(weekStartUtc.toISOString(), tz);
  const d1 = liveEnd ? dateInTz(liveEnd.toISOString(), tz) : addDays(d0, 6);

  let candles: MarketCandle[];
  try {
    candles = (await marketRouter.getIntraday5minRange(instrument.mic, instrument.ticker, d0, d1)).candles;
  } catch (err: any) {
    if (err.code === 'finam_not_found') return empty();
    if (FINAM_DEGRADE_CODES.has(err.code)) {
      console.warn(`[Reports] chart market unavailable: ${err.code}`);
      return empty({ reason: 'market_unavailable' });
    }
    throw err;
  }
  if (candles.length === 0) return empty();

  const exchanges = await marketRouter.getExchanges();
  const exchangeName = exchanges.find(
    (e) => e.mic.toUpperCase() === instrument.mic.toUpperCase()
  )?.name || instrument.mic;

  const first = candles[0];
  const last = candles[candles.length - 1];
  const weekChangePct = first.open > 0
    ? Math.round(((last.close - first.open) / first.open) * 10000) / 100
    : null;

  const chart = {
    tag_id: tagId,
    tag_name: tagName,
    symbol: `${instrument.ticker}@${instrument.mic}`,
    date: d0,
    shifted: false,
    timezone: tz,
    exchange_mic: instrument.mic,
    exchange_name: exchangeName,
    times: candles.map((c) => c.time),
    ohlc: candles.map((c) => [c.open, c.close, c.low, c.high]),
    volumes: candles.map((c) => c.volume ?? 0),
    dates: [...new Set(candles.map((c) => dateInTz(c.time, tz)))],
    covered_until: last.time,
  };

  const payload = {
    chart,
    // форма маркеров — как у cascade-chart (ТЗ-97), id синтетические (в payload
    // снапшота id новостей не храним — клик ведёт по url)
    news_markers: events.map((e, i) => ({
      id: `${params.markerIdPrefix}:${i}`,
      url: e.url,
      published_at: e.published_at,
      title: e.title,
      source: e.source,
    })),
    week_change_pct: weekChangePct,
  };
  cacheSet(params.store, params.cacheKey, payload);
  return payload;
}

// ═══════════════════════════════════════════════════════════════════════════
// Архив: список и полный payload
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/reports/weekly — архив юзера: [{id, week_start, total, top_tag}], ≤12
router.get('/weekly', async (req: AuthRequest, res) => {
  const access = await checkSessionAccess(req);
  if (!access.ok) return res.status(access.status).json({ error: 'Unauthorized' });
  const items = await listWeeklyReports(access.userId, 12);
  return res.json({
    reports: items.map((r) => ({
      id: r.id,
      week_start: r.week_start,
      total: r.totalArticles,
      top_tag: r.topTagName,
    })),
  });
});

// GET /api/reports/weekly/current — LIVE-режим (сессия only, magic-link не применяется)
router.get('/weekly/current', async (req: AuthRequest, res) => {
  const access = await checkSessionAccess(req);
  if (!access.ok) {
    return res.status(access.status).json({ error: access.status === 403 ? 'Forbidden' : 'Unauthorized' });
  }
  const userId = access.userId;

  // Воскресенье после генерации: live-вид исчезает, материализуется архивный снапшот
  const snapshot = await getCurrentWeekSnapshot(userId);
  if (snapshot) {
    return res.json({ snapshot_id: snapshot.id });
  }

  const mskDate = await getMskDateString();
  const cacheKey = `${userId}:${mskDate}`;
  const cached = cacheGet(liveCache, cacheKey, LIVE_CACHE_TTL_MS);
  if (cached) {
    res.setHeader('X-Cache', 'hit');
    return res.json(cached);
  }

  const ent = await getEntitlement(userId, 'weekly_report');
  if (!ent.allowed) {
    return res.status(403).json({ error: 'weekly_report requires paid plan' });
  }

  // Контент на лету: окно — прошедшие дни текущей недели (от понедельника МСК).
  // Ничего не записывается; LLM-бюджет — ноль (overall берёт фронт из
  // существующего /api/user/summary, perTag в live пустой).
  const now = new Date();
  const weekStart = weekStartMsk(now);
  let content = await buildWeeklyReportContent(userId, ent.maxTags, weekStart);

  const tagsResult = await query(
    `SELECT tag_id, tag_name FROM portfolios WHERE user_id = $1 AND is_frozen = FALSE`,
    [userId]
  );
  let liveStats = null;
  if (tagsResult.rows.length > 0) {
    liveStats = await computeLiveWeeklyStats(query, tagsResult.rows, now);
    if (content) content.stats = liveStats;
  }

  const pace = liveStats
    ? {
        elapsed_total: statsCurrentTotal(liveStats),
        prev_same_weekdays_total: statsPrevTotal(liveStats),
      }
    : { elapsed_total: 0, prev_same_weekdays_total: 0 };

  const payload = {
    live: true,
    week_start: weekStartMskDate(now),
    elapsed_days: elapsedWeekdays(now),
    pace,
    content,
    ai: { overall: null, perTag: [], meta: null },
  };
  cacheSet(liveCache, cacheKey, payload);
  res.setHeader('X-Cache', 'miss');
  return res.json(payload);
});

// GET /api/reports/weekly/current/chart?tag_id= — LIVE-график (сессия only)
router.get('/weekly/current/chart', async (req: AuthRequest, res) => {
  const access = await checkSessionAccess(req);
  if (!access.ok) {
    return res.status(access.status).json({ error: access.status === 403 ? 'Forbidden' : 'Unauthorized' });
  }
  const userId = access.userId;
  const tagId = req.query.tag_id as string;
  if (!tagId) return res.status(400).json({ error: 'tag_id required' });

  const ent = await getEntitlement(userId, 'weekly_report');
  if (!ent.allowed) return res.status(403).json({ error: 'weekly_report requires paid plan' });

  const mskDate = await getMskDateString();
  const cacheKey = `${userId}:${tagId}:${mskDate}`;
  const cached = cacheGet(liveChartCache, cacheKey, LIVE_CACHE_TTL_MS);
  if (cached) {
    res.setHeader('X-Cache', 'hit');
    return res.json(cached);
  }

  const now = new Date();
  const weekStart = weekStartMsk(now);
  const content = await buildWeeklyReportContent(userId, ent.maxTags, weekStart);
  const tag = content?.tagSummaries.find((t) => t.tagId === tagId);
  if (!content || !tag) {
    return res.status(404).json({ error: 'Tag not in current week' });
  }

  try {
    const payload = await buildWeekChart({
      store: liveChartCache,
      cacheKey,
      ttl: LIVE_CACHE_TTL_MS,
      tagId: tag.tagId,
      tagName: tag.tagName,
      markerIdPrefix: `${userId}:${tagId}`,
      events: tag.articles.map((a) => ({
        published_at: a.publishedAt instanceof Date ? a.publishedAt.toISOString() : String(a.publishedAt),
        title: a.title,
        sentiment: a.sentiment,
        url: a.url,
        source: a.source,
      })),
      weekStartUtc: weekStart,
      liveEnd: now,
    });
    res.setHeader('X-Cache', 'miss');
    return res.json(payload);
  } catch (err: any) {
    console.error('[Reports] live chart error:', err.message);
    return res.status(500).json({ error: 'chart_failed' });
  }
});

// GET /api/reports/weekly/current/ahead — «что впереди» для live (сессия only)
router.get('/weekly/current/ahead', async (req: AuthRequest, res) => {
  const access = await checkSessionAccess(req);
  if (!access.ok) {
    return res.status(access.status).json({ error: access.status === 403 ? 'Forbidden' : 'Unauthorized' });
  }
  const nextMonday = addDaysCal(weekStartMskDate(), 7);
  return respondAhead(res, access.userId, nextMonday);
});

// GET /api/reports/weekly/:id — полный payload архивного снапшота
router.get('/weekly/:id', async (req: AuthRequest, res) => {
  const access = await checkArchiveAccess(req, req.params.id);
  if (!access.ok) {
    const error = access.status === 403 ? 'Forbidden' : access.status === 401 ? 'Unauthorized' : 'Not found';
    return res.status(access.status).json({ error });
  }
  return res.json({
    id: access.snapshot.id,
    week_start: access.snapshot.weekStart,
    created_at: access.snapshot.createdAt,
    updated_at: access.snapshot.updatedAt,
    sent_at: access.snapshot.sentAt,
    content: access.snapshot.content,
    ai: access.snapshot.ai,
  });
});

// GET /api/reports/weekly/:id/chart?tag_id= — АРХИВ-график (доступ = как у отчёта)
router.get('/weekly/:id/chart', async (req: AuthRequest, res) => {
  const access = await checkArchiveAccess(req, req.params.id);
  if (!access.ok) {
    const error = access.status === 403 ? 'Forbidden' : access.status === 401 ? 'Unauthorized' : 'Not found';
    return res.status(access.status).json({ error });
  }
  const tagId = req.query.tag_id as string;
  if (!tagId) return res.status(400).json({ error: 'tag_id required' });

  const { snapshot } = access;
  // SSRF-гард: tag_id только выбирает тег внутри payload снапшота
  const tag = snapshot.content.tagSummaries.find((t) => t.tagId === tagId);
  if (!tag) return res.status(404).json({ error: 'Tag not in snapshot' });

  const cacheKey = `${snapshot.id}:${tagId}`;
  const wasCached = cacheGet(archiveChartCache, cacheKey, ARCHIVE_CHART_CACHE_TTL_MS) !== null;
  try {
    const payload = await buildWeekChart({
      store: archiveChartCache,
      cacheKey,
      ttl: ARCHIVE_CHART_CACHE_TTL_MS,
      tagId: tag.tagId,
      tagName: tag.tagName,
      markerIdPrefix: `${snapshot.id}:${tagId}`,
      events: getTagEventsFromSnapshot(snapshot, tagId),
      weekStartUtc: new Date(`${snapshot.weekStart}T00:00:00+03:00`),
    });
    res.setHeader('X-Cache', wasCached ? 'hit' : 'miss');
    return res.json(payload);
  } catch (err: any) {
    console.error('[Reports] archive chart error:', err.message);
    return res.status(500).json({ error: 'chart_failed' });
  }
});

// GET /api/reports/weekly/:id/ahead — «что впереди» для архива (доступ = как у отчёта)
router.get('/weekly/:id/ahead', async (req: AuthRequest, res) => {
  const access = await checkArchiveAccess(req, req.params.id);
  if (!access.ok) {
    const error = access.status === 403 ? 'Forbidden' : access.status === 401 ? 'Unauthorized' : 'Not found';
    return res.status(access.status).json({ error });
  }
  // Окно — неделя ПОСЛЕ отчётной; фильтр — по активным тегам ВЛАДЕЛЬЦА отчёта
  const nextMonday = addDaysCal(access.snapshot.weekStart, 7);
  return respondAhead(res, access.snapshot.userId, nextMonday);
});

// ── «Что впереди»: события следующей недели по активным тегам портфеля ──────

const AHEAD_GROUP_CAP = 12; // cap групп событий, сортировка по дате

/**
 * Живые данные канонического calendar_events (НЕ снапшотится — провайдеры
 * подтверждают события в течение недели). Форма ответа — как у публичного
 * GET /api/calendar (days[] → groups[] → companies[]). Календарь не загружен
 * → 200 {ahead: null} — блок скрыт (деградация по конвенции графика).
 */
async function respondAhead(res: any, ownerId: string, windowStart: string): Promise<any> {
  const cacheKey = `${ownerId}:${windowStart}`;
  const cached = cacheGet(aheadCache, cacheKey, AHEAD_CACHE_TTL_MS);
  if (cached) {
    res.setHeader('X-Cache', 'hit');
    return res.json(cached);
  }

  let payload: { ahead: any };
  try {
    if (await isCalendarEmpty()) {
      payload = { ahead: null };
    } else {
      const portfolioResult = await query(
        `SELECT tag_id FROM portfolios WHERE user_id = $1 AND is_frozen = FALSE`,
        [ownerId]
      );
      const tagSet = new Set<string>(portfolioResult.rows.map((r: any) => r.tag_id));

      const windowEnd = addDaysCal(windowStart, 7);
      const eventsResult = await query(
        `SELECT date, weekday, title, kind, status, company, ticker, tag_ids
         FROM calendar_events
         WHERE date >= $1 AND date < $2
         ORDER BY date, title`,
        [windowStart, windowEnd]
      );

      interface Group {
        title: string;
        kind: string;
        status: string;
        companies: Array<{ name: string; ticker: string; matched: boolean }>;
      }
      const days = new Map<string, { weekday: string; groups: Map<string, Group> }>();
      let groupCount = 0;

      for (const row of eventsResult.rows) {
        let rowTags: string[] = [];
        try {
          const parsed = JSON.parse(row.tag_ids || '[]');
          if (Array.isArray(parsed)) rowTags = parsed as string[];
        } catch { /* событие без тегов */ }
        const matchedTags = rowTags.filter((t) => tagSet.has(t));
        // События без пересечения с портфелем (и пустой портфель) — отфильтрованы
        if (matchedTags.length === 0) continue;

        const date = typeof row.date === 'string' ? row.date.slice(0, 10) : String(row.date).slice(0, 10);
        if (!days.has(date)) {
          days.set(date, { weekday: row.weekday, groups: new Map() });
        }
        const day = days.get(date)!;
        const groupKey = `${row.title}|${row.kind}`;
        if (!day.groups.has(groupKey)) {
          if (groupCount >= AHEAD_GROUP_CAP) continue; // cap 12 групп
          groupCount++;
          day.groups.set(groupKey, {
            title: row.title,
            kind: row.kind,
            status: row.status,
            companies: [],
          });
        }
        day.groups.get(groupKey)!.companies.push({
          name: row.company,
          ticker: row.ticker,
          matched: matchedTags.length > 0, // подсветка компаний с совпавшими тегами
        });
      }

      const daysOut = [...days.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, day]) => ({
          date,
          weekday: day.weekday,
          groups: [...day.groups.values()].map((g) => ({
            title: g.title,
            kind: g.kind,
            status: g.status,
            companies: g.companies,
          })),
        }))
        .filter((d) => d.groups.length > 0);

      payload = { ahead: { days: daysOut } };
    }
  } catch (err: any) {
    console.error('[Reports] ahead error:', err.message);
    payload = { ahead: null };
  }

  cacheSet(aheadCache, cacheKey, payload);
  res.setHeader('X-Cache', 'miss');
  return res.json(payload);
}

export default router;
