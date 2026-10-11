/**
 * =============================================================================
 * PULSE — LMS: SEO-пересборка курсов при сохранении (ТЗ-164, event-driven)
 * =============================================================================
 *
 * ФОРМАТ ФАЙЛОВ = scripts/seo-prerender.mts pulse-frontend; при правке формул
 * ТЗ-140/163 править оба места.
 *
 * Фронтовый build-time пререндер (ТЗ-140) остаётся первичным покрытием при
 * деплое и fallback'ом. Этот сервис перегенерирует те же файлы (витрина,
 * карточки курсов, sitemap.xml, robots.txt) напрямую в /opt/pulse/frontend/dist
 * при любой SEO-релевантной мутации из adminEducation.ts — без сборки фронта.
 *
 * Публичные функции:
 *   - scheduleEducationSeoRebuild() — неблокирующий планировщик (дебаунс
 *     EDU_SEO_REBUILD_DEBOUNCE_SEC + защита «не чаще раза в 5 минут»).
 *     Все мутации админки зовут ТОЛЬКО её.
 *   - rebuildEducationSeoNow() — собственно пересборка (ручной роут + heal).
 *   - initEducationSeoBootHeal() — вызывается из точки старта сервера:
 *     свежий dist залили вручную → education/* пропал → пересобрать.
 *
 * Env (fail-soft): EDU_SEO_ENABLED (default 'true'), EDU_SEO_DIST
 * (default '/opt/pulse/frontend/dist'), EDU_SEO_REBUILD_DEBOUNCE_SEC (60).
 * Шелла нет (локальная разработка / Render) → warn и мягкий пропуск, НЕ падение.
 * Ошибка пересборки → лог + notifyAdminsSystemAlert; старые файлы не трогаем
 * (каждый файл пишется атомарно: временный файл + rename в той же директории).
 */

import fs from 'fs';
import path from 'path';
import { query } from '../../config/db';
import { notifyAdminsSystemAlert } from '../adminAlerts';

const ENABLED = (process.env.EDU_SEO_ENABLED ?? 'true') !== 'false';
const DIST_DIR = process.env.EDU_SEO_DIST ?? '/opt/pulse/frontend/dist';
const DEBOUNCE_SEC = Math.max(1, Number(process.env.EDU_SEO_REBUILD_DEBOUNCE_SEC ?? 60) || 60);
const MIN_INTERVAL_MS = 5 * 60 * 1000; // «не чаще раза в 5 минут» от фактического старта

// ─── Формулы меты — порт src/lib/seo.ts pulse-frontend (ТЗ-140/163) ────────
// ВНИМАНИЕ: это копия фронтовых формул. При правке менять в обоих местах.

const BASE = 'https://pulse.inside-trade.ru';

const VITRINE_TITLE = 'Образование — бесплатные и платные курсы | PULSE';

const VITRINE_DESCRIPTION =
  'Бесплатные и платные курсы по инвестициям и финансовым рынкам: мини-курсы по актуальным новостям, полные программы с уроками и материалами от редакции PULSE.';

const OG_DEFAULT_IMAGE = '/og-default.png';

/** Title курса с правилом длины 50–60: суффикс «— курс на PULSE», затем «| PULSE», затем только название. */
export function courseTitle(name: string): string {
  const full = `${name} — курс на PULSE`;
  if (full.length <= 60) return full;
  const short = `${name} | PULSE`;
  if (short.length <= 60) return short;
  return name;
}

/** Meta description: окно 0..155, обрезка по последнему пробелу (но не короче 140, иначе жёсткие 155). */
export function metaDescription(htmlOrText: string | null | undefined): string | null {
  const text = htmlToPlainText(htmlOrText ?? '').replace(/\n+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= 160) return text;
  const window = text.slice(0, 156);
  const lastSpace = window.lastIndexOf(' ');
  if (lastSpace >= 140) return window.slice(0, lastSpace);
  return window.slice(0, 155);
}

/** Canonical URL карточки курса. */
export function canonicalCourse(slug: string, base: string = BASE): string {
  return `${base}/education/${slug}`;
}

/** Относительный путь или уже абсолютный URL → абсолютный URL. */
export function absoluteUrl(pathOrUrl: string | null | undefined, base: string = BASE): string {
  if (!pathOrUrl) return base;
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl;
  if (pathOrUrl.startsWith('/')) return `${base}${pathOrUrl}`;
  return `${base}/${pathOrUrl}`;
}

/** HTML → plain text: script/style вырезаем, границы блоков → переносы строк, теги удаляем,
 *  entities декодируем, пробелы схлопываем. */
export function htmlToPlainText(html: string): string {
  const noScripts = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|blockquote|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const decoded = decodeEntities(noScripts);
  return decoded
    .split('\n')
    .map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Декодирование HTML-entities, которые реально встречаются в текстах курсов. */
export function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => named[name] ?? m);
}

/** HTML-escape для вставки произвольных строк в title/meta/тело статики (& < > " '). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Слой данных ────────────────────────────────────────────────────────────

export interface SeoLesson {
  position: number;
  title: string;
  duration_min: number | null;
}

export interface SeoCourse {
  slug: string;
  title: string;
  description: string | null;
  cover_url: string | null;
  price: number | null;
  author: string | null;
  created_at: string | null;
  type: string;
  badges: string[];
  is_expired: boolean;
  program: SeoLesson[];
}

function parseBadges(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Протухание situational-курса — та же логика, что isExpiredCourse в routes/education.ts. */
function isExpiredCourse(row: any, now: number): boolean {
  if (row.type === 'situational' && row.source_type !== null && row.source_news_id === null) {
    return true; // источник умер (ON DELETE SET NULL) — актуальности нет
  }
  if (row.relevant_until) {
    const until = new Date(row.relevant_until).getTime();
    return Number.isFinite(until) && until <= now;
  }
  return false;
}

/**
 * Публичный набор курсов напрямую из БД: тот же фильтр, что у витрины
 * (routes/education.ts: status='published' AND deleted_at IS NULL AND
 * visibility='public'), и тот же порядок полок (hot → recommended → fresh →
 * каталог внутри created_at DESC) — чтобы файлы совпадали с фронтовым
 * пререндером побайтово. Программа — уроки по position (title, duration_min).
 */
async function loadPublicSeoCourses(): Promise<SeoCourse[]> {
  const rows = await query(
    `SELECT id, slug, title, description, cover_url, price, author, created_at,
            type, badges, relevant_until, source_type, source_news_id
     FROM courses
     WHERE status = 'published' AND deleted_at IS NULL AND visibility = 'public'
     ORDER BY created_at DESC
     LIMIT 200`,
    [],
  );

  const now = Date.now();
  const list = rows.rows.map((r: any) => ({
    id: String(r.id),
    slug: String(r.slug),
    title: String(r.title),
    description: (r.description ?? null) as string | null,
    cover_url: (r.cover_url ?? null) as string | null,
    price: r.price != null ? Number(r.price) : null,
    author: (r.author ?? null) as string | null,
    created_at: (r.created_at ?? null) as string | null,
    type: String(r.type ?? 'course'),
    badges: parseBadges(r.badges),
    is_expired: isExpiredCourse(r, now),
  }));

  // Полки — копия логики produce() витрины: situational-непротухшие (≤10) →
  // бейдж recommended → бейдж new → остальное каталогом.
  const hot: typeof list = [];
  const recommended: typeof list = [];
  const fresh: typeof list = [];
  const inShelf = new Set<string>();
  for (const c of list) {
    if (c.type === 'situational' && !c.is_expired) {
      if (hot.length < 10) { hot.push(c); inShelf.add(c.slug); continue; }
    }
    if (c.badges.includes('recommended')) { recommended.push(c); inShelf.add(c.slug); continue; }
    if (c.badges.includes('new')) { fresh.push(c); inShelf.add(c.slug); continue; }
  }
  const ordered = [...hot, ...recommended, ...fresh, ...list.filter(c => !inShelf.has(c.slug))];

  const courses: SeoCourse[] = [];
  for (const c of ordered) {
    const lessons = await query(
      `SELECT position, title, duration_min
       FROM course_lessons
       WHERE course_id = $1
       ORDER BY position ASC`,
      [c.id],
    );
    courses.push({
      ...c,
      program: lessons.rows.map((l: any) => ({
        position: Number(l.position),
        title: String(l.title),
        duration_min: l.duration_min != null ? Number(l.duration_min) : null,
      })),
    });
  }
  return courses;
}

// ─── Манипуляции со шеллом — порт scripts/seo-prerender.mts ──────────────

function setTitle(html: string, title: string): string {
  return html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
}

/** Существующий в шелле canonical (если остался) — заменяем, не дублируем. */
function stripCanonical(html: string): string {
  return html.replace(/\s*<link[^>]*rel="canonical"[^>]*\/?>/g, '');
}

/** OG/Twitter/description/canonical — сразу после <meta charset>. */
function injectMeta(html: string, snippet: string): string {
  return html.replace(/<meta charset[^>]*>/, (m) => `${m}\n    ${snippet}`);
}

function injectJsonLd(html: string, objects: object[]): string {
  const scripts = objects
    .map(
      (o) =>
        `    <script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`,
    )
    .join('\n');
  return html.replace('</head>', `${scripts}\n  </head>`);
}

/** Статический plain-text блок внутрь #root (SPA очистит контейнер при старте). */
function injectRoot(html: string, block: string): string {
  if (html.includes('<div id="root"></div>')) {
    return html.replace('<div id="root"></div>', `<div id="root">${block}</div>`);
  }
  return html.replace(/<div id="root">/, `<div id="root">${block}`);
}

// ─── Генераторы контента — порт scripts/seo-prerender.mts ────────────────

function ogSnippet(opts: {
  title: string;
  description: string | null;
  canonical: string;
  image: string;
  imageAlt: string;
}): string {
  const desc = escapeHtml(opts.description ?? '');
  const tags: string[] = [
    // Пустое описание → meta description не выводим вовсе (ТЗ-140).
    ...(opts.description
      ? [`<meta name="description" content="${desc}">`]
      : []),
    `<link rel="canonical" href="${escapeHtml(opts.canonical)}">`,
    `<meta property="og:title" content="${escapeHtml(opts.title)}">`,
    ...(opts.description ? [`<meta property="og:description" content="${desc}">`] : []),
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${escapeHtml(opts.canonical)}">`,
    `<meta property="og:site_name" content="PULSE">`,
    `<meta property="og:image" content="${escapeHtml(opts.image)}">`,
    `<meta property="og:locale" content="ru_RU">`,
    `<meta property="og:image:alt" content="${escapeHtml(opts.imageAlt)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(opts.title)}">`,
    ...(opts.description ? [`<meta name="twitter:description" content="${desc}">`] : []),
    `<meta name="twitter:image" content="${escapeHtml(opts.image)}">`,
  ];
  return tags.join('\n    ');
}

function courseJsonLd(card: SeoCourse, image: string): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: card.title,
    description: htmlToPlainText(card.description ?? ''),
    provider: { '@type': 'Organization', name: 'PULSE', sameAs: BASE },
    ...(card.price != null
      ? { offers: { '@type': 'Offer', price: card.price, priceCurrency: 'RUB' } }
      : {}),
    image,
    ...(card.program && card.program.length > 0
      ? {
          syllabusSections: [
            {
              '@type': 'Syllabus',
              name: 'Программа курса',
              children: card.program.map((l) => ({ '@type': 'Course', name: l.title })),
            },
          ],
        }
      : {}),
  };
}

function breadcrumbJsonLd(title: string, canonical: string): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Главная', item: `${BASE}/` },
      { '@type': 'ListItem', position: 2, name: 'Образование', item: `${BASE}/education` },
      { '@type': 'ListItem', position: 3, name: title, item: canonical },
    ],
  };
}

function itemListJsonLd(courses: { slug: string; title: string }[]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: courses.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      url: `${BASE}/education/${c.slug}`,
      item: {
        '@type': 'Course',
        name: c.title,
        provider: { '@type': 'Organization', name: 'PULSE' },
      },
    })),
  };
}

export function courseBodyBlock(card: SeoCourse): string {
  const paragraphs = htmlToPlainText(card.description ?? '')
    .split('\n')
    .filter(Boolean)
    .slice(0, 3);
  const priceText = card.price != null && card.price > 0 ? `${card.price.toLocaleString('ru-RU')} ₽` : 'Бесплатно';
  const authorText = card.author ? ` · Автор: ${escapeHtml(card.author)}` : '';
  const lessons = (card.program ?? [])
    .map(
      (l) =>
        `<li>${escapeHtml(`${l.position}. ${l.title}`)}${l.duration_min != null ? ` (${escapeHtml(String(l.duration_min))} мин)` : ''}</li>`,
    )
    .join('');
  return [
    '<div class="seo-prerender">',
    `<h1>${escapeHtml(card.title)}</h1>`,
    ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
    lessons ? '<h2>Программа курса</h2>' : '',
    lessons ? `<ol>${lessons}</ol>` : '',
    `<p><small>${escapeHtml(`Цена: ${priceText}`)}${authorText}</small></p>`,
    '<p><a href="/education">← Все курсы (Образование)</a></p>',
    '</div>',
  ]
    .filter(Boolean)
    .join('');
}

function vitrineBodyBlock(courses: { slug: string; title: string; price: number | null }[]): string {
  const items = courses
    .map(
      (c) =>
        `<li><a href="/education/${escapeHtml(c.slug)}">${escapeHtml(c.title)}</a> — ${c.price != null && c.price > 0 ? 'платный' : 'бесплатный'}</li>`,
    )
    .join('');
  return [
    '<div class="seo-prerender">',
    '<h1>Образование</h1>',
    `<ul>${items}</ul>`,
    '</div>',
  ].join('');
}

// ─── robots.txt / sitemap.xml — порт scripts/seo-prerender.mts ───────────

export function robotsTxt(): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /profile',
    'Disallow: /api/',
    `Sitemap: ${BASE}/sitemap.xml`,
    '',
  ].join('\n');
}

export function sitemapXml(courses: { slug: string; created_at: string | null }[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const staticUrls = ['/', '/education', '/pricing', '/instructions', '/sentiment', '/download'];
  const rows: string[] = [];
  for (const p of staticUrls) {
    rows.push(`  <url><loc>${esc(BASE + p)}</loc></url>`);
  }
  for (const c of courses) {
    const lastmod = c.created_at ? new Date(c.created_at) : null;
    const lastmodTag =
      lastmod && !Number.isNaN(lastmod.getTime())
        ? `<lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>`
        : '';
    rows.push(`  <url><loc>${esc(`${BASE}/education/${c.slug}`)}</loc>${lastmodTag}</url>`);
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...rows,
    '</urlset>',
    '',
  ].join('\n');
}

// ─── Рендер страниц — порт main() scripts/seo-prerender.mts ──────────────

export function renderVitrineHtml(shell: string, courses: SeoCourse[]): string {
  const publicCards = courses.filter(
    (c) => c.slug && !c.slug.includes('/') && !c.slug.includes('..'),
  );
  const vitrineMeta = ogSnippet({
    title: VITRINE_TITLE,
    description: VITRINE_DESCRIPTION,
    canonical: `${BASE}/education`,
    image: absoluteUrl(OG_DEFAULT_IMAGE, BASE),
    imageAlt: VITRINE_TITLE,
  });
  let html = stripCanonical(shell);
  html = setTitle(html, VITRINE_TITLE);
  html = injectMeta(html, vitrineMeta);
  html = injectJsonLd(html, [itemListJsonLd(publicCards.map((c) => ({ slug: c.slug, title: c.title })))]);
  html = injectRoot(html, vitrineBodyBlock(publicCards));
  return html;
}

export function renderCourseHtml(shell: string, card: SeoCourse): string {
  const title = courseTitle(card.title);
  const description = metaDescription(card.description);
  const canonical = canonicalCourse(card.slug, BASE);
  const image = card.cover_url ? absoluteUrl(card.cover_url, BASE) : absoluteUrl(OG_DEFAULT_IMAGE, BASE);
  let html = stripCanonical(shell);
  html = setTitle(html, title);
  html = injectMeta(html, ogSnippet({ title, description, canonical, image, imageAlt: card.title }));
  html = injectJsonLd(html, [courseJsonLd(card, image), breadcrumbJsonLd(card.title, canonical)]);
  html = injectRoot(html, courseBodyBlock(card));
  return html;
}

// ─── Атомарная запись + чистка ─────────────────────────────────────────────

/** Атомарная запись: временный файл в той же директории + rename. */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, content);
  await fs.promises.rename(tmp, filePath);
}

/**
 * Чистка протухших директорий: удаляет education/<slug>/ для слагов, которых
 * нет в текущем публичном наборе (курс скрыли/архивировали — HTML должен
 * исчезнуть, иначе URL продолжит отдавать старую карточку). education/index.html
 * (витрина) и всё, не являющееся директорией-карточкой, НЕ трогаем.
 */
export async function cleanupStaleCourseDirs(educationDir: string, currentSlugs: Set<string>): Promise<number> {
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(educationDir, { withFileTypes: true });
  } catch {
    return 0; // директории ещё нет — писать всё равно будем
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const slug = entry.name;
    if (currentSlugs.has(slug)) continue;
    if (slug.includes('/') || slug.includes('..')) continue;
    try {
      await fs.promises.rm(path.join(educationDir, slug), { recursive: true, force: true });
      removed++;
      console.log(`[EduSeo] удалена протухшая директория курса: education/${slug}/`);
    } catch (err: any) {
      console.warn(`[EduSeo] не удалось удалить education/${slug}/:`, err?.message);
    }
  }
  return removed;
}

/**
 * Генерация и запись всех SEO-файлов в distDir (витрина, карточки курсов,
 * sitemap.xml, robots.txt). Отдельна от чтения данных, чтобы её можно было
 * прогонять без БД. Возвращает число записанных карточек курсов.
 */
export async function writeEducationSeoFiles(
  distDir: string,
  shell: string,
  courses: SeoCourse[],
): Promise<number> {
  const publicCards = courses.filter(
    (c) => c.slug && !c.slug.includes('/') && !c.slug.includes('..'),
  );

  const educationDir = path.join(distDir, 'education');
  await fs.promises.mkdir(educationDir, { recursive: true });

  // Чистка ПЕРЕД записью карточек: скрытый/архивированный курс не должен
  // оставить старый HTML (витринный index.html не трогаем).
  await cleanupStaleCourseDirs(educationDir, new Set(publicCards.map((c) => c.slug)));

  await writeFileAtomic(path.join(educationDir, 'index.html'), renderVitrineHtml(shell, courses));
  for (const card of publicCards) {
    const dir = path.join(educationDir, card.slug);
    await fs.promises.mkdir(dir, { recursive: true });
    await writeFileAtomic(path.join(dir, 'index.html'), renderCourseHtml(shell, card));
  }

  await writeFileAtomic(path.join(distDir, 'robots.txt'), robotsTxt());
  await writeFileAtomic(path.join(distDir, 'sitemap.xml'), sitemapXml(
    publicCards.map((c) => ({ slug: c.slug, created_at: c.created_at })),
  ));

  return publicCards.length;
}

// ─── Планировщик ────────────────────────────────────────────────────────────

let pendingTimer: NodeJS.Timeout | null = null;
let running = false;
let lastRunStartAt = 0;

function runRebuild(): void {
  if (running) {
    // Предыдущая пересборка ещё идёт — отложим повторный проход.
    scheduleTimer(30 * 1000);
    return;
  }
  const elapsed = Date.now() - lastRunStartAt;
  if (elapsed < MIN_INTERVAL_MS) {
    scheduleTimer(MIN_INTERVAL_MS - elapsed);
    return;
  }
  running = true;
  lastRunStartAt = Date.now();
  rebuildEducationSeoNow()
    .then(({ courses }) => {
      if (courses > 0) console.log(`[EduSeo] пересборка завершена: ${courses} курсов`);
    })
    .catch((err: any) => {
      console.error('[EduSeo] пересборка не удалась:', err?.message || err);
      notifyAdminsSystemAlert(`SEO-пересборка образования не удалась: ${err?.message || err}`).catch(() => {});
    })
    .finally(() => {
      running = false;
    });
}

function scheduleTimer(delayMs: number): void {
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    runRebuild();
  }, delayMs);
  pendingTimer.unref?.();
}

/**
 * Неблокирующий планировщик: каждый вызов сдвигает пересборку на
 * EDU_SEO_REBUILD_DEBOUNCE_SEC (дефолт 60) вперёд; фактический старт не чаще
 * раза в 5 минут. Ответ админке не ждёт пересборки.
 */
export function scheduleEducationSeoRebuild(): void {
  if (!ENABLED) return;
  scheduleTimer(DEBOUNCE_SEC * 1000);
}

// ─── Собственно пересборка ──────────────────────────────────────────────────

/**
 * Перегенерирует education/index.html, education/<slug>/index.html,
 * sitemap.xml и robots.txt в EDU_SEO_DIST. Бросает ошибку при отключённом
 * сервисе или сбое генерации (вызывающий код решает, как реагировать);
 * отсутствие шелла — мягкий пропуск: warn + { courses: 0 }.
 */
export async function rebuildEducationSeoNow(): Promise<{ courses: number }> {
  if (!ENABLED) {
    throw new Error('SEO-пересборка образования отключена (EDU_SEO_ENABLED=false)');
  }

  const shellPath = path.join(DIST_DIR, 'index.html');
  let shell: string;
  try {
    shell = await fs.promises.readFile(shellPath, 'utf8');
  } catch {
    console.warn(`[EduSeo] шелл ${shellPath} не найден — пропуск пересборки (настройте EDU_SEO_DIST или отключите EDU_SEO_ENABLED)`);
    return { courses: 0 };
  }

  const courses = await loadPublicSeoCourses();
  const written = await writeEducationSeoFiles(DIST_DIR, shell, courses);
  return { courses: written };
}

// ─── Boot-heal ──────────────────────────────────────────────────────────────

/**
 * Точка старта сервера: свежий dist залили вручную (DEPLOYMENT.md §«Обновление
 * версии») — education/* пропал вместе с остальным dist. Если шелл на месте,
 * а витринный index.html отсутствует — планируем пересборку. Синхронная и
 * дешёвая (два existsSync), безопасна без БД (пересборка отложена таймером).
 */
export function initEducationSeoBootHeal(): void {
  if (!ENABLED) return;
  const shellPath = path.join(DIST_DIR, 'index.html');
  const vitrinePath = path.join(DIST_DIR, 'education', 'index.html');
  if (fs.existsSync(shellPath) && !fs.existsSync(vitrinePath)) {
    console.warn('[EduSeo] education/index.html отсутствует при наличии шелла — планирую пересборку (boot-heal)');
    scheduleEducationSeoRebuild();
  }
}

export default {
  scheduleEducationSeoRebuild,
  rebuildEducationSeoNow,
  initEducationSeoBootHeal,
};
