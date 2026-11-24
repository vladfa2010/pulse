/**
 * =============================================================================
 * probe_tz229 v1 ↔ ТЗ-229 v1
 * =============================================================================
 *
 * Проба калибровки порогов «материалы к новости» (Задача 4 ТЗ-229).
 * Запускается ВРУЧНУЮ на проде ДО включения NEWS_MATERIALS_ENABLED.
 *
 *   docker exec \
 *     -e NEWS_MATERIALS_LESSON_MIN_SIM=0 -e NEWS_MATERIALS_COURSE_MIN_SIM=0 \
 *     -e NEWS_MATERIALS_LESSON_TOP=5 -e NEWS_MATERIALS_COURSE_TOP=5 \
 *     pulse-backend node scripts/probe_tz229.js
 *
 * Env-переопределения подавляют пороги/лимиты конфига на время пробы (конфиг
 * читается при импорте), подбор идёт ТЕМ ЖЕ кодом сервиса
 * (services/education/newsMaterials), что продовые эндпоинты — проба измеряет
 * боевую логику, а не её копию.
 *
 * Вывод: распределение top-1 косинусов (p10/p50/p90) для уроков и курсов,
 * 15 лучших и 15 пограничных пар «новость ↔ материал» с заголовками для
 * глазной оценки (уроки: пограничье 0.20–0.35; курсы: около 0.60).
 */

/* eslint-disable no-console */

const { query } = require('../dist/config/db');
const {
  materialsForVector,
  parseVectorText,
} = require('../dist/services/education/newsMaterials');

const NEWS_LIMIT = 200;
const BOUNDARY_LESSON = [0.2, 0.35];
const BOUNDARY_COURSE = [0.55, 0.65];

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

async function main() {
  const t0 = Date.now();
  const newsRes = await query(
    `SELECT id, title_ru, published_at, embedding::text AS emb_text
     FROM news WHERE embedding IS NOT NULL
     ORDER BY published_at DESC NULLS LAST
     LIMIT $1`,
    [NEWS_LIMIT],
  );
  const news = newsRes.rows;
  console.log(`[probe_tz229] новостей с эмбеддингом в выборке: ${news.length}`);

  const lessonTop1 = [];
  const courseTop1 = [];
  const lessonPairs = []; // { sim, newsTitle, materialTitle }
  const coursePairs = [];

  for (const n of news) {
    const vec = parseVectorText(n.emb_text);
    if (!vec) continue;
    const { lessons, courses } = await materialsForVector(vec);
    if (lessons.length > 0) {
      lessonTop1.push(lessons[0].similarity);
      for (const l of lessons) {
        lessonPairs.push({ sim: l.similarity, news: n.title_ru, material: `${l.title} ← ${l.course_title}` });
      }
    }
    if (courses.length > 0) {
      courseTop1.push(courses[0].similarity);
      for (const c of courses) {
        coursePairs.push({ sim: c.similarity, news: n.title_ru, material: c.title });
      }
    }
  }

  const fmt = (v) => (v === null ? '—' : v.toFixed(4));
  const dist = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return `n=${s.length} p10=${fmt(percentile(s, 10))} p50=${fmt(percentile(s, 50))} p90=${fmt(percentile(s, 90))}`;
  };

  console.log('\n=== Распределение top-1 косинусов (новости с ≥1 материалом) ===');
  console.log(`уроки:  ${dist(lessonTop1)}`);
  console.log(`курсы:  ${dist(courseTop1)}`);

  const dump = (label, pairs, boundary) => {
    const best = [...pairs].sort((a, b) => b.sim - a.sim).slice(0, 15);
    const edge = pairs
      .filter((p) => p.sim >= boundary[0] && p.sim <= boundary[1])
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 15);
    console.log(`\n=== ${label}: 15 лучших ===`);
    for (const p of best) console.log(`${p.sim.toFixed(4)}  «${p.material}»  ←  «${p.news}»`);
    console.log(`\n=== ${label}: 15 пограничных (${boundary[0]}–${boundary[1]}) ===`);
    for (const p of edge) console.log(`${p.sim.toFixed(4)}  «${p.material}»  ←  «${p.news}»`);
  };

  dump('Уроки', lessonPairs, BOUNDARY_LESSON);
  dump('Курсы', coursePairs, BOUNDARY_COURSE);

  console.log(`\n[probe_tz229] готово за ${Date.now() - t0} мс`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[probe_tz229] ошибка:', err);
  process.exit(1);
});
