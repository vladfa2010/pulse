/**
 * =============================================================================
 * PULSE — URL Normalization
 * =============================================================================
 *
 * Нормализует URL перед сохранением в БД.
 * Убирает tracking-параметры, приводит к единому формату.
 *
 * Проблемы которые решает:
 *   - UTM-параметры: ?utm_source=rss → удаляем
 *   - HTTP vs HTTPS: http:// → https://
 *   - WWW: www.example.com → example.com
 *   - Mobile: m.example.com → example.com
 *   - Trailing slash: /path/ → /path
 *   - Пустые query-параметры: ? → удаляем
 */

// Параметры которые убираем (tracking)
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'referrer', 'source', 'medium', 'campaign', 'yclid', 'gclid',
  'fbclid', 'ttclid', 'si', 'feature', 'rss', 'from',
];

/**
 * normalizeUrl — приводит URL к единому формату
 * Если URL невалидный — возвращает как есть (fallback)
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);

    // 1. Протокол → https
    u.protocol = 'https:';

    // 2. Убираем www и mobile поддомены
    u.hostname = u.hostname
      .replace(/^www\./, '')
      .replace(/^m\./, '')
      .replace(/^mobile\./, '');

    // 3. Убираем tracking-параметры
    TRACKING_PARAMS.forEach(param => u.searchParams.delete(param));

    // 4. Убираем пустой search
    if (u.search === '?') {
      u.search = '';
    }

    // 5. Убираем trailing slash (кроме корня)
    u.pathname = u.pathname.replace(/\/+$/, '') || '/';

    // 6. Убираем hash (якори не влияют на контент)
    u.hash = '';

    return u.toString();
  } catch {
    // Невалидный URL — возвращаем как есть
    return url;
  }
}
