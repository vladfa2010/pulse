/**
 * =============================================================================
 * PULSE — Материалы к новости: уроки и курсы по смыслу (ТЗ-229, конфиг)
 * =============================================================================
 *
 * Фичефлаг — безопасный откат без редеплоя: false → эндпоинты
 * /api/news/:id/materials и /api/news/materials-lookup отдают 404 / {},
 * фронт не показывает ни блок в новости, ни чип в ленте.
 *
 * Пороги — env с дефолтами. Курс data-backed (ТЗ-177: типичный косинус
 * релевантной пары 0.6–0.75). Порог урока НЕ проверен (одна спот-пара
 * ТЗ-107: 0.2791) — калибруется пробой scripts/probe_tz229.js ДО включения
 * флага на проде (Задача 4 ТЗ-229); прецедент подстройки без редеплоя — ТЗ-215.
 */

export const NEWS_MATERIALS_ENABLED = process.env.NEWS_MATERIALS_ENABLED === 'true'; // дефолт OFF

// Не проверено — калибровка пробой (Задача 4 ТЗ-229) до включения флага.
export const NEWS_MATERIALS_LESSON_MIN_SIM = parseFloat(process.env.NEWS_MATERIALS_LESSON_MIN_SIM || '0.25');

// ТЗ-177: типичный косинус релевантной пары 0.6–0.75.
export const NEWS_MATERIALS_COURSE_MIN_SIM = parseFloat(process.env.NEWS_MATERIALS_COURSE_MIN_SIM || '0.60');

export const NEWS_MATERIALS_LESSON_TOP = parseInt(process.env.NEWS_MATERIALS_LESSON_TOP || '4', 10); // как ТЗ-215
export const NEWS_MATERIALS_COURSE_TOP = parseInt(process.env.NEWS_MATERIALS_COURSE_TOP || '6', 10); // как ТЗ-214
