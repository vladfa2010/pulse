/**
 * =============================================================================
 * PULSE — ТЗ-164: тест SEO-генератора образования (порт формул пререндера)
 * =============================================================================
 *
 * Чистый юнит-прогон: без HTTP и БД (запись файлов — во временную директорию).
 *
 * Проверяет:
 *   1. Формулы меты: courseTitle (лесенка ≤60), metaDescription (окно 0..155,
 *      обрезка по последнему пробелу, пол 140), escapeHtml, htmlToPlainText.
 *   2. Побайтовую эквивалентность с формулами фронтового seo-prerender
 *      (robots.txt, sitemap со статическими URL + lastmod).
 *   3. Запись во временную директорию: файлы на месте, временных .tmp не
 *      осталось (атомарность tmp+rename), recursive-mkdir для слага.
 *   4. Чистку протухших директорий: education/legacy-slug/ исчезает,
 *      education/index.html (витрина) не тронут.
 *
 * Запуск:  npx ts-node src/tests/seoRebuild.test.ts
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  SeoCourse,
  courseTitle,
  metaDescription,
  escapeHtml,
  htmlToPlainText,
  robotsTxt,
  sitemapXml,
  renderVitrineHtml,
  renderCourseHtml,
  writeEducationSeoFiles,
  cleanupStaleCourseDirs,
} from '../services/education/seoRebuild';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const bad = (name: string, detail?: any) => { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); };

function check(name: string, cond: boolean, detail?: any) {
  if (cond) ok(name); else bad(name, detail);
}

// ─── 1. courseTitle — лесенка ≤60 ──────────────────────────────────────────
{
  check('короткое название → суффикс «— курс на PULSE»',
    courseTitle('Волатильность') === 'Волатильность — курс на PULSE');

  const mid = 'А'.repeat(48); // 48 + 13 = 61 > 60 → «| PULSE»
  check('среднее название → «| PULSE»',
    courseTitle(mid) === `${mid} | PULSE` && courseTitle(mid).length <= 60);

  const long = 'Б'.repeat(61); // 61 + 9 = 70 > 60 → только название
  check('длинное название → только название',
    courseTitle(long) === long);
}

// ─── 2. metaDescription — окно 0..155 ──────────────────────────────────────
{
  check('пустое/отсутствующее описание → null',
    metaDescription('') === null && metaDescription(null) === null && metaDescription(undefined) === null);

  const short = 'Короткое описание курса.';
  check('≤160 символов → без изменений', metaDescription(short) === short);

  // 200 символов без пробелов в окне 140..155 → жёсткие 155
  const noSpace = 'а'.repeat(200);
  check('нет пробела в окне → жёсткие 155', metaDescription(noSpace) === 'а'.repeat(155));

  // последний пробел в позиции 150 (>= 140) → обрезка по нему
  const withSpace = `${'а'.repeat(150)} ${'б'.repeat(60)}`;
  const r = metaDescription(withSpace);
  check('пробел в окне → обрезка по последнему пробелу', r === 'а'.repeat(150), r?.length);

  // последний пробел раньше 140 → жёсткие 155
  const earlySpace = `${'а'.repeat(100)} ${'б'.repeat(120)}`;
  const r2 = metaDescription(earlySpace);
  check('пробел раньше 140 → жёсткие 155', r2 === earlySpace.slice(0, 155), r2?.length);

  check('HTML разметка → plain text перед обрезкой',
    metaDescription('<p>Первый абзац</p><p>Второй</p>') === 'Первый абзац Второй');
}

// ─── 3. escapeHtml / htmlToPlainText ───────────────────────────────────────
{
  check('escapeHtml покрывает & < > " \'',
    escapeHtml(`<a href="x">&'`) === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');

  check('htmlToPlainText: script/style вырезаны, блоки → переносы, entities',
    htmlToPlainText('<p>А &amp; Б</p><script>var x=1;</script><ul><li>Пункт&nbsp;1</li></ul>') === 'А & Б\nПункт 1');
}

// ─── 4. robots.txt / sitemap.xml — эталонные строки ────────────────────────
{
  check('robots.txt — фиксированный набор строк',
    robotsTxt() === [
      'User-agent: *',
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /profile',
      'Disallow: /api/',
      'Sitemap: https://pulse.inside-trade.ru/sitemap.xml',
      '',
    ].join('\n'));

  const sm = sitemapXml([
    { slug: 'kurs-a', created_at: '2026-10-11T12:00:00.000Z' },
    { slug: 'kurs-b', created_at: null },
  ]);
  const expected = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url><loc>https://pulse.inside-trade.ru/</loc></url>',
    '  <url><loc>https://pulse.inside-trade.ru/education</loc></url>',
    '  <url><loc>https://pulse.inside-trade.ru/pricing</loc></url>',
    '  <url><loc>https://pulse.inside-trade.ru/instructions</loc></url>',
    '  <url><loc>https://pulse.inside-trade.ru/sentiment</loc></url>',
    '  <url><loc>https://pulse.inside-trade.ru/download</loc></url>',
    '  <url><loc>https://pulse.inside-trade.ru/education/kurs-a</loc><lastmod>2026-10-11</lastmod></url>',
    '  <url><loc>https://pulse.inside-trade.ru/education/kurs-b</loc></url>',
    '</urlset>',
    '',
  ].join('\n');
  check('sitemap.xml — статика + курсы с/без lastmod', sm === expected, sm);
}

// ─── 5. Запись во временную директорию + чистка ────────────────────────────
async function runFileTests(): Promise<void> {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edu-seo-test-'));
  const distDir = path.join(tmpRoot, 'dist');
  const educationDir = path.join(distDir, 'education');
  fs.mkdirSync(educationDir, { recursive: true });

  const shell = [
    '<!doctype html>',
    '<html><head>',
    '    <meta charset="UTF-8" />',
    '    <title>PULSE — инвестиционные новости и аналитика</title>',
    '  </head>',
    '  <body><div id="root"></div></body>',
    '</html>',
    '',
  ].join('\n');

  const longCourse: SeoCourse = {
    slug: 'ochen-dlinnoe-nazvanie-kursa-kotoroe-tochno-prevysit-shestdesyat-simvolov-dlya-proverki-lestnici',
    title: 'Очень длинное название курса которое точно превысит шестьдесят символов для проверки лесенки title',
    description: '<p>Первый абзац описания.</p><p>Второй абзац.</p><p>Третий.</p><p>Четвёртый не попадает.</p>',
    cover_url: '/media/courses/cover.png',
    price: 0,
    author: 'Редакция PULSE',
    created_at: '2026-10-01T10:00:00.000Z',
    type: 'course',
    badges: [],
    is_expired: false,
    program: [
      { position: 1, title: 'Введение & основы', duration_min: 15 },
      { position: 2, title: 'Практика', duration_min: null },
    ],
  };
  const paidCourse: SeoCourse = {
    slug: 'platny-kurs',
    title: 'Платный курс',
    description: null,
    cover_url: null,
    price: 4990,
    author: null,
    created_at: '2026-10-11T10:00:00.000Z',
    type: 'course',
    badges: [],
    is_expired: false,
    program: [],
  };

  // Протухшая директория + посторонний файл в витрине (не трогаем).
  fs.mkdirSync(path.join(educationDir, 'legacy-slug'), { recursive: true });
  fs.writeFileSync(path.join(educationDir, 'legacy-slug', 'index.html'), 'stale');
  fs.writeFileSync(path.join(educationDir, 'keepme.txt'), 'keep');

  const written = await writeEducationSeoFiles(distDir, shell, [longCourse, paidCourse]);
  check('записано 2 карточки', written === 2, written);

  check('витрина записана', fs.existsSync(path.join(educationDir, 'index.html')));
  check('карточка длинного курса записана',
    fs.existsSync(path.join(educationDir, longCourse.slug, 'index.html')));
  check('карточка платного курса записана',
    fs.existsSync(path.join(educationDir, 'platny-kurs', 'index.html')));
  check('robots.txt и sitemap.xml записаны',
    fs.existsSync(path.join(distDir, 'robots.txt')) && fs.existsSync(path.join(distDir, 'sitemap.xml')));

  // Атомарность: временных .tmp-файлов не осталось.
  const leftovers: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.includes('.tmp-')) leftovers.push(p);
    }
  };
  walk(distDir);
  check('временных .tmp файлов не осталось (tmp+rename отработал)', leftovers.length === 0, leftovers);

  // Чистка: legacy-slug исчез, keepme.txt и витрина целы.
  check('протухшая директория удалена', !fs.existsSync(path.join(educationDir, 'legacy-slug')));
  check('посторонний файл витрины не тронут', fs.existsSync(path.join(educationDir, 'keepme.txt')));

  const cleanupRemoved = await cleanupStaleCourseDirs(educationDir, new Set(['platny-kurs']));
  check('cleanupStaleCourseDirs удаляет только не-публичные слаги', cleanupRemoved === 1
    && !fs.existsSync(path.join(educationDir, longCourse.slug))
    && fs.existsSync(path.join(educationDir, 'platny-kurs'))
    && fs.existsSync(path.join(educationDir, 'index.html')));

  // Рендер карточки: title-лесенка, цена, уроки с/без длительности.
  const cardHtml = renderCourseHtml(shell, longCourse);
  check('карточка: только название (лесенка)',
    cardHtml.includes(`<title>${escapeHtml(longCourse.title)}</title>`));
  check('карточка: урок с длительностью и без',
    cardHtml.includes('<li>1. Введение &amp; основы (15 мин)</li>')
    && cardHtml.includes('<li>2. Практика</li>'));
  check('карточка: ≤3 абзаца описания', (cardHtml.match(/<p>Первый абзац|<p>Второй абзац|<p>Третий|<p>Четвёртый/g) || []).length === 3);

  const paidHtml = renderCourseHtml(shell, paidCourse);
  check('платный курс: «Цена: X ₽» по ru-RU',
    paidHtml.includes(`Цена: ${(4990).toLocaleString('ru-RU')} ₽`),
    paidHtml.match(/Цена:[^<]*/)?.[0]);
  check('пустое описание → нет meta description', !paidHtml.includes('name="description"'));
  check('платный курс: offers RUB в JSON-LD',
    paidHtml.includes('"price":4990') && paidHtml.includes('"priceCurrency":"RUB"'));

  const vitrineHtml = renderVitrineHtml(shell, [longCourse, paidCourse]);
  check('витрина: ItemList + статические ссылки',
    vitrineHtml.includes('"@type":"ItemList"')
    && vitrineHtml.includes(`<a href="/education/${longCourse.slug}">`)
    && vitrineHtml.includes('<a href="/education/platny-kurs">Платный курс</a> — платный</li>')
    && vitrineHtml.includes(' — бесплатный</li>'));

  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// ─── main ──────────────────────────────────────────────────────────────────
runFileTests()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((err) => {
    console.error('UNEXPECTED ERROR:', err);
    process.exit(1);
  });
