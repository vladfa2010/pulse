/**
 * Публичная статистика «Объём информации» для гостевой главной (ТЗ-56, кэш — ТЗ-57).
 *
 * GET /api/public/efficiency — счётчики новостей эталонного аккаунта
 * (env PUBLIC_EFFICIENCY_EMAIL, по умолчанию vladfa@ya.ru). Без авторизации.
 *
 * SQL — 1:1 с /user/stats (user.ts), чтобы цифры на лендинге совпадали
 * с профилем эталонного аккаунта. PG-only (NOW(), &&) — как и оригинал.
 * Наружу — только счётчики: email и список тегов не отдаём.
 *
 * Кэш (ТЗ-57): ленивый пересчёт раз в сутки (env PUBLIC_EFFICIENCY_TTL_MS,
 * дефолт 24 ч). Single-flight: параллельные хиты при истёкшем TTL ждут один
 * in-flight пересчёт. Stale-on-error: пересчёт упал при живом кэше → отдаём
 * старое со stale: true; 500 только когда кэша нет вообще. Ночной cron не нужен.
 *
 * GET /api/public/summary-global — публичный «Пульс рынка»: отдаёт только
 * свежий кэш globalSummary (LLM-генерацию не триггерит, прогрев — cron'ом).
 *
 * GET /api/public/demo-tags, GET /api/public/demo-feed (ТЗ-59, кэш — ТЗ-60) —
 * демо-режим гостевой главной: теги и лента (с графиками) демо-аккаунта
 * (env PUBLIC_DEMO_EMAIL, дефолт vladfa@ya1.ru). Кэш 60 с; лента — полный
 * аналог /api/news/global плюс фильтр matched_tags && demo-теги (PG-only),
 * без пагинации: параметры игнорируются, ответ один, кэш одноключевой.
 */

import { Router } from 'express';
import { query } from '../config/db';
import { getCachedGlobalSummary } from '../services/globalSummary';
import { timeFilterSql } from '../services/newsReads';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

const router = Router();

const TTL_MS = parseInt(process.env.PUBLIC_EFFICIENCY_TTL_MS || '', 10) || 24 * 3600 * 1000;

interface EfficiencyPayload {
  total_news: number;
  total_news_24h: number;
  personal_news: number;
  personal_news_24h: number;
  user_tags_count: number;
  cached_at: string;
  stale?: boolean;
}

let cache: { data: EfficiencyPayload; cachedAt: number } | null = null;
let inFlight: Promise<EfficiencyPayload> | null = null; // single-flight (паттерн calendarCachePromise)

async function recompute(): Promise<EfficiencyPayload> {
  const started = Date.now();
  const email = process.env.PUBLIC_EFFICIENCY_EMAIL || 'vladfa@ya.ru';
  const userResult = await query(`SELECT id FROM users WHERE email = $1`, [email]);
  const userId = userResult.rows[0]?.id;
  if (!userId) {
    const err: any = new Error('efficiency_account_not_configured');
    err.statusCode = 404;
    throw err;
  }

  // 1. Общее количество новостей в базе
  const totalResult = await query(`SELECT COUNT(*)::int as total FROM news`, []);
  const totalNews = totalResult.rows[0]?.total || 0;

  // 2. Количество новостей за 24ч
  const dayResult = await query(
    `SELECT COUNT(*)::int as cnt FROM news WHERE published_at > NOW() - INTERVAL '24 hours'`,
    []
  );
  const last24h = dayResult.rows[0]?.cnt || 0;

  // 3. Теги эталонного аккаунта (from portfolios) — matched_tags stores tag_id!
  const tagsResult = await query(
    `SELECT tag_id FROM portfolios WHERE user_id = $1 AND is_frozen = FALSE`,
    [userId]
  );
  const userTags = tagsResult.rows.map((r: any) => r.tag_id);

  // 4. Новости, подходящие под теги аккаунта (matched_tags && user_tags)
  let personalNews = 0;
  let personalNews24h = 0;

  if (userTags.length > 0) {
    const personalResult = await query(
      `SELECT COUNT(*)::int as cnt FROM news
       WHERE matched_tags && $1::text[]`,
      [userTags]
    );
    personalNews = personalResult.rows[0]?.cnt || 0;

    const personal24hResult = await query(
      `SELECT COUNT(*)::int as cnt FROM news
       WHERE matched_tags && $1::text[]
         AND published_at > NOW() - INTERVAL '24 hours'`,
      [userTags]
    );
    personalNews24h = personal24hResult.rows[0]?.cnt || 0;
  }

  const data: EfficiencyPayload = {
    total_news: totalNews,
    total_news_24h: last24h,
    personal_news: personalNews,
    personal_news_24h: personalNews24h,
    user_tags_count: userTags.length,
    cached_at: new Date().toISOString(),
  };
  console.log(`[PublicStats] recompute: ${Date.now() - started}ms total_news=${totalNews} personal_news=${personalNews}`);
  return data;
}

/** Пересчёт с single-flight: вторая и далее параллельные ждут in-flight промис. */
function recomputeSingleFlight(): Promise<EfficiencyPayload> {
  if (!inFlight) {
    inFlight = recompute()
      .then((data) => {
        cache = { data, cachedAt: Date.now() };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

// ТЗ-57: прогрев после boot — первый хит гостя всегда из кэша
export async function warmPublicEfficiency(): Promise<void> {
  if (cache && Date.now() - cache.cachedAt < TTL_MS) return;
  await recomputeSingleFlight();
}

router.get('/efficiency', async (_req, res) => {
  try {
    if (cache && Date.now() - cache.cachedAt < TTL_MS) {
      return res.json(cache.data);
    }
    const data = await recomputeSingleFlight();
    return res.json(data);
  } catch (err: any) {
    // Stale-on-error: пересчёт упал (включая пропажу учётки), но старая запись есть — отдаём её
    if (cache) {
      console.warn('[PublicStats] recompute failed, serving stale cache:', err.message);
      return res.json({ ...cache.data, stale: true });
    }
    if (err.statusCode === 404) {
      return res.status(404).json({ error: 'efficiency_account_not_configured' });
    }
    console.error('[PublicStats] Error:', err.message);
    return res.status(500).json({ error: 'Failed to get efficiency stats' });
  }
});

// GET /api/public/summary-global — публичный «Пульс рынка» (ИИ-саммари всей ленты)
// для гостевой главной. Только свежий кэш (TTL 6ч10м), генерацию НЕ триггерит —
// LLM прогревает cron (warm-up после boot + каждые 6 ч). Нет кэша → 404, фронт
// скрывает блок. Refresh-параметр анонимам игнорируется.
router.get('/summary-global', (_req, res) => {
  const cached = getCachedGlobalSummary();
  if (!cached) {
    return res.status(404).json({ error: 'summary_not_ready' });
  }
  return res.json({
    summary: cached.summary,
    cached: true,
    generated_at: cached.generatedAt || undefined,
    articles_count: cached.articlesCount,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ТЗ-59: демо-режим гостевой главной — теги и лента демо-аккаунта
// (env PUBLIC_DEMO_EMAIL, по умолчанию vladfa@ya1.ru; владелец наполняет
// тегами сам — контент лендинга правится без деплоя).
// PG-only (matched_tags && — как в /user/stats); SQLite не поддерживаем, ок.
// ═══════════════════════════════════════════════════════════════════════════

const DEMO_CACHE_MS = 60 * 1000; // под рекламный трафик
// ТЗ-60: demo-feed без пагинации — один ключ на весь ответ
const DEMO_FEED_TTL_MS = 60 * 1000;
const DEMO_FEED_LIMIT = 50;

interface DemoTag {
  tag_id: string;
  tag_name: string;
  tag_type: string;
}

let demoUserIdCache: { id: string; cachedAt: number } | null = null;
let demoTagsCache: { data: { tags: DemoTag[]; count: number; cached_at: string }; cachedAt: number } | null = null;
let demoFeedCache: { at: number; payload: unknown } | null = null;

async function resolveDemoUserId(): Promise<string | null> {
  if (demoUserIdCache && Date.now() - demoUserIdCache.cachedAt < 3600 * 1000) {
    return demoUserIdCache.id;
  }
  const email = process.env.PUBLIC_DEMO_EMAIL || 'vladfa@ya1.ru';
  const result = await query(`SELECT id FROM users WHERE email = $1`, [email]);
  const id = result.rows[0]?.id || null;
  if (id) demoUserIdCache = { id, cachedAt: Date.now() };
  return id;
}

async function fetchDemoTags(userId: string) {
  if (demoTagsCache && Date.now() - demoTagsCache.cachedAt < DEMO_CACHE_MS) {
    return demoTagsCache.data;
  }
  const result = await query(
    `SELECT tag_id, tag_name, tag_type FROM portfolios WHERE user_id = $1 AND is_frozen = ${USE_SQLITE ? '0' : 'FALSE'}`,
    [userId]
  );
  const data = {
    tags: result.rows as DemoTag[],
    count: result.rows.length,
    cached_at: new Date().toISOString(),
  };
  demoTagsCache = { data, cachedAt: Date.now() };
  return data;
}

// GET /api/public/demo-tags — теги демо-аккаунта (без замороженных), кэш 60 с
router.get('/demo-tags', async (_req, res) => {
  try {
    const userId = await resolveDemoUserId();
    if (!userId) {
      return res.status(404).json({ error: 'demo_account_not_configured' });
    }
    const data = await fetchDemoTags(userId);
    return res.json(data);
  } catch (err: any) {
    console.error('[PublicDemo] demo-tags error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch demo tags' });
  }
});

// GET /api/public/demo-feed — лента демо-аккаунта (ТЗ-59, кэш — ТЗ-60).
// Query-параметры намеренно игнорируются: пагинации нет, гостю достаточно
// первых 50 новостей; иначе перебор ?page=N обходит кэш и бьёт в БД.
// SQL — полный аналог /api/news/global (тот же SELECT, timeFilterSql,
// LIMIT+1) плюс фильтр matched_tags && demo-теги. Кэш один на весь ответ.
router.get('/demo-feed', async (_req, res) => {
  try {
    const hit = demoFeedCache;
    if (hit && Date.now() - hit.at < DEMO_FEED_TTL_MS) {
      return res.json(hit.payload);
    }

    const userId = await resolveDemoUserId();
    if (!userId) {
      return res.status(404).json({ error: 'demo_account_not_configured' });
    }
    const { tags } = await fetchDemoTags(userId);
    if (tags.length === 0) {
      // Не ошибка: фронт скроет блок
      return res.json({ articles: [], total: null, page: 1, hasMore: false });
    }
    const tagIds = tags.map((t) => t.tag_id);
    const timeFilter = timeFilterSql();

    const result = await query(
      `SELECT id, title_ru, title_original, summary_ru, summary_original, source, url, published_at, sentiment, sentiment_score, sentiment_reasoning, sentiment_source, is_political, article_type, matched_tags,
              tag_impact, source_count, all_sources, fact_check_status, fact_check_result, slug
       FROM news
       WHERE ${timeFilter}
         AND matched_tags && $2::text[]
       ORDER BY published_at DESC
       LIMIT $1`,
      [DEMO_FEED_LIMIT + 1, tagIds]
    );

    const articles = result.rows.slice(0, DEMO_FEED_LIMIT);
    const payload = {
      articles,
      total: null,
      page: 1,
      hasMore: false,
      cached_at: new Date().toISOString(),
    };
    demoFeedCache = { at: Date.now(), payload };
    return res.json(payload);
  } catch (err: any) {
    console.error('[PublicDemo] demo-feed error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch demo feed' });
  }
});

export default router;
