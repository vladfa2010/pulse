/**
 * ТЗ-207 — Админ-таб «Фактчекинг»: сводка, история, деталь сессии.
 * Все эндпоинты за adminMiddleware (per-request проверка is_admin из БД).
 * Только параметризованный SQL; page_size ≤ 200.
 */

import { Router } from 'express';
import { query } from '../config/db';
import { adminMiddleware } from '../middleware/admin';
import { computeCostUsd, INPUT_USD_PER_M, OUTPUT_USD_PER_M, WEB_SEARCH_USD_PER_CALL } from '../config/factCheckPricing';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

const dateBucket = USE_SQLITE
  ? "strftime('%Y-%m-%d', s.started_at)"
  : "to_char(s.started_at, 'YYYY-MM-DD')";
const durationSec = USE_SQLITE
  ? '((julianday(s.completed_at) - julianday(s.started_at)) * 86400)'
  : 'EXTRACT(EPOCH FROM (s.completed_at - s.started_at))';

// Средние токены этапа из tokens_breakdown_json (диалект-специфичное извлечение)
function stageAvg(stage: string, dir: 'in' | 'out'): string {
  return USE_SQLITE
    ? `AVG(json_extract(s.tokens_breakdown_json, '$.${stage}.${dir}'))`
    : `AVG((s.tokens_breakdown_json->'${stage}'->>'${dir}')::numeric)`;
}

function toNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// GET /api/admin/fact-checking/stats?days=30
router.get('/fact-checking/stats', adminMiddleware, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(String(req.query.days || '30'), 10) || 30, 1), 365);
    const since = USE_SQLITE
      ? `datetime('now', '-${days} days')`
      : `NOW() - INTERVAL '${days} days'`;

    const totals = await query(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN s.status = 'completed' AND s.tokens_input = 0 THEN 1 ELSE 0 END) AS cached,
              COALESCE(SUM(s.tokens_input), 0) AS tokens_in,
              COALESCE(SUM(s.tokens_output), 0) AS tokens_out,
              SUM(CASE WHEN s.tokens_input > 0 THEN 1 ELSE 0 END) AS with_llm,
              AVG(${durationSec}) FILTER (WHERE s.status = 'completed' AND s.completed_at IS NOT NULL) AS avg_duration_sec
       FROM fact_check_sessions s
       WHERE s.started_at >= ${since}`,
      []
    );

    const stageAvgs = await query(
      `SELECT ${stageAvg('search', 'in')} AS search_in, ${stageAvg('search', 'out')} AS search_out,
              ${stageAvg('analysis', 'in')} AS analysis_in, ${stageAvg('analysis', 'out')} AS analysis_out,
              ${stageAvg('sources', 'in')} AS sources_in, ${stageAvg('sources', 'out')} AS sources_out,
              ${stageAvg('assessment', 'in')} AS assessment_in, ${stageAvg('assessment', 'out')} AS assessment_out
       FROM fact_check_sessions s
       WHERE s.started_at >= ${since} AND s.tokens_breakdown_json IS NOT NULL`,
      []
    );

    const daily = await query(
      `SELECT ${dateBucket} AS day,
              COUNT(*) AS checks,
              SUM(CASE WHEN s.status = 'completed' THEN 1 ELSE 0 END) AS completed,
              COALESCE(SUM(s.tokens_input), 0) AS tokens_in,
              COALESCE(SUM(s.tokens_output), 0) AS tokens_out
       FROM fact_check_sessions s
       WHERE s.started_at >= ${since}
       GROUP BY 1 ORDER BY 1`,
      []
    );

    const topUsers = await query(
      `SELECT u.email, u.username,
              COUNT(*) AS checks,
              COALESCE(SUM(s.tokens_input), 0) AS tokens_in,
              COALESCE(SUM(s.tokens_output), 0) AS tokens_out
       FROM fact_check_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.started_at >= ${since}
       GROUP BY u.id, u.email, u.username
       ORDER BY checks DESC
       LIMIT 10`,
      []
    );

    const errors = await query(
      `SELECT s.error_message, COUNT(*) AS count
       FROM fact_check_sessions s
       WHERE s.started_at >= ${since} AND s.status = 'failed' AND s.error_message IS NOT NULL
       GROUP BY s.error_message
       ORDER BY count DESC
       LIMIT 10`,
      []
    );

    const retries = await query(
      `SELECT COUNT(*) AS total_with_job,
              COALESCE(SUM(CASE WHEN j.max_attempts > 1 THEN 1 ELSE 0 END), 0) AS retried
       FROM fact_check_sessions s
       JOIN (SELECT news_id, user_id, MAX(attempts) AS max_attempts
             FROM fact_check_jobs GROUP BY news_id, user_id) j
         ON j.news_id = s.news_id AND j.user_id = s.user_id
       WHERE s.started_at >= ${since}`,
      []
    );

    const t = totals.rows[0] || {};
    const tokensIn = toNum(t.tokens_in);
    const tokensOut = toNum(t.tokens_out);
    const withLlm = toNum(t.with_llm);
    const total = toNum(t.total);
    const completed = toNum(t.completed);
    const cached = toNum(t.cached);

    res.json({
      period_days: days,
      totals: {
        checks: total,
        completed,
        failed: toNum(t.failed),
        cached,
        success_rate: total ? completed / total : 0,
        cache_rate: total ? cached / total : 0,
        tokens_input: tokensIn,
        tokens_output: tokensOut,
        cost_llm_usd: computeCostUsd(tokensIn, tokensOut, 0),
        cost_total_usd: computeCostUsd(tokensIn, tokensOut, withLlm),
        avg_tokens_input: total ? tokensIn / total : 0,
        avg_tokens_output: total ? tokensOut / total : 0,
        avg_duration_sec: toNum(t.avg_duration_sec),
        retried_share: toNum(retries.rows[0]?.total_with_job)
          ? toNum(retries.rows[0]?.retried) / toNum(retries.rows[0]?.total_with_job)
          : 0,
      },
      stage_avgs: stageAvgs.rows[0] || {},
      daily: daily.rows,
      top_users: topUsers.rows.map((r: any) => ({
        ...r,
        cost_usd: computeCostUsd(toNum(r.tokens_in), toNum(r.tokens_out), 0),
      })),
      errors: errors.rows,
      pricing: { input_usd_per_m: INPUT_USD_PER_M, output_usd_per_m: OUTPUT_USD_PER_M, web_search_usd_per_call: WEB_SEARCH_USD_PER_CALL },
    });
  } catch (err: any) {
    console.error('[AdminFactChecking] stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/fact-checking/list?from&to&status&user_query&page=1&page_size=50
router.get('/fact-checking/list', adminMiddleware, async (req, res) => {
  try {
    const page = Math.max(parseInt(String(req.query.page || '1'), 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(String(req.query.page_size || '50'), 10) || 50, 1), 200);
    const from = String(req.query.from || '').slice(0, 10);
    const to = String(req.query.to || '').slice(0, 10);
    const status = String(req.query.status || '').slice(0, 20);
    const userQuery = String(req.query.user_query || '').slice(0, 100);

    const where: string[] = [];
    const params: any[] = [];
    if (from) { params.push(`${from} 00:00:00`); where.push(`s.started_at >= $${params.length}`); }
    if (to) { params.push(`${to} 23:59:59`); where.push(`s.started_at <= $${params.length}`); }
    if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
    if (userQuery) {
      params.push(`%${userQuery}%`);
      where.push(`(u.email ${USE_SQLITE ? 'LIKE' : 'ILIKE'} $${params.length} OR u.username ${USE_SQLITE ? 'LIKE' : 'ILIKE'} $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const baseSql = `
      FROM fact_check_sessions s
      JOIN users u ON u.id = s.user_id
      JOIN news n ON n.id = s.news_id
      LEFT JOIN (SELECT news_id, user_id, MAX(attempts) AS attempts
                 FROM fact_check_jobs GROUP BY news_id, user_id) j
        ON j.news_id = s.news_id AND j.user_id = s.user_id
      ${whereSql}`;

    const totalRes = await query(`SELECT COUNT(*) AS count ${baseSql}`, params);
    const rowsRes = await query(
      `SELECT s.id AS session_id, s.started_at, s.completed_at, s.status, s.model,
              u.email AS user_email, u.username AS user_username,
              COALESCE(NULLIF(n.title_ru, ''), n.title_original, '') AS news_title,
              s.news_id, n.url AS news_url,
              (s.tokens_input = 0 AND s.status = 'completed') AS cached,
              s.tokens_input, s.tokens_output,
              LEFT(s.error_message, 200) AS error_message,
              j.attempts AS attempts,
              ${durationSec} AS duration_sec
       ${baseSql}
       ORDER BY s.started_at DESC
       LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
      params
    );

    res.json({
      total: parseInt(totalRes.rows[0]?.count || '0', 10),
      page,
      page_size: pageSize,
      rows: rowsRes.rows.map((r: any) => ({
        ...r,
        duration_sec: r.duration_sec != null ? Math.round(toNum(r.duration_sec)) : null,
        cost_usd: computeCostUsd(toNum(r.tokens_input), toNum(r.tokens_output), r.cached ? 0 : 1),
      })),
    });
  } catch (err: any) {
    console.error('[AdminFactChecking] list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/fact-checking/:sessionId — деталь одной проверки (модалка)
router.get('/fact-checking/:sessionId', adminMiddleware, async (req, res) => {
  try {
    const sessionId = String(req.params.sessionId).slice(0, 64);
    const result = await query(
      `SELECT s.*, u.email AS user_email, u.username AS user_username,
              COALESCE(NULLIF(n.title_ru, ''), n.title_original, '') AS news_title,
              n.url AS news_url
       FROM fact_check_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN news n ON n.id = s.news_id
       WHERE s.id = $1`,
      [sessionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const row = result.rows[0];
    let breakdown: any = null;
    if (row.tokens_breakdown_json) {
      try {
        breakdown = typeof row.tokens_breakdown_json === 'string'
          ? JSON.parse(row.tokens_breakdown_json)
          : row.tokens_breakdown_json;
      } catch { /* оставляем null */ }
    }
    let sources: any[] = [];
    if (row.sources_json) {
      try {
        const parsed = typeof row.sources_json === 'string' ? JSON.parse(row.sources_json) : row.sources_json;
        sources = Array.isArray(parsed) ? parsed.slice(0, 20) : [];
      } catch { /* оставляем пустым */ }
    }
    const cached = row.tokens_input === 0 && row.status === 'completed';
    res.json({
      ...row,
      tokens_breakdown_json: undefined,
      tokens_breakdown: breakdown,
      sources_json: undefined,
      sources,
      cached,
      cost_usd: computeCostUsd(toNum(row.tokens_input), toNum(row.tokens_output), cached ? 0 : 1),
      duration_sec: row.completed_at
        ? Math.max(0, Math.round((new Date(row.completed_at).getTime() - new Date(row.started_at).getTime()) / 1000))
        : null,
    });
  } catch (err: any) {
    console.error('[AdminFactChecking] detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
