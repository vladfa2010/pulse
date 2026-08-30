import { CalendarAdapter, NormalizedEvent, ParseWarnings, EventKind, EventStatus, NormalizedCompany } from './types'
import { investmintAdapter } from './investmint'
import { smartlabAdapter } from './smartlab'
import { bcsAdapter } from './bcs'
import { globalAdapter } from './global'

export * from './types'
export { investmintAdapter, smartlabAdapter, bcsAdapter, globalAdapter }
export { detectKind, detectStatus } from './classify'
export { pad, inferYear, getWeekday } from './dateUtils'

const FEED_SOURCES = new Set(['investmint', 'smartlab', 'bcs', 'global'])

const ADAPTERS: CalendarAdapter[] = [investmintAdapter, smartlabAdapter, bcsAdapter, globalAdapter]

export function isFeedSource(source: string): boolean {
  return FEED_SOURCES.has(source)
}

export function isAdapterReady(source: string): boolean {
  const adapter = getAdapterBySource(source)
  return !!adapter && !adapter.stub
}

export function getAdapters(): CalendarAdapter[] {
  return ADAPTERS
}

export function getAdapterBySource(source: string): CalendarAdapter | undefined {
  return ADAPTERS.find((a) => a.source === source)
}

export interface DetectResult {
  adapter: CalendarAdapter
  score: number
}

export function detectAdapter(raw: unknown): { adapter: CalendarAdapter | null; ambiguous: boolean } {
  const scores: DetectResult[] = ADAPTERS
    .map((adapter) => ({ adapter, score: adapter.detect(raw) }))
    .filter((r) => r.score >= 0.5)
    .sort((a, b) => b.score - a.score)

  if (scores.length === 0) {
    return { adapter: null, ambiguous: false }
  }

  if (scores.length >= 2 && Math.abs(scores[0].score - scores[1].score) < 0.001) {
    return { adapter: null, ambiguous: true }
  }

  return { adapter: scores[0].adapter, ambiguous: false }
}

export interface CalendarRawRow {
  source: string
  date: string
  weekday: string
  title: string
  kind: EventKind
  status: EventStatus
  company: string
  ticker: string
}

/** Превращает нормализованные события в плоские raw-строки (1 строка = 1 компания).
 *  Shape совпадает с тем, что читает rebuildCanonical. */
export function toRawRows(events: NormalizedEvent[], source: string): CalendarRawRow[] {
  const rows: CalendarRawRow[] = []
  for (const ev of events) {
    if (!ev.companies || ev.companies.length === 0) continue
    for (const company of ev.companies) {
      rows.push({
        source,
        date: ev.date,
        weekday: ev.weekday,
        title: ev.title,
        kind: ev.kind,
        status: ev.status,
        company: company.name,
        ticker: company.ticker.toUpperCase(),
      })
    }
  }
  return rows
}
