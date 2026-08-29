/**
 * Типы адаптеров провайдеров календаря.
 * NormalizedEvent — промежуточный формат между сырым JSON провайдера
 * и строками calendar_events_raw. Source не хранится в событии:
 * конвейер М3 знает адаптер и проставляет source при записи в raw.
 */

export type EventKind = 'МСФО' | 'РСБУ' | 'СД' | 'СА' | 'Дивиденды' | 'Другое'
export type EventStatus = 'confirmed' | 'expected'

export interface NormalizedCompany {
  name: string
  ticker: string
}

export interface NormalizedEvent {
  date: string        // YYYY-MM-DD
  weekday: string     // 'пн'..'вс'
  title: string
  kind: EventKind
  status: EventStatus
  companies: NormalizedCompany[]
}

export interface ParseWarnings {
  noTicker: number
  skipped: number
  invalidDates: number
  details: string[]
}

export interface CalendarAdapter {
  source: string
  detect(raw: unknown): number   // 0–1, уверенность
  parse(raw: unknown): { events: NormalizedEvent[]; warnings: ParseWarnings }
}
