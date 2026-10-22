/**
 * =============================================================================
 * PULSE — ТЗ-191: еженедельный отчёт как страница платформы — фазы «в» и «г»
 * =============================================================================
 *
 * Прогон:  USE_SQLITE=true npx ts-node --transpile-only src/tests/weeklyReportPage.test.ts
 *
 * Покрытие пунктов чек-листа ТЗ-191 (Задача 7):
 *   1  Генерация — снапшот у entitled без подписок; повторный прогон: upsert,
 *      id стабилен; created-флаг (unit). SKIP: конкурентность ≤5 (мок-таймеры),
 *      изоляция «LLM-500 у одного юзера» (частично: AI 500→null + per-user try/catch).
 *   2  Идемпотентность отправки — первый прогон шлёт и ставит sent_at; повторный
 *      в ту же неделю: 0 отправок (due-каналы отсутствуют). SKIP: окно тихих часов
 *      (нужен сдвиг часов/окно 22–08 МСК — ручная проверка).
 *   3  AI-саммари — без ключа: все null, 0 HTTP-вызовов; мок 200: структура,
 *      ≤6 вызовов; мок 500: null, отчёт не падает; без фичи ai_summary: пер-теговые
 *      null БЕЗ вызовов.
 *   4  Доступ — smoke-HTTP матрица: свой 200 / чужой 404 / админ 200 /
 *      is_blocked=true со свежим JWT → 403 (authMiddleware этого не ловит);
 *      тот же набор для archive-chart.
 *   5  Magic-link — валидный ?k= без сессии → 200 на отчёт и chart; протухший/
 *      чужой токен → 401; /weekly/current с ?k= → 401 (live — сессия only);
 *      токен после удаления отчёта → 404. SKIP: нет — всё на SQLite.
 *   6  SSRF-гард — tag_id вне payload → 404, 0 вызовов marketRouter; чужой
 *      инструментальный тег → тоже 404 (выборка строго внутри payload).
 *   7  Архив — ≤12, свежие первыми, без полного payload.
 *   8  График — тег с инструментом: свечи + события из payload + week_change_pct;
 *      тег без инструмента → {chart:null}; мок finam_maintenance → 200
 *      {chart:null, reason:'market_unavailable'}; повторный запрос — из кэша,
 *      без повторного обращения к marketRouter.
 *   9  Live — perDay только прошедшие будни; pace (будни-к-будням); нет % дельт;
 *      повторный запрос — из кэша (X-Cache: hit); после генерации — {snapshot_id};
 *      0 LLM-вызовов; live-chart отдаёт события из live-контента.
 *  10  Календарь «впереди» — события следующей недели с пересечением тегов
 *      портфеля; без пересечения — отфильтрованы; тег без новостей, но с
 *      событием — видно; пустой календарь → 200 {ahead:null}.
 *  11  Письмо/Telegram — ссылка с k= и UTM (email + TG-кнопка + push data);
 *      escapeHtml тега с <script> и саммари с HTML; PNG-вложение cid:weekly-chart;
 *      падение фото → текстовая сводка с inline-кнопкой.
 *  12  FE — вне scope бэкенд-теста, прогоняется на фронте (React). SKIP.
 *  13  Очистка — 14-недельный удалён (каскадно токены), 12-недельный на месте,
 *      невысланный снапшот текущей недели на месте.
 *
 * Postgres-варианты SQL не покрыты (нужен живой PG) — SQLite-ветки идентичны
 * по логике; прогнать на VPS при необходимости.
 */

// ВАЖНО: env ставим ДО любых импортов модулей (USE_SQLITE/JWT_SECRET читаются при загрузке)
process.env.USE_SQLITE = 'true';
process.env.JWT_SECRET = 'weekly-page-test-secret';
process.env.TELEGRAM_BOT_TOKEN = 'test-token-1234567890';
process.env.FRONTEND_URL = 'https://frontend.test';
// Глушим реальные транспорты на случай локального .env (dotenv не перезаписывает env)
process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = '';
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
process.env.RESEND_API_KEY = '';
// KIMI_API_KEY намеренно НЕ задана: деградация AI → null, 0 HTTP-вызовов (п.3)

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

let passed = 0;
let failed = 0;
let skipped = 0;
function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}
function skip(name: string, why: string) {
  skipped++; console.log(`  SKIP ${name} — ${why}`);
}

// ── Общие хелперы дат (МСК = UTC+3 фиксированно, конвенция weeklyStats) ─────
const MSK_MS = 3 * 3600 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Понедельник 00:00 МСК текущей недели как UTC-инстанс */
function mondayMsk(d: Date = new Date()): Date {
  const msk = new Date(d.getTime() + MSK_MS);
  const dow = msk.getUTCDay();
  const shift = dow === 0 ? 6 : dow - 1;
  const mon = new Date(msk.getTime() - shift * DAY_MS);
  mon.setUTCHours(0, 0, 0, 0);
  return new Date(mon.getTime() - MSK_MS);
}
const isoDb = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 19); // SQLite-формат
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
/** Календарная дата по МСК (как weekStartMskDate — значение колонки week_start) */
const mskDayStr = (d: Date) => new Date(d.getTime() + MSK_MS).toISOString().slice(0, 10);

let q: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;

async function seedUser(id: string, email: string, opts: { admin?: boolean; blocked?: boolean; plan?: string } = {}) {
  await q(
    `INSERT INTO users (id, email, username, password_hash, is_admin, is_blocked,
                        subscription_plan, subscription_expires_at, subscription_active)
     VALUES ($1, $2, $3, 'x', $4, $5, $6, $7, 1)`,
    [id, email, id, opts.admin ? 1 : 0, opts.blocked ? 1 : 0,
     opts.plan || 'free', opts.plan ? isoDb(new Date(Date.now() + 30 * DAY_MS)) : null]
  );
}

async function seedPortfolio(userId: string, tagId: string, tagName: string) {
  await q(
    `INSERT INTO portfolios (id, user_id, tag_id, tag_name, tag_type, created_at)
     VALUES ($1, $2, $3, $4, 'company', ${"datetime('now')"})`,
    [crypto.randomUUID(), userId, tagId, tagName]
  );
}

async function seedNews(id: string, tagId: string, sentiment: string, fetchedAt: Date, title?: string) {
  // SQLite-путь контента матчит LIKE `%"id"%` — одиночный тег в JSON так не
  // матчится (как в жизни: matched_tags всегда мультитеговый), поэтому соседи-заглушки
  await q(
    `INSERT INTO news (id, title_ru, title_original, summary_ru, source, url,
                       published_at, fetched_at, sentiment, matched_tags)
     VALUES ($1, $2, '', '', 'test-source', $3, $4, $4, $5, $6)`,
    [id, title ?? id, `https://example.com/${id}`, isoDb(fetchedAt), sentiment,
     JSON.stringify(['zz-dummy', tagId, 'zz-dummy2'])]
  );
}

function makeStats(tagId: string, tagName: string, current: number): any {
  return {
    perTag: [{ tagId, tagName, current, prevWeek: current - 1, monthAvg: current }],
    perDay: [{ date: dayStr(mondayMsk()), count: current }],
    sentiment: {
      positive: current, negative: 0, neutral: 0,
      prevPositive: current - 1, prevNegative: 0, prevNeutral: 0,
    },
    kpis: { totalDeltaWeekPct: 10, totalDeltaMonthPct: 5, topTagId: tagId, peakDay: dayStr(mondayMsk()) },
  };
}

function makeArticle(tag: string, n: number): any {
  return {
    title: `Новость ${tag} #${n}`,
    summary: `Кратко ${tag} ${n}`,
    source: 'test-source',
    url: `https://example.com/${tag}-${n}`,
    publishedAt: new Date(),
    sentiment: n % 2 === 0 ? 'positive' : 'neutral',
  };
}

async function main(): Promise<void> {
  process.env.SQLITE_FILE = path.join(os.tmpdir(), `weekly-page-test-${Date.now()}.db`);
  const sqlite = await import('../config/db-sqlite');
  await sqlite.initSQLite();
  await sqlite.initSQLiteSchema();
  q = sqlite.query;

  // SQLite-стенд: колонка тарифа для кандидатов/entitlement (в PG — price_monthly)
  await q(`ALTER TABLE subscription_plans ADD COLUMN price_monthly REAL`, []);
  await q(`UPDATE subscription_plans SET price_monthly = CASE WHEN price > 0 THEN price ELSE 0 END`, []);
  // SQLite-шаблон portfolios старше фичи freeze — колонки нет, добавляем
  try {
    await q(`ALTER TABLE portfolios ADD COLUMN is_frozen INTEGER DEFAULT 0`, []);
  } catch { /* уже есть */ }
  // Таблицы, которых нет в SQLite-шаблоне (в PG создаются миграциями index.ts)
  await q(`CREATE TABLE IF NOT EXISTS user_defined_tags (
             tag_id VARCHAR(50) PRIMARY KEY, tag_name VARCHAR(100) NOT NULL,
             tag_type VARCHAR(20) DEFAULT 'company', keywords TEXT DEFAULT '{}',
             enriched_data TEXT, created_at TEXT DEFAULT (datetime('now')))`, []);
  await q(`CREATE TABLE IF NOT EXISTS calendar_events (
             id TEXT PRIMARY KEY, date DATE NOT NULL, weekday VARCHAR(2) NOT NULL,
             title TEXT NOT NULL, kind VARCHAR(10) NOT NULL, status VARCHAR(10) NOT NULL,
             company VARCHAR(100) NOT NULL, ticker VARCHAR(10) NOT NULL,
             uploaded_at TEXT, sources TEXT, possible_duplicate INTEGER DEFAULT 0,
             tag_ids TEXT, UNIQUE (date, title, kind, ticker))`, []);

  const snap = await import('../services/notifications/weeklyReportSnapshot');
  const fmtMod = await import('../services/notifications/formatters');
  const statsMod = await import('../services/notifications/weeklyStats');
  const axios = (await import('axios')).default;
  // ПРАВКА-2 к ТЗ-191: генерация пишет снапшот в ОТЧЁТНУЮ неделю (в пн–сб —
  // завершившаяся на прошлом вс) — сиды новостей кладём внутрь её окна
  const genTargetWs = statsMod.weeklyReportTargetWeekStart();
  const genTargetWeek = statsMod.weekStartMskDate(genTargetWs);

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nТЗ-191.1/13 Генерация: upsert идемпотентность, created-флаг');
  // ═════════════════════════════════════════════════════════════════════════
  await seedUser('unit-user', 'unit@test.local', { plan: 'premium' });
  const unitContent: any = {
    period: 'unit', tagSummaries: [{ tagId: 'tag-u', tagName: 'Unit', articles: [makeArticle('u', 1)] }],
    totalArticles: 1, sentimentBreakdown: { positive: 1, negative: 0, neutral: 0 }, stats: null,
  };
  const first = await snap.saveWeeklyReportSnapshot('unit-user', unitContent, null);
  check('первое сохранение: created=true, id есть', first.created === true && !!first.id, first);
  const second = await snap.saveWeeklyReportSnapshot('unit-user', unitContent, null);
  check('повторное сохранение в ту же неделю: created=false, id стабилен',
    second.created === false && second.id === first.id, second);
  const unitSnap = await snap.getWeeklyReportSnapshot(first.id);
  check('payload читается обратно (content + ai=null)', unitSnap?.content.period === 'unit' && unitSnap.ai === null);

  // ── Magic-токены (unit-часть п.5) ─────────────────────────────────────────
  const token1 = await snap.issueReportAccessToken(first.id);
  check('issueReportAccessToken вернул plaintext (48 hex)', /^[0-9a-f]{48}$/.test(token1), token1.length);
  check('валидный токен проходит validateReportAccessToken',
    (await snap.validateReportAccessToken(first.id, token1)) === true);
  check('чужой/битый токен → false',
    (await snap.validateReportAccessToken(first.id, '0'.repeat(48))) === false);
  const token2 = await snap.issueReportAccessToken(first.id);
  check('перевыпуск (upsert): строка одна, старый токен протух',
    token2 !== token1
    && (await snap.validateReportAccessToken(first.id, token1)) === false
    && (await snap.validateReportAccessToken(first.id, token2)) === true);
  await q(`UPDATE report_access_tokens SET expires_at = '2020-01-01 00:00:00' WHERE report_id = $1`, [first.id]);
  check('протухший токен → false', (await snap.validateReportAccessToken(first.id, token2)) === false);
  const token3 = await snap.issueReportAccessToken(first.id); // вернём валидный для HTTP-секции
  check('токен перевыпущен снова валиден', (await snap.validateReportAccessToken(first.id, token3)) === true);

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nТЗ-191.3 AI-саммари: без ключа / мок 200 / мок 500 / фича-гейт');
  // ═════════════════════════════════════════════════════════════════════════
  const aiContent = (tagCount: number): any => ({
    period: 'тест',
    tagSummaries: Array.from({ length: tagCount }, (_, i) => ({
      tagId: `tag-ai-${i}`, tagName: `Тег${i}`,
      articles: Array.from({ length: 4 }, (_, n) => makeArticle(`ai${i}`, n)),
    })),
    totalArticles: tagCount * 4,
    sentimentBreakdown: { positive: tagCount * 2, negative: 0, neutral: tagCount * 2 },
    stats: null,
  });

  // 3a. Без ключа (модуль загружен без KIMI_API_KEY): все null, 0 HTTP
  let moonshotCalls = 0;
  const origPost = axios.post;
  (axios as any).post = async (url: string) => {
    if (String(url).includes('moonshot')) { moonshotCalls++; return { data: { choices: [{ message: { content: 'x' } }] } }; }
    return { data: { ok: true } };
  };
  const aiNoKey = await import('../services/notifications/weeklySummaryAI');
  const rNoKey = await aiNoKey.generateWeeklyAISummaries(aiContent(2), { perTagEnabled: true, sleepMs: 0 });
  check('без ключа: overall=null, пер-теговые null, meta=null',
    rNoKey.summaries.overall === null
    && rNoKey.summaries.perTag.every((t: any) => t.summary === null)
    && rNoKey.summaries.meta === null, rNoKey.summaries);
  check('без ключа: 0 HTTP-вызовов Moonshot', moonshotCalls === 0, moonshotCalls);

  // 3b. Мок 200 (fresh-модуль с ключом): структура + ≤6 вызовов (1 + топ-5 тегов)
  process.env.KIMI_API_KEY = 'test-kimi-key';
  const aiPath = require.resolve('../services/notifications/weeklySummaryAI');
  delete require.cache[aiPath];
  const aiWithKey = require(aiPath);
  const rOk = await aiWithKey.generateWeeklyAISummaries(aiContent(6), { perTagEnabled: true, sleepMs: 0 });
  check('мок 200: overall заполнен, мета с количеством статей',
    typeof rOk.summaries.overall === 'string' && rOk.summaries.overall.length > 0
    && rOk.summaries.meta?.articles_count === 24, rOk.summaries.meta);
  check('мок 200: пер-теговые заполнены (топ-5 тегов, лимит PER_TAG_LIMIT)',
    rOk.summaries.perTag.length === 5 && rOk.summaries.perTag.every((t: any) => typeof t.summary === 'string'),
    rOk.summaries.perTag.map((t: any) => t.summary?.length));
  check('мок 200: вызовов ≤6 (1 общее + 5 по тегам)', rOk.llmCalls <= 6 && rOk.llmCalls === 6, rOk.llmCalls);

  // 3c. Мок 500: null без падения
  (axios as any).post = async (url: string) => {
    if (String(url).includes('moonshot')) {
      moonshotCalls++;
      const err: any = new Error('Request failed');
      err.response = { status: 500, data: {} };
      throw err;
    }
    return { data: { ok: true } };
  };
  const r500 = await aiWithKey.generateWeeklyAISummaries(aiContent(2), { perTagEnabled: true, sleepMs: 0 });
  check('мок 500: overall=null, пер-теговые null, meta=null, без throw',
    r500.summaries.overall === null && r500.summaries.meta === null
    && r500.summaries.perTag.every((t: any) => t.summary === null), r500.summaries);

  // 3d. Без фичи ai_summary: пер-теговые null БЕЗ вызовов (только 1 общее)
  (axios as any).post = async (url: string) => {
    if (String(url).includes('moonshot')) { moonshotCalls++; return { data: { choices: [{ message: { content: 'ok' } }] } }; }
    return { data: { ok: true } };
  };
  const before = moonshotCalls;
  const rNoFeature = await aiWithKey.generateWeeklyAISummaries(aiContent(6), { perTagEnabled: false, sleepMs: 0 });
  check('без фичи: пер-теговые null БЕЗ вызовов, общее — 1 вызов',
    rNoFeature.summaries.perTag.every((t: any) => t.summary === null)
    && typeof rNoFeature.summaries.overall === 'string'
    && moonshotCalls - before === 1, { calls: moonshotCalls - before });

  // 3e. Недоступный LLM в фазе генерации: снапшот создан, ai=null, крон не падает.
  // Модули перечитываем ПОСЛЕ снятия ключа — иначе сработал бы реальный HTTP к Moonshot.
  delete process.env.KIMI_API_KEY;
  delete require.cache[aiPath];
  delete require.cache[require.resolve('../services/notifications/weeklyReportGenerate')];
  const genMod = require('../services/notifications/weeklyReportGenerate');
  await seedUser('gen-err-user', 'gen-err@test.local', { plan: 'premium' });
  await seedPortfolio('gen-err-user', 'tag-gen-err', 'ГенОшибка');
  await seedNews('gen-err-1', 'tag-gen-err', 'positive', new Date(genTargetWs.getTime() + 10 * 3600 * 1000));
  const genRes = await genMod.generateWeeklySnapshots();
  const errSnap = await snap.getCurrentWeekSnapshot('gen-err-user', genTargetWeek);
  check('генерация при недоступном LLM: снапшот создан, ai.overall=null, errors=0, 0 LLM-вызовов',
    !!errSnap && errSnap.ai?.overall === null && genRes.errors === 0 && genRes.llmCalls === 0,
    { generated: genRes.generated, errors: genRes.errors, llm: genRes.llmCalls });
  (axios as any).post = origPost;

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nТЗ-191.9 (unit) Live-агрегаты: perDay только прошедшие будни, pace, без % дельт');
  // ═════════════════════════════════════════════════════════════════════════
  {
    const WED = new Date('2026-10-14T12:00:00.000Z'); // среда 15:00 МСК
    const ws = mondayMsk(WED); // пн 00:00 МСК = 2026-10-11T21:00Z
    await seedNews('live-mon', 'tag-live-u', 'positive', new Date(ws.getTime() + 10 * 3600 * 1000));
    await seedNews('live-tue', 'tag-live-u', 'negative', new Date(ws.getTime() + DAY_MS + 10 * 3600 * 1000));
    await seedNews('live-prev-mon', 'tag-live-u', 'neutral', new Date(ws.getTime() - 7 * DAY_MS + 10 * 3600 * 1000));
    await seedNews('live-prev-tue', 'tag-live-u', 'neutral', new Date(ws.getTime() - 6 * DAY_MS + 10 * 3600 * 1000));
    await seedNews('live-prev-wed', 'tag-live-u', 'neutral', new Date(ws.getTime() - 5 * DAY_MS + 10 * 3600 * 1000));
    const live = await statsMod.computeLiveWeeklyStats(
      q,
      [{ tagId: 'tag-live-u', tagName: 'LiveUnit' }],
      WED
    );
    check('perDay: только прошедшие будни (среда → 3 дня: пн–ср)',
      live.perDay.length === 3 && live.elapsedDays === 3, live.perDay);
    check('perDay: даты — МСК-даты текущей недели (2026-10-12…14)',
      live.perDay.map((d: any) => d.date).join(',') === '2026-10-12,2026-10-13,2026-10-14',
      live.perDay.map((d: any) => d.date));
    check('perDay: сумма = 2 (пн+вт), пустых дней нет',
      live.perDay.reduce((s: number, d: any) => s + d.count, 0) === 2, live.perDay);
    check('прошлая неделя обрезана по тем же будням (prevTotal = 3, а не больше)',
      statsMod.statsPrevTotal(live) === 3, live.sentiment);
    check('процентных дельт на неполной неделе нет (обе null)',
      live.kpis.totalDeltaWeekPct === null && live.kpis.totalDeltaMonthPct === null, live.kpis);
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nТЗ-191.11 (unit) Форматтеры: ссылка k=+UTM, escapeHtml, PNG cid, push report_url');
  // ═════════════════════════════════════════════════════════════════════════
  {
    const content: any = {
      period: '12 — 19 октября',
      tagSummaries: [
        { tagId: 'tag-x', tagName: '<script>alert(1)</script>', articles: [makeArticle('x', 1), makeArticle('x', 2)] },
        { tagId: 'tag-y', tagName: 'Нефть', articles: [makeArticle('y', 1)] },
      ],
      totalArticles: 3,
      sentimentBreakdown: { positive: 2, negative: 0, neutral: 1 },
      stats: makeStats('tag-x', '<script>alert(1)</script>', 2),
    };
    const ai: any = {
      overall: 'Первая часть итогов с <b>HTML</b>.\n\nВторая часть итогов.',
      perTag: [], meta: { model: 'k', generated_at: '2026-10-19', articles_count: 3 },
    };
    const reportUrl = 'https://frontend.test/reports/weekly/rep-1?k=tok123abc&utm_source=email&utm_medium=weekly_report';

    const email = fmtMod.formatWeeklyReportEmail(content, { withChart: true, reportUrl, ai });
    check('email: ссылка с k= и UTM в кнопке', email.html.includes('k=tok123abc') && email.html.includes('utm_source=email') && email.html.includes('utm_medium=weekly_report'));
    check('email: PNG-вложение cid:weekly-chart', email.html.includes('cid:weekly-chart'));
    check('email: первый абзац саммари в теле, вторая часть — нет',
      email.html.includes('Первая часть итогов с') && !email.html.includes('Вторая часть итогов'));
    check('email: escapeHtml — нет <script> и <b> из саммари',
      !email.html.includes('<script>') && !email.html.includes('<b>HTML</b>') && email.html.includes('&lt;script&gt;'));
    check('email: KPI-карточки (всего/позитив/негатив)',
      email.html.includes('Всего новостей') && email.html.includes('Позитив') && email.html.includes('Негатив'));
    check('email: топ-3 тега со счётчиками (script-тег экранирован, счётчик 2)',
      email.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && email.html.includes('— 2 новостей'));

    const tg = fmtMod.formatWeeklyReportTelegram(content, { reportUrl, ai });
    check('tg: саммари целиком, HTML экранирован',
      tg.includes('Вторая часть итогов') && !tg.includes('<b>HTML</b>') && tg.includes('&lt;b&gt;HTML&lt;/b&gt;'));
    check('tg: топ-3 тега со счётчиками, имя тега экранирован',
      tg.includes('&lt;script&gt;alert(1)&lt;/script&gt; — 2') && tg.includes('Нефть — 1'));
    check('tg: статистика без полного списка новостей',
      tg.includes('Всего новостей: 2') && !tg.includes('Читать на сайте'));

    const push = fmtMod.formatWeeklyReportPush(content, reportUrl);
    check('push: data.report_url с deeplink', push.data.report_url === reportUrl, push.data);
    check('push: без ссылки — report_url отсутствует', fmtMod.formatWeeklyReportPush(content).data.report_url === undefined);

    // Сводка без ссылки и без ai (фолбэк)
    const plain = fmtMod.formatWeeklyReportEmail(content, {});
    check('email без ссылки/ai: сводка уходит, кнопки и саммари нет',
      !plain.html.includes('Открыть полный отчёт') && !plain.html.includes('🧠'));
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nТЗ-191.13 Очистка: 14 недель удалён (каскадно токены), 12 недель на месте, текущая нетронута');
  // ═════════════════════════════════════════════════════════════════════════
  {
    await seedUser('archive-user', 'archive@test.local', { plan: 'premium' });
    const insertOld = async (weeksAgo: number, withToken: boolean) => {
      const id = crypto.randomUUID();
      // понедельник той недели (а не сдвиг UTC-инстанса — иначе дата «поезжает» на воскресенье)
      const weekStart = mskDayStr(mondayMsk(new Date(Date.now() - weeksAgo * 7 * DAY_MS)));
      await q(
        `INSERT INTO weekly_reports (id, user_id, week_start, payload, created_at, updated_at, sent_at)
         VALUES ($1, 'archive-user', $2, $3, datetime('now'), datetime('now'), datetime('now'))`,
        [id, weekStart, JSON.stringify({
          content: { period: `w-${weeksAgo}`, tagSummaries: [], totalArticles: weeksAgo,
                     sentimentBreakdown: { positive: 0, negative: 0, neutral: weeksAgo }, stats: null },
          ai: null,
        })]
      );
      if (withToken) await snap.issueReportAccessToken(id);
      return id;
    };
    const id14a = await insertOld(15, true);
    const id14b = await insertOld(14, false);
    const ids12 = [await insertOld(12, false)];
    const ids11 = [await insertOld(11, false), await insertOld(10, false)];
    // ещё недели 9..1 — чтобы в архиве было 13 строк (кэп 12 проверим через HTTP)
    for (let w = 9; w >= 1; w--) await insertOld(w, false);
    const currentUnsent = await snap.saveWeeklyReportSnapshot('archive-user', unitContent, null); // невысланный текущей недели
    await q(`UPDATE weekly_reports SET sent_at = NULL WHERE id = $1`, [currentUnsent.id]);

    const deleted = await snap.cleanupOldWeeklyReports();
    check('удалены ровно 2 отчёта старше 12 недель', deleted === 2, deleted);

    const exists = async (id: string) =>
      (await q(`SELECT 1 FROM weekly_reports WHERE id = $1`, [id])).rows.length > 0;
    check('14-недельный (с токеном) удалён', !(await exists(id14a)));
    check('14-недельный (без токена) удалён', !(await exists(id14b)));
    check('токен 15-недельного снесён каскадом',
      (await q(`SELECT COUNT(*) AS c FROM report_access_tokens WHERE report_id = $1`, [id14a])).rows[0].c === 0,
      (await q(`SELECT COUNT(*) AS c FROM report_access_tokens WHERE report_id = $1`, [id14a])).rows[0]);
    check('12-недельный на месте (граница ретеншна — НЕ старше)', await exists(ids12[0]));
    check('11- и 10-недельные на месте', (await exists(ids11[0])) && (await exists(ids11[1])));
    check('невысланный снапшот текущей недели на месте', await exists(currentUnsent.id));

    const list = await snap.listWeeklyReports('archive-user', 12);
    check('listWeeklyReports: ≤12 (13 строк в БД → 12)', list.length === 12, list.length);
    const sortedDesc = list.every((r: any, i: number, a: any[]) => i === 0 || a[i - 1].week_start >= r.week_start);
    check('listWeeklyReports: свежие первыми', sortedDesc, list.map((r: any) => r.week_start));
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nТЗ-191.1 Генерация (e2e, SQLite): entitled без подписок — снапшот создан; повторный прогон — id стабилен');
  // ═════════════════════════════════════════════════════════════════════════
  const seedSettings = async (userId: string) => {
    await q(`INSERT INTO notification_settings (user_id, quiet_hours_enabled) VALUES ($1, 0)`, [userId]);
  };
  // gen-err-user уже снапшотится в секции 3e — используем его для проверки стабильности id
  const errSnapBefore = await snap.getCurrentWeekSnapshot('gen-err-user', genTargetWeek);
  await seedUser('gen-user-1', 'gen1@test.local', { plan: 'premium' });   // entitled, БЕЗ подписок
  await seedPortfolio('gen-user-1', 'tag-g1', 'ГенОдин');
  await seedNews('g1-1', 'tag-g1', 'positive', new Date(genTargetWs.getTime() + 11 * 3600 * 1000));
  await seedUser('gen-user-2', 'gen2@test.local', { plan: 'premium' });   // entitled + telegram-канал
  await seedPortfolio('gen-user-2', 'tag-g2', 'ГенДва');
  await seedNews('g2-1', 'tag-g2', 'positive', new Date(genTargetWs.getTime() + 12 * 3600 * 1000));
  await seedSettings('gen-user-2');
  await q(`INSERT INTO user_channels (id, user_id, channel, target, is_active)
           VALUES ($1, 'gen-user-2', 'telegram', '424242', 1)`, [crypto.randomUUID()]);
  await q(`INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency)
           VALUES ('gen-user-2', 'weekly_report', 'telegram', 1, 'weekly')`);
  await seedUser('gen-user-3', 'gen3@test.local', { plan: 'premium' });   // для фолбэка «фото упало»
  await seedPortfolio('gen-user-3', 'tag-g3', 'ГенТри');
  await seedNews('g3-1', 'tag-g3', 'positive', new Date(genTargetWs.getTime() + 13 * 3600 * 1000));
  await seedSettings('gen-user-3');
  await q(`INSERT INTO user_channels (id, user_id, channel, target, is_active)
           VALUES ($1, 'gen-user-3', 'telegram', '434343', 1)`, [crypto.randomUUID()]);
  await q(`INSERT INTO notification_subscriptions (user_id, product, channel, enabled, frequency)
           VALUES ('gen-user-3', 'weekly_report', 'telegram', 1, 'weekly')`);

  const genMod2 = require('../services/notifications/weeklyReportGenerate');
  const res2 = await genMod2.generateWeeklySnapshots();
  const s1 = await snap.getCurrentWeekSnapshot('gen-user-1', genTargetWeek);
  const s2 = await snap.getCurrentWeekSnapshot('gen-user-2', genTargetWeek);
  const s3 = await snap.getCurrentWeekSnapshot('gen-user-3', genTargetWeek);
  check('entitled БЕЗ подписок на каналы — снапшот создан (страница обещана всем entitled)',
    !!s1 && s1.content.tagSummaries.length > 0);
  check('entitled с подписками — снапшот создан', !!s2);
  check('AI без ключа: ai.overall=null в payload (деградация, генерация не падает)',
    s1?.ai?.overall === null && s2?.ai?.overall === null);
  check('magic-токен выпущен в фазе генерации (один на отчёт)',
    (await q(`SELECT 1 FROM report_access_tokens WHERE report_id = $1`, [s1!.id])).rows.length === 1);
  check('повторный прогон: ошибок 0', res2.errors === 0, res2.errors);

  const errSnapAfter = await snap.getCurrentWeekSnapshot('gen-err-user', genTargetWeek);
  check('повторный прогон: id снапшота стабилен (upsert)', !!errSnapBefore && errSnapAfter?.id === errSnapBefore.id,
    { before: errSnapBefore?.id, after: errSnapAfter?.id });
  check('ПРАВКА-2: сгенерированный снапшот содержит chartEvents (все новости недели)',
    (s1?.content.tagSummaries[0]?.chartEvents?.length ?? 0) === 1, s1?.content.tagSummaries[0]);
  skip('конкурентность ≤5', 'нужны мок-таймеры; пул на промисах проверен код-ревью (CONCURRENCY=5)');
  skip('окно тихих часов → sent_at NULL + дорассылка', 'нужен сдвиг часов/окно 22:00–08:00 МСК — ручная проверка');

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nТЗ-191.2/11 Фаза отправки: фан-аут со ссылкой, sent_at, идемпотентность, фолбэк без фото');
  // ═════════════════════════════════════════════════════════════════════════
  const telegram = await import('../services/telegram');
  const dispMod = await import('../services/notifications/dispatcher');
  const captured: { photos: any[]; messages: any[] } = { photos: [], messages: [] };
  const origPhoto = telegram.sendTelegramPhoto;
  const origMsg = telegram.sendTelegramMessage;
  (telegram as any).sendTelegramPhoto = async (chatId: string, photo: Buffer, caption?: string, keyboard?: any) => {
    captured.photos.push({ chatId, caption, keyboard });
    return true;
  };
  (telegram as any).sendTelegramMessage = async (chatId: string, text: string, mode?: string, keyboard?: any) => {
    captured.messages.push({ chatId, text, mode, keyboard });
    return true;
  };
  try {
    const r1 = await dispMod.dispatchToUser('gen-user-2', 'weekly_report');
    check('первый прогон: sent', r1 === 'sent', r1);
    check('фото ушло с caption (HTML) и inline-кнопкой',
      captured.photos.length === 1 && captured.photos[0].caption?.includes('Еженедельный отчёт')
      && captured.photos[0].keyboard?.inline_keyboard?.[0]?.[0]?.url, captured.photos[0]?.keyboard);
    const photoUrl: string = captured.photos[0]?.keyboard?.inline_keyboard?.[0]?.[0]?.url ?? '';
    check('кнопка под фото: URL отчёта с k= и UTM (utm_source=telegram)',
      photoUrl.includes('https://frontend.test/reports/weekly/') && photoUrl.includes('?k=')
      && photoUrl.includes('utm_source=telegram') && photoUrl.includes('utm_medium=weekly_report'), photoUrl);
    const m = photoUrl.match(/[?&]k=([0-9a-f]+)/);
    check('токен из ссылки — ВАЛИДЕН для этого отчёта (SHA-256 пара в БД)',
      !!m && (await snap.validateReportAccessToken(s2!.id, m![1])));
    check('текст под фото: сводка (статистика + главные темы), кнопки нет (она под фото)',
      captured.messages.some((x) => x.text.includes('Всего новостей') && x.text.includes('Главные темы')
        && x.keyboard === undefined));
    check('ai=null → блок «Итоги недели» отсутствует, сводка всё равно уходит',
      captured.messages.every((x) => !x.text.includes('Итоги недели')));

    const sentRow = await q(`SELECT sent_at FROM weekly_reports WHERE id = $1`, [s2!.id]);
    check('после фан-аута sent_at проставлен', !!sentRow.rows[0]?.sent_at, sentRow.rows[0]);

    const msgsAfterFirst = captured.messages.length;
    const r2 = await dispMod.dispatchToUser('gen-user-2', 'weekly_report');
    check('повторный прогон в ту же неделю: 0 отправок (due-каналов нет), skipped',
      r2 === 'skipped' && captured.messages.length === msgsAfterFirst
      && captured.photos.length === 1, { r2, msgs: captured.messages.length });

    // Падение фото → текстовая сводка с inline-кнопкой (деградация п.11)
    (telegram as any).sendTelegramPhoto = async () => false;
    const r3 = await dispMod.dispatchToUser('gen-user-3', 'weekly_report');
    const lastMsg = captured.messages[captured.messages.length - 1];
    check('фото упало → сводка всё равно ушла, кнопка в последнем сообщении',
      r3 === 'sent' && !!lastMsg?.keyboard?.inline_keyboard?.[0]?.[0]?.url
      && lastMsg.text.includes('Всего новостей'), { r3, hasKeyboard: !!lastMsg?.keyboard });
    check('кнопка фолбэка: валидный magic-link (утм_source=telegram)',
      /\/reports\/weekly\/[^/?]+\?k=[0-9a-f]+&utm_source=telegram&utm_medium=weekly_report$/
        .test(lastMsg?.keyboard?.inline_keyboard?.[0]?.[0]?.url ?? ''),
      lastMsg?.keyboard?.inline_keyboard?.[0]?.[0]?.url);
  } finally {
    (telegram as any).sendTelegramPhoto = origPhoto;
    (telegram as any).sendTelegramMessage = origMsg;
  }

  // Гость-юзер без снапшота — skipped (фаза «а», регрессия)
  await seedUser('guest-user', 'guest@test.local', { plan: 'premium' });
  await seedSettings('guest-user');
  const rGuest = await dispMod.dispatchToUser('guest-user', 'weekly_report');
  check('юзер без снапшота → skipped (не падаем)', rGuest === 'skipped', rGuest);

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\nТЗ-191.4–10 HTTP-матрица: доступ, magic-link, SSRF-гард, архив, графики, live, календарь');
  // ═════════════════════════════════════════════════════════════════════════
  const jwt = (await import('jsonwebtoken')).default;
  const express = (await import('express')).default;
  const reportsRouter = (await import('../routes/reports')).default;
  const marketRouter = await import('../services/market/marketRouter');

  // Юзеры доступа
  await seedUser('owner', 'owner@test.local', { plan: 'premium' });
  await seedUser('other', 'other@test.local', { plan: 'premium' });
  await seedUser('admin', 'admin@test.local', { plan: 'premium', admin: true });
  await seedUser('blocked', 'blocked@test.local', { plan: 'premium', blocked: true });
  await seedPortfolio('owner', 'tag-sber', 'Сбербанк');
  await seedUser('live-user', 'live@test.local', { plan: 'premium' });
  await seedPortfolio('live-user', 'tag-live', 'Лайв');
  await seedPortfolio('live-user', 'tag-div', 'Дивиденды'); // тег без новостей — для «впереди»
  await seedNews('live-1', 'tag-live', 'positive', new Date(Date.now() - 2 * 3600 * 1000));
  // ТЗ-194: negative вместо neutral — иначе ненейтральная одна и live-серия
  // деградирует в null (порог по ненейтральным, а не по всем новостям)
  await seedNews('live-2', 'tag-live', 'negative', new Date(Date.now() - 6 * 3600 * 1000));
  await seedNews('live-prev', 'tag-live', 'neutral', new Date(Date.now() - 7 * DAY_MS - 3600 * 1000));

  // Снапшот владельца: тег с инструментом + тег без инструмента + AI-саммари
  const ownerContent: any = {
    period: '12 — 19 октября',
    tagSummaries: [
      { tagId: 'tag-sber', tagName: 'Сбербанк', articles: [makeArticle('sber', 1), makeArticle('sber', 2)] },
      { tagId: 'tag-plain', tagName: 'Нефть', articles: [makeArticle('oil', 1)] },
    ],
    totalArticles: 3,
    sentimentBreakdown: { positive: 2, negative: 0, neutral: 1 },
    stats: makeStats('tag-sber', 'Сбербанк', 2),
  };
  const ownerAi: any = {
    overall: 'Первая часть итогов.\n\nВторая часть.',
    perTag: [{ tagId: 'tag-sber', tagName: 'Сбербанк', summary: 'По тегу всё стабильно.' }],
    meta: { model: 'k', generated_at: '2026-10-19T11:00:00Z', articles_count: 3 },
  };
  const ownerSnapSaved = await snap.saveWeeklyReportSnapshot('owner', ownerContent, ownerAi);
  const ownerSnap = await snap.getWeeklyReportSnapshot(ownerSnapSaved.id);
  const ownerToken = await snap.issueReportAccessToken(ownerSnap!.id);
  await q(`INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, enriched_data)
           VALUES ('tag-sber', 'Сбербанк', 'company', $1)`,
    [JSON.stringify({ ticker: 'SBER', mic: 'MISX' })]);
  await q(`INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, enriched_data)
           VALUES ('other-tag', 'Чужой', 'company', $1)`,
    [JSON.stringify({ ticker: 'GAZP', mic: 'MISX' })]);

  // Мок marketRouter: свечи + счётчик вызовов
  let marketCalls = 0;
  let marketMode: 'ok' | 'maintenance' = 'ok';
  const origRange = marketRouter.getIntraday5minRange;
  const origExchanges = marketRouter.getExchanges;
  (marketRouter as any).getIntraday5minRange = async () => {
    marketCalls++;
    if (marketMode === 'maintenance') {
      const err: any = new Error('maintenance');
      err.code = 'finam_maintenance';
      throw err;
    }
    return {
      candles: [
        { time: '2026-10-13T10:00:00+03:00', open: 100, close: 101, low: 99, high: 102, volume: 10 },
        { time: '2026-10-14T10:00:00+03:00', open: 101, close: 110, low: 100, high: 111, volume: 20 },
      ],
    };
  };
  (marketRouter as any).getExchanges = async () => [{ mic: 'MISX', name: 'МосБиржа' }];

  const app = express();
  app.use('/api/reports', reportsRouter);
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/reports`;
  const J = (uid: string) => jwt.sign({ userId: uid, email: `${uid}@test.local` }, process.env.JWT_SECRET!, { expiresIn: '1h' });
  const httpGet = async (pathAndQuery: string, token?: string) => {
    const res = await fetch(`${base}${pathAndQuery}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, data: await res.json().catch(() => ({})) as any, headers: res.headers };
  };

  try {
    // ── 4. Доступ и is_blocked ──────────────────────────────────────────────
    const own = await httpGet(`/weekly/${ownerSnap!.id}`, J('owner'));
    check('свой отчёт → 200, контент + AI-саммари', own.status === 200
      && own.data.content?.tagSummaries?.length === 2 && own.data.ai?.overall === ownerAi.overall, own.status);
    const strangers = await httpGet(`/weekly/${ownerSnap!.id}`, J('other'));
    check('чужой отчёт → 404 (id не палим)', strangers.status === 404, strangers.status);
    const adminView = await httpGet(`/weekly/${ownerSnap!.id}`, J('admin'));
    check('админ → 200', adminView.status === 200, adminView.status);
    const blockedView = await httpGet(`/weekly/${ownerSnap!.id}`, J('blocked'));
    check('is_blocked=true со свежим JWT → 403 (authMiddleware не ловит — проверка своя)',
      blockedView.status === 403, blockedView.status);
    const noAuth = await httpGet(`/weekly/${ownerSnap!.id}`);
    check('без сессии и без ?k= → 401', noAuth.status === 401, noAuth.status);

    const chartOwn = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=tag-sber`, J('owner'));
    check('chart свой → 200', chartOwn.status === 200, chartOwn.status);
    const chartStranger = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=tag-sber`, J('other'));
    check('chart чужой → 404', chartStranger.status === 404, chartStranger.status);
    const chartBlocked = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=tag-sber`, J('blocked'));
    check('chart с is_blocked → 403', chartBlocked.status === 403, chartBlocked.status);

    // ── 5. Magic-link ───────────────────────────────────────────────────────
    const magic = await httpGet(`/weekly/${ownerSnap!.id}?k=${ownerToken}`);
    check('валидный ?k= без сессии → 200', magic.status === 200 && magic.data.ai?.overall === ownerAi.overall, magic.status);
    const magicChart = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=tag-sber&k=${ownerToken}`);
    check('валидный ?k= на chart → 200', magicChart.status === 200 && magicChart.data.chart, magicChart.status);
    const magicWrong = await httpGet(`/weekly/${ownerSnap!.id}?k=${'0'.repeat(48)}`);
    check('битый токен → 401', magicWrong.status === 401, magicWrong.status);
    const magicOtherReport = await httpGet(`/weekly/${s1!.id}?k=${ownerToken}`);
    check('токен чужого отчёта → 401 (привязка к report_id)', magicOtherReport.status === 401, magicOtherReport.status);
    const magicLive = await httpGet(`/weekly/current?k=${ownerToken}`);
    check('magic-link на /weekly/current → 401 (live — сессия only)', magicLive.status === 401, magicLive.status);
    await q(`UPDATE report_access_tokens SET expires_at = '2020-01-01 00:00:00' WHERE report_id = $1`, [ownerSnap!.id]);
    const magicExpired = await httpGet(`/weekly/${ownerSnap!.id}?k=${ownerToken}`);
    check('протухший токен → 401', magicExpired.status === 401, magicExpired.status);
    await snap.issueReportAccessToken(ownerSnap!.id); // вернём валидный для чистки
    const ownerTokenFresh = (await q(`SELECT token_hash FROM report_access_tokens WHERE report_id = $1`, [ownerSnap!.id])).rows[0].token_hash;
    // токен после удаления отчёта → 404
    const tmpId = crypto.randomUUID();
    await q(`INSERT INTO weekly_reports (id, user_id, week_start, payload, created_at, updated_at)
             VALUES ($1, 'owner', '2020-01-06', $2, datetime('now'), datetime('now'))`,
      [tmpId, JSON.stringify({ content: unitContent, ai: null })]);
    const tmpToken = await snap.issueReportAccessToken(tmpId);
    await q(`DELETE FROM weekly_reports WHERE id = $1`, [tmpId]);
    const magicDeleted = await httpGet(`/weekly/${tmpId}?k=${tmpToken}`);
    check('токен после удаления отчёта → 404', magicDeleted.status === 404, magicDeleted.status);
    check('в БД остался только хэш токена (plaintext не храним)',
      typeof ownerTokenFresh === 'string' && ownerTokenFresh.length === 64 && ownerTokenFresh !== ownerToken);

    // ── 6. SSRF-гард ────────────────────────────────────────────────────────
    const callsBefore = marketCalls;
    const ssrf1 = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=not-in-snapshot`, J('owner'));
    check('tag_id вне payload → 404', ssrf1.status === 404, ssrf1.status);
    const ssrf2 = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=other-tag`, J('owner'));
    check('чужой инструментальный тег (не в payload) → тоже 404', ssrf2.status === 404, ssrf2.status);
    check('SSRF: в marketRouter НИ ОДНОГО вызова', marketCalls === callsBefore, { before: callsBefore, after: marketCalls });

    // ── 8. График (архив) ───────────────────────────────────────────────────
    const c1 = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=tag-sber`, J('owner'));
    check('тег с инструментом → свечи, символ из payload тега',
      c1.status === 200 && c1.data.chart?.symbol === 'SBER@MISX' && c1.data.chart?.ohlc?.length === 2
      && c1.data.chart?.timezone === 'Europe/Moscow', c1.data.chart?.symbol);
    check('события ровно из tagSummaries (2 маркера с url статей)',
      c1.data.news_markers?.length === 2
      && c1.data.news_markers.every((m: any) => m.url.startsWith('https://example.com/sber-')), c1.data.news_markers);
    check('week_change_pct посчитан ((110-100)/100 = 10)', c1.data.week_change_pct === 10, c1.data.week_change_pct);
    check('ТЗ-194: 1 ненейтральная (1 pos + 1 neutral) → sentiment: null (порог по ненейтральным)',
      'sentiment' in c1.data && c1.data.sentiment === null, c1.data.sentiment);
    const callsAfterChart = marketCalls;
    const c1b = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=tag-sber`, J('owner'));
    check('повторный запрос (report_id, tag_id) — из кэша 24ч, marketRouter не дёргается',
      c1b.headers.get('x-cache') === 'hit' && marketCalls === callsAfterChart, { cache: c1b.headers.get('x-cache'), calls: marketCalls });
    const c2 = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=tag-plain`, J('owner'));
    check('тег без инструмента → 200 {chart:null}', c2.status === 200 && c2.data.chart === null, c2.data);
    marketMode = 'maintenance';
    const c3 = await httpGet(`/weekly/${ownerSnap!.id}/chart?tag_id=tag-sber&cb=${Date.now()}`, J('owner'));
    // кэш отдаст прошлый ответ — используем другой тег? нет: для деградации чистим кэш нельзя,
    // поэтому проверяем деградацию на отдельном отчёте ниже
    marketMode = 'ok';
    const degId = crypto.randomUUID();
    // неделя ДО текущей — у владельца уже есть снапшот текущей недели (UNIQUE)
    await q(`INSERT INTO weekly_reports (id, user_id, week_start, payload, created_at, updated_at)
             VALUES ($1, 'owner', $2, $3, datetime('now'), datetime('now'))`,
      [degId, mskDayStr(mondayMsk(new Date(Date.now() - 7 * DAY_MS))), JSON.stringify({ content: ownerContent, ai: null })]);
    marketMode = 'maintenance';
    const c4 = await httpGet(`/weekly/${degId}/chart?tag_id=tag-sber`, J('owner'));
    check('мок finam_maintenance → 200 {chart:null, reason:market_unavailable} (страница цела)',
      c4.status === 200 && c4.data.chart === null && c4.data.reason === 'market_unavailable', c4.data);
    marketMode = 'ok';

    // ── ТЗ-192: маркеры вне окна недели отсекаются (анти-снап к крайней свече) ─
    const tzId = crypto.randomUUID();
    const tzContent: any = {
      period: '5 — 11 октября',
      tagSummaries: [{
        tagId: 'tag-sber', tagName: 'Сбербанк',
        articles: [
          { ...makeArticle('sber', 1), publishedAt: '2026-10-06T10:05:00+03:00' }, // внутри недели
          { ...makeArticle('sber', 9), publishedAt: '2026-10-03T10:00:00+03:00' }, // до начала недели
          { ...makeArticle('sber', 8), publishedAt: '2026-10-13T10:00:00+03:00' }, // после конца недели
        ],
      }],
      totalArticles: 3,
      sentimentBreakdown: { positive: 1, negative: 0, neutral: 2 },
      stats: null,
    };
    await q(`INSERT INTO weekly_reports (id, user_id, week_start, payload, created_at, updated_at)
             VALUES ($1, 'owner', '2026-10-05', $2, datetime('now'), datetime('now'))`,
      [tzId, JSON.stringify({ content: tzContent, ai: null })]);
    const cTz = await httpGet(`/weekly/${tzId}/chart?tag_id=tag-sber`, J('owner'));
    check('ТЗ-192: маркер внутри недели остался, вне окна отсечены (без снапа к крайней свече)',
      cTz.status === 200 && cTz.data.news_markers?.length === 1
      && cTz.data.news_markers[0].url === 'https://example.com/sber-1', cTz.data.news_markers);

    // ── ПРАВКА-2 к ТЗ-191: маркеры/сантимент из chartEvents (все новости недели),
    //    а не из кепнутых articles ────────────────────────────────────────────
    const ceId = crypto.randomUUID();
    const ceContent: any = {
      period: '28 сентября — 4 октября',
      tagSummaries: [{
        tagId: 'tag-sber', tagName: 'Сбербанк',
        articles: [makeArticle('sber', 1)], // кепнутая свежая 1 статья
        chartEvents: ['2026-09-28T10:01:00+03:00', '2026-09-29T10:02:00+03:00',
                      '2026-09-30T10:03:00+03:00', '2026-10-01T10:04:00+03:00'].map((iso, i) => ({
          title: `Событие недели ${i + 1}`, source: 'РБК', sentiment: i % 2 ? 'neutral' : 'positive',
          url: `https://example.com/week-ev-${i + 1}`,
          publishedAt: iso,
        })),
      }],
      totalArticles: 1,
      sentimentBreakdown: { positive: 1, negative: 0, neutral: 0 },
      stats: null,
    };
    await q(`INSERT INTO weekly_reports (id, user_id, week_start, payload, created_at, updated_at)
             VALUES ($1, 'owner', '2026-09-28', $2, datetime('now'), datetime('now'))`,
      [ceId, JSON.stringify({ content: ceContent, ai: null })]);
    const cCe = await httpGet(`/weekly/${ceId}/chart?tag_id=tag-sber`, J('owner'));
    check('ПРАВКА-2: маркеры ВСЕ из chartEvents (4 шт, url week-ev-*), а не из кепнутой 1 articles',
      cCe.status === 200 && cCe.data.news_markers?.length === 4
      && cCe.data.news_markers.every((m: any) => m.url.startsWith('https://example.com/week-ev-')),
      cCe.data.news_markers?.map((m: any) => m.url));
    check('ТЗ-194: накопительная кривая из chartEvents (pos,neutral,pos,neutral → 2 точки, cum 1→2)',
      Array.isArray(cCe.data.sentiment) && cCe.data.sentiment.length === 2
      && cCe.data.sentiment[0].cum === 1 && cCe.data.sentiment[1].cum === 2
      && cCe.data.sentiment[0].t === '2026-09-28T07:01:00.000Z' // 10:01 МСК
      // фикстура без newsId — старые снапшоты: null в точках
      && cCe.data.sentiment.every((p: any) => p.news_id === null),
      cCe.data.sentiment);

    // ── 7. Архив (HTTP) ─────────────────────────────────────────────────────
    const archive = await httpGet(`/weekly`, J('archive-user'));
    const reports: any[] = archive.data.reports ?? [];
    check('GET /weekly → 200, ≤12 строк', archive.status === 200 && reports.length === 12, reports.length);
    check('архив: свежие первыми', reports.every((r, i) => i === 0 || reports[i - 1].week_start >= r.week_start),
      reports.slice(0, 3).map((r) => r.week_start));
    check('архив: метаданные без полного payload (нет content/ai, есть total/top_tag)',
      reports.every((r) => 'content' in r === false && 'ai' in r === false
        && 'id' in r && 'week_start' in r && 'total' in r && 'top_tag' in r));

    // ── 9. Live ─────────────────────────────────────────────────────────────
    let moonshotDuringLive = 0;
    (axios as any).post = async (url: string) => {
      if (String(url).includes('moonshot')) { moonshotDuringLive++; return { data: {} }; }
      return { data: { ok: true } };
    };
    const elapsed = statsMod.elapsedWeekdays();
    const live1 = await httpGet(`/weekly/current`, J('live-user'));
    check('live → 200, live:true, elapsed_days = прошедшие будни',
      live1.status === 200 && live1.data.live === true && live1.data.elapsed_days === elapsed,
      { status: live1.status, elapsed: live1.data.elapsed_days });
    const liveStats = live1.data.content?.stats;
    check('live: perDay только прошедшие будни', liveStats?.perDay?.length === elapsed, liveStats?.perDay?.length);
    check('live: pace (будни-к-будням) без % дельт',
      typeof live1.data.pace?.elapsed_total === 'number'
      && typeof live1.data.pace?.prev_same_weekdays_total === 'number'
      && liveStats?.kpis?.totalDeltaWeekPct === null, live1.data.pace);
    check('live: 0 LLM-вызовов', moonshotDuringLive === 0, moonshotDuringLive);
    const live2 = await httpGet(`/weekly/current`, J('live-user'));
    check('live: повторный запрос — из кэша 5 мин (X-Cache: hit)', live2.headers.get('x-cache') === 'hit');
    // live-chart: события из live-контента
    await q(`INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, enriched_data)
             VALUES ('tag-live', 'Лайв', 'company', $1)`, [JSON.stringify({ ticker: 'LKOH', mic: 'MISX' })]);
    const lc = await httpGet(`/weekly/current/chart?tag_id=tag-live`, J('live-user'));
    check('live-chart → 200, события из live-контента (url текущей недели)',
      lc.status === 200 && lc.data.news_markers?.length === 2
      && lc.data.news_markers.every((m: any) => m.url.startsWith('https://example.com/live-')),
      lc.data.news_markers?.length);
    check('ТЗ-194: live-chart — накопительная кривая (2 ненейтральные → 2 ступени, конец = pos−neg = 0)',
      'sentiment' in lc.data && Array.isArray(lc.data.sentiment) && lc.data.sentiment.length === 2
      && lc.data.sentiment[0].cum === -1 && lc.data.sentiment[1].cum === 0
      // порядок строго published_at: live-2 (6 ч назад) раньше live-1 (2 ч назад);
      // news_id из БД доехал до точки (CAST(id AS TEXT))
      && lc.data.sentiment[0].news_id === 'live-2' && lc.data.sentiment[1].news_id === 'live-1',
      lc.data.sentiment);
    (axios as any).post = origPost;
    // воскресный сценарий: снапшот появился → {snapshot_id}
    const liveSnap = await snap.saveWeeklyReportSnapshot('live-user', ownerContent, null);
    const live3 = await httpGet(`/weekly/current`, J('live-user'));
    check('после генерации live отвечает {snapshot_id} (фронт редиректит в архив)',
      live3.status === 200 && live3.data.snapshot_id === liveSnap.id, live3.data);

    // ── 10. Календарь «впереди» ─────────────────────────────────────────────
    const nextMonday = dayStr(new Date(mondayMsk().getTime() + 7 * DAY_MS));
    const nextTuesday = dayStr(new Date(mondayMsk().getTime() + 8 * DAY_MS));
    const nextThursday = dayStr(new Date(mondayMsk().getTime() + 10 * DAY_MS));
    const ev = (date: string, title: string, kind: string, ticker: string, tagIds: string[]) =>
      q(`INSERT INTO calendar_events (id, date, weekday, title, kind, status, company, ticker, tag_ids)
         VALUES ($1, $2, 'Вт', $3, $4, 'expected', $5, $6, $7)`,
        [crypto.randomUUID(), date, title, kind, `Компания ${ticker}`, ticker, JSON.stringify(tagIds)]);
    await ev(nextTuesday, 'Отчёт МСФО', 'МСФО', 'SBER', ['tag-sber', 'tag-live']); // совпадает с портфелем owner и live-user
    await ev(nextTuesday, 'Отчёт МСФО', 'МСФО', 'XYZ', ['tag-other']);    // без пересечения — фильтр
    await ev(nextThursday, 'Дивиденды', 'Дивиденды', 'DIV', ['tag-div']); // тег без новостей — видно
    const aheadLive = await httpGet(`/weekly/current/ahead`, J('live-user'));
    const aheadTitles = JSON.stringify(aheadLive.data);
    check('впереди (live): события с пересечением тегов портфеля — в ответе',
      aheadLive.status === 200 && aheadLive.data.ahead?.days?.length > 0, aheadLive.data);
    check('впереди: событие без пересечения отфильтровано', !aheadTitles.includes('XYZ'), aheadTitles.slice(0, 200));
    check('впереди: тег без новостей, но с событием — событие видно', aheadTitles.includes('Дивиденды'));
    check('впереди: пометка «expected» и компания с тикером', aheadTitles.includes('expected') && aheadTitles.includes('SBER'));
    // архивный ahead — по портфелю ВЛАДЕЛЬЦА отчёта
    const aheadArchive = await httpGet(`/weekly/${ownerSnap!.id}/ahead`, J('owner'));
    check('впереди (архив): тот же read-path, событие по тегу портфеля владельца',
      aheadArchive.status === 200 && JSON.stringify(aheadArchive.data).includes('SBER'), aheadArchive.status);
    // календарь не загружен → {ahead: null}
    await q(`DELETE FROM calendar_events`, []);
    await seedUser('no-cal-user', 'nocal@test.local', { plan: 'premium' });
    const aheadEmpty = await httpGet(`/weekly/current/ahead`, J('no-cal-user'));
    check('календарь пуст → 200 {ahead:null}', aheadEmpty.status === 200 && aheadEmpty.data.ahead === null, aheadEmpty.data);
  } finally {
    (marketRouter as any).getIntraday5minRange = origRange;
    (marketRouter as any).getExchanges = origExchanges;
    server.close();
  }

  skip('п.12 FE-рендер страницы', 'фронтенд-скоп (pulse-frontend): рендер на моковом payload, live-бейдж, стирание ?k= — проверяется в React-тестах/ручным чек-листом');
  skip('PG-варианты SQL', 'нужен живой PG на VPS — SQLite-ветки идентичны по логике');

  console.log(`\nИтого: ${passed} ok, ${failed} fail, ${skipped} skip`);
  fs.rmSync(process.env.SQLITE_FILE!, { force: true });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  if (process.env.SQLITE_FILE) fs.rmSync(process.env.SQLITE_FILE, { force: true });
  process.exit(1);
});
