/**
 * Регрессионные проверки гварда перевода (ТЗ-01/02 v1.2).
 *
 * Что покрывает:
 *   1. isGarbageText — все 4 формы эха LLM отклоняются (сырой JSON-запрос,
 *      system-промпт, user-message, перевод-ключ), валидные заголовок/саммари
 *      проходят (лимиты 300/2000);
 *   2. Три ветки парсера translateBatch на зафиксированных фикстурах
 *      (JSON-массив, объект {"0":...}, line-by-line) — валидные ответы принимаются;
 *   3. Эхо запроса ни через одну ветку не проходит — возвращаются оригиналы
 *      (→ needs_translation остаётся TRUE → штатный ретрай).
 *
 * Без живого API: axios.post подменяется моком до загрузки модулей.
 * Без БД: проверяемые пути translateBatch в БД не ходят.
 *
 * Запуск: node scripts/newsQueries-verify.js (предварительно npm run build)
 */

process.env.KIMI_API_KEY = process.env.KIMI_API_KEY || 'verify-test-key';

const path = require('path');
const distDir = path.join(__dirname, '..', 'dist');

// Подменяем axios.post до загрузки dist-модулей: ответ «модели» переключается
// через currentFixture между проверками.
let currentFixture = '';
const axios = require('axios');
axios.post = async () => ({
  data: { choices: [{ message: { content: currentFixture } }] },
});

const { isGarbageText } = require(path.join(distDir, 'utils', 'translationGuard.js'));
const { translateBatch } = require(path.join(distDir, 'services', 'translate.js'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. isGarbageText — юнит-проверки валидатора
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[isGarbageText]');
check('отклоняет сырой JSON-запрос (эхо тела)', isGarbageText('{"model": "kimi-k2.6", "messages": []}'));
check('отклоняет эхо system-промпта (маркер "senior financial news editor")',
  isGarbageText('You are a senior financial news editor translating English headlines into Russian'));
check('отклоняет эхо user-message (префикс "Translate these")',
  isGarbageText('Translate these 5 financial news headlines to Russian. Return as JSON array in same order:'));
check('отклоняет перевод-ключ (объект с переводом в ключе)', isGarbageText('{"translations": ["Apple победила прогнозы"]}'));
check('отклоняет JSON-массив', isGarbageText('["Apple победила прогнозы"]'));
check('отклоняет не-строку (null)', isGarbageText(null));
check('отклоняет не-строку (число)', isGarbageText(42));
check('отклоняет пустую строку', isGarbageText(''));
check('отклоняет заголовок длиной 301 (лимит 300)', isGarbageText('А'.repeat(301)));
check('принимает валидный заголовок', !isGarbageText('Apple превзошла прогнозы по прибыли, акции взлетели на 5%'));
check('принимает саммари ~1500 символов (лимит 2000)', !isGarbageText('Р'.repeat(1500), 2000));
check('отклоняет саммари 2001+ символ (лимит 2000)', isGarbageText('Р'.repeat(2001), 2000));

// ═══════════════════════════════════════════════════════════════════════════
// 2–3. Ветки парсера translateBatch на фикстурах (axios замокан)
// ═══════════════════════════════════════════════════════════════════════════
const EN_TWO = [
  'Apple beats earnings expectations and raises guidance',
  'Tesla shares plunge after weak delivery numbers',
];

async function runParserChecks() {
  console.log('\n[translateBatch — ветки парсера]');

  // JSON-массив — основной путь после снятия response_format
  currentFixture = '["Apple превзошла прогнозы по прибыли и повысила прогноз", "Акции Tesla рухнули на фоне слабых поставок"]';
  let r = await translateBatch([...EN_TWO]);
  check('JSON-массив: переводы приняты', r[0].includes('превзошла') && r[1].includes('Tesla'));

  // Объект {"0": ...} — fallback-ветка
  currentFixture = '{"0": "Apple превзошла прогнозы по прибыли", "1": "Акции Tesla рухнули на фоне слабых поставок"}';
  r = await translateBatch([...EN_TWO]);
  check('объект {"0":...}: переводы приняты (fallback-ветка)', r[0].includes('превзошла') && r[1].includes('Tesla'));

  // Line-by-line — fallback-ветка
  currentFixture = 'Apple превзошла прогнозы по прибыли\nАкции Tesla рухнули на фоне слабых поставок';
  r = await translateBatch([...EN_TWO]);
  check('line-by-line: переводы приняты (fallback-ветка)', r[0].includes('превзошла') && r[1].includes('Tesla'));

  console.log('\n[translateBatch — эхо отклоняется]');

  // Эхо объекта {system, user} — все ветки должны отказать → оригиналы
  currentFixture = '{"system": "You are a senior financial news editor translating English headlines into Russian for a premium investment platform PULSE", "user": "Translate these 2 financial news headlines to Russian. Return as JSON array in same order:"}';
  r = await translateBatch([...EN_TWO]);
  check('эхо {system,user}: возвращены оригиналы', r[0] === EN_TWO[0] && r[1] === EN_TWO[1]);

  // Эхо user-message однострочник, батч из 1 текста — line-by-line совпадение по счёту
  currentFixture = 'Translate these 1 financial news headlines to Russian. Return as JSON array in same order: 1. "Apple beats earnings expectations"';
  r = await translateBatch([EN_TWO[0]]);
  check('эхо user-message (батч 1): возвращён оригинал', r[0] === EN_TWO[0]);

  // Эхо JSON-массива со строкой промпта — array-ветка должна отказать
  currentFixture = '["You are a senior financial news editor translating English headlines into Russian"]';
  r = await translateBatch([EN_TWO[0]]);
  check('эхо system-промпта в массиве: возвращён оригинал', r[0] === EN_TWO[0]);

  // Эхо сырого запроса — {model, messages}
  currentFixture = '{"model": "kimi-k2.6", "temperature": 0.6, "messages": [{"role": "system", "content": "You are a senior financial news editor"}]}';
  r = await translateBatch([EN_TWO[0]]);
  check('эхо сырого запроса: возвращён оригинал', r[0] === EN_TWO[0]);
}

runParserChecks().then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('Провалены: ' + failures.join(' | '));
    process.exit(1);
  }
}).catch(e => {
  console.error('Скрипт упал:', e);
  process.exit(1);
});
