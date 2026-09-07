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
 */

import { Router } from 'express';
import { query } from '../config/db';

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

export default router;
