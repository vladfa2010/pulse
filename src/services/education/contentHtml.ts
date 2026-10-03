// Санитизация HTML-контента LMS (ТЗ-101 v12, S1; ТЗ-108; нормализация ТЗ-108 v3).
// Единая точка: тексты уроков (text_content) и описания курсов (description).
// Из routes/ выделено в services/, чтобы публичный контур (education.ts) мог
// санитизировать legacy-данные на отдаче без импорта админского роутера.

import sanitizeHtml from 'sanitize-html';

/**
 * ТЗ-108 v3, Задача 4 — нормализация «простого текста».
 *
 * HTML-контракт хранения: абзацы = `<p>`, перенос строки внутри абзаца = `<br>`;
 * голые `\n` смысла не несут — браузер в HTML-рендере коллапсирует их в пробел,
 * и текст, набранный «просто с Enter'ами», у ученика сливался в один абзац.
 *
 * Правило: есть блочные теги → автор разметил осознанно (тулбара или руками),
 * НЕ трогаем вообще (никакой гибридной конвертации — ломала бы чужую разметку).
 * Нет блочных тегов → «простой текст»: абзацы по `\n\s*\n`, внутри `\n` → `<br>`.
 *
 * Идемпотентно по построению: результат уже содержит `<p>` → второй проход
 * попадает в ветку «не трогаем» (нормализация на записи + на отдаче безопасна).
 */
export function normalizePlainText(html: string): string {
  if (!html) return html;
  if (/<(p|h[1-4]|ul|ol|li|blockquote|pre|table|div)\b/i.test(html)) return html;
  const trimmed = html.trim();
  if (!trimmed) return '';
  return trimmed
    .split(/\n\s*\n/)
    .map((para) => `<p>${para.trim().replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * Whitelist: p/h1-h4/списки/strong/em/u/a/img/code/pre/blockquote/table;
 * a[href] — только https://, img[src] — только '/media/' (наш storage);
 * SVG/script/on*-атрибуты/style отсекаются sanitize-html по умолчанию.
 * Санитизируем на ЗАПИСИ — публичный API отдаёт готовый безопасный HTML.
 * Нормализация простого текста — СТРОГО до санитайзера (созданные `<p>`/`<br>`
 * должны пройти whitelist).
 */
export function sanitizeLessonHtml(html: string): string {
  // sanitize-html сериализует void-элементы в XHTML-стиле (<br />); храним
  // HTML5-форму <br> — детерминированный контракт хранения (ТЗ-108 v3, критерий 9).
  return sanitizeHtml(normalizePlainText(html), {
    allowedTags: [
      'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em',
      'u',
      'a', 'img', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'br', 'div',
    ],
    // ТЗ-127 4а: div только как контейнер callout-выноски в конспекте;
    // прочие классы отсекаются allowedClasses.
    allowedAttributes: { a: ['href'], img: ['src'], div: ['class'] },
    allowedClasses: { div: ['callout'] },
    transformTags: {
      a: (tagName, attribs): { tagName: string; attribs: Record<string, string> } => {
        const href = attribs.href || '';
        // Только https: http и прочие схемы (javascript:) вырезаются целиком.
        if (!/^https:\/\//i.test(href)) return { tagName: 'a', attribs: {} };
        return { tagName: 'a', attribs: { href } };
      },
      img: (tagName, attribs): { tagName: string; attribs: Record<string, string> } => {
        const src = attribs.src || '';
        if (!src.startsWith('/media/')) return { tagName: 'img', attribs: {} };
        return { tagName: 'img', attribs: { src } };
      },
    },
  }).replace(/<br\s*\/>/gi, '<br>');
}
