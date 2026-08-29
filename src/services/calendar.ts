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

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const VALID_KINDS: EventKind[] = ['МСФО', 'РСБУ', 'СД', 'СА', 'Дивиденды', 'Другое'];
const VALID_STATUSES: EventStatus[] = ['confirmed', 'expected'];

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const STALE_ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

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

  return {
    daysCount: days.length,
    eventsCount: flatRows.length,
  };
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
