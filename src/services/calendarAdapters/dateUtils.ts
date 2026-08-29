/**
 * Общие утилиты для парсинга дат календарных провайдеров.
 * Все функции чистые и независимы от диалекта БД.
 */

const RUSSIAN_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

export function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Эвристика года: investmint «28 августа ср» не содержит год.
 *  Если месяц в файле меньше текущего, считаем, что это следующий год.
 *  Smartlab и другие с явным годом эту функцию не вызывают. */
export function inferYear(month: number): number {
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1
  return month < currentMonth ? currentYear + 1 : currentYear
}

/** День недели по дате (Europe/Moscow не нужна: JS-день недели для даты UTC
 *  совпадает с московским для полночи по UTC). */
export function getWeekday(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  if (isNaN(d.getTime())) return ''
  return RUSSIAN_WEEKDAYS[d.getUTCDay()]
}

export function toDateString(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
