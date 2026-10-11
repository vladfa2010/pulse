/**
 * =============================================================================
 * PULSE — ТЗ-159: тест парсера импорта курса из Markdown (parseCourseMd)
 * =============================================================================
 *
 * Чистый юнит-прогон: без HTTP и БД (парсер — чистая функция).
 *
 * Проверяет:
 *   1. Разрез по H1; H1 внутри ``` fence НЕ разделитель.
 *   2. Текст до первого H1 → ошибка; пустой файл → ошибка; >100 уроков → ошибка.
 *   3. Frontmatter: валидный / незакрытый / не-объект / неизвестный ключ → warning
 *      / невалидные значения (is_free, duration_min, unlock_days) → ошибки.
 *   4. video_url вне белого списка → ошибка; youtube https → ок.
 *   5. Пустой урок → ошибка. Заголовок >255 → ошибка.
 *   6. :::chart → div.chart-block переживает sanitize; без ticker/exchange → warning.
 *   7. Внешняя картинка → вырезана + warning; /media/ картинка — остаётся.
 *   8. GFM-таблица → <table>; **b** → <strong>; лидирующий # без пробела — текст.
 *   9. Вредоносный md: <script> и [x](javascript:…) не проходят.
 *  10. \r\n нормализуются; BOM снимается.
 *
 * Запуск:  npx ts-node src/tests/mdCourseImport.test.ts
 */

import { parseCourseMd } from '../services/education/mdCourseImport';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const bad = (name: string, detail?: any) => { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); };

function check(name: string, cond: boolean, detail?: any) {
  if (cond) ok(name); else bad(name, detail);
}

// ─── 1. Разрез по H1, fence ────────────────────────────────────────────────
{
  const r = parseCourseMd('# Урок один\n\nТекст первого.\n\n```\n# не заголовок\n```\n\n# Урок два\n\nТекст второго.');
  check('H1: два урока', r.lessons.length === 2, r);
  check('H1: заголовки', r.lessons[0]?.title === 'Урок один' && r.lessons[1]?.title === 'Урок два', r.lessons.map(l => l.title));
  check('H1 в fence — не разделитель (текст урока 1 содержит "# не заголовок")',
    r.lessons.length === 2 && r.lessons[0].text_content.includes('не заголовок'), r.lessons[0]?.text_content);
  check('H1: без ошибок', r.errors.length === 0, r.errors);
}

// ─── 2. Преамбула → описание курса (ТЗ-159 v3) / пустой файл / лимит 100 ──
{
  const r = parseCourseMd('Вводный текст **курса**.\n\n# Урок\n\nТекст.');
  check('Преамбула → course_description (HTML после sanitize)',
    !!r.course_description && r.course_description.includes('<strong>курса</strong>'), r.course_description);
  check('Преамбула → не ошибка, урок распарсился', r.errors.length === 0 && r.lessons.length === 1, r.errors);
  const noPreamble = parseCourseMd('# Урок\n\nТекст.');
  check('Без преамбулы — course_description null', noPreamble.course_description === null, noPreamble.course_description);
  const directivesInPreamble = parseCourseMd(':::chart ticker=SBER exchange=MOEX\n\n# Урок\n\nТекст.');
  check('Директивы в преамбуле → warning, оставлены текстом',
    directivesInPreamble.warnings.some(w => w.includes('Директивы ::: в описании курса')) &&
    (directivesInPreamble.course_description || '').includes(':::chart'),
    { w: directivesInPreamble.warnings, d: directivesInPreamble.course_description });
  const empty = parseCourseMd('   \n\n  ');
  check('Пустой файл → ошибка', empty.errors.includes('Файл пустой'), empty.errors);
  const many = parseCourseMd(Array.from({ length: 101 }, (_, i) => `# Урок ${i + 1}\n\nТ.`).join('\n'));
  check('101 урок → ошибка лимита', many.errors.some(e => e.includes('Слишком много уроков')), many.errors);
}

// ─── 3. Frontmatter ────────────────────────────────────────────────────────
{
  const good = parseCourseMd('# Урок\n---\nis_free: true\nduration_min: 15\nunlock_days: 3\nvideo_url: https://www.youtube.com/watch?v=abc\n---\n\nТекст урока.');
  check('FM: валидный — без ошибок', good.errors.length === 0, good.errors);
  check('FM: is_free', good.lessons[0]?.is_free_preview === true, good.lessons[0]);
  check('FM: duration_min', good.lessons[0]?.duration_min === 15, good.lessons[0]);
  check('FM: unlock_days', good.lessons[0]?.unlock_after_days === 3, good.lessons[0]);
  check('FM: video_url', good.lessons[0]?.video_embed_url === 'https://www.youtube.com/watch?v=abc', good.lessons[0]);

  const unclosed = parseCourseMd('# Урок\n---\nis_free: true\n\nТекст.');
  check('FM: незакрытый --- → ошибка', unclosed.errors.some(e => e.includes('незакрытый блок настроек')), unclosed.errors);

  const notObject = parseCourseMd('# Урок\n---\n- a\n- b\n---\n\nТекст.');
  check('FM: не-объект → ошибка', notObject.errors.some(e => e.includes('списком ключей')), notObject.errors);

  const unknown = parseCourseMd('# Урок\n---\nfoobar: 1\n---\n\nТекст.');
  check('FM: неизвестный ключ → warning', unknown.warnings.some(w => w.includes('неизвестная настройка "foobar"')), unknown.warnings);
  check('FM: неизвестный ключ — не ошибка', unknown.errors.length === 0, unknown.errors);

  const badDuration = parseCourseMd('# Урок\n---\nduration_min: много\n---\n\nТекст.');
  check('FM: duration_min "много" → ошибка', badDuration.errors.some(e => e.includes('duration_min')), badDuration.errors);

  const badUnlock = parseCourseMd('# Урок\n---\nunlock_days: -5\n---\n\nТекст.');
  check('FM: unlock_days -5 → ошибка', badUnlock.errors.some(e => e.includes('unlock_days')), badUnlock.errors);

  const badFree = parseCourseMd('# Урок\n---\nis_free: да\n---\n\nТекст.');
  check('FM: is_free "да" → ошибка', badFree.errors.some(e => e.includes('is_free')), badFree.errors);
}

// ─── 4. video_url whitelist ────────────────────────────────────────────────
{
  const bad = parseCourseMd('# Урок\n---\nvideo_url: https://my.mail.ru/video/x\n---\n\nТекст.');
  check('video_url mail.ru → ошибка', bad.errors.some(e => e.includes('video_url')), bad.errors);
  const http = parseCourseMd('# Урок\n---\nvideo_url: http://www.youtube.com/watch?v=x\n---\n\nТекст.');
  check('video_url http (не https) → ошибка', http.errors.some(e => e.includes('video_url')), http.errors);
}

// ─── 5. Пустой урок / длинный заголовок ────────────────────────────────────
{
  const emptyLesson = parseCourseMd('# Пустой\n\n# Непустой\n\nТекст.');
  check('Пустой урок → ошибка с его заголовком', emptyLesson.errors.some(e => e.includes('Пустой')), emptyLesson.errors);
  const longTitle = parseCourseMd(`# ${'а'.repeat(256)}\n\nТекст.`);
  check('Заголовок >255 → ошибка', longTitle.errors.some(e => e.includes('255')), longTitle.errors);
}

// ─── 6. chart-директива ────────────────────────────────────────────────────
{
  const r = parseCourseMd('# Урок\n\nТекст.\n\n:::chart ticker=SBER exchange=MOEX name="Сбер" tf=d1 range=3M width=75%\n\nЕщё текст.');
  check('chart: div.chart-block в HTML', r.lessons[0]?.text_content.includes('class="chart-block"'), r.lessons[0]?.text_content);
  check('chart: data-атрибуты прошли sanitize', r.lessons[0]?.text_content.includes('data-ticker="SBER"') && r.lessons[0]?.text_content.includes('data-exchange="MOEX"'), r.lessons[0]?.text_content);
  check('chart: без ошибок', r.errors.length === 0, r.errors);

  const noTicker = parseCourseMd('# Урок\n\n:::chart exchange=MOEX\n\nТекст.');
  check('chart без ticker → warning, div не подставлен', noTicker.warnings.some(w => w.includes(':::chart без обязательных')), noTicker.warnings);
  check('chart без ticker — не ошибка', noTicker.errors.length === 0, noTicker.errors);

  const badTf = parseCourseMd('# Урок\n\n:::chart ticker=SBER exchange=MOEX tf=m5 range=1Y\n\nТекст.');
  check('chart m5+1Y → sanitize обнулил блок (класс снят)',
    !badTf.lessons[0]?.text_content.includes('chart-block'), badTf.lessons[0]?.text_content);
}

// ─── 7. Картинки ───────────────────────────────────────────────────────────
{
  const external = parseCourseMd('# Урок\n\n![схема](https://evil.example/x.png)\n\nТекст.');
  // sanitize снимает src (как у ручного ввода), тег без src остаётся и ничего
  // не рендерит — важно, что не осталось картинки С url.
  check('Внешняя картинка: ни одного img с src', !/<img[^>]*\ssrc=/i.test(external.lessons[0]?.text_content || ''), external.lessons[0]?.text_content);
  check('Внешняя картинка → warning', external.warnings.some(w => w.includes('вырезана')), external.warnings);

  const local = parseCourseMd('# Урок\n\n![схема](/media/content/abc.png)\n\nТекст.');
  check('Локальная /media/ картинка осталась', local.lessons[0]?.text_content.includes('src="/media/content/abc.png"'), local.lessons[0]?.text_content);
  check('Локальная картинка — без warning', !local.warnings.some(w => w.includes('вырезана')), local.warnings);
}

// ─── 8. Markdown-разметка ──────────────────────────────────────────────────
{
  const r = parseCourseMd('# Урок\n\nПараграф с **жирным**.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n## Подзаголовок\n\n- пункт 1\n- пункт 2');
  const html = r.lessons[0]?.text_content || '';
  check('GFM-таблица → <table>', html.includes('<table'), html);
  check('**b** → <strong>', html.includes('<strong>жирным</strong>'), html);
  check('h2 → <h2>', html.includes('<h2>Подзаголовок</h2>'), html);
  check('список → <ul><li>', html.includes('<li>пункт 1</li>'), html);

  const inlineHtml = parseCourseMd('# Урок\n\nТекст с <u>подчёркиванием</u> и <table><tr><td>x</td></tr></table>.');
  const html2 = inlineHtml.lessons[0]?.text_content || '';
  check('inline <u> дошёл до санитайзера и пережил его', html2.includes('<u>подчёркиванием</u>'), html2);
  check('inline <table> пережил санитайзер', html2.includes('<table>'), html2);
}

// ─── 9. Вредоносный md ─────────────────────────────────────────────────────
{
  const evil = parseCourseMd('# Урок\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\nТекст.');
  const html = evil.lessons[0]?.text_content || '';
  check('evil: <script> вырезан', !html.includes('<script'), html);
  // markdown-it не создаёт <a> для javascript: (ссылка остаётся литеральным
  // текстом); sanitize в любом случае режет не-https href. Важно: не ссылки.
  check('evil: javascript-ссылки нет', !/<a[^>]*javascript:/i.test(html), html);
  check('evil: — не ошибка (контент чистится, а не отклоняется)', evil.errors.length === 0, evil.errors);
}

// ─── 10. Нормализация \r\n и BOM ───────────────────────────────────────────
{
  const r = parseCourseMd('\uFEFF# Урок\r\n\r\nТекст с переводом\r\nстроки внутри абзаца.\r\n\r\nВторой абзац.');
  check('BOM снят, заголовок чистый', r.lessons[0]?.title === 'Урок', r.lessons[0]?.title);
  const html = r.lessons[0]?.text_content || '';
  check('\\r\\n: абзацы образуются пустой строкой', html.includes('<p>Текст с переводом') && html.split('<p>').length === 3, html);
  check('\\r\\n: внутриабзацный перенос → <br> (не breaks)', html.includes('<br>'), html);
}

// ─── 11. :::button (ТЗ-159 v2) ─────────────────────────────────────────────
{
  const good = parseCourseMd('# Урок\n\nТекст.\n\n:::button label="Открыть терминал" url=/terminal color=violet\n:::button label="Подробнее" url=https://example.com/page\n\nЕщё текст.');
  check('button: 2 кнопки в драфте', good.lessons[0]?.buttons.length === 2, good.lessons[0]?.buttons);
  check('button: label/url/color', good.lessons[0]?.buttons[0].label === 'Открыть терминал' &&
    good.lessons[0]?.buttons[0].url === '/terminal' && good.lessons[0]?.buttons[0].color === 'violet', good.lessons[0]?.buttons);
  check('button: target авто — внутренний self, внешний new_tab',
    good.lessons[0]?.buttons[0].target === 'self' && good.lessons[0]?.buttons[1].target === 'new_tab', good.lessons[0]?.buttons);
  check('button: строки удалены из текста', !good.lessons[0]?.text_content.includes(':::button'), good.lessons[0]?.text_content);
  check('button: без ошибок', good.errors.length === 0, good.errors);

  const fourth = parseCourseMd('# Урок\n\nТекст.\n\n:::button label="1" url=/a\n:::button label="2" url=/b\n:::button label="3" url=/c\n:::button label="4" url=/d');
  check('button: четвёртая → ошибка 0–3', fourth.errors.some(e => e.includes('0–3') && e.includes('Урок')), fourth.errors);

  const http = parseCourseMd('# Урок\n\nТекст.\n\n:::button label="x" url=http://example.com');
  check('button: http:// → ошибка', http.errors.some(e => e.includes('https') && e.includes('Урок')), http.errors);

  const longLabel = parseCourseMd(`# Урок\n\nТекст.\n\n:::button label="${'а'.repeat(31)}" url=/a`);
  check('button: label >30 → ошибка', longLabel.errors.some(e => e.includes('30 символов')), longLabel.errors);

  const unknown = parseCourseMd('# Урок\n\nТекст.\n\n:::foo bar=1\n\nПосле.');
  check(':::foo → warning и строка осталась в тексте',
    unknown.warnings.some(w => w.includes('неизвестная директива ":::foo"')) &&
    unknown.lessons[0]?.text_content.includes(':::foo'), { w: unknown.warnings, h: unknown.lessons[0]?.text_content });
  check(':::foo — не ошибка', unknown.errors.length === 0, unknown.errors);
}

// ─── 12. :::test (ТЗ-159 v2) ───────────────────────────────────────────────
{
  const good = parseCourseMd('# Урок\n\nТекст.\n\n:::test pass=80 blocking=true\n? Столица России?\n- ( ) Казань\n- (x) Москва\n- ( ) Тверь\n:::\n\nПосле.');
  const t = good.lessons[0]?.test;
  check('test: драфт есть, pass=80 blocking=true', !!t && t.pass_score === 80 && t.is_blocking === true, t);
  check('test: 1 вопрос, 3 варианта, correct=1',
    !!t && t.questions.length === 1 && t.questions[0].options.length === 3 && t.questions[0].correct === 1, t);
  check('test: q без знака ?', !!t && t.questions[0].q === 'Столица России?', t);
  check('test: блок удалён из текста', !good.lessons[0]?.text_content.includes(':::test') && !good.lessons[0]?.text_content.includes('Москва'), good.lessons[0]?.text_content);
  check('test: без ошибок', good.errors.length === 0, good.errors);

  const defaults = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n? Вопрос?\n- ( ) а\n- (x) б\n:::');
  check('test: default pass=70, blocking=false', defaults.lessons[0]?.test?.pass_score === 70 && defaults.lessons[0]?.test?.is_blocking === false, defaults.lessons[0]?.test);

  const multi = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n? Первый?\n- (x) да\n- ( ) нет\n? Второй?\n- ( ) да\n- (X) да\n:::');
  check('test: 2 вопроса, X тоже отметка', multi.lessons[0]?.test?.questions.length === 2 && multi.lessons[0]?.test?.questions[1].correct === 1, multi.lessons[0]?.test);

  const twoX = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n? В?\n- (x) а\n- (x) б\n:::');
  check('test: два (x) → ошибка «ровно один»', twoX.errors.some(e => e.includes('ровно один правильный')), twoX.errors);

  const zeroX = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n? В?\n- ( ) а\n- ( ) б\n:::');
  check('test: ноль (x) → ошибка «ровно один»', zeroX.errors.some(e => e.includes('ровно один правильный')), zeroX.errors);

  const oneOpt = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n? В?\n- (x) а\n:::');
  check('test: один вариант → ошибка 2–6', oneOpt.errors.some(e => e.includes('2–6 вариантов')), oneOpt.errors);

  const q21 = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n' +
    Array.from({ length: 21 }, (_, i) => `? В${i + 1}?\n- (x) а\n- ( ) б`).join('\n') + '\n:::');
  check('test: 21 вопрос → ошибка 1–20', q21.errors.some(e => e.includes('от 1 до 20 вопросов')), q21.errors);

  const second = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n? В?\n- (x) а\n- ( ) б\n:::\n\n:::test\n? В2?\n- (x) а\n- ( ) б\n:::');
  check('test: второй блок → ошибка', second.errors.some(e => e.includes('второй блок :::test')), second.errors);

  const unclosed = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n? В?\n- (x) а\n- ( ) б');
  check('test: незакрытый блок → ошибка', unclosed.errors.some(e => e.includes('незакрытый блок :::test')), unclosed.errors);

  const garbage = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n? В?\nмусорная строка\n- (x) а\n- ( ) б\n:::');
  check('test: мусорная строка → ошибка со срезом 60', garbage.errors.some(e => e.includes('непонятная строка в блоке :::test')), garbage.errors);

  const optionOutside = parseCourseMd('# Урок\n\nТекст.\n\n:::test\n- (x) а\n- ( ) б\n? В?\n- (x) а\n- ( ) б\n:::');
  check('test: вариант до вопроса → ошибка «вариант вне вопроса»', optionOutside.errors.some(e => e.includes('вариант вне вопроса')), optionOutside.errors);

  const pass0 = parseCourseMd('# Урок\n\nТекст.\n\n:::test pass=0\n? В?\n- (x) а\n- ( ) б\n:::');
  check('test: pass=0 → ошибка', pass0.errors.some(e => e.includes('pass')), pass0.errors);
  const pass101 = parseCourseMd('# Урок\n\nТекст.\n\n:::test pass=101\n? В?\n- (x) а\n- ( ) б\n:::');
  check('test: pass=101 → ошибка', pass101.errors.some(e => e.includes('pass')), pass101.errors);
  const badBlocking = parseCourseMd('# Урок\n\nТекст.\n\n:::test blocking=да\n? В?\n- (x) а\n- ( ) б\n:::');
  check('test: blocking=да → ошибка', badBlocking.errors.some(e => e.includes('blocking')), badBlocking.errors);

  // Урок только с тестом (без текста и видео) запрещён осознанно (ТЗ-159 v2 п.6)
  const onlyTest = parseCourseMd('# Урок\n\n:::test\n? В?\n- (x) а\n- ( ) б\n:::');
  check('Урок только с тестом → ошибка «пустой»', onlyTest.errors.some(e => e.includes('пустой')), onlyTest.errors);

  // Видео без текста + тест — допустимо
  const videoTest = parseCourseMd('# Урок\n---\nvideo_url: https://www.youtube.com/watch?v=abc\n---\n\n:::test\n? В?\n- (x) а\n- ( ) б\n:::');
  check('Урок видео+тест (без текста) — ок', videoTest.errors.length === 0 && !!videoTest.lessons[0]?.test, videoTest.errors);
}

// ─── Итог ──────────────────────────────────────────────────────────────────
console.log(`\nmdCourseImport: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
