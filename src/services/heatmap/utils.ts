/**
 * News heatmap utilities (TZ 11.11).
 * Timezone-aware helpers and math for daily/hourly/year aggregates.
 */

import crypto from 'crypto';

export const DEFAULT_TZ = 'Europe/Moscow';
export const HOURS_DAYS = 14;
export const WEEKS = 53;

export type Scope = 'portfolio' | 'tag' | 'all';

export interface HeatmapCell {
  date: string;
  stories: number;
  pos: number;
  neg: number;
  resonance: number;
  sentiment_sign: 1 | -1 | 0 | null;
  spike?: boolean;
}

export function portfolioKey(tags: string[]): string {
  return crypto.createHash('sha256').update([...tags].sort().join('|')).digest('hex').slice(0, 16);
}

export function sqliteOffset(tz: string): string {
  // SQLite only supports fixed offset; Europe/Moscow is +03:00 year-round.
  if (tz === 'Europe/Moscow') return '+3 hours';
  return '+0 hours';
}

export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const k = (sorted.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) return sorted[f];
  return sorted[f] * (c - k) + sorted[c] * (k - f);
}

export function spikeThreshold(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const median = quantile(sorted, 0.5);
  return Math.max(median * 3, median + 3);
}

export function toMskDateString(d: Date): string {
  const msk = new Date(d.getTime() + 3 * 3600 * 1000);
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const day = String(msk.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function beginEndMsk(): { begin: string; end: string } {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const y = msk.getUTCFullYear();
  const m = String(msk.getUTCMonth() + 1).padStart(2, '0');
  const d = String(msk.getUTCDate()).padStart(2, '0');
  return {
    begin: `${y}-${m}-${d} 00:00:00+03`,
    end: `${y}-${m}-${d} 23:59:59+03`,
  };
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

export function buildYearDates(): string[] {
  const dates: string[] = [];
  const today = new Date();
  // 53 weeks * 7 days = 371 days, aligned to Monday.
  const currentMsk = new Date(today.getTime() + 3 * 3600 * 1000);
  const end = new Date(Date.UTC(
    currentMsk.getUTCFullYear(),
    currentMsk.getUTCMonth(),
    currentMsk.getUTCDate()
  ));
  // Move back to Monday of current week.
  const dayOfWeek = end.getUTCDay(); // 0=Sun, 1=Mon
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  end.setDate(end.getUTCDate() + mondayOffset + 6); // last Sunday of 53-week window
  const start = new Date(end.getTime());
  start.setDate(start.getUTCDate() - 53 * 7 + 1); // first Monday

  for (let d = new Date(start); d <= end; d.setDate(d.getUTCDate() + 1)) {
    dates.push(isoDate(d));
  }
  return dates;
}
