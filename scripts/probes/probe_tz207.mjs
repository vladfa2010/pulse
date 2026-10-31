/**
 * probe_tz207.mjs — живая сверка админ-API учёта токенов фактчека (ТЗ-207).
 *
 * Проверяет эндпоинты /api/admin/fact-checking/{stats,list,:sessionId}:
 *   - stats: сводка (checks/completed/failed/cached, токены, стоимость, ретраи)
 *   - list: пагинация, total
 *   - detail: токены + разбивка по этапам pipeline
 *   - auth: без токена -> 401
 *
 * Запуск на VPS:
 *   docker cp scripts/probes/probe_tz207.mjs pulse-backend:/tmp/probe.mjs
 *   docker exec pulse-backend node /tmp/probe.mjs [days] [baseUrl]
 *
 * Учёт токенов начался с момента деплоя ТЗ-207 — у сессий до него токены 0,
 * это ожидаемо. Для проверки записи токенов закажите реальный фактчек и
 * дождитесь completion (~5 мин), затем перезапустите probe.
 */

const BASE = process.argv[4] || 'http://127.0.0.1:3001'
const DAYS = parseInt(process.argv[3] || '30', 10)
const J = (r) => r.text().then((t) => { try { return JSON.parse(t) } catch { console.log('NON-JSON:', r.status, t.slice(0, 200)); process.exit(1) } })

const adminEmail = process.env.PROBE_ADMIN_EMAIL || 'vladfa@ya.ru'
const adminPassword = process.env.PROBE_ADMIN_PASSWORD || '!1234567890'

const login = await J(await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: adminEmail, password: adminPassword }),
}))
if (!login.token) { console.log('FAIL login:', JSON.stringify(login).slice(0, 200)); process.exit(1) }
console.log('OK: login')
const H = { Authorization: 'Bearer ' + login.token }

const stats = await J(await fetch(BASE + '/api/admin/fact-checking/stats?days=' + DAYS, { headers: H }))
const t = stats.totals || {}
console.log('STATS: checks=%s completed=%s failed=%s cached=%s tokens_in=%s tokens_out=%s cost_llm=$%s cost_total=$%s retried=%s%% avg_dur=%ss',
  t.checks, t.completed, t.failed, t.cached, t.tokens_input, t.tokens_output,
  Number(t.cost_llm_usd || 0).toFixed(4), Number(t.cost_total_usd || 0).toFixed(4),
  Math.round((t.retried_share || 0) * 100), Math.round(t.avg_duration_sec || 0))
console.log('STAGE_AVGS:', JSON.stringify(stats.stage_avgs))
console.log('DAILY points:', (stats.daily || []).length, '| TOP users:', (stats.top_users || []).length, '| ERRORS:', (stats.errors || []).length)

const list = await J(await fetch(BASE + '/api/admin/fact-checking/list?page=1&page_size=5', { headers: H }))
const row = (list.rows || [])[0]
console.log('LIST: total=%s', list.total)
if (!row) { console.log('INFO: no sessions yet'); process.exit(0) }
console.log('LIST first: status=%s cached=%s tokens_in=%s tokens_out=%s cost=$%s dur=%ss',
  row.status, row.cached, row.tokens_input, row.tokens_output,
  Number(row.cost_usd || 0).toFixed(4), Math.round(row.duration_sec || 0))

const d = await J(await fetch(BASE + '/api/admin/fact-checking/' + row.session_id, { headers: H }))
console.log('DETAIL: status=%s tokens_in=%s tokens_out=%s model=%s breakdown=%s',
  d.status, d.tokens_input, d.tokens_output, d.model, JSON.stringify(d.tokens_breakdown))

const noTok = await fetch(BASE + '/api/admin/fact-checking/stats?days=7')
console.log('AUTH: no-token HTTP %s (expect 401/403)', noTok.status)
