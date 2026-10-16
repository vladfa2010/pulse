/**
 * Регрессионные проверки ТЗ-181 — кросс-языковые каскады (без БД):
 *   1. pickTitle/pickSummary (clusteringRules.ts) — перевод предпочтительнее,
 *      original — фолбэк: верификатор и вето больше не получают пустую сторону
 *      для непереведённых новостей (корневая причина слепых отказов с 11.10);
 *   2. Промпт верификатора — явная инструкция, что разный язык НЕ признак
 *      разных событий; плейсхолдеры TITLE_A/B на месте;
 *   3. MAX_VERIFY_ATTEMPTS=3 в конфиге (fall-through: до 3 LLM-вызовов на новость);
 *   4. numericVeto на кросс-языковой паре с одинаковыми числами — вето не мешает
 *      склейке RU+EN одного события.
 *
 * Замечание: сам цикл fall-through живёт внутри clusterOne и требует БД —
 * он покрыт интеграционно смоуком/продом, здесь проверяем чистые части.
 *
 * Запуск: npm run verify:clusteringTz181 (предварительно npm run build)
 */

const path = require('path');
const distDir = path.join(__dirname, '..', 'dist');

const { pickTitle, pickSummary, numericVeto } = require(path.join(distDir, 'services', 'clusteringRules.js'));
const { CLUSTER_VERIFIER_PROMPT_TEMPLATE } = require(path.join(distDir, 'services', 'clusterVerifierPrompt.js'));
const { MAX_VERIFY_ATTEMPTS, VERIFIER_DAILY_LIMIT } = require(path.join(distDir, 'config', 'clustering.js'));

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
// 1. pickTitle / pickSummary — «лучший доступный текст» (ТЗ-181 §2.3)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[pickTitle/pickSummary]');
check(
  'RU-новость: берётся title_ru, original игнорируется',
  pickTitle({ title_ru: 'Сбер поднял ставку', title_original: 'Sber raises rate' }) === 'Сбер поднял ставку'
);
check(
  'EN-новость без перевода: фолбэк на title_original (раньше — пустая строка в верификатор)',
  pickTitle({ title_ru: null, title_original: 'Fed holds rates steady' }) === 'Fed holds rates steady'
);
check(
  'оба пусты — пустая строка (fail-closed верификатор откажет, как и раньше)',
  pickTitle({ title_ru: null, title_original: null }) === ''
);
check(
  'summary: ru предпочтительнее original',
  pickSummary({ summary_ru: 'Кратко по-русски', summary_original: 'English summary' }) === 'Кратко по-русски'
);
check(
  'summary: фолбэк на original при NULL summary_ru',
  pickSummary({ summary_ru: null, summary_original: 'English summary' }) === 'English summary'
);
check(
  'кросс-языковая пара из ТЗ (RU + EN сингл, sim 0.7): обе стороны непустые для верификатора',
  pickTitle({ title_ru: 'ЦБ сохранил ключевую ставку', title_original: null }).length > 0
    && pickTitle({ title_ru: null, title_original: 'Central bank holds key rate' }).length > 0
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Промпт верификатора — кросс-языковые пары (ТЗ-181 §3.5)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[промпт верификатора]');
check(
  'инструкция про разные языки присутствует',
  /РАЗНЫХ языках/.test(CLUSTER_VERIFIER_PROMPT_TEMPLATE)
    && /язык сам по себе\s*\n?НЕ признак разных событий/.test(CLUSTER_VERIFIER_PROMPT_TEMPLATE)
);
check(
  'один и тот же факт на русском и английском — дубль',
  /Один и тот же факт на русском и английском — дубль/.test(CLUSTER_VERIFIER_PROMPT_TEMPLATE)
);
check(
  'плейсхолдеры TITLE_A/B на месте (пустых заголовков в промпте быть не должно)',
  CLUSTER_VERIFIER_PROMPT_TEMPLATE.includes('{{TITLE_A}}') && CLUSTER_VERIFIER_PROMPT_TEMPLATE.includes('{{TITLE_B}}')
);
check(
  'критерий «тот же факт» и контрпримеры сохранены',
  CLUSTER_VERIFIER_PROMPT_TEMPLATE.includes('Дубль = тот же факт без существенно новой информации')
    && CLUSTER_VERIFIER_PROMPT_TEMPLATE.includes('Brent > $90')
);

// ═══════════════════════════════════════════════════════════════════════════
// 3. Конфиг fall-through (ТЗ-181 §3.1)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[конфиг]');
check('MAX_VERIFY_ATTEMPTS = 3', MAX_VERIFY_ATTEMPTS === 3);
check('VERIFIER_DAILY_LIMIT сохранён (2000)', VERIFIER_DAILY_LIMIT === 2000);

// ═══════════════════════════════════════════════════════════════════════════
// 4. numericVeto на кросс-языковой паре
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n[numericVeto: кросс-языковые пары]');
check(
  'одинаковые числа RU/EN («516 дронов» / «516 drones») — вето НЕ мешает склейке',
  numericVeto('Сбито 516 дронов над Ростовской областью', 'Downed 516 drones over Rostov region') === false
);
check(
  'разные числа RU/EN («85» / «516») — вето срабатывает как и раньше',
  numericVeto('Сбито 85 дронов', 'Downed 516 drones') === true
);

// ═══════════════════════════════════════════════════════════════════════════
// Итог
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\nИтог: ${passed} прошло, ${failed} упало`);
if (failed > 0) {
  console.log('Падения:', failures.join('; '));
  process.exit(1);
}
console.log('verify:clusteringTz181 — OK');
