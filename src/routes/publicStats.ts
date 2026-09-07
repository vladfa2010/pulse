/**
 * Публичная статистика «Объём информации» для гостевой главной (ТЗ-56).
 *
 * GET /api/public/efficiency — счётчики новостей эталонного аккаунта
 * (env PUBLIC_EFFICIENCY_EMAIL, по умолчанию vladfa@ya.ru). Без авторизации.
 *
 * SQL — 1:1 с /user/stats (user.ts), чтобы цифры на лендинге совпадали
 * с профилем эталонного аккаунта. PG-only (NOW(), &&) — как и оригинал.
 * Наружу — только счётчики: email и список тегов не отдаём.
 * In-memory кэш 60 с: под рекламным трафиком нельзя делать 4 COUNT(*) по news на хит.
 */

import { Router } from 'express';
import { query } from '../config/db';

const router = Router();

const CACHE_TTL_MS = 60 * 1000;
let cache: { at: number; payload: any } | null = null;

router.get('/efficiency', async (_req, res) => {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return res.json(cache.payload);
    }

    const email = process.env.PUBLIC_EFFICIENCY_EMAIL || 'vladfa@ya.ru';
    const userResult = await query(`SELECT id FROM users WHERE email = $1`, [email]);
    const userId = userResult.rows[0]?.id;
    if (!userId) {
      return res.status(404).json({ error: 'efficiency_account_not_configured' });
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

    const payload = {
      total_news: totalNews,
      total_news_24h: last24h,
      personal_news: personalNews,
      personal_news_24h: personalNews24h,
      user_tags_count: userTags.length,
      cached_at: new Date().toISOString(),
    };
    cache = { at: Date.now(), payload };
    res.json(payload);
  } catch (err: any) {
    console.error('[PublicStats] Error:', err.message);
    res.status(500).json({ error: 'Failed to get efficiency stats' });
  }
});

export default router;
