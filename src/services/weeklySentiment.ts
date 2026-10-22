/**
 * =============================================================================
 * PULSE — Накопительное настроение новостей недельного графика (ТЗ-194)
 * =============================================================================
 *
 * Чистая функция агрегации поля sentiment (positive/negative/neutral, уже
 * считается на ingest) в ступенчатую серию для третьего слоя графика
 * «{TICKER} · M5 · 7 дней». Источник — те же события тега, что news_markers
 * (live и архив считаются одним кодом). Подпись в UI — «настроение новостей»,
 * не «сигнал»/«прогноз».
 *
 * Модель — накопительная дельта, без параметров (решение владельца
 * 2026-10-22; замещает бакеты 4 ч + окно 12 ч ПРАВКА-2 v1):
 *   - события сортируются по published_at; позитив +1, негатив −1, нейтрал
 *     пропускается (ступень без сдвига — в серию точка не пишется);
 *   - значение точки — баланс ПОСЛЕ этой новости; старт периода = 0
 *     (кривая по определению ступенчатая: между событиями горизонталь);
 *   - конец кривой = positive − negative тега за окно — совпадает со
 *     сводкой отчёта (кросс-проверка зафиксирована тестом);
 *   - деградация: < SENTIMENT_MIN_NEWS ненейтральных новостей за окно → null —
 *     фронт скрывает панель целиком (цена и объём работают).
 *
 * Форма точки: { t, cum, news_id } — news_id для клика/якоря к ленте тега;
 * у старых снапшотов id новостей не сохранялся → null (клик фолбечится).
 */

export interface WeeklySentimentEvent {
  published_at: string;
  sentiment: string;
  /** id новости (строка) — для якоря к ленте; старые снапшоты: null */
  news_id?: string | null;
}

export interface SentimentPoint {
  /** published_at новости, ISO UTC */
  t: string;
  /** значение кривой ПОСЛЕ этой новости */
  cum: number;
  news_id: string | null;
}

/** Деградация панели: меньше ненейтральных новостей за окно → sentiment: null */
export const SENTIMENT_MIN_NEWS = 2;

/**
 * Ступенчатая серия по окну недели. weekEndUtc не передан (архив) — окно ровно
 * 7 дней от weekStartUtc; live передаёт now. События вне окна отбрасываются.
 * Нейтральные не создают точек; точек при деградации нет (null).
 */
export function buildSentimentSeries(
  events: WeeklySentimentEvent[],
  weekStartUtc: Date,
  weekEndUtc?: Date,
): SentimentPoint[] | null {
  const t0 = weekStartUtc.getTime();
  const t1 = weekEndUtc ? weekEndUtc.getTime() : t0 + 7 * 24 * 60 * 60 * 1000;

  const scored: { ms: number; idx: number; delta: number; news_id: string | null; published_at: string }[] = [];
  events.forEach((e, idx) => {
    const ms = new Date(e.published_at).getTime();
    if (Number.isNaN(ms) || ms < t0 || ms >= t1) return;
    const delta = e.sentiment === 'positive' ? 1 : e.sentiment === 'negative' ? -1 : 0;
    if (delta === 0) return;
    scored.push({ ms, idx, delta, news_id: e.news_id ?? null, published_at: e.published_at });
  });

  if (scored.length < SENTIMENT_MIN_NEWS) return null;

  // строгий порядок публикации; при равных published_at — исходный порядок
  scored.sort((a, b) => (a.ms - b.ms) || (a.idx - b.idx));

  let cum = 0;
  return scored.map((s) => {
    cum += s.delta;
    return { t: new Date(s.ms).toISOString(), cum, news_id: s.news_id };
  });
}
