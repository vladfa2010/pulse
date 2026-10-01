# LMS «Образование» — документация модуля

Образовательная платформа PULSE. ТЗ пакета: `ТЗ-100` (витрина/прохождение/оплата),
`ТЗ-101` (админка), `ТЗ-102` (UGC + модерация), `ТЗ-103` (мэтчинг с новостями),
`ТЗ-104` (симуляторы), `ТЗ-105` (программы), `ТЗ-107` (граф знаний).
Порядок внедрения — по README пакета; этот документ ведётся по мере реализации.

## Статус

- ✅ **Шаг 1** (ТЗ-100 Задача 1 + 1а): схема БД (11 таблиц) + storage-драйвер.
- ✅ **Шаг 2** (ТЗ-101 целиком + ТЗ-100 Задача 2 минимум): admin-API курсов,
  таб «Образование» в админке (пиксельный перенос мокапа admin.html),
  публичный контур витрины. Коммиты: бэкенд `25fe75c`, фронтенд `30bd9be`.
- ✅ **ТЗ-102** (UGC + модерация + ClamAV, backend + frontend): миграция
  `lms_v2_ugc.sql` (`/migrate-lms-ugc`), публичный API предложений
  (`POST .../courses/:slug/materials`, `GET /my/submissions`), очередь
  модерации (`GET|POST /api/admin/education/moderation[/:kind/:id/approve|
  reject]`), антивирусный контур `services/education/virusScan.ts` (clamd по
  unix-сокету, INSTREAM на stdlib net/fs; quarantine/ → ugc/ атомарный rename;
  423 для нечистых; sweeper раз в минуту + retry при заходе модератора; флаг
  av_unavailable вычисляемый). Smoke: `scripts/smoke-lms-ugc.js` (14 проверок;
  с живым CLAMAV_SOCKET +EICAR и clean-контур = 16).
- ✅ **ТЗ-103** (мэтчинг курсов с новостями и календарём, backend): миграция
  `lms_v3_matching.sql` (`/migrate-lms-matching`), `services/education/match.ts`
  (эмбеддинги курсов + RECALL теги/косинус + RANK LLM-батч с суточным лимитом +
  ретроскан ≤200 новостей/14 дней при publish + cron-страховка `matchUnprocessedNews`
  ежечасно + асинхронный хук в newsProcessor), `services/education/calendarMatch.ts`
  (правила по тегам, без LLM; in-memory кэш `education:calmatch:today:*` TTL 1 ч,
  инвалидация вместе с витриной). Принцип: система только РЕКОМЕНДУЕТ
  (`course_match_suggestions`: attach/dismiss решением редактора, ON CONFLICT
  DO NOTHING). Всё под флагом `EDUCATION_MATCH_ENABLED` (default 'false'):
  выключен — эндпоинты 404, хук/ретроскан/cron no-op. Smoke:
  `scripts/smoke-lms-match.js` (оба прогона). Бэкфилл:
  `scripts/backfill-course-embeddings.js` (критерий приёмки №3).
- ⏭ Дальше: ТЗ-100 Задачи 4–6 (прохождение/«Мои курсы» в ЛК, оплата курсов
  ЮKassa, шеринг пути), затем ТЗ-105, ТЗ-104 по команде, ТЗ-107 последним.

## Шаг 2 — что реализовано

**Admin API** (`src/routes/adminEducation.ts`, все роуты за `adminMiddleware`,
монтирован на `/api/admin/education`): CRUD курсов (draft/published/archived,
soft-delete с 409 при покупках, restore), уроки (создание/редактирование/
удаление с пересчётом position, reorder), тесты (1..20 вопросов, 2..6 вариантов),
материалы (файл через multipart+magic bytes / ссылка / новость, is_free),
обложки (multer memory → file-type jpg/png/webp → sharp EXIF-strip ≤50 Мпикс),
теги из единой базы (`GET /tags?q=` автодополнение, `PUT /tags` полная замена),
категории (CRUD + reorder, удаление запрещено при живых курсах — 409),
тарифы курса (`tariff_ids` полная замена), привязки к новостям (≤10),
`POST /resolve-source` (строго домен PULSE: /news → 200, /cascades|/stories|
/topics → 409 «раздел появится позже», чужое → 400), публикация с проверками
422, управление слушателями (admin_grant идемпотентно, is_blocked → 422,
отписка 204 без удаления прогресса), users-search/news-search.
Санитизация `text_content` на записи (sanitize-html: whitelist тегов,
https-only ссылки, img только /media/*, SVG/script вырезаются). Каждая мутация
инвалидирует кэш витрины (`services/education/cache.ts`, in-memory, TTL 5 мин).

**Публичный контур** (`src/routes/education.ts`, `/api/education`): витрина
(полки hot/recommended/fresh + каталог, фильтры all/free/paid/hot/mine, topic,
category с анти-энумерацией hidden), категории, карточка курса (публичная
титульная, draft по `?preview_token=` админа, hidden → 404 чужим), урок
(enrollment или is_free_preview; тест без correct; subscription_expired /
locked_by_drip по tenure; 401/403 + `IDOR blocked` в логе), complete,
«Мои курсы», материалы-download (302 на signedUrl; is_free анониму с
лимитом 30/час по IP), «Курс в новостях». `GET /api/news/:slug` отдаёт
`attached_courses` (≤3, published+public).

**Фронтенд** (таб «Образование» в `/admin`): таблица курсов (обложки, ярлыки
размера/типа, чип категории, фильтр «Потеряли источник», удалённые),
модал создания, модал «Категории», редактор с 5 вкладками (Основное с
тег-пикером, источником, тарифами, дрипом и видимостью; Уроки с пресетом
дрипа и тест-редактором; Материалы; Новости; Записавшиеся). Пиксельный
перенос мокапа `admin.html`. Компоненты: `src/pages/admin/EducationTab.tsx`
+ `src/components/admin/education/*`.

**Известные TODO:** `subscriptionTenureDays` — fallback на `created_at`
юзера (источник: `services/education/subscriptionTenure.ts`); «Мои курсы»
в личном кабинете и покупка курсов — следующий этап; SQLite-адаптер
исправлен для `ON CONFLICT DO NOTHING` (dev-режим).

## Проверки шага 2

- `node scripts/smoke-lms-step2.js` — 28 групп проверок × 2 прогона на
  чистых БД (CRUD, валидации, publish, санитизация, cover 415/413, тарифы,
  категории, resolve-source, enrollments, публичный API, drip, hidden,
  preview_token) — зелёно. Фронтенд: tsc чисто, тесты 193/193, build ок.
- Прод: бэкенд `25fe75c`, фронтенд `30bd9be`, `GET /api/education/courses`
  отвечает (пустой каталог до появления контента).

## Схема БД

PG-миграция: `src/migrations/lms_v1.sql`, применяется идемпотентно через
`POST /migrate-lms?secret=CRON_SECRET_KEY` (в SQLite-режиме → `{skipped:true}`,
там таблицы создаёт `initSQLiteSchema()` в `src/config/db-sqlite.ts`, блок
добавлен в конец шаблона, существующие таблицы не тронуты).

Ключевые решения (из ТЗ, не обсуждаются):
- `courses.price` — рубли, INTEGER (копеек в ценах курсов не будет).
- `courses.type` ('course'|'situational') ≠ `courses.size` ('micro'|'standard'|'full') —
  НЕ путать: situational — про привязку к инфоповоду, size — про объём.
- `badges` — JSONB, ручные метки `new/popular/recommended`, максимум 2
  (CHECK в PG; SQLite CHECK на JSON не работает — валидировать на бэке/фронте).
- Существующие таблицы (`news`, `users`, `payments`, `subscription_plans`)
  НЕ изменяются — только FK-ссылки на них. ALTER существующих таблиц запрещён.
- `source_type` situational: 'news' активен; 'cascade'|'storyline'|'topic' —
  enum заложен, сущностей в backend пока нет (отдельные миграции позже).
- `visibility='hidden'`: курс published, но вне всех публичных выдач;
  доступ только по enrollment от админа (`admin_grant`). Анти-энумерация:
  для чужих такой курс — 404, не 403.
- Дрип-контент: `subscription_unlock_mode` ('full'|'drip') +
  `unlock_after_days` (день АКТИВНОЙ подписки, 0 = сразу). Действует ТОЛЬКО
  на enrollment `source='subscription'`; tenure — накопленные дни членства
  (паузы «замораживают», не сбрасывают).

## Storage-драйвер (`src/services/storage/driver.ts`)

Интерфейс: `putBuffer`/`putFile` → `{relPath, url, size}`, `removeFile`,
`signedUrl`, `verifySignedUrl`, `assertDiskSpace`, `bootstrapStorage`,
`purgeExpiredTrash`. S3 — интерфейс-заглушка (`throw 501`), переезд на
объектное хранилище без миграции данных (в БД только относительные пути).

**Конвенция путей:** в БД — ТОЛЬКО `/media/<kind>/<uuid>.<ext>`. Имя файла на
диске генерируется драйвером (`uuid + расширение`), оригинальное имя в путь
не попадает (защита от traversal/кодировок; человекочитаемое имя — в БД).

Каталоги в `UPLOADS_DIR` (bootstrap при старте):
`courses/` (обложки), `materials/`, `ugc/`, `tmp/`, `tmp/trash/`, `quarantine/`.

Гарантии (аудит LMS 2026-09-21, блоки Sx):
- **S11 атомарная запись:** tmp → fsync → rename; при ошибке после rename —
  компенсирующее удаление. INSERT в БД — вызывающим кодом ПОСЛЕ успешного put.
  Сироты в `tmp/` старше суток зачищаются при старте (критерий 18(7)).
- **S7 soft-delete:** `removeFile` переносит файл в `tmp/trash/`; retention
  30 дней (env `STORAGE_TRASH_RETENTION_DAYS`); физическое удаление —
  `purgeExpiredTrash()` (boot + раз в сутки). Подписанный URL на удалённый
  файл → 404.
- **S6 квоты:** перед записью `statfs`, свободно < 10 % → 507
  (env `STORAGE_MIN_FREE_PCT`, переопределение — для dev-станций).
  Лимит загрузок: `lmsUploadLimiter` в `src/middleware/rateLimit.ts` —
  20 файлов/час на пользователя (429 на 21-й, критерий 18(2)).
- **SIGNED_URL_SECRET — обязателен, fail-fast** при пустом (как ENCRYPTION_KEY).

### Отдача файлов (`src/services/storage/media.ts`)

Монтировано в `index.ts`: `app.use('/media', mediaGuard)` — **ДО** `apiLimiter`
(статика не ест общий лимит API). Правила:
- `/media/courses/**` — обложки, публичные, `Cache-Control: public, max-age=3600`.
- `/media/materials/**`, `/media/ugc/**` — ТОЛЬКО по signed URL
  (`?expires=<unix>&sig=<hmac sha256>`), `Cache-Control: private, max-age=0`.
- `/media/tmp/**`, `/media/quarantine/**` — никогда не отдаются.
- Всегда `X-Content-Type-Options: nosniff`; HTML/SVG — только как attachment
  (same-origin XSS-вектор закрыт заголовками, S8/S10).
- Любой отказ → 404 (существование/причина не раскрываются).

Платные материалы отдаются только через download-эндпоинт
(`GET /api/education/materials/:id/download` → 302 на signedUrl, TTL 1 час) —
эндпоинт приходит с публичным API (Задача 2 ТЗ-100). `is_free=true` — тот же
эндпоинт без auth/enrollment, с rate limit по IP.

## Доступ к контенту (`src/services/education/access.ts`)

`assertCourseAccess(userId, courseId)` — **ЕДИНСТВЕННАЯ** точка проверки
доступа (S5). Любой новый обработчик контента вне неё = регрессия
безопасности (чеклист код-ревью).

Уровни: `'guest'` (аноним/без прав) → 401/403 на усмотрение роута;
`'free'` (курс published, бесплатный, не записан); `'enrolled'`;
`'admin'`. Проверки живости подписки (`source='subscription'`) и дрип-по-tenure
наращиваются поверх в задачах 2/4/5 — контракт уровней не меняется.

Отклонённый доступ логируется `logIdorBlocked(userId, resource, resourceId)`
→ строка `IDOR blocked {...}` в логе (основа алертинга на перебор).

## Env (прод, VDS)

| Переменная | Значение | Где |
|---|---|---|
| `STORAGE_DRIVER` | `local` (default) | compose |
| `UPLOADS_DIR` | `/app/uploads` (default) | compose |
| `SIGNED_URL_SECRET` | hex 32 байта (`openssl rand -hex 32`) | /opt/pulse/.env |
| `SIGNED_URL_TTL_SEC` | `3600` (default) | compose |
| `STORAGE_MIN_FREE_PCT` | `10` (default) | при необходимости |

Volume: `/opt/pulse/uploads:/app/uploads` (bind-mount — переживает redeploy,
бэкапится одним `tar`). Бэкап-cron (tar uploads + pg_dump, ротация 14 дней,
внешняя копия) — обязателен с первого дня эксплуатации (ТЗ-100 v11).

**Инцидент 2026-10-01 (зафиксировано, чтобы не повторить):** секреты VDS живут
в `/opt/pulse/.env` (ВНЕ project dir). Compose их видит двумя способами, оба
закоммичены в `docker-compose.yml`: `env_file: /opt/pulse/.env` (проброс в
контейнер) и **symlink** `/opt/pulse/pulse/.env → /opt/pulse/.env` (compose
читает `.env` из project dir для интерполяции `${VAR}` в блоке `environment`;
без symlink явные ключи получали дефолты вроде `change-me-in-production` и
перекрывали env_file). Раньше серверный compose был пропатчен вручную и не
был в git — `git pull` перезаписал его, контейнер потерял `ENCRYPTION_KEY`,
`SIGNED_URL_SECRET` и пр. Правило: **правки compose на сервере → сразу коммит
в git**. Дубль ключа `environment` в одном mapping-е compose отклоняет
(«mapping key already defined») — ключи объединять, а не добавлять второй блок.
Прод-миграции LMS (`/migrate-lms`, `/migrate-lms-ugc`, `/migrate-lms-matching`,
POST + `?secret=CRON_SECRET_KEY`) применяются вручную после первого деплоя
схемы — автоматически не накатываются.

## Проверки

- `npx tsc --noEmit` — чисто.
- `node scripts/smoke-lms-step1.js` (после `npx tsc`) — 9 проверок: таблицы,
  идемпотентность, bootstrap, put, подпись (подделка/expired/чужой путь),
  soft-delete, purge, traversal, уровни доступа.
- `node scripts/smoke-lms-media.js` — HTTP 6/6: публичная обложка, signed
  gating, подделка/expired → 404, traversal, attachment для SVG.

## Дорожная карта (следующие шаги)

1. ~~Задача 1 + 1а: схема БД + storage-драйвер~~ ✅
2. ~~ТЗ-101: админка курсов/уроков/категорий + публичный контур~~ ✅
3. ТЗ-100 Задачи 4–6: «Мои курсы» в ЛК/прохождение (фронт), покупка курсов
   через контур ЮKassa (`activatePaymentIfNeeded`, `product_type='course'`),
   шеринг пути (`user_path_shares`).

## ТЗ-102 — UGC + модерация + ClamAV (реализовано)

**Миграция** `src/migrations/lms_v2_ugc.sql` (PG, `POST /migrate-lms-ugc?
secret=CRON_SECRET_KEY`, идемпотентна; SQLite → `{skipped:true}` — колонки
добавляет `initSQLiteSchema()`, ALTER строго по одной колонке). Добавлено
`created_at` в `course_materials` сверх буквы ТЗ: на нём завязан индекс
`idx_materials_moderation` из самого ТЗ и FIFO-сортировка очереди.

**Контрактные точки:**
- `course_materials`: `origin` ('editorial'|'user'), `status` ('pending'|
  'approved'|'rejected'), `submitted_by/reviewed_by/reviewed_at`,
  `reject_reason`, `scan_status` ('pending_scan'|'clean'|'infected'). Дефолты
  `editorial/approved/clean` — обратная совместимость ТЗ-100 из коробки;
  все публичные выборки материалов фильтруют `status='approved'`.
- `news_course_suggestions` — очередь новостей от учеников; аппрув пишет в
  редакционную `news_course_links` (структура ТЗ-100 не тронута).
- UGC-файлы живут в `quarantine/` (pending_scan) → `ugc/` (clean, атомарный
  rename через `driver.moveToKind`); `/media/quarantine/**` не отдаётся никогда,
  `/media/ugc/**` — всегда `Content-Disposition: attachment` (media.ts).
- Скачивание файла с `scan_status != 'clean'` → **423 Locked для всех**,
  включая модератора (проверка до контроля доступа). UGC не прошедший
  модерацию (даже clean) → 403.
- Деградация clamd: файл остаётся `pending_scan`, юзеру 201 «на проверке»;
  retry — комбинированный (зафиксировано в шапке virusScan.ts): enqueue при
  загрузке + sweeper раз в минуту + enqueue при заходе модератора в очередь.
  Флаг `av_unavailable` в `GET /moderation` — вычисляемый: pending_scan старше
  `CLAMAV_STALE_MS` (10 мин default).
- Лимиты: `lmsSubmissionLimiter` — 5 предложений/сутки на юзера (429 на 6-м);
  файлы: whitelist `pdf,xlsx,docx,png,jpg,webp`, ≤10 МБ (400), magic bytes
  через `file-type` (несоответствие расширению → 415; неопределённый тип
  пропускается в карантин — досматривает ClamAV, так EICAR доезжает до скана).

**Env:** `CLAMAV_SOCKET` (default `/run/clamav/clamd.sock`), `CLAMAV_TIMEOUT_MS`
(10000), `CLAMAV_SWEEP_INTERVAL_MS` (60000), `CLAMAV_STALE_MS` (600000).

**Docker:** сервис `clamav` в `docker-compose.yml` с профилем `av` (не стартует
с обычным `up -d`: ~1 ГБ RAM на базы; `docker compose --profile av up -d clamav`),
named volume `clamav_run` — сокет в backend (ro). Backend без clamd штатно
деградирует (см. выше), поэтому `depends_on` не добавлен.

## ТЗ-103 — мэтчинг курсов с новостями и календарём (реализовано)

**Миграция** `src/migrations/lms_v3_matching.sql` (PG, `POST /migrate-lms-matching?
secret=CRON_SECRET_KEY`, идемпотентна; SQLite → `{skipped:true}`). HNSW-индекс
НЕ создан намеренно: курсов десятики, seq scan по `vector(1024)` — микросекунды.

**Новостной мэтчинг** (`services/education/match.ts`):
- `computeCourseEmbedding` — TEI, текст = title+description+названия уроков
  (обрезка `EMBEDDING_MAX_TEXT`), триггеры: publish всегда; PUT курса при смене
  title/description; CRUD уроков при смене названий. Асинхронно, ошибки не
  валят запрос.
- RECALL: кандидаты по тегам (`course_tags` ∩ `news.matched_tags`) + top-10 по
  косинусу эмбеддинга (PG `<=>`; SQLite — косинус в JS). RANK: LLM-батч
  (по 8 пар) по паттерну `clusterVerifier`: JSON-вердикты `{score, reason}`,
  fail-closed, общий суточный лимит. Пишутся пары `score>=0.5` ИЛИ тег-матч;
  `ON CONFLICT (course_id, news_id) DO NOTHING` — решение редактора
  (attached/dismissed) не перетирается повторным мэтчингом.
- Пайплайн: ретроскан при publish (14 дней, ≤200 новостей) → инкрементальный
  хук в `newsProcessor` (async, ошибки глотаем с логом) → cron-страховка
  `matchUnprocessedNews()` ежечасно (новости за 2 ч без строк в suggestions).
- Админ-API: `GET /courses/:id/suggestions?status=…`,
  `POST /suggestions/:id/attach` (транзакция: `news_course_links` +
  status=attached + инвалидация кэша), `POST /suggestions/:id/dismiss`
  (attached через dismiss не открепляется; dismiss→attach = 409).

**Календарный мэтчинг** (`services/education/calendarMatch.ts`): только
пересечение тегов, без LLM/эмбеддингов (YAGNI, теги событий чистые). Таблиц
связей НЕТ — события эфемерны (конвейер пересобирает `calendar_events`),
адресация натуральным ключом `(date,title,kind,ticker)`. ≤3 курса на событие,
прошедшие события нигде не показываем. In-memory кэш `education:calmatch:today:
<YYYY-MM-DD>` TTL 1 ч (паттерн `heatmapDaily`), инвалидация вместе с витриной.
Публичные эндпоинты (без auth, за `lmsCalendarMatchLimiter`):
`GET /calendar-today` (сегодня/завтра по МСК), `GET /for-event`,
`GET /courses/:slug/events?days=14`. Админский `GET /courses/:id/events-preview`
(включая черновики; курс без тегов → `{events:[], warning:'no_tags'}`).
**Контракт:** `ticker` в `/for-event` опционален — сгруппированные события с
несколькими компаниями матчатся по `date+title+kind` (первая строка).

**Фичефлаг:** `EDUCATION_MATCH_ENABLED` (default `'false'`): выключен —
все эндпоинты мэтчинга 404, хук/ретроскан/cron no-op, фронт прячет блоки.

**Env:** `EDUCATION_MATCH_ENABLED`, `EDUCATION_MATCH_LLM_DAILY_LIMIT` (500).

**Бэкфилл:** `scripts/backfill-course-embeddings.js` — эмбеддинги
существующих курсов (критерий приёмки №3; запуск после миграции, до включения
флага на проде).

**Фронтенд** (коммит в pulse-frontend отдельно): секция «Рекомендованные (N)»
в редакторе курса (`SuggestionsPanel`), «События календаря» в админке
(`EventsPreviewPanel`), публичные `CoursePage` / витрина `Education` /
`CalendarTodayBlock` / `MatchedCourseChips` / «Мои предложения» в профиле
(`SubmissionsTab`). Контракт автора UGC-материала: `submitted_by: {id, username}`.

## Страница урока + грейдинг теста (реализовано)

**Проблема:** программа курса на `CoursePage` рендерилась строками без ссылок —
попасть в урок было невозможно. Добавлена страница урока и серверный грейдинг.

**Бэк** (`src/routes/education.ts`):
- `POST /api/education/lessons/:lessonId/test` — грейдинг ответов. GET вырезает
  `correct` (критерий 4), клиент шлёт `{answers: [индексы]}` (по одному на
  вопрос, иначе 400), бэк сверяет с `lesson_tests.questions` и возвращает
  `{test_score, pass_score, passed}`. Прогресс НЕ пишется — это делает
  `POST /complete` (там же валидация `test_score >= pass_score` → 422).
  Доступ: запись обязательна (403), для source='subscription' — живость
  подписки и drip-проверка.
- GET `/lessons/:id` без изменений (весь контент, тест без correct, prev/next).

**Фронт** (pulse-frontend):
- `pages/LessonPage.tsx`, маршрут `/education/lesson/:id` (статический сегмент
  `lesson` ранжируется выше `/education/:slug`). Состояния: loading / 404 /
  401 (кнопка «Войти» через auth-modal) / 403 (subscription_expired,
  locked_by_drip с «откроется через N дн.», test_blocked). Контент: видео
  (embed-iframe, youtube watch→embed конвертация на клиенте), текст как HTML
  (санитизирует бэк `sanitizeLessonHtml`), тест (радио-варианты → грейдинг →
  при проходе автоматический `complete`), кнопка «Отметить пройденным» для
  уроков без теста, навигация prev/next.
- `CoursePage`: строка урока — ссылка, когда `(enrolled || is_free_preview) &&
  !locked_by_drip`; иначе прежняя неактивная строка с замком/drip-плашкой.
- `lib/api.ts`: ошибки HTTP теперь несут `err.data` — тело ответа целиком
  (машиночитаемые `reason`/`unlock_in_days` из LMS и будущих эндпоинтов).
- `lib/educationApi.ts`: `fetchLesson`, `submitLessonTest`, `completeLesson`.

**Проверки:** smoke-lms-step2.js дополнен блоком грейдинга (401 анониму,
400 по длине, подсчёт 0/100), 30 проверок × 2 прогона, зелёные.

## Дорожная карта (следующие шаги)

1. ~~Задача 1 + 1а: схема БД + storage-драйвер~~ ✅
2. ~~ТЗ-101: админка курсов/уроков/категорий + публичный контур~~ ✅
3. ~~ТЗ-102 (UGC + ClamAV)~~ ✅ / ~~ТЗ-103 (мэтчинг)~~ ✅
4. Деплой ТЗ-102/103 на VDS: миграции `lms_v2_ugc` + `lms_v3_matching`,
   `docker compose --profile av up -d clamav` (проверить RAM ~1 ГБ),
   `EDUCATION_MATCH_ENABLED=true` после бэкфилла эмбеддингов.
5. ТЗ-100 Задачи 4–6: «Мои курсы» в ЛК/прохождение (фронт), покупка курсов
   через контур ЮKassa (`activatePaymentIfNeeded`, `product_type='course'`),
   шеринг пути (`user_path_shares`).
6. Затем ТЗ-105, ТЗ-104 по команде, ТЗ-107 последним.
