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
