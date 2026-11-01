/**
 * =============================================================================
 * PULSE — Поиск: раздел «Курсы по теме» (ТЗ-214, конфиг)
 * =============================================================================
 *
 * Фичефлаг — безопасный откат раздела без редеплоя логики: false → бэкенд
 * не выполняет SQL к courses и не отдаёт поле courses в ответе /api/news/search.
 */

export const SEARCH_COURSES_ENABLED = process.env.SEARCH_COURSES_ENABLED !== 'false';

// ТЗ-215: раздел «Уроки по теме» — тот же паттерн отката, что у курсов выше.
export const SEARCH_LESSONS_ENABLED = process.env.SEARCH_LESSONS_ENABLED !== 'false';
