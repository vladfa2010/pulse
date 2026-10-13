/**
 * =============================================================================
 * PULSE — LMS «Образование»: парсер импорта курса из Markdown (ТЗ-159 v3)
 * =============================================================================
 *
 * Один .md-файл = пакет уроков одного курса. Разделитель уроков — `# ` (H1),
 * настройки урока — плоский frontmatter `--- … ---` сразу после H1,
 * CTA-кнопки — директива `:::button`, тест — блок `:::test … :::` (ТЗ-159 v2).
 * Текст до первого H1 — описание курса: при импорте заменяет
 * courses.description (ТЗ-159 v3, пустая преамбула = не трогаем).
 *
 * Модуль чистый: никаких запросов к БД и express — тестируется без HTTP.
 * Контент проходит тот же sanitizeLessonHtml, кнопки — тот же
 * validateLessonButtons, что и ручной ввод (ТЗ-159 решение 5).
 *
 * Идемпотентность импорта (ключ `md-import:<sha256>:<i>`) — на уровне
 * эндпоинта (adminEducation.ts), здесь только разбор текста.
 */

import MarkdownIt from 'markdown-it';
import { parse as parseYaml } from 'yaml';
import { sanitizeLessonHtml } from './contentHtml';
import { isAllowedEmbedUrl, normalizeEmbedUrl } from './embedUrl';
import { validateLessonButtons } from './lessonButtons';
import type { LessonButton } from './lessonButtons';

export interface MdTestQuestion {
  q: string;
  options: string[];
  correct: number;
}

export interface MdTestDraft {
  pass_score: number;            // default 70
  is_blocking: boolean;          // default false
  questions: MdTestQuestion[];
}

export interface MdLessonDraft {
  title: string;                 // из H1, trim, 1..255
  text_content: string;          // HTML, УЖЕ прогнанный через sanitizeLessonHtml
  video_embed_url: string | null;
  duration_min: number | null;
  is_free_preview: boolean;
  unlock_after_days: number;
  buttons: LessonButton[];       // 0–3, после validateLessonButtons
  test: MdTestDraft | null;
}

export interface MdParseResult {
  course_description: string | null;  // HTML после sanitizeLessonHtml; null = не трогать
  lessons: MdLessonDraft[];
  warnings: string[];            // «Урок "…": картинка с внешним URL вырезана»
  errors: string[];              // непусто → импорт запрещён (400)
}

const MAX_LESSONS = 100;
const TITLE_MAX = 255;

const md = new MarkdownIt({ html: true, linkify: false, breaks: false });

// ТЗ-159 Задача 6: одиночный \n ВНУТРИ абзаца → <br> (контракт ТЗ-108: перенос
// строки = <br>). НЕ через markdown-it breaks:true — иначе <br> получат и
// списки/заголовки («кирпичи» ТЗ-156); преобразуем только внутри <p>.
function renderMd(src: string): string {
  return md
    .render(src)
    .replace(/<p>((?:(?!<\/p>)[\s\S])*)<\/p>/g, (_m, inner: string) => `<p>${inner.replace(/\n/g, '<br>')}</p>`);
}

// Общий key=value-парсер атрибутов директив (chart/button/test) — копипаста
// запрещена (ТЗ-159 v2 п.5): label="…" url=… color=… и т.п.
function parseAttrs(rest: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)=("([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    attrs[m[1]] = m[3] !== undefined ? m[3] : m[4];
  }
  return attrs;
}

// Строго построчно: H1 с пробелом — разделитель; `#` без пробела — не заголовок;
// строки ``` включают/выключают fence (H1 внутри fence — текст кода, не разделитель).
function splitByH1(lines: string[]): { title: string; bodyLines: string[] }[] {
  const sections: { title: string; bodyLines: string[] }[] = [];
  let inFence = false;
  let current: { title: string; bodyLines: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && line.startsWith('# ')) {
      current = { title: line.slice(2).trim(), bodyLines: [] };
      sections.push(current);
    } else if (current) {
      current.bodyLines.push(line);
    }
  }
  return sections;
}

// :::chart ticker=X exchange=Y [name=".."] [tf=..] [range=..] [width=..%]
// → <div class="chart-block" data-…></div>. Без обязательных ticker/exchange —
// не подставляем div, warning; финальную валидацию всё равно делает
// sanitizeLessonHtml (transformTags div в contentHtml.ts).
function replaceChartDirectives(body: string, warn: (msg: string) => void): string {
  return body
    .split('\n')
    .map((line) => {
      if (!line.trimStart().startsWith(':::chart')) return line;
      const attrs = parseAttrs(line.trim().slice(':::chart'.length));
      const ticker = (attrs.ticker || '').trim();
      const exchange = (attrs.exchange || '').trim();
      if (!ticker || !exchange) {
        warn('строка :::chart без обязательных ticker/exchange — пропущена');
        return '';
      }
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const parts = [
        'class="chart-block"',
        `data-ticker="${esc(ticker)}"`,
        `data-exchange="${esc(exchange)}"`,
      ];
      if (attrs.name) parts.push(`data-name="${esc(attrs.name.trim())}"`);
      if (attrs.tf) parts.push(`data-tf="${esc(attrs.tf.trim().toLowerCase())}"`);
      if (attrs.range) parts.push(`data-range="${esc(attrs.range.trim().toUpperCase())}"`);
      if (attrs.width) parts.push(`data-width="${esc(attrs.width.trim())}"`);
      return `<div ${parts.join(' ')}></div>`;
    })
    .join('\n');
}

// Директивы тела урока (ТЗ-159 v2 п.5): `:::button` (однострочная) и
// `:::test … :::` (блок до строки `:::`). Строки директив удаляются из текста;
// неизвестные `:::` — warning, строка остаётся. Ошибки копятся в errors —
// «всё или ничего» решает эндпоинт по итоговому массиву.
function extractBodyDirectives(
  bodyLines: string[],
  label: string,
  errors: string[],
  warnings: string[],
): { restLines: string[]; buttons: LessonButton[]; test: MdTestDraft | null } {
  const restLines: string[] = [];
  const rawButtons: Record<string, string>[] = [];
  let test: MdTestDraft | null = null;
  let testSeen = false;

  const pushErr = (msg: string) => errors.push(`Урок "${label}": ${msg}`);

  let i = 0;
  while (i < bodyLines.length) {
    const trimmed = bodyLines[i].trim();

    if (trimmed.startsWith(':::button')) {
      rawButtons.push(parseAttrs(trimmed.slice(':::button'.length)));
      i++;
      continue;
    }

    if (trimmed.startsWith(':::test')) {
      // Второй блок в уроке — ошибка, но блок всё равно съедаем до закрывающего
      // ::: (иначе он уйдёт в текст как «неизвестная директива»).
      if (testSeen) pushErr('второй блок :::test в уроке');
      testSeen = true;

      const attrs = parseAttrs(trimmed.slice(':::test'.length));
      let passScore = 70;
      let isBlocking = false;
      if (attrs.pass !== undefined && attrs.pass.trim() !== '') {
        const v = attrs.pass.trim();
        if (!/^\d+$/.test(v) || parseInt(v, 10) < 1 || parseInt(v, 10) > 100) {
          pushErr('pass — целое число 1..100');
        } else {
          passScore = parseInt(v, 10);
        }
      }
      if (attrs.blocking !== undefined && attrs.blocking.trim() !== '') {
        const v = attrs.blocking.trim().toLowerCase();
        if (v !== 'true' && v !== 'false') pushErr('blocking — только true или false');
        else isBlocking = v === 'true';
      }

      const blockLines: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < bodyLines.length; j++) {
        if (bodyLines[j].trim() === ':::') { closed = true; break; }
        blockLines.push(bodyLines[j]);
      }
      if (!closed) pushErr('незакрытый блок :::test');
      i = closed ? j + 1 : bodyLines.length;

      const questions: MdTestQuestion[] = [];
      let cur: MdTestQuestion | null = null;
      let bad = false;
      for (const bl of blockLines) {
        const t = bl.trim();
        if (!t) continue; // пустые строки игнорируются
        if (t.startsWith('?')) {
          cur = { q: t.slice(1).trim(), options: [], correct: -1 };
          questions.push(cur);
          continue;
        }
        const opt = t.match(/^- \(( |x|X)\)\s?(.*)$/);
        if (opt) {
          if (!cur) {
            pushErr('вариант вне вопроса в блоке :::test');
            bad = true;
            continue;
          }
          if (opt[1].toLowerCase() === 'x') {
            if (cur.correct !== -1) {
              pushErr('у вопроса должен быть ровно один правильный ответ');
              bad = true;
            } else {
              cur.correct = cur.options.length;
            }
          }
          cur.options.push(opt[2].trim());
          continue;
        }
        pushErr(`непонятная строка в блоке :::test: "${t.slice(0, 60)}"`);
        bad = true;
      }

      if (closed && !bad && test === null) {
        const errsBefore = errors.length;
        if (questions.length < 1 || questions.length > 20) pushErr('тест — от 1 до 20 вопросов');
        for (const q of questions) {
          if (!q.q) pushErr('у вопроса должен быть текст (? …)');
          if (q.options.length < 2 || q.options.length > 6) pushErr('у вопроса должно быть 2–6 вариантов');
          if (q.correct === -1) pushErr('у вопроса должен быть ровно один правильный ответ');
        }
        if (errors.length === errsBefore) {
          test = { pass_score: passScore, is_blocking: isBlocking, questions };
        }
      }
      continue;
    }

    if (trimmed.startsWith(':::') && !trimmed.startsWith(':::chart')) {
      const name = trimmed.slice(3).split(/\s/)[0];
      warnings.push(`Урок "${label}": неизвестная директива ":::${name}" — оставлена текстом`);
    }
    restLines.push(bodyLines[i]);
    i++;
  }

  let buttons: LessonButton[] = [];
  if (rawButtons.length > 0) {
    const validated = validateLessonButtons(rawButtons);
    if ('error' in validated) pushErr(validated.error);
    else buttons = validated;
  }
  return { restLines, buttons, test };
}

// Парсинг frontmatter ТОЛЬКО как плоских строк (schema 'failsafe': никаких
// автоматических типов в логику не протаскиваем — валидируем вручную).
// Возвращает настройки и остаток тела (строки после закрывающего '---').
function parseFrontmatter(
  bodyLines: string[],
  label: string,
  errors: string[],
  warnings: string[],
): { restLines: string[]; isFree: boolean; videoUrl: string | null; durationMin: number | null; unlockDays: number } {
  const out = { restLines: bodyLines, isFree: false, videoUrl: null as string | null, durationMin: null as number | null, unlockDays: 0 };

  let start = -1;
  for (let i = 0; i < bodyLines.length; i++) {
    if (bodyLines[i].trim() === '') continue;
    if (bodyLines[i].trim() === '---') start = i;
    break;
  }
  if (start === -1) return out;

  let end = -1;
  for (let i = start + 1; i < bodyLines.length; i++) {
    if (bodyLines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) {
    errors.push(`Урок "${label}": незакрытый блок настроек ---`);
    return out;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(bodyLines.slice(start + 1, end).join('\n'), { schema: 'failsafe' });
  } catch (e: any) {
    errors.push(`Урок "${label}": ошибка разбора настроек — ${e?.message || e}`);
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    errors.push(`Урок "${label}": настройки --- должны быть списком ключей key: value`);
    return out;
  }

  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const value = String(raw ?? '').trim();
    switch (key) {
      case 'is_free': {
        const v = value.toLowerCase();
        if (v !== 'true' && v !== 'false') {
          errors.push(`Урок "${label}": is_free — только true или false`);
        } else {
          out.isFree = v === 'true';
        }
        break;
      }
      case 'video_url': {
        if (!value) {
          errors.push(`Урок "${label}": video_url — непустая строка`);
        } else if (!isAllowedEmbedUrl(normalizeEmbedUrl(value))) {
          errors.push(`Урок "${label}": video_url — домен вне белого списка (youtube, vkvideo, vimeo, rutube) или не https`);
        } else {
          out.videoUrl = normalizeEmbedUrl(value);
        }
        break;
      }
      case 'duration_min': {
        if (!/^\d+$/.test(value)) {
          errors.push(`Урок "${label}": duration_min — целое число ≥ 0`);
        } else {
          out.durationMin = parseInt(value, 10);
        }
        break;
      }
      case 'unlock_days': {
        if (!/^\d+$/.test(value)) {
          errors.push(`Урок "${label}": unlock_days — целое число ≥ 0`);
        } else {
          out.unlockDays = parseInt(value, 10);
        }
        break;
      }
      default:
        warnings.push(`Урок "${label}": неизвестная настройка "${key}" проигнорирована`);
    }
  }

  out.restLines = bodyLines.slice(end + 1);
  return out;
}

export function parseCourseMd(source: string): MdParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.trim()) {
    return { course_description: null, lessons: [], warnings, errors: ['Файл пустой'] };
  }

  const lines = normalized.split('\n');
  const h1Idx: number[] = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (line.startsWith('```')) inFence = !inFence;
    else if (!inFence && line.startsWith('# ')) h1Idx.push(i);
  });

  // ТЗ-159 v3: текст до первого H1 — описание курса (пустая преамбула = не трогаем)
  const preamble = lines.slice(0, h1Idx.length > 0 ? h1Idx[0] : lines.length).join('\n').trim();
  let courseDescription: string | null = null;
  if (preamble) {
    if (/^\s*:::/m.test(preamble)) {
      warnings.push('Директивы ::: в описании курса не поддерживаются — оставлены текстом');
    }
    const sanitized = sanitizeLessonHtml(renderMd(preamble));
    if (sanitized.trim()) {
      courseDescription = sanitized;
    } else {
      warnings.push('Описание курса после очистки пустое — текущее описание не изменится');
    }
  }

  const sections = splitByH1(lines);

  if (sections.length === 0) {
    errors.push('В файле нет ни одного урока (строки "# Заголовок")');
  }
  if (sections.length > MAX_LESSONS) {
    errors.push(`Слишком много уроков (${sections.length} > ${MAX_LESSONS})`);
  }

  const lessons: MdLessonDraft[] = [];
  sections.forEach((section, i) => {
    const label = section.title || `№${i + 1}`;
    const warn = (msg: string) => warnings.push(`Урок "${label}": ${msg}`);

    if (!section.title || section.title.length > TITLE_MAX) {
      errors.push(`Урок ${i + 1}: заголовок "# " — непустая строка до ${TITLE_MAX} символов`);
      return;
    }

    const fm = parseFrontmatter(section.bodyLines, label, errors, warnings);
    const directives = extractBodyDirectives(fm.restLines, label, errors, warnings);

    // Пустой урок (ТЗ-159 v2 п.6): нет ни текста, ни видео. Урок только с
    // тестом/кнопками запрещён осознанно — ученику не к чему переходить.
    const bodyMd = directives.restLines.join('\n');
    if (!bodyMd.trim() && !fm.videoUrl) {
      errors.push(`Урок "${label}" пустой`);
      return;
    }

    const withCharts = replaceChartDirectives(bodyMd, warn);
    const textContent = sanitizeLessonHtml(renderMd(withCharts));

    // ТЗ-159 Задача 2 п.10: картинки были в md, а в результате не осталось НИ
    // ОДНОЙ с src — значит sanitize вырезал внешние URL (допустимы только
    // /media/…). Тег <img> без src sanitize оставляет — поэтому проверяем src.
    if (/!\[|<img/i.test(withCharts) && !/<img[^>]*\ssrc=/i.test(textContent)) {
      warn('картинка(и) с внешним URL вырезана — допустимы только /media/…');
    }

    lessons.push({
      title: section.title,
      text_content: textContent,
      video_embed_url: fm.videoUrl,
      duration_min: fm.durationMin,
      is_free_preview: fm.isFree,
      unlock_after_days: fm.unlockDays,
      buttons: directives.buttons,
      test: directives.test,
    });
  });

  return { course_description: courseDescription, lessons, warnings, errors };
}
