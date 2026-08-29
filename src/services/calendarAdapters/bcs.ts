import { CalendarAdapter } from './types'

export const bcsAdapter: CalendarAdapter = {
  source: 'bcs',
  detect(): number {
    return 0
  },
  parse(): never {
    throw new Error('bcs adapter not implemented')
  },
}
