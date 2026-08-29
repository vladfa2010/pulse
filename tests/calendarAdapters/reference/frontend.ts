/**
 * Замороженный эталон фронтовых парсеров из src/pages/admin/CalendarTab.tsx.
 * Используется только для parity-теста бэкенд-адаптеров.
 * Если фронт меняется до М4 — эталон надо синхронизировать.
 */

export type EventKind = 'МСФО' | 'РСБУ' | 'СД' | 'СА' | 'Дивиденды' | 'Другое'
export type EventStatus = 'confirmed' | 'expected'

export interface CalendarCompany { name: string; ticker: string }
export interface CalendarEventGroup { title: string; kind: EventKind; status: EventStatus; companies: CalendarCompany[] }
export interface CalendarDay { date: string; weekday: string; groups: CalendarEventGroup[] }

const MONTHS: Record<string, number> = {
  января: 1, февраля: 2, марта: 3, апреля: 4, мая: 5, июня: 6,
  июля: 7, августа: 8, сентября: 9, октября: 10, ноября: 11, декабря: 12,
}

const WD_MAP: Record<string, string> = {
  пн: 'пн', вт: 'вт', ср: 'ср', чт: 'чт', пт: 'пт', сб: 'сб', вс: 'вс',
}

const COMPANY_RE = /^([АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯA-Z])\s+(.+?)\s+([A-Z][A-Z0-9.]*)$/

interface RawInvestmintItem { date: string; events: string[]; fullText?: string }
interface RawSmartlabItem { date: string; time?: string; title: string; text?: string }

function pad(n: number) { return String(n).padStart(2, '0') }

function inferYear(month: number): number {
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1
  return month < currentMonth ? currentYear + 1 : currentYear
}

function parseDate(str: string): { date: string; weekday: string } | null {
  const m = str.match(/^(\d{1,2})\s+([а-яё]+)\s+(\S+)\s*$/i)
  if (!m) return null
  const [, day, monthRaw, wdRaw] = m
  const month = MONTHS[monthRaw.toLowerCase()]
  if (!month) return null
  const weekday = WD_MAP[wdRaw.toLowerCase()] || wdRaw.toLowerCase()
  const year = inferYear(month)
  const date = `${year}-${pad(month)}-${pad(parseInt(day, 10))}`
  return { date, weekday }
}

function splitTokens(s: string): string[] {
  return s.split(/\s{2,}/).map((t) => t.trim()).filter(Boolean)
}

function parseCompany(token: string): CalendarCompany | null {
  const m = token.match(COMPANY_RE)
  if (!m) return null
  return { name: m[2].trim(), ticker: m[3].trim().toUpperCase() }
}

function hasWord(text: string, word: string): boolean {
  const tokens = text.toLowerCase().split(/[^a-zа-яё0-9]+/).filter(Boolean)
  return tokens.includes(word.toLowerCase())
}

function detectKind(title: string): EventKind {
  const t = title.toLowerCase()
  if (t.includes('совет директоров') || hasWord(t, 'сд')) return 'СД'
  if (hasWord(t, 'госа') || hasWord(t, 'воса') || t.includes('собрание акционеров') || hasWord(t, 'собрание')) {
    return 'СА'
  }
  if (t.includes('мсфо')) return 'МСФО'
  if (t.includes('рсбу')) return 'РСБУ'
  if (t.includes('дивиденд')) return 'Дивиденды'
  return 'Другое'
}

function detectStatus(title: string): EventStatus {
  const t = title.toLowerCase()
  return t.includes('ожидается') || t.includes('предварительно') ? 'expected' : 'confirmed'
}

export function parseInvestmintCalendar(raw: RawInvestmintItem[]): CalendarDay[] {
  const days = new Map<string, { weekday: string; groups: Map<string, CalendarEventGroup> }>()
  for (const item of raw) {
    const parsedDate = parseDate(item.date)
    if (!parsedDate) continue
    if (!days.has(parsedDate.date)) {
      days.set(parsedDate.date, { weekday: parsedDate.weekday, groups: new Map() })
    }
    const day = days.get(parsedDate.date)!
    for (const ev of item.events || []) {
      const tokens = splitTokens(ev)
      if (tokens.length < 2) continue
      const title = tokens[0]
      const companies: CalendarCompany[] = []
      for (const tok of tokens.slice(1)) {
        const c = parseCompany(tok)
        if (c) companies.push(c)
      }
      if (companies.length === 0) continue
      const kind = detectKind(title)
      const status = detectStatus(title)
      const key = `${title}|${kind}`
      if (!day.groups.has(key)) {
        day.groups.set(key, { title, kind, status, companies: [] })
      }
      const group = day.groups.get(key)!
      for (const c of companies) {
        if (!group.companies.some((x) => x.ticker === c.ticker)) {
          group.companies.push(c)
        }
      }
    }
  }
  const result: CalendarDay[] = []
  for (const date of Array.from(days.keys()).sort()) ) {
    const d = days.get(date)!
    const groups = Array.from(d.groups.values())
    groups.sort((a, b) => a.title.localeCompare(b.title, 'ru'))
    for (const g of groups) {
      g.companies.sort((a, b) => a.ticker.localeCompare(b.ticker))
    }
    result.push({ date, weekday: d.weekday, groups })
  }
  return result
}

function isSmartlabItem(item: unknown): item is RawSmartlabItem {
  if (!item || typeof item !== 'object') return false
  const i = item as any
  return (
    typeof i.date === 'string' &&
    /^\d{2}\.\d{2}\.\d{4}$/.test(i.date) &&
    typeof i.title === 'string'
  )
}

function parseSmartlabDate(str: string): { date: string; weekday: string } | null {
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)
  if (!m) return null
  const [, day, month, year] = m
  const date = `${year}-${month}-${day}`
  const d = new Date(`${date}T00:00:00`)
  const weekday = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][d.getDay()]
  return { date, weekday }
}

function parseSmartlabTickerTitle(fullTitle: string): { ticker: string; title: string } {
  const m = fullTitle.match(/^([A-Z][A-Z0-9]{1,5})(?:\s*[:\-]\s*)(.+)$/)
  if (m) {
    return { ticker: m[1].trim().toUpperCase(), title: m[2].trim() }
  }
  return { ticker: '', title: fullTitle.trim() }
}

export function parseSmartlabCalendar(raw: RawSmartlabItem[]): { days: CalendarDay[]; noTicker: number; skipped: number } {
  const days = new Map<string, { weekday: string; groups: Map<string, CalendarEventGroup> }>()
  let skipped = 0
  let noTicker = 0
  for (const item of raw) {
    const parsedDate = parseSmartlabDate(item.date)
    if (!parsedDate) continue
    if (!days.has(parsedDate.date)) {
      days.set(parsedDate.date, { weekday: parsedDate.weekday, groups: new Map() })
    }
    const day = days.get(parsedDate.date)!
    const fullTitle = (item.title || '').trim()
    if (!fullTitle) {
      skipped++
      continue
    }
    const parsedTitle = parseSmartlabTickerTitle(fullTitle)
    const kind = detectKind(parsedTitle.title)
    const status = detectStatus(parsedTitle.title)
    const title = parsedTitle.title
    const key = `${title}|${kind}`
    if (!day.groups.has(key)) {
      day.groups.set(key, { title, kind, status, companies: [] })
    }
    const group = day.groups.get(key)!
    const ticker = parsedTitle.ticker || 'UNKNOWN'
    if (!parsedTitle.ticker) noTicker++
    if (!group.companies.some((x) => x.ticker === ticker)) {
      group.companies.push({ name: parsedTitle.ticker ? parsedTitle.ticker : fullTitle, ticker })
    }
  }
  if (noTicker > 0) console.warn(`[Smartlab parser] ${noTicker} entries saved with UNKNOWN ticker`)
  if (skipped > 0) console.warn(`[Smartlab parser] skipped ${skipped} empty entries`)
  const result: CalendarDay[] = []
  for (const date of Array.from(days.keys()).sort()) {
    const d = days.get(date)!
    const groups = Array.from(d.groups.values())
    if (groups.length === 0) continue
    groups.sort((a, b) => a.title.localeCompare(b.title, 'ru'))
    for (const g of groups) {
      g.companies.sort((a, b) => a.ticker.localeCompare(b.ticker))
    }
    result.push({ date, weekday: d.weekday, groups })
  }
  return { days: result, noTicker, skipped }
}
