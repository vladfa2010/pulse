/**
 * =============================================================================
 * PULSE — ТЗ-164: Rutube в видео-уроках — белый список + нормализация в embed
 * =============================================================================
 *
 * Чистый юнит-прогон: без HTTP и БД.
 *
 * Проверяет:
 *   1. rutube.ru в белом списке: embed-форма и страница /video/<id>/ проходят.
 *   2. normalizeEmbedUrl: страница → https://rutube.ru/play/embed/<id>;
 *      уже-embed не меняется; www-хост нормализуется; не-видео пути — как есть.
 *   3. http:// не проходит (whitelist требует https, нормализация не апгрейдит).
 *   4. Регрессия: youtube/vkvideo/vimeo — как раньше; ok.ru — отклоняется.
 *
 * Запуск:  npx ts-node src/tests/embedUrl.test.ts
 */

import { isAllowedEmbedUrl, normalizeEmbedUrl } from '../services/education/embedUrl';

let passed = 0;
let failed = 0;
const ok = (name: string) => { passed++; console.log(`  PASS  ${name}`); };
const bad = (name: string, detail?: any) => { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); };

function check(name: string, cond: boolean, detail?: any) {
  if (cond) ok(name); else bad(name, detail);
}

const RUTUBE_PAGE = 'https://rutube.ru/video/cae960e8244d38e0381311b644223c15/';
const RUTUBE_EMBED = 'https://rutube.ru/play/embed/cae960e8244d38e0381311b644223c15';

// ─── 1. Белый список ────────────────────────────────────────────────────────
check('rutube embed-URL проходит whitelist', isAllowedEmbedUrl(RUTUBE_EMBED));
check('rutube страница /video/ проходит whitelist', isAllowedEmbedUrl(RUTUBE_PAGE));
check('www.rutube.ru проходит whitelist', isAllowedEmbedUrl('https://www.rutube.ru/play/embed/cae960e8244d38e0381311b644223c15'));

// ─── 2. Нормализация ────────────────────────────────────────────────────────
check(
  'страница → embed-форма',
  normalizeEmbedUrl(RUTUBE_PAGE) === RUTUBE_EMBED,
  normalizeEmbedUrl(RUTUBE_PAGE)
);
check(
  'www-страница → embed-форма',
  normalizeEmbedUrl('https://www.rutube.ru/video/cae960e8244d38e0381311b644223c15/') === RUTUBE_EMBED,
  normalizeEmbedUrl('https://www.rutube.ru/video/cae960e8244d38e0381311b644223c15/')
);
check('уже-embed не меняется', normalizeEmbedUrl(RUTUBE_EMBED) === RUTUBE_EMBED);
check(
  'не-видео путь rutube — как есть',
  normalizeEmbedUrl('https://rutube.ru/feeds/') === 'https://rutube.ru/feeds/',
  normalizeEmbedUrl('https://rutube.ru/feeds/')
);
check(
  'youtube-URL не тронут',
  normalizeEmbedUrl('https://www.youtube.com/watch?v=abc') === 'https://www.youtube.com/watch?v=abc'
);

// ─── 3. http отклоняется ────────────────────────────────────────────────────
check('http://rutube страница не нормализуется', normalizeEmbedUrl('http://rutube.ru/video/cae960e8244d38e0381311b644223c15/') === 'http://rutube.ru/video/cae960e8244d38e0381311b644223c15/');
check('http://rutube отклонён whitelist', !isAllowedEmbedUrl('http://rutube.ru/video/cae960e8244d38e0381311b644223c15/'));

// ─── 4. Регрессия ───────────────────────────────────────────────────────────
check('youtube embed — ок', isAllowedEmbedUrl('https://www.youtube.com/embed/abc'));
check('vkvideo — ок', isAllowedEmbedUrl('https://vkvideo.ru/video_ext.php?oid=1&id=2'));
check('vimeo player — ок', isAllowedEmbedUrl('https://player.vimeo.com/video/123'));
check('ok.ru — отклонён', !isAllowedEmbedUrl('https://ok.ru/video/123'));
check('пустая строка — отклонена', !isAllowedEmbedUrl(''));
check('мусор — отклонён', !isAllowedEmbedUrl('not a url'));

// ─── Итог ───────────────────────────────────────────────────────────────────
console.log(`\nembedUrl ТЗ-164: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
