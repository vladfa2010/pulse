/**
 * =============================================================================
 * PULSE — LMS «Образование»: CTA-кнопки урока (ТЗ-124, ТЗ-159 v2)
 * =============================================================================
 *
 * Реализация в services (а не в routes), потому что парсер md-импорта
 * (mdCourseImport.ts) прогоняет директивы `:::button` через ту же валидацию —
 * services → routes запрещён, поэтому общий код живёт здесь; routes-файл
 * реэкспортирует функцию и тип по образцу sanitizeLessonHtml / isAllowedEmbedUrl.
 */

export interface LessonButton {
  label: string;
  url: string;
  color: 'accent' | 'violet' | 'green' | 'ghost';
  target: 'self' | 'new_tab';
}

export const LESSON_BUTTON_COLORS = ['accent', 'violet', 'green', 'ghost'] as const;

/**
 * Валидация buttons урока: массив 0–3 кнопок.
 * url — строго https:// (new URL) или внутренний путь на '/' (без '//'-префикса:
 * protocol-relative запрещены). Дефолты: color='accent'; target — 'new_tab'
 * для https-ссылок, 'self' для внутренних.
 */
export function validateLessonButtons(raw: any): LessonButton[] | { error: string } {
  if (!Array.isArray(raw) || raw.length > 3) {
    return { error: 'buttons — массив из 0–3 кнопок' };
  }
  const out: LessonButton[] = [];
  for (const b of raw) {
    if (b === null || typeof b !== 'object' || Array.isArray(b)) {
      return { error: 'buttons: каждая кнопка — объект { label, url, color?, target? }' };
    }
    const label = typeof b.label === 'string' ? b.label.trim() : '';
    if (!label || label.length > 30) {
      return { error: 'buttons: label — непустая строка до 30 символов' };
    }
    const url = typeof b.url === 'string' ? b.url.trim() : '';
    let isExternal = false;
    if (url.startsWith('/')) {
      if (url.startsWith('//')) {
        return { error: 'buttons: url — https://-ссылка или внутренний путь на /' };
      }
    } else {
      try {
        const u = new URL(url);
        if (u.protocol !== 'https:') {
          return { error: 'buttons: url — только https:// или внутренний путь на /' };
        }
        isExternal = true;
      } catch {
        return { error: 'buttons: url — только https:// или внутренний путь на /' };
      }
    }
    let color: LessonButton['color'] = 'accent';
    if (b.color !== undefined) {
      if (!LESSON_BUTTON_COLORS.includes(b.color)) {
        return { error: `buttons: color — только ${LESSON_BUTTON_COLORS.join(' | ')}` };
      }
      color = b.color;
    }
    let target: LessonButton['target'];
    if (b.target !== undefined) {
      if (b.target !== 'self' && b.target !== 'new_tab') {
        return { error: "buttons: target — только 'self' | 'new_tab'" };
      }
      target = b.target;
    } else {
      target = isExternal ? 'new_tab' : 'self';
    }
    out.push({ label, url, color, target });
  }
  return out;
}
