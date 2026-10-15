// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-170 — декодирование имён загружаемых файлов
// multer/busboy отдаёт originalname в Latin-1; браузер шлёт UTF-8 →
// в БД и storage попадает mojibake («ÐÐ´Ð¸Ð½Ð°Ñ...» вместо «Адина...»).
// ═══════════════════════════════════════════════════════════════════════════

/** Перекодирует mojibake-имя обратно в UTF-8.
 *  Эвристика: если в имени нет символов À-ÿ (кракозябра всегда содержит
 *  Ð/Ñ и ко), или после перекодировки появился replacement-char —
 *  возвращаем исходник (ASCII-имена и корректный Latin-1 не трогаем). */
export function decodeUploadName(name: string): string {
  if (!name) return name;
  if (!/[À-ÿ]/.test(name)) return name;
  try {
    const fixed = Buffer.from(name, 'latin1').toString('utf8');
    return fixed.includes('�') ? name : fixed;
  } catch {
    return name;
  }
}
