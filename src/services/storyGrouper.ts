/**
 * =============================================================================
 * PULSE — Группировка каскадов в сюжеты (ТЗ-92, задача 5)
 * =============================================================================
 *
 * Сюжет = группа каскадов одной развивающейся истории (Методология §6.1):
 * общий предмет и причинная цепочка. Пример: ежедневные сводки ПВО — ОДИН
 * сюжет при разных числах; закрытие консульства → ответ МИД — ОДИН сюжет.
 *
 * Запуск: раз в час по cron (пересмотр раз в час достаточен — сюжеты
 * медленные, Методология §6.1 п.5). Фиче-флаг — CLUSTERING_ENABLED.
 *
 * Кандидаты: кластеры size >= 8 ИЛИ жизнь > 24 ч, ещё без story_id
 * (включая импортные kind='story_candidate'). Батч-вызов LLM: на вход —
 * первый заголовок + 2–3 типичных дубля каждого кандидата; на выход —
 * назначение story_id (существующий сюжет или новый с title/summary).
 *
 * Конвенции вызова — §9.1 Методологии (как clusterVerifier): kimi-k2.6,
 * temp 0.6, thinking disabled, response_format json_object. Парсинг по
 * явным ключам, fail-closed (§9.3).
 *
 * Обратная операция (разбиение сюжетного мега-кластера на каскады) —
 * тем же вызовом, отдельным ТЗ при необходимости; здесь не реализуем,
 * чтобы не ломать ручную разметку владельца.
 */

import axios from 'axios';
import { query } from '../config/db';
import {
  VERIFIER_MODEL_TEMPERATURE,
  VERIFIER_TIMEOUT_MS,
} from '../config/clustering';

const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';

const MAX_CANDIDATES = 30;
const MAX_EXISTING_STORIES = 30;
const MAX_TOKENS = 4000; // батч до 30 кластеров — с запасом

const STORY_GROUPING_PROMPT = `Ты — редактор новостной ленты PULSE. Сгруппируй новостные каскады в СЮЖЕТЫ — развивающиеся истории.

Критерий «одна история»: общий предмет И причинная цепочка. Примеры:
- ежедневные сводки ПВО с разными числами — ОДИН сюжет (продолжающаяся история);
- закрытие консульства → ответ МИД — ОДИН сюжет (цепочка событий);
- рост и падение нефти на одних драйверах — один сюжет; на разных — разные.

Кластеры-кандидаты:
{{CLUSTERS}}

Существующие сюжеты:
{{STORIES}}

Для КАЖДОГО кластера-кандидата назначь сюжет: индекс существующего ИЛИ новый (придумай title и короткий summary).

Ответь строго JSON:
{"assignments": [{"cluster_index": 0, "story_index": 0 или null, "new_title": "...", "new_summary": "..."}]}`;

interface ClusterCandidate {
  id: string;
  size: number;
  first_published_at: string;
  last_seen_at: string;
  samples: { title: string; source: string; published_at: string }[];
}

function fillTemplate(prompt: string, vars: Record<string, string>): string {
  let out = prompt;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

export async function runStoryGrouping(): Promise<{ assigned: number; candidates: number }> {
  if (!KIMI_API_KEY) {
    console.warn('[StoryGrouper] KIMI_API_KEY не задан — пропуск');
    return { assigned: 0, candidates: 0 };
  }

  // Кандидаты: большие или долгоживущие кластеры без сюжета
  const candRes = await query(
    `SELECT id, size, first_published_at, last_seen_at
     FROM clusters
     WHERE story_id IS NULL
       AND (size >= 8 OR last_seen_at - first_published_at > INTERVAL '24 hours')
     ORDER BY size DESC
     LIMIT $1`,
    [MAX_CANDIDATES]
  );
  const candidates: ClusterCandidate[] = [];
  for (const row of candRes.rows) {
    const samplesRes = await query(
      `SELECT n.title_ru, n.source, n.published_at
       FROM cluster_items ci
       JOIN news n ON n.id = ci.news_id
       WHERE ci.cluster_id = $1
       ORDER BY n.published_at ASC
       LIMIT 4`,
      [row.id]
    );
    candidates.push({
      id: row.id,
      size: row.size,
      first_published_at: row.first_published_at,
      last_seen_at: row.last_seen_at,
      samples: samplesRes.rows.map((r: any) => ({
        title: r.title_ru || '',
        source: r.source || '',
        published_at: r.published_at,
      })),
    });
  }
  if (candidates.length === 0) {
    return { assigned: 0, candidates: 0 };
  }

  const storiesRes = await query(
    'SELECT id, title FROM stories ORDER BY last_seen_at DESC NULLS LAST LIMIT $1',
    [MAX_EXISTING_STORIES]
  );
  const existingStories = storiesRes.rows as { id: string; title: string }[];

  const clustersText = candidates
    .map((c, i) => {
      const items = c.samples
        .map((s) => `  - «${s.title.slice(0, 160)}» (${s.source}, ${s.published_at.slice(0, 16).replace('T', ' ')})`)
        .join('\n');
      return `[${i}] кластер из ${c.size} новостей:\n${items}`;
    })
    .join('\n\n');
  const storiesText =
    existingStories.length > 0
      ? existingStories.map((s, i) => `[${i}] ${s.title || '(без названия)'}`).join('\n')
      : '(нет — создавай новые)';

  const prompt = fillTemplate(STORY_GROUPING_PROMPT, {
    CLUSTERS: clustersText,
    STORIES: storiesText,
  });

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
    console.warn(`[StoryGrouper] LLM-ошибка: ${err.message?.slice(0, 120)}`);
    return { assigned: 0, candidates: candidates.length };
  }

  let parsed: any = null;
  try {
    const raw = content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    parsed = JSON.parse(raw);
  } catch {
    console.warn('[StoryGrouper] невалидный JSON — пропуск прогона');
    return { assigned: 0, candidates: candidates.length };
  }

  const assignments = Array.isArray(parsed?.assignments) ? parsed.assignments : [];
  let assigned = 0;

  for (const a of assignments) {
    if (
      !a ||
      typeof a.cluster_index !== 'number' ||
      a.cluster_index < 0 ||
      a.cluster_index >= candidates.length
    ) {
      continue; // fail-closed
    }
    const cluster = candidates[a.cluster_index];
    try {
      const storyId = await resolveStoryId(a, existingStories);
      if (!storyId) continue;
      await query('UPDATE clusters SET story_id = $1 WHERE id = $2', [storyId, cluster.id]);
      await refreshStoryBounds(storyId);
      assigned++;
    } catch (err: any) {
      console.warn(`[StoryGrouper] кластер ${cluster.id} не назначен: ${err.message?.slice(0, 100)}`);
    }
  }

  console.log(`[StoryGrouper] кандидатов: ${candidates.length}, назначено в сюжеты: ${assigned}`);
  return { assigned, candidates: candidates.length };
}

/** story_index → существующий сюжет; иначе создаём новый (fail-closed без title) */
async function resolveStoryId(
  a: any,
  existingStories: { id: string; title: string }[]
): Promise<string | null> {
  if (typeof a.story_index === 'number' && a.story_index >= 0 && a.story_index < existingStories.length) {
    return existingStories[a.story_index].id;
  }
  const title = typeof a.new_title === 'string' ? a.new_title.trim() : '';
  if (!title) return null; // новый сюжет без названия — отклоняем
  const summary = typeof a.new_summary === 'string' ? a.new_summary.trim().slice(0, 2000) : '';
  const ins = await query(
    'INSERT INTO stories (title, summary) VALUES ($1, $2) RETURNING id',
    [title.slice(0, 300), summary]
  );
  const id = ins.rows[0].id as string;
  existingStories.unshift({ id, title }); // последующие кластеры могут сослаться на новый
  return id;
}

/** started_at = min first_published_at, last_seen_at = max last_seen_at членов */
async function refreshStoryBounds(storyId: string): Promise<void> {
  await query(
    `UPDATE stories SET
       started_at = (SELECT MIN(c.first_published_at) FROM clusters c WHERE c.story_id = $1),
       last_seen_at = (SELECT MAX(c.last_seen_at) FROM clusters c WHERE c.story_id = $1)
     WHERE id = $1`,
    [storyId]
  );
}
