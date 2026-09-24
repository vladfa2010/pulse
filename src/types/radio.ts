/**
 * PULSE — Радио: общие типы (ТЗ-57).
 *
 * Совпадает по структуре с фронт-типом pulse-frontend/src/types/radio.ts
 * (монорепы нет — тип продублирован в обоих репозиториях, осознанно).
 */
export interface RadioSegment {
  role: 'host' | 'guest' | 'single';
  text: string;
}
