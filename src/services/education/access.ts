/**
 * =============================================================================
 * PULSE — LMS: централизованный контроль доступа к контенту курсов
 * =============================================================================
 *
 * ТЗ-100 v11 (S5): assertCourseAccess() — ЕДИНСТВЕННАЯ точка проверки доступа
 * к контенту курса. ВСЕ обработчики уроков, материалов, download и preview
 * обязаны идти через неё — ad-hoc проверки по коду запрещены (регрессия
 * безопасности, чеклист код-ревью).
 *
 * Уровни доступа:
 *   'guest'   — аноним (или пользователь без прав на этот контент).
 *               Вызывающий код отвечает 401 (нет JWT) / 403 (есть JWT).
 *   'free'    — курс опубликован и бесплатен: уроки/материалы доступны
 *               любому авторизованному пользователю (после /enroll уровень
 *               станет 'enrolled'; до него — 'free').
 *   'enrolled'— есть запись (course_enrollments) на курс.
 *   'admin'   — пользователь с флагом is_admin (видит всё, включая draft).
 *
 * Замечание по полноте правил (ТЗ-100 v5/v13): проверки живости подписки
 * для enrollment source='subscription' и дрип-по-tenure добавляются поверх
 * этой функции в задачах 2/4/5 (контракт уровней здесь не меняется).
 *
 * Каждая отклонённая попытка доступа к чужому/закрытому ресурсу логируется:
 * `IDOR blocked { userId, resource, resourceId }` — основа алертинга на перебор.
 */

import { query } from '../../config/db';

export type CourseAccessLevel = 'guest' | 'free' | 'enrolled' | 'admin';

/**
 * Проверить доступ пользователя к контенту курса.
 * userId === undefined — аноним. courseId — UUID курса.
 *
 * Порядок проверок: admin → enrolled → published+free → guest.
 * deleted_at IS NULL всегда: soft-deleted курс невидим нигде (кроме admin,
 * который работает через preview_token на уровне выше, ТЗ-101).
 */
export async function assertCourseAccess(
  userId: string | undefined,
  courseId: string,
): Promise<CourseAccessLevel> {
  if (!userId) return 'guest';

  const user = await query(
    `SELECT is_admin FROM users WHERE id = $1`,
    [userId],
  );
  if (user.rows.length === 0) return 'guest';
  if (user.rows[0].is_admin) return 'admin';

  const enrollment = await query(
    `SELECT id FROM course_enrollments WHERE user_id = $1 AND course_id = $2`,
    [userId, courseId],
  );
  if (enrollment.rows.length > 0) return 'enrolled';

  const course = await query(
    `SELECT price, status, deleted_at FROM courses WHERE id = $1`,
    [courseId],
  );
  if (
    course.rows.length > 0 &&
    course.rows[0].deleted_at == null &&
    course.rows[0].status === 'published' &&
    Number(course.rows[0].price) === 0
  ) {
    return 'free';
  }

  return 'guest';
}

/**
 * Логирование отклонённого доступа (S5). Основа алертинга на перебор IDOR.
 * Вызывается вызывающим кодом при отказе — НЕ внутри assertCourseAccess
 * (функция отвечает только уровнем, решение о 401/403/404 принимает роут).
 */
export function logIdorBlocked(
  userId: string | undefined,
  resource: string,
  resourceId: string,
): void {
  console.warn(`IDOR blocked ${JSON.stringify({ userId: userId ?? null, resource, resourceId })}`);
}

export default { assertCourseAccess, logIdorBlocked };
