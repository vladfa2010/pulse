/**
 * probe_tz209.mjs — живая сверка шеринга фактчека (ТЗ-209).
 *
 * Критерии приёмки (сверяются на запущенном бэкенде, BASE внутри контейнера):
 *   1. share на checked-новость → 201 {url}; публичный GET без логина → 200
 *      с title + result (analysis/sources/assessment)
 *   2. многоразовость: три GET подряд → все 200; TTL: форс expires_at в
 *      прошлое (SQL снаружи) → следующий GET 410
 *   3. идемпотентность: повторный share той же новости → 200 с тем же URL
 *   4. отрицательные: not_checked → 409; без auth → 401; фейковый id → 404;
 *      невалидный токен (длина) → 404
 *
 * Запуск на VPS:
 *   docker cp scripts/probes/probe_tz209.mjs pulse-backend:/tmp/probe.mjs
 *   docker exec pulse-backend node /tmp/probe.mjs <checkedNewsId> <uncheckedNewsId> [baseUrl]
 *
 * Квота (критерий 4 приёмки, 429 на 21-й ссылке) проверяется отдельно —
 * SQL-вставкой 20 фиктивных строк (см. ниже), затем share → 429.
 * TTL-форс: UPDATE fact_check_shares SET expires_at = '2020-01-01' WHERE token='…'
 */

const BASE = process.argv[5] || 'http://127.0.0.1:3001'
const J = (r) => r.text().then((t) => { try { return JSON.parse(t) } catch { return { __raw: t } } })

const adminEmail = process.env.PROBE_ADMIN_EMAIL || 'vladfa@ya.ru'
const adminPassword = process.env.PROBE_ADMIN_PASSWORD || '!1234567890'

const login = await J(await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: adminEmail, password: adminPassword }),
}))
if (!login.token) { console.log('FAIL login:', JSON.stringify(login).slice(0, 200)); process.exit(1) }
console.log('OK: login')
const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' }

const checkedId = process.argv[2]
const uncheckedId = process.argv[3]

// 1. share → 201 {url}
const r1 = await fetch(BASE + '/api/news/' + checkedId + '/fact-check/share', { method: 'POST', headers: H })
const b1 = await J(r1)
console.log('SHARE: HTTP', r1.status, '| url =', b1.url)
if (r1.status !== 201 && r1.status !== 200) { console.log('FAIL share:', JSON.stringify(b1).slice(0, 200)); process.exit(1) }
const token = b1.url.split('/').pop()

// 2. многоразовость: три публичных GET подряд
for (let i = 1; i <= 3; i++) {
  const rg = await fetch(BASE + '/api/fact-check/shared/' + token)
  const bg = await J(rg)
  const r = bg.result || {}
  console.log('OPEN #%d: HTTP %s | title=%s | analysis=%s sources=%s assessment=%s',
    i, rg.status, JSON.stringify((bg.news?.title || '').slice(0, 50)),
    !!r.analysis, (r.sources || []).length, !!r.assessment)
}

// 3. идемпотентность: повторный share → тот же URL
const r2 = await fetch(BASE + '/api/news/' + checkedId + '/fact-check/share', { method: 'POST', headers: H })
const b2 = await J(r2)
console.log('IDEMPOTENT: HTTP', r2.status, '| same url =', b2.url === b1.url)

// 4. отрицательные кейсы
const rNc = await fetch(BASE + '/api/news/' + uncheckedId + '/fact-check/share', { method: 'POST', headers: H })
console.log('NOT_CHECKED share: HTTP', rNc.status, '| error =', (await J(rNc)).error)
const rNoAuth = await fetch(BASE + '/api/news/' + checkedId + '/fact-check/share', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
console.log('NO_AUTH share: HTTP', rNoAuth.status)
const rFake = await fetch(BASE + '/api/news/00000000-0000-0000-0000-000000000000/fact-check/share', { method: 'POST', headers: H })
console.log('FAKE_NEWS share: HTTP', rFake.status)
const rBadToken = await fetch(BASE + '/api/fact-check/shared/zzz')
console.log('BAD_TOKEN open: HTTP', rBadToken.status)

console.log('TOKEN=' + token)
// Дальше вручную (psql): TTL-форс → повторный GET → ожидается 410.
// Далее DELETE fact_check_shares WHERE token='…' (чистка после прогона).
