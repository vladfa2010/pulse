import { Router } from 'express';
import { adminMiddleware } from './admin';
import { query } from '../config/db';
import { nowSql } from '../utils/nowSql';
import { getRadioTtsMetrics } from '../services/radioMetrics';
import {
  buildSessionSankey,
  SANKEY_DEFAULT_DEPTH,
  SANKEY_DEPTH_OPTIONS,
} from '../services/adminSessionSankey';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

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

// ТЗ-119 Задача 6.4: ловим label упавших safe*-запросов текущего запроса,
// чтобы в ответе /metrics отличать «нет данных» от «метрика сломалась».
// Устанавливается только на время обработки одной секции (см. роут ниже).
let collectErrors: string[] | null = null;

async function safeCount(sql: string, label: string): Promise<number> {
  try {
    const result = await query(sql);
    const val = result.rows[0]?.c;
    const num = val === null || val === undefined || val === '' ? 0 : parseInt(val);
    console.log(`[Metrics] ${label}: ${num}`);
    return isNaN(num) ? 0 : num;
  } catch (err: any) {
    console.error(`[Metrics] ${label} FAILED:`, err.message);
    collectErrors?.push(label);
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
    collectErrors?.push(label);
    return 0;
  }
}

async function safeQuery(sql: string, label: string): Promise<any[]> {
  try {
    const result = await query(sql);
    return result.rows || [];
  } catch (err: any) {
    console.error(`[Metrics] ${label} FAILED:`, err.message);
    collectErrors?.push(label);
    return [];
  }
}

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

async function getOverview(period: number) {
  const totalUsersCount = Math.max(1, await safeCount('SELECT COUNT(*) as c FROM users', 'totalUsers'));

  // ТЗ-119 Задача 1: активность — из user_sessions (touchPresence на каждый
  // запрос с токеном), а не user_logins: парольный логин редок (JWT 7 дней),
  // по логинам DAU/WAU/MAU занижены.
  const dau = await safeCount(
    USE_SQLITE
      ? `SELECT COUNT(DISTINCT user_id) as c FROM user_sessions WHERE last_connected_at > datetime('now', '-1 days')`
      : `SELECT COUNT(DISTINCT user_id) as c FROM user_sessions WHERE last_connected_at > NOW() - INTERVAL '1 day'`,
    'DAU'
  );
  const wau = await safeCount(
    USE_SQLITE
      ? `SELECT COUNT(DISTINCT user_id) as c FROM user_sessions WHERE last_connected_at > datetime('now', '-7 days')`
      : `SELECT COUNT(DISTINCT user_id) as c FROM user_sessions WHERE last_connected_at > NOW() - INTERVAL '7 days'`,
    'WAU'
  );
  const mau = await safeCount(
    USE_SQLITE
      ? `SELECT COUNT(DISTINCT user_id) as c FROM user_sessions WHERE last_connected_at > datetime('now', '-30 days')`
      : `SELECT COUNT(DISTINCT user_id) as c FROM user_sessions WHERE last_connected_at > NOW() - INTERVAL '30 days'`,
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
    `SELECT COALESCE(SUM(amount), 0) as c FROM payments WHERE status = 'completed' AND paid_at > ${agoSql(period)}`,
    'revenue'
  );

  // ТЗ-119 Задача 4: деньги — по paid_at (момент оплаты), не created_at (создание pending).
  // ТЗ-119 Задача 1: dormant — по user_sessions: нет строки (ни разу не заходил
  // с токеном) ИЛИ последний визит старше N дней. Без строки — dormant до первого
  // визита, это корректно.
  const dormant7d = await safeCount(
    USE_SQLITE
      ? `SELECT COUNT(*) as c FROM users u
         WHERE (NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.user_id = u.id)
                OR (SELECT MAX(s.last_connected_at) FROM user_sessions s WHERE s.user_id = u.id) < datetime('now', '-7 days'))
           AND (u.is_blocked = 0 OR u.is_blocked IS NULL)`
      : `SELECT COUNT(*) as c FROM users u
         WHERE (NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.user_id = u.id)
                OR (SELECT MAX(s.last_connected_at) FROM user_sessions s WHERE s.user_id = u.id) < NOW() - INTERVAL '7 days')
           AND (u.is_blocked = FALSE OR u.is_blocked IS NULL)`,
    'dormant7d'
  );
  const dormant30d = await safeCount(
    USE_SQLITE
      ? `SELECT COUNT(*) as c FROM users u
         WHERE (NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.user_id = u.id)
                OR (SELECT MAX(s.last_connected_at) FROM user_sessions s WHERE s.user_id = u.id) < datetime('now', '-30 days'))
           AND (u.is_blocked = 0 OR u.is_blocked IS NULL)`
      : `SELECT COUNT(*) as c FROM users u
         WHERE (NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.user_id = u.id)
                OR (SELECT MAX(s.last_connected_at) FROM user_sessions s WHERE s.user_id = u.id) < NOW() - INTERVAL '30 days')
           AND (u.is_blocked = FALSE OR u.is_blocked IS NULL)`,
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
  // ТЗ-119 Задача 1.2: активность дня = UNION логинов и событийной истории
  // (DISTINCT user_id, day). У user_sessions нет истории — одна строка на юзера.
  const dailyRows = await safeQuery(
    USE_SQLITE
      ? `SELECT day, COUNT(*) as dau FROM (
           SELECT DISTINCT user_id, date(login_at) as day FROM user_logins WHERE login_at > datetime('now', '-${period} days')
           UNION
           SELECT DISTINCT user_id, date(created_at) as day FROM user_events WHERE created_at > datetime('now', '-${period} days')
         ) t GROUP BY day ORDER BY day`
      : `SELECT day, COUNT(*) as dau FROM (
           SELECT DISTINCT user_id, DATE(login_at) as day FROM user_logins WHERE login_at > NOW() - INTERVAL '${period} days'
           UNION
           SELECT DISTINCT user_id, DATE(created_at) as day FROM user_events WHERE created_at > NOW() - INTERVAL '${period} days'
         ) t GROUP BY day ORDER BY day`,
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
  // ТЗ-119 Задача 2: единая когорта — все шаги только внутри пользователей,
  // зарегистрированных за период. Каждый следующий шаг дополнительно
  // вложен в предыдущий (user_id IN (...)), тогда pct_of_prev ≤ 100 по
  // построению: чтение новостей и подписка на тег не требуют друг друга,
  // без вложения воронка на реальных данных давала 300–400%.
  const cohort = `SELECT id FROM users WHERE created_at > ${agoSql(period)}`;
  const loginSet = `SELECT DISTINCT user_id FROM user_logins WHERE login_at > ${agoSql(period)} AND user_id IN (${cohort})`;
  const tagSet = `SELECT DISTINCT user_id FROM portfolios WHERE created_at > ${agoSql(period)} AND user_id IN (${loginSet})`;
  const readSet = `SELECT DISTINCT user_id FROM user_news_reads WHERE read_at > ${agoSql(period)} AND user_id IN (${tagSet})`;

  const fReg = await safeCount(
    `SELECT COUNT(*) as c FROM users WHERE created_at > ${agoSql(period)}`,
    'funnelReg'
  );
  const fLogin = await safeCount(
    `SELECT COUNT(*) as c FROM (${loginSet}) t`,
    'funnelLogin'
  );
  const fTag = await safeCount(
    `SELECT COUNT(*) as c FROM (${tagSet}) t`,
    'funnelTag'
  );
  const fRead = await safeCount(
    `SELECT COUNT(*) as c FROM (${readSet}) t`,
    'funnelRead'
  );
  const fPay = await safeCount(
    `SELECT COUNT(DISTINCT user_id) as c FROM payments WHERE status = 'completed' AND paid_at > ${agoSql(period)} AND user_id IN (${readSet})`,
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
  // ТЗ-119 Задача 5.1: когорты — по неделям (подпись cohort_week правдивая);
  // активность dN = last_login_at (после фикса reset-password — честный)
  // ИЛИ событие user_events позже created_at+N; незрелым когортам (не
  // исполнилось N дней) — null вместо 0, фронт рендерит «—».
  const retentionDays = period <= 7 ? 14 : period <= 30 ? 42 : period;
  const cohortLimit = Math.ceil(retentionDays / 7);

  const rows = await safeQuery(
    USE_SQLITE
      ? `SELECT strftime('%Y-W%W', created_at) as cohort_week,
            COUNT(*) as w0,
            COUNT(CASE WHEN last_login_at > datetime(created_at, '+1 days')
                        OR EXISTS (SELECT 1 FROM user_events e WHERE e.user_id = users.id
                                   AND e.created_at > datetime(users.created_at, '+1 days')) THEN 1 END) as d1,
            COUNT(CASE WHEN last_login_at > datetime(created_at, '+7 days')
                        OR EXISTS (SELECT 1 FROM user_events e WHERE e.user_id = users.id
                                   AND e.created_at > datetime(users.created_at, '+7 days')) THEN 1 END) as d7,
            COUNT(CASE WHEN last_login_at > datetime(created_at, '+30 days')
                        OR EXISTS (SELECT 1 FROM user_events e WHERE e.user_id = users.id
                                   AND e.created_at > datetime(users.created_at, '+30 days')) THEN 1 END) as d30,
            MAX(created_at) as last_created
          FROM users
          WHERE created_at > datetime('now', '-${retentionDays} days')
          GROUP BY strftime('%Y-W%W', created_at)
          ORDER BY cohort_week DESC
          LIMIT ${cohortLimit}`
      : `SELECT DATE_TRUNC('week', created_at) as cohort_week,
            COUNT(*) as w0,
            COUNT(CASE WHEN last_login_at > created_at + INTERVAL '1 days'
                        OR EXISTS (SELECT 1 FROM user_events e WHERE e.user_id = users.id
                                   AND e.created_at > users.created_at + INTERVAL '1 days') THEN 1 END) as d1,
            COUNT(CASE WHEN last_login_at > created_at + INTERVAL '7 days'
                        OR EXISTS (SELECT 1 FROM user_events e WHERE e.user_id = users.id
                                   AND e.created_at > users.created_at + INTERVAL '7 days') THEN 1 END) as d7,
            COUNT(CASE WHEN last_login_at > created_at + INTERVAL '30 days'
                        OR EXISTS (SELECT 1 FROM user_events e WHERE e.user_id = users.id
                                   AND e.created_at > users.created_at + INTERVAL '30 days') THEN 1 END) as d30,
            MAX(created_at) as last_created
          FROM users
          WHERE created_at > NOW() - INTERVAL '${retentionDays} days'
          GROUP BY DATE_TRUNC('week', created_at)
          ORDER BY cohort_week DESC
          LIMIT ${cohortLimit}`,
    'retention'
  );

  const retention = rows.map((r: any) => {
    const w0 = parseInt(r.w0);
    const lastCreated = new Date(r.last_created).getTime();
    // Когорта зрелая по N дням, когда «дожил» до N дней самый поздний юзер.
    const mature = (days: number) => lastCreated + days * 86400000 < Date.now();
    return {
      cohort: USE_SQLITE ? r.cohort_week : new Date(r.cohort_week).toISOString().slice(0, 10),
      d1: mature(1) ? pct(parseInt(r.d1 || 0), w0) : null,
      d7: mature(7) ? pct(parseInt(r.d7 || 0), w0) : null,
      d30: mature(30) ? pct(parseInt(r.d30 || 0), w0) : null,
    };
  });

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

async function getOnline(_period: number) {
  const onlineNow = await safeCount(
    USE_SQLITE
      ? `SELECT COUNT(DISTINCT user_id) as c FROM user_sessions WHERE last_connected_at > datetime('now', '-15 minutes')`
      : `SELECT COUNT(DISTINCT user_id) as c FROM user_sessions WHERE last_connected_at > NOW() - INTERVAL '15 minutes'`,
    'onlineNow'
  );

  const historyRows = await safeQuery(
    USE_SQLITE
      ? `SELECT
          strftime('%Y-%m-%d %H:%M', datetime((strftime('%s', last_connected_at) / 1800) * 1800, 'unixepoch')) as slot,
          COUNT(DISTINCT user_id) as users
         FROM user_sessions
         WHERE last_connected_at > datetime('now', '-12 hours')
         GROUP BY slot
         ORDER BY slot`
      : `SELECT
          DATE_TRUNC('hour', last_connected_at) + INTERVAL '30 min' * (EXTRACT(minute FROM last_connected_at)::int / 30) as slot,
          COUNT(DISTINCT user_id) as users
         FROM user_sessions
         WHERE last_connected_at > NOW() - INTERVAL '12 hours'
         GROUP BY slot
         ORDER BY slot`,
    'onlineHistory'
  );

  return {
    online_now: onlineNow,
    history: historyRows.map((r: any) => ({ slot: r.slot, users: parseInt(r.users) || 0 })),
  };
}

// Последний completed-платёж каждого юзера с активной подпиской.
// Подписчик без платежа (admin-grant) сюда не попадает → 0 в mrr_actual.
async function getActiveSubsLastPayments() {
  return safeQuery(
    `SELECT u.subscription_plan as plan_id, p.amount, p.billing_cycle, p.duration_days
     FROM users u
     JOIN payments p ON p.user_id = u.id AND p.status = 'completed'
       AND p.paid_at = (SELECT MAX(p2.paid_at) FROM payments p2
                        WHERE p2.user_id = u.id AND p2.status = 'completed')
     WHERE u.subscription_active = ${USE_SQLITE ? '1' : 'TRUE'}
       AND (u.subscription_expires_at IS NULL OR u.subscription_expires_at > ${nowSql()})`,
    'activeSubsPayments'
  );
}

async function getPlans(_period: number) {
  const rows = await safeQuery(
    USE_SQLITE
      ? `SELECT sp.id, sp.name, sp.price, sp.plan_level,
            COUNT(u.id) as subscribers
         FROM subscription_plans sp
         LEFT JOIN users u ON u.subscription_plan = sp.id AND u.subscription_active = 1
         WHERE sp.deleted_at IS NULL
         GROUP BY sp.id, sp.name, sp.price, sp.plan_level
         ORDER BY sp.plan_level`
      : `SELECT sp.id, sp.name, sp.price, sp.plan_level,
            COUNT(u.id) as subscribers
         FROM subscription_plans sp
         LEFT JOIN users u ON u.subscription_plan = sp.id AND u.subscription_active = TRUE
         WHERE sp.deleted_at IS NULL
         GROUP BY sp.id, sp.name, sp.price, sp.plan_level
         ORDER BY sp.plan_level`,
    'plans'
  );

  // ТЗ-119 Задача 4.3: revenue = mrr_actual (нормированный последний платёж
  // активных подписчиков плана), не прайсовая SUM(sp.price).
  const payRows = await getActiveSubsLastPayments();
  const revenueByPlan = new Map<string, number>();
  for (const r of payRows) {
    const norm =
      r.billing_cycle === 'monthly' ? parseFloat(r.amount)
      : r.billing_cycle === 'yearly' ? parseFloat(r.amount) / 12
      : r.billing_cycle === 'quarterly' ? parseFloat(r.amount) / 3
      : r.billing_cycle === 'weekly' ? parseFloat(r.amount) * 30 / 7
      : parseFloat(r.amount) * 30 / Math.max(parseInt(r.duration_days) || 0, 1);
    revenueByPlan.set(r.plan_id, (revenueByPlan.get(r.plan_id) || 0) + (isFinite(norm) ? norm : 0));
  }

  return {
    plans: rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      price: parseFloat(r.price) || 0,
      subscribers: parseInt(r.subscribers) || 0,
      revenue: Math.round((revenueByPlan.get(r.id) || 0) * 100) / 100,
    })),
  };
}

async function getMRR(_period: number) {
  // ТЗ-119 Задача 4.1: MRR = нормированные последние платежи АКТИВНЫХ
  // подписчиков (не «платежи за 30 дней» — подписка, оплаченная 31 день
  // назад, иначе исчезает из MRR).
  const payRows = await getActiveSubsLastPayments();
  const normOne = (r: any): number => {
    const amount = parseFloat(r.amount) || 0;
    switch (r.billing_cycle) {
      case 'monthly': return amount;
      case 'yearly': return amount / 12;
      case 'quarterly': return amount / 3;
      case 'weekly': return amount * 30 / 7;
      default: return amount * 30 / Math.max(parseInt(r.duration_days) || 0, 1);
    }
  };
  const mrr = payRows.reduce((sum: number, r: any) => sum + normOne(r), 0);

  // Прайсовая сумма по тем же активным подписчикам — подпись для фронта.
  const listRows = await safeQuery(
    `SELECT COALESCE(SUM(sp.price), 0) as c
     FROM users u
     JOIN subscription_plans sp ON sp.id = u.subscription_plan
     WHERE u.subscription_active = ${USE_SQLITE ? '1' : 'TRUE'}
       AND (u.subscription_expires_at IS NULL OR u.subscription_expires_at > ${nowSql()})`,
    'mrrList'
  );
  const mrrList = parseFloat(listRows[0]?.c) || 0;

  const trendRows = await safeQuery(
    USE_SQLITE
      ? `SELECT strftime('%Y-%m', paid_at) as month,
            COALESCE(SUM(
              CASE
                WHEN billing_cycle = 'monthly' THEN amount
                WHEN billing_cycle = 'yearly' THEN amount / 12.0
                WHEN billing_cycle = 'quarterly' THEN amount / 3.0
                WHEN billing_cycle = 'weekly' THEN amount * 30.0 / 7
                ELSE amount * 30.0 / MAX(COALESCE(duration_days, 0), 1)
              END
            ), 0) as mrr
         FROM payments
         WHERE status = 'completed'
         GROUP BY month
         ORDER BY month DESC
         LIMIT 6`
      : `SELECT DATE_TRUNC('month', paid_at) as month,
            COALESCE(SUM(
              CASE
                WHEN billing_cycle = 'monthly' THEN amount
                WHEN billing_cycle = 'yearly' THEN amount / 12.0
                WHEN billing_cycle = 'quarterly' THEN amount / 3.0
                WHEN billing_cycle = 'weekly' THEN amount * 30.0 / 7
                ELSE amount * 30.0 / GREATEST(COALESCE(duration_days, 0), 1)
              END
            ), 0) as mrr
         FROM payments
         WHERE status = 'completed'
         GROUP BY month
         ORDER BY month DESC
         LIMIT 6`,
    'mrrTrend'
  );

  return {
    mrr: Math.round(mrr),
    mrr_list: Math.round(mrrList),
    arr: Math.round(mrr * 12),
    trend: trendRows.map((r: any) => ({ month: r.month, mrr: Math.round(parseFloat(r.mrr) || 0) })),
  };
}

async function getPromos(_period: number) {
  // ТЗ-119 Задача 3: деньги — только по платежам с этим promo_code (колонки
  // promo_code пишет services/promo.ts при применении промо). JOIN через
  // user_id раньше приписывал промо ВСЕ платежи пользователя (и с удвоением
  // при нескольких uses). uses остаются по user_promo_uses.
  const rows = await safeQuery(
    USE_SQLITE
      ? `SELECT pc.id, pc.code, pc.discount_value as discount, pc.discount_type,
            (SELECT COUNT(DISTINCT pu.user_id) FROM user_promo_uses pu WHERE pu.promo_code_id = pc.id) as uses,
            (SELECT COUNT(DISTINCT p.user_id) FROM payments p WHERE p.promo_code = pc.code AND p.status = 'completed') as converted_to_paid,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.promo_code = pc.code AND p.status = 'completed'), 0) as revenue
         FROM promo_codes pc
         ORDER BY uses DESC
         LIMIT 20`
      : `SELECT pc.id, pc.code, pc.discount_value as discount, pc.discount_type,
            (SELECT COUNT(DISTINCT pu.user_id) FROM user_promo_uses pu WHERE pu.promo_code_id = pc.id) as uses,
            (SELECT COUNT(DISTINCT p.user_id) FROM payments p WHERE p.promo_code = pc.code AND p.status = 'completed') as converted_to_paid,
            COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.promo_code = pc.code AND p.status = 'completed'), 0) as revenue
         FROM promo_codes pc
         ORDER BY uses DESC
         LIMIT 20`,
    'promos'
  );

  return {
    promos: rows.map((r: any) => ({
      id: r.id,
      code: r.code,
      discount: parseInt(r.discount) || 0,
      discount_type: r.discount_type,
      uses: parseInt(r.uses) || 0,
      converted_to_paid: parseInt(r.converted_to_paid) || 0,
      revenue: parseFloat(r.revenue) || 0,
    })),
  };
}

async function getEngagement(_period: number) {
  const avgEvents = await safeFloat(
    USE_SQLITE
      ? `SELECT COALESCE(AVG(cnt), 0) as c
         FROM (
           SELECT user_id, date(created_at) as day, COUNT(*) as cnt
           FROM user_events
           WHERE created_at > datetime('now', '-7 days')
           GROUP BY user_id, date(created_at)
         ) t`
      : `SELECT COALESCE(AVG(cnt), 0) as c
         FROM (
           SELECT user_id, DATE(created_at) as day, COUNT(*) as cnt
           FROM user_events
           WHERE created_at > NOW() - INTERVAL '7 days'
           GROUP BY user_id, DATE(created_at)
         ) t`,
    'avgEvents'
  );

  const distRows = await safeQuery(
    USE_SQLITE
      ? `SELECT CASE
            WHEN cnt = 1 THEN '1'
            WHEN cnt <= 5 THEN '2-5'
            WHEN cnt <= 10 THEN '6-10'
            WHEN cnt <= 20 THEN '11-20'
            ELSE '21+'
          END as bucket,
          COUNT(*) as users
         FROM (
           SELECT user_id, date(created_at) as day, COUNT(*) as cnt
           FROM user_events
           WHERE created_at > datetime('now', '-7 days')
           GROUP BY user_id, date(created_at)
         ) t
         GROUP BY bucket
         ORDER BY MIN(cnt)`
      : `SELECT CASE
            WHEN cnt = 1 THEN '1'
            WHEN cnt <= 5 THEN '2-5'
            WHEN cnt <= 10 THEN '6-10'
            WHEN cnt <= 20 THEN '11-20'
            ELSE '21+'
          END as bucket,
          COUNT(*) as users
         FROM (
           SELECT user_id, DATE(created_at) as day, COUNT(*) as cnt
           FROM user_events
           WHERE created_at > NOW() - INTERVAL '7 days'
           GROUP BY user_id, DATE(created_at)
         ) t
         GROUP BY bucket
         ORDER BY MIN(cnt)`,
    'engagementDist'
  );

  return {
    avg_events: avgEvents,
    distribution: distRows.map((r: any) => ({ label: r.bucket, value: parseInt(r.users) || 0 })),
  };
}

async function getChurn(_period: number) {
  // ТЗ-119 Задача 5.2: churned = подписка неактивна ИЛИ истекла, И нет
  // completed-платежа позже first_payment+Nд (yearly с будущим expires_at
  // «нет платежа 30 дней» — не churn). Когорты, которым не исполнилось
  // 30/90 дней, дают null rate — фронт рендерит «—».
  const rows = await safeQuery(
    USE_SQLITE
      ? `WITH first_payments AS (
           SELECT user_id, MIN(paid_at) as first_payment
           FROM payments
           WHERE status = 'completed'
           GROUP BY user_id
         ),
         cohort_stats AS (
           SELECT
             strftime('%Y-%m', fp.first_payment) as cohort,
             COUNT(DISTINCT fp.user_id) as total_subs,
             COUNT(DISTINCT CASE WHEN (u.subscription_active = 0 OR u.subscription_expires_at < datetime('now'))
                                  AND p2.user_id IS NULL THEN fp.user_id END) as churned_30d,
             COUNT(DISTINCT CASE WHEN (u.subscription_active = 0 OR u.subscription_expires_at < datetime('now'))
                                  AND p3.user_id IS NULL THEN fp.user_id END) as churned_90d,
             MAX(fp.first_payment) as last_fp
           FROM first_payments fp
           JOIN users u ON u.id = fp.user_id
           LEFT JOIN payments p2 ON p2.user_id = fp.user_id
             AND p2.status = 'completed'
             AND p2.paid_at > datetime(fp.first_payment, '+30 days')
           LEFT JOIN payments p3 ON p3.user_id = fp.user_id
             AND p3.status = 'completed'
             AND p3.paid_at > datetime(fp.first_payment, '+90 days')
           GROUP BY strftime('%Y-%m', fp.first_payment)
         )
         SELECT cohort, total_subs, churned_30d, churned_90d, last_fp
         FROM cohort_stats
         ORDER BY cohort DESC
         LIMIT 6`
      : `WITH first_payments AS (
           SELECT user_id, MIN(paid_at) as first_payment
           FROM payments
           WHERE status = 'completed'
           GROUP BY user_id
         ),
         cohort_stats AS (
           SELECT
             DATE_TRUNC('month', fp.first_payment) as cohort,
             COUNT(DISTINCT fp.user_id) as total_subs,
             COUNT(DISTINCT CASE WHEN (u.subscription_active = FALSE OR u.subscription_expires_at < NOW())
                                  AND p2.user_id IS NULL THEN fp.user_id END) as churned_30d,
             COUNT(DISTINCT CASE WHEN (u.subscription_active = FALSE OR u.subscription_expires_at < NOW())
                                  AND p3.user_id IS NULL THEN fp.user_id END) as churned_90d,
             MAX(fp.first_payment) as last_fp
           FROM first_payments fp
           JOIN users u ON u.id = fp.user_id
           LEFT JOIN payments p2 ON p2.user_id = fp.user_id
             AND p2.status = 'completed'
             AND p2.paid_at > fp.first_payment + INTERVAL '30 days'
           LEFT JOIN payments p3 ON p3.user_id = fp.user_id
             AND p3.status = 'completed'
             AND p3.paid_at > fp.first_payment + INTERVAL '90 days'
           GROUP BY DATE_TRUNC('month', fp.first_payment)
         )
         SELECT cohort, total_subs, churned_30d, churned_90d, last_fp
         FROM cohort_stats
         ORDER BY cohort DESC
         LIMIT 6`,
    'churn'
  );

  return {
    cohorts: rows.map((r: any) => {
      const total = parseInt(r.total_subs) || 0;
      const c30 = parseInt(r.churned_30d) || 0;
      const c90 = parseInt(r.churned_90d) || 0;
      const lastFp = new Date(r.last_fp).getTime();
      const mature = (days: number) => lastFp + days * 86400000 < Date.now();
      return {
        month: USE_SQLITE ? r.cohort : new Date(r.cohort).toISOString().slice(0, 10),
        total_subs: total,
        churned_30d: c30,
        churned_90d: c90,
        churn_rate_30d: mature(30) && total > 0 ? Math.round((c30 / total) * 1000) / 10 : null,
        churn_rate_90d: mature(90) && total > 0 ? Math.round((c90 / total) * 1000) / 10 : null,
      };
    }),
  };
}

// ТЗ-122: визуализация потока действий пользователей (sankey / bubbles / timeline).
// Единая лента: user_events (минус admin_*) + прочтения статей user_news_reads.
// Сессия — разрыв между событиями > 1800 сек. Переходы считаются только внутри сессии,
// серии одинаковых подряд схлопываются (X→X не пишем). Агрегат (без userId) кэшируется.
// ТЗ-122/ТЗ-124: общие кирпичи CTE. ОДНО определение событий и сессии для
// flow (ТЗ-122) и user-paths (ТЗ-124) — два разных определения сессии = бомба.
const CONTENT_EVENT_TYPES = ['read_article', 'page_view_feed'];

// events CTE: синтетический read_article из user_news_reads + admin_%-фильтр.
// periodDays = null — полная история (ТЗ-124: окна 7d/30d и last_event без
// period-фильтра, иначе расходимся с эталоном probe_tz124 блок 4).
// functionsOnly — исключить контентные события ДО подсчёта (scope=functions).
function buildEventsCte(periodDays: number | null, opts: { userId?: string | null; functionsOnly?: boolean } = {}): string {
  const userFilter = opts.userId ? ` AND user_id = '${opts.userId}'` : '';
  const periodFilter = periodDays ? ` AND created_at > ${agoSql(periodDays)}` : '';
  const contentFilter = opts.functionsOnly
    ? ` AND event_type NOT IN ('${CONTENT_EVENT_TYPES.join("','")}')`
    : '';
  const readPeriodFilter = periodDays ? ` AND read_at > ${agoSql(periodDays)}` : '';
  const readBranch = opts.functionsOnly
    ? ''
    : `
    UNION ALL
    SELECT user_id, 'read_article' AS event_type, read_at AS created_at FROM user_news_reads
    WHERE 1 = 1${readPeriodFilter}${userFilter}`;
  return `WITH events AS (
    SELECT user_id, event_type, created_at FROM user_events
    WHERE event_type NOT LIKE 'admin_%'${periodFilter}${userFilter}${contentFilter}${readBranch}
  )`;
}

// Разрыв > 1800 сек = новая сессия (ТЗ-122)
const GAP_EXPR = USE_SQLITE
  ? `(julianday(created_at) - julianday(prev_at)) * 86400 > 1800`
  : `EXTRACT(EPOCH FROM (created_at - prev_at)) > 1800`;
const LEAD_GAP_EXPR = USE_SQLITE
  ? `(julianday(next_at) - julianday(created_at)) * 86400 > 1800`
  : `EXTRACT(EPOCH FROM (next_at - created_at)) > 1800`;

// lagged + sessed: нумерация сессий окном (одинакова для PG и SQLite)
const SESSED_CTE = `,
  lagged AS (
    SELECT user_id, event_type, created_at,
           LAG(created_at) OVER (PARTITION BY user_id ORDER BY created_at) AS prev_at
    FROM events
  ),
  sessed AS (
    SELECT user_id, event_type, created_at,
           SUM(CASE WHEN prev_at IS NULL OR ${GAP_EXPR} THEN 1 ELSE 0 END)
             OVER (PARTITION BY user_id ORDER BY created_at) AS session_id
    FROM lagged
  )`;

async function getFlowData(period: number, userId: string | null): Promise<any> {
  if (!userId) {
    const cached = getCached('flow:all', period);
    if (cached) {
      console.log(`[Metrics] cache hit flow:all:${period}`);
      return cached;
    }
  }

  const eventsCte = buildEventsCte(period, { userId });

  // Пары prev_type→event_type внутри сессии; X→X отсекаем (схлопывание серий),
  // переход через границу сессии не считаем (LAG по партиции user_id+session_id).
  const transitionsRows = await safeQuery(
    `${eventsCte}${SESSED_CTE},
        pairs AS (
          SELECT event_type,
                 LAG(event_type) OVER (PARTITION BY user_id, session_id ORDER BY created_at) AS prev_type
          FROM sessed
        )
        SELECT prev_type AS "from", event_type AS "to", COUNT(*) AS count
        FROM pairs
        WHERE prev_type IS NOT NULL AND prev_type <> event_type
        GROUP BY prev_type, event_type`,
    'flowTransitions'
  );

  const sortedTransitions = transitionsRows
    .map((r: any) => ({ from: r.from, to: r.to, count: parseInt(r.count) || 0 }))
    .sort((a: any, b: any) => b.count - a.count);
  // Топ-30 связок, остаток сворачиваем в other по from
  const transitions = sortedTransitions.slice(0, 30);
  const otherByFrom = new Map<string, number>();
  for (const r of sortedTransitions.slice(30)) {
    otherByFrom.set(r.from, (otherByFrom.get(r.from) || 0) + r.count);
  }
  for (const [from, count] of otherByFrom) {
    transitions.push({ from, to: 'other', count });
  }

  const sessionStartsRows = await safeQuery(
    `${eventsCte},
        lagged AS (
          SELECT user_id, event_type, created_at,
                 LAG(created_at) OVER (PARTITION BY user_id ORDER BY created_at) AS prev_at
          FROM events
        )
        SELECT event_type, COUNT(*) AS count
        FROM lagged
        WHERE prev_at IS NULL OR ${GAP_EXPR}
        GROUP BY event_type
        ORDER BY count DESC
        LIMIT 10`,
    'flowSessionStarts'
  );
  const session_starts = sessionStartsRows.map((r: any) => ({
    event_type: r.event_type,
    count: parseInt(r.count) || 0,
  }));

  const bubblesRows = await safeQuery(
    USE_SQLITE
      ? `${eventsCte}
        SELECT CAST(strftime('%H', created_at) AS INT) AS hour, event_type, COUNT(*) AS count
        FROM events
        GROUP BY hour, event_type`
      : `${eventsCte}
        SELECT EXTRACT(HOUR FROM created_at) AS hour, event_type, COUNT(*) AS count
        FROM events
        GROUP BY EXTRACT(HOUR FROM created_at), event_type`,
    'flowBubbles'
  );
  const bubbles = bubblesRows.map((r: any) => ({
    hour: parseInt(r.hour) || 0,
    event_type: r.event_type,
    count: parseInt(r.count) || 0,
  }));

  // Таймлайн — только per-user: последние 300 событий, отдаём ASC
  let timeline: any[] = [];
  if (userId) {
    const timelineRows = await safeQuery(
      `${eventsCte}
      SELECT t, type FROM (
        SELECT created_at AS t, event_type AS type FROM events
        ORDER BY created_at DESC
        LIMIT 300
      ) sub
      ORDER BY t ASC`,
      'flowTimeline'
    );
    timeline = timelineRows.map((r: any) => ({
      t: USE_SQLITE ? `${String(r.t).replace(' ', 'T')}Z` : new Date(r.t).toISOString(),
      type: r.type,
    }));
  }

  const result = { period, user_id: userId, transitions, session_starts, bubbles, timeline };
  if (!userId) setCached('flow:all', period, result);
  return result;
}

// ТЗ-124: дашборд «Пути пользователей» — сводная таблица юзеров, exit-точки,
// цепочки к целям и матрица ветвлений. Переиспользует CTE и сессионизацию ТЗ-122.
// Правила малой выборки: связки count<3 → other, проценты только с n.
async function getUserPathsData(period: number, scope: 'all' | 'functions', depth: number = SANKEY_DEFAULT_DEPTH): Promise<any> {
  const fullKey = `paths:${period}:${scope}:${depth}`;
  const cachedEntry = cache.get(fullKey);
  if (cachedEntry && cachedEntry.expiresAt > Date.now()) return cachedEntry.data;
  if (cachedEntry) cache.delete(fullKey);

  const functionsOnly = scope === 'functions';
  const iso = (v: any) =>
    v ? (USE_SQLITE ? `${String(v).replace(' ', 'T')}Z` : new Date(v).toISOString()) : null;

  // 1. users — сводная таблица. last_event и окна 7d/30d считаем по ПОЛНОЙ
  //    истории (без period-фильтра — сверка с эталоном probe_tz124 блок 4);
  //    top_event_type / top_transition — за period.
  const aggRows = await safeQuery(
    `${buildEventsCte(null)},
    agg AS (
      SELECT user_id,
             MAX(created_at) AS last_event_at,
             SUM(CASE WHEN created_at > ${agoSql(7)} THEN 1 ELSE 0 END) AS e7,
             SUM(CASE WHEN created_at > ${agoSql(30)} THEN 1 ELSE 0 END) AS e30
      FROM events GROUP BY user_id
    )
    SELECT user_id, last_event_at, e7, e30 FROM agg`,
    'pathsUsersAgg'
  );
  const lastTypeRows = await safeQuery(
    `${buildEventsCte(null)},
    ranked AS (
      SELECT user_id, event_type,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
      FROM events
    )
    SELECT user_id, event_type FROM ranked WHERE rn = 1`,
    'pathsUsersLastType'
  );
  const topEventRows = await safeQuery(
    `${buildEventsCte(period)},
    top AS (
      SELECT user_id, event_type, COUNT(*) AS c,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC, event_type) AS rn
      FROM events GROUP BY user_id, event_type
    )
    SELECT user_id, event_type, c FROM top WHERE rn = 1`,
    'pathsUsersTopEvent'
  );
  const topTransitionRows = await safeQuery(
    `${buildEventsCte(period)}${SESSED_CTE},
    pairs AS (
      SELECT user_id, event_type,
             LAG(event_type) OVER (PARTITION BY user_id, session_id ORDER BY created_at) AS prev_type
      FROM sessed
    ),
    top AS (
      SELECT user_id, prev_type, event_type, COUNT(*) AS c,
             ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY COUNT(*) DESC, prev_type, event_type) AS rn
      FROM pairs
      WHERE prev_type IS NOT NULL AND prev_type <> event_type
      GROUP BY user_id, prev_type, event_type
    )
    SELECT user_id, prev_type AS "from", event_type AS "to", c FROM top WHERE rn = 1`,
    'pathsUsersTopTransition'
  );
  const ltvRows = await safeQuery(
    `SELECT user_id, COALESCE(SUM(amount), 0) AS ltv FROM payments WHERE status = 'completed' GROUP BY user_id`,
    'pathsLtv'
  );
  const userRows = await safeQuery(
    `SELECT id, email, username, subscription_plan, subscription_active FROM users`,
    'pathsUsersList'
  );

  const aggMap = new Map(aggRows.map((r: any) => [r.user_id, r]));
  const lastTypeMap = new Map(lastTypeRows.map((r: any) => [r.user_id, r.event_type]));
  const topEventMap = new Map(topEventRows.map((r: any) => [r.user_id, r]));
  const topTransMap = new Map(topTransitionRows.map((r: any) => [r.user_id, r]));
  const ltvMap = new Map(ltvRows.map((r: any) => [r.user_id, parseFloat(r.ltv) || 0]));

  const users = userRows
    .map((u: any) => {
      const a = aggMap.get(u.id);
      const te = topEventMap.get(u.id);
      const tt = topTransMap.get(u.id);
      return {
        user_id: u.id,
        email: u.email,
        username: u.username,
        plan: u.subscription_plan,
        subscription_active: !!u.subscription_active,
        last_event_at: a ? iso(a.last_event_at) : null,
        last_event_type: a ? lastTypeMap.get(u.id) ?? null : null,
        events_7d: a ? parseInt(a.e7) || 0 : 0,
        events_30d: a ? parseInt(a.e30) || 0 : 0,
        top_event_type: te ? te.event_type : null,
        top_transition: tt ? { from: tt.from, to: tt.to, count: parseInt(tt.c) || 0 } : null,
        ltv: ltvMap.get(u.id) || 0,
      };
    })
    .sort((a: any, b: any) => {
      if (!a.last_event_at && !b.last_event_at) return 0;
      if (!a.last_event_at) return 1;
      if (!b.last_event_at) return -1;
      return a.last_event_at < b.last_event_at ? 1 : -1;
    })
    .slice(0, 500);

  // 2. exit_points — последнее событие каждой сессии, топ-10 + other.
  //    read_article как точка выхода — норма (дочитал и ушёл).
  const exitRows = await safeQuery(
    `${buildEventsCte(period)},
    lagged AS (
      SELECT user_id, event_type, created_at,
             LEAD(created_at) OVER (PARTITION BY user_id ORDER BY created_at) AS next_at
      FROM events
    )
    SELECT event_type, COUNT(*) AS count FROM lagged
    WHERE next_at IS NULL OR ${LEAD_GAP_EXPR}
    GROUP BY event_type ORDER BY count DESC`,
    'pathsExit'
  );
  const exits = exitRows.map((r: any) => ({ event_type: r.event_type, count: parseInt(r.count) || 0 }));
  const exitOtherCount = exits.slice(10).reduce((s: number, e: any) => s + e.count, 0);
  const exit_points = [
    ...exits.slice(0, 10),
    ...(exitOtherCount > 0 ? [{ event_type: 'other', count: exitOtherCount }] : []),
  ];

  // 3. conversion_paths — до 3 предшествующих событий в той же сессии перед
  //    целью; если цель стартует сессию — последние 3 события юзера перед ней.
  //    Серии повторов схлопнуты (правило из раздела 1 ТЗ).
  const GOALS = ['payment_completed', 'subscription_activated', 'subscription_cancelled'];
  const convRows = await safeQuery(
    `${buildEventsCte(period)}${SESSED_CTE},
    goals AS (
      SELECT ROW_NUMBER() OVER (ORDER BY user_id, created_at) AS goal_id,
             user_id, event_type AS goal, created_at AS goal_at, session_id
      FROM sessed
      WHERE event_type IN ('${GOALS.join("','")}')
    ),
    prev_sess AS (
      SELECT g.goal_id, e.event_type, e.created_at,
             ROW_NUMBER() OVER (PARTITION BY g.goal_id ORDER BY e.created_at DESC) AS rn
      FROM goals g
      JOIN sessed e ON e.user_id = g.user_id AND e.session_id = g.session_id AND e.created_at < g.goal_at
    ),
    prev_any AS (
      SELECT g.goal_id, e.event_type, e.created_at,
             ROW_NUMBER() OVER (PARTITION BY g.goal_id ORDER BY e.created_at DESC) AS rn
      FROM goals g
      JOIN sessed e ON e.user_id = g.user_id AND e.created_at < g.goal_at
      WHERE NOT EXISTS (SELECT 1 FROM prev_sess p WHERE p.goal_id = g.goal_id)
    )
    SELECT gs.goal_id, gs.goal,
           COALESCE(ps.event_type, pa.event_type) AS event_type,
           COALESCE(ps.created_at, pa.created_at) AS prev_at,
           COALESCE(ps.rn, pa.rn) AS rn
    FROM goals gs
    LEFT JOIN prev_sess ps ON ps.goal_id = gs.goal_id AND ps.rn <= 5
    LEFT JOIN prev_any pa ON pa.goal_id = gs.goal_id AND pa.rn <= 5
    ORDER BY gs.goal_id, rn`,
    'pathsConversion'
  );
  const byGoalId = new Map<number, { goal: string; prev: { event_type: string; created_at: string }[] }>();
  for (const r of convRows) {
    if (!byGoalId.has(r.goal_id)) byGoalId.set(r.goal_id, { goal: r.goal, prev: [] });
    if (r.event_type) byGoalId.get(r.goal_id)!.prev.push({ event_type: r.event_type, created_at: r.prev_at });
  }
  const pathCountsByGoal = new Map<string, Map<string, number>>();
  for (const { goal, prev } of byGoalId.values()) {
    const asc = [...prev].sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const collapsed: string[] = [];
    for (const p of asc) {
      if (collapsed.length === 0 || collapsed[collapsed.length - 1] !== p.event_type) collapsed.push(p.event_type);
    }
    const path = [...collapsed.slice(-3), goal];
    const key = path.join('→');
    if (!pathCountsByGoal.has(goal)) pathCountsByGoal.set(goal, new Map());
    const counts = pathCountsByGoal.get(goal)!;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const conversion_paths: any[] = [];
  for (const [goal, counts] of pathCountsByGoal) {
    const entries = [...counts.entries()]
      .map(([key, count]) => ({ goal, path: key.split('→'), count }))
      .sort((a, b) => b.count - a.count);
    const shown = entries.filter((e) => e.count >= 3).slice(0, 5);
    const shownKeys = new Set(shown.map((e) => e.path.join('→')));
    const otherCount = entries.filter((e) => !shownKeys.has(e.path.join('→'))).reduce((s, e) => s + e.count, 0);
    conversion_paths.push(...shown);
    if (otherCount > 0) conversion_paths.push({ goal, path: ['other'], count: otherCount });
  }

  // 4. branching — матрица ветвлений по сессионным переходам за period.
  //    scope=functions: контентные события исключены ДО подсчёта (buildEventsCte).
  const branchRows = await safeQuery(
    `${buildEventsCte(period, { functionsOnly })}${SESSED_CTE},
    pairs AS (
      SELECT event_type,
             LAG(event_type) OVER (PARTITION BY user_id, session_id ORDER BY created_at) AS prev_type
      FROM sessed
    )
    SELECT prev_type AS "from", event_type AS "to", COUNT(*) AS count
    FROM pairs
    WHERE prev_type IS NOT NULL AND prev_type <> event_type
    GROUP BY prev_type, event_type`,
    'pathsBranching'
  );
  const byFrom = new Map<string, { to: string; count: number }[]>();
  for (const r of branchRows) {
    const from = r.from as string;
    if (!byFrom.has(from)) byFrom.set(from, []);
    byFrom.get(from)!.push({ to: r.to, count: parseInt(r.count) || 0 });
  }
  const branching = [...byFrom.entries()]
    .map(([from, list]) => {
      const total_out = list.reduce((s, x) => s + x.count, 0);
      const sorted = [...list].sort((a, b) => b.count - a.count || (a.to < b.to ? -1 : 1));
      const shown = sorted.filter((x) => x.count >= 3).slice(0, 5);
      const shownTos = new Set(shown.map((x) => x.to));
      const otherCount = sorted.filter((x) => !shownTos.has(x.to)).reduce((s, x) => s + x.count, 0);
      const next = shown.map((x) => ({ to: x.to, count: x.count, share: pct(x.count, total_out) }));
      if (otherCount > 0) next.push({ to: 'other', count: otherCount, share: pct(otherCount, total_out) });
      return { from, total_out, next };
    })
    .sort((a, b) => b.total_out - a.total_out)
    .slice(0, 20);

  // 5. sankey — типичные пути сессий, глубина depth (ТЗ-124 v3, 3/5/10).
  //    Серии одинаковых подряд схлопнуты (LAG), уровни — ROW_NUMBER; ограничения
  //    lvl в SQL НЕТ — coverage считается по полным длинам, обрезка до depth
  //    и схлопы малых потоков — в чистой функции buildSessionSankey.
  const sankeyRows = await safeQuery(
    `${buildEventsCte(period, { functionsOnly })}${SESSED_CTE},
    collapsed AS (
      SELECT user_id, session_id, event_type, created_at,
             LAG(event_type) OVER (PARTITION BY user_id, session_id ORDER BY created_at) AS prev_type
      FROM sessed
    ),
    lvled AS (
      SELECT user_id, session_id, event_type,
             ROW_NUMBER() OVER (PARTITION BY user_id, session_id ORDER BY created_at) AS lvl
      FROM collapsed
      WHERE prev_type IS NULL OR prev_type <> event_type
    )
    SELECT user_id, session_id, event_type, lvl FROM lvled
    ORDER BY user_id, session_id, lvl`,
    'pathsSankey'
  );
  const sessionPathsMap = new Map<string, string[]>();
  for (const r of sankeyRows) {
    const key = `${r.user_id}#${r.session_id}`;
    if (!sessionPathsMap.has(key)) sessionPathsMap.set(key, []);
    sessionPathsMap.get(key)!.push(r.event_type);
  }
  const sankeyBuilt = buildSessionSankey([...sessionPathsMap.values()], depth);
  const sankey = { levels: depth, nodes: sankeyBuilt.nodes, links: sankeyBuilt.links, coverage: sankeyBuilt.coverage };

  const result = { period, scope, users, exit_points, conversion_paths, branching, sankey };
  cache.set(fullKey, { data: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// Экспорт для MCP-инструмента admin_metrics (ТЗ-183): тот же набор секций, без HTTP-слоя
export const handlers: Record<string, (period: number) => Promise<any>> = {
  overview: getOverview,
  daily: getDaily,
  funnel: getFunnel,
  retention: getRetention,
  sentiment: getSentiment,
  tags: getTags,
  revenue: getRevenue,
  adoption: getAdoption,
  online: getOnline,
  plans: getPlans,
  mrr: getMRR,
  promos: getPromos,
  engagement: getEngagement,
  churn: getChurn,
  // Radio TTS — in-memory с момента старта процесса (period игнорируется)
  radio: async (_period: number) => getRadioTtsMetrics(),
  // ТЗ-122: визуализация потока действий (агрегат по всем пользователям)
  flow: (period: number) => getFlowData(period, null),
  // ТЗ-124: дашборд «Пути пользователей» (scope=all, depth=3; переключатели
  // scope/depth — вторым запросом к /metrics/user-paths,
  // кэш paths:<period>:<scope>:<depth>)
  paths: (period: number) => getUserPathsData(period, 'all', SANKEY_DEFAULT_DEPTH),
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
      return res.json({ section, period, cached: true, errors: cached.errors || [], data: cached.data });
    }

    collectErrors = [];
    try {
      const data = await handlers[section](period);
      const errors = collectErrors || [];
      setCached(section, period, { data, errors });
      res.json({ section, period, cached: false, errors, data });
    } finally {
      collectErrors = null;
    }
  } catch (err: any) {
    console.error('[Admin Metrics] Error:', err.message);
    res.status(500).json({ error: 'Failed to load metrics', details: err.message });
  }
});

router.get('/metrics/at-risk-accounts', adminMiddleware, async (req, res) => {
  try {
    const type = req.query.type as string;
    let limit = parseInt(req.query.limit as string) || 50;
    if (limit < 1) limit = 1;
    if (limit > 200) limit = 200;

    const labels: Record<string, string> = {
      dormant_7d: 'Не заходили 7+ дней',
      dormant_30d: 'Не заходили 30+ дней',
      no_tags: 'Без тегов',
      sub_expiring: 'Подписка истекает ≤7 дней',
    };

    if (!labels[type]) {
      return res.status(400).json({ error: 'Invalid type', allowed: Object.keys(labels) });
    }

    let sql: string;
    if (type === 'dormant_7d') {
      // ТЗ-119 Задача 1: dormant — по user_sessions.last_connected_at (как в overview);
      // колонку last_login_at в SELECT оставляем — контракт AtRiskModal не меняем.
      sql = USE_SQLITE
        ? `SELECT id, email, username, subscription_active, subscription_expires_at, last_login_at
           FROM users u
           WHERE (NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.user_id = u.id)
                  OR (SELECT MAX(s.last_connected_at) FROM user_sessions s WHERE s.user_id = u.id) < datetime('now', '-7 days'))
             AND (is_blocked = 0 OR is_blocked IS NULL)
           ORDER BY last_login_at IS NULL, last_login_at DESC
           LIMIT ${limit}`
        : `SELECT id, email, username, subscription_active, subscription_expires_at, last_login_at
           FROM users u
           WHERE (NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.user_id = u.id)
                  OR (SELECT MAX(s.last_connected_at) FROM user_sessions s WHERE s.user_id = u.id) < NOW() - INTERVAL '7 days')
             AND (is_blocked = FALSE OR is_blocked IS NULL)
           ORDER BY last_login_at DESC NULLS LAST
           LIMIT ${limit}`;
    } else if (type === 'dormant_30d') {
      sql = USE_SQLITE
        ? `SELECT id, email, username, subscription_active, subscription_expires_at, last_login_at
           FROM users u
           WHERE (NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.user_id = u.id)
                  OR (SELECT MAX(s.last_connected_at) FROM user_sessions s WHERE s.user_id = u.id) < datetime('now', '-30 days'))
             AND (is_blocked = 0 OR is_blocked IS NULL)
           ORDER BY last_login_at IS NULL, last_login_at DESC
           LIMIT ${limit}`
        : `SELECT id, email, username, subscription_active, subscription_expires_at, last_login_at
           FROM users u
           WHERE (NOT EXISTS (SELECT 1 FROM user_sessions s WHERE s.user_id = u.id)
                  OR (SELECT MAX(s.last_connected_at) FROM user_sessions s WHERE s.user_id = u.id) < NOW() - INTERVAL '30 days')
             AND (is_blocked = FALSE OR is_blocked IS NULL)
           ORDER BY last_login_at DESC NULLS LAST
           LIMIT ${limit}`;
    } else if (type === 'no_tags') {
      sql = USE_SQLITE
        ? `SELECT id, email, username, subscription_active, subscription_expires_at, last_login_at
           FROM users
           WHERE NOT EXISTS (SELECT 1 FROM portfolios p WHERE p.user_id = users.id)
           ORDER BY created_at DESC
           LIMIT ${limit}`
        : `SELECT id, email, username, subscription_active, subscription_expires_at, last_login_at
           FROM users
           WHERE NOT EXISTS (SELECT 1 FROM portfolios p WHERE p.user_id = users.id)
           ORDER BY created_at DESC
           LIMIT ${limit}`;
    } else {
      // sub_expiring
      sql = USE_SQLITE
        ? `SELECT id, email, username, subscription_active, subscription_expires_at, last_login_at
           FROM users
           WHERE subscription_active = 1
             AND subscription_expires_at > datetime('now')
             AND subscription_expires_at < datetime('now', '+7 days')
           ORDER BY subscription_expires_at ASC
           LIMIT ${limit}`
        : `SELECT id, email, username, subscription_active, subscription_expires_at, last_login_at
           FROM users
           WHERE subscription_active = TRUE
             AND subscription_expires_at > NOW()
             AND subscription_expires_at < NOW() + INTERVAL '7 days'
           ORDER BY subscription_expires_at ASC
           LIMIT ${limit}`;
    }

    const result = await query(sql);
    const accounts = (result.rows || []).map((r: any) => ({
      id: r.id,
      email: r.email,
      username: r.username,
      subscription_active: USE_SQLITE ? Boolean(r.subscription_active) : r.subscription_active,
      subscription_expires_at: r.subscription_expires_at,
      last_login_at: r.last_login_at,
    }));

    res.json({
      type,
      label: labels[type],
      count: accounts.length,
      accounts,
    });
  } catch (err: any) {
    console.error('[Admin Metrics] At-risk accounts error:', err.message);
    res.status(500).json({ error: 'Failed to load at-risk accounts', details: err.message });
  }
});

// ТЗ-122: визуализация потока действий (sankey / bubbles / timeline per-user)
router.get('/metrics/flow', adminMiddleware, async (req, res) => {
  try {
    const period = Number(req.query.period);
    if (![1, 7, 30, 90].includes(period)) {
      return res.status(400).json({ error: 'Invalid period', allowed: [1, 7, 30, 90] });
    }

    const userId = req.query.user_id as string | undefined;
    if (userId && !/^[0-9a-fA-F-]{36}$/.test(userId)) {
      return res.status(400).json({ error: 'Invalid user_id' });
    }

    const data = await getFlowData(period, userId || null);
    res.json(data);
  } catch (err: any) {
    console.error('[Admin Metrics] Flow error:', err.message);
    res.status(500).json({ error: 'Failed to load flow' });
  }
});

// ТЗ-124: дашборд «Пути пользователей» — сводка по всем юзерам + scope для
// матрицы ветвлений (all | functions)
router.get('/metrics/user-paths', adminMiddleware, async (req, res) => {
  try {
    const period = Number(req.query.period);
    if (![1, 7, 30, 90].includes(period)) {
      return res.status(400).json({ error: 'Invalid period', allowed: [1, 7, 30, 90] });
    }
    const scope = (req.query.scope as string) || 'all';
    if (!['all', 'functions'].includes(scope)) {
      return res.status(400).json({ error: 'Invalid scope', allowed: ['all', 'functions'] });
    }
    // ТЗ-124 v3: глубина Санки 3/5/10 (дефолт 3); невалидное значение — дефолт
    const depthRaw = parseInt(String(req.query.depth ?? '3'), 10);
    const depth = SANKEY_DEPTH_OPTIONS.includes(depthRaw as any) ? depthRaw : SANKEY_DEFAULT_DEPTH;

    const data = await getUserPathsData(period, scope as 'all' | 'functions', depth);
    res.json(data);
  } catch (err: any) {
    console.error('[Admin Metrics] User paths error:', err.message);
    res.status(500).json({ error: 'Failed to load user paths' });
  }
});

export default router;
