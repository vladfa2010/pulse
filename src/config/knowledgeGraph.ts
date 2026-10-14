/**
 * =============================================================================
 * PULSE — LMS «Образование»: граф знаний, конфиг (ТЗ-107 v3, Задача 2 п.4-5)
 * =============================================================================
 *
 * Пороги — стартовые (ТЗ-107 v3 §6): после недели на проде владелец смотрит
 * выдачу recommendations и крутит значения через env, код не трогаем.
 */

/** Смысловое ребро урок↔урок МЕЖДУ курсами: топ-N на урок, минимум sim */
export const KG_LESSON_CROSS_TOP = parseInt(process.env.KG_LESSON_CROSS_TOP || '5', 10);
export const KG_LESSON_CROSS_MIN_SIM = parseFloat(process.env.KG_LESSON_CROSS_MIN_SIM || '0.55');

/** Смысловое ребро урок↔урок ВНУТРИ курса: топ-N на урок, минимум sim */
export const KG_LESSON_INTRA_TOP = parseInt(process.env.KG_LESSON_INTRA_TOP || '3', 10);
export const KG_LESSON_INTRA_MIN_SIM = parseFloat(process.env.KG_LESSON_INTRA_MIN_SIM || '0.60');

/** Пары курсов с итоговым sim ниже порога не пишем в course_similarity */
export const KG_COURSE_MIN_SIM = parseFloat(process.env.KG_COURSE_MIN_SIM || '0.45');

/** Сколько топ cross-пар уроков усредняем в course_similarity (Задача 2 п.5) */
export const KG_COURSE_TOP_PAIRS = parseInt(process.env.KG_COURSE_TOP_PAIRS || '10', 10);

/** Фичефлаг (ТЗ-107 v3): выключен — джоба no-op, оба API-эндпоинта 404 */
export function isEducationGraphEnabled(): boolean {
  return process.env.EDUCATION_GRAPH_ENABLED === 'true';
}
