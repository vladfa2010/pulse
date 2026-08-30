import { CalendarAdapter } from './types'

export const globalAdapter: CalendarAdapter = {
  source: 'global',
  stub: true,
  detect(): number {
    return 0
  },
  parse(): never {
    throw new Error('global adapter not implemented')
  },
}
