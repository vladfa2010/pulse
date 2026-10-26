/**
 * ТЗ_195 (2026-10-26) — очистка текста push-уведомлений от HTML/markdown.
 *
 * Кейсы 1–9 и 11–13 из тест-плана ТЗ. Запуск: npx ts-node src/tests/stripPushMarkup.test.ts
 */
import {
  stripPushMarkup,
  truncateTextSmart,
  PUSH_TITLE_MAX,
  PUSH_BODY_MAX,
  formatDigestPush,
  formatWeeklyReportPush,
} from '../services/notifications/formatters';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, actual?: unknown) {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${actual !== undefined ? ` — получено: ${JSON.stringify(actual)}` : ''}`);
  }
}

// ── stripPushMarkup: кейсы 1–9 из ТЗ ──
check('1: **жирный** + <b>', stripPushMarkup('**Тинькофф** запускает <b>продукт</b>') === 'Тинькофф запускает продукт', stripPushMarkup('**Тинькофф** запускает <b>продукт</b>'));

check('2: &mdash; / &hellip;', stripPushMarkup('Рост &mdash; на 5%&hellip;') === 'Рост — на 5%…', stripPushMarkup('Рост &mdash; на 5%&hellip;'));

check('3: markdown-ссылка', stripPushMarkup('[Читать](https://rbc.ru/x) полностью') === 'Читать полностью', stripPushMarkup('[Читать](https://rbc.ru/x) полностью'));

check('4: &amp; / &lt;&gt;', stripPushMarkup('A &amp; B &lt;ok&gt;') === 'A & B <ok>', stripPushMarkup('A &amp; B &lt;ok&gt;'));

check('5: &nbsp; и пробелы', stripPushMarkup('Заголовок&nbsp;&nbsp;с   пробелами') === 'Заголовок с пробелами', stripPushMarkup('Заголовок&nbsp;&nbsp;с   пробелами'));

check('6: неизвестные сущности удалены', stripPushMarkup('&Prime; неизвестная сущность &prime;') === 'неизвестная сущность', stripPushMarkup('&Prime; неизвестная сущность &prime;'));

check('7: эмодзи и ёлочки сохранены', stripPushMarkup('Текст с эмодзи 📊 и «кавычками-ёлочками»') === 'Текст с эмодзи 📊 и «кавычками-ёлочками»', stripPushMarkup('Текст с эмодзи 📊 и «кавычками-ёлочками»'));

{
  // 8: чистка ДО обрезки — разметка не съедает бюджет 140
  const dirty = '**Важно:** ' + 'слово '.repeat(30) + '**конец**';
  const clean = stripPushMarkup(dirty);
  const cut = truncateTextSmart(clean, PUSH_BODY_MAX);
  check('8: чистка до обрезки', cut.length <= PUSH_BODY_MAX && !/[*_~`#]/.test(cut) && !cut.endsWith('…'.repeat(2)), cut);
}

check('9: # заголовок', stripPushMarkup('# Заголовок') === 'Заголовок', stripPushMarkup('# Заголовок'));

// ── Регрессия 11: текст без разметки не изменяется ──
const plain = 'ЦБ сохранил ключевую ставку на уровне 16% годовых';
check('11: чистый текст не тронут', stripPushMarkup(plain) === plain, stripPushMarkup(plain));

// ── Форматтеры применяют чистку ──
{
  const d = formatDigestPush({
    totalUnread: 1,
    articles: [{ id: '1', title: '**Рост** ставки <b>ЦБ</b>', url: '/news/1', source: 'РБК', tag: 'Экономика', tagId: 't1', sentiment: 'neutral' }],
  });
  check('digest: title очищен', d.title === 'Рост ставки ЦБ', d.title);
  check('digest: body очищен', d.body === 'РБК · Экономика', d.body);
}
{
  const d = formatDigestPush({
    totalUnread: 3,
    articles: [{ id: '1', title: '&laquo;Котировки&raquo; — рост', url: '/news/2', source: 'ТАСС', tag: 'Рынки', tagId: 't2', sentiment: 'positive' }],
  });
  check('digest n>1: title с типографикой', d.title === '«Котировки» — рост', d.title);
  check('digest n>1: body без изменений', d.body === '+ ещё 2 статьи', d.body);
}
{
  const w = formatWeeklyReportPush(
    { period: '12 — 18 октября', totalArticles: 5, tagSummaries: [{ tagName: '**Санкции**', count: 3 }] } as any,
  );
  check('weekly: title очищен', w.title === `📊 Еженедельный отчёт: 12 — 18 октября`, w.title);
  check('weekly: topTag очищен', w.body === '5 новостей за неделю · Санкции', w.body);
  check('weekly: data.report_url не затронут (ТЗ-191)', typeof w.data.report_url === 'undefined', w.data);
}

// ── 13: sentiment/billing — статичные строки, truncateTextSmart прежний ──
check('13: truncateTextSmart без изменений', truncateTextSmart('a b c d e f g', 5) === 'a b…', truncateTextSmart('a b c d e f g', 5));
check('лимиты прежние', PUSH_TITLE_MAX === 60 && PUSH_BODY_MAX === 140);

console.log(`\nstripPushMarkup: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
