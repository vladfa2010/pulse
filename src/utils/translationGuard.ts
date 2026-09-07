// Отбраковка эха LLM: эхо запроса/промпта не является переводом.
// Маркеры — фрагменты промпта translate.ts; надёжнее префиксов.
// Единая точка использования: translate.ts, newsProcessor (×2), backfill-роуты (×2).
export function isGarbageText(s: any, maxLen = 300): boolean {
  if (typeof s !== 'string') return true;
  const t = s.trim();
  return t.length < 2 || t.length > maxLen ||
         t.startsWith('{') || t.startsWith('[') ||
         t.includes('senior financial news editor') ||
         t.startsWith('Translate these');
}
