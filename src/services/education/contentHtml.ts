// Санитизация HTML-контента LMS (ТЗ-101 v12, S1; ТЗ-108; нормализация ТЗ-108 v3;
// ТЗ-137: img[width] + доверенный HTML-блок).
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

// ─── ТЗ-137: доверенный HTML-блок ────────────────────────────────────────────
//
// Контракт: <div class="html-block">…произвольная вёрстка…</div> хранится в
// text_content и рендерится студенту КАК ЕСТЬ (админ — доверенное лицо;
// подтверждение при вставке — на фронте, RichTextField). sanitize-html не
// умеет «пропустить поддерево», поэтому блоки изымаются ДО санитайзера в
// placeholders и возвращаются ПОСЛЕ. Placeholder — чистый текст, whitelist
// его не трогает.
//
// Поиск конца блока — НЕ регэксп до первого </div> (внутри вёрстки могут быть
// свои <div>): сканируем теги <div> / </div> со счётчиком вложенности.

const BLOCK_OPEN = '<div class="html-block">';

function extractHtmlBlocks(html: string): { placeholdered: string; blocks: string[] } {
  const blocks: string[] = [];
  let placeholdered = '';
  let rest = html;
  for (;;) {
    const start = rest.indexOf(BLOCK_OPEN);
    if (start === -1) { placeholdered += rest; break; }
    placeholdered += rest.slice(0, start);
    // конец блока — по балансу <div>/</div>
    let depth = 0;
    let end = -1;
    const tagRe = /<div\b|<\/div>/g;
    tagRe.lastIndex = start;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(rest)) !== null) {
      if (m[0] === '<div') depth++;
      else {
        depth--;
        if (depth === 0) { end = tagRe.lastIndex; break; }
        }
    }
    if (end === -1) {
      // незакрытый блок — считаем всё до конца строки содержимым блока.
      // Не откусываем '</div>'.length: у незакрытого блока его нет, иначе
      // терялись последние 6 символов вёрстки (B2, ревью ТЗ-137).
      blocks.push(rest.slice(start + BLOCK_OPEN.length));
      placeholdered += `%%PULSE_HTML_BLOCK_${blocks.length - 1}%%`;
      rest = '';
      break;
    }
    blocks.push(rest.slice(start + BLOCK_OPEN.length, end - '</div>'.length));
    placeholdered += `%%PULSE_HTML_BLOCK_${blocks.length - 1}%%`;
    rest = rest.slice(end);
  }
  return { placeholdered, blocks };
}

function restoreHtmlBlocks(html: string, blocks: string[]): string {
  return html.replace(/%%PULSE_HTML_BLOCK_(\d+)%%/g, (_, i) => {
    const inner = blocks[Number(i)];
    return inner === undefined ? '' : `${BLOCK_OPEN}${inner}</div>`;
  });
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
  // ТЗ-137: сначала изымаем доверенные блоки (до normalizePlainText — их <div>
  // и так переключает нормализацию в ветку «не трогать», но placeholders
  // упрощают анализ и защищают содержимое от обоих проходов).
  const { placeholdered, blocks } = extractHtmlBlocks(html);

  // sanitize-html сериализует void-элементы в XHTML-стиле (<br />); храним
  // HTML5-форму <br> — детерминированный контракт хранения (ТЗ-108 v3, критерий 9).
  const sanitized = sanitizeHtml(normalizePlainText(placeholdered), {
    allowedTags: [
      'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em',
      'u',
      'a', 'img', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'br', 'div',
    ],
    // ТЗ-127 4а: div только как контейнер callout-выноски;
    // ТЗ-137: img[width] — пресеты ширины из редактора (только проценты);
    // html-block в allowedClasses нужен, чтобы пустой блок (вставленный руками
    // без содержимого) переживал санитайзер — наполнение защищено extraction'ом.
    // ТЗ-143: div.chart-block — атом графика, атрибуты data-* валидируются
    // трансформером div ниже (содержимого у блока нет — озвучке/рендеру
    // текста нечего сломать).
    allowedAttributes: {
      a: ['href'],
      img: ['src', 'width'],
      div: ['class', 'data-ticker', 'data-exchange', 'data-name', 'data-tf', 'data-range', 'data-width'],
    },
    allowedClasses: { div: ['callout', 'html-block', 'chart-block'] },
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
        // ТЗ-137: width — только «N%», N = 1..100 (пресеты 25/50/75/100 от
        // редактора; ручное значение в HTML-режиме тоже валидируется).
        // Пиксели запрещены осознанно: фиксированная ширина ломает мобильную
        // вёрстку (ТЗ-133) и мультиколонку читалки (ТЗ-132).
        const w = attribs.width || '';
        const ok = /^([1-9]\d?|100)%$/.test(w.trim());
        return { tagName: 'img', attribs: ok ? { src, width: w.trim() } : { src } };
      },
      div: (tagName, attribs): { tagName: string; attribs: Record<string, string> } => {
        // ТЗ-143: жёсткая валидация chart-block — любой невалидный атрибут
        // обнуляет блок целиком (класс снимается → фронт его не рендерит),
        // а не оставляет «битый» график ученику.
        if ((attribs.class || '').split(/\s+/).includes('chart-block')) {
          const ticker = (attribs['data-ticker'] || '').toUpperCase().trim();
          const exchange = (attribs['data-exchange'] || '').toUpperCase().trim();
          const name = (attribs['data-name'] || '').trim().slice(0, 80);
          const tf = (attribs['data-tf'] || 'd1').toLowerCase().trim();
          const range = (attribs['data-range'] || '').toUpperCase().trim();
          const width = (attribs['data-width'] || '').trim();
          const okTicker = /^[A-Z0-9][A-Z0-9.\-]{0,14}$/.test(ticker);
          const okExchange = /^[A-Z0-9]{2,10}$/.test(exchange);
          const okTf = ['d1', 'm5'].includes(tf);
          // Диапазон обязан соответствовать таймфрейму: иначе руками в HTML
          // можно собрать m5+1Y — тысячи 5-минутных свечей за год.
          const okRange = tf === 'm5'
            ? ['1D', '1W', '1M'].includes(range || '1D')
            : ['1M', '3M', '6M', '1Y'].includes(range || '3M');
          const okWidth = !width || /^([1-9]\d?|100)%$/.test(width);
          if (!okTicker || !okExchange || !okTf || !okRange || !okWidth) {
            return { tagName: 'div', attribs: {} };
          }
          const out: Record<string, string> = {
            class: 'chart-block',
            'data-ticker': ticker,
            'data-exchange': exchange,
            'data-tf': tf,
            'data-range': range || (tf === 'm5' ? '1D' : '3M'),
          };
          if (name) out['data-name'] = name;
          if (width) out['data-width'] = width;
          return { tagName: 'div', attribs: out };
        }
        return { tagName, attribs };
      },
    },
  }).replace(/<br\s*\/>/gi, '<br>');

  return restoreHtmlBlocks(sanitized, blocks);
}
