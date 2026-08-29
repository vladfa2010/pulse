/**
 * =============================================================================
 * PULSE — Investor Calendar service
 * =============================================================================
 *
 * Stores and serves the «Календарь инвестора» snapshot.
 * Snapshot is uploaded manually by admins via POST /api/admin/calendar
 * and kept in two tables: calendar_events (flat rows) + calendar_meta (1 row).
 */

import { query, pool } from '../config/db';
import { nowSql } from '../utils/nowSql';
import { sendTelegramMessage } from './telegram';
import { broadcastCalendarRefresh } from './sse';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type EventKind = 'МСФО' | 'РСБУ' | 'СД' | 'СА' | 'Дивиденды' | 'Другое';
export type EventStatus = 'confirmed' | 'expected';

export interface CalendarCompany {
  name: string;
  ticker: string;
}

export interface CalendarEventGroup {
  title: string;
  kind: EventKind;
  status: EventStatus;
  companies: CalendarCompany[];
}

export interface CalendarDay {
  date: string;    // YYYY-MM-DD
  weekday: string; // 'пн'..'вс'
  groups: CalendarEventGroup[];
}

export interface CalendarResponse {
  server_date: string;
  generated_at: string;
  stale: boolean;
  days: CalendarDay[];
}

export interface CalendarAdminEvent {
  date: string;
  weekday: string;
  title: string;
  kind: EventKind;
  status: EventStatus;
  companies: CalendarCompany[];
  companies_count: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const VALID_KINDS: EventKind[] = ['МСФО', 'РСБУ', 'СД', 'СА', 'Дивиденды', 'Другое'];
const VALID_STATUSES: EventStatus[] = ['confirmed', 'expected'];

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const STALE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CALENDAR_CACHE_TTL_MS = 60 * 1000;

let calendarCache: { data: CalendarResponse; cachedAt: number } | null = null;
let calendarCachePromise: Promise<CalendarResponse> | null = null;
let calendarCacheGeneration = 0;

class CalendarNotLoadedError extends Error {
  constructor() {
    super('calendar_not_loaded');
    this.name = 'CalendarNotLoadedError';
  }
}

export function isCalendarNotLoadedError(err: any): err is CalendarNotLoadedError {
  return err instanceof CalendarNotLoadedError;
}

export function invalidateCalendarCache(): void {
  calendarCache = null;
  calendarCachePromise = null;
  calendarCacheGeneration++;
}

// ═══════════════════════════════════════════════════════════════════════════
// Date helpers
// ═══════════════════════════════════════════════════════════════════════════

function toDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** PostgreSQL DATE column is returned as a Date object; SQLite returns a string.
 *  Normalize any value to a canonical YYYY-MM-DD string so Map keys and JSON match. */
function normalizeDbDate(value: unknown): string {
  if (value instanceof Date) {
    return toDateString(value);
  }
  if (typeof value === 'string') {
    return value.length >= 10 ? value.slice(0, 10) : value;
  }
  return String(value).slice(0, 10);
}

/** Current date in Europe/Moscow as YYYY-MM-DD. Computed in JS to work on both SQLite and PostgreSQL. */
export async function getMskDateString(): Promise<string> {
  const result = await query(`SELECT ${nowSql()} as now`);
  const raw = result.rows[0]?.now;
  const serverNow = raw ? new Date(raw) : new Date();
  // Add MSK offset (+3h from UTC)
  const msk = new Date(serverNow.getTime() + MSK_OFFSET_MS);
  return toDateString(msk);
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateString(d);
}

// ═══════════════════════════════════════════════════════════════════════════
// Validation
// ═══════════════════════════════════════════════════════════════════════════

function isValidDate(str: unknown): str is string {
  if (typeof str !== 'string') return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(`${str}T00:00:00Z`).getTime());
}

export function validateCalendarDays(days: unknown): CalendarDay[] {
  if (!Array.isArray(days) || days.length === 0) {
    throw new Error('days must be a non-empty array');
  }

  const seen = new Set<string>();

  for (const day of days) {
    if (!day || typeof day !== 'object') {
      throw new Error('each day must be an object');
    }

    if (!isValidDate(day.date)) {
      throw new Error(`invalid day date: ${day.date}`);
    }
    if (typeof day.weekday !== 'string' || day.weekday.length === 0) {
      throw new Error(`invalid weekday for ${day.date}`);
    }
    if (!Array.isArray(day.groups) || day.groups.length === 0) {
      throw new Error(`groups must be a non-empty array for ${day.date}`);
    }

    const dayKey = day.date;
    if (seen.has(dayKey)) {
      throw new Error(`duplicate day: ${day.date}`);
    }
    seen.add(dayKey);

    const groupKeys = new Set<string>();

    for (const group of day.groups) {
      if (!group || typeof group !== 'object') {
        throw new Error(`group must be an object for ${day.date}`);
      }
      if (typeof group.title !== 'string' || group.title.length === 0) {
        throw new Error(`group title required for ${day.date}`);
      }
      if (!VALID_KINDS.includes(group.kind)) {
        throw new Error(`invalid kind "${group.kind}" for ${day.date}`);
      }
      if (!VALID_STATUSES.includes(group.status)) {
        throw new Error(`invalid status "${group.status}" for ${day.date}`);
      }
      if (!Array.isArray(group.companies) || group.companies.length === 0) {
        throw new Error(`companies must be a non-empty array for ${day.date}`);
      }

      const groupKey = `${group.title}|${group.kind}`;
      if (groupKeys.has(groupKey)) {
        throw new Error(`duplicate group "${group.title}" (${group.kind}) for ${day.date}`);
      }
      groupKeys.add(groupKey);

      const tickers = new Set<string>();
      for (const company of group.companies) {
        if (!company || typeof company !== 'object') {
          throw new Error(`company must be an object for ${day.date}`);
        }
        if (typeof company.name !== 'string' || company.name.length === 0) {
          throw new Error(`company name required for ${day.date}`);
        }
        if (typeof company.ticker !== 'string' || company.ticker.length === 0) {
          throw new Error(`company ticker required for ${day.date}`);
        }
        const tickerUpper = company.ticker.toUpperCase();
        if (tickers.has(tickerUpper)) {
          throw new Error(`duplicate ticker ${tickerUpper} in group "${group.title}" for ${day.date}`);
        }
        tickers.add(tickerUpper);
      }
    }
  }

  return days as CalendarDay[];
}

// ═══════════════════════════════════════════════════════════════════════════
// DB helpers
// ═══════════════════════════════════════════════════════════════════════════

interface CalendarRow {
  date: string;
  weekday: string;
  title: string;
  kind: EventKind;
  status: EventStatus;
  company: string;
  ticker: string;
}

async function getUploadedAt(): Promise<string | null> {
  try {
    const result = await query(`SELECT uploaded_at FROM calendar_meta WHERE id = 1`);
    if (result.rows.length === 0) return null;
    const uploadedAt = result.rows[0].uploaded_at;
    return uploadedAt ? new Date(uploadedAt).toISOString() : null;
  } catch {
    return null;
  }
}

export async function isCalendarEmpty(): Promise<boolean> {
  try {
    const result = await query(`SELECT COUNT(*) as c FROM calendar_events`);
    return Number(result.rows[0]?.c || 0) === 0;
  } catch {
    return true;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

export async function getCalendarData(): Promise<CalendarResponse> {
  if (calendarCache && Date.now() - calendarCache.cachedAt < CALENDAR_CACHE_TTL_MS) {
    return calendarCache.data;
  }

  if (calendarCachePromise) {
    return calendarCachePromise;
  }

  const gen = calendarCacheGeneration;

  calendarCachePromise = (async (): Promise<CalendarResponse> => {
    if (await isCalendarEmpty()) {
      throw new CalendarNotLoadedError();
    }

    const serverDate = await getMskDateString();
    const generatedAt = await getUploadedAt();
    const windowStart = addDays(serverDate, -2);
    const windowEnd = addDays(serverDate, 120);

    const result = await query(
      `SELECT date, weekday, title, kind, status, company, ticker
       FROM calendar_events
       WHERE date >= $1 AND date <= $2
       ORDER BY date, title`,
      [windowStart, windowEnd]
    );

    const rows: CalendarRow[] = result.rows.map((r: any) => ({
      date: normalizeDbDate(r.date),
      weekday: r.weekday,
      title: r.title,
      kind: r.kind,
      status: r.status,
      company: r.company,
      ticker: r.ticker,
    }));

    const days = buildDays(rows);
    const stale = days.length === 0 || days[days.length - 1].date < addDays(serverDate, -2);

    if (stale) {
      maybeSendStaleAlert().catch((err: any) => {
        console.error('[Calendar] Stale alert failed:', err.message);
      });
    }

    return {
      server_date: serverDate,
      generated_at: generatedAt || new Date().toISOString(),
      stale,
      days,
    };
  })();

  try {
    const response = await calendarCachePromise;
    if (gen === calendarCacheGeneration) {
      calendarCache = { data: response, cachedAt: Date.now() };
    }
    return response;
  } catch (err) {
    if (gen === calendarCacheGeneration) {
      calendarCachePromise = null;
    }
    throw err;
  } finally {
    if (gen === calendarCacheGeneration) {
      calendarCachePromise = null;
    }
  }
}

function buildDays(rows: CalendarRow[]): CalendarDay[] {
  const dayMap = new Map<string, { weekday: string; groups: Map<string, CalendarEventGroup> }>();

  for (const row of rows) {
    if (!dayMap.has(row.date)) {
      dayMap.set(row.date, { weekday: row.weekday, groups: new Map() });
    }
    const day = dayMap.get(row.date)!;

    const groupKey = `${row.title}|${row.kind}`;
    if (!day.groups.has(groupKey)) {
      day.groups.set(groupKey, {
        title: row.title,
        kind: row.kind,
        status: row.status,
        companies: [],
      });
    }
    const group = day.groups.get(groupKey)!;
    group.companies.push({ name: row.company, ticker: row.ticker });
  }

  const days: CalendarDay[] = [];
  const sortedDates = Array.from(dayMap.keys()).sort();
  for (const date of sortedDates) {
    const day = dayMap.get(date)!;
    const sortedGroups = Array.from(day.groups.values()).sort((a, b) =>
      a.title.localeCompare(b.title, 'ru')
    );
    days.push({ date, weekday: day.weekday, groups: sortedGroups });
  }

  return days;
}

// ═══════════════════════════════════════════════════════════════════════════
// Admin upload
// ═══════════════════════════════════════════════════════════════════════════

type QueryFn = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

export async function saveCalendarSnapshot(days: CalendarDay[]): Promise<{ daysCount: number; eventsCount: number }> {
  validateCalendarDays(days);

  const flatRows: Array<{
    date: string;
    weekday: string;
    title: string;
    kind: EventKind;
    status: EventStatus;
    company: string;
    ticker: string;
  }> = [];

  for (const day of days) {
    for (const group of day.groups) {
      for (const company of group.companies) {
        flatRows.push({
          date: day.date,
          weekday: day.weekday,
          title: group.title,
          kind: group.kind,
          status: group.status,
          company: company.name,
          ticker: company.ticker.toUpperCase(),
        });
      }
    }
  }

  // Cross-platform transaction
  const USE_SQLITE = process.env.USE_SQLITE === 'true';

  if (pool && !USE_SQLITE) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM calendar_events`);

      for (const row of flatRows) {
        await client.query(
          `INSERT INTO calendar_events (date, weekday, title, kind, status, company, ticker, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
          [row.date, row.weekday, row.title, row.kind, row.status, row.company, row.ticker]
        );
      }

      await client.query(
        `INSERT INTO calendar_meta (id, uploaded_at, last_stale_alert_at)
         VALUES (1, ${nowSql()}, NULL)
         ON CONFLICT (id) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL`
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    await query('BEGIN');
    try {
      await query(`DELETE FROM calendar_events`);

      for (const row of flatRows) {
        await query(
          `INSERT INTO calendar_events (date, weekday, title, kind, status, company, ticker, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
          [row.date, row.weekday, row.title, row.kind, row.status, row.company, row.ticker]
        );
      }

      await query(
        `INSERT INTO calendar_meta (id, uploaded_at, last_stale_alert_at)
         VALUES (1, ${nowSql()}, NULL)
         ON CONFLICT (id) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL`
      );

      await query('COMMIT');
    } catch (err) {
      await query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  broadcastCalendarRefresh();
  invalidateCalendarCache();

  return {
    daysCount: days.length,
    eventsCount: flatRows.length,
  };
}

export async function mergeCalendarSnapshot(
  days: CalendarDay[]
): Promise<{ daysCount: number; eventsCount: number; addedDays: number; addedEvents: number }> {
  validateCalendarDays(days);

  const flatRows: Array<{
    date: string;
    weekday: string;
    title: string;
    kind: EventKind;
    status: EventStatus;
    company: string;
    ticker: string;
  }> = [];

  for (const day of days) {
    for (const group of day.groups) {
      for (const company of group.companies) {
        flatRows.push({
          date: day.date,
          weekday: day.weekday,
          title: group.title,
          kind: group.kind,
          status: group.status,
          company: company.name,
          ticker: company.ticker.toUpperCase(),
        });
      }
    }
  }

  const USE_SQLITE = process.env.USE_SQLITE === 'true';
  let addedDays = 0;
  let addedEvents = 0;

  const processGroups = async (q: QueryFn) => {
    const seenGroups = new Set<string>();

    for (const day of days) {
      let dayHasNew = false;
      for (const group of day.groups) {
        const groupKey = `${day.date}|${group.title}|${group.kind}`;
        if (seenGroups.has(groupKey)) continue;
        seenGroups.add(groupKey);

        const existing = await q(
          `SELECT 1 FROM calendar_events WHERE date = $1 AND title = $2 AND kind = $3 LIMIT 1`,
          [day.date, group.title, group.kind]
        );

        if (existing.rows.length > 0) {
          continue;
        }

        dayHasNew = true;
        addedEvents++;
        for (const company of group.companies) {
          await q(
            `INSERT INTO calendar_events (date, weekday, title, kind, status, company, ticker, uploaded_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
            [day.date, day.weekday, group.title, group.kind, group.status, company.name, company.ticker.toUpperCase()]
          );
        }
      }
      if (dayHasNew) addedDays++;
    }
  };

  if (pool && !USE_SQLITE) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await processGroups((text, params) => client.query(text, params));
      await client.query(
        `INSERT INTO calendar_meta (id, uploaded_at, last_stale_alert_at)
         VALUES (1, ${nowSql()}, NULL)
         ON CONFLICT (id) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL`
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    await query('BEGIN');
    try {
      await processGroups(query);
      await query(
        `INSERT INTO calendar_meta (id, uploaded_at, last_stale_alert_at)
         VALUES (1, ${nowSql()}, NULL)
         ON CONFLICT (id) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL`
      );
      await query('COMMIT');
    } catch (err) {
      await query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  broadcastCalendarRefresh();
  invalidateCalendarCache();

  return {
    daysCount: days.length,
    eventsCount: flatRows.length,
    addedDays,
    addedEvents,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Admin single-event CRUD
// ═══════════════════════════════════════════════════════════════════════════

class CalendarAdminError extends Error {
  status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.name = 'CalendarAdminError';
    this.status = status;
  }
}

export function isValidKind(k: unknown): k is EventKind {
  return typeof k === 'string' && VALID_KINDS.includes(k as EventKind);
}

export function isValidStatus(s: unknown): s is EventStatus {
  return typeof s === 'string' && VALID_STATUSES.includes(s as EventStatus);
}

const RUSSIAN_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function getWeekday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return '';
  return RUSSIAN_WEEKDAYS[d.getUTCDay()];
}

function validateCalendarAdminEvent(event: unknown): CalendarAdminEvent {
  if (!event || typeof event !== 'object') {
    throw new CalendarAdminError('event must be an object');
  }

  const e = event as Record<string, unknown>;

  if (!isValidDate(e.date)) {
    throw new CalendarAdminError(`invalid date: ${e.date}`);
  }
  if (!isValidKind(e.kind)) {
    throw new CalendarAdminError(`invalid kind: ${e.kind}`);
  }
  if (!isValidStatus(e.status)) {
    throw new CalendarAdminError(`invalid status: ${e.status}`);
  }
  if (typeof e.title !== 'string' || e.title.length === 0) {
    throw new CalendarAdminError('title is required');
  }
  if (!Array.isArray(e.companies) || e.companies.length === 0) {
    throw new CalendarAdminError('companies must be a non-empty array');
  }

  const tickers = new Set<string>();
  const companies: CalendarCompany[] = [];

  for (const item of e.companies) {
    if (!item || typeof item !== 'object') {
      throw new CalendarAdminError('each company must be an object');
    }

    const c = item as Record<string, unknown>;
    if (typeof c.name !== 'string' || c.name.length === 0) {
      throw new CalendarAdminError('company name is required');
    }
    if (typeof c.ticker !== 'string' || c.ticker.length === 0) {
      throw new CalendarAdminError('company ticker is required');
    }

    const tickerUpper = c.ticker.toUpperCase();
    if (tickers.has(tickerUpper)) {
      throw new CalendarAdminError(`duplicate ticker ${tickerUpper}`);
    }
    tickers.add(tickerUpper);

    companies.push({ name: c.name, ticker: tickerUpper });
  }

  const weekday = typeof e.weekday === 'string' && e.weekday.length > 0
    ? e.weekday
    : getWeekday(e.date);

  return {
    date: e.date,
    weekday,
    title: e.title,
    kind: e.kind,
    status: e.status,
    companies,
    companies_count: companies.length,
  };
}

async function withCalendarTransaction<T>(fn: (q: QueryFn) => Promise<T>): Promise<T> {
  const USE_SQLITE = process.env.USE_SQLITE === 'true';

  if (pool && !USE_SQLITE) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn((text, params) => client.query(text, params));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    await query('BEGIN');
    try {
      const result = await fn(query);
      await query('COMMIT');
      return result;
    } catch (err) {
      await query('ROLLBACK').catch(() => {});
      throw err;
    }
  }
}

async function touchCalendarMeta(q: QueryFn): Promise<void> {
  await q(
    `INSERT INTO calendar_meta (id, uploaded_at, last_stale_alert_at) VALUES (1, ${nowSql()}, NULL)
     ON CONFLICT (id) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL`
  );
}

export interface CalendarAdminFilters {
  search?: string;
  kind?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export async function listCalendarEventGroups(
  filters: CalendarAdminFilters
): Promise<{ events: CalendarAdminEvent[]; total: number }> {
  const search = typeof filters.search === 'string' && filters.search.length > 0 ? filters.search : undefined;
  const kind = typeof filters.kind === 'string' && filters.kind.length > 0 ? filters.kind : undefined;
  const status = typeof filters.status === 'string' && filters.status.length > 0 ? filters.status : undefined;
  const limit = Number.isFinite(Number(filters.limit)) && Number(filters.limit) > 0 ? Number(filters.limit) : 50;
  const offset = Number.isFinite(Number(filters.offset)) && Number(filters.offset) >= 0 ? Number(filters.offset) : 0;

  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (kind) {
    conditions.push(`ce.kind = $${idx}`);
    params.push(kind);
    idx++;
  }
  if (status) {
    conditions.push(`ce.status = $${idx}`);
    params.push(status);
    idx++;
  }
  if (search) {
    const pattern = `%${search}%`;
    conditions.push(
      `(lower(ce.title) LIKE $${idx} OR EXISTS (` +
        `SELECT 1 FROM calendar_events ce2 ` +
        `WHERE ce2.date = ce.date AND ce2.title = ce.title AND ce2.kind = ce.kind ` +
        `AND (lower(ce2.company) LIKE $${idx} OR lower(ce2.ticker) LIKE $${idx})))`
    );
    params.push(pattern);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const dataSql = `
    SELECT ce.date, ce.weekday, ce.title, ce.kind, ce.status, COUNT(*) as companies_count
    FROM calendar_events ce
    ${where}
    GROUP BY ce.date, ce.weekday, ce.title, ce.kind, ce.status
    ORDER BY ce.date DESC, ce.title
    LIMIT $${idx} OFFSET $${idx + 1}
  `;
  const dataParams = [...params, limit, offset];

  const totalSql = `
    SELECT COUNT(*) as total FROM (
      SELECT 1 FROM calendar_events ce
      ${where}
      GROUP BY ce.date, ce.title, ce.kind
    ) sub
  `;

  const [dataResult, totalResult] = await Promise.all([
    query(dataSql, dataParams),
    query(totalSql, params),
  ]);

  const events: CalendarAdminEvent[] = dataResult.rows.map((r: any) => ({
    date: normalizeDbDate(r.date),
    weekday: r.weekday,
    title: r.title,
    kind: r.kind,
    status: r.status,
    companies: [],
    companies_count: Number(r.companies_count || 0),
  }));

  const total = Number(totalResult.rows[0]?.total || 0);
  return { events, total };
}

export async function getCalendarEventGroup(
  date: string,
  title: string,
  kind: string
): Promise<CalendarAdminEvent | null> {
  const result = await query(
    `SELECT date, weekday, title, kind, status, company, ticker
     FROM calendar_events
     WHERE date = $1 AND title = $2 AND kind = $3
     ORDER BY ticker`,
    [date, title, kind]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const rows = result.rows.map((r: any) => ({
    date: normalizeDbDate(r.date),
    weekday: r.weekday,
    title: r.title,
    kind: r.kind,
    status: r.status,
    company: r.company,
    ticker: r.ticker,
  }));

  const first = rows[0];
  const companies = rows.map((r: any) => ({ name: r.company, ticker: r.ticker }));

  return {
    date: first.date,
    weekday: first.weekday,
    title: first.title,
    kind: first.kind,
    status: first.status,
    companies,
    companies_count: companies.length,
  };
}

export async function createCalendarEventGroup(event: unknown): Promise<void> {
  const validated = validateCalendarAdminEvent(event);

  await withCalendarTransaction(async (q) => {
    const existing = await q(
      `SELECT 1 FROM calendar_events WHERE date = $1 AND title = $2 AND kind = $3 LIMIT 1`,
      [validated.date, validated.title, validated.kind]
    );
    if (existing.rows.length > 0) {
      throw new CalendarAdminError('Event group already exists', 409);
    }

    for (const company of validated.companies) {
      await q(
        `INSERT INTO calendar_events (date, weekday, title, kind, status, company, ticker, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
        [validated.date, validated.weekday, validated.title, validated.kind, validated.status, company.name, company.ticker]
      );
    }

    await touchCalendarMeta(q);
  });

  broadcastCalendarRefresh();
  invalidateCalendarCache();
}

export async function updateCalendarEventGroup(
  oldDate: string,
  oldTitle: string,
  oldKind: string,
  event: unknown
): Promise<void> {
  const validated = validateCalendarAdminEvent(event);

  await withCalendarTransaction(async (q) => {
    const del = await q(
      `DELETE FROM calendar_events WHERE date = $1 AND title = $2 AND kind = $3`,
      [oldDate, oldTitle, oldKind]
    );

    if (!del.rowCount) {
      throw new CalendarAdminError('Event group not found', 404);
    }

    for (const company of validated.companies) {
      await q(
        `INSERT INTO calendar_events (date, weekday, title, kind, status, company, ticker, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
        [validated.date, validated.weekday, validated.title, validated.kind, validated.status, company.name, company.ticker]
      );
    }

    await touchCalendarMeta(q);
  });

  broadcastCalendarRefresh();
  invalidateCalendarCache();
}

export async function deleteCalendarEventGroup(
  date: string,
  title: string,
  kind: string
): Promise<void> {
  await withCalendarTransaction(async (q) => {
    const del = await q(
      `DELETE FROM calendar_events WHERE date = $1 AND title = $2 AND kind = $3`,
      [date, title, kind]
    );

    if (!del.rowCount) {
      throw new CalendarAdminError('Event group not found', 404);
    }

    await touchCalendarMeta(q);
  });

  broadcastCalendarRefresh();
  invalidateCalendarCache();
}

// ═══════════════════════════════════════════════════════════════════════════
// Stale alert (throttled)
// ═══════════════════════════════════════════════════════════════════════════

export async function maybeSendStaleAlert(): Promise<void> {
  const metaResult = await query(`SELECT uploaded_at, last_stale_alert_at FROM calendar_meta WHERE id = 1`);
  if (metaResult.rows.length === 0) return;

  const meta = metaResult.rows[0];
  const serverDate = await getMskDateString();
  const windowStart = addDays(serverDate, -2);

  const coverResult = await query(
    `SELECT MAX(date) as max_date FROM calendar_events`
  );
  const maxDate = normalizeDbDate(coverResult.rows[0]?.max_date);

  if (!maxDate || maxDate >= windowStart) return;

  const lastAlert = meta.last_stale_alert_at ? new Date(meta.last_stale_alert_at).getTime() : 0;
  if (Date.now() - lastAlert < STALE_ALERT_COOLDOWN_MS) return;

  const adminsResult = await query(
    `SELECT tg_chat_id FROM admin_tg_settings WHERE is_active = TRUE AND tg_chat_id IS NOT NULL`
  );
  if (adminsResult.rows.length === 0) return;

  const message = `⚠️ Календарь инвестора устарел\nПоследние данные: ${maxDate}\nСерверная дата: ${serverDate}\nЗагрузите новый снапшот через админку.`;

  let sent = 0;
  for (const row of adminsResult.rows) {
    const ok = await sendTelegramMessage(row.tg_chat_id, message, 'HTML');
    if (ok) sent++;
  }

  if (sent > 0) {
    await query(
      `UPDATE calendar_meta SET last_stale_alert_at = ${nowSql()} WHERE id = 1`
    );
    console.log(`[Calendar] Sent stale alert to ${sent} admin(s)`);
  }
}
