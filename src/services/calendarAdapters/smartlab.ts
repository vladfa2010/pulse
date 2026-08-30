import { CalendarAdapter, NormalizedEvent, ParseWarnings, NormalizedCompany } from './types'
import { detectKind, detectStatus } from './classify'
import { pad, getWeekday } from './dateUtils'

interface RawSmartlabItem {
  date: string
  time?: string
  title: string
  text?: string
}

export const smartlabAdapter: CalendarAdapter = {
  source: 'smartlab',
  stub: false,

  detect(raw: unknown): number {
    if (!Array.isArray(raw) || raw.length === 0) return 0
    const sample = raw.slice(0, 3)
    let score = 0
    let checks = 0
    for (const item of sample) {
      if (!item || typeof item !== 'object') continue
      checks++
      const i = item as any
      if (typeof i.date === 'string' && /^\d{2}\.\d{2}\.\d{4}$/.test(i.date)) {
        score += 0.5
      }
      if (typeof i.title === 'string' && i.title.length > 0) {
        score += 0.5
      }
    }
    return checks === 0 ? 0 : score / checks
  },

  parse(raw: unknown): { events: NormalizedEvent[]; warnings: ParseWarnings } {
    const warnings: ParseWarnings = { noTicker: 0, skipped: 0, invalidDates: 0, details: [] }
    const events: NormalizedEvent[] = []
    const rawItems = raw as RawSmartlabItem[]

    const grouped = new Map<string, { weekday: string; groups: Map<string, NormalizedEvent> }>()

    for (const item of rawItems) {
      const parsed = parseDate(item.date)
      if (!parsed) {
        warnings.invalidDates++
        warnings.details.push(`invalid date skipped: ${item.date}`)
        continue
      }

      if (!grouped.has(parsed.date)) {
        grouped.set(parsed.date, { weekday: parsed.weekday, groups: new Map() })
      }
      const day = grouped.get(parsed.date)!

      const fullTitle = (item.title || '').trim()
      if (!fullTitle) {
        warnings.skipped++
        warnings.details.push(`skipped empty title on ${parsed.date}`)
        continue
      }

      const parsedTitle = parseTickerTitle(fullTitle)
      const ticker = parsedTitle.ticker || 'UNKNOWN'
      if (!parsedTitle.ticker) {
        warnings.noTicker++
      }

      const kind = detectKind(parsedTitle.title)
      const status = detectStatus(parsedTitle.title)
      const title = parsedTitle.title
      const key = `${title}|${kind}`

      if (!day.groups.has(key)) {
        day.groups.set(key, { date: parsed.date, weekday: day.weekday, title, kind, status, companies: [] })
      }
      const group = day.groups.get(key)!

      const companyName = parsedTitle.ticker ? parsedTitle.ticker : fullTitle
      if (!group.companies.some((x) => x.ticker === ticker)) {
        group.companies.push({ name: companyName, ticker })
      }
    }

    for (const [date, day] of grouped) {
      for (const group of day.groups.values()) {
        group.companies.sort((a, b) => a.ticker.localeCompare(b.ticker))
        const expectedWeekday = getWeekday(group.date)
        if (group.weekday && expectedWeekday && group.weekday !== expectedWeekday) {
          warnings.details.push(
            `weekday mismatch on ${group.date}: file=${group.weekday}, computed=${expectedWeekday}`
          )
        }
        events.push(group)
      }
    }

    events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title, 'ru'))
    return { events, warnings }
  },
}

function parseDate(str: string): { date: string; weekday: string } | null {
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (!m) return null
  const [, day, month, year] = m
  const date = `${year}-${month}-${day}`
  // Sanity: reject impossible dates like 01.13.2026
  const d = new Date(`${date}T00:00:00Z`)
  if (isNaN(d.getTime()) || d.getUTCFullYear() !== Number(year) || d.getUTCMonth() + 1 !== Number(month) || d.getUTCDate() !== Number(day)) {
    return null
  }
  const weekday = getWeekday(date)
  return { date, weekday }
}

function parseTickerTitle(fullTitle: string): { ticker: string; title: string } {
  const m = fullTitle.match(/^([A-Z][A-Z0-9]{1,5})(?:\s*[:\-]\s*)(.+)$/)
  if (m) {
    return { ticker: m[1].trim().toUpperCase(), title: m[2].trim() }
  }
  return { ticker: '', title: fullTitle.trim() }
}
