/**
 * =============================================================================
 * PULSE — OG-мета для runtime-рендера карточек курсов (ТЗ-205)
 * =============================================================================
 *
 * Порт формул fe/src/lib/seo.ts (дословная копия — courseTitle, metaDescription,
 * canonicalCourse, absoluteUrl, htmlToPlainText, decodeEntities, escapeHtml).
 * Дрейф формул страхуется кросс-тестом паритета на общих фикстурах
 * (src/tests/ogMetaParity.test.ts). BASE — из FRONTEND_URL, дефолт прод-домен.
 */

const BASE = (process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru').replace(/\/+$/, '');

export const OG_DEFAULT_IMAGE = '/og-default.png';

/** ТЗ-205.1: деривация og.jpg-пути из cover_url (.webp → та же база .og.jpg).
 *  Детерминированно, без fs.stat: краулер при редком промахе (файла нет) получит
 *  404 картинки → текст-превью — деградация не хуже исходной webp-ситуации. */
export function ogJpgPathFromCover(coverUrl: string | null | undefined): string | null {
  if (!coverUrl) return null;
  if (coverUrl.endsWith('.webp')) return coverUrl.slice(0, -'.webp'.length) + '.og.jpg';
  return null; // не webp — пары нет
}

/** ТЗ-205.1: og:image для мета — jpeg-производная для webp-обложек (Telegram/X
 *  не берут webp в summary_large_image); иначе cover как есть; null → дефолт. */
export function ogImageFromCover(coverUrl: string | null | undefined): string {
  const derived = ogJpgPathFromCover(coverUrl);
  if (derived) return derived;
  return coverUrl || OG_DEFAULT_IMAGE;
}

/** Title курса с правилом длины 50–60: суффикс «— курс на PULSE», затем «| PULSE», затем только название. */
export function courseTitle(name: string): string {
  const full = `${name} — курс на PULSE`;
  if (full.length <= 60) return full;
  const short = `${name} | PULSE`;
  if (short.length <= 60) return short;
  return name;
}

/** Meta description: целимся в ~155 символов — окно 0..155, обрезка по последнему
 *  пробелу (но не короче 140, иначе жёсткие 155). Пустое описание → null (тег не выводить). */
export function metaDescription(htmlOrText: string | null | undefined): string | null {
  const text = htmlToPlainText(htmlOrText ?? '').replace(/\n+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= 160) return text;
  const window = text.slice(0, 156);
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace >= 140) return window.slice(0, lastSpace);
  return window.slice(0, 155);
}

/** Canonical URL карточки курса. */
export function canonicalCourse(slug: string, base: string = BASE): string {
  return `${base}/education/${slug}`;
}

/** Относительный путь или уже абсолютный URL → абсолютный URL. */
export function absoluteUrl(pathOrUrl: string | null | undefined, base: string = BASE): string {
  if (!pathOrUrl) return base;
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return `${base}${pathOrUrl}`;
  return `${base}/${pathOrUrl}`;
}

/** HTML → plain text: script/style вырезаем, границы блоков → переносы строк, теги удаляем,
 *  entities декодируем, пробелы схлопываем. */
export function htmlToPlainText(html: string): string {
  const noScripts = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|blockquote|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decoded = decodeEntities(noScripts);
  return decoded
    .split('\n')
    .map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Декодирование HTML-entities, которые реально встречаются в текстах курсов. */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_: string, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_: string, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m: string, name: string) => named[name] ?? m);
}

/** HTML-escape для вставки произвольных строк в title/meta (& < > " '). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
