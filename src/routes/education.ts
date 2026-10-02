/**
 * =============================================================================
 * PULSE — LMS «Образование»: публичный API (ТЗ-100 Задача 2 — минимальный контур)
 * =============================================================================
 *
 * Auth: optionalAuth (JWT «мягкий» парсер, как NewsFeed) на публичных эндпоинтах;
 * authMiddleware — только там, где «да» (complete, my). Ошибки {error: string}.
 *
 * Кэш витрины: getCached() из services/education/cache (TTL 5 мин, ключи
 * 'education:'), инвалидация — любой мутацией adminEducation. Персональные
 * поля (my_enrollment, progress, locked_by_drip) НЕ кэшируются — дочисляются
 * после чтения кэша (риск «Кэш × персонализация» ТЗ-100 v5).
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import fileType from 'file-type';
import crypto from 'crypto';
import axios from 'axios';

import { query } from '../config/db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { optionalAuth } from '../middleware/optionalAuth';
import { checkRateLimit, lmsCalendarMatchLimiter, lmsFreeDownloadLimiter, lmsSubmissionLimiter } from '../middleware/rateLimit';
import { getActivePlans, getUserSubscription, parseDbJson } from '../services/subscription';
import { getCached } from '../services/education/cache';
import { isEducationMatchEnabled } from '../services/education/match'; // ТЗ-103 Задача 6: фичефлаг мэтчинга
import {
  courseTagIds,
  getCalMatchCached,
  matchCoursesToEvent,
  matchEventsToCourse,
} from '../services/education/calendarMatch'; // ТЗ-103 v2 Задача 7
import { getMskDateString, addDays } from '../services/calendar'; // бизнес-дата МСК, как у календаря
import { subscriptionTenureDays } from '../services/education/subscriptionTenure';
import { logIdorBlocked } from '../services/education/access';
import { logUserEvent } from '../services/activityLog';
import { enqueueScan } from '../services/education/virusScan';
import { putBufferQuarantine, signedUrl, StorageError } from '../services/storage/driver';
import { sanitizeLessonHtml } from '../services/education/contentHtml'; // ТЗ-108: description — HTML, санитизируем и на отдаче (legacy-строки)

const JWT_SECRET: string = process.env.JWT_SECRET!;
const router = Router();

function h(fn: (req: AuthRequest, res: Response) => Promise<any>) {
  return (req: Request, res: Response) => {
    fn(req as AuthRequest, res).catch((err: any) => {
      console.error('[Education] handler error:', err?.message || err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  };
}

function fail(res: Response, status: number, message: string): void {
  res.status(status).json({ error: message });
}

// id LMS — uuid (uuid-ossp). Невалидный формат до запроса не пускаем: иначе PG
// бросит «invalid input syntax for type uuid» → 500 вместо честного 404.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

function boolDb(v: any): boolean {
  return v === true || v === 1;
}

/** is_admin пользователя (один запрос на обработчик, только если залогинен). */
async function isAdminUser(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const r = await query(`SELECT is_admin FROM users WHERE id = $1`, [userId]);
  return r.rows.length > 0 && boolDb(r.rows[0].is_admin);
}

interface PublicCourse {
  id: string;
  slug: string;
  title: string;
  type: string;
  size: string;
  price: number;
  badges: string[];
  cover_url: string | null;
  category: { id: string; name: string } | null;
  tags: { id: string; label: string }[];
  lessons_count: number;
  author: string;
  source: { type: string; id: string; title: string | null } | null;
  is_expired: boolean;
  created_at: string;
}

function isExpiredCourse(row: any, now: number): boolean {
  if (row.type === 'situational' && row.source_type !== null && row.source_news_id === null) {
    return true; // источник умер (ON DELETE SET NULL) — актуальности нет (v12)
  }
  if (row.relevant_until) {
    const until = new Date(row.relevant_until).getTime();
    return Number.isFinite(until) && until <= now;
  }
  return false;
}

/** Загрузить теги курсов списком (один запрос на набор id). */
async function loadCourseTags(courseIds: string[]): Promise<Map<string, { id: string; label: string }[]>> {
  const map = new Map<string, { id: string; label: string }[]>();
  if (courseIds.length === 0) return map;
  if (process.env.USE_SQLITE === 'true') {
    const ph = courseIds.map((_, i) => `$${i + 1}`).join(',');
    const rows = await query(
      `SELECT ct.course_id, ct.tag_id, udt.tag_name
       FROM course_tags ct LEFT JOIN user_defined_tags udt ON udt.tag_id = ct.tag_id
       WHERE ct.course_id IN (${ph})`,
      courseIds,
    );
    for (const r of rows.rows) {
      if (!map.has(r.course_id)) map.set(r.course_id, []);
      map.get(r.course_id)!.push({ id: r.tag_id, label: r.tag_name || r.tag_id });
    }
    return map;
  }
  const rows = await query(
    `SELECT ct.course_id, ct.tag_id, udt.tag_name
     FROM course_tags ct LEFT JOIN user_defined_tags udt ON udt.tag_id = ct.tag_id
     WHERE ct.course_id = ANY($1)`,
    [courseIds],
  );
  for (const r of rows.rows) {
    if (!map.has(r.course_id)) map.set(r.course_id, []);
    map.get(r.course_id)!.push({ id: r.tag_id, label: r.tag_name || r.tag_id });
  }
  return map;
}

/** Теги курса по фильтру topic (AND-логика с filter/category). */
async function courseIdsByTopic(topic: string): Promise<Set<string> | null> {
  const rows = await query(
    `SELECT course_id FROM course_tags WHERE tag_id = $1`,
    [topic],
  );
  if (rows.rows.length === 0) return new Set(); // темы нет → пустой результат, НЕ 400
  return new Set(rows.rows.map((r: any) => r.course_id));
}

function toPublicCourse(row: any, tags: { id: string; label: string }[], now: number): PublicCourse {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    type: row.type,
    size: row.size,
    price: Number(row.price),
    badges: parseDbJson<string[]>(row.badges) || [],
    cover_url: row.cover_url,
    category: row.category_id
      ? { id: row.category_id, name: row.category_name }
      : null,
    tags,
    lessons_count: Number(row.lessons_count),
    author: row.author,
    source: row.source_type === 'news' && row.source_news_id
      ? { type: 'news', id: row.source_news_id, title: row.source_title ?? null }
      : null,
    is_expired: isExpiredCourse(row, now),
    created_at: row.created_at,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/education/courses — витрина (ТЗ-100 критерии 3, 16-19)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/courses', optionalAuth, h(async (req, res) => {
  const filter = String(req.query.filter || 'all');
  if (!['all', 'free', 'paid', 'hot', 'mine'].includes(filter)) {
    return fail(res, 400, "filter — только all|free|paid|hot|mine");
  }
  const topic = String(req.query.topic || '').trim();
  const category = String(req.query.category || '').trim();
  const userId = req.user?.userId;

  if (filter === 'mine' && !userId) {
    return fail(res, 401, 'Authentication required'); // «Мои курсы» — только с JWT
  }

  const cacheKey = `catalog:${filter}:${topic}:${category}`;

  const produce = async () => {
    const now = Date.now();
    const params: any[] = [];
    let where: string;

    if (filter === 'mine') {
      // Персональная выборка: visibility НЕ фильтруем (v9 п.3) — свой
      // скрытый курс записанный видит наравне с остальными. deleted — скрыт.
      params.push(userId);
      where = `c.deleted_at IS NULL
               AND c.id IN (SELECT course_id FROM course_enrollments WHERE user_id = $1)`;
    } else {
      // Публичный контур: published + не удалён + НЕ hidden (v9 п.1)
      let priceClause = '';
      if (filter === 'free') priceClause = 'AND c.price = 0';
      if (filter === 'paid') priceClause = 'AND c.price > 0';
      let typeClause = '';
      if (filter === 'hot') {
        // hot: situational с живым источником. Актуальность relevant_until
        // проверяется в JS (is_expired) — строковое сравнение дат в SQLite
        // ненадёжно, а лишние строки полка отсечёт сама.
        typeClause = `AND c.type = 'situational'
          AND NOT (c.source_type IS NOT NULL AND c.source_news_id IS NULL)`;
      }
      params.push(category);
      where = `c.status = 'published' AND c.deleted_at IS NULL AND c.visibility = 'public'
               AND ($1 = '' OR c.category_id = $1)
               ${priceClause} ${typeClause}`;
    }

    const rows = await query(
      `SELECT c.*, cc.name AS category_name,
         (SELECT COUNT(*) FROM course_lessons cl WHERE cl.course_id = c.id) AS lessons_count,
         (SELECT title_ru FROM news n WHERE n.id = c.source_news_id) AS source_title
       FROM courses c
       LEFT JOIN course_categories cc ON cc.id = c.category_id
       WHERE ${where}
       ORDER BY c.created_at DESC
       LIMIT 200`,
      params,
    );

    let list = rows.rows;
    if (topic) {
      const topicIds = await courseIdsByTopic(topic);
      list = list.filter((r: any) => topicIds?.has(r.id));
    }

    const tagMap = await loadCourseTags(list.map((r: any) => r.id));
    const courses = list.map((r: any) =>
      toPublicCourse(r, tagMap.get(r.id) || [], now),
    );

    if (filter === 'mine') {
      return { shelves: { hot: [], recommended: [], fresh: [] }, catalog: courses };
    }

    // Полки: hot — situational (уже отфильтровано для filter=hot),
    // recommended/fresh — ручные бейджи; catalog — остальные.
    const hot: PublicCourse[] = [];
    const recommended: PublicCourse[] = [];
    const fresh: PublicCourse[] = [];
    const inShelf = new Set<string>();
    for (const c of courses) {
      if (c.type === 'situational' && !c.is_expired) {
        if (hot.length < 10) { hot.push(c); inShelf.add(c.id); continue; }
      }
      if (c.badges.includes('recommended')) { recommended.push(c); inShelf.add(c.id); continue; }
      if (c.badges.includes('new')) { fresh.push(c); inShelf.add(c.id); continue; }
    }
    const catalog = courses.filter((c: PublicCourse) => !inShelf.has(c.id));
    return { shelves: { hot, recommended, fresh }, catalog };
  };

  // Кэш ТОЛЬКО безликого каталога; персональное (filter=mine) — без кэша
  const result = filter === 'mine'
    ? await produce()
    : await getCached(cacheKey, produce);

  // Персональное дочисление ПОСЛЕ чтения кэша (не входит в кэш):
  // my_enrollment — есть ли запись пользователя на курс.
  if (userId) {
    const enrollR = await query(
      `SELECT course_id, source FROM course_enrollments WHERE user_id = $1`,
      [userId],
    );
    const enrollMap = new Map(enrollR.rows.map((r: any) => [r.course_id, r.source]));
    const mark = (c: PublicCourse) => ({ ...c, my_enrollment: enrollMap.has(c.id), enrollment_source: enrollMap.get(c.id) ?? null });
    result.shelves.hot = result.shelves.hot.map(mark);
    result.shelves.recommended = result.shelves.recommended.map(mark);
    result.shelves.fresh = result.shelves.fresh.map(mark);
    result.catalog = result.catalog.map(mark);
  }

  res.json(result);
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/education/categories — пилюли витрины (ТЗ-100 v10; анти-энумерация)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/categories', h(async (_req, res) => {
  const result = await getCached('categories', async () => {
    const rows = await query(
      `SELECT cc.id, cc.name, cc.position,
         (SELECT COUNT(*) FROM courses c
           WHERE c.category_id = cc.id AND c.status = 'published'
             AND c.deleted_at IS NULL AND c.visibility = 'public') AS courses_count
       FROM course_categories cc
       ORDER BY cc.position ASC`,
      [],
    );
    // Категории с courses_count = 0 отдаём тоже (админ готовит раздел заранее)
    return rows.rows.map((r: any) => ({
      id: r.id, name: r.name, position: r.position, courses_count: Number(r.courses_count),
    }));
  });
  res.json(result);
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/education/courses/:slug — титульная (ТЗ-100 v4/v9/v13; критерии 9, 16-21)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/courses/:slug', optionalAuth, h(async (req, res) => {
  const slug = req.params.slug;
  const userId = req.user?.userId;

  const courseR = await query(
    `SELECT c.*, cc.name AS category_name,
       (SELECT title_ru FROM news n WHERE n.id = c.source_news_id) AS source_title
     FROM courses c
     LEFT JOIN course_categories cc ON cc.id = c.category_id
     WHERE c.slug = $1`,
    [slug],
  );
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const c = courseR.rows[0];

  if (c.deleted_at) return fail(res, 404, 'Курс не найден'); // soft-deleted невидим нигде

  // Админский preview_token (?preview_token=<JWT>) — единая проверка для
  // draft/archived (статус) и hidden (видимость)
  let previewAdmin = false;
  const previewToken = String(req.query.preview_token || '');
  if (previewToken) {
    try {
      const decoded = jwt.verify(previewToken, JWT_SECRET) as { userId: string };
      previewAdmin = await isAdminUser(decoded.userId);
    } catch {
      previewAdmin = false;
    }
  }

  // draft/archived: только админ через ?preview_token=<JWT> (ТЗ-101 Задача 2)
  if (c.status !== 'published' && !previewAdmin) {
    return fail(res, 404, 'Курс не найден');
  }

  // Скрытый курс (v9): аноним/без enrollment → 404 (не 403 — факт существования
  // секретного курса не подтверждаем). Админ (is_admin или валидный preview_token) — ок.
  const admin = (await isAdminUser(userId)) || previewAdmin;
  const enrollR = userId
    ? await query(
        `SELECT source, created_at FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
        [userId, c.id],
      )
    : { rows: [] as any[] };
  const enrollment = enrollR.rows[0] || null;

  if (c.visibility === 'hidden' && !enrollment && !admin) {
    logIdorBlocked(userId, 'course', c.id);
    return fail(res, 404, 'Курс не найден');
  }

  const lessonsR = await query(
    `SELECT * FROM course_lessons WHERE course_id = $1 ORDER BY position ASC`,
    [c.id],
  );
  // ТЗ-102: публично — ТОЛЬКО approved (pending/rejected UGC не светятся нигде).
  // Редакционные строки после миграции имеют status='approved' по умолчанию.
  const materialsR = await query(
    `SELECT m.*, u.username AS submitted_by_username
     FROM course_materials m LEFT JOIN users u ON u.id = m.submitted_by
     WHERE m.course_id = $1 AND m.status = 'approved'
     ORDER BY m.position ASC`,
    [c.id],
  );

  // Подписка: живость и tenure для drip (v13; критерии 20-21)
  const subscription = userId ? await getUserSubscription(userId) : null;
  const isSubscriptionEnrollment = enrollment?.source === 'subscription';
  const subscriptionAlive = isSubscriptionEnrollment && !!subscription?.active;
  const subscriptionExpired = isSubscriptionEnrollment && !subscription?.active;
  let tenureDays = 0;
  if (isSubscriptionEnrollment && subscription?.active && c.subscription_unlock_mode === 'drip') {
    tenureDays = await subscriptionTenureDays(userId!);
  }

  const program = lessonsR.rows.map((l: any) => {
    let lockedByDrip = false;
    let unlockInDays: number | null = null;
    if (
      c.subscription_unlock_mode === 'drip' &&
      isSubscriptionEnrollment &&
      subscription?.active &&
      Number(l.unlock_after_days) > 0
    ) {
      lockedByDrip = tenureDays < Number(l.unlock_after_days);
      unlockInDays = lockedByDrip ? Number(l.unlock_after_days) - tenureDays : null;
    }
    return {
      id: l.id,
      position: l.position,
      title: l.title,
      kind: l.kind,
      duration_min: l.duration_min,
      is_free_preview: boolDb(l.is_free_preview),
      unlock_after_days: l.unlock_after_days,
      locked_by_drip: lockedByDrip,
      unlock_in_days: unlockInDays,
    };
  });

  // Ближайшая дата открытия (прогноз «урок N откроется ДД.ММ»)
  let nextUnlockDate: string | null = null;
  if (c.subscription_unlock_mode === 'drip' && isSubscriptionEnrollment && subscription?.active) {
    const lockedLessons = program.filter((p: any) => p.locked_by_drip && p.unlock_in_days !== null);
    if (lockedLessons.length > 0) {
      const minDays = Math.min(...lockedLessons.map((p: any) => p.unlock_in_days));
      nextUnlockDate = new Date(Date.now() + minDays * 24 * 60 * 60 * 1000).toISOString();
    }
  }

  // Материалы (v4): записанному — все; гостю — is_free + счётчик закрытых.
  // origin/submitted_by — ТЗ-102: плашка «предложил @username» для UGC-материалов.
  const allMaterials = materialsR.rows.map((m: any) => ({
    id: m.id, kind: m.kind, title: m.title, is_free: boolDb(m.is_free),
    news_id: m.news_id,
    url: m.kind === 'link' || boolDb(m.is_free) ? m.url : null, // file/news — только через download-эндпоинт
    origin: m.origin || 'editorial',
    submitted_by: m.origin === 'user' && m.submitted_by
      ? { id: m.submitted_by, username: m.submitted_by_username || null }
      : null,
  }));
  const hasFullAccess = !!enrollment || admin;
  const materials = hasFullAccess
    ? allMaterials
    : allMaterials.filter((m: any) => m.is_free);
  const lockedMaterialsCount = hasFullAccess
    ? 0
    : allMaterials.filter((m: any) => !m.is_free).length;

  // included_tariffs — только активные планы (v5)
  const activePlans = await getActivePlans();
  const tariffR = await query(
    `SELECT plan_id FROM course_tariffs WHERE course_id = $1`, [c.id],
  );
  const tariffIds = new Set(tariffR.rows.map((r: any) => r.plan_id));
  const includedTariffs = activePlans
    .filter((p: any) => tariffIds.has(p.id))
    // ТЗ-121: сырые price + billing_frequency — фронт показывает цену «₽/мес»
    // только для monthly-тарифов (помесячную конверсию годовых не считаем:
    // ложная цена хуже её отсутствия)
    .map((p: any) => ({ id: p.id, name: p.name, price: Number(p.price), billing_frequency: p.billing_frequency }));

  // Прогресс записанного
  let progress: { completed_lessons: number; total_lessons: number; percent: number } | null = null;
  if (enrollment && userId) {
    const progR = await query(
      `SELECT COUNT(*) AS cnt FROM lesson_progress lp
         JOIN course_lessons cl ON cl.id = lp.lesson_id
        WHERE lp.user_id = $1 AND cl.course_id = $2`,
      [userId, c.id],
    );
    const completed = Number(progR.rows[0].cnt);
    const total = lessonsR.rows.length;
    progress = {
      completed_lessons: completed,
      total_lessons: total,
      percent: total > 0 ? Math.round((completed / total) * 100) : 0,
    };
  }

  const tagsR = await query(
    `SELECT ct.tag_id, udt.tag_name FROM course_tags ct
     LEFT JOIN user_defined_tags udt ON udt.tag_id = ct.tag_id
     WHERE ct.course_id = $1`,
    [c.id],
  );

  const accessViaSubscription = !!(
    subscription?.active &&
    subscription.plan !== 'free' &&
    tariffIds.has(subscription.plan)
  );

  res.json({
    id: c.id,
    slug: c.slug,
    title: c.title,
    description: sanitizeLessonHtml(String(c.description || '')),
    cover_url: c.cover_url,
    type: c.type,
    size: c.size,
    price: Number(c.price),
    badges: parseDbJson<string[]>(c.badges) || [],
    status: c.status,
    visibility: c.visibility,
    author: c.author,
    category: c.category_id ? { id: c.category_id, name: c.category_name } : null,
    tags: tagsR.rows.map((t: any) => ({ id: t.tag_id, label: t.tag_name || t.tag_id })),
    source: c.source_type === 'news' && c.source_news_id
      ? { type: 'news', id: c.source_news_id, title: c.source_title ?? null }
      : null,
    is_expired: isExpiredCourse(c, Date.now()),
    relevant_until: c.relevant_until,
    included_tariffs: includedTariffs,
    subscription_unlock_mode: c.subscription_unlock_mode,
    subscription_expired_for_course: subscriptionExpired,
    access_via_subscription: accessViaSubscription,
    tenure_days: isSubscriptionEnrollment && subscription?.active ? tenureDays : null,
    next_unlock_date: nextUnlockDate,
    my_enrollment: enrollment
      ? { source: enrollment.source, created_at: enrollment.created_at }
      : null,
    progress,
    program,
    materials,
    locked_materials_count: lockedMaterialsCount,
  });
}));


// ═══════════════════════════════════════════════════════════════════════════
// GET /api/education/lessons/:lessonId — контент урока (ТЗ-100 v4/v5/v13;
// критерии 4, 10, 13, 20)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/lessons/:lessonId', optionalAuth, h(async (req, res) => {
  const lessonId = req.params.lessonId;
  const userId = req.user?.userId;
  if (!isUuid(lessonId)) return fail(res, 404, 'Урок не найден');

  const lessonR = await query(
    `SELECT l.*, c.status AS course_status, c.visibility, c.deleted_at,
            c.subscription_unlock_mode, c.type AS course_type, c.slug AS course_slug,
            c.title AS course_title
     FROM course_lessons l JOIN courses c ON c.id = l.course_id
     WHERE l.id = $1`,
    [lessonId],
  );
  if (lessonR.rows.length === 0) return fail(res, 404, 'Урок не найден');
  const lesson = lessonR.rows[0];

  // Soft-deleted курс невидим нигде (включая учеников с enrollment)
  if (lesson.deleted_at) return fail(res, 404, 'Урок не найден');

  const admin = await isAdminUser(userId);
  const enrollR = userId
    ? await query(
        `SELECT source FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
        [userId, lesson.course_id],
      )
    : { rows: [] as any[] };
  const enrollment = enrollR.rows[0] || null;

  // Hidden-курс (v9 п.5): открытые уроки для анонимов НЕ работают → 404.
  // Секретность перекрывает превью; для записанных/админа — обычные правила.
  if (lesson.visibility === 'hidden' && !enrollment && !admin) {
    logIdorBlocked(userId, 'lesson', lessonId);
    return fail(res, 404, 'Урок не найден');
  }

  if (lesson.course_status !== 'published' && !admin) {
    // draft/archived: записанные ученики archived доступ сохраняют (v9/архив),
    // draft — нет. Не-опубликованное для не-админа и не-enrollment → 404.
    if (!(lesson.course_status === 'archived' && enrollment)) {
      logIdorBlocked(userId, 'lesson', lessonId);
      return fail(res, 404, 'Урок не найден');
    }
  }

  // Доступ: enrollment ИЛИ is_free_preview (v4; критерий 10)
  const hasAccess = !!enrollment || admin || boolDb(lesson.is_free_preview);
  if (!hasAccess) {
    if (!userId) return fail(res, 401, 'Authentication required');
    logIdorBlocked(userId, 'lesson', lessonId);
    return fail(res, 403, 'Доступ к уроку закрыт');
  }

  // Подписка: живость для source='subscription' (v5; критерий 13)
  if (enrollment && !admin) {
    if (enrollment.source === 'subscription') {
      const subscription = await getUserSubscription(userId!);
      if (!subscription.active) {
        return fail(res, 403, 'subscription_expired');
      }
      // Дрип (v13; критерий 20): урок открыт при tenure ≥ unlock_after_days
      if (lesson.subscription_unlock_mode === 'drip' && Number(lesson.unlock_after_days) > 0) {
        const tenure = await subscriptionTenureDays(userId!);
        if (tenure < Number(lesson.unlock_after_days)) {
          return res.status(403).json({
            error: 'locked_by_drip',
            reason: 'locked_by_drip',
            unlock_in_days: Number(lesson.unlock_after_days) - tenure,
          });
        }
      }
    }

    // Блокирующий тест предыдущего урока (ТЗ-100 критерий 5): не пройден → 403
    const prevR = await query(
      `SELECT l2.id FROM course_lessons l2
       LEFT JOIN lesson_tests t ON t.lesson_id = l2.id
       WHERE l2.course_id = $1 AND l2.position < $2 AND t.is_blocking = $3
       ORDER BY l2.position DESC LIMIT 1`,
      [lesson.course_id, lesson.position, true],
    );
    if (prevR.rows.length > 0) {
      const prevLessonId = prevR.rows[0].id;
      const testR = await query(
        `SELECT pass_score FROM lesson_tests WHERE lesson_id = $1`,
        [prevLessonId],
      );
      const progR = await query(
        `SELECT test_score FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2`,
        [userId, prevLessonId],
      );
      const passScore = Number(testR.rows[0]?.pass_score ?? 0);
      const score = progR.rows.length > 0 ? progR.rows[0].test_score : null;
      const passed = score !== null && Number(score) >= passScore;
      if (!passed) {
        return res.status(403).json({
          error: 'test_blocked',
          reason: 'test_blocked',
          blocked_by_lesson_id: prevLessonId,
        });
      }
    }
  }

  // Тест БЕЗ correct (критерий 4: вырезаем индексы правильных ответов на бэке)
  const testR = await query(`SELECT * FROM lesson_tests WHERE lesson_id = $1`, [lessonId]);
  const test = testR.rows.length > 0
    ? {
        pass_score: testR.rows[0].pass_score,
        is_blocking: boolDb(testR.rows[0].is_blocking),
        questions: (parseDbJson<any[]>(testR.rows[0].questions) || []).map(
          (q: any) => ({ q: q.q, options: q.options }),
        ),
      }
    : null;

  // Прогресс: записанному — состояние, анониму — null
  let progress: { completed: boolean; test_score: number | null } | null = null;
  if (userId) {
    const progR = await query(
      `SELECT test_score FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2`,
      [userId, lessonId],
    );
    progress = progR.rows.length > 0
      ? { completed: true, test_score: progR.rows[0].test_score ?? null }
      : { completed: false, test_score: null };
  }

  // prev/next по позициям курса
  const neighborsR = await query(
    `SELECT id, position FROM course_lessons WHERE course_id = $1 ORDER BY position ASC`,
    [lesson.course_id],
  );
  const idx = neighborsR.rows.findIndex((r: any) => r.id === lessonId);
  const prevLesson = idx > 0 ? neighborsR.rows[idx - 1] : null;
  const nextLesson = idx >= 0 && idx < neighborsR.rows.length - 1 ? neighborsR.rows[idx + 1] : null;

  res.json({
    id: lesson.id,
    course_id: lesson.course_id,
    course_slug: lesson.course_slug,
    course_title: lesson.course_title,
    position: lesson.position,
    title: lesson.title,
    kind: lesson.kind,
    text_content: sanitizeLessonHtml(String(lesson.text_content || '')), // ТЗ-108 v3: легаси-простой текст → абзацы на отдаче (идемпотентно)
    video_source: lesson.video_source,
    video_embed_url: lesson.video_embed_url,
    duration_min: lesson.duration_min,
    unlock_after_days: lesson.unlock_after_days,
    test,
    progress,
    prev_lesson_id: prevLesson?.id ?? null,
    next_lesson_id: nextLesson?.id ?? null,
  });
}));

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/education/lessons/:lessonId/complete — прогресс (критерии 5, 10)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/lessons/:lessonId/complete', authMiddleware, h(async (req, res) => {
  const lessonId = req.params.lessonId;
  const userId = req.user!.userId;
  if (!isUuid(lessonId)) return fail(res, 404, 'Урок не найден');

  const lessonR = await query(
    `SELECT l.*, c.deleted_at, c.subscription_unlock_mode
     FROM course_lessons l JOIN courses c ON c.id = l.course_id
     WHERE l.id = $1`,
    [lessonId],
  );
  if (lessonR.rows.length === 0 || lessonR.rows[0].deleted_at) {
    return fail(res, 404, 'Урок не найден');
  }
  const lesson = lessonR.rows[0];

  // Enrollment обязателен — даже для открытого урока (v4: прогресс без аккаунта
  // не сохраняем; аноним сюда не доходит — authMiddleware даёт 401 раньше)
  const enrollR = await query(
    `SELECT source FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, lesson.course_id],
  );
  if (enrollR.rows.length === 0) {
    logIdorBlocked(userId, 'lesson_complete', lessonId);
    return fail(res, 403, 'Запишитесь на курс, чтобы отмечать прогресс');
  }
  if (enrollR.rows[0].source === 'subscription') {
    const subscription = await getUserSubscription(userId);
    if (!subscription.active) {
      return fail(res, 403, 'subscription_expired');
    }
    if (lesson.subscription_unlock_mode === 'drip' && Number(lesson.unlock_after_days) > 0) {
      const tenure = await subscriptionTenureDays(userId);
      if (tenure < Number(lesson.unlock_after_days)) {
        return res.status(403).json({
          error: 'locked_by_drip',
          reason: 'locked_by_drip',
          unlock_in_days: Number(lesson.unlock_after_days) - tenure,
        });
      }
    }
  }

  // Тест: score < pass_score → 422 {passed:false} (критерий 5)
  const testR = await query(`SELECT * FROM lesson_tests WHERE lesson_id = $1`, [lessonId]);
  let testScore: number | null = null;
  if (testR.rows.length > 0) {
    testScore = Number(req.body?.test_score);
    if (!Number.isFinite(testScore)) {
      return fail(res, 400, 'test_score обязателен для урока с тестом');
    }
    if (testScore < Number(testR.rows[0].pass_score)) {
      return res.status(422).json({ passed: false });
    }
  }

  // UPSERT lesson_progress (кросс-диалектный: SELECT → UPDATE/INSERT;
  // адаптер SQLite не поддерживает ON CONFLICT DO UPDATE)
  const existing = await query(
    `SELECT 1 FROM lesson_progress WHERE user_id = $1 AND lesson_id = $2`,
    [userId, lessonId],
  );
  if (existing.rows.length > 0) {
    await query(
      `UPDATE lesson_progress SET completed_at = ${nowSqlInline()}, test_score = $1
       WHERE user_id = $2 AND lesson_id = $3`,
      [testScore, userId, lessonId],
    );
  } else {
    await query(
      `INSERT INTO lesson_progress (user_id, lesson_id, completed_at, test_score)
       VALUES ($1, $2, ${nowSqlInline()}, $3)`,
      [userId, lessonId, testScore],
    );
  }
  res.json({ ok: true, passed: true });
}));

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/education/lessons/:lessonId/test — грейдинг ответов теста.
// GET вырезает correct (критерий 4), поэтому подсчёт балла — только на бэке:
// клиент шлёт индексы ответов, бэк сверяет с lesson_tests.questions и возвращает
// score. Прогресс НЕ пишем — это делает POST /complete (там же проверка pass_score).
// ═══════════════════════════════════════════════════════════════════════════
router.post('/lessons/:lessonId/test', authMiddleware, h(async (req, res) => {
  const lessonId = req.params.lessonId;
  const userId = req.user!.userId;
  if (!isUuid(lessonId)) return fail(res, 404, 'Урок не найден');

  const lessonR = await query(
    `SELECT l.*, c.deleted_at, c.subscription_unlock_mode
     FROM course_lessons l JOIN courses c ON c.id = l.course_id
     WHERE l.id = $1`,
    [lessonId],
  );
  if (lessonR.rows.length === 0 || lessonR.rows[0].deleted_at) {
    return fail(res, 404, 'Урок не найден');
  }
  const lesson = lessonR.rows[0];

  const enrollR = await query(
    `SELECT source FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, lesson.course_id],
  );
  if (enrollR.rows.length === 0) {
    logIdorBlocked(userId, 'lesson_test', lessonId);
    return fail(res, 403, 'Запишитесь на курс, чтобы проходить тест');
  }
  if (enrollR.rows[0].source === 'subscription') {
    const subscription = await getUserSubscription(userId);
    if (!subscription.active) {
      return fail(res, 403, 'subscription_expired');
    }
    if (lesson.subscription_unlock_mode === 'drip' && Number(lesson.unlock_after_days) > 0) {
      const tenure = await subscriptionTenureDays(userId);
      if (tenure < Number(lesson.unlock_after_days)) {
        return res.status(403).json({
          error: 'locked_by_drip',
          reason: 'locked_by_drip',
          unlock_in_days: Number(lesson.unlock_after_days) - tenure,
        });
      }
    }
  }

  const testR = await query(`SELECT * FROM lesson_tests WHERE lesson_id = $1`, [lessonId]);
  if (testR.rows.length === 0) return fail(res, 404, 'У урока нет теста');

  const questions = parseDbJson<any[]>(testR.rows[0].questions) || [];
  const answers = req.body?.answers;
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    return fail(res, 400, `answers — массив из ${questions.length} индексов (по одному на вопрос)`);
  }

  let correctCount = 0;
  for (let i = 0; i < questions.length; i++) {
    const right = Number(questions[i]?.correct);
    if (Number.isInteger(right) && Number(answers[i]) === right) correctCount += 1;
  }
  const testScore = questions.length > 0
    ? Math.round((correctCount / questions.length) * 100)
    : 100;
  const passScore = Number(testR.rows[0].pass_score);

  res.json({ test_score: testScore, pass_score: passScore, passed: testScore >= passScore });
}));

function nowSqlInline(): string {
  return process.env.USE_SQLITE === 'true' ? "datetime('now')" : 'NOW()';
}

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/education/my — мои курсы (критерий 6)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/my', authMiddleware, h(async (req, res) => {
  const userId = req.user!.userId;
  const rows = await query(
    `SELECT c.id, c.slug, c.title, c.type, c.size, c.price, c.badges, c.cover_url,
            c.status, c.visibility, ce.source, ce.created_at AS enrolled_at,
       (SELECT COUNT(*) FROM course_lessons cl WHERE cl.course_id = c.id) AS total_lessons,
       (SELECT COUNT(*) FROM lesson_progress lp
          JOIN course_lessons cl ON cl.id = lp.lesson_id
         WHERE lp.user_id = ce.user_id AND cl.course_id = c.id) AS completed_lessons
     FROM course_enrollments ce
     JOIN courses c ON c.id = ce.course_id
     WHERE ce.user_id = $1 AND c.deleted_at IS NULL
     ORDER BY ce.created_at DESC`,
    [userId],
  );
  res.json(rows.rows.map((r: any) => {
    const total = Number(r.total_lessons);
    const completed = Number(r.completed_lessons);
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      type: r.type,
      size: r.size,
      price: Number(r.price),
      badges: parseDbJson<string[]>(r.badges) || [],
      cover_url: r.cover_url,
      status: r.status,
      visibility: r.visibility,
      enrollment_source: r.source,
      enrolled_at: r.enrolled_at,
      progress: {
        completed_lessons: completed,
        total_lessons: total,
        percent: total > 0 ? Math.round((completed / total) * 100) : 0,
      },
    };
  }));
}));

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/education/courses/:slug/enroll — самозапись на курс.
// price=0 → source='free'; price>0 + активная подписка с планом из
// course_tariffs → source='subscription' (ТЗ-106 Задача 1); иначе 409.
// Идемпотентно (UNIQUE(user_id, course_id), ON CONFLICT DO NOTHING).
// hidden-курсы — 404 (анти-энумерация, как в карточке курса).
// ═══════════════════════════════════════════════════════════════════════════
router.post('/courses/:slug/enroll', authMiddleware, h(async (req, res) => {
  const userId = req.user!.userId;
  const courseR = await query(
    `SELECT id, title, price, status, visibility, deleted_at FROM courses WHERE slug = $1`,
    [req.params.slug],
  );
  if (courseR.rows.length === 0 || courseR.rows[0].deleted_at) {
    return fail(res, 404, 'Курс не найден');
  }
  const c = courseR.rows[0];
  if (c.status !== 'published') return fail(res, 404, 'Курс не найден');
  if (c.visibility === 'hidden') return fail(res, 404, 'Курс не найден');

  let source = 'free';
  if (Number(c.price) > 0) {
    // Та же логика, что access_via_subscription в карточке курса:
    // активная подписка (grace — флаг subscription_active) и план в course_tariffs.
    const subscription = await getUserSubscription(userId);
    const tariffR = await query(
      `SELECT plan_id FROM course_tariffs WHERE course_id = $1`, [c.id],
    );
    const tariffIds = new Set(tariffR.rows.map((r: any) => r.plan_id));
    const viaSubscription = !!(
      subscription.active &&
      subscription.plan !== 'free' &&
      tariffIds.has(subscription.plan)
    );
    if (!viaSubscription) {
      return fail(res, 409, 'Платный курс: запись открывается после покупки');
    }
    source = 'subscription';
  }
  await query(
    `INSERT INTO course_enrollments (user_id, course_id, source)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, course_id) DO NOTHING`,
    [userId, c.id, source],
  );
  if (source === 'subscription') {
    logUserEvent(userId, 'education.enroll_subscribed', { course_id: c.id });
  }
  res.json({ enrolled: true, course_id: c.id, source });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/education/courses/:slug/news — «Курс в новостях» (свежие 5)
// ═══════════════════════════════════════════════════════════════════════════
router.get('/courses/:slug/news', h(async (req, res) => {
  const courseR = await query(
    `SELECT id, visibility FROM courses WHERE slug = $1`, [req.params.slug],
  );
  if (courseR.rows.length === 0) return fail(res, 404, 'Курс не найден');
  const course = courseR.rows[0];
  // Скрытый курс: привязки хранятся, но в публичной выдаче не показываются (v9)
  if (course.visibility === 'hidden') return res.json([]);
  const rows = await query(
    `SELECT n.id, n.slug, n.title_ru, n.published_at
     FROM news_course_links l JOIN news n ON n.id = l.news_id
     WHERE l.course_id = $1
     ORDER BY n.published_at DESC
     LIMIT 5`,
    [course.id],
  );
  res.json(rows.rows.map((r: any) => ({
    id: r.id, slug: r.slug, title_ru: r.title_ru, published_at: r.published_at,
  })));
}));

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-103 v2, Задача 7 — календарный мэтчинг (публичные эндпоинты, правила
// по тегам, без LLM/эмбеддингов). Без auth, под разумным rate limit.
// Все три — 404 при выключенном EDUCATION_MATCH_ENABLED (Задача 6/критерий 15).
// Прошедшие события нигде не показываем.
// ═══════════════════════════════════════════════════════════════════════════

/** Теги события: tag_ids — TEXT-JSON (парсинг как в calendar.ts:648). */
function parseEventTagIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
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

// GET /api/education/calendar-today — события сегодня/завтра с ≥1 курсом.
// Кэш in-memory ключ education:calmatch:today:<YYYY-MM-DD> TTL 1 час
// (паттерн heatmapDaily; инвалидация — вместе с invalidateEducationCache).
router.get('/calendar-today', h(async (req, res) => {
  if (!isEducationMatchEnabled()) return fail(res, 404, 'Not found');
  if (!(await checkRateLimit(req, res, lmsCalendarMatchLimiter))) return; // 429 отправлен

  const today = await getMskDateString();
  const tomorrow = addDays(today, 1);
  const cacheKey = `today:${today}`;

  const payload = await getCalMatchCached(cacheKey, async () => {
    console.log(`[EducationCalMatch] calendar-today computed (cache miss, ${today})`);
    const rows = await query(
      `SELECT date, title, kind, status, company, ticker, tag_ids
       FROM calendar_events
       WHERE date IN ($1, $2)
       ORDER BY date ASC, title ASC`,
      [today, tomorrow],
    );
    const events = [];
    for (const r of rows.rows) {
      const matchedCourses = await matchCoursesToEvent(parseEventTagIds(r.tag_ids));
      if (matchedCourses.length === 0) continue; // событие без курсов — пропускаем
      events.push({
        date: String(r.date).slice(0, 10),
        title: r.title,
        kind: r.kind,
        status: r.status,
        company: r.company,
        ticker: r.ticker,
        matched_courses: matchedCourses,
      });
    }
    return { events };
  });
  res.json(payload);
}));

// GET /api/education/for-event?date&title&kind&ticker — курсы для блока на
// странице календаря. Событие адресуется натуральным ключом (id не принимаем —
// нестабилен при пересборке конвейером); событие не найдено → 404.
// ticker опционален: у сгруппированных событий с несколькими компаниями фронт
// может не знать единственный ticker — тогда матчим по date+title+kind (первая
// строка; риск №9 ТЗ-103: лучше пропустить, чем показать нерелевантное).
router.get('/for-event', h(async (req, res) => {
  if (!isEducationMatchEnabled()) return fail(res, 404, 'Not found');
  if (!(await checkRateLimit(req, res, lmsCalendarMatchLimiter))) return; // 429 отправлен

  const date = String(req.query.date || '').trim();
  const title = String(req.query.title || '').trim();
  const kind = String(req.query.kind || '').trim();
  const ticker = String(req.query.ticker || '').trim();
  if (!date || !title || !kind) {
    return fail(res, 400, 'нужны параметры: date, title, kind (ticker опционален)');
  }

  const eventR = ticker
    ? await query(
        `SELECT tag_ids FROM calendar_events
         WHERE date = $1 AND title = $2 AND kind = $3 AND ticker = $4`,
        [date, title, kind, ticker],
      )
    : await query(
        `SELECT tag_ids FROM calendar_events
         WHERE date = $1 AND title = $2 AND kind = $3
         ORDER BY company ASC LIMIT 1`,
        [date, title, kind],
      );
  if (eventR.rows.length === 0) return fail(res, 404, 'Событие не найдено');

  const courses = await matchCoursesToEvent(parseEventTagIds(eventR.rows[0].tag_ids));
  res.json({ courses });
}));

// GET /api/education/courses/:slug/events?days=14 — «Связанные события» на
// странице курса. Окно [сегодня, сегодня+days] по бизнес-дате МСК.
router.get('/courses/:slug/events', h(async (req, res) => {
  if (!isEducationMatchEnabled()) return fail(res, 404, 'Not found');
  if (!(await checkRateLimit(req, res, lmsCalendarMatchLimiter))) return; // 429 отправлен

  const courseR = await query(
    `SELECT id, status, visibility, deleted_at FROM courses WHERE slug = $1`,
    [req.params.slug],
  );
  if (courseR.rows.length === 0 || courseR.rows[0].deleted_at) {
    return fail(res, 404, 'Курс не найден');
  }
  const course = courseR.rows[0];
  if (course.status !== 'published') return fail(res, 404, 'Курс не найден');
  // Скрытый курс: привязки хранятся, но публично не показываются (как news)
  if (course.visibility === 'hidden') return res.json({ events: [] });

  let days = parseInt(String(req.query.days || '14'), 10);
  if (!Number.isInteger(days) || days < 1 || days > 90) days = 14;

  const tags = await courseTagIds(course.id);
  const events = await matchEventsToCourse(tags, days);
  res.json({ events });
}));

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/education/materials/:id/download — 302 на signedUrl (ТЗ-100 v4/v11;
// критерий 11). is_free → без auth + лимит по IP 30/час; иначе auth + enrollment
// ═══════════════════════════════════════════════════════════════════════════
router.get('/materials/:id/download', optionalAuth, h(async (req, res) => {
  const materialId = req.params.id;
  const userId = req.user?.userId;

  const matR = await query(
    `SELECT m.*, c.deleted_at, c.visibility FROM course_materials m
     JOIN courses c ON c.id = m.course_id
     WHERE m.id = $1`,
    [materialId],
  );
  if (matR.rows.length === 0 || matR.rows[0].deleted_at) {
    return fail(res, 404, 'Материал не найден');
  }
  const material = matR.rows[0];

  if (material.kind !== 'file') {
    // Ссылки и новости не скачиваются — материал-ссылка отдаётся в карточке как есть
    return fail(res, 400, 'Скачивание доступно только для файловых материалов');
  }

  // ТЗ-102 v2 (S4): файл UGC-ученика отдаётся ТОЛЬКО после чистого скана —
  // для ВСЕХ, включая модератора (очередь модерации не вектор заражения).
  // Проверка ДО контроля доступа: 423 важнее 401/403.
  if (material.origin === 'user' && material.scan_status !== 'clean') {
    return fail(res, 423, 'Файл на антивирусной проверке. Попробуйте позже.');
  }
  // UGC-материал чист, но ещё не прошёл модерацию — публично не отдаём
  if (material.origin === 'user' && material.status !== 'approved') {
    return fail(res, 403, 'Материал на модерации');
  }

  // Админ (модератор) скачивает любой файл для проверки без enrollment (ТЗ-102)
  const admin = await isAdminUser(userId);
  if (boolDb(material.is_free)) {
    // Открытый материал: без auth и enrollment, rate limit по IP (30/час)
    if (!(await checkRateLimit(req, res, lmsFreeDownloadLimiter))) return; // 429 отправлен
  } else {
    if (!userId) return fail(res, 401, 'Authentication required');
    const enrollR = await query(
      `SELECT 1 FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
      [userId, material.course_id],
    );
    if (enrollR.rows.length === 0 && !admin) {
      logIdorBlocked(userId, 'material_download', materialId);
      return fail(res, 403, 'Доступ к материалу закрыт');
    }
  }

  // 302 на HMAC-signedUrl, TTL 1 час (доступ уже проверен ДО выдачи ссылки)
  const target = signedUrl(String(material.url), 3600);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.redirect(302, target);
}));

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-102: UGC — материалы и новости от учеников с пре-модерацией
// ═══════════════════════════════════════════════════════════════════════════

// UGC-файлы: белый список ТЗ-102, лимит 10 МБ (критерий §3 п.4: 11 МБ → 400).
const UGC_ALLOWED_EXTS = new Set(['pdf', 'xlsx', 'docx', 'png', 'jpg', 'webp']);
const UGC_MAX_BYTES = 10 * 1024 * 1024;

const ugcUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UGC_MAX_BYTES + 1024 }, // запас на multipart-оверхед; точный лимит — ниже
});

/** Обёртка multer для UGC: лимит размера ТЗ трактует как 400 (не 413). */
function ugcUploadMw(req: Request, res: Response, next: () => void): void {
  ugcUpload.single('file')(req, res, (err: any) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return fail(res, 400, 'Файл больше 10 МБ');
      }
      return fail(res, 400, 'Ошибка загрузки файла');
    }
    next();
  });
}

/**
 * Magic bytes UGC-файла (ТЗ-102 v2, S2): определённый file-type ОБЯЗАН
 * соответствовать заявленному расширению (переименованный .exe → .pdf даст
 * ext 'exe' ≠ 'pdf' → 415). Неопределённый тип (plain text и т.п., в т.ч.
 * тестовый EICAR — ASCII-строка) НЕ считается несоответствием: файл уходит
 * в карантин и досматривает ClamAV (критерий §3 п.11).
 */
async function ugcMagicBytesMatch(buf: Buffer, claimedExt: string): Promise<boolean> {
  const ft = await fileType.fromBuffer(buf);
  if (!ft) return true;
  if (!UGC_ALLOWED_EXTS.has(ft.ext)) return false;
  return ft.ext === claimedExt;
}

// POST /api/education/courses/:slug/materials — предложить материал (ТЗ-102).
// Только записанным (403 иначе); link/file → course_materials (status='pending'),
// file сразу в quarantine/ + scan_status='pending_scan' (clamd, virusScan.ts);
// news → news_course_suggestions (UNIQUE(news_id,course_id,submitted_by) → 409).
router.post('/courses/:slug/materials', authMiddleware, ugcUploadMw, h(async (req, res) => {
  const userId = req.user!.userId;

  if (!(await checkRateLimit(req, res, lmsSubmissionLimiter))) return; // 429 отправлен

  const courseR = await query(
    `SELECT id, deleted_at FROM courses WHERE slug = $1`, [req.params.slug],
  );
  if (courseR.rows.length === 0 || courseR.rows[0].deleted_at) {
    return fail(res, 404, 'Курс не найден');
  }
  const courseId = courseR.rows[0].id;

  // Только записанные на курс (гость сюда не доходит — authMiddleware → 401)
  const enrollR = await query(
    `SELECT 1 FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId],
  );
  if (enrollR.rows.length === 0) {
    logIdorBlocked(userId, 'ugc_submit', courseId);
    return fail(res, 403, 'Запишитесь на курс, чтобы предлагать материалы');
  }

  const kind = String(req.body?.kind || '');
  if (!['link', 'file', 'news'].includes(kind)) {
    return fail(res, 400, "kind — только 'link' | 'file' | 'news'");
  }

  // ── kind='news': предложение новости к курсу ────────────────────────────
  if (kind === 'news') {
    const newsId = String(req.body?.news_id || '');
    if (!newsId) return fail(res, 400, 'для kind=news нужен news_id');
    const newsR = await query(`SELECT id FROM news WHERE id = $1`, [newsId]);
    if (newsR.rows.length === 0) return fail(res, 404, 'Новость не найдена');
    const dupR = await query(
      `SELECT 1 FROM news_course_suggestions
        WHERE news_id = $1 AND course_id = $2 AND submitted_by = $3`,
      [newsId, courseId, userId],
    );
    if (dupR.rows.length > 0) {
      return fail(res, 409, 'Вы уже предлагали эту новость к этому курсу');
    }
    const id = crypto.randomUUID();
    try {
      await query(
        `INSERT INTO news_course_suggestions (id, news_id, course_id, submitted_by, created_at)
         VALUES ($1, $2, $3, $4, ${nowSqlInline()})`,
        [id, newsId, courseId, userId],
      );
    } catch (err: any) {
      // UNIQUE(news_id, course_id, submitted_by) на гонке — та же 409
      if (String(err?.message || '').includes('UNIQUE') || err?.code === '23505') {
        return fail(res, 409, 'Вы уже предлагали эту новость к этому курсу');
      }
      throw err;
    }
    return res.status(201).json({ status: 'pending', id });
  }

  const title = String(req.body?.title || '').trim();
  if (!title || title.length > 255) {
    return fail(res, 400, 'title — непустая строка до 255 символов');
  }

  // ── kind='link': только http(s); javascript:/data: → 400 ────────────────
  if (kind === 'link') {
    const url = String(req.body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return fail(res, 400, "url для kind='link' — http(s) ссылка");
    }
    const maxPos = await query(
      `SELECT COALESCE(MAX(position), 0) AS mp FROM course_materials WHERE course_id = $1`,
      [courseId],
    );
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO course_materials
         (id, course_id, kind, title, url, news_id, is_free, position,
          origin, status, submitted_by, scan_status, created_at)
       VALUES ($1, $2, 'link', $3, $4, NULL, 0, $5, 'user', 'pending', $6, 'clean', ${nowSqlInline()})`,
      [id, courseId, title, url, Number(maxPos.rows[0].mp) + 1, userId],
    );
    return res.status(201).json({ status: 'pending', id });
  }

  // ── kind='file': multipart (field: file), quarantine + pending_scan ─────
  const file = (req as any).file as Express.Multer.File | undefined;
  if (!file || !file.buffer || file.buffer.length === 0) {
    return fail(res, 400, 'Файл не загружен (field: file)');
  }
  if (file.buffer.length > UGC_MAX_BYTES) {
    return fail(res, 400, 'Файл больше 10 МБ');
  }
  const claimedExt = (file.originalname || '').split('.').pop()?.toLowerCase() || '';
  if (!UGC_ALLOWED_EXTS.has(claimedExt)) {
    return fail(res, 400, 'Допустимые типы: pdf, xlsx, docx, png, jpg, webp');
  }
  if (!(await ugcMagicBytesMatch(file.buffer, claimedExt))) {
    return fail(res, 415, 'Тип файла не соответствует расширению (проверка по содержимому)');
  }
  let put;
  try {
    // S4: сразу в карантин — до чистого скана файл вне отдаваемых каталогов
    put = await putBufferQuarantine(file.buffer, file.originalname || `material.${claimedExt}`);
  } catch (err: any) {
    if (err instanceof StorageError) return fail(res, err.status, err.message);
    throw err;
  }
  const maxPos = await query(
    `SELECT COALESCE(MAX(position), 0) AS mp FROM course_materials WHERE course_id = $1`,
    [courseId],
  );
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO course_materials
       (id, course_id, kind, title, url, news_id, is_free, position,
        origin, status, submitted_by, scan_status, created_at)
     VALUES ($1, $2, 'file', $3, $4, NULL, 0, $5, 'user', 'pending', $6, 'pending_scan', ${nowSqlInline()})`,
    [id, courseId, title, put.relPath, Number(maxPos.rows[0].mp) + 1, userId],
  );
  // Асинхронный скан (fire-and-forget): clamd недоступен → останется
  // pending_scan, sweeper/модераторский retry догонят (virusScan.ts).
  enqueueScan(id);
  return res.status(201).json({ status: 'pending', id, scan_status: 'pending_scan' });
}));

// GET /api/education/my/submissions — мои предложения по всем курсам (ТЗ-102):
// материалы и новости со статусом и reject_reason (видит только сам ученик).
router.get('/my/submissions', authMiddleware, h(async (req, res) => {
  const userId = req.user!.userId;
  const [matR, newsR] = await Promise.all([
    query(
      `SELECT m.id, m.kind, m.title, m.status, m.reject_reason, m.scan_status, m.created_at,
              c.id AS course_id, c.slug AS course_slug, c.title AS course_title
       FROM course_materials m JOIN courses c ON c.id = m.course_id
       WHERE m.submitted_by = $1
       ORDER BY m.created_at DESC`,
      [userId],
    ),
    query(
      `SELECT s.id, s.status, s.reject_reason, s.created_at,
              n.id AS news_id, n.slug AS news_slug, n.title_ru AS news_title,
              c.id AS course_id, c.slug AS course_slug, c.title AS course_title
       FROM news_course_suggestions s
       JOIN news n ON n.id = s.news_id
       JOIN courses c ON c.id = s.course_id
       WHERE s.submitted_by = $1
       ORDER BY s.created_at DESC`,
      [userId],
    ),
  ]);
  const submissions = [
    ...matR.rows.map((m: any) => ({
      type: 'material',
      id: m.id,
      kind: m.kind,
      title: m.title,
      status: m.status,
      reject_reason: m.reject_reason,
      scan_status: m.scan_status,
      course: { id: m.course_id, slug: m.course_slug, title: m.course_title },
      created_at: m.created_at,
    })),
    ...newsR.rows.map((s: any) => ({
      type: 'news',
      id: s.id,
      kind: 'news',
      title: s.news_title,
      status: s.status,
      reject_reason: s.reject_reason,
      scan_status: 'clean',
      news: { id: s.news_id, slug: s.news_slug, title_ru: s.news_title },
      course: { id: s.course_id, slug: s.course_slug, title: s.course_title },
      created_at: s.created_at,
    })),
  ];
  // Единая лента по дате (свежие первыми); NULL-даты (старые SQLite-строки) — в конец
  submissions.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  res.json({ submissions });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-100 v8 (Задача 6) — шеринг инвестиционного пути.
// Один активный шеринг на юзера: POST перевыпускает токен (старый мёртв
// сразу), DELETE отзывает. GET /shared/:token — публичная страница пути:
// только username, агрегированные статы и опубликованные публичные курсы.
// email/user_id/source/даты НЕ отдаём (приватность по ТЗ).
// ═══════════════════════════════════════════════════════════════════════════

const EDU_FRONTEND_URL = (process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru').replace(/\/+$/, '');

function pathShareUrl(token: string): string {
  return `${EDU_FRONTEND_URL}/education/path/${token}`;
}

// GET /api/education/my/path-share — моя активная ссылка
router.get('/my/path-share', authMiddleware, h(async (req, res) => {
  const userId = req.user!.userId;
  const r = await query(`SELECT token FROM user_path_shares WHERE user_id = $1`, [userId]);
  if (r.rows.length === 0) return res.json({ token: null, url: null });
  const token = r.rows[0].token;
  res.json({ token, url: pathShareUrl(token) });
}));

// POST /api/education/my/path-share — создать/перевыпустить токен
router.post('/my/path-share', authMiddleware, h(async (req, res) => {
  const userId = req.user!.userId;
  const token = crypto.randomBytes(24).toString('base64url');
  await query(`DELETE FROM user_path_shares WHERE user_id = $1`, [userId]);
  await query(
    `INSERT INTO user_path_shares (user_id, token) VALUES ($1, $2)`,
    [userId, token],
  );
  res.json({ token, url: pathShareUrl(token) });
}));

// DELETE /api/education/my/path-share — отозвать ссылку
router.delete('/my/path-share', authMiddleware, h(async (req, res) => {
  await query(`DELETE FROM user_path_shares WHERE user_id = $1`, [req.user!.userId]);
  res.status(204).end();
}));

// GET /api/education/shared/:token — публичная страница пути (без auth)
router.get('/shared/:token', h(async (req, res) => {
  const shareR = await query(
    `SELECT s.user_id, u.username, u.is_blocked
     FROM user_path_shares s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [req.params.token],
  );
  // Токена нет или владелец заблокирован — одинаковый 404 (без утечки факта блокировки)
  if (shareR.rows.length === 0) return fail(res, 404, 'Ссылка не найдена');
  const owner = shareR.rows[0];
  if (owner.is_blocked === true || owner.is_blocked === 1) return fail(res, 404, 'Ссылка не найдена');

  const rows = await query(
    `SELECT c.slug, c.title, c.type, c.size, c.cover_url,
       (SELECT COUNT(*) FROM course_lessons cl WHERE cl.course_id = c.id) AS total_lessons,
       (SELECT COUNT(*) FROM lesson_progress lp
          JOIN course_lessons cl ON cl.id = lp.lesson_id
         WHERE lp.user_id = $1 AND lp.completed_at IS NOT NULL AND cl.course_id = c.id) AS completed_lessons
     FROM course_enrollments ce
     JOIN courses c ON c.id = ce.course_id
     WHERE ce.user_id = $1 AND c.deleted_at IS NULL
       AND c.status = 'published' AND c.visibility = 'public'
     ORDER BY ce.created_at ASC`,
    [owner.user_id],
  );
  const items = rows.rows.map((r: any) => {
    const total = Number(r.total_lessons);
    const completed = Number(r.completed_lessons);
    return {
      slug: r.slug,
      title: r.title,
      type: r.type,
      size: r.size,
      cover_url: r.cover_url,
      progress_percent: total > 0 ? Math.round((completed / total) * 100) : 0,
      completed: total > 0 && completed >= total,
    };
  });

  const statsR = await query(
    `SELECT COUNT(DISTINCT ce.course_id) AS courses,
            COUNT(lp.lesson_id) AS lessons_done,
            COALESCE(SUM(CASE WHEN lp.lesson_id IS NOT NULL THEN cl.duration_min ELSE 0 END), 0) AS minutes
     FROM course_enrollments ce
     JOIN courses c ON c.id = ce.course_id
     LEFT JOIN course_lessons cl ON cl.course_id = c.id
     LEFT JOIN lesson_progress lp
       ON lp.lesson_id = cl.id AND lp.user_id = ce.user_id AND lp.completed_at IS NOT NULL
     WHERE ce.user_id = $1 AND c.deleted_at IS NULL
       AND c.status = 'published' AND c.visibility = 'public'`,
    [owner.user_id],
  );
  const s = statsR.rows[0] || {};
  res.json({
    owner: { username: owner.username },
    stats: {
      courses: Number(s.courses || 0),
      lessons_done: Number(s.lessons_done || 0),
      minutes: Number(s.minutes || 0),
    },
    items,
  });
}));

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-100 v14 (Задача 5) — покупка платного курса через ЮKassa.
// Платёж с product_type='course': plan_id=NULL, billing_cycle='once'.
// Двойной клик = два pending-платежа — активацией владеет
// activatePaymentIfNeeded (ON CONFLICT в enrollment страхует гонку).
// Промокоды на курсы не распространяются (400, как в ТЗ).
// ═══════════════════════════════════════════════════════════════════════════
router.post('/courses/:slug/buy', authMiddleware, h(async (req, res) => {
  const userId = req.user!.userId;
  if ((req.body as any)?.promoCode) {
    return fail(res, 400, 'Промокоды не применяются к покупке курсов');
  }
  const courseR = await query(
    `SELECT id, title, price, status, visibility, deleted_at FROM courses WHERE slug = $1`,
    [req.params.slug],
  );
  if (courseR.rows.length === 0 || courseR.rows[0].deleted_at) {
    return fail(res, 404, 'Курс не найден');
  }
  const c = courseR.rows[0];
  if (c.status !== 'published' || c.visibility === 'hidden') {
    return fail(res, 404, 'Курс не найден');
  }
  const price = Number(c.price);
  if (!(price > 0)) {
    return fail(res, 400, 'Курс бесплатный — используйте запись на курс');
  }
  const enrollR = await query(
    `SELECT 1 FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, c.id],
  );
  if (enrollR.rows.length > 0) return fail(res, 409, 'Вы уже записаны на этот курс');

  const paymentId = crypto.randomUUID();
  await query(
    `INSERT INTO payments (id, user_id, amount, base_amount, discount, method, status,
                           plan_id, billing_cycle, duration_days, is_upgrade,
                           product_type, product_ref)
     VALUES ($1, $2, $3, $3, 0, 'bank_card', 'pending',
             NULL, 'once', NULL, 0,
             'course', $4)`,
    [paymentId, userId, price, c.id],
  );

  const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
  const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';

  // DEMO режим (как в payment.ts): без ключей — «оплата» через demo-страницу
  if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) {
    return res.json({
      payment: { id: paymentId, amount: price, status: 'pending' },
      demo: true,
      confirmation_url: `${EDU_FRONTEND_URL}/payment/return?demo=1&payment_id=${paymentId}&return=1`,
    });
  }

  const userEmail = req.user!.email || '';
  const yookassaPayload: any = {
    amount: { value: price.toFixed(2), currency: 'RUB' },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: `${EDU_FRONTEND_URL}/education/${req.params.slug}?payment_id=${paymentId}&paid=1`,
    },
    description: `PULSE курс «${c.title}» — ${userEmail}`.slice(0, 128),
    save_payment_method: false,
    merchant_customer_id: userId,
    metadata: { payment_id: paymentId, user_id: userId, product: 'course', course_id: c.id },
    receipt: {
      customer: { email: userEmail },
      items: [{
        description: `Курс PULSE «${c.title}»`.slice(0, 128),
        quantity: '1.00',
        amount: { value: price.toFixed(2), currency: 'RUB' },
        vat_code: 1,
        payment_subject: 'service',
        payment_mode: 'full_payment',
      }],
    },
  };

  try {
    const yookassaRes = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      yookassaPayload,
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64'),
          'Idempotence-Key': crypto.randomUUID(),
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      },
    );
    await query(
      `UPDATE payments SET provider_ref = $1 WHERE id = $2`,
      [yookassaRes.data.id, paymentId],
    );
    res.json({
      payment: { id: paymentId, amount: price, status: 'pending' },
      confirmation_url: yookassaRes.data.confirmation?.confirmation_url,
    });
  } catch (err: any) {
    console.error('[Education] Buy failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Payment creation failed',
      details: err.response?.data?.description || err.message,
    });
  }
}));

export default router;
