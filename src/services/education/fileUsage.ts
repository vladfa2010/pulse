/**
 * =============================================================================
 * PULSE — ТЗ-199: сканер привязок файлов хранилища (usage scan)
 * =============================================================================
 *
 * Точки привязки файлов /media/<kind>/<name> (см. ТЗ-199 §2):
 *   courses.cover_url            → обложка курса (course_cover);
 *   course_paths.cover_url       → обложка программы (path_cover);
 *   course_materials.url         → материал курса/урока (material), включая
 *                                  UGC-заявки (origin='user' + статус заявки);
 *   course_lessons.text_content  → картинка в конспекте урока (lesson_content).
 *
 * Функция чистая: принимает queryFn — тесты гоняют её на сидированном SQLite
 * (паттерн weeklyReportChart.test.ts), роуты передают query из config/db.
 * 4 запроса на вызов (точное совпадение ×3 + LIKE по text_content); объёмы
 * малы, индексов не требуется. TODO(ТЗ-199 §6): при росте course_lessons до
 * тысяч — индекс/отдельная таблица ссылок вместо LIKE-скана.
 */

export type FileUsageType = 'course_cover' | 'path_cover' | 'lesson_content' | 'material';

export interface FileUsage {
  type: FileUsageType;
  id: string;
  title: string;
  course_id: string | null;    // куда ведёт клик по бейджу (курс в админке)
  course_title: string | null;
  origin: string | null;       // material: 'editorial' | 'user' (UGC-заявка)
  status: string | null;       // material: статус UGC-заявки (pending/approved/rejected)
  course_deleted: boolean;     // курс-владелец в корзине — привязка «битая»
}

type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

const USE_SQLITE = process.env.USE_SQLITE === 'true';

/** IN-плейсхолдеры под оба диалекта: PG — ANY($1), SQLite — IN ($1,$2,…). */
function inClause(paths: string[], params: any[]): string {
  if (USE_SQLITE) {
    const ph = paths.map((_, i) => {
      params.push(paths[i]);
      return `$${params.length}`;
    });
    return `IN (${ph.join(',')})`;
  }
  params.push(paths);
  return `= ANY($${params.length})`;
}

export async function scanFileUsages(queryFn: QueryFn, paths: string[]): Promise<Map<string, FileUsage[]>> {
  const map = new Map<string, FileUsage[]>();
  const add = (path: string | null | undefined, usage: FileUsage) => {
    if (!path) return;
    const list = map.get(path) || [];
    list.push(usage);
    map.set(path, list);
  };
  if (paths.length === 0) return map;

  // 1+2. Обложки курсов и программ — живые (deleted_at IS NULL) владельцы;
  // архивные учитываются (обложка у архива по-прежнему отображается).
  {
    const params: any[] = [];
    const r = await queryFn(
      `SELECT id, title, cover_url FROM courses
       WHERE deleted_at IS NULL AND cover_url ${inClause(paths, params)}`,
      params,
    );
    for (const row of r.rows) {
      add(row.cover_url, {
        type: 'course_cover', id: row.id, title: row.title,
        course_id: row.id, course_title: row.title,
        origin: null, status: null, course_deleted: false,
      });
    }
  }
  {
    const params: any[] = [];
    const r = await queryFn(
      `SELECT id, title, cover_url FROM course_paths
       WHERE deleted_at IS NULL AND cover_url ${inClause(paths, params)}`,
      params,
    );
    for (const row of r.rows) {
      add(row.cover_url, {
        type: 'path_cover', id: row.id, title: row.title,
        course_id: null, course_title: null, // программа — не курс, бейдж некликабелен
        origin: null, status: null, course_deleted: false,
      });
    }
  }

  // 3. Материалы (kind='file'): включая UGC-заявки с их статусом; курс-владелец
  // может быть в корзине — привязку отдаём, помечаем course_deleted.
  {
    const params: any[] = [];
    const r = await queryFn(
      `SELECT m.id, m.title, m.url, m.origin, m.status,
              m.course_id, c.title AS course_title, c.deleted_at AS course_deleted_at
       FROM course_materials m
       LEFT JOIN courses c ON c.id = m.course_id
       WHERE m.kind = 'file' AND m.url ${inClause(paths, params)}`,
      params,
    );
    for (const row of r.rows) {
      add(row.url, {
        type: 'material', id: row.id, title: row.title,
        course_id: row.course_id, course_title: row.course_title,
        origin: row.origin, status: row.status,
        course_deleted: !!row.course_deleted_at,
      });
    }
  }

  // 4. Картинки в конспектах уроков: text_content LIKE '%<path>%' (пути вида
  // /media/content/<uuid>.<ext> содержат только [a-z0-9./-] — wildcard-escape
  // не нужен; TODO(ТЗ-199 §6) — пересмотреть при росте таблицы уроков.
  for (const p of paths) {
    const r = await queryFn(
      `SELECT l.id, l.title, l.course_id, c.title AS course_title
       FROM course_lessons l
       LEFT JOIN courses c ON c.id = l.course_id
       WHERE l.text_content LIKE '%' || $1 || '%'`,
      [p],
    );
    for (const row of r.rows) {
      add(p, {
        type: 'lesson_content', id: row.id, title: row.title,
        course_id: row.course_id, course_title: row.course_title,
        origin: null, status: null, course_deleted: false,
      });
    }
  }

  return map;
}
