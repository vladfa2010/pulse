import { Router } from 'express';
import { adminMiddleware } from './admin';
import { query } from '../config/db';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

const nowSql = () => (USE_SQLITE ? "datetime('now')" : 'NOW()');
const agoSql = (days: number) =>
  USE_SQLITE ? `datetime('now', '-${days} days')` : `NOW() - INTERVAL '${days} days'`;

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { data: any; expiresAt: number }>();

function cacheKey(section: string, period: number): string {
  return `${section}:${period}`;
}

function getCached(section: string, period: number): any | null {
  const key = cacheKey(section, period);
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    return entry.data;
  }
  if (entry) cache.delete(key);
  return null;
}

function setCached(section: string, period: number, data: any): void {
  const key = cacheKey(section, period);
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

async function safeCount(sql: string, label: string): Promise<number> {
  try {
    const result = await query(sql);
    const val = result.rows[0]?.c;
    const num = val === null || val === undefined || val === '' ? 0 : parseInt(val);
    console.log(`[Metrics] ${label}: ${num}`);
    return isNaN(num) ? 0 : num;
  } catch (err: any) {
    console.error(`[Metrics] ${label} FAILED:`, err.message);
    return 0;
  }
}

async function safeFloat(sql: string, label: string): Promise<number> {
  try {
    const result = await query(sql);
    const val = result.rows[0]?.c;
    const num = val === null || val === undefined || val === '' ? 0 : parseFloat(val);
    console.log(`[Metrics] ${label}: ${num}`);
    return isNaN(num) ? 0 : num;
  } catch (err: any) {
    console.error(`[Metrics] ${label} FAILED:`, err.message);
    return 0;
  }
}

async function safeQuery(sql: string, label: string): Promise<any[]> {
  try {
    const result = await query(sql);
    return result.rows || [];
  } catch (err: any) {
    console.error(`[Metrics] ${label} FAILED:`, err.message);
    return [];
  }
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

async function getOverview(period: number) {
  const totalUsersCount = Math.max(1, await safeCount('SELECT COUNT(*) as c FROM users', 'totalUsers'));

  const dau = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM user_logins WHERE login_at > ${agoSql(1)}`,
    'DAU'
  );
  const wau = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM user_logins WHERE login_at > ${agoSql(7)}`,
    'WAU'
  );
  const mau = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM user_logins WHERE login_at > ${agoSql(30)}`,
    'MAU'
  );

  const newToday = await safeCount(`SELECT COUNT(*) as c FROM users WHERE created_at > ${agoSql(1)}`, 'newToday');
  const newWeek = await safeCount(`SELECT COUNT(*) as c FROM users WHERE created_at > ${agoSql(7)}`, 'newWeek');
  const activeSubs = await safeCount(
    `SELECT COUNT(*) as c FROM users WHERE subscription_active = ${USE_SQLITE ? '1' : 'TRUE'}`,
    'activeSubs'
  );
  const pushSubs = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM push_subscriptions WHERE is_active = ${USE_SQLITE ? '1' : 'TRUE'}`,
    'pushSubs'
  );
  const revenue = await safeFloat(
    `SELECT COALESCE(SUM(amount), 0) as c FROM payments WHERE status = 'completed' AND created_at > ${agoSql(period)}`,
    'revenue'
  );

  const dormant7d = await safeCount(
    `SELECT COUNT(*) as c FROM users WHERE (last_login_at < ${agoSql(7)} OR last_login_at IS NULL) AND (is_blocked = ${USE_SQLITE ? '0' : 'FALSE'} OR is_blocked IS NULL)`,
    'dormant7d'
  );
  const dormant30d = await safeCount(
    `SELECT COUNT(*) as c FROM users WHERE (last_login_at < ${agoSql(30)} OR last_login_at IS NULL) AND (is_blocked = ${USE_SQLITE ? '0' : 'FALSE'} OR is_blocked IS NULL)`,
    'dormant30d'
  );
  const noTags = await safeCount(
    `SELECT COUNT(*) as c FROM users u WHERE NOT EXISTS (SELECT 1 FROM portfolios p WHERE p.user_id = u.id)`,
    'noTags'
  );
  const subExpiring7d = await safeCount(
    `SELECT COUNT(*) as c FROM users WHERE subscription_active = ${USE_SQLITE ? '1' : 'TRUE'} AND subscription_expires_at > ${nowSql()} AND subscription_expires_at < ${agoSql(-7)}`,
    'subExpiring7d'
  );

  return {
    total_users: totalUsersCount,
    dau,
    wau,
    mau,
    new_users_today: newToday,
    new_users_week: newWeek,
    active_subscriptions: activeSubs,
    push_subscribers: pushSubs,
    total_revenue: revenue,
    dormant_7d: dormant7d,
    dormant_30d: dormant30d,
    no_tags: noTags,
    sub_expiring_7d: subExpiring7d,
  };
}

async function getDaily(period: number) {
  const dailyRows = await safeQuery(
    USE_SQLITE
      ? `SELECT date(login_at) as day, COUNT(DISTINCT user_id) as dau FROM user_logins WHERE login_at > datetime('now', '-${period} days') GROUP BY date(login_at) ORDER BY day`
      : `SELECT DATE(login_at) as day, COUNT(DISTINCT user_id) as dau FROM user_logins WHERE login_at > NOW() - INTERVAL '${period} days' GROUP BY DATE(login_at) ORDER BY day`,
    'daily_activity'
  );

  const newUsersRows = await safeQuery(
    USE_SQLITE
      ? `SELECT date(created_at) as day, COUNT(*) as c FROM users WHERE created_at > datetime('now', '-${period} days') GROUP BY date(created_at) ORDER BY day`
      : `SELECT DATE(created_at) as day, COUNT(*) as c FROM users WHERE created_at > NOW() - INTERVAL '${period} days' GROUP BY DATE(created_at) ORDER BY day`,
    'new_users_daily'
  );

  const newUsersMap = new Map(newUsersRows.map((r: any) => [r.day, parseInt(r.c)]));

  const daily_activity = dailyRows.map((r: any) => ({
    date: r.day,
    dau: parseInt(r.dau) || 0,
    new_users: newUsersMap.get(r.day) || 0,
  }));

  const signupRows = await safeQuery(
    USE_SQLITE
      ? `SELECT date(created_at) as day, COUNT(*) as signups FROM users WHERE created_at > datetime('now', '-${period} days') GROUP BY date(created_at) ORDER BY day`
      : `SELECT DATE(created_at) as day, COUNT(*) as signups FROM users WHERE created_at > NOW() - INTERVAL '${period} days' GROUP BY DATE(created_at) ORDER BY day`,
    'signup_trend'
  );

  const signup_trend = signupRows.map((r: any) => ({
    date: r.day,
    signups: parseInt(r.signups) || 0,
  }));

  return { daily_activity, signup_trend };
}

async function getFunnel(period: number) {
  const fReg = await safeCount(
    `SELECT COUNT(*) as c FROM users WHERE created_at > ${agoSql(period)}`,
    'funnelReg'
  );
  const fLogin = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM user_logins WHERE login_at > ${agoSql(period)}`,
    'funnelLogin'
  );
  const fTag = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM portfolios WHERE created_at > ${agoSql(period)}`,
    'funnelTag'
  );
  const fRead = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM user_news_reads WHERE read_at > ${agoSql(period)}`,
    'funnelRead'
  );
  const fPay = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM payments WHERE status = 'completed' AND created_at > ${agoSql(period)}`,
    'funnelPay'
  );

  const funnel = [
    { step: 'Registered', count: fReg, pct_of_prev: 100, pct_of_total: 100 },
    { step: 'Logged In', count: fLogin, pct_of_prev: pct(fLogin, fReg), pct_of_total: pct(fLogin, fReg) },
    { step: 'Added Tag', count: fTag, pct_of_prev: pct(fTag, fLogin), pct_of_total: pct(fTag, fReg) },
    { step: 'Read Article', count: fRead, pct_of_prev: pct(fRead, fTag), pct_of_total: pct(fRead, fReg) },
    { step: 'Paid', count: fPay, pct_of_prev: pct(fPay, fRead), pct_of_total: pct(fPay, fReg) },
  ];

  return { funnel };
}

async function getRetention(period: number) {
  const retentionDays = period <= 7 ? 14 : period <= 30 ? 42 : period;
  const cohortLimit = Math.ceil(retentionDays / 7);

  const rows = await safeQuery(
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
          LIMIT ${cohortLimit}`,
    'retention'
  );

  const retention = rows.map((r: any) => ({
    cohort: r.cohort_week,
    d1: pct(parseInt(r.d1 || 0), parseInt(r.w0)),
    d7: pct(parseInt(r.d7 || 0), parseInt(r.w0)),
    d30: pct(parseInt(r.d30 || 0), parseInt(r.w0)),
  }));

  return { retention };
}

async function getSentiment(period: number) {
  const totalVotes = await safeCount(
    `SELECT COUNT(*) as c FROM sentiment_votes WHERE created_at > ${agoSql(period)}`,
    'sentimentVotes'
  );
  const uniqueVoters = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM sentiment_votes WHERE created_at > ${agoSql(period)}`,
    'sentimentVoters'
  );
  const avgStreak = await safeFloat(
    `SELECT COALESCE(AVG(streak_days), 0) as c FROM sentiment_user_windows WHERE streak_days > 0`,
    'avgStreak'
  );
  const distRows = await safeQuery(
    `SELECT vote_value, COUNT(*) as c FROM sentiment_votes WHERE created_at > ${agoSql(period)} GROUP BY vote_value`,
    'sentimentDist'
  );

  return {
    sentiment: {
      total_votes: totalVotes,
      unique_voters: uniqueVoters,
      avg_streak: avgStreak,
      distribution: {
        bullish: parseInt(distRows.find((r: any) => r.vote_value == 1)?.c) || 0,
        neutral: parseInt(distRows.find((r: any) => r.vote_value == 0)?.c) || 0,
        bearish: parseInt(distRows.find((r: any) => r.vote_value == -1)?.c) || 0,
      },
    },
  };
}

async function getTags() {
  const avgTags = await safeFloat(
    `SELECT COALESCE(AVG(tag_count), 0) as c FROM (SELECT COUNT(*) as tag_count FROM portfolios GROUP BY user_id) sub`,
    'avgTags'
  );
  const distRows = await safeQuery(
    `SELECT CASE WHEN tag_count = 1 THEN '1' WHEN tag_count BETWEEN 2 AND 3 THEN '2-3' WHEN tag_count BETWEEN 4 AND 5 THEN '4-5' ELSE '6+' END as bucket,
        COUNT(*) as c
       FROM (SELECT COUNT(*) as tag_count FROM portfolios GROUP BY user_id) sub
       GROUP BY bucket ORDER BY MIN(tag_count)`,
    'tagDist'
  );
  const topTags = await safeQuery(
    `SELECT tag_name as label, COUNT(DISTINCT user_id) as c FROM portfolios GROUP BY tag_name ORDER BY c DESC LIMIT 10`,
    'topTags'
  );

  return {
    avg_tags: avgTags,
    tag_distribution: distRows.map((r: any) => ({ label: r.bucket, value: parseInt(r.c) })),
    top_tags: topTags.map((r: any) => ({ label: r.label, value: parseInt(r.c) })),
  };
}

async function getRevenue(period: number) {
  const cohortRows = await safeQuery(
    USE_SQLITE
      ? `SELECT date(u.created_at) as cohort, COUNT(DISTINCT u.id) as users, COALESCE(SUM(p.amount), 0) as revenue
           FROM users u LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
           WHERE u.created_at > datetime('now', '-42 days')
           GROUP BY date(u.created_at) ORDER BY cohort DESC LIMIT 6`
      : `SELECT DATE(u.created_at) as cohort, COUNT(DISTINCT u.id) as users, COALESCE(SUM(p.amount), 0) as revenue
           FROM users u LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
           WHERE u.created_at > NOW() - INTERVAL '42 days'
           GROUP BY DATE(u.created_at) ORDER BY cohort DESC LIMIT 6`,
    'cohort_ltv'
  );

  const trendRows = await safeQuery(
    USE_SQLITE
      ? `SELECT date(u.created_at) as cohort, COUNT(DISTINCT u.id) as users, COALESCE(SUM(p.amount), 0) as revenue
           FROM users u LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
           WHERE u.created_at > datetime('now', '-42 days')
           GROUP BY date(u.created_at) ORDER BY cohort`
      : `SELECT DATE(u.created_at) as cohort, COUNT(DISTINCT u.id) as users, COALESCE(SUM(p.amount), 0) as revenue
           FROM users u LEFT JOIN payments p ON u.id = p.user_id AND p.status = 'completed'
           WHERE u.created_at > NOW() - INTERVAL '42 days'
           GROUP BY DATE(u.created_at) ORDER BY cohort`,
    'ltv_trend'
  );

  const ttfpRows = await safeQuery(
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
           GROUP BY bucket`,
    'ttfp'
  );

  const totalUsersCount = Math.max(1, await safeCount('SELECT COUNT(*) as c FROM users', 'totalUsers'));

  return {
    cohort_ltv: cohortRows.map((r: any) => ({
      cohort: r.cohort,
      users: parseInt(r.users) || 0,
      ltv: parseInt(r.users) > 0 ? Math.round(parseFloat(r.revenue || 0) / parseInt(r.users)) : 0,
    })),
    ltv_trend: trendRows.map((r: any) => ({
      cohort: r.cohort,
      ltv: parseInt(r.users) > 0 ? Math.round(parseFloat(r.revenue || 0) / parseInt(r.users)) : 0,
    })),
    ttfp: { distribution: ttfpRows.map((r: any) => ({ label: r.bucket, value: parseInt(r.c) })) },
    conversion_velocity: { buckets: ttfpRows.map((r: any) => ({ label: r.bucket, value: parseInt(r.c) })) },
  };
}

async function getAdoption() {
  const totalUsersCount = Math.max(1, await safeCount('SELECT COUNT(*) as c FROM users', 'totalUsers'));

  const pushCount = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM push_subscriptions WHERE is_active = ${USE_SQLITE ? '1' : 'TRUE'}`,
    'pushAdopt'
  );
  const tgCount = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM user_channels WHERE channel = 'telegram' AND is_active = ${USE_SQLITE ? '1' : 'TRUE'}`,
    'tgAdopt'
  );
  const sentimentCount = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM sentiment_votes`,
    'sentimentAdopt'
  );
  const premiumCount = await safeCount(
    `SELECT COUNT(*) as c FROM users WHERE subscription_active = ${USE_SQLITE ? '1' : 'TRUE'}`,
    'premiumAdopt'
  );

  return {
    feature_adoption: {
      push: { count: pushCount, pct: pct(pushCount, totalUsersCount) },
      telegram: { count: tgCount, pct: pct(tgCount, totalUsersCount) },
      sentiment: { count: sentimentCount, pct: pct(sentimentCount, totalUsersCount) },
      premium: { count: premiumCount, pct: pct(premiumCount, totalUsersCount) },
    },
  };
}

const handlers: Record<string, (period: number) => Promise<any>> = {
  overview: getOverview,
  daily: getDaily,
  funnel: getFunnel,
  retention: getRetention,
  sentiment: getSentiment,
  tags: getTags,
  revenue: getRevenue,
  adoption: getAdoption,
};

router.get('/metrics', adminMiddleware, async (req, res) => {
  try {
    const section = req.query.section as string;
    const period = parseInt(req.query.period as string) || 30;

    if (!section || !handlers[section]) {
      return res.status(400).json({ error: 'Invalid section', allowed: Object.keys(handlers) });
    }

    if (![1, 7, 30, 90].includes(period)) {
      return res.status(400).json({ error: 'Invalid period', allowed: [1, 7, 30, 90] });
    }

    const cached = getCached(section, period);
    if (cached) {
      console.log(`[Metrics] cache hit ${section}:${period}`);
      return res.json({ section, period, cached: true, data: cached });
    }

    const data = await handlers[section](period);
    setCached(section, period, data);

    res.json({ section, period, cached: false, data });
  } catch (err: any) {
    console.error('[Admin Metrics] Error:', err.message);
    res.status(500).json({ error: 'Failed to load metrics', details: err.message });
  }
});

export default router;
