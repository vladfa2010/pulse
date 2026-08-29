import { CalendarAdapter, NormalizedEvent, ParseWarnings, NormalizedCompany } from './types'
import { detectKind, detectStatus } from './classify'
import { pad, inferYear, getWeekday } from './dateUtils'

const MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
}

const COMPANY_RE = /^([АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯA-Z])\s+(.+?)\s+([A-Z][A-Z0-9.]*)$/

const WD_MAP: Record<string, string> = {
  пн: 'пн', вт: 'вт', ср: 'ср', чт: 'чт', пт: 'пт', сб: 'сб', вс: 'вс',
}

interface RawInvestmintItem {
  date: string
  events: string[]
  fullText?: string
}

export const investmintAdapter: CalendarAdapter = {
  source: 'investmint',

  detect(raw: unknown): number {
    if (!Array.isArray(raw) || raw.length === 0) return 0
    const sample = raw.slice(0, 3)
    let score = 0
    let checks = 0
    for (const item of sample) {
      if (!item || typeof item !== 'object') continue
      checks++
      const i = item as any
      if (typeof i.date === 'string' && /^\d{1,2}\s+[а-яё]+/i.test(i.date)) {
        score += 0.5
      }
      if (Array.isArray(i.events)) {
        score += 0.5
      }
    }
    return checks === 0 ? 0 : score / checks
  },

  parse(raw: unknown): { events: NormalizedEvent[]; warnings: ParseWarnings } {
    const warnings: ParseWarnings = { noTicker: 0, skipped: 0, invalidDates: 0, details: [] }
    const events: NormalizedEvent[] = []
    const rawItems = raw as RawInvestmintItem[]

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

      for (const ev of item.events || []) {
        const tokens = splitTokens(ev)
        if (tokens.length < 2) {
          warnings.skipped++
          warnings.details.push(`skipped event with <2 tokens on ${parsed.date}: ${ev}`)
          continue
        }

        const title = tokens[0]
        const companies: NormalizedCompany[] = []
        for (const tok of tokens.slice(1)) {
          const c = parseCompany(tok)
          if (c) companies.push(c)
        }
        if (companies.length === 0) {
          warnings.skipped++
          warnings.details.push(`skipped event without companies on ${parsed.date}: ${ev}`)
          continue
        }

        const kind = detectKind(title)
        const status = detectStatus(title)
        const key = `${title}|${kind}`

        if (!day.groups.has(key)) {
          day.groups.set(key, { date: parsed.date, weekday: day.weekday, title, kind, status, companies: [] })
        }
        const group = day.groups.get(key)!
        for (const c of companies) {
          if (!group.companies.some((x) => x.ticker === c.ticker)) {
            group.companies.push(c)
          }
        }
      }
    }

    for (const [date, day] of grouped) {
      for (const group of day.groups.values()) {
        group.companies.sort((a, b) => a.ticker.localeCompare(b.ticker))
        // sanity-check weekday: дата важнее, weekday всё равно перевычисляется в canonical
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
  const m = str.match(/^(\d{1,2})\s+([а-яё]+)\s+(\S+)\s*$/i)
  if (!m) return null
  const [, day, monthRaw, wdRaw] = m
  const month = MONTHS[monthRaw.toLowerCase()]
  if (!month) return null
  const weekday = WD_MAP[wdRaw.toLowerCase()] || wdRaw.toLowerCase().slice(0, 2)
  const year = inferYear(month)
  const date = `${year}-${pad(month)}-${pad(parseInt(day, 10))}`
  return { date, weekday }
}

function splitTokens(s: string): string[] {
  return s
    .split(/\s{2,}/)
    .map((t) => t.trim())
    .filter(Boolean)
}

function parseCompany(token: string): NormalizedCompany | null {
  const m = token.match(COMPANY_RE)
  if (!m) return null
  return { name: m[2].trim(), ticker: m[3].trim().toUpperCase() }
}
