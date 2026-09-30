/**
 * =============================================================================
 * PULSE — LMS: резолв URL → источник курса (ТЗ-101 v15, критерий 25)
 * =============================================================================
 *
 * ЕДИНСТВЕННАЯ точка логики «URL → сущность» (риск v15 «два парсера разъедутся»):
 * используется фронтом (paste в пикер) через POST /api/admin/education/resolve-source
 * и сервером в POST/PUT /courses (поле source_url).
 *
 * Правила:
 *   - host строго из доменов PULSE: BACKEND_URL / FRONTEND_URL из env +
 *     'pulse.inside-trade.ru' + 'pulse.ru' (+ поддомены вида www.<domain>).
 *   - путь (после отрезания query и fragment): /news/<slug>       → новость
 *                                                /cascades/<slug>  → каскад
 *                                                /stories/<slug>   → сюжет
 *                                                /topics/<slug>    → тема
 *   - 'news' → lookup по slug (колонка news.slug) или по UUID id; не найдена → 400.
 *   - остальные типы → 409 «раздел появится позже» (сущностей в backend пока нет,
 *     опознание работает — активация с миграцией сущности, ТЗ-100 v12).
 *   - чужой домен или неизвестный путь → 400 «не ссылка на материал PULSE».
 */

import { query } from '../../config/db';

export interface ResolvedSource {
  source_type: 'news' | 'cascade' | 'storyline' | 'topic';
  id: string;
  title: string;
}

export class ResolveSourceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const BAD_URL = 'не ссылка на материал PULSE';
const NOT_YET = 'раздел появится позже';

/** Домены PULSE: env (BACKEND_URL/FRONTEND_URL) + фиксированные прод-домены. */
function pulseDomains(): string[] {
  const domains = ['pulse.inside-trade.ru', 'pulse.ru'];
  for (const envVar of ['BACKEND_URL', 'FRONTEND_URL']) {
    const raw = process.env[envVar];
    if (!raw) continue;
    try {
      domains.push(new URL(raw).hostname.toLowerCase());
    } catch {
      // непарсабельный env — игнорируем, фиксированные домены всё равно работают
    }
  }
  return domains;
}

function isPulseHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return pulseDomains().some((d) => host === d || host.endsWith('.' + d));
}

const PATH_RE = /^\/(news|cascades|stories|topics)\/([^/?#]+)\/?$/;

/**
 * Резолвить URL материала PULSE в источник курса.
 * Бросает ResolveSourceError (status 400/409) — вызывающий код мапит на ответ.
 */
export async function resolveSourceUrl(rawUrl: string): Promise<ResolvedSource> {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new ResolveSourceError(400, BAD_URL);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new ResolveSourceError(400, BAD_URL);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ResolveSourceError(400, BAD_URL);
  }
  if (!isPulseHost(parsed.hostname)) {
    throw new ResolveSourceError(400, BAD_URL);
  }

  // query/utm отрезаем; fragment не входит в URL.pathname, но на всякий случай
  // берём путь до '?' и '#' (paste из браузера может принести всё сразу).
  const pathOnly = parsed.pathname;

  const m = PATH_RE.exec(pathOnly);
  if (!m) {
    throw new ResolveSourceError(400, BAD_URL);
  }

  const sourceType = m[1] as 'news' | 'cascade' | 'storyline' | 'topic';
  const slugOrId = decodeURIComponent(m[2]);

  if (sourceType !== 'news') {
    // Опознали тип, но backend-сущности пока нет (ТЗ-101 v13, риск «фронт
    // опережает backend»): контракт заложен, включение — отдельной миграцией.
    throw new ResolveSourceError(409, NOT_YET);
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const result = uuidRegex.test(slugOrId)
    ? await query(`SELECT id, title_ru FROM news WHERE id = $1`, [slugOrId])
    : await query(`SELECT id, title_ru FROM news WHERE slug = $1`, [slugOrId]);

  if (result.rows.length === 0) {
    throw new ResolveSourceError(400, 'новость не найдена');
  }

  return {
    source_type: 'news',
    id: result.rows[0].id,
    title: result.rows[0].title_ru,
  };
}

export default { resolveSourceUrl, ResolveSourceError };
