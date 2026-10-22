/**
 * =============================================================================
 * PULSE — ТЗ-124 v2/v3: Санки «Типичные пути» (чистая функция сборки)
 * =============================================================================
 *
 * Вход: сессионные пути — по одному массиву event_type на сессию
 * (серии одинаковых подряд уже схлопнуты на уровне SQL). Глубина — параметр
 * (ТЗ-124 v3): схлопывание серий и coverage считаются по ПОЛНОЙ длине пути,
 * узлы/ленты строятся по первым `depth` шагам.
 *
 * Правила малой выборки (едины с остальным дашбордом «Пути»):
 *   а) узел с суммарным исходящим потоком < SANKEY_MIN_FLOW схлопывается в
 *      other#<уровень> с перенаправлением ОБОИХ концов лент (узел исчезает
 *      целиком, поток через границу уровней сохраняется);
 *   б) лента с value < SANKEY_MIN_FLOW схлопывается по target в other#<уровень
 *      target> с сохранением value (поток через границу уровней не меняется);
 *   в) потолок SANKEY_MAX_LINKS лент: топ по value остаётся, хвост — той же
 *      схемой в other; если после слияния всё ещё больше — жёсткий slice.
 *
 * Узел: id «тип#уровень» (уровень 1..depth), label — сырой event_type
 * (RU-лейблы — на фронте, eventLabel из PathsSection).
 *
 * Coverage (ТЗ-124 v3): для каждого уровня 1..depth — сколько сессий до него
 * дошли (длина пути ≥ уровень); pct от общего числа сессий. Монотонно
 * не возрастает; coverage[0] = 100%.
 *
 * Консервация: сумма лент через границу уровня N→N+1 не меняется ни одной
 * операцией — схлопывание переносит веса, не удаляет.
 */

export interface SankeyNode {
  id: string;
  label: string;
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
}

export interface SankeyCoverageLevel {
  level: number;
  sessions: number;
  pct: number;
}

export interface SessionSankey {
  nodes: SankeyNode[];
  links: SankeyLink[];
  coverage: SankeyCoverageLevel[];
}

export const SANKEY_MAX_LINKS = 200;
export const SANKEY_MIN_FLOW = 3;
export const SANKEY_DEPTH_OPTIONS = [3, 5, 10] as const;
export const SANKEY_DEFAULT_DEPTH = 3;

const OTHER_PREFIX = 'other#';

const levelOf = (nodeId: string): number => parseInt(nodeId.slice(nodeId.indexOf('#') + 1), 10);
const otherId = (level: number): string => `${OTHER_PREFIX}${level}`;

function addLinkInto(map: Map<string, SankeyLink>, source: string, target: string, value: number): void {
  const key = `${source}->${target}`;
  const existing = map.get(key);
  if (existing) existing.value += value;
  else map.set(key, { source, target, value });
}

export function buildSessionSankey(
  sessionPaths: string[][],
  depth: number = SANKEY_DEFAULT_DEPTH,
): SessionSankey {
  // 1. Считаем одинаковые пути (элемент входа — одна сессия)
  const pathCounts = new Map<string, number>();
  for (const path of sessionPaths) {
    if (path.length === 0) continue;
    const key = path.join(' ');
    pathCounts.set(key, (pathCounts.get(key) || 0) + 1);
  }

  // 2. Ленты между соседними уровнями — по первым `depth` шагам
  let links = new Map<string, SankeyLink>();
  for (const [key, count] of pathCounts) {
    const path = key.split(' ');
    const steps = Math.min(path.length, depth);
    for (let i = 0; i + 1 < steps; i++) {
      addLinkInto(links, `${path[i]}#${i + 1}`, `${path[i + 1]}#${i + 2}`, count);
    }
  }

  // (а) узлы с исходящим потоком < MIN → other своего уровня, оба конца лент
  const outflow = new Map<string, number>();
  for (const l of links.values()) outflow.set(l.source, (outflow.get(l.source) || 0) + l.value);
  const nodeRemap = new Map<string, string>();
  for (const [id, flow] of outflow) {
    if (flow < SANKEY_MIN_FLOW) nodeRemap.set(id, otherId(levelOf(id)));
  }
  if (nodeRemap.size > 0) {
    const next = new Map<string, SankeyLink>();
    for (const l of links.values()) {
      addLinkInto(next, nodeRemap.get(l.source) ?? l.source, nodeRemap.get(l.target) ?? l.target, l.value);
    }
    links = next;
  }

  // (б) ленты value < MIN → target в other#<уровень target>, value сохраняется
  {
    const next = new Map<string, SankeyLink>();
    for (const l of links.values()) {
      const target = l.value < SANKEY_MIN_FLOW ? otherId(levelOf(l.target)) : l.target;
      addLinkInto(next, l.source, target, l.value);
    }
    links = next;
  }

  // (в) потолок лент: топ-MAX по value, хвост в other того же уровня target
  if (links.size > SANKEY_MAX_LINKS) {
    const sorted = [...links.values()].sort((a, b) => b.value - a.value);
    const head = sorted.slice(0, SANKEY_MAX_LINKS);
    const next = new Map<string, SankeyLink>();
    for (const l of head) addLinkInto(next, l.source, l.target, l.value);
    for (const l of sorted.slice(SANKEY_MAX_LINKS)) {
      addLinkInto(next, l.source, otherId(levelOf(l.target)), l.value);
    }
    links = next;
    if (links.size > SANKEY_MAX_LINKS) {
      const top = [...links.values()].sort((a, b) => b.value - a.value).slice(0, SANKEY_MAX_LINKS);
      links = new Map(top.map((l) => [`${l.source}->${l.target}`, l]));
    }
  }

  // 3. Узлы — из оставшихся лент + узлы-источники уровня 1 без исходящих
  //    (сессии из 1 события, поток ≥ MIN — иначе это шум без роли в диаграмме)
  const nodeIds = new Set<string>();
  for (const l of links.values()) {
    nodeIds.add(l.source);
    nodeIds.add(l.target);
  }
  for (const [key, count] of pathCounts) {
    if (count >= SANKEY_MIN_FLOW) nodeIds.add(`${key.split(' ')[0]}#1`);
  }
  const nodes = [...nodeIds].sort().map((id) => ({
    id,
    label: id.startsWith(OTHER_PREFIX) ? 'other' : id.slice(0, id.indexOf('#')),
  }));

  // 4. Coverage (ТЗ-124 v3): по ПОЛНЫМ длинам путей, монотонно не возрастает
  const totalSessions = sessionPaths.filter((p) => p.length > 0).length;
  const coverage: SankeyCoverageLevel[] = [];
  for (let level = 1; level <= depth; level++) {
    const sessions = sessionPaths.filter((p) => p.length >= level).length;
    coverage.push({
      level,
      sessions,
      pct: totalSessions ? Math.round((sessions * 1000) / totalSessions) / 10 : 0,
    });
  }

  return { nodes, links: [...links.values()].sort((a, b) => b.value - a.value), coverage };
}
