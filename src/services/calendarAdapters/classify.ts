/**
 * Классификация событий календаря — единая точка truth для всех адаптеров.
 * Перенесено из фронта (src/pages/admin/CalendarTab.tsx).
 */

import { EventKind, EventStatus } from './types'

export function hasWord(text: string, word: string): boolean {
  const tokens = text.toLowerCase().split(/[^a-zа-яё0-9]+/).filter(Boolean)
  return tokens.includes(word.toLowerCase())
}

export function detectKind(title: string): EventKind {
  const t = title.toLowerCase()
  // СД: совет директоров или отдельное слово «сд»
  if (t.includes('совет директоров') || hasWord(t, 'сд')) return 'СД'
  // СА: собрания акционеров / ГОСА / ВОСА / общее слово «собрание»
  if (
    hasWord(t, 'госа') ||
    hasWord(t, 'воса') ||
    t.includes('собрание акционеров') ||
    hasWord(t, 'собрание')
  ) {
    return 'СА'
  }
  // Отчётности
  if (t.includes('мсфо')) return 'МСФО'
  if (t.includes('рсбу')) return 'РСБУ'
  // Дивиденды — после СД, чтобы «СД по дивидендам» шло в СД
  if (t.includes('дивиденд')) return 'Дивиденды'
  return 'Другое'
}

export function detectStatus(title: string): EventStatus {
  const t = title.toLowerCase()
  return t.includes('ожидается') || t.includes('предварительно') ? 'expected' : 'confirmed'
}
