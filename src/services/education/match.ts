/**
 * =============================================================================
 * PULSE — LMS «Образование»: мэтчинг курсов с новостями (ТЗ-103, Задачи 1–3)
 * =============================================================================
 *
 * Принцип (зафиксировано с владельцем): система только РЕКОМЕНДУЕТ.
 * Автоприкрепления новостей к курсам нет — решение принимает редактор
 * (attach/dismiss в adminEducation, Задача 4).
 *
 * Пайплайн двухстадийный: RECALL (теги `&&` + top-10 косинус эмбеддинга,
 * паттерн clustering.ts:322) → RANK (LLM-батч по паттерну clusterVerifier.ts:
 * один запрос на батч пар, модель KIMI_MODEL, суточный in-memory лимит).
 * При исчерпании лимита/отсутствии ключа пары пишутся только по тег-матчу
 * со score = NULL («без LLM-оценки») — штатная деградация.
 *
 * Всё под фичефлагом EDUCATION_MATCH_ENABLED (default 'false'): выключен —
 * хук, ретроскан и cron-страховка no-op (Задача 6).
 *
 * Dual-mode: PG — pgvector (`1 - (embedding <=> $1::vector)`, vectorLiteral);
 * SQLite — courses.embedding JSON-текст, косинус в JS; news.embedding в SQLite
 * нет (колонка PG-миграции news_embeddings_v1) → эмбеддинг-RECALL новостей
 * только на PG.
 */

import crypto from 'crypto';
import axios from 'axios';
import { query } from '../../config/db';
import { nowSql } from '../../utils/nowSql';
import { embedBatch, EMBEDDING_DIM, EMBEDDING_MAX_TEXT } from '../embeddings';
import { VERIFIER_MODEL_TEMPERATURE } from '../../config/clustering';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const KIMI_API_KEY = process.env.KIMI_API_KEY;
const KIMI_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';

/** Суточный потолок LLM-вызовов ранкера (страховка стоимости, ТЗ-103 §4.1) */
const MATCH_LLM_DAILY_LIMIT = parseInt(process.env.EDUCATION_MATCH_LLM_DAILY_LIMIT || '500', 10);
/** Ретроскан: максимум новостей за прогон (ТЗ-103 Задача 3) */
const RETROSCAN_MAX_NEWS = 200;
/** Retention новостей 14 дней → окно ретроскана (ТЗ-103) */
const RETENTION_DAYS = 14;
/** Пар в одном LLM-запросе */
const RANK_BATCH_SIZE = 8;

export function isEducationMatchEnabled(): boolean {
  return process.env.EDUCATION_MATCH_ENABLED === 'true';
}

// ─── Суточный LLM-счётчик (паттерн clusterVerifier.ts:47-53) ───────────────

let matchDailyCount = 0;
let matchDailyDate = '';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getMatchDailyCount(): { date: string; count: number } {
  return { date: matchDailyDate, count: matchDailyCount };
}

function matchLimitAvailable(): boolean {
  const date = todayUtc();
  if (matchDailyDate !== date) {
    matchDailyDate = date;
    matchDailyCount = 0;
  }
  return matchDailyCount < MATCH_LLM_DAILY_LIMIT;
}

// ─── Утилиты векторов/тегов ─────────────────────────────────────────────────

function vectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/** PG возвращает vector как '[0.1,0.2,...]' — парсим обратно в массив. */
function parseVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== 'string' || !value.startsWith('[')) return null;
  const v = value.slice(1, -1).split(',').map(Number);
  return v.length === EMBEDDING_DIM && v.every(Number.isFinite) ? v : null;
}

/** matched_tags: PG — TEXT[], SQLite — JSON-строка (ТЗ-103 v3 п.2). */
function parseTagArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// news.embedding есть только в PG (SQLite-схема её не содержит) —
// проверяем наличие колонки один раз на процесс.
let newsEmbeddingChecked = false;
let newsEmbeddingAvailable = false;

async function hasNewsEmbedding(): Promise<boolean> {
  if (newsEmbeddingChecked) return newsEmbeddingAvailable;
  newsEmbeddingChecked = true;
  try {
    await query('SELECT embedding FROM news LIMIT 0', []);
    newsEmbeddingAvailable = true;
  } catch {
    newsEmbeddingAvailable = false;
  }
  return newsEmbeddingAvailable;
}

// ─── Задача 1 — эмбеддинги курсов ───────────────────────────────────────────

/**
 * Текст курса для эмбеддинга: title + '\n' + description + '\n' + названия
 * уроков, обрезка EMBEDDING_MAX_TEXT (ТЗ-103 Задача 1).
 */
async function courseEmbeddingText(courseId: string): Promise<string> {
  const courseR = await query(
    `SELECT title, description FROM courses WHERE id = $1`, [courseId],
  );
  if (courseR.rows.length === 0) throw new Error('курс не найден');
  const lessonsR = await query(
    `SELECT title FROM course_lessons WHERE course_id = $1 ORDER BY position ASC`,
    [courseId],
  );
  const parts = [
    courseR.rows[0].title || '',
    courseR.rows[0].description || '',
    ...lessonsR.rows.map((l: any) => l.title || ''),
  ];
  return parts.join('\n').slice(0, EMBEDDING_MAX_TEXT);
}

/**
 * Считать и сохранить эмбеддинг курса. PG: vectorLiteral -> vector(1024);
 * SQLite: JSON.stringify. Ошибки пробрасываются вызывающему (триггеры
 * логируют и не валят запрос).
 */
export async function computeCourseEmbedding(courseId: string): Promise<void> {
  const text = await courseEmbeddingText(courseId);
  if (!text.trim()) return; // пустой курс не эмбеддим
  const [vector] = await embedBatch([text]);
  await query(
    USE_SQLITE
      ? `UPDATE courses SET embedding = $1 WHERE id = $2`
      : `UPDATE courses SET embedding = $1::vector WHERE id = $2`,
    [USE_SQLITE ? JSON.stringify(vector) : vectorLiteral(vector), courseId],
  );
}

/** Асинхронный пересчёт эмбеддинга (триггеры Задачи 1): ошибки → лог, не throw. */
export function scheduleCourseReembedding(courseId: string): void {
  if (!isEducationMatchEnabled()) return;
  void computeCourseEmbedding(courseId).catch((err: any) => {
    console.warn(`[EducationMatch] embedding course ${courseId} failed:`, err?.message);
  });
}

// ─── Задача 2 — RECALL ──────────────────────────────────────────────────────

interface RecallCandidate {
  id: string;
  tagMatch: boolean;
  sim: number | null;
}

const PUBLISHED_COURSES = `c.status = 'published' AND c.deleted_at IS NULL`;

/** Кандидаты-курсы для новости: пересечение тегов + top-10 по косинусу. */
async function recallCoursesForNews(news: {
  id: string;
  matched_tags: unknown;
  embedding?: unknown;
}): Promise<Map<string, RecallCandidate>> {
  const candidates = new Map<string, RecallCandidate>();
  const tags = parseTagArray(news.matched_tags);

  if (tags.length > 0) {
    let rows;
    if (USE_SQLITE) {
      const ph = tags.map((_, i) => `$${i + 1}`).join(',');
      rows = await query(
        `SELECT DISTINCT c.id FROM courses c
           JOIN course_tags ct ON ct.course_id = c.id
         WHERE ${PUBLISHED_COURSES} AND ct.tag_id IN (${ph})`,
        tags,
      );
    } else {
      rows = await query(
        `SELECT DISTINCT c.id FROM courses c
           JOIN course_tags ct ON ct.course_id = c.id
         WHERE ${PUBLISHED_COURSES} AND ct.tag_id = ANY($1::text[])`,
        [tags],
      );
    }
    for (const r of rows.rows) {
      candidates.set(r.id, { id: r.id, tagMatch: true, sim: null });
    }
  }

  const newsVector = parseVector((news as any).embedding);
  if (newsVector && !USE_SQLITE) {
    const simRows = await query(
      `SELECT c.id, 1 - (c.embedding <=> $1::vector) AS sim
       FROM courses c
       WHERE ${PUBLISHED_COURSES} AND c.embedding IS NOT NULL
       ORDER BY c.embedding <=> $1::vector
       LIMIT 10`,
      [vectorLiteral(newsVector)],
    );
    for (const r of simRows.rows) {
      const existing = candidates.get(r.id);
      if (existing) existing.sim = Number(r.sim);
      else candidates.set(r.id, { id: r.id, tagMatch: false, sim: Number(r.sim) });
    }
  }

  return candidates;
}

/** Кандидаты-новости для курса (ретроскан): теги в окне + top-10 косинус. */
async function recallNewsForCourse(
  course: { id: string; embedding?: unknown },
  courseTags: string[],
  cutoffIso: string,
): Promise<Map<string, RecallCandidate>> {
  const candidates = new Map<string, RecallCandidate>();

  const newsR = await query(
    `SELECT id, matched_tags FROM news
     WHERE published_at >= $1
     ORDER BY published_at DESC
     LIMIT $2`,
    [cutoffIso, RETROSCAN_MAX_NEWS],
  );
  for (const n of newsR.rows) {
    const newsTags = parseTagArray(n.matched_tags);
    if (courseTags.length > 0 && newsTags.some((t) => courseTags.includes(t))) {
      candidates.set(n.id, { id: n.id, tagMatch: true, sim: null });
    }
  }

  const courseVector = parseVector((course as any).embedding);
  if (courseVector && !USE_SQLITE) {
    const simRows = await query(
      `SELECT n.id, 1 - (n.embedding <=> $1::vector) AS sim
       FROM news n
       WHERE n.embedding IS NOT NULL AND n.published_at >= $2
       ORDER BY n.embedding <=> $1::vector
       LIMIT 10`,
      [vectorLiteral(courseVector), cutoffIso],
    );
    for (const r of simRows.rows) {
      const existing = candidates.get(r.id);
      if (existing) existing.sim = Number(r.sim);
      else candidates.set(r.id, { id: r.id, tagMatch: false, sim: Number(r.sim) });
    }
  }

  return candidates;
}

// ─── Задача 2 — RANK (LLM-батч по паттерну clusterVerifier) ─────────────────

interface RankItem {
  courseId: string;
  newsId: string;
  courseTitle: string;
  newsTitle: string;
  tagMatch: boolean;
  sim: number | null;
  sharedTagNames: string[];
}

const RANK_PROMPT = `Ты — редактор образовательной платформы PULSE. Даны пары «новость ↔ курс». Для каждой пары оцени, насколько новость полезна ученику этого курса прямо сейчас: score от 0 (нерелевантно) до 1 (обязательно прочитать ученику). score >= 0.5 — новость стоит показать редактору для прикрепления к курсу.

Пары:
{{PAIRS}}

Ответь строго JSON, вердикт на каждую пару по её номеру:
{"verdicts":[{"index":1,"score":0.0,"reason":"одна короткая фраза на русском"}]}`;

async function llmRankBatch(items: RankItem[]): Promise<Map<number, { score: number; reason: string }>> {
  const verdicts = new Map<number, { score: number; reason: string }>();
  if (items.length === 0) return verdicts;

  if (!KIMI_API_KEY) {
    console.warn('[EducationMatch] KIMI_API_KEY не задан — RANK пропущен (пары только по тег-матчу, score NULL)');
    return verdicts; // fail-closed по паттерну clusterVerifier
  }
  if (!matchLimitAvailable()) {
    console.warn(`[EducationMatch] суточный лимит ${MATCH_LLM_DAILY_LIMIT} исчерпан — RANK пропущен (пары только по тег-матчу, score NULL)`);
    return verdicts;
  }

  const pairsText = items.map((it, i) => {
    const tagNote = it.sharedTagNames.length > 0 ? ` (общие теги: ${it.sharedTagNames.join(', ')})` : '';
    return `${i + 1}. Новость: «${it.newsTitle.slice(0, 200)}» | Курс: «${it.courseTitle.slice(0, 200)}»${tagNote}`;
  }).join('\n');

  let content = '';
  try {
    const response = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL,
        messages: [{ role: 'user', content: RANK_PROMPT.split('{{PAIRS}}').join(pairsText) }],
        temperature: KIMI_MODEL.startsWith('kimi-k') ? VERIFIER_MODEL_TEMPERATURE : 0.1,
        max_tokens: 1024,
        response_format: { type: 'json_object' },
        thinking: KIMI_MODEL.startsWith('kimi-k') ? { type: 'disabled' } : undefined,
      },
      {
        headers: { Authorization: `Bearer ${KIMI_API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 60_000,
      },
    );
    content = response.data?.choices?.[0]?.message?.content || '';
  } catch (err: any) {
    console.warn(`[EducationMatch] LLM-ошибка ранкера: ${err.message?.slice(0, 120)}`);
    return verdicts;
  }
  matchDailyCount++;

  // Парсинг ТОЛЬКО по явным ключам; отсутствие индекса = пара без оценки
  try {
    const raw = content.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.verdicts)) {
      for (const v of parsed.verdicts) {
        if (typeof v?.index !== 'number' || typeof v?.score !== 'number') continue;
        const idx = v.index - 1;
        if (idx < 0 || idx >= items.length) continue;
        verdicts.set(idx, {
          score: Math.min(1, Math.max(0, v.score)),
          reason: typeof v.reason === 'string' ? v.reason.slice(0, 300) : '',
        });
      }
    }
  } catch {
    console.warn('[EducationMatch] невалидный JSON ранкера — пары без LLM-оценки');
  }
  return verdicts;
}

/** Названия общих тегов (для reason 'общий тег: X'). */
async function sharedTagNames(courseId: string, newsTags: string[]): Promise<string[]> {
  if (newsTags.length === 0) return [];
  const ph = newsTags.map((_, i) => `$${i + 2}`).join(',');
  const r = await query(
    `SELECT ct.tag_id, udt.tag_name FROM course_tags ct
       LEFT JOIN user_defined_tags udt ON udt.tag_id = ct.tag_id
     WHERE ct.course_id = $1 AND ct.tag_id IN (${ph})`,
    [courseId, ...newsTags],
  );
  return r.rows.map((row: any) => row.tag_name || row.tag_id);
}

/** Записать пары: только score >= 0.5 ИЛИ тег-матч; ON CONFLICT DO NOTHING —
 * повторный мэтчинг не перетирает решение редактора (ТЗ-103 критерий 6). */
async function writeSuggestions(
  items: RankItem[],
  verdicts: Map<number, { score: number; reason: string }>,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const verdict = verdicts.get(i);
    const score = verdict ? verdict.score : null;
    const hasTagReason = it.sharedTagNames.length > 0;
    // В БД пишем только пары со score >= 0.5 ИЛИ с тег-матчем (Задача 2 п.2)
    if (!(score !== null && score >= 0.5) && !it.tagMatch) continue;
    const source = it.tagMatch && it.sim !== null ? 'both' : it.tagMatch ? 'tag' : 'embedding';
    const reason = verdict?.reason
      || (hasTagReason ? `общий тег: ${it.sharedTagNames.join(', ')}`.slice(0, 300) : null);
    const r = await query(
      `INSERT INTO course_match_suggestions
         (id, course_id, news_id, score, reason, source, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', ${nowSql()})
       ON CONFLICT (course_id, news_id) DO NOTHING`,
      [crypto.randomUUID(), it.courseId, it.newsId, score, reason, source],
    );
    if ((r.rowCount ?? 0) > 0) written++;
  }
  return written;
}

/** RECALL → RANK → запись для списка кандидатов одной новости/курса. */
async function rankAndStore(items: RankItem[]): Promise<number> {
  let written = 0;
  for (let start = 0; start < items.length; start += RANK_BATCH_SIZE) {
    const chunk = items.slice(start, start + RANK_BATCH_SIZE);
    const verdicts = await llmRankBatch(chunk);
    written += await writeSuggestions(chunk, verdicts);
  }
  return written;
}

async function fetchCourseCard(courseId: string): Promise<{ id: string; title: string } | null> {
  const r = await query(`SELECT id, title FROM courses WHERE id = $1`, [courseId]);
  return r.rows.length > 0 ? r.rows[0] : null;
}

// ─── Задача 3 — инкрементальный хук (из newsProcessor) ─────────────────────

/**
 * RECALL+RANK новости против всех опубликованных курсов. Вызывается
 * асинхронно из пайплайна новостей ПОСЛЕ проставления matched_tags+embedding;
 * ошибки глотаются вызывающим — мэтчинг не ломает парсинг.
 */
export async function matchNewsToCourses(newsId: string): Promise<void> {
  if (!isEducationMatchEnabled()) return;
  const withEmbedding = !USE_SQLITE && (await hasNewsEmbedding());
  const newsR = await query(
    `SELECT id, title_ru, summary_ru, matched_tags, source, published_at${withEmbedding ? ', embedding' : ''}
     FROM news WHERE id = $1`,
    [newsId],
  );
  if (newsR.rows.length === 0) return;
  const news = newsR.rows[0];

  const candidates = await recallCoursesForNews(news);
  if (candidates.size === 0) return;

  const ids = [...candidates.keys()];
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const coursesR = await query(
    `SELECT id, title FROM courses WHERE id IN (${ph})`, ids,
  );
  const newsTags = parseTagArray(news.matched_tags);
  const items: RankItem[] = [];
  for (const c of coursesR.rows) {
    const cand = candidates.get(c.id)!;
    items.push({
      courseId: c.id,
      newsId,
      courseTitle: c.title || '',
      newsTitle: news.title_ru || '',
      tagMatch: cand.tagMatch,
      sim: cand.sim,
      sharedTagNames: cand.tagMatch ? await sharedTagNames(c.id, newsTags) : [],
    });
  }
  const written = await rankAndStore(items);
  if (written > 0) {
    console.log(`[EducationMatch] news ${newsId}: ${written} suggestion(s)`);
  }
}

// ─── Задача 3 — ретроскан при публикации ────────────────────────────────────

/**
 * Ретроскан курса: новости за 14 дней (retention, ТЗ-103) против курса,
 * максимум 200 свежих (published_at DESC). LLM-лимит общий с инкрементальным
 * мэтчингом — при исчерпании пары пишутся только по тег-матчу (score NULL).
 */
export async function retroscanCourse(courseId: string): Promise<void> {
  if (!isEducationMatchEnabled()) return;
  const course = await fetchCourseCard(courseId);
  if (!course) return;

  const courseR = await query(
    `SELECT embedding FROM courses WHERE id = $1`, [courseId],
  );
  const courseTagsR = await query(
    `SELECT tag_id FROM course_tags WHERE course_id = $1`, [courseId],
  );
  const courseTags = courseTagsR.rows.map((r: any) => r.tag_id);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000).toISOString();

  const candidates = await recallNewsForCourse(
    { id: courseId, embedding: courseR.rows[0]?.embedding },
    courseTags,
    cutoff,
  );
  if (candidates.size === 0) {
    console.log(`[EducationMatch] retroscan course ${courseId}: no candidates`);
    return;
  }

  const ids = [...candidates.keys()];
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const newsR = await query(
    `SELECT id, title_ru, matched_tags FROM news WHERE id IN (${ph})`, ids,
  );
  const items: RankItem[] = [];
  for (const n of newsR.rows) {
    const cand = candidates.get(n.id)!;
    const newsTags = parseTagArray(n.matched_tags);
    items.push({
      courseId,
      newsId: n.id,
      courseTitle: course.title,
      newsTitle: n.title_ru || '',
      tagMatch: cand.tagMatch,
      sim: cand.sim,
      sharedTagNames: cand.tagMatch ? await sharedTagNames(courseId, newsTags) : [],
    });
  }
  const written = await rankAndStore(items);
  console.log(`[EducationMatch] retroscan course ${courseId}: ${written}/${items.length} suggestion(s)`);
}

/**
 * Публикация курса (ТЗ-101 publish): всегда пересчитываем эмбеддинг (Задача 1)
 * и запускаем ретроскан (Задача 3). Асинхронно — ответ API не ждёт.
 */
export function onCoursePublished(courseId: string): void {
  if (!isEducationMatchEnabled()) return;
  void (async () => {
    try {
      await computeCourseEmbedding(courseId);
    } catch (err: any) {
      console.warn(`[EducationMatch] embedding course ${courseId} failed:`, err?.message);
    }
    try {
      await retroscanCourse(courseId);
    } catch (err: any) {
      console.warn(`[EducationMatch] retroscan course ${courseId} failed:`, err?.message);
    }
  })();
}

// ─── Задача 3 — cron-страховка (вызывается из cron.ts раз в час) ────────────

/**
 * Новости за последние 2 часа без ни одной строки в course_match_suggestions
 * — догоняем мэтчингом (окно закрывает падение хука в newsProcessor).
 */
export async function matchUnprocessedNews(): Promise<number> {
  if (!isEducationMatchEnabled()) return 0;
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const r = await query(
    `SELECT n.id FROM news n
     WHERE n.published_at >= $1
       AND NOT EXISTS (
         SELECT 1 FROM course_match_suggestions cms WHERE cms.news_id = n.id
       )
     ORDER BY n.published_at DESC
     LIMIT 100`,
    [cutoff],
  );
  let matched = 0;
  for (const row of r.rows) {
    try {
      await matchNewsToCourses(row.id);
      matched++;
    } catch (err: any) {
      console.warn(`[EducationMatch] catch-up news ${row.id} failed:`, err?.message);
    }
  }
  if (r.rows.length > 0) {
    console.log(`[EducationMatch] catch-up: scanned ${r.rows.length}, matched ${matched}`);
  }
  return matched;
}
