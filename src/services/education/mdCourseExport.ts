/**
 * =============================================================================
 * PULSE — LMS «Образование»: сериализатор курса в Markdown (ТЗ-191)
 * =============================================================================
 *
 * Обратная сторона парсера mdCourseImport.ts (ТЗ-159): экспортированный файл
 * проходит «Импорт из MD» и даёт семантически тот же курс (round-trip).
 * Гарантируем семантику и блоки, НЕ байт-в-байт исходной MD-разметки.
 *
 * Модуль чистый: никаких запросов к БД и express — данные приходят снаружи.
 *
 * Известные ограничения (зафиксированы в ТЗ):
 *   - материалы урока в MD не выразимы — в файл не входят;
 *   - `#` в заголовке урока заменяется на полноширинную ＃ (иначе splitByH1
 *     парсера разорвёт round-trip); при реимпорте вернётся как ＃.
 */

/// <reference path="../../types/turndown-plugin-gfm.d.ts" />
import TurndownService from 'turndown';
import { tables } from 'turndown-plugin-gfm';
import type { LessonButton } from './lessonButtons';

export interface ExportTestQuestion {
  q: string;
  options: string[];
  correct: number;
}

export interface ExportTest {
  pass_score: number;
  is_blocking: boolean;
  questions: ExportTestQuestion[];
}

export interface ExportLesson {
  position: number;
  title: string;
  text_content: string | null;
  video_embed_url: string | null;
  duration_min: number | null;
  is_free_preview: boolean;
  unlock_after_days: number;
  buttons: LessonButton[];
}

// Атрибуты chart-block → директива :::chart (порядок — как в парсере,
// mdCourseImport.ts replaceChartDirectives).
const CHART_ATTRS = ['ticker', 'exchange', 'name', 'tf', 'range', 'width'] as const;

function escAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function chartDirective(node: { getAttribute(name: string): string | null }): string {
  const parts: string[] = [];
  for (const key of CHART_ATTRS) {
    const v = (node.getAttribute(`data-${key}`) || '').trim();
    if (!v) continue;
    // name с пробелами — только в кавычках (parseAttrs понимает оба вида)
    parts.push(key === 'name' ? `${key}="${escAttr(v)}"` : `${key}=${escAttr(v)}`);
  }
  return `:::chart ${parts.join(' ')}`;
}

function createTurndown(): TurndownService {
  // DOM-типов в бэкенде нет (lib ES2020) — узел описан структурно.
  interface DomNode {
    nodeName: string;
    className: string;
    getAttribute(name: string): string | null;
    outerHTML: string;
  }
  const hasClass = (node: any, cls: string) =>
    typeof node?.className === 'string' && node.className.split(/\s+/).includes(cls);

  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    // ТЗ-191: пустые элементы turndown швыряет в blankReplacement РАНЬШЕ
    // проверки правил (rules.forNode → isBlank). chart-block всегда пуст —
    // без этого перехвата он молча исчез бы из экспорта.
    blankReplacement: (_content, node: any) => {
      if (node.nodeName === 'DIV' && hasClass(node, 'chart-block')) {
        return `\n\n${chartDirective(node as DomNode)}\n\n`;
      }
      return node.isBlock ? '\n\n' : '';
    },
  });
  td.use(tables);

  // div.chart-block → :::chart … (обратно к mdCourseImport.ts:101-110).
  // Сюда попадает только непустой блок (см. blankReplacement выше).
  td.addRule('chart-block', {
    filter: (node: any) => node.nodeName === 'DIV' && hasClass(node, 'chart-block'),
    replacement: (_content, node) => `\n\n${chartDirective(node as unknown as { getAttribute(n: string): string | null })}\n\n`,
  });

  // div.callout / div.html-block → сырой HTML как есть: markdown-it на импорте
  // рендерит html-блоки нативно (md.html: true), round-trip сохраняется.
  const rawHtmlBlock = (cls: string) => ({
    filter: (node: any) => node.nodeName === 'DIV' && hasClass(node, cls),
    replacement: (_content: string, node: any) => `\n\n${(node as DomNode).outerHTML}\n\n`,
  });
  td.addRule('callout', rawHtmlBlock('callout'));
  td.addRule('html-block', rawHtmlBlock('html-block'));

  // img: дефолтный turndown уже отдаёт ![alt](src); src у нас всегда /media/…
  // (санитайзер внешние режет), отдельное правило не нужно.
  return td;
}

/** Санитизированный HTML тела урока → Markdown (GFM: таблицы ТЗ-176). */
export function htmlToMd(html: string): string {
  return createTurndown().turndown(html).trim();
}

/** CTA-кнопки → строки :::button (формат парсера, validateLessonButtons). */
export function buttonsToMd(buttons: LessonButton[]): string {
  return buttons
    .map((b) => {
      const parts = [`label="${escAttr(b.label)}"`, `url=${escAttr(b.url)}`, `color=${b.color}`, `target=${b.target}`];
      return `:::button ${parts.join(' ')}`;
    })
    .join('\n');
}

/** Тест → блок :::test (один (x) на вопрос — гарантия схемы). */
export function testToMd(test: ExportTest): string {
  const lines = [`:::test pass=${test.pass_score} blocking=${test.is_blocking ? 'true' : 'false'}`];
  for (const q of test.questions) {
    lines.push(`? ${q.q}`);
    q.options.forEach((opt, i) => lines.push(`- (${i === q.correct ? 'x' : ' '}) ${opt}`));
  }
  lines.push(':::');
  return lines.join('\n');
}

// `#` в заголовке сломает splitByH1 парсера — заменяем на полноширинную ＃
// (оговорка ТЗ-191: при реимпорте в названии будет ＃).
export function sanitizeMdTitle(title: string): string {
  return title.replace(/#/g, '＃');
}

/** Один урок → MD: H1 + значимый фронтматтер + тело + кнопки + тест. */
export function lessonToMd(lesson: ExportLesson, test: ExportTest | null): string {
  const fm: string[] = [];
  if (lesson.is_free_preview) fm.push('is_free: true');
  if (lesson.video_embed_url) fm.push(`video_url: "${lesson.video_embed_url}"`);
  if (lesson.duration_min != null) fm.push(`duration_min: ${lesson.duration_min}`);
  if (lesson.unlock_after_days > 0) fm.push(`unlock_days: ${lesson.unlock_after_days}`);

  const parts = [`# ${sanitizeMdTitle(lesson.title)}`];
  if (fm.length > 0) parts.push(`---\n${fm.join('\n')}\n---`);

  const body = htmlToMd(lesson.text_content || '');
  if (body) parts.push(body);

  const buttons = buttonsToMd(lesson.buttons);
  if (buttons) parts.push(buttons);

  if (test) parts.push(testToMd(test));

  return parts.join('\n\n') + '\n';
}

export interface ExportCourse {
  title: string;
  description: string | null;
}

/** Весь курс: преамбула-описание (если непустое) + уроки по порядку. */
export function courseToMd(
  course: ExportCourse,
  lessons: { lesson: ExportLesson; test: ExportTest | null }[],
): string {
  const parts: string[] = [];
  const description = htmlToMd(course.description || '');
  if (description) parts.push(description);
  for (const { lesson, test } of lessons) parts.push(lessonToMd(lesson, test));
  return parts.join('\n\n') + '\n';
}

// Имя файла по RFC 5987 (кириллица в Content-Disposition, критерий 7).
export function contentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
