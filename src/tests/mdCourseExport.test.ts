/**
 * =============================================================================
 * PULSE — ТЗ-191: тест сериализатора экспорта курса в Markdown (mdCourseExport)
 * =============================================================================
 *
 * Чистый юнит-прогон: без HTTP и БД. Ключевой критерий ТЗ — round-trip:
 * снапшот-фикстура урока со всеми элементами → MD → parseCourseMd (ТЗ-159) →
 * структурное сравнение (title, фронтматтер, buttons, test, chart-block в HTML).
 *
 * Проверяет:
 *   1. Урок со всем: таблица (GFM), chart-block, callout, html-block, img
 *      /media, списки, кнопки, тест → MD с директивами парсера.
 *   2. Round-trip: экспортированный MD парсится без ошибок, структура совпала.
 *   3. Границы: урок без теста/кнопок/видео; пустое описание курса (нет
 *      преамбулы); заголовок с `#` → ＃; 20 вопросов; RFC 5987 имя файла.
 *
 * Запуск:  npx ts-node src/tests/mdCourseExport.test.ts
 */

import { lessonToMd, courseToMd, htmlToMd, buttonsToMd, testToMd, sanitizeMdTitle, contentDisposition } from '../services/education/mdCourseExport';
import type { ExportLesson, ExportTest } from '../services/education/mdCourseExport';
import { parseCourseMd } from '../services/education/mdCourseImport';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const check = (name: string, cond: any, detail?: any) => {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 300)}` : ''}`); }
};

const FULL_HTML =
  '<p>Вводный <b>текст</b> урока.</p>' +
  '<ul><li>пункт 1</li><li>пункт 2</li></ul>' +
  '<table><thead><tr><th>Тикер</th><th>Цена</th></tr></thead><tbody><tr><td>SBER</td><td>300</td></tr></tbody></table>' +
  '<div class="callout">Важная выноска с <b>жирным</b></div>' +
  '<div class="chart-block" data-ticker="SBER" data-exchange="MOEX" data-name="Сбер" data-tf="D1" data-range="3M" data-width="80%"></div>' +
  '<div class="html-block"><p>Произвольный <i>HTML</i> блок</p></div>' +
  '<p><img src="/media/abc123.png" alt="Схема"></p>';

const FULL_BUTTONS = [
  { label: 'Купить', url: 'https://example.com/buy', color: 'violet' as const, target: 'new_tab' as const },
  { label: 'Подробнее', url: '/education/x', color: 'accent' as const, target: 'self' as const },
];

const FULL_TEST: ExportTest = {
  pass_score: 80,
  is_blocking: true,
  questions: [
    { q: '2+2?', options: ['3', '4', '5'], correct: 1 },
    { q: 'Столица РФ?', options: ['Москва', 'Питер'], correct: 0 },
  ],
};

const FULL_LESSON: ExportLesson = {
  position: 1,
  title: 'Урок #1: Основы',
  text_content: FULL_HTML,
  video_embed_url: 'https://www.youtube.com/embed/abc123',
  duration_min: 15,
  is_free_preview: true,
  unlock_after_days: 3,
  buttons: FULL_BUTTONS,
};

// ─── 1. Сериализация: полный урок ──────────────────────────────────────────
const fullMd = lessonToMd(FULL_LESSON, FULL_TEST);
console.log('\n── Сериализация полного урока ──');

check('H1 с `#` → ＃ (round-trip splitByH1 не сломается)',
  fullMd.startsWith('# Урок ＃1: Основы'), fullMd.split('\n')[0]);

check('фронтматтер значимый: is_free/video_url/duration_min/unlock_days',
  /---\nis_free: true\nvideo_url: "https:\/\/www\.youtube\.com\/embed\/abc123"\nduration_min: 15\nunlock_days: 3\n---/.test(fullMd), fullMd.slice(0, 400));

check('GFM-таблица: | Тикер | Цена |', fullMd.includes('| Тикер | Цена |'), fullMd);
check('chart-block → :::chart с атрибутами (name в кавычках)',
  fullMd.includes(':::chart ticker=SBER exchange=MOEX name="Сбер" tf=D1 range=3M width=80%'), fullMd);
check('callout — сырой HTML', fullMd.includes('<div class="callout">Важная выноска с <b>жирным</b></div>'), fullMd);
check('html-block — сырой HTML', fullMd.includes('<div class="html-block">'), fullMd);
check('img → ![alt](/media/…)', fullMd.includes('![Схема](/media/abc123.png)'), fullMd);
check('список `- пункт 1`', /^-\s+пункт 1$/m.test(fullMd), fullMd);
check('жирный → **текст**', fullMd.includes('**текст**'), fullMd);

check('кнопки → :::button (label в кавычках, все 4 атрибута)',
  fullMd.includes(':::button label="Купить" url=https://example.com/buy color=violet target=new_tab') &&
  fullMd.includes(':::button label="Подробнее" url=/education/x color=accent target=self'), fullMd);

check('тест → :::test pass/blocking, `? вопрос`, один (x)',
  fullMd.includes(':::test pass=80 blocking=true') &&
  fullMd.includes('? 2+2?') &&
  (fullMd.match(/- \(x\)/g) || []).length === 2 &&
  fullMd.includes('- ( ) 3') && fullMd.trim().endsWith(':::'), fullMd);

// ─── 2. Round-trip: экспорт → parseCourseMd → структура совпала ────────────
console.log('\n── Round-trip через parseCourseMd ──');
const rt = parseCourseMd(`Описание **курса**.\n\n${fullMd}\n\n# Только видео\n---\nvideo_url: https://player.vimeo.com/video/123\n---\n`);

check('round-trip: ошибок нет', rt.errors.length === 0, rt.errors);
check('round-trip: преамбула → описание курса',
  rt.course_description !== null && /Описание/.test(rt.course_description) && /<strong>курса<\/strong>/.test(rt.course_description), rt.course_description);
check('round-trip: 2 урока', rt.lessons.length === 2, rt.lessons.length);

const rl = rt.lessons[0];
check('round-trip: title с ＃ вернулся', rl?.title === 'Урок ＃1: Основы', rl?.title);
check('round-trip: фронтматтер', rl?.is_free_preview === true && rl?.duration_min === 15 &&
  rl?.unlock_after_days === 3 && rl?.video_embed_url === 'https://www.youtube.com/embed/abc123', {
  is_free: rl?.is_free_preview, dur: rl?.duration_min, unlock: rl?.unlock_after_days, video: rl?.video_embed_url });
check('round-trip: кнопки 1:1', JSON.stringify(rl?.buttons) === JSON.stringify(FULL_BUTTONS), rl?.buttons);
check('round-trip: тест 1:1', JSON.stringify(rl?.test) === JSON.stringify(FULL_TEST), rl?.test);
check('round-trip: chart-block в HTML с data-атрибутами',
  /class="chart-block"/.test(rl?.text_content || '') &&
  /data-ticker="SBER"/.test(rl?.text_content || '') &&
  /data-exchange="MOEX"/.test(rl?.text_content || '') &&
  /data-tf="d1"/.test(rl?.text_content || '') &&
  /data-range="3M"/.test(rl?.text_content || '') &&
  /data-width="80%"/.test(rl?.text_content || ''), rl?.text_content?.match(/<div[^>]*chart-block[^>]*>/)?.[0]);
check('round-trip: таблица → <table>', /<table>/.test(rl?.text_content || ''), rl?.text_content?.slice(0, 200));
check('round-trip: callout и html-block прошли sanitize', rl?.text_content.includes('callout') && rl?.text_content.includes('html-block'), rl?.text_content?.slice(0, 300));
check('round-trip: img /media на месте', rl?.text_content.includes('/media/abc123.png'), rl?.text_content);
check('round-trip: тексты выноски на месте', rl?.text_content.includes('Важная выноска') && rl?.text_content.includes('Произвольный'), rl?.text_content);

const rl2 = rt.lessons[1];
check('round-trip: видео-урок без тела — ок', rl2?.title === 'Только видео' &&
  rl2?.video_embed_url === 'https://player.vimeo.com/video/123' && !rl2?.test && (rl2?.text_content || '').trim() === '', {
  title: rl2?.title, video: rl2?.video_embed_url, tc: rl2?.text_content });

// ─── 3. Границы ────────────────────────────────────────────────────────────
console.log('\n── Границы ──');
{
  const bare = lessonToMd({
    position: 2, title: 'Просто текст', text_content: '<p>Только абзац.</p>',
    video_embed_url: null, duration_min: null, is_free_preview: false, unlock_after_days: 0, buttons: [],
  }, null);
  check('без фронтматтера (все значения по умолчанию) — блока --- нет',
    !bare.includes('---') && bare.startsWith('# Просто текст'), bare.slice(0, 200));
  const parsed = parseCourseMd(bare);
  check('без теста/кнопок/видео — парсится, дефолты', parsed.errors.length === 0 &&
    parsed.lessons[0]?.duration_min === null && parsed.lessons[0]?.unlock_after_days === 0 &&
    parsed.lessons[0]?.is_free_preview === false && parsed.lessons[0]?.buttons.length === 0 &&
    parsed.lessons[0]?.test === null, parsed.errors);
}
{
  const md = courseToMd({ title: 'К', description: null }, [{ lesson: FULL_LESSON, test: null }]);
  check('пустое описание курса — преамбулы нет, файл сразу с `# `',
    md.startsWith('# '), md.slice(0, 60));
}
{
  check('sanitizeMdTitle: все `#` → ＃', sanitizeMdTitle('A # B # C') === 'A ＃ B ＃ C', sanitizeMdTitle('A # B # C'));
}
{
  const test20: ExportTest = {
    pass_score: 70, is_blocking: false,
    questions: Array.from({ length: 20 }, (_, i) => ({ q: `В${i}?`, options: ['а', 'б'], correct: 0 })),
  };
  const md = lessonToMd({ ...FULL_LESSON, title: 'Двадцать', buttons: [] }, test20);
  const parsed = parseCourseMd(md);
  check('20 вопросов — верхняя граница проходит', parsed.errors.length === 0 && parsed.lessons[0]?.test?.questions.length === 20, parsed.errors);
}
{
  const cd = contentDisposition('Курс — Тестовый.md');
  check('Content-Disposition: RFC 5987, кириллица закодирована',
    cd.startsWith("attachment; filename*=UTF-8''") && cd.includes('%D0%9A%D1%83%D1%80%D1%81'), cd);
  check('Content-Disposition: декодируется обратно',
    decodeURIComponent(cd.slice("attachment; filename*=UTF-8''".length)) === 'Курс — Тестовый.md', cd);
}
{
  // Отдельные маленькие юниты составляющих
  check('htmlToMd: пустая строка → пусто', htmlToMd('') === '' && htmlToMd('<p></p>') === '', htmlToMd('<p></p>'));
  check('buttonsToMd: пустой массив → пусто', buttonsToMd([]) === '', buttonsToMd([]));
  check('testToMd: 20 вопросов рендерятся', (testToMd({
    pass_score: 70, is_blocking: false,
    questions: Array.from({ length: 20 }, (_, i) => ({ q: `В${i}`, options: ['а', 'б'], correct: 1 })),
  }).match(/\? /g) || []).length === 20);
  check('htmlToMd: заголовки h2/h3 → ##/###', htmlToMd('<h2>Два</h2><h3>Три</h3>') === '## Два\n\n### Три', htmlToMd('<h2>Два</h2><h3>Три</h3>'));
}

// ─── Итог ──────────────────────────────────────────────────────────────────
console.log(`\nmdCourseExport: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
