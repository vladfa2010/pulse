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

import { query } from '../config/db';
import { AuthRequest, authMiddleware } from '../middleware/auth';
import { optionalAuth } from '../middleware/optionalAuth';
import { checkRateLimit, lmsFreeDownloadLimiter } from '../middleware/rateLimit';
import { getActivePlans, getUserSubscription, parseDbJson } from '../services/subscription';
import { getCached } from '../services/education/cache';
import { subscriptionTenureDays } from '../services/education/subscriptionTenure';
import { logIdorBlocked } from '../services/education/access';
import { signedUrl } from '../services/storage/driver';

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
  const materialsR = await query(
    `SELECT * FROM course_materials WHERE course_id = $1 ORDER BY position ASC`,
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

  // Материалы (v4): записанному — все; гостю — is_free + счётчик закрытых
  const allMaterials = materialsR.rows.map((m: any) => ({
    id: m.id, kind: m.kind, title: m.title, is_free: boolDb(m.is_free),
    news_id: m.news_id,
    url: m.kind === 'link' || boolDb(m.is_free) ? m.url : null, // file/news — только через download-эндпоинт
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
    .map((p: any) => ({ id: p.id, name: p.name }));

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
    description: c.description,
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
    text_content: lesson.text_content,
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

  if (boolDb(material.is_free)) {
    // Открытый материал: без auth и enrollment, rate limit по IP (30/час)
    if (!(await checkRateLimit(req, res, lmsFreeDownloadLimiter))) return; // 429 отправлен
  } else {
    if (!userId) return fail(res, 401, 'Authentication required');
    const enrollR = await query(
      `SELECT 1 FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
      [userId, material.course_id],
    );
    if (enrollR.rows.length === 0) {
      logIdorBlocked(userId, 'material_download', materialId);
      return fail(res, 403, 'Доступ к материалу закрыт');
    }
  }

  // 302 на HMAC-signedUrl, TTL 1 час (доступ уже проверен ДО выдачи ссылки)
  const target = signedUrl(String(material.url), 3600);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.redirect(302, target);
}));

export default router;
