/**
 * probe_tz208.mjs — живая сверка гейта фактчека по фича-флагу (ТЗ-208).
 *
 * Проверяет критерии приёмки на запущенном бэкенде (по умолчанию
 * http://127.0.0.1:3001 внутри контейнера pulse-backend):
 *   1. premium → subscription.features.factcheck === true; free → false
 *   2. free POST /api/news/:id/fact-check → 403 с динамическим списком тарифов
 *   3. premium POST → гейт пропускает (не 403)
 *   4. free GET checked-результата → 200 (результат виден без подписки)
 *
 * Запуск на VPS:
 *   docker cp scripts/probes/probe_tz208.mjs pulse-backend:/tmp/probe.mjs
 *   docker exec pulse-backend node /tmp/probe.mjs <newsId> <checkedNewsId> [baseUrl]
 *
 * newsId — любая новость (для free-юзера запрос отсекается гейтом до воркера,
 * денег не тратит). checkedNewsId — новость с fact_check_status='checked'.
 * Создаёт и удаляет тестового free-юзера (SQL DELETE через psql нужен снаружи,
 * здесь юзер остаётся — удаляйте вручную по FREE_USER_ID в выводе).
 */

const BASE = process.argv[5] || 'http://127.0.0.1:3001'
const J = (r) => r.json()

const login = async (email, password) => {
  const r = await J(await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  }))
  if (!r.token) { console.log('FAIL login', email, JSON.stringify(r).slice(0, 150)); process.exit(1) }
  return r.token
}

const adminEmail = process.env.PROBE_ADMIN_EMAIL || 'vladfa@ya.ru'
const adminPassword = process.env.PROBE_ADMIN_PASSWORD || '!1234567890'

// 1. premium: features в payload
const tAdmin = await login(adminEmail, adminPassword)
const me1 = await J(await fetch(BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + tAdmin } }))
console.log('CRIT-1 premium: features.factcheck =', me1.user.subscription.features?.factcheck, '| plan =', me1.user.subscription.plan)

// 2. регистрация free-юзера
const email = 'tz208-test-' + Date.now() + '@example.com'
const reg = await J(await fetch(BASE + '/api/auth/register', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, username: 'tz208test', password: 'Password208!' }),
}))
if (!reg.token) { console.log('REG FAILED:', JSON.stringify(reg).slice(0, 300)); process.exit(1) }
const tFree = reg.token
const me2 = await J(await fetch(BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + tFree } }))
console.log('CRIT-1 free: features.factcheck =', me2.user.subscription.features?.factcheck, '| plan =', me2.user.subscription.plan)
console.log('FREE_USER_ID=' + me2.user.id)

// 3. негатив: free POST -> 403
const newsId = process.argv[2]
const rFree = await fetch(BASE + '/api/news/' + newsId + '/fact-check', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + tFree, 'Content-Type': 'application/json' },
})
const bFree = await J(rFree)
console.log('CRIT-2/4 free POST: HTTP', rFree.status, '| error =', bFree.error,
  '| min_plan =', bFree.min_plan, '| min_price =', bFree.min_price,
  '| upgrade_required =', bFree.upgrade_required)

// 4. позитив: premium POST -> гейт пропускает (не 403).
// ВНИМАНИЕ: если новость имеет текст ≥10 символов, запустится реальный
// платный прогон фактчека. Для проверки без расходов берите новость с
// коротким текстом (ответ 422) либо accept-ите стоимость одной проверки.
const rPrem = await fetch(BASE + '/api/news/' + newsId + '/fact-check', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + tAdmin, 'Content-Type': 'application/json' },
})
const bPrem = await J(rPrem)
console.log('CRIT-4 premium POST: HTTP', rPrem.status, '(гейт пропустил, если не 403)', JSON.stringify(bPrem).slice(0, 150))

// 5. GET результата без подписки
const checkedId = process.argv[3]
const rGet = await fetch(BASE + '/api/news/' + checkedId + '/fact-check', { headers: { Authorization: 'Bearer ' + tFree } })
const bGet = await J(rGet)
console.log('CRIT-5 free GET checked-результата: HTTP', rGet.status, '| status =', bGet.status)
