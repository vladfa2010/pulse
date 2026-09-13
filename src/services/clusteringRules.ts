/**
 * =============================================================================
 * PULSE — Чистые правила кластеризации (ТЗ-95, задача 4)
 * =============================================================================
 *
 * Числовое вето и рубрик-черный список — функции без зависимостей от БД
 * (вынесены из clustering.ts, чтобы запускаться верификатором
 * scripts/clustering-veto-verify.js на машине без DATABASE_URL).
 * Поведение не менялось — clustering.ts реэкспортирует эти же функции.
 */

import { RUBRIC_BLACKLIST } from '../config/clustering';

const NON_SIGNIFICANT_NUMS = new Set(['2025', '2026', '2027']);

/** Значимые числа заголовка: длина >= 2 и не год. Числа < 10 не значимы —
 *  иначе ложная склейка по «топ-3», «5 причин» (Методология §5). */
export function significantNumbers(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(/\d+/g)) {
    const n = m[0];
    if (n.length >= 2 && !NON_SIGNIFICANT_NUMS.has(n)) {
      out.add(n);
    }
  }
  return out;
}

/** true = пара отбрасывается: оба заголовка имеют значимые числа и их
 *  пересечение пусто (разные факты: «сбито 516 БПЛА» ≠ «сбито 130 БПЛА»). */
export function numericVeto(a: string, b: string): boolean {
  const sa = significantNumbers(a);
  const sb = significantNumbers(b);
  if (sa.size === 0 || sb.size === 0) return false;
  for (const n of sa) {
    if (sb.has(n)) return false;
  }
  return true;
}

/** lower() после обрезки ведущих эмодзи/символов; дайджест-заголовки
 *  не участвуют в склейке ни сидом, ни дублём. */
export function isRubricTitle(title: string): boolean {
  const t = title
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}\s]+/u, '')   // эмодзи/префиксы Telegram-источников
    .trim();
  return RUBRIC_BLACKLIST.some((r) => t.startsWith(r));
}
