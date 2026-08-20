/**
 * IANA timezones per MIC (ISO 10383) for Finam market data.
 * Unknown MICs fall back to UTC with a one-time warning.
 */

/** IANA timezones per MIC. Covers Finam's main venues; unknown → UTC + warn. */
export const MIC_TIMEZONE: Record<string, string> = {
  MISX: 'Europe/Moscow', RUSX: 'Europe/Moscow', SPBX: 'Europe/Moscow',
  XNGS: 'America/New_York', XNYS: 'America/New_York', ARCX: 'America/New_York',
  BATS: 'America/New_York', XNCM: 'America/New_York', IEXG: 'America/New_York',
  XCME: 'America/Chicago', XCBT: 'America/Chicago', XNYM: 'America/New_York',
  XLON: 'Europe/London',
  XETR: 'Europe/Berlin', XFRA: 'Europe/Berlin',
  XPAR: 'Europe/Paris', XAMS: 'Europe/Amsterdam', XMAD: 'Europe/Madrid', XMIL: 'Europe/Rome',
  XHKG: 'Asia/Hong_Kong', XTKS: 'Asia/Tokyo', XSHG: 'Asia/Shanghai', XSES: 'Asia/Singapore',
  XTSE: 'America/Toronto',
};

const warned = new Map<string, number>(); // mic → count of hits

export function micTimezone(mic: string): string {
  const tz = MIC_TIMEZONE[mic?.toUpperCase()];
  if (tz) return tz;
  const key = (mic || '?').toUpperCase();
  warned.set(key, (warned.get(key) ?? 0) + 1);
  if (warned.get(key) === 1) console.warn(`[market] no timezone for MIC ${key}, using UTC`);
  return 'UTC';
}

/** For admin UI: which MICs hit the UTC fallback. */
export function getTimezoneWarnings(): { mic: string; hits: number }[] {
  return [...warned.entries()].map(([mic, hits]) => ({ mic, hits }));
}

/** YYYY-MM-DD of `iso` instant in exchange timezone. */
export function dateInTz(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
}

/** Add `days` to a YYYY-MM-DD calendar date (tz-agnostic string shift). */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 'HH:mm' label of `iso` in exchange timezone. */
export function timeInTz(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
}

/**
 * Convert a calendar date (YYYY-MM-DD) in a specific timezone to a UTC Date
 * representing the midnight start of that day in the given timezone.
 * Offset is resolved iteratively — correct across DST transitions.
 */
export function zonedMidnightToUtc(dateStr: string, tz: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  // initial guess: treat as UTC
  let guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
    const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second);
    const offset = asIfUtc - guess; // how much tz adds to UTC
    const target = Date.UTC(y, m - 1, d) - offset;
    if (target === guess) break;
    guess = target;
  }
  return new Date(guess);
}
