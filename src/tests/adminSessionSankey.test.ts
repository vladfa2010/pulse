/**
 * =============================================================================
 * PULSE — ТЗ-124 v2/v3: unit-тест сборки Санки «Типичные пути»
 * =============================================================================
 *
 * Прогон: USE_SQLITE=true npx ts-node --transpile-only src/tests/adminSessionSankey.test.ts
 *
 * Покрытие (чистая функция без БД/HTTP):
 *   1. Базовая сборка: узлы «тип#уровень», уровни 1..depth, ленты соседних уровней.
 *   2. Счётчик путей: одинаковые сессии суммируются в вес лент.
 *   3. Схлоп узлов (а): исходящий поток < 3 → other#<уровень>, узел исчезает.
 *   4. Схлоп лент (б): value < 3 → target other#<уровень>, value сохраняется.
 *   5. Консервация: сумма лент через границу уровня N→N+1 равна числу сессий
 *      с >N событиями — до и после всех схлопов.
 *   6. Сессии из 1 события дают узел уровня 1 без исходящих (источник).
 *   7. Потолок SANKEY_MAX_LINKS: лент не больше потолка.
 *   8. Глубина (ТЗ-124 v3): depth=5/10 — узлы и ленты только до уровня depth.
 *   9. Coverage: длина depth, монотонно не возрастает, level 1 = 100%, pct
 *      считается по полным длинам путей (обрезка до depth не искажает).
 */

import {
  buildSessionSankey,
  SANKEY_DEFAULT_DEPTH,
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

  // 8. Глубина (ТЗ-124 v3): depth=5 и 10 ограничивают уровни узлов/лент
  {
    const longPath = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];
    const paths = [...Array(10).fill(longPath)];
    const depth5 = buildSessionSankey(paths, 5);
    check('depth=5: coverage длиной 5', depth5.coverage.length === 5, depth5.coverage.length);
    check('depth=5: максимальный уровень узла = 5',
      depth5.nodes.every((n) => levelOf(n.id) <= 5) &&
      Math.max(...depth5.nodes.map((n) => levelOf(n.id))) === 5,
      depth5.nodes.map((n) => n.id));
    check('depth=5: последняя лента 4→5, лент 5→6 нет',
      depth5.links.some((l) => levelOf(l.source) === 4 && levelOf(l.target) === 5) &&
      !depth5.links.some((l) => levelOf(l.source) === 5 && levelOf(l.target) === 6),
      depth5.links);
    const depth10 = buildSessionSankey(paths, 10);
    check('depth=10: узлы доходят до уровня 10 (путь 11 шагов → обрезка до 10)',
      Math.max(...depth10.nodes.map((n) => levelOf(n.id))) === 10,
      depth10.nodes.map((n) => n.id));
    check('дефолтная глубина = 3',
      SANKEY_DEFAULT_DEPTH === 3 && buildSessionSankey(paths).coverage.length === 3);
  }

  // 9. Coverage: монотонность, 100% на 1-м уровне, полные длины (обрезка не искажает)
  {
    // 5 сессий по 1 событию, 3 по 2, 2 по 3 → всего 10
    const paths: string[][] = [
      ...Array(5).fill(['solo']),
      ...Array(3).fill(['a', 'b']),
      ...Array(2).fill(['a', 'b', 'c']),
    ];
    const sankey = buildSessionSankey(paths, 3);
    const cov = sankey.coverage;
    check('coverage: 3 уровня', cov.length === 3, cov);
    check('coverage[0]: все 10 сессий, 100%',
      cov[0].sessions === 10 && cov[0].pct === 100, cov[0]);
    check('coverage[1]: 5 сессий (50%)', cov[1].sessions === 5 && cov[1].pct === 50, cov[1]);
    check('coverage[2]: 2 сессии (20%)', cov[2].sessions === 2 && cov[2].pct === 20, cov[2]);
    check('coverage монотонно не возрастает',
      cov.every((c, i) => i === 0 || c.sessions <= cov[i - 1].sessions), cov);
    // depth=2: pct уровня 2 всё равно 50% — считается по ПОЛНЫМ длинам
    const cov2 = buildSessionSankey(paths, 2).coverage;
    check('depth=2: pct уровня 2 = 50% (полные длины, не обрезанные)',
      cov2[1].sessions === 5 && cov2[1].pct === 50, cov2);
  }
}

main();
console.log(`\nadminSessionSankey.test.ts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

export {};
