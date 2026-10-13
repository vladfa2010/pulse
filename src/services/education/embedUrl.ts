// Валидация embed-URL по белому списку доменов (критерий 5 ТЗ-101).
// Вынесено из routes/adminEducation.ts в services (ТЗ-159): парсер md-импорта
// services/education/mdCourseImport.ts импортирует отсюда — services → routes
// импорта не делаем (как sanitizeLessonHtml, contentHtml.ts).

const EMBED_DOMAINS = [
  'youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
  'vkvideo.ru',
  'player.vimeo.com',
  'rutube.ru', // ТЗ-164: страница /video/<id>/ и embed /play/embed/<id>
];

/** Проверить embed-URL по белому списку (host === domain || *.domain). */
export function isAllowedEmbedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return EMBED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

/** ТЗ-164: нормализация страницы Rutube в embed-форму. Остальные URL — как есть.
 *  Только https: http-ссылки не апгрейдим — whitelist требует https
 *  (иначе «http://rutube.ru/…» молча прошла бы после нормализации). */
export function normalizeEmbedUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return raw;
    const host = u.hostname.toLowerCase();
    if (host === 'rutube.ru' || host === 'www.rutube.ru') {
      const m = u.pathname.match(/^\/video\/([0-9a-f]{32})\/?/i);
      if (m) return `https://rutube.ru/play/embed/${m[1]}`;
    }
  } catch { /* не URL — вернём как есть, валидация ответит */ }
  return raw;
}
