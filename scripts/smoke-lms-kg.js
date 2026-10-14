// Smoke-проверка LMS графа знаний (ТЗ-107 v3) по HTTP.
// Запуск: npm run build && node scripts/smoke-lms-kg.js
// SQLite-режим, сервер поднимается дочерним процессом, проверки — реальные HTTP.
// Эмбеддинг-пересчёт (Задача 2, критерии 2-3) НЕ покрыт: TEI на dev-машине нет,
// джоба проверяется на проде после деплоя. Здесь: миграция, фичефлаг-404,
// анти-энумерация hidden, форма графов, состояния уроков, рекомендации.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const PORT = 3996;
const BASE = `http://127.0.0.1:${PORT}`;
const DIST = path.join(__dirname, '..', 'dist');
let passed = 0;

function ok(name) {
  passed += 1;
  console.log(`OK ${passed}: ${name}`);
}

async function api(method, p, opts = {}) {
  const headers = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(BASE + p, { method, headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function main() {
  const DIR = `/tmp/lms-smoke-kg`;
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  process.env.USE_SQLITE = 'true';
  process.env.SQLITE_FILE = `${DIR}/pulse.db`;
  process.env.UPLOADS_DIR = `${DIR}/uploads`;
  process.env.SIGNED_URL_SECRET = 'test';
  process.env.JWT_SECRET = 'test';
  process.env.CRON_SECRET_KEY = 'test';
  process.env.STORAGE_MIN_FREE_PCT = '0';
  process.env.NODE_ENV = 'test';

  const sqlite = require(path.join(DIST, 'config', 'db-sqlite'));
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  await sqlite.query(`ALTER TABLE news ADD COLUMN slug TEXT`);
  const q = sqlite.query;
  const uuid = () => crypto.randomUUID();

  const ids = { admin: uuid(), user: uuid() };
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin)
     VALUES ($1,'admin@test.ru','admin','x',1),($2,'user@test.ru','user','x',0)`,
    [ids.admin, ids.user],
  );

  // 3 курса: A и B — published/public, H — published/hidden
  const courseA = uuid(), courseB = uuid(), courseH = uuid();
  const insCourse = (id, slug, title, visibility) => q(
    `INSERT INTO courses (id, slug, title, price, status, visibility, type, embedding)
     VALUES ($1,$2,$3,0,'published',$4,'course',NULL)`,
    [id, slug, title, visibility],
  );
  await insCourse(courseA, 'kg-course-a', 'Курс A', 'public');
  await insCourse(courseB, 'kg-course-b', 'Курс B', 'public');
  await insCourse(courseH, 'kg-course-h', 'Курс H (hidden)', 'hidden');

  const lesson = (courseId, pos, title, free) => q(
    `INSERT INTO course_lessons (id, course_id, position, title, kind, is_free_preview, unlock_after_days)
     VALUES ($1,$2,$3,$4,'text',$5,0)`,
    [uuid(), courseId, pos, title, free ? 1 : 0],
  );
  const a1 = uuid(), a2 = uuid(), b1 = uuid(), b2 = uuid(), h1 = uuid();
  for (const [id, cid, pos, t, free] of [
    [a1, courseA, 1, 'Что такое дивиденды', 1],
    [a2, courseA, 2, 'Дивидендная политика компаний', 0],
    [b1, courseB, 1, 'Выплаты акционерам: дивиденды', 0],
    [b2, courseB, 2, 'Налоги для акционеров', 0],
    [h1, courseH, 1, 'Скрытый урок про дивиденды', 0],
  ]) {
    await q(
      `INSERT INTO course_lessons (id, course_id, position, title, kind, is_free_preview, unlock_after_days)
       VALUES ($1,$2,$3,$4,'text',$5,0)`,
      [id, cid, pos, t, free ? 1 : 0],
    );
  }
  void lesson;

  // Общий тег A/B — для shared_tags рекомендаций
  await sqlite.query(
    `CREATE TABLE IF NOT EXISTS user_defined_tags (
       tag_id VARCHAR(50) PRIMARY KEY, tag_name VARCHAR(100) NOT NULL,
       tag_type VARCHAR(20) DEFAULT 'company', keywords TEXT DEFAULT '{}',
       enriched_data TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')))`,
  );
  await q(`INSERT INTO user_defined_tags (tag_id, tag_name, tag_type) VALUES ('akcii','Акции','asset')`, []);
  await q(`INSERT INTO course_tags (course_id, tag_id) VALUES ($1,'akcii'),($2,'akcii')`, [courseA, courseB]);

  // Юзер записан на hidden-курс H (анти-энумерация: видит его, аноним — нет)
  await q(
    `INSERT INTO course_enrollments (id, user_id, course_id, source) VALUES ($1,$2,$3,'free')`,
    [uuid(), ids.user, courseH],
  );

  // Снапшот графа (как будто ночная джоба уже отработала)
  const now = `datetime('now')`;
  await q(
    `INSERT INTO lesson_similarity (lesson_a, lesson_b, sim, cross_course, computed_at) VALUES
       ($1,$2,0.72,0,${now}),   -- a1-a2 intra
       ($3,$4,0.81,1,${now}),   -- a1-b1 cross
       ($5,$6,0.78,1,${now})`,  // a2-h1 cross (hidden-урок!)
    [a1 < a2 ? a1 : a2, a1 < a2 ? a2 : a1,
     a1 < b1 ? a1 : b1, a1 < b1 ? b1 : a1,
     a2 < h1 ? a2 : h1, a2 < h1 ? h1 : a2],
  );
  await q(
    `INSERT INTO course_similarity (course_a, course_b, sim, sim_embed, shared_pairs, computed_at) VALUES
       ($1,$2,0.75,0.70,1,${now}),
       ($3,$4,0.66,0.60,1,${now})`,
    [courseA < courseB ? courseA : courseB, courseA < courseB ? courseB : courseA,
     courseA < courseH ? courseA : courseH, courseA < courseH ? courseH : courseA],
  );

  const adminToken = jwt.sign({ userId: ids.admin }, 'test');
  const userToken = jwt.sign({ userId: ids.user }, 'test');

  let server = null;
  async function boot(graphEnabled) {
    const srv = spawn('node', [path.join(DIST, 'index.js')], {
      env: { ...process.env, PORT: String(PORT), EDUCATION_GRAPH_ENABLED: graphEnabled ? 'true' : 'false' },
      stdio: 'ignore',
    });
    server = srv;
    srv.on('exit', () => { if (server === srv) server = null; });
    process.on('exit', () => { try { if (server) server.kill(); } catch {} });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${BASE}/health`);
        if (r.ok) return server;
      } catch {}
      await new Promise(r2 => setTimeout(r2, 700));
    }
    server.kill();
    throw new Error('server did not become healthy');
  }

  // ─── Прогон 1: фичефлаг ВЫКЛЮЧЕН ───
  server = await boot(false);

  const mig = await api('POST', `/migrate-lms-kg?secret=test`);
  if (mig.status !== 200 || !mig.json?.skipped) throw new Error(`migrate: ${JSON.stringify(mig)}`);
  ok('миграция: SQLite-режим — skipped, таблицы создал initSQLiteSchema');

  const off1 = await api('GET', '/api/education/graph');
  const off2 = await api('GET', '/api/education/courses/kg-course-a/graph');
  if (off1.status !== 404 || off2.status !== 404) throw new Error(`flag off: ${off1.status}/${off2.status}`);
  ok('фичефлаг выключен → оба эндпоинта 404 (критерий 6)');

  server.kill();
  await new Promise(r2 => setTimeout(r2, 1500));

  // ─── Прогон 2: фичефлаг ВКЛЮЧЁН ───
  server = await boot(true);

  const gAnon = await api('GET', '/api/education/graph');
  if (gAnon.status !== 200 || !gAnon.json?.graph) throw new Error(`graph anon: ${JSON.stringify(gAnon).slice(0, 200)}`);
  const g = gAnon.json.graph;
  const gCourseIds = g.nodes.courses.map(c => c.id);
  const gLessonIds = g.nodes.lessons.map(l => l.id);
  if (gCourseIds.includes(courseH)) throw new Error('hidden-курс H утёк анониму');
  if (gLessonIds.includes(h1)) throw new Error('hidden-урок h1 утёк анониму');
  if (!gCourseIds.includes(courseA) || !gCourseIds.includes(courseB)) throw new Error('published-курсы не на месте');
  if (g.edges.courses.some(e => e.a === courseH || e.b === courseH)) throw new Error('hidden-ребро курса утекло');
  if (g.edges.lessons.some(e => e.a === h1 || e.b === h1)) throw new Error('hidden-ребро урока утекло');
  if (!g.edges.courses.some(e => (e.a === courseA && e.b === courseB) || (e.a === courseB && e.b === courseA))) {
    throw new Error('ребро A-B не на месте');
  }
  if (!g.edges.lessons.some(e => (e.a === a1 && e.b === b1) || (e.a === b1 && e.b === a1))) {
    throw new Error('ребро a1-b1 не на месте');
  }
  const nodeA = g.nodes.courses.find(c => c.id === courseA);
  if (nodeA.lessons_count !== 2 || nodeA.students !== 0) throw new Error(`meta nodeA: ${JSON.stringify(nodeA)}`);
  if (g.my_progress !== undefined || g.my_courses !== undefined) throw new Error('анониму персональные поля не нужны');
  ok(`глобальная карта анонима: A+B, hidden нет ни в узлах, ни в рёбрах (критерий 5)`);

  const gUser = await api('GET', '/api/education/graph', { token: userToken });
  const gu = gUser.json.graph;
  if (!gu.nodes.courses.map(c => c.id).includes(courseH)) throw new Error('записанный юзер не видит hidden-курс');
  if (!gu.my_courses.includes(courseH)) throw new Error('my_courses без hidden-курса юзера');
  ok('записанный юзер: hidden-курс виден, my_courses на месте');

  const cAnon = await api('GET', '/api/education/courses/kg-course-a/graph');
  if (cAnon.status !== 200 || !cAnon.json?.graph) throw new Error(`course graph: ${JSON.stringify(cAnon).slice(0, 200)}`);
  const cg = cAnon.json.graph;
  const states = Object.fromEntries(cg.lessons.map(l => [l.position, l.state]));
  if (states[1] !== 'current' || states[2] !== 'locked') throw new Error(`guest states: ${JSON.stringify(states)}`);
  if (JSON.stringify(cg.edges_structural) !== JSON.stringify([[1, 2]])) throw new Error(`structural: ${JSON.stringify(cg.edges_structural)}`);
  if (cg.edges_semantic.length !== 1 || cg.edges_semantic[0].sim !== 0.72) throw new Error(`semantic: ${JSON.stringify(cg.edges_semantic)}`);
  if (cg.recommendations.length !== 1) throw new Error(`recs anon: ${JSON.stringify(cg.recommendations)}`);
  const rec = cg.recommendations[0];
  if (rec.course.slug !== 'kg-course-b' || !rec.shared_tags?.includes('Акции')) {
    throw new Error(`rec: ${JSON.stringify(rec)}`);
  }
  if (cg.recommendations.some(r => r.course.slug === 'kg-course-h')) throw new Error('hidden-курс в рекомендациях анонима');
  ok('граф курса анониму: free_preview=current, остальное locked, структурные+смысловые рёбра, рекомендация с shared_tags');

  const cUser = await api('GET', '/api/education/courses/kg-course-a/graph', { token: userToken });
  const cu = cUser.json.graph;
  const recUser = cu.recommendations.find(r => r.course.slug === 'kg-course-h');
  if (!recUser) throw new Error('записанный на H юзер не получил rec в hidden-курс');
  ok('записанный юзер: рекомендация в hidden-курс H видна');

  const c404 = await api('GET', '/api/education/courses/kg-course-unknown/graph');
  if (c404.status !== 404) throw new Error(`unknown course: ${c404.status}`);
  ok('несуществующий курс → 404');

  server.kill();
  console.log(`\nSMOKE OK — knowledge graph (ТЗ-107 v3): ${passed} проверок`);
  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
