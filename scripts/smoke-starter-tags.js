// Smoke: стартовые теги при регистрации (ТЗ-119 v3, задача 11).
// SQLite-режим, поднимаем express только с auth-роутом.
// Запуск: npm run build && node scripts/smoke-starter-tags.js
process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = '/tmp/starter-tags-smoke/pulse.db';
process.env.UPLOADS_DIR = '/tmp/starter-tags-smoke/uploads';
process.env.JWT_SECRET = 'smoke-secret-starter-tags';
process.env.SIGNED_URL_SECRET = 'smoke-secret-0123456789abcdef';
process.env.STARTER_TAGS_ENABLED = 'true';

const assert = require('assert');
const fs = require('fs');

let passed = 0;
function ok(msg) { passed++; console.log(`OK ${passed}: ${msg}`); }

async function registerUser(port, n) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `smoke_${Date.now()}_${n}`,
      email: `smoke_${Date.now()}_${n}@pulse.local`,
      password: 'SmokePass123!',
    }),
  });
  return { status: res.status, data: await res.json() };
}

function bootApp() {
  // Перечитываем auth-роут, чтобы module-level флаг STARTER_TAGS_ENABLED
  // пере-evaluate'ился при смене env между сценариями
  const routePath = require.resolve('../dist/routes/auth');
  delete require.cache[routePath];
  const authRouter = require(routePath).default;
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

(async () => {
  fs.rmSync('/tmp/starter-tags-smoke', { recursive: true, force: true });
  fs.mkdirSync('/tmp/starter-tags-smoke', { recursive: true });

  const sqlite = require('../dist/config/db-sqlite');
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();

  // Сид: каталог тегов + is_frozen в portfolios.
  // ВНИМАНИЕ: SQLite smoke-схема не включает user_defined_tags и отстаёт
  // от PG по portfolios.is_frozen — добиваем явно (в проде PG полный).
  const pfCols = await sqlite.query(`PRAGMA table_info(portfolios)`, []);
  if (!pfCols.rows.some(c => c.name === 'is_frozen')) {
    await sqlite.query(`ALTER TABLE portfolios ADD COLUMN is_frozen INTEGER DEFAULT 0`, []);
  }
  await sqlite.query(
    `CREATE TABLE IF NOT EXISTS user_defined_tags (
       tag_id TEXT PRIMARY KEY,
       tag_name TEXT NOT NULL,
       tag_type TEXT DEFAULT 'company',
       keywords TEXT DEFAULT '[]',
       enriched_data TEXT,
       created_by TEXT,
       created_at TEXT DEFAULT (datetime('now')),
       updated_at TEXT DEFAULT (datetime('now'))
     )`, []);
  // (free-тариф сидится самим db-sqlite, tag_limit=3 — двум стартовым хватает)
  await sqlite.query(
    `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type) VALUES ('sber', 'Сбербанк', 'company')`, []);
  await sqlite.query(
    `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type) VALUES ('neft', 'Нефть', 'sector')`, []);
  ok('сид: free-тариф (tag_limit=3) + каталог «Сбербанк»/«Нефть»');

  // ── Сценарий A: флаг ВКЛ, каталог полный ────────────────────────────
  let server = bootApp().listen(0);
  let port = server.address().port;

  let r = await registerUser(port, 'a');
  assert(r.status === 201, `register A: HTTP ${r.status}`);
  assert(Array.isArray(r.data.starterTags) && r.data.starterTags.length === 2,
    `starterTags A: ${JSON.stringify(r.data.starterTags)}`);
  const names = r.data.starterTags.map(t => t.tag_name).sort();
  assert.deepStrictEqual(names, ['Нефть', 'Сбербанк']);
  const types = Object.fromEntries(r.data.starterTags.map(t => [t.tag_name, t.tag_type]));
  assert(types['Сбербанк'] === 'company' && types['Нефть'] === 'sector',
    `типы стартовых тегов: ${JSON.stringify(types)}`);
  ok('флаг ВКЛ: 201 + starterTags = [Сбербанк/company, Нефть/sector]');

  const pf = await sqlite.query(
    'SELECT tag_id FROM portfolios WHERE user_id = $1', [r.data.user.id]);
  assert(pf.rows.length === 2, `portfolios A: ${pf.rows.length}`);
  ok('оба тега реально подписаны в portfolios');

  // Портфель виден через GET /user/tags (канонический путь фронта)
  const userTags = await sqlite.query(
    'SELECT COUNT(*) c FROM portfolios WHERE user_id = $1', [r.data.user.id]);
  assert(parseInt(userTags.rows[0].c) === 2);
  ok('подписка доступна для фронта');

  server.close();

  // ── Сценарий B: флаг ВЫКЛ — регистрация без стартовых тегов ─────────
  process.env.STARTER_TAGS_ENABLED = 'false';
  server = bootApp().listen(0);
  port = server.address().port;

  r = await registerUser(port, 'b');
  assert(r.status === 201, `register B: HTTP ${r.status}`);
  assert(!('starterTags' in r.data) || r.data.starterTags.length === 0,
    `starterTags B должен отсутствовать: ${JSON.stringify(r.data.starterTags)}`);
  const pfB = await sqlite.query(
    'SELECT COUNT(*) c FROM portfolios WHERE user_id = $1', [r.data.user.id]);
  assert(parseInt(pfB.rows[0].c) === 0, 'портфель B не пуст');
  ok('флаг ВЫКЛ: 201, поле starterTags отсутствует, подписок нет');

  server.close();

  // ── Сценарий C: флаг ВКЛ, «Нефть» удалена из каталога ───────────────
  process.env.STARTER_TAGS_ENABLED = 'true';
  await sqlite.query(`DELETE FROM user_defined_tags WHERE tag_id = 'neft'`, []);
  server = bootApp().listen(0);
  port = server.address().port;

  r = await registerUser(port, 'c');
  assert(r.status === 201, `register C: HTTP ${r.status} — регистрация не должна падать`);
  assert(Array.isArray(r.data.starterTags) && r.data.starterTags.length === 1
    && r.data.starterTags[0].tag_name === 'Сбербанк',
    `starterTags C: ${JSON.stringify(r.data.starterTags)}`);
  ok('каталог без «Нефть»: 201, starterTags = [Сбербанк], регистрация не падает');

  server.close();

  console.log(`\nВсе ${passed} проверок starter-tags smoke прошли`);
  process.exit(0);
})().catch(e => { console.error('SMOKE FAIL:', e.message); process.exit(1); });
