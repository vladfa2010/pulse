/**
 * =============================================================================
 * PULSE — LMS: материалы к новости — уроки и курсы по смыслу (ТЗ-229, сервис)
 * =============================================================================
 *
 * Движок подбора «у этой новости есть материал в LMS». Хранилища пар НЕТ —
 * вычисление на лету из существующих векторов (news.embedding pgvector,
 * courses.embedding pgvector, lesson_embeddings.vector BYTEA), миграций нет.
 *
 * Выборки — 1:1 из searchCoursesByVector / searchLessonsByVector (news.ts,
 * ТЗ-214/215): те же фильтры видимости (published + public + не удалён —
 * анти-энумерация hidden/draft) и тот же принцип «полный перебор дёшев»
 * (embeddings.md:100-101). Дубль SELECT'ов осознан: поисковый контур не
 * рефакторим (риск 2 ТЗ-229) — при смене фильтров править ОБА места.
 *
 * Косинус — в Node через публичные cosine / bufferToVector (knowledgeGraph.ts).
 * SQLite-режим: news.embedding не существует (PG-only) — обе функции возвращают
 * пустые коллекции, эндпоинты отдают пустой результат, не падают.
 */

import { query } from '../../config/db';
import { bufferToVector, cosine } from './knowledgeGraph';
import {
  NEWS_MATERIALS_LESSON_MIN_SIM,
  NEWS_MATERIALS_COURSE_MIN_SIM,
  NEWS_MATERIALS_LESSON_TOP,
  NEWS_MATERIALS_COURSE_TOP,
} from '../../config/newsMaterials';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const EMBEDDING_DIM = 1024;

/** Урок для блока «Материалы по теме» — поля SearchLesson (ТЗ-215) + флаг превью. */
export interface LessonMaterial {
  lesson_id: string;
  title: string;
  course_slug: string;
  course_title: string;
  duration_min: number | null;
  cover_url: string | null;
  similarity: number;
  /** Умная ссылка (ТЗ-229 Задача 6): true → прямой урок, иначе страница курса. */
  is_free_preview: boolean;
}

/** Курс для блока «Материалы по теме» — поля под CourseCard + similarity. */
export interface CourseMaterial {
  id: string;
  slug: string;
  title: string;
  cover_url: string | null;
  type: string;
  size: string;
  price: number;
  badges: string[];
  category: { id: string; name: string } | null;
  source_title: string | null;
  lessons_count: number;
  total_minutes: number;
  students_count: number;
  similarity: number;
}

// Парсинг pgvector-текста ('[0.1,…]' — JSON-совместим) с валидацией размерности.
// 1:1 jsonToVector из knowledgeGraph.ts (приватен там — не трогаем, риск «Что НЕ
// трогать» ТЗ-229). Экспортирован: роутам нужен для эмбеддинга новости.
export function parseVectorText(value: unknown): number[] | null {
  if (typeof value !== 'string' || !value.startsWith('[')) return null;
  try {
    const v = JSON.parse(value) as number[];
    return v.length === EMBEDDING_DIM && v.every(Number.isFinite) ? v : null;
  } catch {
    return null;
  }
}

interface LessonRow {
  lesson_id: string;
  vector: unknown; // BYTEA float32 ×1024
  lesson_title: string;
  duration_min: number | null;
  course_slug: string;
  course_title: string;
  cover_url: string | null;
  is_free_preview: boolean;
}

interface CourseRow {
  id: string;
  slug: string;
  title: string;
  cover_url: string | null;
  type: string;
  size: string;
  price: number;
  badges: unknown;
  category_id: string | null;
  category_name: string | null;
  source_title: string | null;
  lessons_count: number;
  total_minutes: number;
  students_count: number;
  emb_text: string; // courses.embedding::text
}

// Матрицы грузятся на каждый запрос — как searchLessonsByVector (news.ts):
// кэш матриц сознательно НЕ вводим (риск 3 ТЗ-229); если p95 lookup > 1.5 с —
// следующим ТЗ добавить in-memory кэш с TTL 10 мин.
async function loadLessonsMatrix(): Promise<LessonRow[]> {
  // SELECT 1:1 searchLessonsByVector (news.ts) + cl.is_free_preview (Задача 6 ТЗ-229)
  const res = await query(
    `SELECT le.lesson_id, le.vector, cl.title AS lesson_title, cl.duration_min,
            cl.is_free_preview, c.slug AS course_slug, c.title AS course_title, c.cover_url
     FROM lesson_embeddings le
     JOIN course_lessons cl ON cl.id = le.lesson_id
     JOIN courses c ON c.id = cl.course_id
     WHERE c.status = 'published' AND c.deleted_at IS NULL AND c.visibility = 'public'`,
    [],
  );
  return res.rows as LessonRow[];
}

async function loadCoursesMatrix(): Promise<CourseRow[]> {
  // SELECT — по образцу searchCoursesByVector (news.ts), вектор текстом для
  // Node-косинуса (прецедент-комментарий: полный перебор дёшев, индекс не нужен)
  const res = await query(
    `SELECT c.id, c.slug, c.title, c.cover_url, c.type, c.size, c.price, c.badges,
            cc.id AS category_id, cc.name AS category_name,
            (SELECT title_ru FROM news n WHERE n.id = c.source_news_id) AS source_title,
            (SELECT COUNT(*) FROM course_lessons cl WHERE cl.course_id = c.id)::int AS lessons_count,
            (SELECT COALESCE(SUM(cl2.duration_min), 0) FROM course_lessons cl2 WHERE cl2.course_id = c.id)::int AS total_minutes,
            (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id)::int AS students_count,
            c.embedding::text AS emb_text
     FROM courses c
     LEFT JOIN course_categories cc ON cc.id = c.category_id
     WHERE c.status = 'published' AND c.deleted_at IS NULL
       AND c.visibility = 'public' AND c.embedding IS NOT NULL
     ORDER BY c.created_at DESC`,
    [],
  );
  return res.rows as CourseRow[];
}

// Порядок: фильтр по порогу → сортировка по sim → slice (прецедент news.ts:808-809).
function rankLessons(newsVec: number[], rows: LessonRow[]): LessonMaterial[] {
  return rows
    .map((r) => {
      const v = bufferToVector(r.vector);
      if (!v) return null;
      return {
        lesson_id: r.lesson_id,
        title: r.lesson_title,
        course_slug: r.course_slug,
        course_title: r.course_title,
        duration_min: r.duration_min,
        cover_url: r.cover_url,
        is_free_preview: Boolean(r.is_free_preview),
        similarity: Math.round(cosine(v, newsVec) * 10000) / 10000,
      };
    })
    .filter((r): r is LessonMaterial => r !== null && r.similarity >= NEWS_MATERIALS_LESSON_MIN_SIM)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, NEWS_MATERIALS_LESSON_TOP);
}

function rankCourses(newsVec: number[], rows: CourseRow[]): CourseMaterial[] {
  const ranked: CourseMaterial[] = [];
  for (const r of rows) {
    const v = parseVectorText(r.emb_text);
    if (!v) continue;
    const similarity = Math.round(cosine(v, newsVec) * 10000) / 10000;
    if (similarity < NEWS_MATERIALS_COURSE_MIN_SIM) continue;
    let badges: string[] = [];
    try {
      const parsed = typeof r.badges === 'string' ? JSON.parse(r.badges) : r.badges;
      badges = Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      badges = [];
    }
    ranked.push({
      id: r.id,
      slug: r.slug,
      title: r.title,
      cover_url: r.cover_url,
      type: r.type,
      size: r.size,
      price: Number(r.price),
      badges,
      category: r.category_id ? { id: r.category_id, name: r.category_name || '' } : null,
      source_title: r.source_title,
      lessons_count: Number(r.lessons_count),
      total_minutes: Number(r.total_minutes),
      students_count: Number(r.students_count),
      similarity,
    });
  }
  return ranked
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, NEWS_MATERIALS_COURSE_TOP);
}

/** Топ-N уроков и курсов к одному вектору новости. SQLite → пустые коллекции.
 *  Флаг НЕ проверяем здесь — проба калибровки (Задача 4 ТЗ-229) должна работать
 *  с выключенным флагом; гейт стоит на уровне роутов. */
export async function materialsForVector(newsVec: number[]): Promise<{
  lessons: LessonMaterial[];
  courses: CourseMaterial[];
}> {
  if (USE_SQLITE) return { lessons: [], courses: [] };
  const [lessonRows, courseRows] = await Promise.all([loadLessonsMatrix(), loadCoursesMatrix()]);
  return {
    lessons: rankLessons(newsVec, lessonRows),
    courses: rankCourses(newsVec, courseRows),
  };
}

/** Батч-счётчики для чипов ленты: сколько материалов проходит порог по новости. */
export async function materialsCountsForNews(
  ids: string[],
): Promise<Map<string, { lessons: number; courses: number }>> {
  const empty = new Map<string, { lessons: number; courses: number }>();
  if (USE_SQLITE || ids.length === 0) return empty;

  const res = await query(
    `SELECT id, embedding::text AS emb_text FROM news WHERE id = ANY($1::uuid[]) AND embedding IS NOT NULL`,
    [ids],
  );

  const [lessonRows, courseRows] = await Promise.all([loadLessonsMatrix(), loadCoursesMatrix()]);
  const out = new Map<string, { lessons: number; courses: number }>();
  for (const r of res.rows as any[]) {
    const v = parseVectorText(r.emb_text);
    if (!v) continue;
    const lessons = rankLessons(v, lessonRows).length;
    const courses = rankCourses(v, courseRows).length;
    if (lessons > 0 || courses > 0) out.set(String(r.id), { lessons, courses });
  }
  return out;
}
