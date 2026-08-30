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
import { NormalizedEvent } from './calendarAdapters';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type EventKind = 'МСФО' | 'РСБУ' | 'СД' | 'СА' | 'Дивиденды' | 'Другое';
export type EventStatus = 'confirmed' | 'expected';

export interface CalendarCompany {
  name: string;
  ticker: string;
  sources?: string[];
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
  generated_at: string | null;
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
  sources?: string[];
  possible_duplicate?: boolean;
  /** Tombstone-only: the original event title, if preserved. */
  original_title?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const VALID_KINDS: EventKind[] = ['МСФО', 'РСБУ', 'СД', 'СА', 'Дивиденды', 'Другое'];
const VALID_STATUSES: EventStatus[] = ['confirmed', 'expected'];

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const STALE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const CALENDAR_CACHE_TTL_MS = 60 * 1000;

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export const PROVIDER_PRIORITY = ['manual', 'investmint', 'smartlab', 'bcs', 'global', 'legacy'];

export interface CalendarRawRow {
  id?: string;
  source: string;
  date: string;
  weekday: string;
  title: string;
  kind: EventKind;
  status: EventStatus;
  company: string;
  ticker: string;
  uploaded_at?: string;
  /** Tombstone-only: suppressed canonical key (date|ticker or date|n:<company>). */
  tombstone_key?: string;
  /** Tombstone-only: original event title for display/restore. */
  original_title?: string;
}

export interface CanonicalRow {
  date: string;
  weekday: string;
  title: string;
  kind: EventKind;
  status: EventStatus;
  company: string;
  ticker: string;
  sources: string;
  possible_duplicate: boolean;
}

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
export function normalizeDbDate(value: unknown): string {
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

export function addDays(dateStr: string, days: number): string {
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

async function getGeneratedAt(): Promise<string | null> {
  try {
    const result = await query(`SELECT MAX(uploaded_at) as generated_at FROM calendar_sources`);
    const generatedAt = result.rows[0]?.generated_at;
    return generatedAt ? new Date(generatedAt).toISOString() : null;
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
    const generatedAt = await getGeneratedAt();
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
    const stale = days.length === 0 || days[days.length - 1].date < windowStart;

    maybeSendProviderStaleAlerts().catch((err: any) => {
      console.error('[Calendar] Provider stale alerts failed:', err.message);
    });

    return {
      server_date: serverDate,
      generated_at: generatedAt,
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

  const flatRows: CalendarRawRow[] = [];
  for (const day of days) {
    for (const group of day.groups) {
      for (const company of group.companies) {
        flatRows.push({
          source: 'legacy',
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

  await withCalendarTransaction(async (q) => {
    await q(`DELETE FROM calendar_events_raw WHERE source = 'legacy'`);

    for (const row of flatRows) {
      await q(
        `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
         VALUES ('legacy', $1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
        [row.date, row.weekday, row.title, row.kind, row.status, row.company, row.ticker]
      );
    }

    await q(
      `INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at)
       VALUES ('legacy', ${nowSql()}, NULL)
       ON CONFLICT (source) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL`
    );

    await rebuildCanonical(q);
  });

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

  const flatRows: CalendarRawRow[] = [];
  for (const day of days) {
    for (const group of day.groups) {
      for (const company of group.companies) {
        flatRows.push({
          source: 'legacy',
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

  // Count genuinely new groups before the transaction for the API response.
  const inputGroups = new Map<string, string>();
  for (const day of days) {
    for (const group of day.groups) {
      const key = `${day.date}|${group.title}|${group.kind}`;
      if (!inputGroups.has(key)) inputGroups.set(key, day.date);
    }
  }

  const uniqueDates = [...new Set(days.map((d) => d.date))];
  const datePlaceholders = uniqueDates.map((_, i) => `$${i + 1}`).join(',');
  const existingGroupsResult = await query(
    `SELECT date, title, kind FROM calendar_events WHERE date IN (${datePlaceholders})`,
    uniqueDates
  );
  const existingGroups = new Set(existingGroupsResult.rows.map((r: any) => `${normalizeDbDate(r.date)}|${r.title}|${r.kind}`));

  let addedEvents = 0;
  const addedDates = new Set<string>();
  for (const [key, date] of inputGroups) {
    if (!existingGroups.has(key)) {
      addedEvents++;
      addedDates.add(date);
    }
  }

  await withCalendarTransaction(async (q) => {
    for (const row of flatRows) {
      await q(
        `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
         VALUES ('legacy', $1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
        [row.date, row.weekday, row.title, row.kind, row.status, row.company, row.ticker]
      );
    }

    await q(
      `INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at)
       VALUES ('legacy', ${nowSql()}, NULL)
       ON CONFLICT (source) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL`
    );

    await rebuildCanonical(q);
  });

  broadcastCalendarRefresh();
  invalidateCalendarCache();

  return {
    daysCount: days.length,
    eventsCount: flatRows.length,
    addedDays: addedDates.size,
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

export async function withCalendarTransaction<T>(fn: (q: QueryFn) => Promise<T>): Promise<T> {
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
    // SQLite (sql.js): db.export() (used by saveDb after every write) closes any active transaction,
    // so explicit BEGIN/COMMIT cannot be safely used here. Writes run in autocommit mode on dev SQLite.
    return await fn(query);
  }
}

async function touchCalendarMeta(q: QueryFn): Promise<void> {
  await q(
    `INSERT INTO calendar_meta (id, uploaded_at, last_stale_alert_at) VALUES (1, ${nowSql()}, NULL)
     ON CONFLICT (id) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL`
  );
}

async function touchCalendarSource(q: QueryFn, source: string, warnings: string[] = []): Promise<void> {
  await q(
    `INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at, last_warnings)
     VALUES ($1, ${nowSql()}, NULL, $2)
     ON CONFLICT (source) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL, last_warnings = $2`,
    [source, JSON.stringify(warnings)]
  );
}

export interface CalendarAdminFilters {
  search?: string;
  kind?: string;
  status?: string;
  possible_duplicate?: boolean;
  tombstones?: boolean;
  limit?: number;
  offset?: number;
}

export async function listCalendarEventGroups(
  filters: CalendarAdminFilters
): Promise<{ events: CalendarAdminEvent[]; total: number }> {
  const search = typeof filters.search === 'string' && filters.search.length > 0 ? filters.search : undefined;
  const kind = typeof filters.kind === 'string' && filters.kind.length > 0 ? filters.kind : undefined;
  const status = typeof filters.status === 'string' && filters.status.length > 0 ? filters.status : undefined;
  const possibleDuplicate = filters.possible_duplicate === true;
  const tombstones = filters.tombstones === true;
  const limit = Number.isFinite(Number(filters.limit)) && Number(filters.limit) > 0 ? Number(filters.limit) : 50;
  const offset = Number.isFinite(Number(filters.offset)) && Number(filters.offset) >= 0 ? Number(filters.offset) : 0;

  if (tombstones) {
    const rowsResult = await query(
      `SELECT date, weekday, title, kind, company, original_title
       FROM calendar_events_raw
       WHERE source = 'manual' AND ticker = '__deleted__'
       ORDER BY date DESC, title, company`
    );

    const groups = new Map<string, CalendarAdminEvent>();
    for (const r of rowsResult.rows) {
      const date = normalizeDbDate(r.date);
      const displayTitle = r.original_title || r.title || r.company;
      const kind = assertValidKind(r.kind);
      const key = `${date}|${displayTitle}|${r.company}|${kind}`;
      if (!groups.has(key)) {
        groups.set(key, {
          date,
          weekday: r.weekday,
          title: displayTitle,
          kind,
          status: 'expected',
          companies: [],
          companies_count: 0,
          sources: ['manual'],
          possible_duplicate: false,
          original_title: r.original_title || undefined,
        });
      }
      const group = groups.get(key)!;
      group.companies.push({ name: r.company, ticker: '__deleted__', sources: [] });
      group.companies_count++;
    }

    let events = Array.from(groups.values());
    events.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return a.title.localeCompare(b.title, 'ru');
    });

    const total = events.length;
    events = events.slice(offset, offset + limit);

    return { events, total };
  }

  const conditions: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (kind) {
    conditions.push(`kind = $${idx}`);
    params.push(kind);
    idx++;
  }
  if (status) {
    conditions.push(`status = $${idx}`);
    params.push(status);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rowsResult = await query(
    `SELECT date, weekday, title, kind, status, company, ticker, sources, possible_duplicate
     FROM calendar_events
     ${where}
     ORDER BY date DESC, title`,
    params
  );

  const groups = new Map<string, CalendarAdminEvent>();
  for (const r of rowsResult.rows) {
    const key = `${normalizeDbDate(r.date)}|${r.title}|${r.kind}|${r.status}`;
    if (!groups.has(key)) {
      groups.set(key, {
        date: normalizeDbDate(r.date),
        weekday: r.weekday,
        title: r.title,
        kind: assertValidKind(r.kind),
        status: assertValidStatus(r.status),
        companies: [],
        companies_count: 0,
        sources: [],
        possible_duplicate: false,
      });
    }
    const group = groups.get(key)!;
    const rowSources = parseSources(r.sources || '[]');
    group.companies.push({ name: r.company, ticker: r.ticker, sources: rowSources });
    group.companies_count++;
    for (const s of rowSources) {
      if (!group.sources!.includes(s)) group.sources!.push(s);
    }
    if (r.possible_duplicate) group.possible_duplicate = true;
  }

  let events = Array.from(groups.values());
  events.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return a.title.localeCompare(b.title, 'ru');
  });

  if (search) {
    const pat = search.toLowerCase();
    events = events.filter(
      (e) =>
        e.title.toLowerCase().includes(pat) ||
        e.companies.some(
          (c) => c.name.toLowerCase().includes(pat) || c.ticker.toLowerCase().includes(pat)
        )
    );
  }

  if (possibleDuplicate) {
    events = events.filter((e) => e.possible_duplicate);
  }

  const total = events.length;
  events = events.slice(offset, offset + limit);

  return { events, total };
}

export async function getCalendarEventGroup(
  date: string,
  title: string,
  kind: string
): Promise<CalendarAdminEvent | null> {
  const result = await query(
    `SELECT date, weekday, title, kind, status, company, ticker, sources
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
    sources: parseSources(r.sources || '[]'),
  }));

  const first = rows[0];
  const companies = rows.map((r: any) => ({ name: r.company, ticker: r.ticker, sources: r.sources }));

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
      `SELECT 1 FROM calendar_events_raw WHERE source = 'manual' AND date = $1 AND title = $2 AND kind = $3 LIMIT 1`,
      [validated.date, validated.title, validated.kind]
    );
    if (existing.rows.length > 0) {
      throw new CalendarAdminError('Event group already exists', 409);
    }

    for (const company of validated.companies) {
      await q(
        `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
         VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
        [validated.date, validated.weekday, validated.title, validated.kind, validated.status, company.name, company.ticker]
      );
    }

    await touchCalendarSource(q, 'manual');
    await rebuildCanonical(q);
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

  const oldGroup = await getCalendarEventGroup(oldDate, oldTitle, oldKind);
  if (!oldGroup) {
    throw new CalendarAdminError('Event group not found', 404);
  }

  const newMergeKeys = new Set(
    validated.companies.map((c) => mergeKey(validated.date, c.ticker, c.name))
  );

  await withCalendarTransaction(async (q) => {
    // Only delete manual rows for the old key; provider raw rows must stay untouched.
    await q(
      `DELETE FROM calendar_events_raw WHERE source = 'manual' AND date = $1 AND title = $2 AND kind = $3`,
      [oldDate, oldTitle, oldKind]
    );

    // Tombstone old merge keys that are no longer represented in the updated event
    // so provider data cannot resurrect a removed/changed company or date.
    for (const company of oldGroup.companies) {
      const oldKey = mergeKey(oldDate, company.ticker, company.name);
      if (!newMergeKeys.has(oldKey)) {
        const tombstoneTitle = company.ticker && company.ticker.toUpperCase() !== 'UNKNOWN'
          ? company.ticker.toUpperCase()
          : '';
        await q(
          `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at, tombstone_key, original_title)
           VALUES ('manual', $1, $2, $3, $4, 'expected', $5, '__deleted__', ${nowSql()}, $6, $7)`,
          [oldDate, oldGroup.weekday, tombstoneTitle, oldKind, company.name, oldKey, oldTitle]
        );
      }
    }

    for (const company of validated.companies) {
      await q(
        `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
         VALUES ('manual', $1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
        [validated.date, validated.weekday, validated.title, validated.kind, validated.status, company.name, company.ticker]
      );
    }

    await touchCalendarSource(q, 'manual');
    await rebuildCanonical(q);
  });

  broadcastCalendarRefresh();
  invalidateCalendarCache();
}

export async function deleteCalendarEventGroup(
  date: string,
  title: string,
  kind: string
): Promise<void> {
  const group = await getCalendarEventGroup(date, title, kind);
  if (!group) {
    throw new CalendarAdminError('Event group not found', 404);
  }

  await withCalendarTransaction(async (q) => {
    // Do not delete provider raw rows; insert tombstones to suppress the merge keys.
    for (const company of group.companies) {
      const tombstoneTitle = company.ticker && company.ticker.toUpperCase() !== 'UNKNOWN'
        ? company.ticker.toUpperCase()
        : '';
      const tombstoneKey = makeCanonicalKey(date, company.ticker, company.name);
      await q(
        `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at, tombstone_key, original_title)
         VALUES ('manual', $1, $2, $3, $4, 'expected', $5, '__deleted__', ${nowSql()}, $6, $7)`,
        [date, group.weekday, tombstoneTitle, kind, company.name, tombstoneKey, title]
      );
    }

    await touchCalendarSource(q, 'manual');
    await rebuildCanonical(q);
  });

  broadcastCalendarRefresh();
  invalidateCalendarCache();
}

export async function restoreCalendarEventGroup(
  date: string,
  title: string,
  company: string,
  originalTitle?: string
): Promise<void> {
  await withCalendarTransaction(async (q) => {
    const titleUpper = (title || '').toUpperCase();
    const hasOriginalTitle = originalTitle && originalTitle.length > 0;

    // Try the "title as ticker" key first. This handles known-ticker deletions
    // and UNKNOWN deletions where frontend sent an empty title.
    const keyAsTicker = makeCanonicalKey(date, titleUpper, company);
    const result = await q(
      `DELETE FROM calendar_events_raw
       WHERE source = 'manual' AND ticker = '__deleted__' AND tombstone_key = $1
         AND ($2 IS NULL OR original_title = $2)`,
      [keyAsTicker, hasOriginalTitle ? originalTitle : null]
    );

    // Fallback: the frontend may have sent the company name as title for an
    // UNKNOWN-ticker tombstone whose stored key uses the normalized company.
    const deleted = typeof result.rowCount === 'number' ? result.rowCount : 0;
    if (deleted === 0) {
      const keyAsCompany = makeCanonicalKey(date, 'UNKNOWN', company);
      await q(
        `DELETE FROM calendar_events_raw
         WHERE source = 'manual' AND ticker = '__deleted__' AND tombstone_key = $1
           AND ($2 IS NULL OR original_title = $2)`,
        [keyAsCompany, hasOriginalTitle ? originalTitle : null]
      );
    }

    await touchCalendarSource(q, 'manual');
    await rebuildCanonical(q);
  });

  broadcastCalendarRefresh();
  invalidateCalendarCache();
}

// ═══════════════════════════════════════════════════════════════════════════
// Stale alert (throttled)
// ═══════════════════════════════════════════════════════════════════════════

// Feed-провайдеры, за которыми следим на протухание.
const FEED_PROVIDERS = ['investmint', 'smartlab', 'bcs', 'global'];

/** Per-provider stale alerts. Проверяются только feed-провайдеры из calendar_sources;
 *  manual и legacy не алертятся. */
export async function maybeSendProviderStaleAlerts(): Promise<void> {
  const serverDate = await getMskDateString();
  const windowStart = addDays(serverDate, -2);

  const placeholders = FEED_PROVIDERS.map((_, i) => `$${i + 1}`).join(',');
  const sourcesResult = await query(
    `SELECT source, last_stale_alert_at FROM calendar_sources WHERE source IN (${placeholders})`,
    FEED_PROVIDERS
  );
  if (sourcesResult.rows.length === 0) return;

  const coverageResult = await query(
    `SELECT source, MAX(date) as max_date FROM calendar_events_raw
     WHERE source IN (${placeholders})
     GROUP BY source`,
    FEED_PROVIDERS
  );
  const coverageBySource = new Map<string, string>();
  for (const row of coverageResult.rows) {
    const maxDate = normalizeDbDate(row.max_date);
    if (maxDate) coverageBySource.set(row.source, maxDate);
  }

  const adminsResult = await query(
    `SELECT tg_chat_id FROM admin_tg_settings WHERE is_active = TRUE AND tg_chat_id IS NOT NULL`
  );
  if (adminsResult.rows.length === 0) return;

  for (const sourceRow of sourcesResult.rows) {
    const source = sourceRow.source;
    const coverage = coverageBySource.get(source);
    if (!coverage || coverage >= windowStart) continue;

    const lastAlert = sourceRow.last_stale_alert_at ? new Date(sourceRow.last_stale_alert_at).getTime() : 0;
    if (Date.now() - lastAlert < STALE_ALERT_COOLDOWN_MS) continue;

    const message = `Провайдер ${source} протух: покрытие до ${coverage} (серверная дата ${serverDate})`;

    let sent = 0;
    for (const admin of adminsResult.rows) {
      const ok = await sendTelegramMessage(admin.tg_chat_id, message, 'HTML');
      if (ok) sent++;
    }

    if (sent > 0) {
      await query(
        `INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at)
         VALUES ($1, ${nowSql()}, ${nowSql()})
         ON CONFLICT (source) DO UPDATE SET last_stale_alert_at = ${nowSql()}`,
        [source]
      );
      console.log(`[Calendar] Sent stale alert for ${source} to ${sent} admin(s)`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Calendar v2: raw slices, canonical rebuild, migrations
// ═══════════════════════════════════════════════════════════════════════════

function providerRank(source: string): number {
  const idx = PROVIDER_PRIORITY.indexOf(source);
  return idx === -1 ? PROVIDER_PRIORITY.length : idx;
}

const ORG_PREFIXES = new Set(['пао', 'ао', 'оао', 'зао', 'ооо', 'pao']);

function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[«»"'`]/g, '')
    .split(/\s+/)
    .filter((t) => t && !ORG_PREFIXES.has(t))
    .join(' ')
    .replace(/[^a-zа-яё0-9]+/g, ' ')
    .trim();
}

function makeCanonicalKey(date: string, ticker: string, company: string): string {
  const tickerUpper = (ticker || '').toUpperCase();
  if (tickerUpper && tickerUpper !== 'UNKNOWN') {
    return `${date}|${tickerUpper}`;
  }
  return `${date}|n:${normalizeCompanyName(company)}`;
}

function mergeKey(date: string, ticker: string, company: string): string {
  return makeCanonicalKey(date, ticker, company);
}

function pickRepresentative(rows: CalendarRawRow[]): CalendarRawRow {
  const sorted = [...rows].sort((a, b) => {
    const rankA = providerRank(a.source);
    const rankB = providerRank(b.source);
    if (rankA !== rankB) return rankA - rankB;
    if (b.title.length !== a.title.length) return b.title.length - a.title.length;
    return a.title.localeCompare(b.title, 'ru');
  });
  return sorted[0];
}

function dedupeSources(sources: string[]): string[] {
  const set = new Set(sources);
  const hasNonLegacy = Array.from(set).some((s) => s !== 'legacy');
  if (hasNonLegacy) {
    set.delete('legacy');
  }
  return Array.from(set).sort();
}

function assertValidKind(k: string): EventKind {
  if (VALID_KINDS.includes(k as EventKind)) return k as EventKind;
  return 'Другое';
}

function assertValidStatus(s: string): EventStatus {
  if (VALID_STATUSES.includes(s as EventStatus)) return s as EventStatus;
  return 'expected';
}

export interface ProviderSliceValidation {
  reject?: string;
  warnings: string[];
}

/** Sanity-проверки провайдерского среза перед записью. */
export function validateProviderSlice(
  _source: string,
  events: NormalizedEvent[],
  serverDate: string
): ProviderSliceValidation {
  const warnings: string[] = [];

  if (events.length === 0) {
    return { reject: 'формат не распознан', warnings };
  }

  const uniqueDates = new Set(events.map((e) => e.date));
  if (uniqueDates.size < 5) {
    return { reject: 'слишком короткий срез', warnings };
  }

  const dates = Array.from(uniqueDates).sort();
  const maxDate = dates[dates.length - 1];
  const windowStart = addDays(serverDate, -2);
  if (maxDate < windowStart) {
    warnings.push(`все даты в прошлом: max_date ${maxDate} < ${windowStart}`);
  }

  const noTickerEvents = events.filter((e) => e.companies.every((c) => !c.ticker || c.ticker === 'UNKNOWN'));
  if (noTickerEvents.length / events.length > 0.2) {
    warnings.push(`много событий без тикера: ${noTickerEvents.length}/${events.length}`);
  }

  return { warnings };
}

// In-memory single-flight сериализация ingestProviderSlice.
let ingestFlight: Promise<unknown> = Promise.resolve();

interface IngestResult {
  canonical: CanonicalRow[];
  generatedAt: string | null;
  diff: DiffResult;
}

/** Заменяет срез провайдера и пересобирает канон. dry_run не пишет в БД.
 *  Снапшот канона снимается внутри single-flight, чтобы diff атрибутировался
 *  корректно при параллельных загрузках. */
export async function ingestProviderSlice(
  source: string,
  flatRows: CalendarRawRow[],
  dryRun: boolean,
  warnings: string[] = []
): Promise<IngestResult> {
  const run = async (): Promise<IngestResult> => {
    const snapshot = await getCanonicalSnapshot();

    if (dryRun) {
      const rawResult = await query(
        `SELECT source, date, weekday, title, kind, status, company, ticker, tombstone_key, original_title
         FROM calendar_events_raw`
      );
      const existingRows: CalendarRawRow[] = rawResult.rows.map((r: any) => ({
        source: r.source,
        date: normalizeDbDate(r.date),
        weekday: r.weekday,
        title: r.title,
        kind: r.kind,
        status: r.status,
        company: r.company,
        ticker: r.ticker,
        tombstone_key: r.tombstone_key || undefined,
        original_title: r.original_title || undefined,
      }));
      const simulated = existingRows.filter((r) => r.source !== source).concat(flatRows);
      const canonical = buildCanonicalRows(simulated);
      const generatedAt = await getGeneratedAt();
      const diff = computeDiff(snapshot, canonical);
      return { canonical, generatedAt, diff };
    }

    const { canonical } = await withCalendarTransaction(async (q) => {
      await q(`DELETE FROM calendar_events_raw WHERE source = $1`, [source]);

      for (const row of flatRows) {
        await q(
          `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${nowSql()})`,
          [source, row.date, row.weekday, row.title, row.kind, row.status, row.company, row.ticker]
        );
      }

      await q(
        `INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at, last_warnings)
         VALUES ($1, ${nowSql()}, NULL, $2)
         ON CONFLICT (source) DO UPDATE SET uploaded_at = ${nowSql()}, last_stale_alert_at = NULL, last_warnings = $2`,
        [source, JSON.stringify(warnings)]
      );

      const { canonical } = await rebuildCanonical(q);
      return { canonical, generatedAt: null };
    });

    const generatedAt = await getGeneratedAt();
    const diff = computeDiff(snapshot, canonical);
    return { canonical, generatedAt, diff };
  };

  const p = ingestFlight.then(run, run);
  ingestFlight = p;
  try {
    return await p;
  } finally {
    // не сбрасываем ingestFlight = null, чтобы последовательность оставалась корректной
  }
}

export interface DiffResult {
  counts: {
    new_events: number;
    updated_events: number;
    confirmed_upgrades: number;
    confirmations: number;
    removed_events: number;
  };
  samples: {
    new: string[];
    removed: string[];
    upgraded: string[];
    updated?: string[];
  };
  nonempty: boolean;
}

function canonicalDiffKey(row: CanonicalRow): string {
  return `${makeCanonicalKey(row.date, row.ticker, row.company)}|${row.kind}`;
}

function parseSources(sources: string): string[] {
  try {
    const parsed = JSON.parse(sources);
    if (Array.isArray(parsed)) return parsed as string[];
  } catch { /* ignore */ }
  return [];
}

/** Сравнивает текущий канон (snapshot) с новым. */
export function computeDiff(
  snapshot: Map<string, CanonicalRow[]>,
  newCanonical: CanonicalRow[]
): DiffResult {
  const newMap = new Map<string, CanonicalRow[]>();
  for (const row of newCanonical) {
    const key = canonicalDiffKey(row);
    if (!newMap.has(key)) newMap.set(key, []);
    newMap.get(key)!.push(row);
  }

  const counts = {
    new_events: 0,
    updated_events: 0,
    confirmed_upgrades: 0,
    confirmations: 0,
    removed_events: 0,
  };

  const samples = {
    new: [] as string[],
    removed: [] as string[],
    upgraded: [] as string[],
    updated: [] as string[],
  };

  for (const [key, newRows] of newMap) {
    const oldRows = snapshot.get(key);
    if (!oldRows || oldRows.length === 0) {
      counts.new_events++;
      if (samples.new.length < 20) samples.new.push(key);
      continue;
    }

    const old = oldRows[0];
    const next = newRows[0];

    const titleChanged = old.title !== next.title;
    const companyChanged = old.company !== next.company;
    if (titleChanged || companyChanged) {
      counts.updated_events++;
      if (samples.updated.length < 20) samples.updated.push(key);
    }

    if (old.status === 'expected' && next.status === 'confirmed') {
      counts.confirmed_upgrades++;
      if (samples.upgraded.length < 20) samples.upgraded.push(key);
    }

    const oldSources = new Set(parseSources(old.sources));
    const newSources = parseSources(next.sources);
    const grew = newSources.some((s) => !oldSources.has(s));
    if (grew) {
      counts.confirmations++;
    }
  }

  for (const [key] of snapshot) {
    if (!newMap.has(key)) {
      counts.removed_events++;
      if (samples.removed.length < 20) samples.removed.push(key);
    }
  }

  const nonempty =
    counts.new_events > 0 ||
    counts.updated_events > 0 ||
    counts.confirmed_upgrades > 0 ||
    counts.confirmations > 0 ||
    counts.removed_events > 0;

  return { counts, samples, nonempty };
}

/** Читает текущий канон и группирует по ключу диффа. */
export async function getCanonicalSnapshot(): Promise<Map<string, CanonicalRow[]>> {
  const result = await query(
    `SELECT date, weekday, title, kind, status, company, ticker, sources, possible_duplicate
     FROM calendar_events
     ORDER BY date, title`
  );
  const rows: CanonicalRow[] = result.rows.map((r: any) => ({
    date: normalizeDbDate(r.date),
    weekday: r.weekday,
    title: r.title,
    kind: assertValidKind(r.kind),
    status: assertValidStatus(r.status),
    company: r.company,
    ticker: r.ticker,
    sources: r.sources || '[]',
    possible_duplicate: r.possible_duplicate ? true : false,
  }));

  const snapshot = new Map<string, CanonicalRow[]>();
  for (const row of rows) {
    const key = canonicalDiffKey(row);
    if (!snapshot.has(key)) snapshot.set(key, []);
    snapshot.get(key)!.push(row);
  }
  return snapshot;
}

/** Чистая функция: из сырых строк строит канонический срез (без записи в БД). */
export function buildCanonicalRows(rawRows: CalendarRawRow[]): CanonicalRow[] {
  return buildCanonicalRowsWithStats(rawRows).canonical;
}

function buildCanonicalRowsWithStats(rawRows: CalendarRawRow[]): { canonical: CanonicalRow[]; duplicateCount: number } {
  const rows = rawRows.map((r) => ({
    ...r,
    kind: assertValidKind(r.kind),
    status: assertValidStatus(r.status),
    tombstone_key: r.tombstone_key,
    original_title: r.original_title,
  }));

  // Tombstones are manual marker rows that suppress any canonical group with the same merge key.
  // Prefer the persisted tombstone_key; fall back to deriving it from legacy rows for backwards compatibility.
  const tombstoneKeys = new Set<string>();
  const regularRows: typeof rows = [];
  for (const row of rows) {
    if (row.source === 'manual' && row.ticker === '__deleted__') {
      if (row.tombstone_key) {
        tombstoneKeys.add(row.tombstone_key);
      } else {
        const titleUpper = (row.title || '').toUpperCase();
        if (titleUpper) {
          tombstoneKeys.add(`${row.date}|${titleUpper}`);
        } else {
          tombstoneKeys.add(`${row.date}|n:${normalizeCompanyName(row.company)}`);
        }
      }
      continue;
    }
    regularRows.push(row);
  }

  const groups = new Map<string, CalendarRawRow[]>();
  for (const row of regularRows) {
    const key = makeCanonicalKey(row.date, row.ticker, row.company);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  const canonical: CanonicalRow[] = [];
  let duplicateCount = 0;

  for (const [groupKey, groupRows] of groups) {
    if (tombstoneKeys.has(groupKey)) continue;
    const allSources = dedupeSources(groupRows.map((r) => r.source));

    const kindMap = new Map<EventKind, CalendarRawRow[]>();
    for (const row of groupRows) {
      if (!kindMap.has(row.kind)) kindMap.set(row.kind, []);
      kindMap.get(row.kind)!.push(row);
    }

    const concreteKinds = VALID_KINDS.filter((k) => k !== 'Другое' && kindMap.has(k));
    const outputKinds: EventKind[] = concreteKinds.length > 0 ? concreteKinds : ['Другое'];
    const fallbackConfirmed = kindMap.get('Другое')?.some((r) => r.status === 'confirmed') ?? false;

    for (const kind of outputKinds) {
      const kindRows = kindMap.get(kind) || [];
      const representative = pickRepresentative(kindRows.length > 0 ? kindRows : groupRows);
      const status = kindRows.some((r) => r.status === 'confirmed') || (fallbackConfirmed && kind !== 'Другое')
        ? 'confirmed'
        : 'expected';

      canonical.push({
        date: representative.date,
        weekday: getWeekday(representative.date),
        title: representative.title,
        kind,
        status,
        company: representative.company,
        ticker: representative.ticker.toUpperCase(),
        sources: JSON.stringify(allSources),
        possible_duplicate: outputKinds.length > 1,
      });

      if (outputKinds.length > 1) duplicateCount++;
    }
  }

  canonical.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return a.title.localeCompare(b.title, 'ru');
  });

  return { canonical, duplicateCount };
}

export interface RebuildCanonicalResult {
  rawCount: number;
  canonicalCount: number;
  duplicateCount: number;
  canonical: CanonicalRow[];
}

export async function rebuildCanonical(q: QueryFn = query): Promise<RebuildCanonicalResult> {
  const rawResult = await q(
    `SELECT source, date, weekday, title, kind, status, company, ticker, tombstone_key, original_title
     FROM calendar_events_raw
     ORDER BY date, ticker, title, kind, source`
  );

  const rawRows: CalendarRawRow[] = rawResult.rows.map((r: any) => ({
    source: r.source,
    date: normalizeDbDate(r.date),
    weekday: r.weekday,
    title: r.title,
    kind: r.kind,
    status: r.status,
    company: r.company,
    ticker: r.ticker,
    tombstone_key: r.tombstone_key || undefined,
    original_title: r.original_title || undefined,
  }));

  const { canonical, duplicateCount } = buildCanonicalRowsWithStats(rawRows);

  await q('DELETE FROM calendar_events');
  for (const row of canonical) {
    await q(
      `INSERT INTO calendar_events (date, weekday, title, kind, status, company, ticker, uploaded_at, sources, possible_duplicate, tag_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, ${nowSql()}, $8, $9, NULL)`,
      [row.date, row.weekday, row.title, row.kind, row.status, row.company, row.ticker, row.sources, row.possible_duplicate]
    );
  }

  return {
    rawCount: rawRows.length,
    canonicalCount: canonical.length,
    duplicateCount,
    canonical,
  };
}

export async function migrateExistingCalendarToRaw(q: QueryFn = query): Promise<void> {
  const rawCount = await q('SELECT COUNT(*) as c FROM calendar_events_raw');
  if (Number(rawCount.rows[0]?.c || 0) > 0) return;

  const existing = await q(
    `SELECT date, weekday, title, kind, status, company, ticker
     FROM calendar_events`
  );
  if (existing.rows.length === 0) return;

  for (const row of existing.rows) {
    await q(
      `INSERT INTO calendar_events_raw (source, date, weekday, title, kind, status, company, ticker, uploaded_at)
       VALUES ('legacy', $1, $2, $3, $4, $5, $6, $7, ${nowSql()})`,
      [
        normalizeDbDate(row.date),
        row.weekday,
        row.title,
        row.kind,
        row.status,
        row.company,
        (row.ticker || '').toUpperCase(),
      ]
    );
  }

  const metaResult = await q('SELECT uploaded_at FROM calendar_meta WHERE id = 1');
  const uploadedAt = metaResult.rows[0]?.uploaded_at || new Date().toISOString();
  await q(
    `INSERT INTO calendar_sources (source, uploaded_at, last_stale_alert_at)
     VALUES ('legacy', $1, NULL)
     ON CONFLICT (source) DO UPDATE SET uploaded_at = $1, last_stale_alert_at = NULL`,
    [uploadedAt]
  );

  console.log(`[Calendar] Migrated ${existing.rows.length} legacy rows to raw`);
}

async function ensureCalendarEventsUniquePostgres(q: QueryFn): Promise<void> {
  const existing = await q(
    `SELECT conname, pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'calendar_events'::regclass AND contype = 'u'`
  );

  const hasNew = existing.rows.some((r: any) => r.def?.includes('(date, title, kind, ticker)'));
  if (hasNew) return;

  const oldRow = existing.rows.find((r: any) =>
    r.def?.includes('(date, title, ticker)') && !r.def?.includes('kind')
  );
  if (oldRow) {
    await q(`ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS ${oldRow.conname}`);
  }

  await q(`ALTER TABLE calendar_events ADD CONSTRAINT cal_events_uniq UNIQUE (date, title, kind, ticker)`);
}

async function ensureCalendarEventsColumnsPostgres(q: QueryFn): Promise<void> {
  await q(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS sources TEXT`);
  await q(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS possible_duplicate BOOLEAN DEFAULT FALSE`);
  await q(`ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS tag_ids TEXT`);
  await q(`ALTER TABLE calendar_sources ADD COLUMN IF NOT EXISTS last_warnings TEXT`);
}

async function ensureCalendarEventsColumnsSQLite(q: QueryFn): Promise<void> {
  const info = await q(`PRAGMA table_info(calendar_events)`);
  const existing = new Set(info.rows.map((r: any) => r.name));
  if (!existing.has('sources')) await q(`ALTER TABLE calendar_events ADD COLUMN sources TEXT`);
  if (!existing.has('possible_duplicate')) await q(`ALTER TABLE calendar_events ADD COLUMN possible_duplicate INTEGER DEFAULT 0`);
  if (!existing.has('tag_ids')) await q(`ALTER TABLE calendar_events ADD COLUMN tag_ids TEXT`);
}

async function ensureCalendarSourcesColumnsPostgres(q: QueryFn): Promise<void> {
  await q(`ALTER TABLE calendar_sources ADD COLUMN IF NOT EXISTS last_warnings TEXT`);
}

async function ensureCalendarSourcesColumnsSQLite(q: QueryFn): Promise<void> {
  const info = await q(`PRAGMA table_info(calendar_sources)`);
  const existing = new Set(info.rows.map((r: any) => r.name));
  if (!existing.has('last_warnings')) await q(`ALTER TABLE calendar_sources ADD COLUMN last_warnings TEXT`);
}

async function ensureCalendarEventsRawColumnsPostgres(q: QueryFn): Promise<void> {
  await q(`ALTER TABLE calendar_events_raw ADD COLUMN IF NOT EXISTS tombstone_key TEXT`);
  await q(`ALTER TABLE calendar_events_raw ADD COLUMN IF NOT EXISTS original_title TEXT`);
}

async function ensureCalendarEventsRawColumnsSQLite(q: QueryFn): Promise<void> {
  const info = await q(`PRAGMA table_info(calendar_events_raw)`);
  const existing = new Set(info.rows.map((r: any) => r.name));
  if (!existing.has('tombstone_key')) await q(`ALTER TABLE calendar_events_raw ADD COLUMN tombstone_key TEXT`);
  if (!existing.has('original_title')) await q(`ALTER TABLE calendar_events_raw ADD COLUMN original_title TEXT`);
}

async function ensureCalendarEventsUniqueSQLite(q: QueryFn): Promise<void> {
  const info = await q(`SELECT sql FROM sqlite_master WHERE type='table' AND name='calendar_events'`);
  const createSql: string = info.rows[0]?.sql || '';
  if (createSql.includes('UNIQUE (date, title, kind, ticker)')) return;

  // SQLite/sql.js: db.export() (called by saveDb after every write) closes active transactions,
  // so explicit BEGIN/COMMIT cannot safely wrap DDL here. Run steps in autocommit mode.
  await q(`CREATE TABLE calendar_events_new (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    date DATE NOT NULL,
    weekday VARCHAR(2) NOT NULL,
    title TEXT NOT NULL,
    kind VARCHAR(10) NOT NULL,
    status VARCHAR(10) NOT NULL,
    company VARCHAR(100) NOT NULL,
    ticker VARCHAR(10) NOT NULL,
    uploaded_at TIMESTAMP DEFAULT (datetime('now')),
    sources TEXT,
    possible_duplicate INTEGER DEFAULT 0,
    tag_ids TEXT,
    UNIQUE (date, title, kind, ticker)
  )`);

  await q(
    `INSERT INTO calendar_events_new (id, date, weekday, title, kind, status, company, ticker, uploaded_at, sources, possible_duplicate, tag_ids)
     SELECT id, date, weekday, title, kind, status, company, ticker, uploaded_at, NULL, NULL, NULL FROM calendar_events`
  );

  await q(`DROP TABLE calendar_events`);
  await q(`ALTER TABLE calendar_events_new RENAME TO calendar_events`);
  await q(`CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date)`);
}

export async function runCalendarV2Migrations(): Promise<void> {
  if (USE_SQLITE) {
    await ensureCalendarEventsUniqueSQLite(query);
    await ensureCalendarEventsColumnsSQLite(query);
    await ensureCalendarSourcesColumnsSQLite(query);
    await ensureCalendarEventsRawColumnsSQLite(query);
  } else {
    await ensureCalendarEventsColumnsPostgres(query);
    await ensureCalendarSourcesColumnsPostgres(query);
    await ensureCalendarEventsUniquePostgres(query);
    await ensureCalendarEventsRawColumnsPostgres(query);
  }

  await migrateExistingCalendarToRaw(query);

  const rawCount = await query('SELECT COUNT(*) as c FROM calendar_events_raw');
  if (Number(rawCount.rows[0]?.c || 0) > 0) {
    const result = await withCalendarTransaction(async (q) => rebuildCanonical(q));
    console.log(`[Calendar] Rebuilt canonical: ${result.canonicalCount} rows from ${result.rawCount} raw (duplicates: ${result.duplicateCount})`);
  }
}
