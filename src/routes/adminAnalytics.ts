import { Router } from 'express';
import { adminMiddleware } from './admin';
import { query } from '../config/db';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

const nowSql = () => (USE_SQLITE ? "datetime('now')" : 'NOW()');
const agoSql = (days: number) =>
  USE_SQLITE ? `datetime('now', '-${days} days')` : `NOW() - INTERVAL '${days} days'`;
const intervalSql = (days: number) =>
  USE_SQLITE ? `datetime('now', '-${days} days')` : `NOW() - INTERVAL '${days} days'`;

router.get('/analytics', adminMiddleware, async (req, res) => {
  try {
    const period = parseInt(req.query.period as string) || 30;

    // DAU/WAU/MAU from user_logins; fallback to last_login_at
    let dau, wau, mau;
    try {
      [dau, wau, mau] = await Promise.all([
        query(`SELECT COUNT(DISTINCT user_id) as c FROM user_logins WHERE login_at > ${agoSql(1)}`),
        query(`SELECT COUNT(DISTINCT user_id) as c FROM user_logins WHERE login_at > ${agoSql(7)}`),
        query(`SELECT COUNT(DISTINCT user_id) as c FROM user_logins WHERE login_at > ${agoSql(30)}`),
      ]);
    } catch {
      [dau, wau, mau] = await Promise.all([
        query(`SELECT COUNT(*) as c FROM users WHERE last_login_at > ${agoSql(1)}`),
        query(`SELECT COUNT(*) as c FROM users WHERE last_login_at > ${agoSql(7)}`),
        query(`SELECT COUNT(*) as c FROM users WHERE last_login_at > ${agoSql(30)}`),
      ]);
    }

    const [totalUsers, newToday, newWeek, activeSubs, pushSubs, revenue] = await Promise.all([
      query('SELECT COUNT(*) as c FROM users'),
      query(`SELECT COUNT(*) as c FROM users WHERE created_at > ${agoSql(1)}`),
      query(`SELECT COUNT(*) as c FROM users WHERE created_at > ${agoSql(7)}`),
      query('SELECT COUNT(*) as c FROM users WHERE subscription_active = TRUE'),
      query('SELECT COUNT(DISTINCT user_id) as c FROM push_subscriptions WHERE is_active = TRUE'),
      query(`SELECT COALESCE(SUM(amount), 0) as c FROM payments WHERE status = 'completed' AND created_at > ${agoSql(period)}`),
    ]);

    const totalUsersCount = Math.max(1, parseInt(totalUsers.rows[0]?.c) || 0);

    // Daily activity: DAU from user_logins + new users from users table
    const dailyResult = await query(
      USE_SQLITE
        ? `SELECT date(login_at) as day, COUNT(DISTINCT user_id) as dau FROM user_logins WHERE login_at > datetime('now', '-${period} days') GROUP BY date(login_at) ORDER BY day`
        : `SELECT DATE(login_at) as day, COUNT(DISTINCT user_id) as dau FROM user_logins WHERE login_at > NOW() - INTERVAL '${period} days' GROUP BY DATE(login_at) ORDER BY day`
    );
    const newUsersDaily = await query(
      USE_SQLITE
        ? `SELECT date(created_at) as day, COUNT(*) as c FROM users WHERE created_at > datetime('now', '-${period} days') GROUP BY date(created_at) ORDER BY day`
        : `SELECT DATE(created_at) as day, COUNT(*) as c FROM users WHERE created_at > NOW() - INTERVAL '${period} days' GROUP BY DATE(created_at) ORDER BY day`
    );
    const newUsersMap = new Map(newUsersDaily.rows.map((r: any) => [r.day, parseInt(r.c)]));
    const dailyActivity = dailyResult.rows.map((r: any) => ({
      date: r.day,
      dau: parseInt(r.dau) || 0,
      new_users: newUsersMap.get(r.day) || 0,
    }));

    // Signup trend
    const signupResult = await query(
      USE_SQLITE
        ? `SELECT date(created_at) as day, COUNT(*) as signups FROM users WHERE created_at > datetime('now', '-${period} days') GROUP BY date(created_at) ORDER BY day`
        : `SELECT DATE(created_at) as day, COUNT(*) as signups FROM users WHERE created_at > NOW() - INTERVAL '${period} days' GROUP BY DATE(created_at) ORDER BY day`
    );

    // Funnel: Registered -> Logged In -> Added Tag -> Read Article -> Paid
    const [fReg, fLogin, fTag, fRead, fPay] = await Promise.all([
      query(`SELECT COUNT(*) as c FROM users WHERE created_at > ${agoSql(period)}`),
      query(`SELECT COUNT(DISTINCT user_id) as c FROM user_logins WHERE login_at > ${agoSql(period)}`),
      query(`SELECT COUNT(DISTINCT user_id) as c FROM portfolios WHERE created_at > ${agoSql(period)}`),
      query(`SELECT COUNT(DISTINCT user_id) as c FROM user_news_reads WHERE read_at > ${agoSql(period)}`),
      query(`SELECT COUNT(DISTINCT user_id) as c FROM payments WHERE status = 'completed' AND created_at > ${agoSql(period)}`),
    ]);
    const funnelReg = parseInt(fReg.rows[0]?.c) || 0;
    const fLoginCount = parseInt(fLogin.rows[0]?.c) || 0;
    const fTagCount = parseInt(fTag.rows[0]?.c) || 0;
    const fReadCount = parseInt(fRead.rows[0]?.c) || 0;
    const fPayCount = parseInt(fPay.rows[0]?.c) || 0;
    const funnel = [
      { step: 'Registered', count: funnelReg, pct_of_prev: 100, pct_of_total: 100 },
      { step: 'Logged In', count: fLoginCount, pct_of_prev: pct(fLoginCount, funnelReg), pct_of_total: pct(fLoginCount, funnelReg) },
      { step: 'Added Tag', count: fTagCount, pct_of_prev: pct(fTagCount, fLoginCount), pct_of_total: pct(fTagCount, funnelReg) },
      { step: 'Read Article', count: fReadCount, pct_of_prev: pct(fReadCount, fTagCount), pct_of_total: pct(fReadCount, funnelReg) },
      { step: 'Paid', count: fPayCount, pct_of_prev: pct(fPayCount, fReadCount), pct_of_total: pct(fPayCount, funnelReg) },
    ];

    // Retention: weekly cohorts over last N days
    const retentionDays = period <= 7 ? 14 : period <= 30 ? 42 : period;
    const cohortLimit = Math.ceil(retentionDays / 7);
    const retentionResult = await query(
      USE_SQLITE
        ? `SELECT date(created_at) as cohort_week,
            COUNT(*) as w0,
            COUNT(CASE WHEN last_login_at > datetime(created_at, '+1 days') THEN 1 END) as d1,
            COUNT(CASE WHEN last_login_at > datetime(created_at, '+7 days') THEN 1 END) as d7,
            COUNT(CASE WHEN last_login_at > datetime(created_at, '+30 days') THEN 1 END) as d30
          FROM users
          WHERE created_at > datetime('now', '-${retentionDays} days')
          GROUP BY date(created_at)
          ORDER BY cohort_week DESC
          LIMIT ${cohortLimit}`
        : `SELECT DATE(created_at) as cohort_week,
            COUNT(*) as w0,
            COUNT(CASE WHEN last_login_at > created_at + INTERVAL '1 days' THEN 1 END) as d1,
            COUNT(CASE WHEN last_login_at > created_at + INTERVAL '7 days' THEN 1 END) as d7,
            COUNT(CASE WHEN last_login_at > created_at + INTERVAL '30 days' THEN 1 END) as d30
          FROM users
          WHERE created_at > NOW() - INTERVAL '${retentionDays} days'
          GROUP BY DATE(created_at)
          ORDER BY cohort_week DESC
          LIMIT ${cohortLimit}`
    );

    // Top tags
    const topTags = await query(
      `SELECT tag_name, COUNT(DISTINCT user_id) as c FROM portfolios GROUP BY tag_name ORDER BY c DESC LIMIT 10`
    );

    // Countries, devices, platforms from user_logins
    const topCountries = await query(
      `SELECT country as label, COUNT(DISTINCT user_id) as c FROM user_logins WHERE country IS NOT NULL AND login_at > ${agoSql(period)} GROUP BY country ORDER BY c DESC LIMIT 8`
    ).catch(() => ({ rows: [] }));
    const devices = await query(
      `SELECT device_type as label, COUNT(DISTINCT user_id) as c FROM user_logins WHERE device_type IS NOT NULL AND login_at > ${agoSql(period)} GROUP BY device_type ORDER BY c DESC LIMIT 5`
    ).catch(() => ({ rows: [] }));
    const platforms = await query(
      `SELECT platform as label, COUNT(DISTINCT user_id) as c FROM user_logins WHERE platform IS NOT NULL AND login_at > ${agoSql(period)} GROUP BY platform ORDER BY c DESC`
    ).catch(() => ({ rows: [] }));

    // At risk
    const [risk7d, risk30d, noTags, expiring] = await Promise.all([
      query(`SELECT COUNT(*) as c FROM users WHERE (last_login_at < ${agoSql(7)} OR last_login_at IS NULL) AND is_blocked = FALSE`),
      query(`SELECT COUNT(*) as c FROM users WHERE (last_login_at < ${agoSql(30)} OR last_login_at IS NULL) AND is_blocked = FALSE`),
      query(`SELECT COUNT(*) as c FROM users u WHERE NOT EXISTS (SELECT 1 FROM portfolios p WHERE p.user_id = u.id)`),
      query(`SELECT COUNT(*) as c FROM users WHERE subscription_active = TRUE AND subscription_expires_at > ${nowSql()} AND subscription_expires_at < ${agoSql(-7)}`),
    ]);

    // Sentiment
    let sentVotes, sentVoters, avgStreak, voteDist;
    try {
      [sentVotes, sentVoters, avgStreak, voteDist] = await Promise.all([
        query(`SELECT COUNT(*) as c FROM sentiment_votes WHERE created_at > ${agoSql(period)}`),
        query(`SELECT COUNT(DISTINCT user_id) as c FROM sentiment_votes WHERE created_at > ${agoSql(period)}`),
        query(`SELECT COALESCE(AVG(streak_days), 0) as c FROM sentiment_user_windows WHERE streak_days > 0`),
        query(`SELECT vote_value, COUNT(*) as c FROM sentiment_votes WHERE created_at > ${agoSql(period)} GROUP BY vote_value`),
      ]);
    } catch {
      sentVotes = { rows: [{ c: 0 }] };
      sentVoters = { rows: [{ c: 0 }] };
      avgStreak = { rows: [{ c: 0 }] };
      voteDist = { rows: [] };
    }

    // Avg tags and distribution
    const avgTagsResult = await query(
      `SELECT COALESCE(AVG(tag_count), 0) as c FROM (SELECT COUNT(*) as tag_count FROM portfolios GROUP BY user_id) sub`
    );
    const tagDistResult = await query(
      `SELECT CASE WHEN tag_count = 1 THEN '1' WHEN tag_count BETWEEN 2 AND 3 THEN '2-3' WHEN tag_count BETWEEN 4 AND 5 THEN '4-5' ELSE '6+' END as bucket,
        COUNT(*) as c
       FROM (SELECT COUNT(*) as tag_count FROM portfolios GROUP BY user_id) sub
       GROUP BY bucket ORDER BY MIN(tag_count)`
    );

    // Push stats
    let pushSent, pushOpened, pushDaily;
    try {
      [pushSent, pushOpened, pushDaily] = await Promise.all([
        query(`SELECT COUNT(*) as c FROM push_notifications_sent WHERE sent_at > ${agoSql(period)}`),
        query(`SELECT COUNT(DISTINCT user_id) as c FROM push_notifications_sent WHERE sent_at > ${agoSql(period)}`),
        query(
          USE_SQLITE
            ? `SELECT date(sent_at) as day, COUNT(*) as sent FROM push_notifications_sent WHERE sent_at > datetime('now', '-${period} days') GROUP BY date(sent_at) ORDER BY day`
            : `SELECT DATE(sent_at) as day, COUNT(*) as sent FROM push_notifications_sent WHERE sent_at > NOW() - INTERVAL '${period} days' GROUP BY DATE(sent_at) ORDER BY day`
        ),
      ]);
    } catch {
      pushSent = { rows: [{ c: 0 }] };
      pushOpened = { rows: [{ c: 0 }] };
      pushDaily = { rows: [] };
    }
    const pushSentCount = parseInt(pushSent.rows[0]?.c) || 0;
    const pushOpenedCount = parseInt(pushOpened.rows[0]?.c) || 0;

    // Cohort LTV (42 days)
    const cohortLtvResult = await query(
      USE_SQLITE
        ? `SELECT date(u.created_at) as cohort, COUNT(DISTINCT u.id) as users, COALESCE(SUM(p.amount), 0) as revenue
           FROM users u LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
           WHERE u.created_at > datetime('now', '-42 days')
           GROUP BY date(u.created_at) ORDER BY cohort DESC LIMIT 6`
        : `SELECT DATE(u.created_at) as cohort, COUNT(DISTINCT u.id) as users, COALESCE(SUM(p.amount), 0) as revenue
           FROM users u LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
           WHERE u.created_at > NOW() - INTERVAL '42 days'
           GROUP BY DATE(u.created_at) ORDER BY cohort DESC LIMIT 6`
    );

    const ltvTrendResult = await query(
      USE_SQLITE
        ? `SELECT date(u.created_at) as cohort, COUNT(DISTINCT u.id) as users, COALESCE(SUM(p.amount), 0) as revenue
           FROM users u LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
           WHERE u.created_at > datetime('now', '-42 days')
           GROUP BY date(u.created_at) ORDER BY cohort`
        : `SELECT DATE(u.created_at) as cohort, COUNT(DISTINCT u.id) as users, COALESCE(SUM(p.amount), 0) as revenue
           FROM users u LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
           WHERE u.created_at > NOW() - INTERVAL '42 days'
           GROUP BY DATE(u.created_at) ORDER BY cohort`
    );

    // Time to first payment
    const ttfpResult = await query(
      USE_SQLITE
        ? `SELECT CASE WHEN days <= 1 THEN '0-1d' WHEN days <= 3 THEN '2-3d' WHEN days <= 7 THEN '4-7d' WHEN days <= 14 THEN '8-14d' WHEN days <= 30 THEN '15-30d' ELSE '30d+' END as bucket,
            COUNT(*) as c
           FROM (SELECT CAST(julianday(MIN(p.created_at)) - julianday(u.created_at) AS INTEGER) as days
                 FROM users u JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
                 GROUP BY u.id) sub
           GROUP BY bucket`
        : `SELECT CASE WHEN days <= 1 THEN '0-1d' WHEN days <= 3 THEN '2-3d' WHEN days <= 7 THEN '4-7d' WHEN days <= 14 THEN '8-14d' WHEN days <= 30 THEN '15-30d' ELSE '30d+' END as bucket,
            COUNT(*) as c
           FROM (SELECT EXTRACT(DAY FROM MIN(p.created_at) - u.created_at) as days
                 FROM users u JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
                 GROUP BY u.id) sub
           GROUP BY bucket`
    );

    // Feature adoption
    const [pushAdopt, tgAdopt, sentimentAdopt, premiumAdopt] = await Promise.all([
      query(`SELECT COUNT(DISTINCT user_id) as c FROM push_subscriptions WHERE is_active = ${USE_SQLITE ? '1' : 'TRUE'}`).catch(() => ({ rows: [{ c: 0 }] })),
      query(`SELECT COUNT(DISTINCT user_id) as c FROM user_channels WHERE channel = 'telegram' AND is_active = ${USE_SQLITE ? '1' : 'TRUE'}`).catch(() => ({ rows: [{ c: 0 }] })),
      query(`SELECT COUNT(DISTINCT user_id) as c FROM sentiment_votes`).catch(() => ({ rows: [{ c: 0 }] })),
      query(`SELECT COUNT(*) as c FROM users WHERE subscription_active = TRUE`),
    ]);

    res.json({
      overview: {
        total_users: parseInt(totalUsers.rows[0]?.c) || 0,
        dau: parseInt(dau?.rows[0]?.c) || 0,
        wau: parseInt(wau?.rows[0]?.c) || 0,
        mau: parseInt(mau?.rows[0]?.c) || 0,
        new_users_today: parseInt(newToday.rows[0]?.c) || 0,
        new_users_week: parseInt(newWeek.rows[0]?.c) || 0,
        active_subscriptions: parseInt(activeSubs.rows[0]?.c) || 0,
        push_subscribers: parseInt(pushSubs.rows[0]?.c) || 0,
        total_revenue: parseFloat(revenue.rows[0]?.c) || 0,
      },
      daily_activity: dailyActivity,
      signup_trend: signupResult.rows.map((r: any) => ({ date: r.day, signups: parseInt(r.signups) || 0 })),
      funnel,
      retention: retentionResult.rows.map((r: any) => ({
        cohort: r.cohort_week,
        d1: pct(parseInt(r.d1 || 0), parseInt(r.w0)),
        d7: pct(parseInt(r.d7 || 0), parseInt(r.w0)),
        d30: pct(parseInt(r.d30 || 0), parseInt(r.w0)),
      })),
      top_tags: topTags.rows.map((r: any) => ({ label: r.tag_name, value: parseInt(r.c) })),
      top_countries: topCountries.rows.map((r: any) => ({ label: r.label || 'Unknown', value: parseInt(r.c) })),
      devices: devices.rows.map((r: any) => ({ label: r.label || 'Unknown', value: parseInt(r.c) })),
      platforms: platforms.rows.map((r: any) => ({ label: r.label || 'web', value: parseInt(r.c) })),
      at_risk: {
        dormant_7d: parseInt(risk7d.rows[0]?.c) || 0,
        dormant_30d: parseInt(risk30d.rows[0]?.c) || 0,
        no_tags: parseInt(noTags.rows[0]?.c) || 0,
        sub_expiring_7d: parseInt(expiring.rows[0]?.c) || 0,
      },
      sentiment: {
        total_votes: parseInt(sentVotes.rows[0]?.c) || 0,
        unique_voters: parseInt(sentVoters.rows[0]?.c) || 0,
        avg_streak: parseFloat(avgStreak.rows[0]?.c) || 0,
        distribution: {
          bullish: parseInt(voteDist.rows.find((r: any) => r.vote_value == 1)?.c) || 0,
          neutral: parseInt(voteDist.rows.find((r: any) => r.vote_value == 0)?.c) || 0,
          bearish: parseInt(voteDist.rows.find((r: any) => r.vote_value == -1)?.c) || 0,
        },
      },
      push_stats: {
        sent: pushSentCount,
        opened: pushOpenedCount,
        ctr: pushSentCount > 0 ? Math.round((pushOpenedCount / pushSentCount) * 1000) / 10 : 0,
        daily: (pushDaily?.rows || []).map((r: any) => ({ date: r.day, sent: parseInt(r.sent) || 0 })),
      },
      avg_tags: parseFloat(avgTagsResult.rows[0]?.c) || 0,
      tag_distribution: (tagDistResult.rows || []).map((r: any) => ({ label: r.bucket, value: parseInt(r.c) })),
      cohort_ltv: cohortLtvResult.rows.map((r: any) => ({
        cohort: r.cohort,
        users: parseInt(r.users) || 0,
        ltv: parseInt(r.users) > 0 ? Math.round(parseFloat(r.revenue || 0) / parseInt(r.users)) : 0,
      })),
      ltv_trend: ltvTrendResult.rows.map((r: any) => ({
        cohort: r.cohort,
        ltv: parseInt(r.users) > 0 ? Math.round(parseFloat(r.revenue || 0) / parseInt(r.users)) : 0,
      })),
      ttfp: {
        distribution: (ttfpResult.rows || []).map((r: any) => ({ label: r.bucket, value: parseInt(r.c) })),
      },
      conversion_velocity: {
        buckets: (ttfpResult.rows || []).map((r: any) => ({ label: r.bucket, value: parseInt(r.c) })),
      },
      feature_adoption: {
        push: { count: parseInt(pushAdopt.rows[0]?.c) || 0, pct: pctOfTotal(parseInt(pushAdopt.rows[0]?.c) || 0, totalUsersCount) },
        telegram: { count: parseInt(tgAdopt.rows[0]?.c) || 0, pct: pctOfTotal(parseInt(tgAdopt.rows[0]?.c) || 0, totalUsersCount) },
        sentiment: { count: parseInt(sentimentAdopt.rows[0]?.c) || 0, pct: pctOfTotal(parseInt(sentimentAdopt.rows[0]?.c) || 0, totalUsersCount) },
        premium: { count: parseInt(premiumAdopt.rows[0]?.c) || 0, pct: pctOfTotal(parseInt(premiumAdopt.rows[0]?.c) || 0, totalUsersCount) },
      },
    });
  } catch (err: any) {
    console.error('[Admin Analytics] Error:', err.message);
    res.status(500).json({ error: 'Failed to load analytics', details: err.message });
  }
});

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function pctOfTotal(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

export default router;
