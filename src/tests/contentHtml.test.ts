/**
 * =============================================================================
 * PULSE — ТЗ-155: тест sanitizeLessonHtml — выкидывание пустых li/p
 * =============================================================================
 *
 * Чистый юнит-прогон: без HTTP и БД.
 *
 * Проверяет:
 *   1. `<ul><li></li><li>Текст</li></ul>` → пустой li выкинут, текстовый остался.
 *   2. `<p><img src="/media/x.png"></p>` — выживает (mediaChildren — контент).
 *   3. `<li><br></li>` — выкидывается (<br> контентом не считаем).
 *   4. Регрессии: обычные p/ul не тронуты; вредоносный HTML чистится;
 *      chart-block переживает санитайзер; пустой callout div остаётся
 *      (фильтр — только li/p).
 *
 * Запуск:  npx ts-node src/tests/contentHtml.test.ts
 */

import { sanitizeLessonHtml } from '../services/education/contentHtml';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const bad = (name: string, detail?: any) => { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); };

function check(name: string, cond: boolean, detail?: any) {
  if (cond) ok(name); else bad(name, detail);
}

// ─── 1. Пустые li ──────────────────────────────────────────────────────────
{
  const r = sanitizeLessonHtml('<ul><li></li><li>Текст</li></ul>');
  check('пустой li выкинут, текстовый остался',
    r.includes('<li>Текст</li>') && (r.match(/<li>/g) || []).length === 1, r);

  const spaced = sanitizeLessonHtml('<ul><li>   </li><li>Текст</li></ul>');
  check('li из пробелов выкинут', (spaced.match(/<li>/g) || []).length === 1, spaced);

  const onlyEmpty = sanitizeLessonHtml('<ul><li></li><li></li></ul>');
  check('все пустые li → ни одного li не осталось',
    !onlyEmpty.includes('<li>'), onlyEmpty);
}

// ─── 2. <p><img></p> выживает ───────────────────────────────────────────────
{
  const r = sanitizeLessonHtml('<p><img src="/media/content/x.png" width="50%"></p>');
  check('<p><img></p> сохранился со src', r.includes('<img') && r.includes('src="/media/content/x.png"'), r);
  check('<p><img></p>: p-обёртка осталась', r.includes('<p>') && r.includes('</p>'), r);

  const liImg = sanitizeLessonHtml('<ul><li><img src="/media/content/y.png"></li></ul>');
  check('<li><img></li> сохранился', liImg.includes('<img') && liImg.includes('<li>'), liImg);
}

// ─── 3. <li><br></li> выкидывается ─────────────────────────────────────────
{
  const r = sanitizeLessonHtml('<ul><li><br>Текст</li><li><br></li></ul>');
  check('<li> с текстом и <br> остался', r.includes('Текст'), r);
  check('<li><br></li> (только br) выкинут', (r.match(/<li>/g) || []).length === 1, r);

  const pBr = sanitizeLessonHtml('<p><br></p><p>Абзац</p>');
  check('<p><br></p> выкинут, соседний p цел', !/<p>(\s|<br>)*<\/p>/.test(pBr) && pBr.includes('<p>Абзац</p>'), pBr);
}

// ─── 4. Регрессии ───────────────────────────────────────────────────────────
{
  const plain = sanitizeLessonHtml('<p>Просто абзац</p>');
  check('обычный p не тронут', plain.includes('<p>Просто абзац</p>'), plain);

  const list = sanitizeLessonHtml('<ul><li>а</li><li>б</li></ul><ol><li>1</li></ol>');
  check('обычные списки не тронуты',
    (list.match(/<li>/g) || []).length === 3 && list.includes('<ol>'), list);

  const evil = sanitizeLessonHtml('<p>Текст</p><script>alert(1)</script>');
  check('script вырезается как раньше', !evil.includes('<script') && evil.includes('Текст'), evil);

  const chart = sanitizeLessonHtml('<div class="chart-block" data-ticker="SBER" data-exchange="MOEX" data-tf="d1" data-range="3M"></div>');
  check('chart-block переживает санитайзер (ТЗ-143 не сломан)',
    chart.includes('chart-block') && chart.includes('data-ticker="SBER"'), chart);

  const callout = sanitizeLessonHtml('<div class="callout"></div>');
  check('пустой callout div не тронут (фильтр — только li/p)', callout.includes('callout'), callout);

  const imgExternal = sanitizeLessonHtml('<p><img src="https://evil.example/x.png"></p>');
  check('внешняя картинка по-прежнему без src (ТЗ-108 контракт не сломан)',
    !/<img[^>]*\ssrc=/.test(imgExternal), imgExternal);
}

console.log(`\ncontentHtml: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

// Модуль (без этого tsc склеивает файл с соседними *.test.ts-скриптами
// в одну глобальную область — коллизия имён).
export {};
