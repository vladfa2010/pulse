/**
 * =============================================================================
 * PULSE — LMS «Образование»: граф знаний — ночная джоба пересчёта (ТЗ-107 v3)
 * =============================================================================
 *
 * rebuildKnowledgeGraph():
 *   1. Уроки опубликованных курсов; текст = title + ' ' + plain(text_content),
 *      обрезка до EMBEDDING_MAX_TEXT=1000 (единый проектный формат, без
 *      instruction-префикса — те же тексты, что у news/courses).
 *   2. embedBatch ТОЛЬКО для уроков без записи или со сменившимся text_hash
 *      (экономия TEI, как в бэкфилл-вачдоге cron.ts).
 *   3. Попарный косинус в памяти (500 уроков — 125K пар, секунды).
 *   4. Рёбра: топ-5 cross-course ≥ 0.55 + топ-3 внутрикурсовых ≥ 0.60
 *      (константы — config/knowledgeGraph.ts).
 *   5. course_similarity: sim_embed (косинус courses.embedding) + агрегат
 *      cross-пар уроков; итог = sim_embed при shared_pairs=0, иначе среднее
 *      sim_embed и среднего топ-10 cross-пар. sim < 0.45 не пишем.
 *   6. Атомарная замена снапшота: одна транзакция DELETE+INSERT (PG).
 *      SQLite — последовательные query, осознанное окно (проектный паттерн).
 *
 * Деградации (ТЗ-107 v3 §2): TEI недоступен → ошибка в cron_log, снапшот
 * не трогаем (API продолжает отдавать вчерашний). Джоба упала — то же.
 * Новый/изменённый урок попадёт в граф только со следующего прогона —
 * осознанно, граф не реалтайм-фича.
 *
 * Двойной embedding-клиент НЕ плодим: только существующий embedBatch.
 */

import crypto from 'crypto';
import { query, pool } from '../../config/db';
import { nowSql } from '../../utils/nowSql';
import { embedBatch, EMBEDDING_DIM, EMBEDDING_MAX_TEXT } from '../embeddings';
import {
  KG_LESSON_CROSS_TOP,
  KG_LESSON_CROSS_MIN_SIM,
  KG_LESSON_INTRA_TOP,
  KG_LESSON_INTRA_MIN_SIM,
  KG_COURSE_MIN_SIM,
  KG_COURSE_TOP_PAIRS,
} from '../../config/knowledgeGraph';
import { invalidateEducationCache } from './cache';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const MODEL_TAG = 'qwen3-emb-0.6b-1024';

// ─── Текст урока ────────────────────────────────────────────────────────────

/** HTML → plain: теги, типографика, схлопывание пробелов. Для эмбеддинга. */
export function htmlToPlain(html: string): string {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function lessonText(title: string, textContent: string): string {
  return (title + ' ' + htmlToPlain(textContent)).slice(0, EMBEDDING_MAX_TEXT);
}

// ─── Векторы: сериализация/парсинг (PG BYTEA ↔ SQLite JSON) ─────────────────

/** float32[1024] → Buffer (little-endian), для BYTEA. */
function vectorToBuffer(v: number[]): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf;
}

function bufferToVector(buf: unknown): number[] | null {
  if (buf == null) return null;
  const b: Buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf as any);
  if (b.length !== EMBEDDING_DIM * 4) return null;
  const v = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) v[i] = b.readFloatLE(i * 4);
  return v;
}

function vectorToJson(v: number[]): string {
  return JSON.stringify(v);
}

function jsonToVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== 'string' || !value.startsWith('[')) return null;
  try {
    const v = JSON.parse(value) as number[];
    return v.length === EMBEDDING_DIM && v.every(Number.isFinite) ? v : null;
  } catch {
    return null;
  }
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

// ─── cron_log журнал (та же таблица/стиль, что services/cron.ts) ────────────

async function logStart(taskName: string): Promise<number> {
  const r = await query(
    USE_SQLITE
      ? `INSERT INTO cron_log (task_name, status) VALUES (?, 'running') RETURNING id`
      : `INSERT INTO cron_log (task_name, status) VALUES ($1, 'running') RETURNING id`,
    [taskName],
  );
  return Number(r.rows[0].id);
}

async function logFinish(logId: number, status: 'done' | 'failed', error?: string): Promise<void> {
  await query(
    USE_SQLITE
      ? `UPDATE cron_log SET finished_at = datetime('now'), status = ?, errors = ? WHERE id = ?`
      : `UPDATE cron_log SET finished_at = NOW(), status = $1, errors = $2 WHERE id = $3`,
    [status, error ? error.slice(0, 500) : null, logId],
  );
}

// ─── Основной прогон ────────────────────────────────────────────────────────

export interface KgRunStats {
  lessons: number;
  embedded: number;     // сколько уроков реально отправлено в TEI
  lessonEdges: number;
  courseEdges: number;
  durationMs: number;
}

export async function rebuildKnowledgeGraph(): Promise<KgRunStats> {
  const started = Date.now();
  const logId = await logStart('education-knowledge-graph');
  try {
    const stats = await runBuild();
    await logFinish(logId, 'done');
    console.log(
      `[KG] rebuilt: ${stats.lessons} lessons (${stats.embedded} embedded), ` +
      `${stats.lessonEdges} lesson edges, ${stats.courseEdges} course edges, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    return stats;
  } catch (err: any) {
    await logFinish(logId, 'failed', err?.message || String(err));
    console.error(`[KG] rebuild failed: ${err?.message}`);
    throw err;
  }
}

async function runBuild(): Promise<KgRunStats> {
  const buildStarted = Date.now();
  // 1. Уроки опубликованных курсов
  const lessonsR = await query(
    `SELECT l.id, l.course_id, l.title, l.text_content
       FROM course_lessons l
       JOIN courses c ON c.id = l.course_id
      WHERE c.status = 'published' AND c.deleted_at IS NULL
      ORDER BY l.course_id, l.position`,
    [],
  );
  const lessons = lessonsR.rows.map((l: any) => ({
    id: l.id,
    courseId: l.course_id,
    title: l.title,
    text: lessonText(l.title, l.text_content || ''),
    hash: crypto.createHash('sha256').update(lessonText(l.title, l.text_content || '')).digest('hex'),
  }));

  // 2. Эмбеддинги: только новые/изменившиеся (text_hash)
  const embR = await query(
    `SELECT lesson_id, text_hash, vector FROM lesson_embeddings`,
    [],
  );
  const embByLesson = new Map<string, { hash: string; vector: number[] | null }>();
  for (const row of embR.rows) {
    embByLesson.set(row.lesson_id, {
      hash: row.text_hash,
      vector: USE_SQLITE ? jsonToVector(row.vector) : bufferToVector(row.vector),
    });
  }

  const vectors = new Map<string, number[]>();
  const toEmbed: { id: string; text: string; hash: string }[] = [];
  for (const l of lessons) {
    const existing = embByLesson.get(l.id);
    if (existing && existing.hash === l.hash && existing.vector) {
      vectors.set(l.id, existing.vector);
    } else {
      toEmbed.push({ id: l.id, text: l.text, hash: l.hash });
    }
  }
  // Уроки, исчезнувшие из published-курсов, из lesson_embeddings не удаляем —
  // ON DELETE CASCADE сделает это при удалении урока; в выборке графа они
  // просто не участвуют.

  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i += 32) {
    const chunk = toEmbed.slice(i, i + 32);
    // TEI недоступен → throw выше, снапшот не тронут (деградация ТЗ-107 §2)
    const batch = await embedBatch(chunk.map(c => c.text));
    embedded += chunk.length;
    const now = nowSql();
    for (let j = 0; j < chunk.length; j++) {
      vectors.set(chunk[j].id, batch[j]);
      if (USE_SQLITE) {
        await query(
          `INSERT INTO lesson_embeddings (lesson_id, model, vector, text_hash, computed_at)
           VALUES (?1, ?2, ?3, ?4, ${now})
           ON CONFLICT(lesson_id) DO UPDATE SET model=?2, vector=?3, text_hash=?4, computed_at=${now}`,
          [chunk[j].id, MODEL_TAG, vectorToJson(batch[j]), chunk[j].hash],
        );
      } else {
        await query(
          `INSERT INTO lesson_embeddings (lesson_id, model, vector, text_hash, computed_at)
           VALUES ($1, $2, $3, $4, ${now})
           ON CONFLICT (lesson_id) DO UPDATE SET model=$2, vector=$3, text_hash=$4, computed_at=${now}`,
          [chunk[j].id, MODEL_TAG, vectorToBuffer(batch[j]), chunk[j].hash],
        );
      }
    }
  }

  // 3-4. Попарный косинус + отбор рёбер
  const withVectors = lessons.filter(l => vectors.has(l.id));
  const courseOf = new Map(withVectors.map(l => [l.id, l.courseId]));
  // Для каждого урока держим две топ-кучи (cross/intra)
  const crossHeap = new Map<string, { id: string; sim: number }[]>();
  const intraHeap = new Map<string, { id: string; sim: number }[]>();
  const addTo = (heap: Map<string, { id: string; sim: number }[]>, id: string, cand: { id: string; sim: number }, limit: number) => {
    const arr = heap.get(id) || [];
    arr.push(cand);
    arr.sort((x, y) => y.sim - x.sim);
    if (arr.length > limit) arr.length = limit;
    heap.set(id, arr);
  };

  const n = withVectors.length;
  for (let i = 0; i < n; i++) {
    const vi = vectors.get(withVectors[i].id)!;
    for (let j = i + 1; j < n; j++) {
      const sim = cosine(vi, vectors.get(withVectors[j].id)!);
      const a = withVectors[i];
      const b = withVectors[j];
      if (a.courseId !== b.courseId) {
        if (sim >= KG_LESSON_CROSS_MIN_SIM) {
          addTo(crossHeap, a.id, { id: b.id, sim }, KG_LESSON_CROSS_TOP);
          addTo(crossHeap, b.id, { id: a.id, sim }, KG_LESSON_CROSS_TOP);
        }
      } else if (sim >= KG_LESSON_INTRA_MIN_SIM) {
        addTo(intraHeap, a.id, { id: b.id, sim }, KG_LESSON_INTRA_TOP);
        addTo(intraHeap, b.id, { id: a.id, sim }, KG_LESSON_INTRA_TOP);
      }
    }
  }

  // Собираем уникальный набор рёбер
  const lessonEdges = new Map<string, { a: string; b: string; sim: number; cross: boolean }>();
  const take = (heap: Map<string, { id: string; sim: number }[]>, cross: boolean) => {
    for (const [id, cands] of heap) {
      for (const c of cands) {
        const a = id < c.id ? id : c.id;
        const b = id < c.id ? c.id : id;
        lessonEdges.set(`${a}|${b}`, { a, b, sim: c.sim, cross });
      }
    }
  };
  take(crossHeap, true);
  take(intraHeap, false);

  // Cross-пары по курсам — для course_similarity
  const crossPairsByCourse = new Map<string, { other: string; sim: number }[]>();
  for (const e of lessonEdges.values()) {
    if (!e.cross) continue;
    const ca = courseOf.get(e.a)!;
    const cb = courseOf.get(e.b)!;
    const arr = crossPairsByCourse.get(ca) || [];
    arr.push({ other: cb, sim: e.sim });
    crossPairsByCourse.set(ca, arr);
    const arr2 = crossPairsByCourse.get(cb) || [];
    arr2.push({ other: ca, sim: e.sim });
    crossPairsByCourse.set(cb, arr2);
  }

  // 5. course_similarity: sim_embed + агрегат cross-пар
  const coursesR = await query(
    `SELECT id, embedding FROM courses WHERE status = 'published' AND deleted_at IS NULL`,
    [],
  );
  const courseVector = new Map<string, number[]>();
  for (const c of coursesR.rows) {
    const v = USE_SQLITE ? jsonToVector(c.embedding) : parsePgVector(c.embedding);
    if (v) courseVector.set(c.id, v);
  }
  const courseIds = [...courseVector.keys()];
  const courseEdges = new Map<string, { a: string; b: string; sim: number; simEmbed: number | null; shared: number }>();
  for (let i = 0; i < courseIds.length; i++) {
    for (let j = i + 1; j < courseIds.length; j++) {
      const simEmbed = cosine(courseVector.get(courseIds[i])!, courseVector.get(courseIds[j])!);
      const pairs = (crossPairsByCourse.get(courseIds[i]) || [])
        .filter(p => p.other === courseIds[j])
        .map(p => p.sim)
        .sort((x, y) => y - x);
      const shared = pairs.length;
      let sim: number;
      if (shared === 0) {
        sim = simEmbed;
      } else {
        const topPairs = pairs.slice(0, KG_COURSE_TOP_PAIRS);
        const meanPairs = topPairs.reduce((s, v) => s + v, 0) / topPairs.length;
        sim = (simEmbed + meanPairs) / 2;
      }
      if (sim < KG_COURSE_MIN_SIM) continue;
      const a = courseIds[i] < courseIds[j] ? courseIds[i] : courseIds[j];
      const b = courseIds[i] < courseIds[j] ? courseIds[j] : courseIds[i];
      courseEdges.set(`${a}|${b}`, { a, b, sim, simEmbed, shared });
    }
  }

  // 6. Атомарная замена снапшота
  const now = nowSql();
  if (USE_SQLITE) {
    // Последовательные query — осознанное окно, как принято в SQLite-режиме
    await query(`DELETE FROM lesson_similarity`, []);
    await query(`DELETE FROM course_similarity`, []);
    for (const e of lessonEdges.values()) {
      await query(
        `INSERT INTO lesson_similarity (lesson_a, lesson_b, sim, cross_course, computed_at)
         VALUES (?1, ?2, ?3, ?4, ${now})`,
        [e.a, e.b, e.sim, e.cross ? 1 : 0],
      );
    }
    for (const e of courseEdges.values()) {
      await query(
        `INSERT INTO course_similarity (course_a, course_b, sim, sim_embed, shared_pairs, computed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ${now})`,
        [e.a, e.b, e.sim, e.simEmbed, e.shared],
      );
    }
  } else if (pool) {
    // Транзакция — ОДНО соединение (pool.query даёт разное на каждый вызов,
    // см. шапку config/db.ts; паттерн withCalendarTransaction)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM lesson_similarity`);
      await client.query(`DELETE FROM course_similarity`);
      for (const e of lessonEdges.values()) {
        await client.query(
          `INSERT INTO lesson_similarity (lesson_a, lesson_b, sim, cross_course, computed_at)
           VALUES ($1, $2, $3, $4, ${now})`,
          [e.a, e.b, e.sim, e.cross],
        );
      }
      for (const e of courseEdges.values()) {
        await client.query(
          `INSERT INTO course_similarity (course_a, course_b, sim, sim_embed, shared_pairs, computed_at)
           VALUES ($1, $2, $3, $4, $5, ${now})`,
          [e.a, e.b, e.sim, e.simEmbed, e.shared],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  // 7. Инвалидация кэшей
  invalidateEducationCache();
  invalidateGraphCache();

  return {
    lessons: withVectors.length,
    embedded,
    lessonEdges: lessonEdges.size,
    courseEdges: courseEdges.size,
    durationMs: Date.now() - buildStarted,
  };
}

/** PG возвращает vector как '[0.1,...]' — парсим обратно (паттерн match.ts). */
function parsePgVector(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== 'string' || !value.startsWith('[')) return null;
  const v = value.slice(1, -1).split(',').map(Number);
  return v.length === EMBEDDING_DIM && v.every(Number.isFinite) ? v : null;
}

// ─── Кэш API графа (in-memory, паттерн education/cache.ts) ─────────────────

const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000;
const graphCache = new Map<string, { value: any; expiresAt: number }>();

export function getGraphCached<T>(key: string, producer: () => Promise<T>): Promise<T> {
  const fullKey = `education:kg:${key}`;
  const hit = graphCache.get(fullKey);
  if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value as T);
  graphCache.delete(fullKey);
  return producer().then(value => {
    graphCache.set(fullKey, { value, expiresAt: Date.now() + GRAPH_CACHE_TTL_MS });
    return value;
  });
}

export function invalidateGraphCache(): void {
  graphCache.clear();
}
