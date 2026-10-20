/**
 * =============================================================================
 * PULSE — Аналитика виральности (ТЗ-185, задача 2)
 * =============================================================================
 *
 * Ночной синтез через топ-20: какие темы и триггеры объединяют самые
 * разгоняемые события. Три скоупа — каскады за 24ч (топ по size, рубрики-
 * дайджесты по RUBRIC_BLACKLIST отфильтрованы), сюжеты за 7д (суммарный
 * размер кластеров), темы последнего done-прогона topics-worker (топ-20 по
 * news_count). Один LLM-вызов на скоуп (конвенции §9.1 Методологии — как
 * clusterVerifier/storyGrouper: Kimi, temp 0.6 для kimi-k*, thinking off,
 * response_format json_object, таймаут VERIFIER_TIMEOUT_MS).
 *
 * LLM fail-closed (§9.3): невалидный JSON или отсутствие обязательных
 * ключей → старый отчёт остаётся, ошибка в лог, скоуп не падает.
 * Результат — INSERT в virality_reports (другие таблицы джоба не трогает).
 *
 * Ручного обновления нет (решение владельца): запуск — cron 05:30 МСК
 * (после topics-нейминга 04:10, см. startViralityCron) или разовый вызов
 * runViralityAnalytics() (критерий приёмки №2).
 */

import axios from 'axios';
import { query } from '../config/db';
import {
  VERIFIER_MODEL_TEMPERATURE,
  VERIFIER_TIMEOUT_MS,
} from '../config/clustering';
import { isRubricTitle } from './clustering';

const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';

// ТЗ-185 задача 2: выборка 30 кандидатов → фильтр рубрик в коде → топ-20
const CANDIDATE_LIMIT = 30;
const TOP_LIMIT = 20;
const MAX_MEMBER_TITLES = 4; // до 4 заголовков членов каскада
const MAX_TOKENS = 2000;     // анализ 20 сущностей — с запасом

const TOPICS_ENABLED = process.env.TOPICS_ENABLED === 'true';

type ViralityScope = 'cascades_24h' | 'stories_7d' | 'topics';

const VIRALITY_PROMPT = `Ты — редактор новостной ленты PULSE. Проанализируй, что провоцирует массовые перепечатки.

Вход: список из до 20 самых цитируемых сущностей (заголовки, размеры, источники, длительность).
{{ENTITIES}}

Задача: объясни, что провоцирует на массовые перепечатки.

Ответь строго JSON:
{
  "top_topics":   [{"title": "...", "takeaway": "1 предложение"} ...],   // 3-5 пунктов
  "virality_triggers": ["...", ...],                                     // общие триггеры: числа, персоны, регуляторика, гео...
  "ignition":     {"sources": ["...", ...], "takeaway": "..."},          // кто чаще первоисточник в топе
  "tempo":        {"fast_vs_slow": "...", "takeaway": "..."},            // всплески vs долгие каскады
  "summary":      "2-3 предложения итогом"
}

Правила: опирайся ТОЛЬКО на события из входа; запрещено добавлять события, которых нет во входе.`;

interface CascadeItem {
  id: string;
  size: number;
  lifeMin: number | null;
  tags: string[];
  sources: string[];
  titles: string[]; // до MAX_MEMBER_TITLES заголовков членов
}

interface StoryItem {
  id: string;
  title: string;
  summary: string;
  newsCount: number;
  startedAt: string;
  lastSeenAt: string;
}

interface TopicItem {
  id: string;
  name: string | null;
  summary: string | null;
  keywords: string[];
  trend: string | null;
  newsCount: number;
}

// ─── Выборки топ-20 (ТЗ-185 задача 2 п.1) ───────────────────────────────────

async function fetchCascades(): Promise<CascadeItem[]> {
  // Своя выборка (НЕ кэш/пейлоад /cascades — после ТЗ-184 v4 он отсортирован
  // по свежести, для виральности нужен топ по размеру)
  const res = await query(
    `SELECT c.id, c.size, c.tags,
            EXTRACT(EPOCH FROM (c.last_seen_at - c.first_published_at)) / 60 AS life_min,
            fn.title AS first_title,
            (SELECT array_agg(t ORDER BY lag) FROM (
               SELECT COALESCE(n.title_ru, n.title_original) AS t, ci.lag_min AS lag
               FROM cluster_items ci
               JOIN news n ON n.id = ci.news_id
               WHERE ci.cluster_id = c.id
               ORDER BY ci.lag_min
               LIMIT $1
             ) x) AS titles,
            (SELECT array_agg(DISTINCT n.source) FROM cluster_items ci
              JOIN news n ON n.id = ci.news_id
              WHERE ci.cluster_id = c.id) AS sources
     FROM clusters c
     LEFT JOIN LATERAL (
       SELECT COALESCE(n.title_ru, n.title_original) AS title
       FROM cluster_items ci
       JOIN news n ON n.id = ci.news_id
       WHERE ci.cluster_id = c.id
       ORDER BY ci.lag_min
       LIMIT 1
     ) fn ON true
     WHERE c.last_seen_at > NOW() - INTERVAL '24 hours'
     ORDER BY c.size DESC
     LIMIT $2`,
    [MAX_MEMBER_TITLES, CANDIDATE_LIMIT]
  );
  const items: CascadeItem[] = [];
  for (const r of res.rows) {
    // Рубрики-дайджесты («Что случилось за день») забивают топ размером —
    // отсекаем по первому заголовку (RUBRIC_BLACKLIST)
    if (isRubricTitle(String(r.first_title || ''))) continue;
    items.push({
      id: r.id,
      size: Number(r.size),
      lifeMin: r.life_min != null ? Math.round(Number(r.life_min)) : null,
      tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
      sources: Array.isArray(r.sources) ? r.sources.map(String) : [],
      titles: Array.isArray(r.titles) ? r.titles.map(String) : [],
    });
    if (items.length >= TOP_LIMIT) break;
  }
  return items;
}

async function fetchStories(): Promise<StoryItem[]> {
  // Число новостей сюжета = сумма size кластеров (как storyNewsCount на фронте)
  const res = await query(
    `SELECT s.id, s.title, s.summary, s.started_at, s.last_seen_at,
            COALESCE(SUM(c.size), 0) AS news_count
     FROM stories s
     LEFT JOIN clusters c ON c.story_id = s.id
     WHERE s.last_seen_at > NOW() - INTERVAL '7 days'
     GROUP BY s.id
     ORDER BY news_count DESC
     LIMIT $1`,
    [TOP_LIMIT]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    title: String(r.title || ''),
    summary: String(r.summary || ''),
    newsCount: Number(r.news_count),
    startedAt: new Date(r.started_at).toISOString().slice(0, 10),
    lastSeenAt: new Date(r.last_seen_at).toISOString().slice(0, 10),
  }));
}

async function fetchTopics(): Promise<TopicItem[]> {
  // Темы последнего done-прогона; keywords (jsonb, top-terms TF-IDF) текущий
  // запрос /topics не выбирает — берём отдельно здесь
  const res = await query(
    `SELECT t.id, t.name, t.summary, t.named, t.news_count, t.trend, t.keywords
     FROM topics t
     WHERE t.run_id = (
       SELECT id FROM topic_runs
       WHERE status = 'done'
       ORDER BY finished_at DESC NULLS LAST
       LIMIT 1
     )
     ORDER BY t.news_count DESC
     LIMIT $1`,
    [TOP_LIMIT]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    name: r.named ? String(r.name || '') : null,
    summary: r.named ? String(r.summary || '') : null,
    keywords: Array.isArray(r.keywords) ? r.keywords.map(String) : [],
    trend: r.trend != null ? String(r.trend) : null,
    newsCount: Number(r.news_count),
  }));
}

// ─── Текст входа для промпта ────────────────────────────────────────────────

function cascadesToText(items: CascadeItem[]): string {
  return items
    .map((c, i) => {
      const head = `[${i}] каскад из ${c.size} новостей` +
        (c.lifeMin != null ? `, жизнь ${c.lifeMin} мин` : '') +
        (c.sources.length > 0 ? `, источники: ${c.sources.join(', ')}` : '') +
        (c.tags.length > 0 ? `, теги: ${c.tags.join(', ')}` : '');
      const titles = c.titles.map((t) => `  - «${t.slice(0, 160)}»`).join('\n');
      return `${head}\n${titles}`;
    })
    .join('\n\n');
}

function storiesToText(items: StoryItem[]): string {
  return items
    .map((s, i) => {
      const head = `[${i}] сюжет «${s.title.slice(0, 160)}» — ${s.newsCount} новостей` +
        ` за период ${s.startedAt}..${s.lastSeenAt}`;
      const summary = s.summary ? `\n  ${s.summary.slice(0, 400)}` : '';
      return `${head}${summary}`;
    })
    .join('\n\n');
}

function topicsToText(items: TopicItem[]): string {
  return items
    .map((t, i) => {
      const head = `[${i}] тема «${t.name || '(без названия)'}» — ${t.newsCount} новостей` +
        (t.trend ? `, тренд: ${t.trend}` : '');
      const summary = t.summary ? `\n  ${t.summary.slice(0, 400)}` : '';
      const keywords = t.keywords.length > 0 ? `\n  ключевые слова: ${t.keywords.slice(0, 10).join(', ')}` : '';
      return `${head}${summary}${keywords}`;
    })
    .join('\n\n');
}

// ─── LLM-вызов, валидация и запись (fail-closed, §9.3) ──────────────────────

// Парсинг ТОЛЬКО по явным ключам; любое отсутствие = отчёт не записан (как clusterVerifier)
function isValidPayload(p: any): boolean {
  if (!p || typeof p !== 'object') return false;
  if (!Array.isArray(p.top_topics)) return false;
  for (const t of p.top_topics) {
    if (!t || typeof t !== 'object' || typeof t.title !== 'string' || typeof t.takeaway !== 'string') return false;
  }
  if (!Array.isArray(p.virality_triggers)) return false;
  for (const s of p.virality_triggers) {
    if (typeof s !== 'string') return false;
  }
  if (
    !p.ignition || typeof p.ignition !== 'object' ||
    !Array.isArray(p.ignition.sources) ||
    typeof p.ignition.takeaway !== 'string'
  ) return false;
  if (
    !p.tempo || typeof p.tempo !== 'object' ||
    typeof p.tempo.fast_vs_slow !== 'string' ||
    typeof p.tempo.takeaway !== 'string'
  ) return false;
  if (typeof p.summary !== 'string') return false;
  return true;
}

async function analyzeAndStore(
  scope: ViralityScope,
  entitiesText: string,
  inputIds: string[]
): Promise<void> {
  if (!KIMI_API_KEY) {
    console.warn('[Virality] KIMI_API_KEY не задан — пропуск');
    return;
  }

  const prompt = VIRALITY_PROMPT.split('{{ENTITIES}}').join(entitiesText);

  let content = '';
  try {
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: KIMI_MODEL.startsWith('kimi-k') ? VERIFIER_MODEL_TEMPERATURE : 0.1,
        max_tokens: MAX_TOKENS,
        response_format: { type: 'json_object' },
        thinking: KIMI_MODEL.startsWith('kimi-k') ? { type: 'disabled' } : undefined,
      },
      {
        headers: { Authorization: `Bearer ${KIMI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: VERIFIER_TIMEOUT_MS,
      }
    );
    content = response.data?.choices?.[0]?.message?.content || '';
  } catch (err: any) {
    console.warn(`[Virality] ${scope}: LLM-ошибка: ${err.message?.slice(0, 120)} — старый отчёт остаётся`);
    return;
  }

  let parsed: any = null;
  try {
    const raw = content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[Virality] ${scope}: невалидный JSON — отчёт не записан (fail-closed)`);
    return;
  }

  if (!isValidPayload(parsed)) {
    console.warn(`[Virality] ${scope}: отсутствуют обязательные ключи — отчёт не записан (fail-closed)`);
    return;
  }

  await query(
    'INSERT INTO virality_reports (scope, input_ids, payload) VALUES ($1, $2, $3)',
    [scope, inputIds, JSON.stringify(parsed)]
  );
  console.log(`[Virality] ${scope}: отчёт записан (сущностей во входе: ${inputIds.length})`);
}

// ─── Скоупы ─────────────────────────────────────────────────────────────────

async function runCascadesScope(): Promise<void> {
  const items = await fetchCascades();
  if (items.length === 0) {
    console.log('[Virality] cascades_24h: нет кандидатов за 24ч — отчёт не записан');
    return;
  }
  await analyzeAndStore('cascades_24h', cascadesToText(items), items.map((c) => c.id));
}

async function runStoriesScope(): Promise<void> {
  const items = await fetchStories();
  if (items.length === 0) {
    console.log('[Virality] stories_7d: нет сюжетов за 7д — отчёт не записан');
    return;
  }
  await analyzeAndStore('stories_7d', storiesToText(items), items.map((s) => s.id));
}

async function runTopicsScope(): Promise<void> {
  const items = await fetchTopics();
  if (items.length === 0) {
    console.log('[Virality] topics: нет тем последнего прогона — отчёт не записан');
    return;
  }
  await analyzeAndStore('topics', topicsToText(items), items.map((t) => t.id));
}

// ─── Точка входа ────────────────────────────────────────────────────────────

/**
 * Разовый прогон трёх скоупов подряд. Падение одного скоупа не отменяет
 * остальные (лог + дальше). Скоуп topics мягко пропускается при
 * TOPICS_ENABLED !== 'true' (на Render таблиц тем нет).
 */
export async function runViralityAnalytics(): Promise<void> {
  const startedAt = Date.now();
  console.log('[Virality] старт прогона аналитики виральности');

  const scopes: Array<[ViralityScope, () => Promise<void>]> = [
    ['cascades_24h', runCascadesScope],
    ['stories_7d', runStoriesScope],
    ['topics', runTopicsScope],
  ];
  for (const [scope, fn] of scopes) {
    if (scope === 'topics' && !TOPICS_ENABLED) {
      console.log('[Virality] topics: TOPICS_ENABLED != true — скоуп пропущен (на Render таблиц тем нет)');
      continue;
    }
    console.log(`[Virality] скоуп ${scope}: сбор входа…`);
    try {
      await fn();
    } catch (err: any) {
      console.warn(`[Virality] ${scope}: ошибка скоупа — ${err.message?.slice(0, 150)} (остальные скоупы продолжаются)`);
    }
  }

  console.log(`[Virality] прогон завершён за ${Date.now() - startedAt}мс`);
}
