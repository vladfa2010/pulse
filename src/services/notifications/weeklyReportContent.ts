/**
 * PULSE — Weekly Report Content Builder.
 *
 * Извлечено из reports.ts. Здесь только "какие статьи показать юзеру".
 * Форматирование и доставка — в formatters.ts и диспетчере.
 */

import { query } from '../../config/db';
import { HARD_TAG_CAP } from './types';
import { WeeklyStats, computeWeeklyStatsForTags } from './weeklyStats';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export interface WeeklyReportArticle {
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: Date;
  sentiment: string;
}

/** Лёгкая форма события для графика недели (маркеры + сантимент-фон):
 *  ПРАВКА к ТЗ-191 — БЕЗ кепа по свежести, покрывает всю отчётную неделю */
export interface WeeklyChartEvent {
  title: string;
  source: string;
  url: string;
  publishedAt: Date;
  sentiment: string;
}

export interface WeeklyReportTagSummary {
  tagId: string;
  tagName: string;
  /** Кепнутые свежие статьи — для ИИ-итогов и текстовых блоков (лимит см. в builder) */
  articles: WeeklyReportArticle[];
  /** ВСЕ новости тега за окно недели — источник маркеров/фона графика.
   *  Старые снапшоты поля не имеют — фронт/чарт фолбечатся на articles */
  chartEvents?: WeeklyChartEvent[];
}

export interface WeeklyReportContent {
  period: string;
  tagSummaries: WeeklyReportTagSummary[];
  totalArticles: number;
  sentimentBreakdown: { positive: number; negative: number; neutral: number };
  /**
   * Агрегаты без лимита (ТЗ-184): точные счётчики по тегам/дням/тональности
   * за 7/14/30 дней. null — при сбое агрегатов: контент строится, но
   * счётчики в тексте остаются на старых значениях из списка статей,
   * картинка не рендерится (деградация → текст).
   */
  stats: WeeklyStats | null;
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/** PG возвращает matched_tags массивом, SQLite — JSON-текстом: приводим к массиву */
function normalizeMatchedTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* пустые matched_tags */ }
  }
  return [];
}

/**
 * @param userId  пользователь
 * @param maxTags лимит тегов из Entitlement (null = без plan-лимита)
 * @param windowStart ТЗ-191 live-режим: левая граница окна (понедельник недели
 *                    по МСК) вместо скользящих 7 дней; stats при этом заменяет
 *                    вызывающий (computeLiveWeeklyStats), здесь rolling-агрегаты
 * @param windowEnd ПРАВКА-2 к ТЗ-191: правая граница окна (конец недели / now).
 *                    С windowStart+windowEnd curated-выборка режется по
 *                    published_at В окно (а не «свежие 200»), и дополнительно
 *                    собирается chartEvents — ВСЕ новости окна для графика
 */
export async function buildWeeklyReportContent(
  userId: string,
  maxTags: number | null,
  windowStart?: Date,
  windowEnd?: Date
): Promise<WeeklyReportContent | null> {
  // Cap: min(tagLimit, 200). Бесконечные (-1) и ручной запуск (null) → 200.
  const rawLimit = maxTags ?? HARD_TAG_CAP;
  const limit = rawLimit < 0 ? HARD_TAG_CAP : Math.min(rawLimit, HARD_TAG_CAP);

  // Только активные (не frozen) теги пользователя
  const portfolioResult = await query(
    `SELECT tag_id, tag_name FROM portfolios 
     WHERE user_id = $1 AND is_frozen = FALSE 
     ORDER BY created_at ASC LIMIT $2`,
    [userId, limit]
  );

  if (portfolioResult.rows.length === 0) {
    console.log(`[WeeklyReport] No tags for user ${userId}`);
    return null;
  }

  const tagRows = portfolioResult.rows;
  const tagIds = tagRows.map(r => r.tag_id);
  const tagNames: Record<string, string> = {};
  for (const r of tagRows) tagNames[r.tag_id] = r.tag_name;

  // RSS — 7 дней, API-источники — 8 дней (fetched_at fallback).
  // ТЗ-191 live: окно — от понедельника текущей недели (прошедшие дни).
  const sincePublished = windowStart ?? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sinceFetched = windowStart
    ? new Date(windowStart.getTime() - 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  // ПРАВКА-2 к ТЗ-191: календарное окно [windowStart, windowEnd) по published_at —
  // иначе кеп свежести LIMIT 200 вытягивает «вчера—сегодня», а неделя остаётся пустой
  const windowed = windowStart != null && windowEnd != null;
  const windowClauseSqlite = windowed ? ' AND published_at >= ? AND published_at < ?' : '';
  const windowClausePg = windowed ? ' AND published_at >= $4 AND published_at < $5' : '';

  console.log(
    `[WeeklyReport] user=${userId} tags=${tagIds.length} limit=${limit}`
  );

  let newsResult;
  if (USE_SQLITE) {
    // SQLite-dev паритет с PG `matched_tags && $1::text[]`: matched_tags — JSON-текст
    // вида '["uuid-a","uuid-b"]', поэтому матчим по '"id"' (PG-стиль), а не по
    // ';"id";' — JSON не содержит ';' и старый паттерн никогда не срабатывал.
    const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
    const likeParams = tagIds.map(id => `%"${id}"%`);
    newsResult = await query(
      `SELECT COALESCE(title_ru, title_original) as title,
              COALESCE(summary_ru, summary_original) as summary,
              source, url, published_at, sentiment, matched_tags
       FROM news
       WHERE (${conditions})
         AND (fetched_at > ? OR published_at > ?)${windowClauseSqlite}
       ORDER BY fetched_at DESC
       LIMIT 200`,
      windowed
        ? [...likeParams, sinceFetched.toISOString(), sincePublished.toISOString(),
           windowStart!.toISOString(), windowEnd!.toISOString()]
        : [...likeParams, sinceFetched.toISOString(), sincePublished.toISOString()]
    );
  } else {
    newsResult = await query(
      `SELECT COALESCE(title_ru, title_original) as title,
              COALESCE(summary_ru, summary_original) as summary,
              source, url, published_at, sentiment, matched_tags
       FROM news
       WHERE matched_tags && $1::text[]
         AND (fetched_at > $2 OR published_at > $3)${windowClausePg}
       ORDER BY GREATEST(fetched_at, published_at) DESC
       LIMIT 200`,
      windowed
        ? [tagIds, sinceFetched.toISOString(), sincePublished.toISOString(),
           windowStart!.toISOString(), windowEnd!.toISOString()]
        : [tagIds, sinceFetched.toISOString(), sincePublished.toISOString()]
    );
  }

  // chartEvents: ВСЕ новости тегов за окно (без кепа) — маркеры/фон графика.
  // Отдельный лёгкий запрос: curated-выборка выше намеренно кепнута для ИИ-итогов.
  // matchedTags — служебное поле для раскладки по тегам, в payload не уходит.
  let chartEvents: Array<WeeklyChartEvent & { matchedTags: string[] }> = [];
  if (windowed) {
    let evResult;
    if (USE_SQLITE) {
      const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
      const likeParams = tagIds.map(id => `%"${id}"%`);
      evResult = await query(
        `SELECT COALESCE(title_ru, title_original) as title,
                source, url, published_at, sentiment, matched_tags
         FROM news
         WHERE (${conditions})
           AND published_at >= ? AND published_at < ?
         ORDER BY published_at ASC
         LIMIT 5000`,
        [...likeParams, windowStart!.toISOString(), windowEnd!.toISOString()]
      );
    } else {
      evResult = await query(
        `SELECT COALESCE(title_ru, title_original) as title,
                source, url, published_at, sentiment, matched_tags
         FROM news
         WHERE matched_tags && $1::text[]
           AND published_at >= $2 AND published_at < $3
         ORDER BY published_at ASC
         LIMIT 5000`,
        [tagIds, windowStart!.toISOString(), windowEnd!.toISOString()]
      );
    }
    chartEvents = evResult.rows.map((row: any) => ({
      title: row.title,
      source: row.source,
      url: row.url,
      publishedAt: row.published_at ? new Date(row.published_at) : new Date(),
      sentiment: row.sentiment || 'neutral',
      matchedTags: normalizeMatchedTags(row.matched_tags),
    })) as Array<WeeklyChartEvent & { matchedTags: string[] }>;
  }

  const articles = newsResult.rows;
  if (articles.length === 0) {
    console.log(`[WeeklyReport] user=${userId} no articles`);
    return null;
  }

  // Группировка по тегу
  const tagMap = new Map<string, WeeklyReportTagSummary>();
  for (const row of tagRows) {
    tagMap.set(row.tag_id, { tagId: row.tag_id, tagName: row.tag_name, articles: [] });
  }

  const sentimentBreakdown = { positive: 0, negative: 0, neutral: 0 };

  for (const row of articles) {
    const sentiment = row.sentiment || 'neutral';
    sentimentBreakdown[sentiment as keyof typeof sentimentBreakdown]++;

    // PG возвращает matched_tags массивом, SQLite — JSON-текстом: приводим к массиву
    const matched = normalizeMatchedTags(row.matched_tags);

    for (const tagId of matched) {
      if (tagMap.has(tagId)) {
        tagMap.get(tagId)!.articles.push({
          title: row.title,
          summary: row.summary,
          source: row.source,
          url: row.url,
          publishedAt: row.published_at ? new Date(row.published_at) : new Date(),
          sentiment,
        });
      }
    }
  }

  // Раскладываем chartEvents по тегам (новость может быть привязана к нескольким)
  for (const ev of chartEvents) {
    const { matchedTags, ...event } = ev;
    for (const tagId of matchedTags) {
      const summary = tagMap.get(tagId);
      if (!summary) continue;
      summary.chartEvents ??= [];
      summary.chartEvents.push(event);
    }
  }

  const tagSummaries = Array.from(tagMap.values()).filter(
    t => t.articles.length > 0 || (t.chartEvents?.length ?? 0) > 0
  );
  if (tagSummaries.length === 0) {
    console.log(`[WeeklyReport] user=${userId} no matching tags with articles`);
    return null;
  }

  // ТЗ-184: агрегаты без лимита (точные счётчики для текста и графика).
  // Ошибка агрегатов не ломает отчёт — контент уходит со stats=null.
  let stats: WeeklyStats | null = null;
  try {
    stats = await computeWeeklyStatsForTags(
      tagRows.map(r => ({ tagId: r.tag_id, tagName: r.tag_name }))
    );
  } catch (err) {
    console.error(`[WeeklyReport] user=${userId} stats aggregation failed, report without stats:`, err);
  }

  return {
    // Правую границу показываем как последний день окна (воскресенье), а не
    // exclusive-конец (понедельник 00:00); для live (windowEnd=now) — сегодня
    period: windowStart
      ? `${formatDate(windowStart)} — ${formatDate(new Date((windowEnd ?? new Date()).getTime() - 1))}`
      : `${formatDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))} — ${formatDate(new Date())}`,
    tagSummaries,
    totalArticles: articles.length,
    sentimentBreakdown,
    stats,
  };
}

export { buildWeeklyReportContent as default };
