/**
 * SQL-функция для текущего времени.
 * USE_SQLITE → datetime('now'), иначе NOW().
 * Используется в UPDATE/INSERT для auto-timestamp полей.
 */
const USE_SQLITE = process.env.USE_SQLITE === 'true';

export function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}
