/**
 * =============================================================================
 * PULSE — LMS: in-memory кэш витрины образования (ТЗ-100 v3/v11, критерии 18-19)
 * =============================================================================
 *
 * Паттерн — services/heatmapDaily.ts: внешний Redis НЕ используется (один
 * инстанс backend). Ключи с префиксом 'education:', TTL 5 минут + жёсткая
 * инвалидация по любой мутации из admin API (ТЗ-101): каждый мутационный
 * обработчик adminEducation.ts обязан вызвать invalidateEducationCache().
 *
 * Кэшируется ТОЛЬКО безликий контент: публичный каталог и справочник категорий.
 * Персональные выборки (filter=mine, my_enrollment, прогресс) НЕ кэшируются —
 * персональное дочисляется после чтения кэша (риск «Кэш × персонализация»).
 */

import { invalidateCalMatchCache } from './calendarMatch';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут (ТЗ-100 v3)
const KEY_PREFIX = 'education:';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<any>>();

/**
 * Прочитать значение из кэша либо вычислить через producer и положить в кэш.
 * Producer вызывается не чаще одного раза на протухший ключ; при ошибке
 * producer кэш НЕ заполняется и ошибка пробрасывается вызывающему коду.
 */
export async function getCached<T>(key: string, producer: () => Promise<T>): Promise<T> {
  const fullKey = KEY_PREFIX + key;
  const hit = store.get(fullKey);
  if (hit && hit.expiresAt > Date.now()) {
    return hit.value as T;
  }
  store.delete(fullKey);
  const value = await producer();
  store.set(fullKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/**
 * Жёсткая инвалидация всех ключей витрины. Дёшево (несколько десятков
 * ключей) — безопасно звать при ЛЮБОЙ мутации курсов/уроков/материалов/
 * категорий/тегов/тарифов/news-links (ТЗ-101 v3, Задача 1).
 *
 * ТЗ-103 Задача 7: вместе с витриной инвалидируем и кэш календарного
 * мэтчинга (education:calmatch:*) — правка тегов курса подействует сразу.
 */
export function invalidateEducationCache(): void {
  for (const key of store.keys()) {
    if (key.startsWith(KEY_PREFIX)) {
      store.delete(key);
    }
  }
  invalidateCalMatchCache();
}

export default { getCached, invalidateEducationCache };
