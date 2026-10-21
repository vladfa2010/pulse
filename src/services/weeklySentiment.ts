/**
 * =============================================================================
 * PULSE — Новостной фон (сантимент) недельного графика (ПРАВКА-2 к ТЗ-191)
 * =============================================================================
 *
 * Чистая функция агрегации поля sentiment (positive/negative/neutral, уже
 * считается на ingest) в серию для третьего слоя графика «{TICKER} · M5 ·
 * 7 дней». Источник — те же события тега, что news_markers (live и архив
 * считаются одним кодом). Подпись в UI — «новостной фон», не «сигнал».
 *
 * Расчёт:
 *   - бакеты 4 ч по окну недели [weekStartUtc, weekEndUtc) (~42 шт.),
 *     якорь — понедельник 00:00 МСК (UTC-инстанс), границы детерминированы;
 *   - score бакета = (pos − neg) / всего → [-1, +1]; знак и шкала — как у
 *     «Индекса настроения» (/sentiment, голоса -1/0/1): один язык сантимента;
 *   - сглаживание скользящим окном 12 ч = 3 бакета, TRAILING (значение в
 *     точке t — среднее за [t−12ч, t]): фон читается трендом, а не спайками.
 *     Пустые бакеты в среднее НЕ входят (иначе ночные провалы размывали бы
 *     реальный фон); у пустого окна фон 0 (нейтрально);
 *   - деградация: < SENTIMENT_MIN_NEWS новостей за окно → null — фронт
 *     скрывает панель целиком (конвенция {chart: null}).
 */

export interface WeeklySentimentEvent {
  published_at: string;
  sentiment: string;
}

export interface SentimentPoint {
  /** начало бакета, ISO UTC */
  t: string;
  /** сглаженный баланс [-1, +1], 0 — нейтрально/нет новостей в окне */
  score: number;
}

export const SENTIMENT_BUCKET_MS = 4 * 60 * 60 * 1000;
/** Окно сглаживания 12 ч = 3 бакета по 4 ч */
export const SENTIMENT_SMOOTH_BUCKETS = 3;
/** Деградация панели: меньше новостей за окно → sentiment: null */
export const SENTIMENT_MIN_NEWS = 10;

/** 3 знака после точки — больше на графике не читается */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/**
 * Серия бакетов по окну недели. weekEndUtc не передан (архив) — окно ровно
 * 7 дней от weekStartUtc; live передаёт now. События вне окна отбрасываются.
 */
export function buildSentimentSeries(
  events: WeeklySentimentEvent[],
  weekStartUtc: Date,
  weekEndUtc?: Date,
): SentimentPoint[] | null {
  const t0 = weekStartUtc.getTime();
  const t1 = weekEndUtc ? weekEndUtc.getTime() : t0 + 7 * 24 * 60 * 60 * 1000;
  const bucketCount = Math.max(1, Math.ceil((t1 - t0) / SENTIMENT_BUCKET_MS));

  const pos = new Array<number>(bucketCount).fill(0);
  const neg = new Array<number>(bucketCount).fill(0);
  const total = new Array<number>(bucketCount).fill(0);
  let inWindow = 0;

  for (const e of events) {
    const ms = new Date(e.published_at).getTime();
    if (Number.isNaN(ms) || ms < t0 || ms >= t1) continue;
    const b = Math.min(bucketCount - 1, Math.floor((ms - t0) / SENTIMENT_BUCKET_MS));
    total[b] += 1;
    inWindow += 1;
    if (e.sentiment === 'positive') pos[b] += 1;
    else if (e.sentiment === 'negative') neg[b] += 1;
  }

  if (inWindow < SENTIMENT_MIN_NEWS) return null;

  // Сырой баланс бакета; пустой бакет — null (не входит в окно сглаживания)
  const raw: (number | null)[] = total.map((n, b) =>
    n > 0 ? (pos[b] - neg[b]) / n : null,
  );

  // Trailing-окно 12 ч: среднее по НЕПУСТЫМ бакетам [b−2, b]; нет ни одного → 0
  return raw.map((_, b) => {
    let sum = 0;
    let cnt = 0;
    for (let k = Math.max(0, b - SENTIMENT_SMOOTH_BUCKETS + 1); k <= b; k++) {
      if (raw[k] !== null) {
        sum += raw[k] as number;
        cnt += 1;
      }
    }
    const score = cnt > 0 ? sum / cnt : 0;
    return { t: new Date(t0 + b * SENTIMENT_BUCKET_MS).toISOString(), score: round3(score) };
  });
}
