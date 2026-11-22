/**
 * =============================================================================
 * PULSE — ТЗ-222: юнит-прогон санитайзера заголовков (newsTitle.ts)
 * =============================================================================
 *
 * Прогон: npx tsx src/tests/newsTitle.test.ts
 * Образцы — из критерия приёмки ТЗ-222 п.3 + живые русские кейсы.
 */

import { sanitizeNewsTitle } from '../services/newsTitle';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, name: string): void {
  if (actual === expected) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.log(`  FAIL ${name} — ${JSON.stringify({ actual, expected })}`); }
}

// Критерий приёмки ТЗ-222: строка с флагами/хэштегами/markdown
eq(
  sanitizeNewsTitle('🇺🇸🇨🇳🇷🇺#сша #китай #макро **апдейт по саммиту АТЭС** Трамп запостил фото'),
  'апдейт по саммиту АТЭС Трамп запостил фото',
  'критерий 3: флаги+хэштеги+bold'
);

// Чистые заголовки — не изменяются
eq(sanitizeNewsTitle('Сбербанк поднял ставки по вкладам'), 'Сбербанк поднял ставки по вкладам', 'чистый заголовок');
eq(sanitizeNewsTitle('ЦБ: ключевая ставка осталась на уровне 16%'), 'ЦБ: ключевая ставка осталась на уровне 16%', 'чистый с двоеточием');
eq(sanitizeNewsTitle('Рост цен на нефть марки Brent к концу 2026 года'), 'Рост цен на нефть марки Brent к концу 2026 года', 'латиница в кириллическом тексте');

// Отдельные правила
eq(sanitizeNewsTitle('## Заголовок новости'), 'Заголовок новости', 'markdown-заголовок ##');
eq(sanitizeNewsTitle('*курсив* и _подчёркнутый_'), 'курсив и подчёркнутый', 'курсив и подчёркнутый');
eq(sanitizeNewsTitle('**Срочно:** новость дня'), 'Срочно: новость дня', 'bold с двоеточием');
eq(sanitizeNewsTitle('#новости  #рынок   текст'), 'текст', 'хэштеги с пробелами — схлопывание');
eq(sanitizeNewsTitle('🇷🇺 Рынок РФ: итоги дня'), 'Рынок РФ: итоги дня', 'один флаг');
eq(sanitizeNewsTitle('AAPL **+3%** после отчёта'), 'AAPL +3% после отчёта', 'тикер + bold-процент');

// Кириллица не страдает (регламент Unicode-классов)
eq(sanitizeNewsTitle('**Экономика** России в 2026 году'), 'Экономика России в 2026 году', 'кириллица + bold');

// Границы
eq(sanitizeNewsTitle(null), null, 'null → null');
eq(sanitizeNewsTitle(''), '', 'пустая строка');
eq(sanitizeNewsTitle('***'), '', 'только звёздочки');
eq(sanitizeNewsTitle('##'), '', 'только решётки');

console.log(`\nИтого: ${passed} ok, ${failed} fail`);
process.exit(failed > 0 ? 1 : 0);
