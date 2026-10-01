/**
 * =============================================================================
 * PULSE — LMS «Образование»: Admin API (ТЗ-101 v17, критерии 1-9, 13-14, 16-22, 25-26)
 * =============================================================================
 *
 * Все роуты за adminMiddleware (импорт из middleware/admin — ТЗ-66-lite).
 * Паттерн — routes/admin.ts: ошибки {error: string}, nowSql() для timestamp.
 *
 * Общие правила ТЗ-101:
 *   - Любая мутация → invalidateEducationCache() (кэш витрины TTL 5 мин).
 *   - События в activity log от userId АДМИНА: education.course_*,
 *     education.enroll_admin / education.unenroll_admin.
 *   - SQL только параметризованный через query(); id — crypto.randomUUID()
 *     (gen_random_uuid() не использовать — несовместимо с SQLite).
 *   - JSONB-колонки (badges, questions): JSON.stringify при записи,
 *     JSON.parse при чтении (SQLite хранит TEXT).
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import sanitizeHtml from 'sanitize-html';
import sharp from 'sharp';
import fileType from 'file-type';

import { query, pool } from '../config/db';
import { nowSql } from '../utils/nowSql';
import { slugify } from '../utils/slugify';
import { AuthRequest } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { checkRateLimit, lmsUploadLimiter } from '../middleware/rateLimit';
import { logUserEvent } from '../services/activityLog';
import { getActivePlans } from '../services/subscription';
import { invalidateEducationCache } from '../services/education/cache';
import { resolveSourceUrl, ResolveSourceError } from '../services/education/resolveSource';
import { enqueueScan } from '../services/education/virusScan'; // ТЗ-102: retry-скан pending_scan при заходе в очередь
import { isEducationMatchEnabled, onCoursePublished, scheduleCourseReembedding } from '../services/education/match'; // ТЗ-103 Задачи 1,3: эмбеддинги + ретроскан
import { courseTagIds, matchEventsToCourse } from '../services/education/calendarMatch'; // ТЗ-103 Задача 7: events-preview
import { putBuffer, removeFile, StorageError } from '../services/storage/driver';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const router = Router();

router.use(adminMiddleware);

// ─── Хелперы ────────────────────────────────────────────────────────────────

type AsyncHandler = (req: AuthRequest, res: Response) => Promise<any>;

/** Обёртка async-обработчика: единый catch → 500 {error} (паттерн проекта). */
function h(fn: AsyncHandler) {
  return (req: Request, res: Response) => {
    fn(req as AuthRequest, res).catch((err: any) => {
      console.error('[AdminEducation] handler error:', err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  };
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

/** Экранирование wildcard-символов LIKE (паттерн escapeLikePattern в news.ts). */
function escapeLike(q: string): string {
  return q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * SQLite (sql.js собран без ICU): LOWER()/UPPER() кириллицу не трогают, а
 * варианты регистра не покрывают смешанный («Облигации»). Поиск — пост-
 * фильтрация в JS по ограниченному скану (таблицы справочные; PG — ILIKE).
 */
function matchesQuery(haystack: string, needle: string): boolean {
  return String(haystack || '').toLowerCase().includes(needle.toLowerCase());
}

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

/** Проверка существования тегов в единой базе user_defined_tags. */
async function validateTagIds(tagIds: unknown): Promise<string[] | string> {
  if (!Array.isArray(tagIds)) return 'tag_ids должен быть массивом';
  const ids = tagIds.map((t) => String(t));
  if (new Set(ids).size !== ids.length) return 'дубли тегов в tag_ids';
  if (ids.length === 0) return [];
  if (ids.length === 0) return [];
  if (USE_SQLITE) {
    // SQLite: ANY($1) недоступен — параметризованный IN (запрещён SQL-инъекциям)
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const r = await query(
      `SELECT tag_id FROM user_defined_tags WHERE tag_id IN (${placeholders})`,
      ids,
    );
    const existing = new Set(r.rows.map((row: any) => row.tag_id));
    const missing = ids.filter((id) => !existing.has(id));
    if (missing.length > 0) return `несуществующие теги: ${missing.join(', ')}`;
    return ids;
  }
  const found = await query(
    `SELECT tag_id FROM user_defined_tags WHERE tag_id = ANY($1)`,
    [ids],
  );
  const existing = new Set(found.rows.map((row: any) => row.tag_id));
  const missing = ids.filter((id) => !existing.has(id));
  if (missing.length > 0) return `несуществующие теги: ${missing.join(', ')}`;
  return ids;
}

/** Уникальный slug курса: транслит(title) + '-' + uuid8; коллизии → -2, -3. */
async function generateCourseSlug(title: string): Promise<string> {
  const base = slugify(title, crypto.randomUUID());
  let slug = base;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await query(`SELECT 1 FROM courses WHERE slug = $1`, [slug]);
    if (r.rows.length === 0) return slug;
    slug = `${base}-${n++}`;
  }
}

// ─── Санитизация контента урока (ТЗ-101 v12, S1; критерий 23) ───────────────

/**
 * Whitelist: p/h1-h4/списки/strong/em/a/img/code/pre/blockquote/table;
 * a[href] — только https://, img[src] — только '/media/' (наш storage);
 * SVG/script/on*-атрибуты/style отсекаются sanitize-html по умолчанию.
 * Санитизируем на ЗАПИСИ — публичный API отдаёт готовый безопасный HTML.
 */
export function sanitizeLessonHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em',
      'a', 'img', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'br',
    ],
    allowedAttributes: { a: ['href'], img: ['src'] },
    transformTags: {
      a: (tagName, attribs): { tagName: string; attribs: Record<string, string> } => {
        const href = attribs.href || '';
        // Только https: http и прочие схемы (javascript:) вырезаются целиком.
        if (!/^https:\/\//i.test(href)) return { tagName: 'a', attribs: {} };
        return { tagName: 'a', attribs: { href } };
      },
      img: (tagName, attribs): { tagName: string; attribs: Record<string, string> } => {
        const src = attribs.src || '';
        if (!src.startsWith('/media/')) return { tagName: 'img', attribs: {} };
        return { tagName: 'img', attribs: { src } };
      },
    },
  });
}

// ─── Валидация embed-URL (белый список доменов, критерий 5) ─────────────────

const EMBED_DOMAINS = [
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'vkvideo.ru',
  'player.vimeo.com',
];

/** Проверить embed-URL по белому списку (host === domain || *.domain). */
export function isAllowedEmbedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return EMBED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/** Валидация и нормализация полей урока (POST и PUT, критерий 26). */
interface LessonPayload {
  title?: string;
  kind?: string;
  text_content?: string | null;
  video_embed_url?: string | null;
  video_source?: string | null;
  duration_min?: number | null;
  is_free_preview?: boolean;
  unlock_after_days?: number;
}

function validateLessonPayload(body: any): LessonPayload | { error: string } {
  const out: LessonPayload = {};
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title || title.length > 255) return { error: 'title — непустая строка до 255 символов' };
    out.title = title;
  }
  if (body.kind !== undefined) {
    const kind = String(body.kind);
    if (!['text', 'video', 'video_text'].includes(kind)) {
      return { error: "kind — только 'text' | 'video' | 'video_text'" };
    }
    out.kind = kind;
  }
  if (body.text_content !== undefined) {
    const raw = body.text_content === null ? '' : String(body.text_content);
    out.text_content = sanitizeLessonHtml(raw);
  }
  if (body.video_embed_url !== undefined) {
    const embed = body.video_embed_url === null ? '' : String(body.video_embed_url).trim();
    if (embed) {
      if (!isAllowedEmbedUrl(embed)) {
        return { error: 'video_embed_url — домен вне белого списка (youtube, vkvideo, vimeo) или не https' };
      }
      out.video_embed_url = embed;
      out.video_source = 'external_embed';
    } else {
      out.video_embed_url = null;
      out.video_source = null;
    }
  }
  if (body.duration_min !== undefined) {
    if (body.duration_min === null) {
      out.duration_min = null;
    } else {
      const d = Number(body.duration_min);
      if (!Number.isInteger(d) || d < 0) return { error: 'duration_min — целое число ≥ 0' };
      out.duration_min = d;
    }
  }
  if (body.is_free_preview !== undefined) {
    out.is_free_preview = !!body.is_free_preview;
  }
  if (body.unlock_after_days !== undefined) {
    const d = Number(body.unlock_after_days);
    if (!Number.isInteger(d) || d < 0) {
      return { error: 'unlock_after_days — целое число ≥ 0' };
    }
    out.unlock_after_days = d;
  }
  return out;
}

// ─── Проверка типа загруженного файла по magic bytes (ТЗ-101 v12, S2) ───────

const COVER_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Whitelist материалов: pdf, office, изображения, zip, txt/md/csv. */
async function detectMaterialExt(buf: Buffer, originalName: string): Promise<string | null> {
  const ft = await fileType.fromBuffer(buf);
  if (ft) {
    const { ext, mime } = ft;
    if (ext === 'pdf') return 'pdf';
    if (mime.startsWith('image/')) return ext;
    if (['zip'].includes(ext)) return 'zip';
    // Office (OOXML + старый OLE-формат)
    if (/^(doc|docx|xls|xlsx|ppt|pptx)$/.test(ext)) return ext;
    if (mime.includes('msword') || mime.includes('officedocument') ||
        mime.includes('ms-excel') || mime.includes('ms-powerpoint') ||
        mime.includes('vnd.ms-')) return ext;
    return null;
  }
  // file-type не определил — допускаем plain-text форматы по расширению
  // с проверкой, что содержимое похоже на текст (нет NUL-байтов, валидный UTF-8).
  const ext = (originalName.split('.').pop() || '').toLowerCase();
  if (!['txt', 'md', 'csv'].includes(ext)) return null;
  const head = buf.subarray(0, Math.min(buf.length, 8192));
  if (head.includes(0)) return null;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head);
  } catch {
    return null;
  }
  return ext;
}

// ─── Multer (memoryStorage, обработка ошибок → 413) ─────────────────────────

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // ТЗ-101: лимит обложки 5 МБ (413)
});

const materialUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // ТЗ-100 критерий 18(1): >20 МБ → 413
});

/** Обёртка multer: ошибки лимита размера → 413, прочие → 400. */
function uploadMw(mw: ReturnType<typeof multer>, field: string) {
  return (req: Request, res: Response, next: () => void) => {
    mw.single(field)(req, res, (err: any) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return fail(res, 413, 'Файл слишком большой');
        }
        return fail(res, 400, 'Ошибка загрузки файла');
      }
      next();
    });
  };
}

// ─── Резолв источника курса (ТЗ-101 v13/v15) ────────────────────────────────

interface SourceResolution {
  source_type: string | null;
  source_news_id: string | null;
}

/**
 * Резолв source-полей из тела запроса (source_url | source_type + source_id).
 * Бросает ResolveSourceError (400/409) — вызывающий код мапит на ответ.
 */
async function resolveCourseSource(body: any): Promise<SourceResolution | null> {
  // 1) Ссылка целиком: сервер резолвит через resolveSourceUrl (единая точка).
  if (typeof body.source_url === 'string' && body.source_url.trim()) {
    const resolved = await resolveSourceUrl(body.source_url.trim());
    if (resolved.source_type !== 'news') {
      // resolveSourceUrl отдаёт 409 для не-news до сюда, но страхуемся
      throw new ResolveSourceError(400, 'тип источника пока не поддержан backend');
    }
    return { source_type: 'news', source_news_id: resolved.id };
  }
  // 2) Явная пара source_type + source_id.
  if (body.source_type !== undefined && body.source_type !== null) {
    const sourceType = String(body.source_type);
    if (!['news', 'cascade', 'storyline', 'topic'].includes(sourceType)) {
      throw new ResolveSourceError(400, 'неизвестный source_type');
    }
    if (sourceType !== 'news') {
      // Контракт заложен (ТЗ-100 v12), сущности появятся отдельными миграциями.
      throw new ResolveSourceError(400, 'тип источника пока не поддержан backend');
    }
    const sourceId = body.source_id !== undefined ? String(body.source_id) : '';
    if (!sourceId) {
      throw new ResolveSourceError(400, 'укажите новость-источник');
    }
    const news = await query(`SELECT id FROM news WHERE id = $1`, [sourceId]);
    if (news.rows.length === 0) {
      throw new ResolveSourceError(400, 'укажите новость-источник (новость не найдена)');
    }
    return { source_type: 'news', source_news_id: sourceId };
  }
  return null; // источник не передан — решает вызывающий код по контексту
}


// ═══════════════════════════════════════════════════════════════════════════
// GET /tags?q= — единая база тегов для тег-пикера (ТЗ-101 v3/v14, критерий 21)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/tags', h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  // ILIKE — только PG; SQLite: регистр-варианты (sql.js без ICU, см. хелпер выше)
  const rows = USE_SQLITE
    ? await query(
        `SELECT tag_id, tag_name, tag_type FROM user_defined_tags ORDER BY tag_name`, [],
      )
    : await query(
        `SELECT tag_id, tag_name, tag_type FROM user_defined_tags
         WHERE ($1 = '' OR tag_id ILIKE $2 OR tag_name ILIKE $2)
         ORDER BY tag_name LIMIT 8`,
        [q, `%${escapeLike(q)}%`],
      );
  const list = USE_SQLITE
    ? rows.rows
        .filter((t: any) => !q || matchesQuery(t.tag_id, q) || matchesQuery(t.tag_name, q))
        .slice(0, 8)
    : rows.rows;
  res.json(list.map((r: any) => ({ tag_id: r.tag_id, tag_name: r.tag_name, tag_type: r.tag_type })));
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /plans — активные тарифы для чекбоксов редактора (ТЗ-101 v6, критерий 17)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/plans', h(async (_req, res) => {
  const plans = await getActivePlans();
  res.json(plans.map((p: any) => ({
    id: p.id, name: p.name, price: p.price, plan_level: p.plan_level,
  })));
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /news-search?q= — поиск новости для привязки (ТЗ-101 v15; ≥2 символа)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/news-search', h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return fail(res, 400, 'Минимум 2 символа для поиска');
  const rows = USE_SQLITE
    ? await query(
        `SELECT id, slug, title_ru, published_at FROM news ORDER BY published_at DESC LIMIT 500`, [],
      )
    : await query(
        `SELECT id, slug, title_ru, published_at FROM news
         WHERE title_ru ILIKE $1
         ORDER BY published_at DESC LIMIT 10`,
        [`%${escapeLike(q)}%`],
      );
  const list = USE_SQLITE
    ? rows.rows.filter((n: any) => matchesQuery(n.title_ru, q)).slice(0, 10)
    : rows.rows;
  res.json(list.map((r: any) => ({
    id: r.id, slug: r.slug, title_ru: r.title_ru, published_at: r.published_at,
  })));
}));

// ═══════════════════════════════════════════════════════════════════════════
// POST /resolve-source — резолв URL → источник (ТЗ-101 v15, критерий 25)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/resolve-source', h(async (req, res) => {
  try {
    const resolved = await resolveSourceUrl(req.body?.url);
    res.json(resolved);
  } catch (err: any) {
    if (err instanceof ResolveSourceError) {
      return fail(res, err.status, err.message);
    }
    throw err;
  }
}));

// ═══════════════════════════════════════════════════════════════════════════
// Категории (ТЗ-101 v9, критерий 20)
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORY_ID_RE = /^[a-z0-9-]{2,50}$/;

async function categoryCoursesCount(categoryId: string): Promise<number> {
  // Админский счётчик: ВСЕ живые курсы (любой статус/visibility)
  const r = await query(
    `SELECT COUNT(*) AS cnt FROM courses WHERE category_id = $1 AND deleted_at IS NULL`,
    [categoryId],
  );
  return Number(r.rows[0]?.cnt || 0);
}

router.get('/categories', h(async (_req, res) => {
  const rows = await query(
    `SELECT id, name, description, position FROM course_categories ORDER BY position ASC`,
    [],
  );
  const out = [];
  for (const row of rows.rows) {
    out.push({
      id: row.id,
      name: row.name,
      description: row.description,
      position: row.position,
      courses_count: await categoryCoursesCount(row.id),
    });
  }
  res.json(out);
}));

router.post('/categories', h(async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  if (!CATEGORY_ID_RE.test(id)) {
    return fail(res, 400, "id категории — формат ^[a-z0-9-]{2,50}$");
  }
  if (!name) return fail(res, 400, 'Укажите название категории');
  const dup = await query(`SELECT 1 FROM course_categories WHERE id = $1`, [id]);
  if (dup.rows.length > 0) return fail(res, 409, 'Категория с таким id уже существует');
  const maxPos = await query(
    `SELECT COALESCE(MAX(position), 0) AS mp FROM course_categories`, [],
  );
  await query(
    `INSERT INTO course_categories (id, name, description, position) VALUES ($1, $2, $3, $4)`,
    [id, name, description, Number(maxPos.rows[0].mp) + 1],
  );
  invalidateEducationCache();
  res.status(201).json({ id, name, description, position: Number(maxPos.rows[0].mp) + 1, courses_count: 0 });
}));

router.put('/categories/:id', h(async (req, res) => {
  const { id } = req.params;
  const exists = await query(`SELECT 1 FROM course_categories WHERE id = $1`, [id]);
  if (exists.rows.length === 0) return fail(res, 404, 'Категория не найдена');
  if (req.body?.id !== undefined && String(req.body.id) !== id) {
    // id — FK у курсов; «переименование ключа» = создать новую и перевести курсы
    return fail(res, 400, 'Смена id категории запрещена (id является ключом у курсов)');
  }
  const name = req.body?.name !== undefined ? String(req.body.name).trim() : null;
  const description = req.body?.description !== undefined ? String(req.body.description).trim() : null;
  if (name !== null && !name) return fail(res, 400, 'Название не может быть пустым');
  await query(
    `UPDATE course_categories SET
       name = COALESCE($2, name),
       description = COALESCE($3, description)
     WHERE id = $1`,
    [id, name, description],
  );
  invalidateEducationCache();
  const row = await query(`SELECT * FROM course_categories WHERE id = $1`, [id]);
  res.json({
    ...row.rows[0],
    courses_count: await categoryCoursesCount(id),
  });
}));

router.post('/categories/reorder', h(async (req, res) => {
  const ids: unknown = req.body?.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return fail(res, 400, 'ids — непустой массив (полный новый порядок)');
  }
  const strIds = ids.map((x) => String(x));
  if (new Set(strIds).size !== strIds.length) return fail(res, 400, 'Дубли в ids');
  const all = await query(`SELECT id FROM course_categories`, []);
  const existing = new Set(all.rows.map((r: any) => r.id));
  if (!strIds.every((x) => existing.has(x))) {
    return fail(res, 400, 'ids должен содержать все категории без лишних');
  }
  // Полный порядок: position = i+1 (SQLite: последовательные UPDATE, риск гонки
  // при двух редакторах принят — ТЗ-101 риски; редактор один)
  for (let i = 0; i < strIds.length; i++) {
    await query(`UPDATE course_categories SET position = $1 WHERE id = $2`, [i + 1, strIds[i]]);
  }
  invalidateEducationCache();
  res.json({ ok: true });
}));

router.delete('/categories/:id', h(async (req, res) => {
  const { id } = req.params;
  const exists = await query(`SELECT 1 FROM course_categories WHERE id = $1`, [id]);
  if (exists.rows.length === 0) return fail(res, 404, 'Категория не найдена');
  const count = await categoryCoursesCount(id);
  if (count > 0) {
    return fail(res, 409, `в категории ${count} курса(ов) — сначала переведите их`);
  }
  await query(`DELETE FROM course_categories WHERE id = $1`, [id]);
  invalidateEducationCache();
  res.json({ ok: true });
}));


// ═══════════════════════════════════════════════════════════════════════════
// Курсы (ТЗ-101 Задача 1)
// ═══════════════════════════════════════════════════════════════════════════

function boolDb(v: any): boolean {
  // SQLite возвращает 1/0, PG — true/false
  return v === true || v === 1;
}

/** Полная карточка курса для редактора (GET /courses/:id и ответ PUT). */
async function fetchCourseCard(courseId: string): Promise<any | null> {
  const courseR = await query(
    `SELECT c.*, cc.name AS category_name
     FROM courses c
     LEFT JOIN course_categories cc ON cc.id = c.category_id
     WHERE c.id = $1`,
    [courseId],
  );
  if (courseR.rows.length === 0) return null;
  const c = courseR.rows[0];

  const [lessonsR, tariffsR, subEnrollR, materialsR, linksR, tagsR] = await Promise.all([
    query(`SELECT * FROM course_lessons WHERE course_id = $1 ORDER BY position ASC`, [courseId]),
    query(`SELECT plan_id FROM course_tariffs WHERE course_id = $1`, [courseId]),
    query(
      `SELECT COUNT(*) AS cnt FROM course_enrollments WHERE course_id = $1 AND source = 'subscription'`,
      [courseId],
    ),
    query(
      `SELECT * FROM course_materials WHERE course_id = $1 ORDER BY position ASC`,
      [courseId],
    ),
    query(
      `SELECT n.id, n.slug, n.title_ru, n.published_at
       FROM news_course_links l JOIN news n ON n.id = l.news_id
       WHERE l.course_id = $1 ORDER BY l.position ASC`,
      [courseId],
    ),
    query(
      `SELECT ct.tag_id, udt.tag_name
       FROM course_tags ct
       LEFT JOIN user_defined_tags udt ON udt.tag_id = ct.tag_id
       WHERE ct.course_id = $1`,
      [courseId],
    ),
  ]);

  // Тесты уроков (lesson_tests UNIQUE(lesson_id))
  const lessons = [];
  for (const l of lessonsR.rows) {
    const testR = await query(
      `SELECT * FROM lesson_tests WHERE lesson_id = $1`,
      [l.id],
    );
    lessons.push({
      id: l.id,
      position: l.position,
      title: l.title,
      kind: l.kind,
      text_content: l.text_content,
      video_source: l.video_source,
      video_embed_url: l.video_embed_url,
      video_file_url: l.video_file_url,
      duration_min: l.duration_min,
      is_free_preview: boolDb(l.is_free_preview),
      unlock_after_days: l.unlock_after_days,
      test: testR.rows.length > 0
        ? {
            id: testR.rows[0].id,
            pass_score: testR.rows[0].pass_score,
            is_blocking: boolDb(testR.rows[0].is_blocking),
            questions: parseJsonField<any[]>(testR.rows[0].questions, []),
          }
        : null,
    });
  }

  // Источник situational: живой FK → {type, id, title}
  let source: { type: string; id: string; title: string | null } | null = null;
  if (c.source_type === 'news' && c.source_news_id) {
    const newsR = await query(`SELECT id, title_ru FROM news WHERE id = $1`, [c.source_news_id]);
    source = newsR.rows.length > 0
      ? { type: 'news', id: newsR.rows[0].id, title: newsR.rows[0].title_ru }
      : null;
  }

  return {
    id: c.id,
    slug: c.slug,
    title: c.title,
    description: c.description,
    cover_url: c.cover_url,
    type: c.type,
    size: c.size,
    price: Number(c.price),
    badges: parseJsonField<string[]>(c.badges, []),
    status: c.status,
    visibility: c.visibility,
    subscription_unlock_mode: c.subscription_unlock_mode,
    category_id: c.category_id,
    category_name: c.category_name || null,
    author: c.author,
    relevant_until: c.relevant_until,
    source_type: c.source_type,
    source_news_id: c.source_news_id,
    source,
    is_orphan: c.type === 'situational' && c.source_type !== null && c.source_news_id === null,
    deleted_at: c.deleted_at,
    created_by: c.created_by,
    created_at: c.created_at,
    updated_at: c.updated_at,
    tariff_ids: tariffsR.rows.map((r: any) => r.plan_id),
    subscription_enrollments_count: Number(subEnrollR.rows[0]?.cnt || 0),
    lessons,
    materials: materialsR.rows.map((m: any) => ({
      id: m.id,
      kind: m.kind,
      title: m.title,
      url: m.url,
      news_id: m.news_id,
      is_free: boolDb(m.is_free),
      position: m.position,
    })),
    linked_news: linksR.rows.map((n: any) => ({
      id: n.id, slug: n.slug, title_ru: n.title_ru, published_at: n.published_at,
    })),
    tags: tagsR.rows.map((t: any) => ({ id: t.tag_id, label: t.tag_name || t.tag_id })),
  };
}

// GET /courses — таблица: любой статус, deleted_at IS NULL (критерии 1, 13/24)
router.get('/courses', h(async (req, res) => {
  const includeDeleted = req.query.include_deleted === '1';
  const orphansOnly = req.query.orphans === '1';
  const rows = await query(
    `SELECT c.*, cc.name AS category_name,
       (SELECT COUNT(*) FROM course_lessons cl WHERE cl.course_id = c.id) AS lessons_count,
       (SELECT COUNT(*) FROM course_enrollments ce WHERE ce.course_id = c.id) AS enrollments_count
     FROM courses c
     LEFT JOIN course_categories cc ON cc.id = c.category_id
     WHERE ($1 OR c.deleted_at IS NULL)
       AND ($2 OR NOT (c.type = 'situational' AND c.source_type IS NOT NULL AND c.source_news_id IS NULL))
     ORDER BY c.created_at DESC`,
    [includeDeleted, orphansOnly],
  );
  res.json(rows.rows.map((c: any) => ({
    id: c.id,
    slug: c.slug,
    title: c.title,
    type: c.type,
    size: c.size,
    status: c.status,
    visibility: c.visibility,
    price: Number(c.price),
    badges: parseJsonField<string[]>(c.badges, []),
    cover_url: c.cover_url,
    category_id: c.category_id,
    category_name: c.category_name || null,
    source_type: c.source_type,
    source_news_id: c.source_news_id,
    is_orphan: c.type === 'situational' && c.source_type !== null && c.source_news_id === null,
    deleted_at: c.deleted_at,
    lessons_count: Number(c.lessons_count),
    enrollments_count: Number(c.enrollments_count),
    created_at: c.created_at,
    updated_at: c.updated_at,
  })));
}));

// POST /courses — создание черновика (критерий 2)
router.post('/courses', h(async (req, res) => {
  const adminId = req.user!.userId;
  const body = req.body || {};

  const title = String(body.title || '').trim();
  if (!title) return fail(res, 400, 'Укажите название курса');

  const type = body.type !== undefined ? String(body.type) : 'course';
  if (!['course', 'situational'].includes(type)) {
    return fail(res, 400, "type — только 'course' | 'situational'");
  }

  const description = String(body.description || '');
  const price = body.price !== undefined ? Number(body.price) : 0;
  if (!Number.isInteger(price) || price < 0) return fail(res, 400, 'price — целое число ≥ 0');

  const size = body.size !== undefined ? String(body.size) : 'standard';
  if (!['micro', 'standard', 'full'].includes(size)) {
    return fail(res, 400, "size — только 'micro' | 'standard' | 'full'");
  }

  const author = body.author !== undefined && String(body.author).trim()
    ? String(body.author).trim().substring(0, 100)
    : 'Редакция PULSE';

  let categoryId: string | null = null;
  if (body.category_id !== undefined && body.category_id !== null) {
    const cat = await query(`SELECT 1 FROM course_categories WHERE id = $1`, [String(body.category_id)]);
    if (cat.rows.length === 0) return fail(res, 400, 'несуществующая категория');
    categoryId = String(body.category_id);
  }

  // Источник situational-курса: обязателен (ТЗ-101 v13/v15)
  let source: SourceResolution | null = null;
  try {
    source = await resolveCourseSource(body);
  } catch (err: any) {
    if (err instanceof ResolveSourceError) return fail(res, err.status, err.message);
    throw err;
  }
  if (type === 'situational' && !source) {
    return fail(res, 400, 'укажите источник');
  }

  const tagIds = await validateTagIds(body.tag_ids ?? []);
  if (typeof tagIds === 'string') return fail(res, 400, tagIds);

  const id = crypto.randomUUID();
  const slug = await generateCourseSlug(title);

  await query(
    `INSERT INTO courses
       (id, title, slug, description, type, size, price, status, visibility,
        category_id, author, relevant_until, source_type, source_news_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', 'public', $8, $9, $10, $11, $12, $13)`,
    [
      id, title, slug, description, type, size, price, categoryId, author,
      body.relevant_until ? String(body.relevant_until) : null,
      source?.source_type ?? null,
      source?.source_news_id ?? null,
      adminId,
    ],
  );

  // Теги курса (v3)
  for (const tagId of tagIds as string[]) {
    await query(
      `INSERT INTO course_tags (course_id, tag_id) VALUES ($1, $2)`,
      [id, tagId],
    );
  }

  // Двунаправленная связь: source-новость → и в news_course_links (v13)
  if (source?.source_type === 'news' && source.source_news_id) {
    await query(
      `INSERT INTO news_course_links (news_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [source.source_news_id, id],
    );
  }

  invalidateEducationCache();
  logUserEvent(adminId, 'education.course_created', { course_id: id, title, type });

  res.status(201).json(await fetchCourseCard(id));
}));

// GET /courses/:id — полная карточка редактора
router.get('/courses/:id', h(async (req, res) => {
  const card = await fetchCourseCard(req.params.id);
  if (!card) return fail(res, 404, 'Курс не найден');
  res.json(card);
}));

// PUT /courses/:id — обновление полей (критерии 3, 16-19, 21, 22, 26)
router.put('/courses/:id', h(async (req, res) => {
  const adminId = req.user!.userId;
  const courseId = req.params.id;
  const courseR = await query(`SELECT * FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const course = courseR.rows[0];
  const body = req.body || {};

  const sets: string[] = [];
  const params: any[] = [];
  const setField = (clause: string, value: any) => {
    params.push(value);
    sets.push(clause.replace('?', `$${params.length}`));
  };

  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return fail(res, 400, 'title — непустая строка');
    setField('title = ?', title);
  }
  if (body.description !== undefined) {
    setField('description = ?', String(body.description));
  }
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 0) return fail(res, 400, 'price — целое число ≥ 0');
    setField('price = ?', price);
  }
  if (body.badges !== undefined) {
    const allowed = ['new', 'popular', 'recommended'];
    if (!Array.isArray(body.badges) ||
        body.badges.length > 2 ||
        !body.badges.every((b: any) => allowed.includes(String(b)))) {
      return fail(res, 400, 'badges — не более 2 меток из списка new/popular/recommended');
    }
    setField('badges = ?', JSON.stringify(body.badges));
  }
  if (body.size !== undefined) {
    if (!['micro', 'standard', 'full'].includes(String(body.size))) {
      return fail(res, 400, "size — только 'micro' | 'standard' | 'full'");
    }
    setField('size = ?', String(body.size));
  }
  if (body.visibility !== undefined) {
    if (!['public', 'hidden'].includes(String(body.visibility))) {
      return fail(res, 400, "visibility — только 'public' | 'hidden'");
    }
    setField('visibility = ?', String(body.visibility));
  }
  if (body.category_id !== undefined) {
    if (body.category_id === null) {
      setField('category_id = ?', null);
    } else {
      const cat = await query(`SELECT 1 FROM course_categories WHERE id = $1`, [String(body.category_id)]);
      if (cat.rows.length === 0) return fail(res, 400, 'несуществующая категория');
      setField('category_id = ?', String(body.category_id));
    }
  }
  if (body.author !== undefined) {
    const author = String(body.author).trim();
    if (!author || author.length > 100) {
      return fail(res, 400, 'author — непустая строка до 100 символов');
    }
    setField('author = ?', author);
  }
  if (body.relevant_until !== undefined) {
    setField('relevant_until = ?', body.relevant_until ? String(body.relevant_until) : null);
  }
  if (body.subscription_unlock_mode !== undefined) {
    if (!['full', 'drip'].includes(String(body.subscription_unlock_mode))) {
      return fail(res, 400, "subscription_unlock_mode — только 'full' | 'drip'");
    }
    setField('subscription_unlock_mode = ?', String(body.subscription_unlock_mode));
  }

  // Тип курса и источник (v11/v13): situational → source обязателен;
  // situational → course: обнуляем source_* и relevant_until (news_course_links НЕ трогаем)
  let newType = course.type;
  if (body.type !== undefined) {
    if (!['course', 'situational'].includes(String(body.type))) {
      return fail(res, 400, "type — только 'course' | 'situational'");
    }
    newType = String(body.type);
  }

  let source: SourceResolution | null = null;
  const hasSourceInput =
    (typeof body.source_url === 'string' && body.source_url.trim()) ||
    (body.source_type !== undefined && body.source_type !== null);
  try {
    source = hasSourceInput ? await resolveCourseSource(body) : null;
  } catch (err: any) {
    if (err instanceof ResolveSourceError) return fail(res, err.status, err.message);
    throw err;
  }

  if (newType === 'situational') {
    if (source) {
      setField('source_type = ?', source.source_type);
      setField('source_news_id = ?', source.source_news_id);
      // Двунаправленная связь (INSERT OR IGNORE / ON CONFLICT DO NOTHING —
      // адаптер SQLite конвертирует ON CONFLICT DO NOTHING → OR IGNORE)
      if (source.source_type === 'news' && source.source_news_id) {
        await query(
          `INSERT INTO news_course_links (news_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [source.source_news_id, courseId],
        );
      }
    } else if (course.type !== 'situational') {
      // course → situational без источника — 400
      return fail(res, 400, 'укажите источник');
    }
    // situational → situational без source-полей: сохраняем текущий источник
  } else if (course.type === 'situational') {
    // situational → course: обнуляем source и relevant_until (v11; критерий 22)
    setField('source_type = ?', null);
    setField('source_news_id = ?', null);
    setField('relevant_until = ?', null);
  }
  if (body.type !== undefined) {
    setField('type = ?', newType);
  }

  if (sets.length > 0) {
    sets.push(`updated_at = ${nowSql()}`);
    await query(
      `UPDATE courses SET ${sets.join(', ')} WHERE id = $${params.length + 1}`,
      [...params, courseId],
    );
  }

  // Тарифы курса (v6): полная замена, валидация активных планов (критерий 17)
  if (body.tariff_ids !== undefined) {
    if (!Array.isArray(body.tariff_ids)) return fail(res, 400, 'tariff_ids — массив id планов');
    const planIds = body.tariff_ids.map((x: any) => String(x));
    const plans = await getActivePlans();
    const activeIds = new Set(plans.map((p: any) => p.id));
    const missing = planIds.filter((id: string) => !activeIds.has(id));
    if (missing.length > 0) {
      return fail(res, 400, `несуществующие или неактивные планы: ${missing.join(', ')}`);
    }
    // Замена набора — в транзакции (ТЗ-106 Задача 3): падение между
    // DELETE и INSERT не должно оставлять курс без тарифов. SQLite-режим
    // (pool=null) — последовательно, как принято в этом файле.
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM course_tariffs WHERE course_id = $1`, [courseId]);
        for (const planId of planIds) {
          await client.query(
            `INSERT INTO course_tariffs (course_id, plan_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [courseId, planId],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    } else {
      await query(`DELETE FROM course_tariffs WHERE course_id = $1`, [courseId]);
      for (const planId of planIds) {
        await query(
          `INSERT INTO course_tariffs (course_id, plan_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [courseId, planId],
        );
      }
    }
  }

  invalidateEducationCache();
  logUserEvent(adminId, 'education.course_updated', { course_id: courseId });

  // ТЗ-103 Задача 1: смена title/description → асинхронный пересчёт эмбеддинга
  if (body.title !== undefined || body.description !== undefined) {
    scheduleCourseReembedding(courseId);
  }

  res.json(await fetchCourseCard(courseId));
}));

// PUT /courses/:id/tags — полная замена набора тегов (v3, критерий 21)
router.put('/courses/:id/tags', h(async (req, res) => {
  const courseId = req.params.id;
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const tagIds = await validateTagIds(req.body?.tag_ids ?? []);
  if (typeof tagIds === 'string') return fail(res, 400, tagIds);
  await query(`DELETE FROM course_tags WHERE course_id = $1`, [courseId]);
  for (const tagId of tagIds as string[]) {
    await query(`INSERT INTO course_tags (course_id, tag_id) VALUES ($1, $2)`, [courseId, tagId]);
  }
  invalidateEducationCache();
  logUserEvent(req.user!.userId, 'education.course_updated', { course_id: courseId, field: 'tags' });
  res.json({ tag_ids: tagIds });
}));

// POST /courses/:id/publish — проверки 422 (критерий 4, 22)
router.post('/courses/:id/publish', h(async (req, res) => {
  const adminId = req.user!.userId;
  const courseId = req.params.id;
  const courseR = await query(`SELECT * FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const course = courseR.rows[0];
  if (course.deleted_at) return fail(res, 409, 'Курс удалён — сначала восстановите');

  const lessons = await query(
    `SELECT COUNT(*) AS cnt FROM course_lessons WHERE course_id = $1`, [courseId],
  );
  if (Number(lessons.rows[0].cnt) < 1) {
    return fail(res, 422, 'Нельзя опубликовать курс без уроков');
  }
  if (course.type === 'situational') {
    if (course.source_type !== 'news' || !course.source_news_id) {
      return fail(res, 422, 'У ситуационного курса нет живого источника');
    }
    const news = await query(`SELECT 1 FROM news WHERE id = $1`, [course.source_news_id]);
    if (news.rows.length === 0) {
      return fail(res, 422, 'Новость-источник удалена — привяжите новый источник');
    }
  }
  if (course.relevant_until) {
    const until = new Date(course.relevant_until).getTime();
    if (Number.isFinite(until) && until <= Date.now()) {
      return fail(res, 422, 'Срок актуальности истёк — продлите relevant_until');
    }
  }

  await query(
    `UPDATE courses SET status = 'published', updated_at = ${nowSql()} WHERE id = $1`,
    [courseId],
  );
  invalidateEducationCache();
  logUserEvent(adminId, 'education.course_published', { course_id: courseId });
  // ТЗ-103: публикация — всегда пересчитываем эмбеддинг и запускаем
  // ретроскан новостей за 14 дней (асинхронно, флаг EDUCATION_MATCH_ENABLED)
  onCoursePublished(courseId);
  res.json(await fetchCourseCard(courseId));
}));

// POST /courses/:id/archive
router.post('/courses/:id/archive', h(async (req, res) => {
  const courseId = req.params.id;
  const courseR = await query(`SELECT id FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  await query(
    `UPDATE courses SET status = 'archived', updated_at = ${nowSql()} WHERE id = $1`,
    [courseId],
  );
  invalidateEducationCache();
  logUserEvent(req.user!.userId, 'education.course_archived', { course_id: courseId });
  res.json(await fetchCourseCard(courseId));
}));

// POST /courses/:id/delete — soft delete, идемпотентно (v3; критерий 22-уточнение)
router.post('/courses/:id/delete', h(async (req, res) => {
  const adminId = req.user!.userId;
  const courseId = req.params.id;
  const courseR = await query(`SELECT * FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  if (courseR.rows[0].deleted_at) {
    return res.json({ ok: true, already_deleted: true }); // идемпотентно
  }
  const purchases = await query(
    `SELECT COUNT(*) AS cnt FROM course_enrollments WHERE course_id = $1 AND source = 'purchase'`,
    [courseId],
  );
  if (Number(purchases.rows[0].cnt) > 0) {
    return fail(res, 409, 'курс с активными покупками, только архив');
  }
  await query(
    `UPDATE courses SET deleted_at = ${nowSql()}, updated_at = ${nowSql()} WHERE id = $1`,
    [courseId],
  );
  invalidateEducationCache();
  logUserEvent(adminId, 'education.course_deleted', { course_id: courseId });
  res.json({ ok: true });
}));

// POST /courses/:id/restore
router.post('/courses/:id/restore', h(async (req, res) => {
  const courseId = req.params.id;
  const courseR = await query(`SELECT id FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  await query(
    `UPDATE courses SET deleted_at = NULL, updated_at = ${nowSql()} WHERE id = $1`,
    [courseId],
  );
  invalidateEducationCache();
  logUserEvent(req.user!.userId, 'education.course_restored', { course_id: courseId });
  res.json(await fetchCourseCard(courseId));
}));

// POST /courses/:id/cover — обложка: magic bytes + EXIF strip (v12 S2/S3; критерий 8, 23)
router.post('/courses/:id/cover', uploadMw(coverUpload, 'file'), h(async (req, res) => {
  const adminId = req.user!.userId;
  const courseId = req.params.id;
  const courseR = await query(`SELECT cover_url FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');

  if (!(await checkRateLimit(req, res, lmsUploadLimiter))) return; // 429 уже отправлен

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file || !file.buffer || file.buffer.length === 0) {
    return fail(res, 400, 'Файл не загружен (field: file)');
  }

  // S2: тип по magic bytes, не по Content-Type клиента
  const ft = await fileType.fromBuffer(file.buffer);
  if (!ft || !COVER_MIMES.has(ft.mime)) {
    return fail(res, 415, 'Допустимы только jpg/png/webp');
  }

  // EXIF strip (S3): rotate() применяет orientation, withMetadata НЕ вызываем —
  // метаданные камеры/GPS не копируются в выходной файл.
  let normalized: Buffer;
  try {
    const img = sharp(file.buffer).rotate();
    const meta = await img.metadata();
    const megapixels = (meta.width || 0) * (meta.height || 0) / 1e6;
    if (megapixels > 50) {
      return fail(res, 413, 'Изображение больше 50 Мпикс (decompression bomb)');
    }
    normalized = await img.toBuffer();
  } catch {
    return fail(res, 415, 'Файл не является корректным изображением');
  }

  try {
    const put = await putBuffer(normalized, 'courses', `cover.${ft.ext}`);
    const oldCover = courseR.rows[0].cover_url;
    await query(
      `UPDATE courses SET cover_url = $1, updated_at = ${nowSql()} WHERE id = $2`,
      [put.relPath, courseId],
    );
    // S7: старая обложка → soft-delete в tmp/trash (retention 30 дней)
    if (oldCover && String(oldCover).startsWith('/media/')) {
      removeFile(String(oldCover)).catch((e: any) =>
        console.warn('[AdminEducation] old cover removeFile failed:', e?.message));
    }
    invalidateEducationCache();
    logUserEvent(adminId, 'education.course_updated', { course_id: courseId, field: 'cover' });
    res.json({ cover_url: put.relPath });
  } catch (err: any) {
    if (err instanceof StorageError) return fail(res, err.status, err.message);
    throw err;
  }
}));


// ═══════════════════════════════════════════════════════════════════════════
// Уроки (ТЗ-101; критерии 5, 6, 16, 23, 26)
// ═══════════════════════════════════════════════════════════════════════════

async function lessonExistsInCourse(courseId: string, lessonId: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM course_lessons WHERE id = $1 AND course_id = $2`,
    [lessonId, courseId],
  );
  return r.rows.length > 0;
}

router.get('/courses/:id/lessons', h(async (req, res) => {
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [req.params.id]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const rows = await query(
    `SELECT * FROM course_lessons WHERE course_id = $1 ORDER BY position ASC`,
    [req.params.id],
  );
  res.json(rows.rows.map((l: any) => ({
    id: l.id,
    position: l.position,
    title: l.title,
    kind: l.kind,
    text_content: l.text_content,
    video_source: l.video_source,
    video_embed_url: l.video_embed_url,
    video_file_url: l.video_file_url,
    duration_min: l.duration_min,
    is_free_preview: boolDb(l.is_free_preview),
    unlock_after_days: l.unlock_after_days,
  })));
}));

router.post('/courses/:id/lessons', h(async (req, res) => {
  const courseId = req.params.id;
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');

  const payload = validateLessonPayload(req.body || {});
  if ('error' in payload) return fail(res, 400, payload.error);
  const title = payload.title ?? String((req.body || {}).title || '').trim();
  if (!title) return fail(res, 400, 'title — непустая строка');

  const maxPos = await query(
    `SELECT COALESCE(MAX(position), 0) AS mp FROM course_lessons WHERE course_id = $1`,
    [courseId],
  );
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO course_lessons
       (id, course_id, position, title, kind, text_content, video_source,
        video_embed_url, video_file_url, duration_min, is_free_preview, unlock_after_days)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      id, courseId, Number(maxPos.rows[0].mp) + 1, title,
      payload.kind ?? 'text',
      payload.text_content ?? null,
      payload.video_source ?? null,
      payload.video_embed_url ?? null,
      null,
      payload.duration_min ?? null,
      payload.is_free_preview ?? false,
      payload.unlock_after_days ?? 0,
    ],
  );
  invalidateEducationCache();
  logUserEvent(req.user!.userId, 'education.course_updated', { course_id: courseId, field: 'lessons', lesson_id: id });
  // ТЗ-103 Задача 1: новый урок меняет текст курса → пересчёт эмбеддинга
  scheduleCourseReembedding(courseId);
  res.status(201).json({ id, position: Number(maxPos.rows[0].mp) + 1 });
}));

router.post('/courses/:id/lessons/reorder', h(async (req, res) => {
  const courseId = req.params.id;
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');

  const ids: unknown = req.body?.lesson_ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return fail(res, 400, 'lesson_ids — непустой массив (полный порядок)');
  }
  const lessonIds = ids.map((x) => String(x));
  if (new Set(lessonIds).size !== lessonIds.length) return fail(res, 400, 'Дубли в lesson_ids');
  const all = await query(
    `SELECT id FROM course_lessons WHERE course_id = $1`, [courseId],
  );
  const existing = new Set(all.rows.map((r: any) => r.id));
  if (lessonIds.length !== existing.size || !lessonIds.every((x) => existing.has(x))) {
    return fail(res, 400, 'lesson_ids должен содержать все уроки курса без лишних');
  }

  // UNIQUE(course_id, position) не даёт перенумеровать «внахлёст» — сначала
  // уводим все позиции курса во временный диапазон, потом ставим финальные.
  const TEMP_OFFSET = 100000;
  if (pool) {
    // PG: транзакция (одно соединение = одна транзакция)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE course_lessons SET position = position + $1 WHERE course_id = $2`,
        [TEMP_OFFSET, courseId],
      );
      for (let i = 0; i < lessonIds.length; i++) {
        await client.query(
          `UPDATE course_lessons SET position = $1 WHERE id = $2`,
          [i + 1, lessonIds[i]],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    // SQLite (pool=null): последовательные UPDATE; окно гонки при двух
    // редакторах принято (ТЗ-101 риски — редактор один)
    await query(
      `UPDATE course_lessons SET position = position + $1 WHERE course_id = $2`,
      [TEMP_OFFSET, courseId],
    );
    for (let i = 0; i < lessonIds.length; i++) {
      await query(
        `UPDATE course_lessons SET position = $1 WHERE id = $2`,
        [i + 1, lessonIds[i]],
      );
    }
  }
  invalidateEducationCache();
  res.json({ ok: true });
}));

// PUT /lessons/:lessonId — санитизация text_content (S1; критерии 5, 16, 23, 26)
router.put('/lessons/:lessonId', h(async (req, res) => {
  const lessonId = req.params.lessonId;
  const lessonR = await query(`SELECT * FROM course_lessons WHERE id = $1`, [lessonId]);
  if (lessonR.rows.length === 0) return fail(res, 404, 'Урок не найден');

  const payload = validateLessonPayload(req.body || {});
  if ('error' in payload) return fail(res, 400, payload.error);

  const sets: string[] = [];
  const params: any[] = [];
  const setField = (clause: string, value: any) => {
    params.push(value);
    sets.push(clause.replace('?', `$${params.length}`));
  };
  if (payload.title !== undefined) setField('title = ?', payload.title);
  if (payload.kind !== undefined) setField('kind = ?', payload.kind);
  if (payload.text_content !== undefined) setField('text_content = ?', payload.text_content);
  if (payload.video_embed_url !== undefined) setField('video_embed_url = ?', payload.video_embed_url);
  if (payload.video_source !== undefined) setField('video_source = ?', payload.video_source);
  if (payload.duration_min !== undefined) setField('duration_min = ?', payload.duration_min);
  if (payload.is_free_preview !== undefined) setField('is_free_preview = ?', payload.is_free_preview);
  if (payload.unlock_after_days !== undefined) setField('unlock_after_days = ?', payload.unlock_after_days);

  if (sets.length > 0) {
    await query(
      `UPDATE course_lessons SET ${sets.join(', ')} WHERE id = $${params.length + 1}`,
      [...params, lessonId],
    );
  }
  invalidateEducationCache();
  logUserEvent(req.user!.userId, 'education.course_updated', {
    course_id: lessonR.rows[0].course_id, field: 'lesson', lesson_id: lessonId,
  });
  // ТЗ-103 Задача 1: переименование урока меняет текст курса → пересчёт
  if (payload.title !== undefined) {
    scheduleCourseReembedding(lessonR.rows[0].course_id);
  }
  const fresh = await query(`SELECT * FROM course_lessons WHERE id = $1`, [lessonId]);
  const l = fresh.rows[0];
  res.json({
    id: l.id, position: l.position, title: l.title, kind: l.kind,
    text_content: l.text_content, video_source: l.video_source,
    video_embed_url: l.video_embed_url, video_file_url: l.video_file_url,
    duration_min: l.duration_min, is_free_preview: boolDb(l.is_free_preview),
    unlock_after_days: l.unlock_after_days,
  });
}));

// DELETE /lessons/:lessonId — пересчёт position 1..N + removed_progress (критерий 6)
router.delete('/lessons/:lessonId', h(async (req, res) => {
  const lessonId = req.params.lessonId;
  const lessonR = await query(`SELECT * FROM course_lessons WHERE id = $1`, [lessonId]);
  if (lessonR.rows.length === 0) return fail(res, 404, 'Урок не найден');
  const courseId = lessonR.rows[0].course_id;

  const progress = await query(
    `SELECT COUNT(*) AS cnt FROM lesson_progress WHERE lesson_id = $1`, [lessonId],
  );
  const removedProgress = Number(progress.rows[0].cnt);

  await query(`DELETE FROM course_lessons WHERE id = $1`, [lessonId]);
  // Пересчёт position оставшихся 1..N без дыр (FK каскадно снёс lesson_progress)
  const rest = await query(
    `SELECT id FROM course_lessons WHERE course_id = $1 ORDER BY position ASC`,
    [courseId],
  );
  for (let i = 0; i < rest.rows.length; i++) {
    await query(`UPDATE course_lessons SET position = $1 WHERE id = $2`, [i + 1, rest.rows[i].id]);
  }
  invalidateEducationCache();
  logUserEvent(req.user!.userId, 'education.course_updated', {
    course_id: courseId, field: 'lessons', removed_lesson_id: lessonId,
  });
  // ТЗ-103 Задача 1: удаление урока меняет текст курса → пересчёт эмбеддинга
  scheduleCourseReembedding(courseId);
  res.json({ ok: true, removed_progress: removedProgress });
}));

// PUT /lessons/:lessonId/test — создать/обновить тест (критерии ТЗ-100 4-5)
router.put('/lessons/:lessonId/test', h(async (req, res) => {
  const lessonId = req.params.lessonId;
  const lessonR = await query(`SELECT 1 FROM course_lessons WHERE id = $1`, [lessonId]);
  if (lessonR.rows.length === 0) return fail(res, 404, 'Урок не найден');
  const body = req.body || {};

  const passScore = Number(body.pass_score);
  if (!Number.isInteger(passScore) || passScore < 1 || passScore > 100) {
    return fail(res, 400, 'pass_score — целое число 1..100');
  }
  const questions: unknown = body.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 20) {
    return fail(res, 400, 'questions — от 1 до 20 вопросов');
  }
  const normalized = [];
  for (const q of questions) {
    const text = String(q?.q || '').trim();
    const options: unknown = q?.options;
    const correct = Number(q?.correct);
    if (!text) return fail(res, 400, 'у каждого вопроса должен быть текст (q)');
    if (!Array.isArray(options) || options.length < 2 || options.length > 6) {
      return fail(res, 400, 'options — от 2 до 6 вариантов');
    }
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) {
      return fail(res, 400, 'correct — индекс правильного ответа в диапазоне options');
    }
    normalized.push({ q: text, options: options.map((o: any) => String(o)), correct });
  }

  const existing = await query(`SELECT id FROM lesson_tests WHERE lesson_id = $1`, [lessonId]);
  if (existing.rows.length > 0) {
    await query(
      `UPDATE lesson_tests SET pass_score = $1, is_blocking = $2, questions = $3 WHERE lesson_id = $4`,
      [passScore, !!body.is_blocking, JSON.stringify(normalized), lessonId],
    );
  } else {
    await query(
      `INSERT INTO lesson_tests (id, lesson_id, pass_score, is_blocking, questions)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), lessonId, passScore, !!body.is_blocking, JSON.stringify(normalized)],
    );
  }
  invalidateEducationCache();
  logUserEvent(req.user!.userId, 'education.course_updated', { field: 'test', lesson_id: lessonId });
  res.json({ ok: true, pass_score: passScore, is_blocking: !!body.is_blocking, questions: normalized });
}));

// DELETE /lessons/:lessonId/test
router.delete('/lessons/:lessonId/test', h(async (req, res) => {
  const lessonId = req.params.lessonId;
  const lessonR = await query(`SELECT 1 FROM course_lessons WHERE id = $1`, [lessonId]);
  if (lessonR.rows.length === 0) return fail(res, 404, 'Урок не найден');
  await query(`DELETE FROM lesson_tests WHERE lesson_id = $1`, [lessonId]);
  invalidateEducationCache();
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════
// Материалы (ТЗ-101 v5; критерии ТЗ-100 10-11, 18)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchMaterial(materialId: string): Promise<any | null> {
  const r = await query(`SELECT * FROM course_materials WHERE id = $1`, [materialId]);
  if (r.rows.length === 0) return null;
  const m = r.rows[0];
  return {
    id: m.id, course_id: m.course_id, kind: m.kind, title: m.title,
    url: m.url, news_id: m.news_id, is_free: boolDb(m.is_free), position: m.position,
  };
}

/** Валидация тела материала: kind file|link|news, url-правила, is_free (bool). */
async function validateMaterialBody(body: any, partial: boolean):
  Promise<{ ok: true; fields: Record<string, any> } | { ok: false; status: number; message: string }> {
  const fields: Record<string, any> = {};
  const kind = body.kind !== undefined ? String(body.kind) : undefined;
  if (kind !== undefined) {
    if (!['file', 'link', 'news'].includes(kind)) {
      return { ok: false, status: 400, message: "kind — только 'file' | 'link' | 'news'" };
    }
    fields.kind = kind;
  }
  const effectiveKind = kind;
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) return { ok: false, status: 400, message: 'title — непустая строка' };
    fields.title = title;
  }
  if (body.url !== undefined) {
    const url = String(body.url || '').trim();
    if (effectiveKind === 'link' || (!effectiveKind && !partial)) {
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, status: 400, message: "url для kind='link' — http(s) ссылка" };
      }
    }
    if (effectiveKind === 'file' && url && !url.startsWith('/media/')) {
      return { ok: false, status: 400, message: "url для kind='file' — путь из storage (/media/...)" };
    }
    fields.url = url;
  }
  if (body.news_id !== undefined) {
    if (body.news_id === null) {
      fields.news_id = null;
    } else {
      const news = await query(`SELECT id, slug FROM news WHERE id = $1`, [String(body.news_id)]);
      if (news.rows.length === 0) {
        return { ok: false, status: 404, message: 'Новость не найдена' };
      }
      fields.news_id = String(body.news_id);
    }
  }
  if (body.is_free !== undefined) {
    fields.is_free = !!body.is_free;
  }
  if (body.position !== undefined) {
    const p = Number(body.position);
    if (!Number.isInteger(p) || p < 0) return { ok: false, status: 400, message: 'position — целое ≥ 0' };
    fields.position = p;
  }
  return { ok: true, fields };
}

router.get('/courses/:id/materials', h(async (req, res) => {
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [req.params.id]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const rows = await query(
    `SELECT * FROM course_materials WHERE course_id = $1 ORDER BY position ASC`,
    [req.params.id],
  );
  res.json(rows.rows.map((m: any) => ({
    id: m.id, kind: m.kind, title: m.title, url: m.url,
    news_id: m.news_id, is_free: boolDb(m.is_free), position: m.position,
  })));
}));

router.post('/courses/:id/materials', h(async (req, res) => {
  const courseId = req.params.id;
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const body = req.body || {};

  const kind = String(body.kind || '');
  if (!['file', 'link', 'news'].includes(kind)) {
    return fail(res, 400, "kind — только 'file' | 'link' | 'news'");
  }
  const title = String(body.title || '').trim();
  if (!title) return fail(res, 400, 'Укажите название материала');

  let url = String(body.url || '').trim();
  let newsId: string | null = null;
  if (kind === 'link') {
    if (!/^https?:\/\//i.test(url)) return fail(res, 400, "url для kind='link' — http(s) ссылка");
  } else if (kind === 'file') {
    if (!url.startsWith('/media/')) {
      return fail(res, 400, "url для kind='file' — путь из storage (загрузка: POST .../materials/upload)");
    }
  } else {
    // news: news_id обязателен, url — служебный путь
    if (!body.news_id) return fail(res, 400, 'для kind=news нужен news_id');
    const news = await query(`SELECT id, slug FROM news WHERE id = $1`, [String(body.news_id)]);
    if (news.rows.length === 0) return fail(res, 404, 'Новость не найдена');
    newsId = String(body.news_id);
    url = `/news/${news.rows[0].slug || news.rows[0].id}`;
  }

  const maxPos = await query(
    `SELECT COALESCE(MAX(position), 0) AS mp FROM course_materials WHERE course_id = $1`,
    [courseId],
  );
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO course_materials (id, course_id, kind, title, url, news_id, is_free, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, courseId, kind, title, url, newsId, !!body.is_free, Number(maxPos.rows[0].mp) + 1],
  );
  invalidateEducationCache();
  res.status(201).json(await fetchMaterial(id));
}));

// POST /courses/:id/materials/upload — файл материала (S2 magic bytes; критерий 18)
router.post('/courses/:id/materials/upload', uploadMw(materialUpload, 'file'), h(async (req, res) => {
  const courseId = req.params.id;
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');

  if (!(await checkRateLimit(req, res, lmsUploadLimiter))) return; // 429 уже отправлен

  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file || !file.buffer || file.buffer.length === 0) {
    return fail(res, 400, 'Файл не загружен (field: file)');
  }
  const ext = await detectMaterialExt(file.buffer, file.originalname || '');
  if (!ext) {
    return fail(res, 415, 'Недопустимый тип файла (pdf/office/изображения/zip/txt/md/csv)');
  }
  try {
    const put = await putBuffer(file.buffer, 'materials', file.originalname || `material.${ext}`);
    const title = String((req.body?.title || file.originalname || 'Файл')).trim().substring(0, 255);
    const maxPos = await query(
      `SELECT COALESCE(MAX(position), 0) AS mp FROM course_materials WHERE course_id = $1`,
      [courseId],
    );
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO course_materials (id, course_id, kind, title, url, news_id, is_free, position)
       VALUES ($1, $2, 'file', $3, $4, NULL, $5, $6)`,
      [id, courseId, title, put.relPath, !!req.body?.is_free, Number(maxPos.rows[0].mp) + 1],
    );
    invalidateEducationCache();
    res.status(201).json(await fetchMaterial(id));
  } catch (err: any) {
    if (err instanceof StorageError) return fail(res, err.status, err.message);
    throw err;
  }
}));

// PATCH /materials/:materialId — в т.ч. мгновенная смена is_free (v5; критерий 16)
router.patch('/materials/:materialId', h(async (req, res) => {
  const materialId = req.params.materialId;
  const existing = await fetchMaterial(materialId);
  if (!existing) return fail(res, 404, 'Материал не найден');
  const v = await validateMaterialBody(req.body || {}, true);
  if (!v.ok) return fail(res, v.status, v.message);

  const keys = Object.keys(v.fields);
  if (keys.length > 0) {
    const sets: string[] = [];
    const params: any[] = [];
    for (const k of keys) {
      params.push(v.fields[k]);
      sets.push(`${k} = $${params.length}`);
    }
    await query(
      `UPDATE course_materials SET ${sets.join(', ')} WHERE id = $${params.length + 1}`,
      [...params, materialId],
    );
    // Смена is_free меняет карточку курса для гостей → инвалидация кэша витрины
    invalidateEducationCache();
  }
  res.json(await fetchMaterial(materialId));
}));

router.delete('/courses/:id/materials/:materialId', h(async (req, res) => {
  const { id: courseId, materialId } = req.params;
  const existing = await fetchMaterial(materialId);
  if (!existing || existing.course_id !== courseId) return fail(res, 404, 'Материал не найден');
  await query(`DELETE FROM course_materials WHERE id = $1`, [materialId]);
  // S7: файл материала → soft-delete в tmp/trash (retention 30 дней)
  if (existing.kind === 'file' && existing.url && String(existing.url).startsWith('/media/')) {
    removeFile(String(existing.url)).catch((e: any) =>
      console.warn('[AdminEducation] material removeFile failed:', e?.message));
  }
  invalidateEducationCache();
  res.json({ ok: true });
}));

// ═══════════════════════════════════════════════════════════════════════════
// Привязка новостей (ТЗ-101; критерий 7) — лимит 10 активных привязок
// ═══════════════════════════════════════════════════════════════════════════

router.get('/courses/:id/news-links', h(async (req, res) => {
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [req.params.id]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const rows = await query(
    `SELECT n.id, n.slug, n.title_ru, n.published_at
     FROM news_course_links l JOIN news n ON n.id = l.news_id
     WHERE l.course_id = $1 ORDER BY l.position ASC`,
    [req.params.id],
  );
  res.json(rows.rows);
}));

router.post('/courses/:id/news-links', h(async (req, res) => {
  const courseId = req.params.id;
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const newsId = req.body?.news_id ? String(req.body.news_id) : '';
  if (!newsId) return fail(res, 400, 'news_id обязателен');
  const news = await query(`SELECT id FROM news WHERE id = $1`, [newsId]);
  if (news.rows.length === 0) return fail(res, 404, 'Новость не найдена');

  const count = await query(
    `SELECT COUNT(*) AS cnt FROM news_course_links WHERE course_id = $1`, [courseId],
  );
  if (Number(count.rows[0].cnt) >= 10) {
    return fail(res, 400, 'Не более 10 привязанных новостей на курс');
  }
  await query(
    `INSERT INTO news_course_links (news_id, course_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [newsId, courseId],
  );
  invalidateEducationCache();
  res.status(201).json({ ok: true });
}));

router.delete('/courses/:id/news-links/:newsId', h(async (req, res) => {
  const { id: courseId, newsId } = req.params;
  const r = await query(
    `DELETE FROM news_course_links WHERE course_id = $1 AND news_id = $2`,
    [courseId, newsId],
  );
  if ((r.rowCount ?? 0) === 0) return fail(res, 404, 'Привязка не найдена');
  invalidateEducationCache();
  res.json({ ok: true });
}));


// ═══════════════════════════════════════════════════════════════════════════
// Задача 4 — управление слушателями (ТЗ-101 v4; критерии 13-14, 19)
// ═══════════════════════════════════════════════════════════════════════════

router.get('/courses/:id/enrollments', h(async (req, res) => {
  const courseId = req.params.id;
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const totalR = await query(
    `SELECT COUNT(*) AS cnt FROM course_lessons WHERE course_id = $1`, [courseId],
  );
  const totalLessons = Number(totalR.rows[0].cnt);
  const rows = await query(
    `SELECT ce.user_id, ce.source, ce.payment_id, ce.created_at,
            u.username, u.email, u.is_blocked,
       (SELECT COUNT(*) FROM lesson_progress lp
          JOIN course_lessons cl ON cl.id = lp.lesson_id
         WHERE lp.user_id = ce.user_id AND cl.course_id = ce.course_id) AS completed_lessons
     FROM course_enrollments ce
     JOIN users u ON u.id = ce.user_id
     WHERE ce.course_id = $1
     ORDER BY ce.created_at DESC`,
    [courseId],
  );
  res.json(rows.rows.map((r: any) => {
    const completed = Number(r.completed_lessons);
    return {
      user_id: r.user_id,
      username: r.username,
      email: r.email,
      is_blocked: boolDb(r.is_blocked),
      source: r.source,
      payment_id: r.payment_id,
      created_at: r.created_at,
      progress: {
        completed_lessons: completed,
        total_lessons: totalLessons,
        percent: totalLessons > 0 ? Math.round((completed / totalLessons) * 100) : 0,
      },
    };
  }));
}));

router.get('/users-search', h(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return fail(res, 400, 'Минимум 2 символа для поиска');
  // НЕ переиспользуем GET /api/admin/users (тяжёлый). is_blocked НЕ фильтруем —
  // фронт показывает флаг (критерий 14: blocked → 422 при записи)
  const rows = USE_SQLITE
    ? await query(
        `SELECT id, email, username, is_blocked FROM users ORDER BY created_at DESC LIMIT 1000`, [],
      )
    : await query(
        `SELECT id, email, username, is_blocked FROM users
         WHERE email ILIKE $1 OR username ILIKE $1
         ORDER BY created_at DESC LIMIT 10`,
        [`%${escapeLike(q)}%`],
      );
  const list = USE_SQLITE
    ? rows.rows
        .filter((u: any) => matchesQuery(u.email, q) || matchesQuery(u.username, q))
        .slice(0, 10)
    : rows.rows;
  res.json(list.map((r: any) => ({
    id: r.id, email: r.email, username: r.username, is_blocked: boolDb(r.is_blocked),
  })));
}));

// POST /courses/:id/enrollments — запись админом, source='admin_grant', идемпотентно
router.post('/courses/:id/enrollments', h(async (req, res) => {
  const adminId = req.user!.userId;
  const courseId = req.params.id;
  const userId = req.body?.user_id ? String(req.body.user_id) : '';
  if (!userId) return fail(res, 400, 'user_id обязателен');

  const courseR = await query(`SELECT * FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  if (courseR.rows[0].deleted_at) return fail(res, 409, 'Курс удалён — сначала восстановите');

  const userR = await query(`SELECT is_blocked FROM users WHERE id = $1`, [userId]);
  if (userR.rows.length === 0) return fail(res, 404, 'Пользователь не найден');
  if (boolDb(userR.rows[0].is_blocked)) {
    return fail(res, 422, 'Пользователь заблокирован — запись невозможна');
  }

  const existing = await query(
    `SELECT id FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId],
  );
  if (existing.rows.length > 0) {
    return res.status(200).json({ ok: true, already_enrolled: true });
  }

  await query(
    `INSERT INTO course_enrollments (id, user_id, course_id, source, payment_id)
     VALUES ($1, $2, $3, 'admin_grant', NULL)`,
    [crypto.randomUUID(), userId, courseId],
  );
  // Инвалидация кэша витрины НЕ нужна (счётчик записанных не входит в каталог,
  // ТЗ-101 Задача 4) — но аналитика обязательна: кто кому раздал доступ
  logUserEvent(adminId, 'education.enroll_admin', { course_id: courseId, target_user_id: userId });
  res.status(201).json({ ok: true, source: 'admin_grant' });
}));

// DELETE /courses/:id/enrollments/:userId — выписать; прогресс НЕ удалять
router.delete('/courses/:id/enrollments/:userId', h(async (req, res) => {
  const adminId = req.user!.userId;
  const { id: courseId, userId } = req.params;
  const r = await query(
    `DELETE FROM course_enrollments WHERE course_id = $1 AND user_id = $2`,
    [courseId, userId],
  );
  if ((r.rowCount ?? 0) === 0) return fail(res, 404, 'Пользователь не записан на курс');
  logUserEvent(adminId, 'education.unenroll_admin', { course_id: courseId, target_user_id: userId });
  res.status(204).end();
}));

// ═══════════════════════════════════════════════════════════════════════════
// Очередь модерации UGC (ТЗ-102, Задача 3) — pending-материалы + pending-
// предложения новостей, объединённая FIFO-лента (created_at ASC, старые первыми).
// ═══════════════════════════════════════════════════════════════════════════

// Возраст pending_scan, после которого в очереди показываем «антивирус
// недоступен» (колонка в БД не нужна — вычисляемое поле, ТЗ-102 §2 S4).
const AV_STALE_MS = parseInt(process.env.CLAMAV_STALE_MS || String(10 * 60 * 1000), 10);

/**
 * Парсинг created_at из БД в epoch ms. SQLite datetime('now') — 'YYYY-MM-DD
 * HH:MM:SS' в UTC (Date парсит его как локальное время → завышенный возраст),
 * PG — ISO с таймзоной. SQLite-формат нормализуем в UTC явно.
 */
function dbDateMs(value: any): number {
  if (!value) return 0;
  const s = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const t = new Date(normalized).getTime();
  return Number.isFinite(t) ? t : 0;
}

router.get('/moderation', h(async (_req, res) => {
  const [matR, newsR] = await Promise.all([
    query(
      `SELECT m.id, m.kind, m.title, m.url, m.news_id, m.status, m.scan_status, m.created_at,
              m.submitted_by, c.id AS course_id, c.slug AS course_slug, c.title AS course_title,
              u.username AS submitted_by_username,
              n.title_ru AS news_title, n.slug AS news_slug, n.published_at AS news_published_at
       FROM course_materials m
       JOIN courses c ON c.id = m.course_id
       LEFT JOIN users u ON u.id = m.submitted_by
       LEFT JOIN news n ON n.id = m.news_id
       WHERE m.status = 'pending'
       ORDER BY m.created_at ASC`,
      [],
    ),
    query(
      `SELECT s.id, s.created_at, s.news_id, s.submitted_by,
              c.id AS course_id, c.slug AS course_slug, c.title AS course_title,
              u.username AS submitted_by_username,
              n.title_ru AS news_title, n.slug AS news_slug, n.published_at AS news_published_at
       FROM news_course_suggestions s
       JOIN courses c ON c.id = s.course_id
       LEFT JOIN users u ON u.id = s.submitted_by
       JOIN news n ON n.id = s.news_id
       WHERE s.status = 'pending'
       ORDER BY s.created_at ASC`,
      [],
    ),
  ]);

  const now = Date.now();
  const items: any[] = [
    ...matR.rows.map((m: any) => {
      const pendingScan = m.scan_status === 'pending_scan';
      // pending_scan свежее порога — норма (clamd обрабатывает); старше — авария
      const ageMs = m.created_at ? now - dbDateMs(m.created_at) : 0;
      return {
        type: 'material',
        id: m.id,
        kind: m.kind,
        title: m.title,
        url: m.kind === 'link' ? m.url : null, // файл — скачивание через download-эндпоинт
        file_url: m.kind === 'file' ? m.url : null,
        scan_status: m.scan_status,
        av_unavailable: pendingScan && ageMs > AV_STALE_MS,
        news: m.news_id
          ? { id: m.news_id, slug: m.news_slug, title_ru: m.news_title, published_at: m.news_published_at }
          : null,
        course: { id: m.course_id, slug: m.course_slug, title: m.course_title },
        author: m.submitted_by
          ? { id: m.submitted_by, username: m.submitted_by_username || null }
          : null,
        created_at: m.created_at,
      };
    }),
    ...newsR.rows.map((s: any) => ({
      type: 'news-suggestion',
      id: s.id,
      kind: 'news',
      title: s.news_title,
      url: null,
      file_url: null,
      scan_status: 'clean',
      av_unavailable: false,
      news: { id: s.news_id, slug: s.news_slug, title_ru: s.news_title, published_at: s.news_published_at },
      course: { id: s.course_id, slug: s.course_slug, title: s.course_title },
      author: s.submitted_by
        ? { id: s.submitted_by, username: s.submitted_by_username || null }
        : null,
      created_at: s.created_at,
    })),
  ];
  // FIFO: старые первыми (NULL-даты — в начало, их модерируют первыми)
  items.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));

  // ТЗ-102 §2 (retry-стратегия): заход модератора в очередь ставит pending_scan
  // в очередь сканирования — статус в карточке обновляется без перезагрузки
  for (const m of matR.rows) {
    if (m.scan_status === 'pending_scan') enqueueScan(m.id);
  }

  res.json({ total: items.length, items });
}));

// POST /moderation/:kind/:id/approve — kind='material' | 'news-suggestion'
router.post('/moderation/:kind/:id/approve', h(async (req, res) => {
  const adminId = req.user!.userId;
  const { kind, id } = req.params;

  if (kind === 'material') {
    const r = await query(`SELECT * FROM course_materials WHERE id = $1`, [id]);
    if (r.rows.length === 0) return fail(res, 404, 'Материал не найден');
    const m = r.rows[0];
    if (m.status !== 'pending') return fail(res, 409, 'Материал уже проверен');
    // S4: чистый файл-only. pending_scan ещё «на проверке», infected ушёл в
    // системный отказ автоматически (virusScan.ts) — такие сюда не доходят.
    if (m.scan_status !== 'clean') {
      return fail(res, 409, 'Файл ещё на антивирусной проверке — дождитесь результата');
    }
    await query(
      `UPDATE course_materials
         SET status = 'approved', reviewed_by = $1, reviewed_at = ${nowSql()}, reject_reason = NULL
       WHERE id = $2`,
      [adminId, id],
    );
    invalidateEducationCache(); // UGC появляется на витрине без ожидания TTL
    logUserEvent(adminId, 'education.moderation_approve', { type: 'material', id });
    return res.json({ ok: true, status: 'approved' });
  }

  if (kind === 'news-suggestion') {
    const r = await query(`SELECT * FROM news_course_suggestions WHERE id = $1`, [id]);
    if (r.rows.length === 0) return fail(res, 404, 'Предложение не найдено');
    const s = r.rows[0];
    if (s.status !== 'pending') return fail(res, 409, 'Предложение уже проверено');
    // Аппрув = перенос в редакционную таблицу news_course_links (ТЗ-100,
    // публичные выборки её не меняли). Повторный аппрув (PK news_id+course_id)
    // на гонке — идемпотентно проглатываем.
    const maxPos = await query(
      `SELECT COALESCE(MAX(position), 0) AS mp FROM news_course_links WHERE course_id = $1`,
      [s.course_id],
    );
    try {
      await query(
        `INSERT INTO news_course_links (news_id, course_id, position) VALUES ($1, $2, $3)`,
        [s.news_id, s.course_id, Number(maxPos.rows[0].mp) + 1],
      );
    } catch (err: any) {
      if (!(String(err?.message || '').includes('UNIQUE') || err?.code === '23505')) throw err;
    }
    await query(
      `UPDATE news_course_suggestions
         SET status = 'approved', reviewed_by = $1, reviewed_at = ${nowSql()}, reject_reason = NULL
       WHERE id = $2`,
      [adminId, id],
    );
    invalidateEducationCache();
    logUserEvent(adminId, 'education.moderation_approve', { type: 'news-suggestion', id });
    return res.json({ ok: true, status: 'approved' });
  }

  return fail(res, 400, "kind — только 'material' | 'news-suggestion'");
}));

// POST /moderation/:kind/:id/reject — { reason } обязателен (увидит ученик)
router.post('/moderation/:kind/:id/reject', h(async (req, res) => {
  const adminId = req.user!.userId;
  const { kind, id } = req.params;
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return fail(res, 400, 'reason обязателен — ученик увидит его в своих предложениях');

  if (kind === 'material') {
    const r = await query(`SELECT status FROM course_materials WHERE id = $1`, [id]);
    if (r.rows.length === 0) return fail(res, 404, 'Материал не найден');
    if (r.rows[0].status !== 'pending') return fail(res, 409, 'Материал уже проверен');
    await query(
      `UPDATE course_materials
         SET status = 'rejected', reviewed_by = $1, reviewed_at = ${nowSql()}, reject_reason = $2
       WHERE id = $3`,
      [adminId, reason, id],
    );
    invalidateEducationCache();
    logUserEvent(adminId, 'education.moderation_reject', { type: 'material', id });
    return res.json({ ok: true, status: 'rejected' });
  }

  if (kind === 'news-suggestion') {
    const r = await query(`SELECT status FROM news_course_suggestions WHERE id = $1`, [id]);
    if (r.rows.length === 0) return fail(res, 404, 'Предложение не найдено');
    if (r.rows[0].status !== 'pending') return fail(res, 409, 'Предложение уже проверено');
    await query(
      `UPDATE news_course_suggestions
         SET status = 'rejected', reviewed_by = $1, reviewed_at = ${nowSql()}, reject_reason = $2
       WHERE id = $3`,
      [adminId, reason, id],
    );
    invalidateEducationCache();
    logUserEvent(adminId, 'education.moderation_reject', { type: 'news-suggestion', id });
    return res.json({ ok: true, status: 'rejected' });
  }

  return fail(res, 400, "kind — только 'material' | 'news-suggestion'");
}));

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-103, Задача 4 — рекомендации мэтчинга «курс ↔ новость» (suggestions).
// Принцип: система только РЕКОМЕНДУЕТ — прикрепление решением редактора
// (attach), повторный мэтчинг не воскрешает решения (ON CONFLICT DO NOTHING).
// Все эндпоинты — 404 при выключенном EDUCATION_MATCH_ENABLED (Задача 6).
// ═══════════════════════════════════════════════════════════════════════════

// GET /courses/:id/suggestions?status=pending — рекомендации курса
router.get('/courses/:id/suggestions', h(async (req, res) => {
  if (!isEducationMatchEnabled()) return fail(res, 404, 'Not found');
  const courseId = req.params.id;
  const courseR = await query(`SELECT 1 FROM courses WHERE id = $1`, [courseId]);
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');

  const status = String(req.query.status || 'pending');
  if (!['pending', 'attached', 'dismissed'].includes(status)) {
    return fail(res, 400, "status — только 'pending' | 'attached' | 'dismissed'");
  }
  // score DESC NULLS LAST, created_at DESC (NULLS LAST кросс-диалектно через
  // предикат — SQLite sql.js поддерживает NULLS LAST не всякий)
  const rows = await query(
    `SELECT s.id, s.news_id, s.score, s.reason, s.source, s.status, s.created_at,
            n.title_ru, n.published_at, n.source AS news_source, n.slug AS news_slug
     FROM course_match_suggestions s
     JOIN news n ON n.id = s.news_id
     WHERE s.course_id = $1 AND s.status = $2
     ORDER BY (s.score IS NULL) ASC, s.score DESC, s.created_at DESC`,
    [courseId, status],
  );
  res.json(rows.rows.map((r: any) => ({
    id: r.id,
    news_id: r.news_id,
    news_slug: r.news_slug,
    title_ru: r.title_ru,
    published_at: r.published_at,
    source: r.news_source,
    score: r.score === null ? null : Number(r.score),
    reason: r.reason,
    match_source: r.source,
    status: r.status,
    created_at: r.created_at,
  })));
}));

// POST /suggestions/:id/attach — прикрепить рекомендованную новость (в транзакции:
// news_course_links + status='attached'). Идемпотентно при повторном attach.
router.post('/suggestions/:id/attach', h(async (req, res) => {
  if (!isEducationMatchEnabled()) return fail(res, 404, 'Not found');
  const adminId = req.user!.userId;
  const suggestionId = req.params.id;

  const sR = await query(
    `SELECT * FROM course_match_suggestions WHERE id = $1`, [suggestionId],
  );
  if (sR.rows.length === 0) return fail(res, 404, 'Рекомендация не найдена');
  const suggestion = sR.rows[0];
  if (suggestion.status === 'attached') {
    return res.json({ ok: true, already_attached: true });
  }
  if (suggestion.status === 'dismissed') {
    return fail(res, 409, 'Рекомендация отклонена — повторный мэтчинг её не вернёт');
  }

  const attach = async () => {
    const maxPos = await query(
      `SELECT COALESCE(MAX(position), 0) AS mp FROM news_course_links WHERE course_id = $1`,
      [suggestion.course_id],
    );
    await query(
      `INSERT INTO news_course_links (news_id, course_id, position)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [suggestion.news_id, suggestion.course_id, Number(maxPos.rows[0].mp) + 1],
    );
    await query(
      `UPDATE course_match_suggestions
         SET status = 'attached', decided_by = $1, decided_at = ${nowSql()}
       WHERE id = $2`,
      [adminId, suggestionId],
    );
  };

  if (pool) {
    // PG: транзакция (одно соединение = одна транзакция), паттерн reorder
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await attach();
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    // SQLite (pool=null): последовательные запросы; окно гонки принято
    await attach();
  }

  invalidateEducationCache(); // «Курс в новостях» обновляется без TTL-ожидания
  logUserEvent(adminId, 'education.match_attached', { suggestion_id: suggestionId, course_id: suggestion.course_id, news_id: suggestion.news_id });
  res.json({ ok: true, status: 'attached' });
}));

// POST /suggestions/:id/dismiss — отклонить рекомендацию. Прикреплённую новость
// НЕ открепляем (для открепления — DELETE news-links, ТЗ-101).
router.post('/suggestions/:id/dismiss', h(async (req, res) => {
  if (!isEducationMatchEnabled()) return fail(res, 404, 'Not found');
  const adminId = req.user!.userId;
  const suggestionId = req.params.id;

  const sR = await query(
    `SELECT * FROM course_match_suggestions WHERE id = $1`, [suggestionId],
  );
  if (sR.rows.length === 0) return fail(res, 404, 'Рекомендация не найдена');
  const suggestion = sR.rows[0];
  if (suggestion.status === 'attached') {
    return fail(res, 409, 'Новость уже прикреплена — открепление через news-links');
  }
  if (suggestion.status === 'dismissed') {
    return res.json({ ok: true, already_dismissed: true }); // идемпотентно
  }
  await query(
    `UPDATE course_match_suggestions
       SET status = 'dismissed', decided_by = $1, decided_at = ${nowSql()}
     WHERE id = $2`,
    [adminId, suggestionId],
  );
  logUserEvent(adminId, 'education.match_dismissed', { suggestion_id: suggestionId, course_id: suggestion.course_id, news_id: suggestion.news_id });
  res.json({ ok: true, status: 'dismissed' });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-103 v2, Задача 7 — админский events-preview: мэтчинг курса к событиям
// календаря по тегам (для черновиков тоже — редактор проверяет до публикации).
// 404 при выключенном EDUCATION_MATCH_ENABLED.
// ═══════════════════════════════════════════════════════════════════════════

// GET /courses/:id/events-preview?days=14
router.get('/courses/:id/events-preview', h(async (req, res) => {
  if (!isEducationMatchEnabled()) return fail(res, 404, 'Not found');
  const courseR = await query(
    `SELECT id FROM courses WHERE id = $1 AND deleted_at IS NULL`, [req.params.id],
  );
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');

  let days = parseInt(String(req.query.days || '14'), 10);
  if (!Number.isInteger(days) || days < 1 || days > 90) days = 14;

  const tags = await courseTagIds(req.params.id);
  if (tags.length === 0) {
    return res.json({ events: [], warning: 'no_tags' });
  }
  const events = await matchEventsToCourse(tags, days);
  res.json({ events });
}));

export default router;
