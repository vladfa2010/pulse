/**
 * =============================================================================
 * PULSE — ТЗ-124 v2: unit-тест сборки Санки «Типичные пути»
 * =============================================================================
 *
 * Прогон: USE_SQLITE=true npx ts-node --transpile-only src/tests/adminSessionSankey.test.ts
 *
 * Покрытие (чистая функция без БД/HTTP):
 *   1. Базовая сборка: узлы «тип#уровень», уровни 1..3, ленты соседних уровней.
 *   2. Счётчик путей: одинаковые сессии суммируются в вес лент.
 *   3. Схлоп узлов (а): исходящий поток < 3 → other#<уровень>, узел исчезает.
 *   4. Схлоп лент (б): value < 3 → target other#<уровень>, value сохраняется.
 *   5. Консервация: сумма лент через границу уровня N→N+1 равна числу сессий
 *      с >N событиями — до и после всех схлопов.
 *   6. Сессии из 1 события дают узел уровня 1 без исходящих (источник).
 *   7. Потолок SANKEY_MAX_LINKS: лент не больше потолка.
 */

import {
  buildSessionSankey,
  SANKEY_MAX_LINKS,
  SANKEY_MIN_FLOW,
} from '../services/adminSessionSankey';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

const levelOf = (id: string) => parseInt(id.slice(id.indexOf('#') + 1), 10);
const flowAcross = (links: { source: string; target: string; value: number }[], level: number) =>
  links
    .filter((l) => levelOf(l.source) === level && levelOf(l.target) === level + 1)
    .reduce((s, l) => s + l.value, 0);

function main() {
  // 1. Базовая сборка: 10 сессий login→feed→article, 5 сессий login→feed→settings
  {
    const paths: string[][] = [
      ...Array(10).fill(['login', 'page_view_feed', 'read_article']),
      ...Array(5).fill(['login', 'page_view_feed', 'open_settings']),
      ...Array(4).fill(['login', 'payment_completed']),
    ];
    const sankey = buildSessionSankey(paths);
    check('узлы сформированы', sankey.nodes.length > 0, sankey.nodes.length);
    check('все узлы вида «тип#уровень», уровень 1..3',
      sankey.nodes.every((n) => {
        const lvl = levelOf(n.id);
        return n.id.includes('#') && lvl >= 1 && lvl <= 3 && n.label.length > 0;
      }));
    check('все ленты между соседними уровнями (1→2, 2→3)',
      sankey.links.every((l) => levelOf(l.target) === levelOf(l.source) + 1),
      sankey.links);
    check('лента login#1→page_view_feed#2 = 15',
      sankey.links.some((l) => l.source === 'login#1' && l.target === 'page_view_feed#2' && l.value === 15),
      sankey.links);
    check('лента page_view_feed#2→read_article#3 = 10',
      sankey.links.some((l) => l.source === 'page_view_feed#2' && l.target === 'read_article#3' && l.value === 10),
      sankey.links);
    check('консервация 1→2: 19 сессий с ≥2 событиями', flowAcross(sankey.links, 1) === 19, flowAcross(sankey.links, 1));
    check('консервация 2→3: 15 сессий с ≥3 событиями', flowAcross(sankey.links, 2) === 15, flowAcross(sankey.links, 2));
  }

  // 2. Счётчик: разрозненные дубликаты суммируются
  {
    const paths = [['a', 'b'], ['a', 'b'], ['a', 'b'], ['a', 'c']];
    const sankey = buildSessionSankey(paths);
    check('дубликаты путей суммированы: a#1→b#2 = 3',
      sankey.links.some((l) => l.source === 'a#1' && l.target === 'b#2' && l.value === 3),
      sankey.links);
  }

  // 3. Схлоп узлов (а): rare#2 с потоком 2 → other#2
  {
    const paths: string[][] = [
      ...Array(10).fill(['login', 'feed', 'article']),
      ...Array(2).fill(['login', 'rare', 'article']),
    ];
    const sankey = buildSessionSankey(paths);
    check('узел rare#2 схлопнут — не присутствует', !sankey.nodes.some((n) => n.id === 'rare#2'),
      sankey.nodes.map((n) => n.id));
    check('other#2 присутствует', sankey.nodes.some((n) => n.id === 'other#2'),
      sankey.nodes.map((n) => n.id));
    check('консервация 1→2 после схлопа узла: 12', flowAcross(sankey.links, 1) === 12, flowAcross(sankey.links, 1));
    check('консервация 2→3 после схлопа узла: 12', flowAcross(sankey.links, 2) === 12, flowAcross(sankey.links, 2));
  }

  // 4. Схлоп лент (б): value<MIN → target other#<уровень>, value сохраняется
  {
    const paths: string[][] = [
      ...Array(10).fill(['login', 'feed', 'article']),
      ['login', 'feed', 'rare_once'],
    ];
    const sankey = buildSessionSankey(paths);
    const collapsed = sankey.links.find((l) => l.source === 'feed#2' && l.target === 'other#3');
    check('редкая лента схлопнута в other#3 с сохранением value=1',
      !!collapsed && collapsed.value === 1, sankey.links);
    check('консервация 2→3: 11', flowAcross(sankey.links, 2) === 11, flowAcross(sankey.links, 2));
  }

  // 5. Порог из константы: value ровно MIN не схлопывается
  {
    const paths: string[][] = [
      ...Array(10).fill(['login', 'feed', 'article']),
      ...Array(SANKEY_MIN_FLOW).fill(['login', 'feed', 'exact']),
    ];
    const sankey = buildSessionSankey(paths);
    check(`лента с value=${SANKEY_MIN_FLOW} остаётся`,
      sankey.links.some((l) => l.target === 'exact#3' && l.value === SANKEY_MIN_FLOW),
      sankey.links);
  }

  // 6. Сессия из 1 события — источник без исходящих
  {
    const paths: string[][] = [...Array(5).fill(['solo_event']), ...Array(10).fill(['login', 'feed'])];
    const sankey = buildSessionSankey(paths);
    check('одношаговые узлы с потоком ≥MIN присутствуют как источники',
      sankey.nodes.some((n) => n.id === 'solo_event#1'),
      sankey.nodes.map((n) => n.id));
    check('у solo_event#1 нет исходящих лент',
      !sankey.links.some((l) => l.source === 'solo_event#1'),
      sankey.links);
  }

  // 7. Потолок лент
  {
    const paths: string[][] = [];
    for (let i = 0; i < SANKEY_MAX_LINKS + 20; i++) {
      paths.push(...Array(5).fill(['login', `node_${i}`, 'article']));
    }
    const sankey = buildSessionSankey(paths);
    check(`лент не больше SANKEY_MAX_LINKS (${SANKEY_MAX_LINKS})`,
      sankey.links.length <= SANKEY_MAX_LINKS, sankey.links.length);
    check('other-узлы образованы при обрезке потолка',
      sankey.nodes.some((n) => n.id.startsWith('other#')),
      sankey.nodes.map((n) => n.id));
  }
}

main();
console.log(`\nadminSessionSankey.test.ts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

export {};
