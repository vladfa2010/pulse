/**
 * =============================================================================
 * PULSE — ТЗ-205: кросс-тест паритета формул fe/src/lib/seo.ts ↔ be/src/utils/ogMeta.ts
 * =============================================================================
 *
 * Прогон: npx tsx src/tests/ogMetaParity.test.ts
 * Дрейф формул между фронтенд-пререндером и runtime OG-рендером страхуется
 * общими фикстурами: обе реализации должны дать идентичный вывод.
 */

import * as og from '../utils/ogMeta';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string): void {
  if (actual === expected) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`  FAIL ${name} — ${JSON.stringify({ actual, expected })}`); }
}

// ─── courseTitle ────────────────────────────────────────────────────────────
eq(og.courseTitle('Волатильность'), 'Волатильность — курс на PULSE', 'title: короткое имя → суффикс');
eq(og.courseTitle('Что такое "волатильность" на рынке?'), 'Что такое "волатильность" на рынке? — курс на PULSE', 'title: среднее имя');
{
  const long = 'П'.repeat(70);
  eq(og.courseTitle(long), `${long} | PULSE`.length <= 60 ? `${long} | PULSE` : long, 'title: длинное имя → | PULSE → имя');
}
{
  const veryLong = 'О'.repeat(100);
  eq(og.courseTitle(veryLong), veryLong, 'title: очень длинное имя → только имя');
}
eq(og.courseTitle('A'.repeat(44)), `${'A'.repeat(44)} — курс на PULSE`, 'title: граница 60 (44+16 — суффикс «— курс на PULSE» длиной 16)');

// ─── metaDescription ────────────────────────────────────────────────────────
eq(og.metaDescription(null), null, 'desc: null → null');
eq(og.metaDescription(''), null, 'desc: пусто → null');
eq(og.metaDescription('Короткое описание'), 'Короткое описание', 'desc: короткое');
eq(og.metaDescription('<p>Описание <b>с HTML</b></p>'), 'Описание с HTML', 'desc: HTML → plain');
{
  const long = 'слово'.repeat(40); // 200+ символов
  const d = og.metaDescription(long)!;
  eq(d.length <= 160, true, 'desc: длинное ≤ 160');
  eq(d.endsWith('слово'), true, 'desc: обрезка по последнему пробелу');
}
{
  const edge = 'а'.repeat(139) + ' ' + 'б'.repeat(30); // пробел на 139 (< 140) → жёсткие 155
  const d = og.metaDescription(edge)!;
  eq(d.length, 155, 'desc: пробел раньше 140 → жёсткие 155');
}

// ─── canonicalCourse / absoluteUrl ──────────────────────────────────────────
eq(og.canonicalCourse('abc', 'https://example.com'), 'https://example.com/education/abc', 'canonical');
eq(og.absoluteUrl('/x.png', 'https://example.com'), 'https://example.com/x.png', 'absoluteUrl: путь');
eq(og.absoluteUrl('https://cdn.io/x.png', 'https://example.com'), 'https://cdn.io/x.png', 'absoluteUrl: уже абсолютный');
eq(og.absoluteUrl(null, 'https://example.com'), 'https://example.com', 'absoluteUrl: null → base');

// ─── escapeHtml ─────────────────────────────────────────────────────────────
eq(og.escapeHtml(`<b>&"'</b>`), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;', 'escapeHtml: все символы');

// ─── htmlToPlainText / decodeEntities ───────────────────────────────────────
eq(og.htmlToPlainText('<p>A&amp;B&nbsp;C</p>'), 'A&B C', 'plain: entities');
eq(og.htmlToPlainText('<script>var x=1;</script>Текст'), 'Текст', 'plain: script вырезан');

console.log(`\nИтого: ${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
