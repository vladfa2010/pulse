// Санитизация HTML-контента LMS (ТЗ-101 v12, S1; ТЗ-108).
// Единая точка: тексты уроков (text_content) и описания курсов (description).
// Из routes/ выделено в services/, чтобы публичный контур (education.ts) мог
// санитизировать legacy-данные на отдаче без импорта админского роутера.

import sanitizeHtml from 'sanitize-html';

/**
 * Whitelist: p/h1-h4/списки/strong/em/u/a/img/code/pre/blockquote/table;
 * a[href] — только https://, img[src] — только '/media/' (наш storage);
 * SVG/script/on*-атрибуты/style отсекаются sanitize-html по умолчанию.
 * Санитизируем на ЗАПИСИ — публичный API отдаёт готовый безопасный HTML.
 */
export function sanitizeLessonHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em',
      'u',
      'a', 'img', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'br',
    ],
    allowedAttributes: { a: ['href'], img: ['src'] },
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
  });
}
