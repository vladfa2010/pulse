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
- ✅ **ТЗ-103** (мэтчинг курсов с новостями и календарём, backend; доработано
  ТЗ-177/172): миграция
  `lms_v3_matching.sql` (`/migrate-lms-matching`), `services/education/match.ts`
  (эмбеддинги курсов + RECALL теги/косинус + RANK LLM-батч с суточным лимитом +
  запись также по тег-матчу и косинусу ≥ `embedding_threshold` курса (ТЗ-177) +
  ретроскан ≤200 новостей/14 дней при publish и при смене порога +
  выключатель LLM-ранкера `match_llm_enabled` (ТЗ-172) +
  cron-страховка `matchUnprocessedNews`
  ежечасно + асинхронный хук в newsProcessor), `services/education/calendarMatch.ts`
  (правила по тегам, без LLM; in-memory кэш `education:calmatch:today:*` TTL 1 ч,
  инвалидация вместе с витриной). Принцип: система только РЕКОМЕНДУЕТ
  (`course_match_suggestions`: attach/dismiss решением редактора, ON CONFLICT
  DO NOTHING). Всё под флагом `EDUCATION_MATCH_ENABLED` (default 'false'):
  выключен — эндпоинты 404, хук/ретроскан/cron no-op. Smoke:
  `scripts/smoke-lms-match.js` (оба прогона). Бэкфилл:
  `scripts/backfill-course-embeddings.js` (критерий приёмки №3).
- ✅ **ТЗ-100 v8/v14** (шеринг инвестиционного пути + покупка курсов через
  ЮKassa, backend + frontend): `user_path_shares` (CRUD + публичная страница
  пути), платёжный контур курсов по `product_type='course'`
  (`activatePaymentIfNeeded`, webhook, `/status`, `/confirm`). Smoke:
  `scripts/smoke-lms-path-buy.js` (19 проверок).
- ✅ **ТЗ-157** (идемпотентное создание урока, backend + frontend): миграция
  `lms_v6_lesson_idempotency.sql` (`/migrate-lms-lesson-idempotency`, применена
  на проде 2026-10-09) — частичный уникальный индекс `course_lessons_idem_key`
  по `(course_id, idem_key)`, колонка `idem_key`, обработка дубля: POST возвращает
  `already_created` + существующий урок вместо 500. Фронт шлёт стабильный ключ
  из формы урока и показывает тост «Урок уже был добавлен (повторный запрос)».
  Тест: `src/tests/lessonIdempotency.test.ts` (11 проверок).
- ✅ **ТЗ-159 v3** (импорт курса из .md, backend + frontend): парсер
  `services/education/mdCourseImport.ts` (чистая функция): разрез по `# `,
  frontmatter `---` (is_free/video_url/duration_min/unlock_days), директивы
  `:::button` (0–3, через общий `validateLessonButtons` — вынесен в
  `services/education/lessonButtons.ts` по образцу embedUrl) и `:::test … :::`
  (1–20 вопросов, 2–6 вариантов, ровно один (x), pass 1..100 default 70,
  blocking true|false), `:::chart` → div.chart-block; контент — через тот же
  `sanitizeLessonHtml`. Текст до первого `# ` = описание курса: при импорте
  заменяет `courses.description` (пустая преамбула = не трогаем). Эндпоинт
  `POST /courses/:id/import-md` (multer 1 МБ, .md/.markdown/.txt): dry_run →
  превью (course_description/buttons_count/test) без записи; импорт идемпотентен
  по ключу `md-import:<sha256>:<i>` (ТЗ-157), у вставленных уроков с тестом сразу
  INSERT в `lesson_tests`; ответ `{created, skipped_existing, tests_created,
  description_updated, lessons, warnings}`, ре-эмбеддинг и инвалидация кэша при
  created≥1 или обновлении описания. Фронт: кнопка «Импорт из MD» во вкладке
  «Уроки» + модалка с превью (плашка «Описание курса будет заменено», бейджи
  кнопок/теста). Тесты: `src/tests/mdCourseImport.test.ts` (парсер, 78 проверок),
  `src/tests/mdCourseImportEndpoint.test.ts` (живой API, после деплоя),
  фронт `importmd.smoke.test.tsx`.
- ✅ **ТЗ-191** (экспорт курса/урока в MD, backend + frontend): конвертер
  `services/education/mdCourseExport.ts` (turndown + turndown-plugin-gfm,
  HTML→MD): преамбула-текст, `# ` заголовки, frontmatter `---`, `:::chart`,
  `:::button` (0–3), `:::test … :::` (до 20 вопросов), вставки `div.callout`/
  `div.html-block` — сырым HTML (TurndownService не обрабатывает их, оставляем
  как есть), GFM-таблицы. `#` в названиях заменяются на ＃
  (`sanitizeMdTitle`), чтобы не ломать разрез по `# `. Эндпоинт
  `GET /courses/:id/export-md` (+ `?lesson_id=`, только админ): Content-Type
  `text/markdown; charset=utf-8`, `Content-Disposition: attachment;
  filename*=UTF-8''<urlencoded>`, Cache-Control no-store; 404 удалённый/чужой
  курс, 400 чужой урок/нет уроков. Аудит: `education.course_exported`
  (метка «⚠️ Выгрузка курса в MD» в админ-алертах). Материалы в файл не
  входят. Round-trip с ТЗ-159: экспорт→импорт восстанавливает описание,
  уроки, блоки/кнопки/тест/фронтматтер (не байт-в-байт — форматирование
  списков/таблиц нормализуется валидным markdown). Фронт: кнопка «Экспорт MD»
  во вкладке «Уроки» (весь курс) + иконка скачивания у каждого урока,
  скачивание через blob (`adminApi.getBlob`). Тесты: `src/tests/
  mdCourseExport.test.ts` (35 проверок), смоук `scripts/smoke-md-export.js`
  (5 проверок, включая round-trip), фронт `lessonlist.tz191.test.tsx`.
- ⏭ Дальше: ТЗ-100 Задача 4 («Мои курсы» в ЛК), затем ТЗ-105, ТЗ-104 по
  команде, ТЗ-107 последним.

## Шаг 2 — что реализовано

**Admin API** (`src/routes/adminEducation.ts`, все роуты за `adminMiddleware`,
монтирован на `/api/admin/education`): CRUD курсов (draft/published/archived,
soft-delete с 409 при покупках, restore), уроки (создание/редактирование/
удаление с пересчётом position, reorder), тесты (1..20 вопросов, 2..6 вариантов),
материалы (файл через multipart+magic bytes / ссылка / новость, is_free),
обложки (multer memory → file-type jpg/png/webp → sharp EXIF-strip ≤50 Мпикс
→ сжатие ≤1920px WebP q82, всегда `cover.webp`, ТЗ-198;
разовый пережатие существующих: `npx ts-node --transpile-only
scripts/recompress-covers.ts [--dry-run]`),
теги из единой базы (`GET /tags?q=` автодополнение, `PUT /tags` полная замена),
категории (CRUD + reorder, удаление запрещено при живых курсах — 409),
тарифы курса (`tariff_ids` полная замена), привязки к новостям (≤10),
`POST /resolve-source` (строго домен PULSE: /news → 200, /cascades|/stories|
/topics → 409 «раздел появится позже», чужое → 400), публикация с проверками
422, управление слушателями (admin_grant идемпотентно, is_blocked → 422,
отписка 204 без удаления прогресса), users-search/news-search.
**ТЗ-199 (галерея файлов):** `GET /files?kind=&q=&page=` — листинг storage
(50/стр) + usage-привязки (обложки курсов/программ, материалы incl. UGC,
картинки конспектов по text_content LIKE) + summary (unused/bytes/trash);
`DELETE /files?path=&force=` (используется и не force → 409 `{usages}`,
иначе → trash), `GET /files/download?path=` — скачивание через админ-контур
(фронт: fetch+Blob с Bearer; materials/ugc публично не отдаются — mediaGuard
требует signed URL, поэтому прямая ссылка давала 403), `GET /files/trash`,
`POST /files/trash/restore`
(манифест `<trashName>.path` в trash с ТЗ-199; записи без манифеста —
legacy, без restore), `DELETE /files/trash?path=` (purge навсегда);
path-guard `normalizeMediaPath` (префикс /media/, без `..`, kind из набора);
аудит `education.file_deleted|file_restored|file_purged`.
**ТЗ-186 (уведомление при записи админом):** успешный ответ записи (201 и
200 already_enrolled) содержит `notify_channels {email, push, telegram}` —
доступность каналов юзера через `getDeliveryTarget` (email неявный, push
FCM→VAPID, telegram активный user_channels). Отдельный эндпоинт
`POST /courses/:id/enrollments/:userId/notify` (тело `{channels: [1..3]}`,
иначе 400; enrollment обязателен — иначе 404) шлёт «Вам предоставлен доступ
к курсу «<title>»» + кнопку «Изучить» (`/education/<slug>`) по выбранным
каналам: email — HTML-шаблон `templates/course-access-granted.html`
(дизайн-система писем ТЗ-142), Telegram — inline url-кнопка, push — FCM +
VAPID (billing-паттерн, доставка по любому транспорту). Ответ
`{sent, skipped, failed}` по каналам (канал отвалился — `skipped.
channel_not_connected`). Тихие часы и частотные лимиты диспетчера НЕ
применяются — транзакционное уведомление по явному действию админа.
Событие `education.enroll_notified {course_id, target_user_id, channels}`
(фактические отправленные каналы; в ALERT_EVENT_TYPES не входит). Логика —
`services/education/enrollNotify.ts`, смоук `scripts/smoke-enroll-notify.js`
(8 проверок). Фронт: модалка «Пользователь записан. Уведомить?» в
StudentsPanel (доступные каналы предвыбраны, недоступные disabled «не
подключён»; already_enrolled — прежний тост без модалки).
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
лимитом 30/час по IP; ТЗ-173: fallback `?token=` для скачивания по
авторизационной ссылке), «Курс в новостях». `GET /api/news/:slug` отдаёт
`attached_courses` (≤3, published+public). Разовый шеринг урока гостю —
отдельный раздел ниже («Меджик-линк», ТЗ-187).

### Разовый шеринг урока гостю — «Меджик-линк» (ТЗ-187)

Пользователь с доступом к уроку создаёт одноразовую ссылку, по которой гость
без аккаунта видит **только текст урока** (конспект). Цель — виральность:
гость читает урок, видит CTA на курс, при регистрации его визит атрибутируется
шереру. Источник истины — `ТЗ-187-меджик-линк-шеринг-урока.md` (+ Правка 1
от 2026-10-23: квота только на платные ссылки).

**Эндпоинты** (`src/routes/education.ts`, маршруты рядом с роутами урока):

| Метод и путь | Auth | Что делает |
|---|---|---|
| `POST /api/education/lessons/:lessonId/share` | Bearer | Создать ссылку. Гейты доступа те же, что у просмотра урока (см. `checkLessonAccess`): hidden-антислив 404, статус курса, enrollment/`is_free_preview` (гость → 401, чужой → 403 + `IDOR blocked` в логе), живая подписка (`subscription_expired`), drip (`locked_by_drip`), блокирующий тест предыдущего урока (`test_blocked`); админ может шерить любой урок. Квота — ниже. Ответ 201 `{url: <FRONTEND_URL>/share/lesson/<token>}`. |
| `GET /api/education/shared-lessons/:token` | нет | Публичное чтение. Токен — 48 hex; не подходит → 404. **Атомарное сгорание**: `UPDATE lesson_shares SET used_at=..., used_ip=... WHERE token=$1 AND used_at IS NULL AND expires_at > $now RETURNING ...` — при гонке двух открытий ровно один получит 200, второй упадёт в разбор причины. 200 — текст урока; 410 «Ссылка уже использована» (+`course_slug` для CTA на курс); 410 «Срок действия ссылки истёк»; 404 — токена нет или курс удалили после сгорания. |

**Квота (Правка 1):** 2 **платные** ссылки за скользящие 12 часов на
пользователя (глобально, не per-курс) — 429 `{error: 'Лимит шеринга: 2
ссылки за 12 часов', retry_after_hours}`. Бесплатные ссылки — `is_free_preview`-
уроки и уроки бесплатных курсов (price = 0 и нет записей в `course_tariffs`) —
лимитом **не ограничиваются и его не расходуют**. Признак хранится в колонке
`lesson_shares.is_free` и попадает в событие `education.lesson_shared`.

**Право на шеринг** определяется тем же `checkLessonAccess`, что и просмотр:
нельзя расшарить урок, который сам не можешь открыть (включая drip-замок и
непройденный блокирующий тест). Это закрывает обход оплаты через гостевые
ссылки.

**Жизнь ссылки:** 1 час с момента создания, строго одно открытие. Даты во
всех share-запросах считаются на JS и передаются параметрами — SQLite-шим
(`db-sqlite.ts`) криво транслирует `NOW() ± INTERVAL`, поэтому диалект-нейтральный
вариант обязателен.

**Payload гостю** — только `{lesson: {title, content_html, position}, course:
{title, slug}}`. `content_html` проходит `sanitizeLessonHtml` (whitelist тегов,
https-only, img только /media/*). Аудио, видео, материалы и тест в SELECT не
попадают по построению запроса — расширить выдачу нельзя, не меняв код.

**База:** таблица `lesson_shares` (id, token VARCHAR(64) UNIQUE, lesson_id,
course_id, owner_user_id, created_at, expires_at, used_at, used_ip,
converted_user_id, converted_at, is_free). Миграция `src/migrations/lms_v10_lesson_shares.sql`
(идемпотентна, включая `ALTER TABLE ... ADD COLUMN IF NOT EXISTS is_free` и
`... converted_at` для уже созданных таблиц — ТЗ-195), применение: `POST /migrate-lms-lesson-shares?secret=
CRON_SECRET`. SQLite-зеркало — `initSQLiteSchema()` в `db-sqlite.ts` (смоуки).

**Атрибуция регистрации:** фронт после успешного открытия кладёт токен в
localStorage (`lesson_share_token`); `useAuth.register` шлёт его полем
`share_token`. Бэк ищет **использованный** токен (`used_at IS NOT NULL`,
формат 48 hex) и ставит `registration_source = 'lesson_share'`, пишет
`converted_user_id` **и `converted_at`** (момент регистрации — для периодной
статистики конверсий, ТЗ-195) и логирует `register` с `shared_by_user_id`/`lesson_id`.
Регистрация без токена или с битым/неиспользованным — штатная, источник не
перезаписывается.

**Статистика шеринга (ТЗ-195):** блок `sharing` в двух эндпоинтах админ-статистики
(`src/routes/adminEducation.ts`): сводный `GET /api/admin/education/stats/overview`
(+ `top_courses` — топ-5 курсов по созданным ссылкам, только живые курсы) и
детальный `GET /api/admin/education/courses/:id/stats` (+ `top_lessons` — топ-5
уроков курса). Формулы: `links_created` — по `created_at` в периоде;
`links_created_paid/free` — то же с разрезом `is_free`; `links_opened` — по
`used_at`; `links_expired` — `used_at IS NULL` и момент истечения внутри периода
(`since <= expires_at <= now` — ссылки с будущим `expires_at` ещё живы и не
считаются); `conversions` — по `converted_at`; `conversion_rate = conversions /
links_opened` (доля 0..1, округление до сотых на бэке, до целых % на фронте;
`null` при нуле открытий — конвенция ТЗ-180). Период — `days ∈ {7,30,90}`,
default 30, граница ISO-строкой в JS (кросс-диалектно PG/SQLite). Отображение:
карточка «Шеринг уроков» в сводной табе «Статистика» (`StatsPanel.tsx`) и
секция «Шеринг» в детальном виде курса (`CourseStatsView.tsx`) — обе по ТЗ-180/181,
отдельных вкладок нет. Смоук: `scripts/smoke-share-stats.js`.

**Фронтенд** (`pulse-frontend`): кнопка Share2 в ридер-баре урока
(`LessonPage.tsx`, рендерится только при наличии конспекта — гость видит
только текст) → `POST share` → GlassModal со ссылкой, «Копировать»
(clipboard + тост), подсказкой про квоту; 429 — тостом с текстом бэка.
Модалка открывается через `createPortal(..., document.body)` — у предков
`LessonView` есть CSS-transform (framer-motion), из-за него `fixed` внутри
дерева центрируется по документу, а не по вьюпорту. Публичная страница
`/share/lesson/:token` (`SharedLessonPage.tsx`, noindex, SafeHtmlContent):
состояния loading / текст урока + CTA «Открыть курс» / 410 used (CTA на курс
по `course_slug`) / 410 expired (CTA в каталог) / 404. Роут в `App.tsx`
рядом с SharedPathPage.

**События** (в ALERT_EVENT_TYPES не входят): `education.lesson_shared
{lesson_id, course_id, share_id, is_free}` — факт создания ссылки;
`register` с `{share_token, shared_by_user_id, lesson_id}` — конверсия гостя.

**Смоук:** `scripts/smoke-lesson-share.js` — 13 проверок: гейты (403/401/
drip), квота на платные (429) и обход бесплатными, сгорание и гонка (200+410),
used/expired/404, payload без аудио/материалов/теста, атрибуция регистрации,
регрессия register без токена.

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
- ТЗ-121: `included_tariffs` в публичной карточке курса (включая анонимов) —
  активные планы из `course_tariffs`, каждый `{id, name, price,
  billing_frequency}`. Помесячную конверсию годовых цен НЕ считаем (фронт
  показывает «₽/мес» только для `billing_frequency='monthly'`): ложная цена
  хуже её отсутствия. Фронт рендерит блок «или в подписке» гостю и юзеру
  без подходящего тарифа (`CoursePage.tsx`, условия: price>0, нет
  my_enrollment, нет access_via_subscription, included_tariffs непуст).
- ТЗ-122 (Задача 1): TTL висящих pending-платежей — cron ежечасно закрывает
  в `failed` всё, что в `pending` дольше 24 ч (брошенные оплаты ЮKassa /
  упавший create). Окно с запасом: confirmation_url ЮKassa живёт ~1 ч.
  Trade-off (осознан): активация идёт только из pending, поэтому webhook
  `payment.succeeded` после закрытия в failed платёж не активирует —
  лучше редкий ручной разбор, чем вечный мусор в payments и /payment/history.
  Пересмотреть, если появятся офлайн-оплаты с долгим подтверждением.
  Cross-dialect cutoff: SQLite-шим НЕ переводит `NOW() - INTERVAL '...'`
  (вырезает `INTERVAL '` раньше), поэтому `expireStalePendingPayments`
  использует тот же тernary-паттерн, что admin.ts:
  `datetime('now', '-24 hours')` / `NOW() - INTERVAL '24 hours'`.
- ТЗ-122 (Задача 2): перевыпуск path-share — один upsert
  `ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token` вместо
  DELETE+INSERT: параллельные POST (даблклик) больше не дают 500 на PK.
  `created_at` в DO UPDATE не трогаем — дата первого шеринга сохраняется.
- ТЗ-123: материалы привязываются к уроку опционально —
  `course_materials.lesson_id` (NULL = курсовой материал, как раньше;
  задан = материал урока, живёт в контексте урока). Публично отдаются
  только `status='approved'`; карточка курса отдаёт ТОЛЬКО курсовые
  (`lesson_id IS NULL`), урок отдаёт свои + `has_full_access`.
  Удаление урока чистит материалы ЯВНЫМ DELETE (не только CASCADE): в sql.js
  (SQLite-режим) `PRAGMA foreign_keys` не форсируется и каскад не срабатывает
  — опора только на него давала бы сирот в обоих диалектах; файлы
  file-материалов дополнительно уходят в trash через removeFile.
  Известное поведение (не тронуто): удаление КУРСА по-прежнему полагается
  на CASCADE без чистки файлов его материалов.
- ТЗ-124: `course_lessons.buttons` — JSONB-массив 0–3 CTA-кнопок урока:
  `{label ≤30, url (строго https:// или внутренний путь на '/', '//'-префиксы
  запрещены), color из пресетов 'accent'|'violet'|'green'|'ghost' (дефолт
  'accent'), target 'self'|'new_tab' (дефолт по типу ссылки: https →
  'new_tab', внутренняя → 'self')}`. Валидация и нормализация — целиком на
  бэке (`validateLessonButtons`, adminEducation); в БД падает уже готовый
  набор, БД доверяет API. PATCH-семантика: `buttons: undefined` в теле
  PUT — поле не трогается; очистка — явный `buttons: []`. Публично
  (`GET /api/education/lessons/:id`) отдаётся всем, кто видит урок
  (enrollment / free-preview / admin), кэш-инвалидация — существующая
  `invalidateEducationCache()` в PUT урока. Backlog: счётчик кликов,
  кнопки «только записанным».

## Storage-драйвер (`src/services/storage/driver.ts`)

Интерфейс: `putBuffer`/`putFile` → `{relPath, url, size}`, `removeFile`,
`signedUrl`, `verifySignedUrl`, `assertDiskSpace`, `bootstrapStorage`,
`purgeExpiredTrash`. S3 — интерфейс-заглушка (`throw 501`), переезд на
объектное хранилище без миграции данных (в БД только относительные пути).
ТЗ-199: `removeFile` пишет манифест `<trashName>.path` (исходный relPath);
листинг/корзина — `listFiles`/`listTrash`/`restoreFile`/`purgeTrashFile`,
чтение — `readFileBuffer`, guard'ы API — `normalizeMediaPath`/
`sanitizeTrashName` (подробности — в секции «ТЗ-199» ниже).

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
`/migrate-lms-lesson-idempotency`, POST + `?secret=CRON_SECRET_KEY`) применяются
вручную после первого деплоя схемы — автоматически не накатываются.

## Проверки

- `npx tsc --noEmit` — чисто.
- `node scripts/smoke-lms-step1.js` (после `npx tsc`) — 9 проверок: таблицы,
  идемпотентность, bootstrap, put, подпись (подделка/expired/чужой путь),
  soft-delete, purge, traversal, уровни доступа.
- `node scripts/smoke-lms-media.js` — HTTP 6/6: публичная обложка, signed
  gating, подделка/expired → 404, traversal, attachment для SVG.

## ТЗ-100 v8/v14 — шеринг пути + покупка курса (реализовано)

**Шеринг инвестиционного пути** (`src/routes/education.ts`):
- `GET|POST|DELETE /api/education/my/path-share` (auth). Один активный шеринг
  на юзера: POST перевыпускает токен (`crypto.randomBytes(24)` base64url;
  DELETE+INSERT — старый токен мёртв сразу), DELETE отзывает (204).
  URL: `FRONTEND_URL || https://pulse.inside-trade.ru` + `/education/path/<token>`.
- `GET /api/education/shared/:token` (публичный, без auth): `{owner:{username},
  stats:{courses,lessons_done,minutes}, items:[{slug,title,type,size,cover_url,
  progress_percent,completed}]}`. Только опубликованные публичные курсы
  владельца (hidden — исключены), `ORDER BY ce.created_at ASC`; владелец
  `is_blocked` → 404. email/user_id/source/даты НЕ отдаём. minutes — сумма
  `duration_min` пройденных уроков (CASE по matched `lesson_progress`,
  у `lesson_progress` составной PK без колонки `id`).
- Фронт: `pages/SharedPathPage.tsx` (маршрут `/education/path/:token` выше
  `/education/:slug`, noindex, дизайн `lms-full/mockup/path.html`),
  `components/education/SharePathModal.tsx` (GlassModal: копия/перевыпуск/
  отзыв, двухшаговые подтверждения), кнопка «Поделиться путём» на витрине
  `Education.tsx` (только авторизованным).

**Покупка курса через ЮKassa** (`product_type` в платёжном контуре):
- Миграции: `payments.product_type VARCHAR(20) NOT NULL DEFAULT 'subscription'`
  + `payments.product_ref VARCHAR(64)` (PG — ALTER в общем списке миграций
  `index.ts`, накатывается на boot; SQLite — CREATE в `db-sqlite.ts` + тот же
  guarded ALTER). Подписочный путь (DEFAULT 'subscription') без изменений
  поведения — регрессия проверена смоуком.
- `POST /api/education/courses/:slug/buy` (auth): курс `published` + public +
  `price>0` (иначе 404/400), enrollment есть → 409, promoCode → 400. INSERT
  payments: `product_type='course', product_ref=course_id, plan_id=NULL,
  billing_cycle='once', duration_days=NULL`. Дальше как в `payment.ts`:
  без ключей ЮKassa → demo-ответ с `confirmation_url` на `/payment/return`;
  иначе POST api.yookassa.ru/v3/payments (`return_url` на карточку курса с
  `?payment_id=&paid=1`, receipt «Курс PULSE «…»», `save_payment_method:false`,
  metadata `{product:'course', course_id}`).
- `activatePaymentIfNeeded` (services/subscription.ts): RETURNING дополнен
  `product_type, product_ref`; ветка 'course' — INSERT enrollment
  `source='purchase', payment_id` (ON CONFLICT DO NOTHING) + лог
  `payment_completed` с `product_type` (logPaymentCompleted — 5-й опциональный
  параметр; plan_id принимает null). Подписочная ветка не тронута.
- `webhook.ts`: SELECT дополнен `product_type`; курсовый платёж (без plan_id)
  НЕ путается с привязкой карты — отдельная ветка до card-guard: активация +
  ранний return (refund-trial/промо, plan-deleted, auto-renew для курсов не
  выполняются); в `payment.canceled` подписочный лог не пишется для курсов.
- `payment.ts`: `/confirm` ослаблен для course (без plan_id — не 400),
  message product-aware; `/status` и `/force-check` — card-binding guard
  пропускает `product_type='course'` в `activatePaymentIfNeeded`; SELECT'ы
  дополнены `product_type, product_ref`.
- Фронт: `CoursePage.tsx` — ветка «Купить курс» под фичефлагом
  `VITE_EDUCATION_PAYMENTS_ENABLED === 'true'` (выкл → прежняя ссылка на
  /pricing), редирект на `confirmation_url`; возврат с оплаты — поллинг
  `GET /api/payment/status/:id` (2 с × 15), по completed перезагрузка карточки
  и чистка query; 409 → перезагрузка; таймаут → «платёж обрабатывается».
- **Фикс драйвера SQLite** (`config/db-sqlite.ts`): write-запросы с RETURNING
  выполнялись через `db.run()`, теряя RETURNING-строки (молчаливая поломка
  идемпотентности `activatePaymentIfNeeded`, промо-инкремента и др. в SQLite-
  режиме; PG не затронут). Теперь write с RETURNING идёт через prepare/step.

**Проверки:** `npx tsc --noEmit`, `npm run build`, `node scripts/smoke-lms-path-buy.js`
— 19 проверок: сервисная активация (course + подписочная регрессия,
идемпотентность), path-share CRUD/перевыпуск/отзыв/блокировка, shared-фильтры
и приватность, buy-валидации, demo-флоу (buy → status → confirm → /my),
двойной клик, реальный webhook payment.succeeded (курс + подписочная
регрессия, IP ЮKassa через X-Forwarded-For), чужой payment_id → 404.
Регрессия: `smoke-lms-step2.js` — 2 прогона × 30 проверок зелёные.

## Дорожная карта (следующие шаги)

1. ~~Задача 1 + 1а: схема БД + storage-драйвер~~ ✅
2. ~~ТЗ-101: админка курсов/уроков/категорий + публичный контур~~ ✅
3. ~~ТЗ-100 Задачи 5–6: покупка курсов ЮKassa + шеринг пути~~ ✅

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
  fail-closed, общий суточный лимит. Пишутся пары `score>=0.5` ИЛИ тег-матч
  ИЛИ косинус ≥ `courses.embedding_threshold` (ТЗ-177, без LLM: score NULL,
  source `'embedding'`, reason «косинус X ≥ порога Y»; порог 0.30–0.95
  редактируется в админке, пусто — выкл; миграция `lms_v9_course_threshold`,
  ретроскан при смене). Выключатель ранкера — настройка `match_llm_enabled`
  (админка, таб «Образование», ТЗ-172): при выкл LLM не дёргается, пары идут
  по тегам и порогу;
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

**Рантайм-выключатель LLM-ранкера (ТЗ-172/174):** ключ `match_llm_enabled`
в `_education_settings` (паттерн radioSettings, default true) — выключен:
RECALL остаётся, LLM-батч пропускается, пишутся только тег-совпадения.
Управление — таб «Образование» в админке. Контракт `GET/PUT
/admin/education/settings` (ТЗ-174): PUT возвращает полную форму как GET
(фронт после сохранения делает refresh(), а не перезаписывает форму ответом).

**Env:** `EDUCATION_MATCH_ENABLED`, `EDUCATION_MATCH_LLM_DAILY_LIMIT` (500).

**Бэкфилл:** `scripts/backfill-course-embeddings.js` — эмбеддинги
существующих курсов (критерий приёмки №3; запуск после миграции, до включения
флага на проде).

**Фронтенд** (коммит в pulse-frontend отдельно): секция «Рекомендованные (N)»
в редакторе курса (`SuggestionsPanel`), «События календаря» в админке
(`EventsPreviewPanel`), публичные `CoursePage` / витрина `Education` /
`CalendarTodayBlock` / `MatchedCourseChips` / «Мои предложения» в профиле
(`SubmissionsTab`). Контракт автора UGC-материала: `submitted_by: {id, username}`.

## ТЗ-164 — SEO-пересборка при сохранении курса (реализовано)

`services/education/seoRebuild.ts`: event-driven перегенерация SEO-файлов
(витрина, карточки курсов, sitemap.xml, robots.txt — те же формулы, что
`scripts/seo-prerender.mts` pulse-frontend) напрямую в
`/opt/pulse/frontend/dist` при любой SEO-релевантной мутации админки —
без пересборки фронта. Build-time пререндер (ТЗ-140) остаётся первичным
покрытием при деплое и fallback'ом.

- `scheduleEducationSeoRebuild()` — неблокирующий планировщик: дебаунс
  `EDU_SEO_REBUILD_DEBOUNCE_SEC` (60) + защита «не чаще раза в 5 минут».
  Все мутации админки зовут только её.
- `rebuildEducationSeoNow()` — собственно пересборка (ручной роут + heal).
- `initEducationSeoBootHeal()` — на старте сервера: свежий dist залили
  вручную → education/* пропал → пересобрать.
- Атомарная запись (temp-файл + rename), ошибка → лог + alert админам,
  старые файлы не трогаем. Env (fail-soft): `EDU_SEO_ENABLED` (default
  true), `EDU_SEO_DIST`, `EDU_SEO_REBUILD_DEBOUNCE_SEC`. Шелла нет →
  warn и мягкий пропуск, НЕ падение.
- Формулы меты продублированы из `src/lib/seo.ts` фронта — при правке
  формул ТЗ-140/163 править оба места.

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
  **ТЗ-184 (автозапись):** при отсутствии записи оба эндпоинта (`/test` и
  `/complete`) пробуют автозапись через общий хелпер
  `ensureEnrollment` (`services/education/access.ts`) — бесплатный курс →
  `source='free'`, платный + активная подписка с планом из `course_tariffs` →
  `source='subscription'` (drip-гейты после записи исполняются как обычно),
  платный без подписки → прежний 403-пейвол (без автозаписи). Ручной
  `POST /courses/:slug/enroll` делегирует тому же хелперу (без события
  enroll_auto). Успешная автозапись помечается в ответе полем
  `auto_enrolled: true` (фронт показывает тост). Идемпотентно
  (`ON CONFLICT DO NOTHING`, гонка безопасна). События:
  `education.enroll_auto {course_id, source, trigger: 'test'|'complete'}`
  (в USER_EVENT_TYPES, НЕ в ALERT_EVENT_TYPES — в TG-алерты не входит) и
  для subscription-ветки — `education.enroll_subscribed`.
  Смоук: `scripts/smoke-lms-auto-enroll.js` (7 проверок).
- **ТЗ-185 (самоотписка):** `DELETE /courses/:slug/enroll` (auth) — удаляет
  enrollment студента. Курс: 404 только при отсутствии/`deleted_at` (статус
  публикации и visibility не проверяются — от архивного курса тоже можно
  отписаться). Записи нет → 204 (идемпотентно, без утечки факта чужой
  записи). `source='purchase'` → 409 «Курс куплен: отписка невозможна».
  Прогресс (`lesson_progress`) не трогаем — при повторной записи
  восстанавливается (у subscription-источника запись вернётся и автозаписью
  ТЗ-184 при следующем интерактиве; `enrolled_at`/`created_at` при этом
  пересоздаётся). Событие `education.unenroll {course_id, source}` (в
  USER_EVENT_TYPES, НЕ в ALERT_EVENT_TYPES). Смоук: `scripts/smoke-unenroll.js`
  (8 проверок: free/purchase/subscription/гость/чужой/архивный/404/идемпотентность).
  Фронт: кнопка «Отписаться от курса» в карточке курса (`CoursePage`) —
  confirm с пояснением про subscription и сохранение прогресса, 409 → тост
  с текстом бэкенда. На мини-карточках витрины кнопки нет (решение владельца).
- GET `/lessons/:id` без изменений (весь контент, тест без correct, prev/next).

**Фронт** (pulse-frontend):
- `pages/LessonPage.tsx`, маршрут `/education/lesson/:id` (статический сегмент
  `lesson` ранжируется выше `/education/:slug`). Состояния: loading / 404 /
  401 (кнопка «Войти» через auth-modal) / 403 (subscription_expired,
  locked_by_drip с «откроется через N дн.», test_blocked). Контент: видео
  (embed-iframe; белый список доменов `embedUrl.ts`: youtube, vkvideo, vimeo,
  **rutube** — ТЗ-164: страница rutube `/video/<id>` нормализуется в
  `/play/embed/<id>` на бэке при сохранении; youtube watch→embed конвертация
  на клиенте; ТЗ-165: 15 с на попытку + 2 молчаливых авто-ретрая + оверлей
  «загружается…» после 5 с), текст как HTML
  (санитизирует бэк `sanitizeLessonHtml` — вынесен в
  `services/education/contentHtml.ts`, ТЗ-108; whitelist расширен тегом `u`;
  ТЗ-176: редактор уроков поддерживает таблицы TipTap — вставка 3×3 с
  шапкой, бабл редактирования строк/колонок; бэк таблицы принимал и раньше,
  сериализационный мусор TipTap (colgroup/style) вырезается санитайзером,
  colspan/rowspan — тоже; `.edu-content` — `overflow-x:auto` для мобильного),
  общая rich-text типографика `.edu-content` (index.css) — тот же класс, что в
  предпросмотре админки (TextFormatField, ТЗ-108) и карточке курса; тест
  (радио-варианты → грейдинг →
  при проходе автоматический `complete`), кнопка «Отметить пройденным» для
  уроков без теста, навигация prev/next.
- `CoursePage`: строка урока — ссылка, когда `(enrolled || is_free_preview) &&
  !locked_by_drip`; иначе прежняя неактивная строка с замком/drip-плашкой.
  Описание курса — HTML (ТЗ-108): `description` санитизируется
  `sanitizeLessonHtml` на записи (POST/PUT /admin/education/courses) и на
  публичной отдаче (legacy-строки), карточка рендерит его через
  `dangerouslySetInnerHTML` в `.edu-content` (whiteSpace pre-wrap — старые
  plain-text описания не слипаются).
- `lib/api.ts`: ошибки HTTP теперь несут `err.data` — тело ответа целиком
  (машиночитаемые `reason`/`unlock_in_days` из LMS и будущих эндпоинтов).
- `lib/educationApi.ts`: `fetchLesson`, `submitLessonTest`, `completeLesson`.

**ТЗ-108 v3 — нормализация простого текста (2026-10-02):** `normalizePlainText()`
в `services/education/contentHtml.ts` — «простой текст» без блочных тегов
(регуляка `p|h1-4|ul|ol|li|blockquote|pre|table`) на записи И на отдаче
(легаси-строки без миграции) превращается в абзацы: split по `\n\s*\n` → `<p>`,
одиночные `\n` → `<br>`; размеченный текст (есть блочные теги) не трогается.
Идемпотентно по построению. Контракт хранения: абзацы = `<p>`, перенос = `<br>`;
sanitize-html сериализует `<br />` (XHTML) → нормализуем в HTML5 `<br>`.
Публичный GET урока теперь тоже санитизирует `text_content` (legacy-чтение).
Предпросмотр TextFormatField рендерит тот же нормализованный HTML
(`normalizePlainTextForPreview` — зеркало правил бэка, критерий 9).
Smoke step2: +1 блок (plain→абзацы запись/чтение, идемпотентность, round-trip
размеченного, описание курса) — 31 проверка × 2 прогона.

**Проверки:** smoke-lms-step2.js дополнен блоком грейдинга (401 анониму,
400 по длине, подсчёт 0/100), 30 проверок × 2 прогона, зелёные.

## ТЗ-105 v2 — программы из курсов (этап A: схема + публичный API, реализовано 2026-10-14)

Программа (плейлист) — обёртка над независимыми курсами; пейволл остаётся
на курсах. Прогресс вычисляемый, мягкая последовательность (без блокировок).

**Схема:** миграция `src/migrations/lms_v7_paths.sql` (PG) применяется эндпоинтом
`POST /migrate-lms-paths?secret=KEY` (в SQLite-режиме таблицы создаёт
`initSQLiteSchema()`). Таблицы: `course_paths`, `course_path_items` (PK path+course,
position 1..N), `course_path_enrollments`. Курсы удаляются мягко — чтения
фильтруют `courses.deleted_at IS NULL`.

**API (`src/routes/education.ts`):**
- `GET /api/education/paths` — полка: published-программы; кэш `education:paths`
  (5 мин, только безликая часть), `my` дочисляется после кэша для записанных.
- `GET /api/education/paths/:slug` — детальная: items по position
  (карточные поля + `included_tariffs` + `my_status`), `hidden_count` без названий
  (анти-энумерация), archived — записанным с пометкой, остальным 404,
  анониму без `my`. Прогресс — одним агрегирующим запросом (CTE, не N+1);
  процент по ВСЕМ видимым курсам, включая платные без доступа (решение
  владельца — «крючок» к покупке); `completed` только при всех пройденных.
  `next_slug` — первый по position непройденный доступный (записан/бесплатный).
- `POST …/paths/:slug/enroll` — идемпотентно: запись на программу +
  массовая запись на курсы (free/subscription, source НЕ перезаписываем,
  hidden — пропуск, платный без доступа → `needs_purchase`). Ответ
  `{enrolled, already, needs_purchase}` (slug'и — для тостов).
- `DELETE …/paths/:slug/enroll` → 204; трогает ТОЛЬКО запись на программу
  («отписка ≠ разборка»: записи на курсы и прогресс сохраняются).
- `GET /api/education/my` — формат ответа изменён с массива на
  `{courses, paths}`: флаг `via_path` у курсов, записанных только через
  программу (фронт прячет их из общего списка), массив «Моих программ»
  с прогрессом. Фронт `fetchMyCourses` совместим с обоими форматами
  (`courses ?? массив`).

**Деплой/проверки:** бэкенд `b73a799`, фронт `c4686a5`. Миграция применена на VDS
(3 CREATE TABLE OK, повтор — идемпотентно). Полка → `[]`, детальная несуществующей
→ 404, enroll/my без токена → 401. Нюанс: Caddy отвечает 405 на POST к корневым
`/migrate-*` — миграции применять по IP бэкенд-контейнера изнутри VDS.

Этапы (б) админка (`adminEducation.ts`) и (в) фронт — НЕ начаты.

## ТЗ-105 v2 — этап B: админка программ (реализовано 2026-10-14)

Секция в `src/routes/adminEducation.ts` (все роуты за adminMiddleware):
`GET/POST /paths`, `GET/PUT/DELETE /paths/:id` (items — полная замена,
≥2 без дублей, position 1..N, у soft-deleted курсов `removed: true`),
`POST …/publish` (422 при <2 живых курсов) / `…/archive`,
`GET /courses-search` (комбобокс, ≥2 символа), `POST …/enroll-user`
(admin_grant на все курсы программы, идемпотентно, лог
`education.path_enroll_admin`), `POST …/paths/:id/cover` (контур обложек
курсов). Все мутации → `invalidateEducationCache()`. Типы событий
`education.path_*` — в `src/types/events.ts`.

**Проверки:** tsc зелёный; SQLite-смоук с реальным роутером — 24/24
(CRUD, валидации 400, 422 publish, позиции, enroll-user, идемпотентность).
Прод (`fb896e4` + фикс `5dfeacf`): 401 без токена; тестовая программа
через SQL → полка отдала карточку (2 курса, 12 уроков, 79 мин),
детальная — items по position с карточными полями. Фикс: анониму в
детальной уходил '' в uuid-сравнение (PG ругался, SQLite — нет) → NULL.
Зачистка выполнена, логи чистые.

## ТЗ-105 v2 — этап C: фронт программ (реализовано 2026-10-14)

Фронт (`pulse-frontend`, `02566d3`): полка «Программы» на витрине
(Education.tsx, кэш `education:paths` TTL 5 мин — новая программа
видна с задержкой до 5 мин), страница `/education/paths/:slug`
(EducationPath.tsx: hero, цепочка курсов со статусами, enroll/unenroll),
«Мои программы» в фильтре «Мои курсы» (курсы с `via_path` прячутся из
общей сетки), «Входит в программы» в карточке курса. Админка: таблица
программ + инлайн-редактор (PathSection/PathEditor, таб «Образование»
→ «Курсы») — обложка, порядок стрелками, combobox courses-search,
«Записать пользователя», «Глазами ученика ↗».

Бэкенд-фиксы (`447402e`): `draft`-программа → 404 всем кроме
`?preview_token=<admin JWT>` (isAdminUser), `archived` → записанным и
превью, enroll — только `published`; в карточке курса поле `paths`.

**Прод-проверки (e2e, зачистка выполнена):** тестовая программа
(2 бесплатных + 1 платный) через psql → полка отдала карточку
(курсов: 3), детальная — items по position, платный → `needs_purchase`,
карточка курса — `paths: [{slug,title}]`, draft → 404, enroll анонима
→ 401, после DELETE полка снова `[]`.

## Дорожная карта (следующие шаги)

1. ~~Задача 1 + 1а: схема БД + storage-драйвер~~ ✅
2. ~~ТЗ-101: админка курсов/уроков/категорий + публичный контур~~ ✅
3. ~~ТЗ-102 (UGC + ClamAV)~~ ✅ / ~~ТЗ-103 (мэтчинг)~~ ✅
4. ~~ТЗ-100 v8/v14: шеринг пути + покупка курсов ЮKassa~~ ✅
5. ТЗ-100 Задача 4: «Мои курсы» в ЛК/прохождение (фронт).
6. ~~ТЗ-107 v3: граф знаний~~ ✅ (14.10, флаг включён, e2e пройден)
7. ~~ТЗ-103: мэтчинг курсов↔новости~~ ✅ (14.10, первичный ретроскан пройден)

## ТЗ-107 v3 — Граф знаний (2026-10-14, deployed)

**Коммиты:** backend `d66cd89` (+`518792e` фикс смоука), frontend `518bded`,
флаги `82d629f`+`5ca7d36`. Миграция `lms_v8_knowledge_graph.sql` применена
на проде (5 объектов, через `POST /migrate-lms-kg?secret=` по IP контейнера).

**Что внутри:** ночная джоба `startKnowledgeGraphCron` (04:50 Europe/Moscow —
слот 04:30 занят ANALYZE news) пересчитывает эмбеддинги изменившихся уроков
(SHA-256 text_hash, без instruction-префикса) и атомарно заменяет снапшот
`lesson_embeddings` / `lesson_similarity` / `course_similarity`
(PG-транзакция через pool.connect). Пороги через env (`src/config/knowledgeGraph.ts`):
`KG_LESSON_CROSS_MIN_SIM` (0.55, топ-`KG_LESSON_CROSS_TOP`=5 cross-course),
`KG_LESSON_INTRA_MIN_SIM` (0.60, топ-`KG_LESSON_INTRA_TOP`=3 внутрикурсовых),
`KG_COURSE_MIN_SIM` (0.45, среднее по топ-`KG_COURSE_TOP_PAIRS`=10 cross-пар).

**API (фичефлаг `EDUCATION_GRAPH_ENABLED`, без флага — 404):**
- `GET /api/education/graph` — глобальная «Карта знаний»: узлы курсов
  (lessons_count, students, included_tariffs) и уроков, рёбра курсов/уроков
  из снапшота, `my_progress`/`my_courses` для авторизованного. Анти-энумерация:
  hidden-курсы видны только записанным (узлы + рёбра). Кэш 5 мин на процесс.
- `GET /api/education/courses/:slug/graph` — граф курса: уроки с состояниями
  `done`/`current`/`open`/`locked` (4-е состояние «open» — отступление от ТЗ:
  записан, не drip, урок доступен, но не текущий), `edges_structural`
  (позиции), `edges_semantic` (id уроков курса, sim), рекомендации до 6
  (урок → чужой курс, `shared_tags` — «почему связаны»). Drip-замок по
  tenure как в ТЗ-100 v13. Гостю free_preview-урок отдаётся как `current`.

**Фронт:** `KnowledgeMap` (витрина, `Education.tsx`), `CourseKnowledgeGraph`
(`CoursePage.tsx`, внизу контента), ручной SVG, layout детерминирован
FNV-1a(id), без библиотек. `graph: null` → секция не рендерится.

**Верификация:** tsc 0, vitest 246/246, смоук `scripts/smoke-lms-kg.js` 7/7
(флаг off/on, анти-энумерация hidden, состояния, рекомендации), регрессия
`smoke-lms-path-buy.js` зелёная. На проде: миграция applied, `/graph` → 404
(флаг выключен до первого прогона джобы). Критерии 2–3 ТЗ (пересчёт
эмбеддингов, spot-check урок↔новость) — только после первого ночного прогона.

**Включение фичи — выполнено 14.10 вечером:** флаги
`EDUCATION_GRAPH_ENABLED=true` и `EDUCATION_MATCH_ENABLED=true` закреплены
в `/opt/pulse/.env` + mapping в `docker-compose.yml` (backend). Фронт без
изменений — секции графа подхватились из релиза ТЗ-107.

**Прод-запуск 14.10 (факты):** бэкфилл `courses.embedding` через
`scripts/backfill-course-embeddings.js` (8/8 — векторов не было, триггер
ТЗ-103 появился после импорта курсов; без них `course_similarity` пуст по
построению). KG-перезапуск: 53 урока (0 в TEI — кэш text_hash), 69 рёбер
уроков + **11 рёбер курсов** за 0,35 с. E2E: `/api/education/graph` → 200,
граф курса — 13 уроков со состояниями, 12+4 рёбер, 5 рекомендаций.
Транспорт TEI переведён на `node:http` (undici headersTimeout 300 с,
см. docs/embeddings.md), TEI: **RAYON=1, cpus 1.5, mem 4500m** (актуальные
значения `docker-compose.yml` `d245639` == VPS, сверено 27.10; промежуточные
RAYON=2 / cpus 2 / mem 5000m из ранних заметок устарели).

**Мэтчинг курсов↔новости (ТЗ-103) включён тем же рестартом:** первичный
прогон — `retroscanCourse` по каждому published-курсу (ретеншн-окно,
LLM-ранжирование), дальше хук в newsProcessor + cron `0 * * * *`
(`matchUnprocessedNews`, окно 2 ч).

**Подтверждения REVIEW-TZ-107 (27.10, критерии 3 и 7):**
- **Spot-check векторов урок↔новость** (критерий 3): урок «Два вида волатильности»
  (fd8bf111) — косинус к новости про волатильность **0.2791** vs к новости
  про SpaceX **0.1939** (байтовый вектор `lesson_embeddings` ↔ pgvector
  `news.embedding`, cosine посчитан скриптом offline). Порядок верный.
- **Скриншоты секций** (критерий 7): docs/images/tz107-knowledge-map.png
  (глобальная «Карта знаний», 9 курсов + орбиты уроков + фиолетовые рёбра)
  и docs/images/tz107-course-graph.png (локальный «Граф знаний» курса
  «Управление капиталом», узлы в состояниях, рекомендация «О курсе: как учиться»,
  sim 0.66). Оба сняты playwright'ом с прода 27.10.
- **Гость и free_preview:** аноним получает `current` только для уроков с
  `is_free_preview` (проверено: у курса «Управление капиталом» все 3 урока
  free_preview — все три cyan корректны), остальные — `locked`.
- **Расхождение найдено ревью (закрыто):** в доках были промежуточные лимиты
  TEI (RAYON=2 / cpus 2 / mem 5000m) и выдуманные имена env-порогов
  (`KG_LESSON_THRESHOLD` и т.п.) — выправлено на фактические
  (`KG_LESSON_CROSS_MIN_SIM` и др., см. выше). git == VPS, деплой лимиты
  не откатывает.

## ТЗ-179 — события обучения в user_events (2026-10-17)

Четыре студенческих события для аналитики воронки (записался → начал → прошёл),
популярности материалов и истории попыток теста. Новых таблиц нет — всё пишется
`logUserEvent` в существующие `user_events` (JSONB, fire-and-forget, падение
insert не влияет на ответы API). Смоук: `scripts/smoke-lms-events.js` (12 проверок).

**Типы** (`src/types/events.ts`, блок LMS): `education.course_started`,
`education.lesson_started`, `education.material_downloaded`, `education.test_attempt`.

**Правила:**
- Логируются ТОЛЬКО авторизованные не-админы. Админские проходы по гейтам
  (`hasAccess = enrollment || admin || is_free_preview`) воронку не засоряют;
  анонимы структурно не логируются (`user_id` обязателен).
- `lesson_started` — первый просмотр урока (дедуп по `event_data->>'lesson_id'`),
  event_data `{course_id, lesson_id, position}`.
- `course_started` — первый `lesson_started` юзера в курсе (дедуп по
  `event_data->>'course_id'`), event_data `{course_id, lesson_id, source}`
  (source из enrollment: free/purchase/subscription/admin_grant, либо `preview`
  для гостевого free-урока, открытого залогиненным без записи).
- `material_downloaded` — строго после всех гейтов скачивания (антивирус 423,
  UGC-модерация 403, is_free/enrollment), перед 302 на signedUrl. Без дедупа
  (каждое скачивание — событие), event_data `{course_id, material_id, kind}`
  (title не кладём — кракозябры legacy, ТЗ-170). Слепая зона: гостевые is_free
  скачивания (гейт разрешает анонимам, логировать некому).
- `test_attempt` — каждый POST `/lessons/:id/test` после грейдинга, event_data
  `{course_id, lesson_id, score, pass_score, passed}`. История попыток живёт
  здесь; `lesson_progress.test_score` по-прежнему хранит ТОЛЬКО последний зачёт
  (пересдача затирает, ТЗ-100) — для динамики score по попыткам смотрим события.

**TG-алерты:** фильтр `admin_tg_settings.event_types` — whitelist
(`adminAlerts.ts`, `parseEventTypes` NULL→[], неизвестные типы отсекает
`saveAdminTgSettings`), поэтому события не попадают в TG без явной подписки
админа. Правки `ALERT_EVENT_TYPES` для этого не требовались — после ТЗ-123
в нём уже есть flat-типы `course_started`, `lesson_completed`,
`course_completed` (записываются рядом с `education.*` тем же
`logUserEvent`), и админы могут на них подписаться во вкладке Alerts.
Антифлуд: на текущий момент `minIntervalMin` ни на один образовательный
тип не задан, лимитирован только `page_view_feed` (60 мин) — см.
`TELEGRAM_NOTIFICATIONS.md` §6.1 «Антифлуд (ТЗ-123)».

## ТЗ-180 — сводная статистика обучения (2026-10-19)

Третья под-вкладка «Статистика» в табе «Образование» админки: дешборд
«записался → начал → прошёл» по каждому курсу (published/archived, не удалённые).

**Эндпоинт:** `GET /api/admin/education/stats/overview?days=7|30|90`
(дефолт 30; не из списка — фолбек на 30, не 400). Роут: `adminEducation.ts`
(`/stats/overview`). Ответ: `{ period_days, generated_at, courses: [...] }`.

**Формулы** (деление на ноль → `null`, фронт рендерит «—», а не 0%):
- `start_rate = started_period / enrolled_period` — старты за период из событий
  `education.course_started` (distinct user_id), записи за период — по
  `course_enrollments.created_at`.
- `completion_rate = completed_total / enrolled_total` — завершивших считаем из
  `lesson_progress` (distinct уроков >= уроков курса), записи — за всю историю.
- `test_pass_rate = passed / attempts`, `avg_test_score` — из событий
  `education.test_attempt` (score округляется до целого). Поля событий читаем
  через `event_data->>'...'` — работает и в PG, и в sql.js (SQLite ≥3.38).
- `active_learners_7d` — distinct user_id по трём типам событий за 7 дней
  (не зависит от выбранного периода).
- Сортировка по умолчанию: `enrolled_period` DESC, тай-брейк `enrolled_total` DESC.

**Фронт:** `StatsPanel.tsx` — чипы периода, сводка-чипы (суммы по всем курсам),
сортируемая таблица (клик по заголовку), клик по строке → редактор курса.
Янтарная подсветка (`C.warning`) при `start_rate < 0.3` или
`completion_rate < 0.1` при `enrolled_period >= 10` (константы
`WARN_*` вверху файла). Панель держится смонтированной в `EducationTab.tsx`
(`display:none`) — ленивая загрузка один раз, переключения вкладок сеть не дёргают.

**Оговорка:** старты/тесты/скачивания — только с даты выката ТЗ-179 (события
не ретроактивны); записи и завершения — за всю историю. Плашка об этом в UI.

**Тесты:** фронт — vitest `statspanel.tz180.test.tsx` (7 проверок); бэкенд —
live-API `src/tests/educationStatsOverview.test.ts` (паттерн ТЗ-174, прогон
на проде после деплоя).

## ТЗ-181 — детальная статистика курса (2026-10-19)

Второй уровень дрилл-дауна из сводной табы (ТЗ-180): клик по строке курса
открывает детальный экран внутри той же табы (не редактор). Состояние в URL
(`?course=<id>`) — перезагрузка/шаринг сохраняют экран; период 7/30/90 общий
со сводной.

**Эндпоинт:** `GET /api/admin/education/courses/:id/stats?days=7|30|90`
(дефолт 30, фолбек на 30 для невалидного; 404 — курс не найден). Роут:
`adminEducation.ts` (`/courses/:id/stats`). Один запрос = весь экран; «кто
записан» НЕ дублируется — фронт берёт существующий
`GET /courses/:id/enrollments`.

**Формулы:**
- `funnel.enrolled` — все записи; `started` — distinct user_id событий
  `education.course_started` (ТЗ-179, не ретроактивны); `halfway` — юзеры с
  ≥ ceil(lessons/2) завершёнными; `completed` — все уроки курса.
- `sources` — разложение enrolled по `course_enrollments.source`.
- `activity_timeline` — user_events за период по дням + `lesson_completed`
  из `lesson_progress.completed_at` (события не логируются, по дизайну);
  бэк отдаёт только ненулевые дни — фронт достраивает полную ось.
- `lessons[].drop_vs_prev` — доля завершивших урок минус доля предыдущего
  (от enrolled); первый урок — null. `median_day` — медиана
  (completed_at − дата записи) в днях, считается в JS (кросс-диалектность).
- Задача 2: событие `education.test_attempt` дополнено `answers: number[]`
  (индексы выбранных вариантов). `lessons[].per_question` — топ-3 вопроса
  по wrong_rate (сверка с `lesson_tests.questions[].correct`, считается в JS).

**Фронт:** `CourseStatsView.tsx` — воронка (бары), stacked bars SVG руками
(4 серии, детерминированно), «кто записан» (enrollments + локальный поиск) |
«активные за 7 дней», таблица уроков со стопперами, топ-3 завальных вопросов,
материалы (нулевые скачивания не выкидываются — видно «мёртвые» файлы).

**Тесты:** фронт — vitest `coursestats.tz181.test.tsx` + дрилл-даун в
`statspanel.tz180.test.tsx`; бэкенд — live-API `courseStatsDetail.test.ts`
(прогон на проде после деплоя).

## ТЗ-199 — галерея файлов и корзина (2026-10-26)

Четвёртая под-вкладка «Файлы» в табе «Образование» админки: медиатека всего
storage LMS — превью, привязки «где используется», копирование пути, удаление
с защитой, корзина tmp/trash с восстановлением и purge.

**Драйвер** (`services/storage/driver.ts`): `listFiles(kind?)` — рекурсивный
обход `UPLOADS_DIR/<kind>` (4 kind'а; S3-ветка — StorageError 501, как у
putBuffer); `listTrash()` — записи `tmp/trash`, исходный relPath читается из
манифеста `<trashName>.path` (removeFile пишет его с ТЗ-199, best-effort);
записи до ТЗ-199 без манифеста — legacy, показываются без restore.
`restoreFile(trashName)` — 400 без манифеста, 409 «путь занят»;
`purgeTrashFile` — unlink файла + манифеста. `readFileBuffer(relPath)` —
чтение по relPath через `normalizeMediaPath` (префикс `/media/`, без `..`,
kind из разрешённого набора — тот же guard во всех `/files/*` эндпоинтах).
`normalizeMediaPath`/`sanitizeTrashName` — guard'ы API (path traversal → 400).

**Usage-скан** (`services/education/fileUsage.ts`): чистая
`scanFileUsages(queryFn, paths)` — courses/course_paths по cover_url
(live-only, `deleted_at IS NULL`), материалы `kind='file'` (с origin/status
UGC и флагом `course_deleted`), картинки конспектов по
`text_content LIKE '%'||path||'%'`. PG/SQLite кросс-диалект.

**Эндпоинты** (`adminEducation.ts`, все за adminMiddleware): листинг
50/стр + summary; `DELETE /files` (занят и не force → 409 `{usages}`);
`GET /files/download` — скачивание через Bearer вместо signed URL
(materials/ugc mediaGuard'ом публично не отдаются); trash list / restore
(в ответе `usages_count` — подсказка «вернулся сиротой») / purge.
Аудит: `education.file_deleted|file_restored|file_purged`.

**Фронт:** `FilesPanel.tsx` (keep-mounted в `EducationTab.tsx`, как StatsPanel)
— сегменты «Все/Обложки/Контент/Материалы/Корзина» (amber-активная), сетка
карточек с вертикальным hover/focus-within оверлеем, бейджи-пилюли привязок
с переходом в курс, три модалки (409 со списком / «В корзину?» / «навсегда»),
корзина строками. Скачивание — `downloadFile()`: fetch+Blob с Bearer через
`/files/download` (прямая ссылка на materials/ugc давала 403).

**Оговорки:** restore возвращает файл, но НЕ запись БД (удалённый материал
вернётся «сиротой» — предупреждение в UI после restore при `usages_count=0`);
usage-скан по `text_content LIKE` ок на текущих объёмах, при росте —
индекс/таблица ссылок (TODO).

**Тесты:** бэкенд — `src/tests/filesPanel.tz199.test.ts` (40 проверок: драйвер
на temp UPLOADS_DIR + usage-скан на сидированном SQLite; запуск
`TS_NODE_TRANSPILE_ONLY=true npx ts-node src/tests/filesPanel.tz199.test.ts`);
фронт — vitest `filespanel.tz199.test.tsx` (10 проверок).

## ТЗ-200 — баннер «не опубликован» только для неопубликованных (2026-10-28)

**Баг:** фиолетовый баннер «Предпросмотр: курс не опубликован» показывался админу
на ОПУБЛИКОВАННОМ курсе — фронт вязал его на `admin_preview` (бэкенд: админ без
enrollment), статус курса во фронт-тип не доходил.

**Фикс (фронт `7a64389`, версия 8.6.55):** `PublicCourseCard.status` добавлен в
тип (в бэкенд-payload `status` был уже давно); `previewMode = admin_preview &&
status !== 'published'` — баннер и скрытие CTA/тарифов по нему; на published +
admin без записи — тонкая muted-плашка «Вы смотрите как админ · не записаны на
курс» + CTA как у ученика. `showAllMaterials` и маркер материалов остались на
чистом `admin_preview` (ТЗ-171 не тронут).

**Проверено на проде:** курс «Как далеко инвестиционная стабильность для
новичка?» (published, admin_preview=true) — баннера нет, плашка + «Записаться»
на месте (скриншот в сессии). Тесты: `coursepage.tz200.test.tsx` (5 сценариев),
регрессия `coursepage.tz189.test.tsx` зелёная.

## ТЗ-201 — интерактивный блок выбора тегов портфеля в уроке (2026-10-28)

**Что:** ученик выбирает теги портфеля прямо в конспекте урока (не уходя на
главную). Атом `div.tag-select-block` по образцу chart-block (ТЗ-143): контент
блока живёт вне HTML (API по юзеру), в text_content — пустой div с классом.

**Бэкенд (`86a563b`):** единственная правка — `services/education/contentHtml.ts`:
`allowedClasses.div += 'tag-select-block'` (`sanitizeLessonHtml` общая для
админского/публичного/shared-контуров; `routes/adminEducation.ts` — re-export,
отдельного «второго санитайзера» нет). Тест: `src/tests/contentHtml.test.ts`
(+2 кейса: блок переживает санитайзер, чужие атрибуты/содержимое вырезаются;
20/20).

**Фронт (`e471220`, версия 8.6.56 / code 78):**
- `src/components/tags/TagPicker.tsx` — компактный пикер: поиск `/tags/search`
  (дебаунс 200 мс, как на главной), счётчик лимита `/plans` +
  `getEffectiveTagLimit`, заморозка per-tag `is_frozen` (пилюля с замком без
  удаления, добавление заблокировано до разруливания лимита). Home.tsx НЕ
  рефакторится — его пикер переплетён с хиро-секцией, вынос — риск вне скоупа.
- `src/components/education/TagSelectBlockView.tsx` — карточка «Теги портфеля»:
  юзер → TagPicker; гость → демо-пилюли (без API), любой клик → модалка логина
  (`useAuthModal`); событие `education.tag_block_interaction` (role, action).
- `RichTextField.tsx`: нода `tagSelectBlock` (atom, по образцу ChartBlock) +
  NodeView с живым блоком; кнопка «Теги» (lucide `Tags`) в тулбаре. Лимит
  «один блок на урок» снят в ТЗ-203 — блоков может быть несколько.
- `LessonPage.tsx`: `querySelectorAll('div.tag-select-block')` + порталы
  `TagSelectBlockView` рядом с chartMounts (та же пересборка при `segMode`).

**Проверено на проде:** PUT `/api/admin/education/lessons/98bc9e23…` с блоком в
text_content → санитайзер пропустил (1578→1682 симв., класс на месте); публичный
`GET /api/education/lessons/:id` отдаёт блок. UI-проверка playwright'ом: юзер —
блок с пилюлями (31/45) + glow на фокус инпута; гость — демо-пилюли, клик →
модалка логина, **0 запросов** к /tags/* (снимки в сессии). Тесты:
`tagpicker.tz201.test.tsx` (5), `tagselectblock.tz201.test.tsx` (3); vitest 534
зелёных, tsc обоих репо — чисто.

**Полировка (`c847540`, версия 8.6.57 / code 79):** убран dashed-бордер NodeView
(→ solid #222); пилюли блока уменьшены ~35% (`Tag` — опциональный проп `small`,
дефолт/главная не тронуты; замороженные и демо-пилюли — аналогично); glow на
фокус инпута 1в1 с главной (`0 0 8px/24px/48px rgba(0,212,255,…)`).

**ТЗ:** `ТЗ-201-интерактивный-блок-тегов-в-уроке.md` (актуализировано по коду:
заморозка per-tag, один санитайзер, порталы вместо html-react-parser).

## ТЗ-202 — блок «Теги сообщества» в уроке (2026-10-28)

**Что:** популярные теги платформы ( PopularTagsSlider с главной) встраиваются в
конспект урока атомом `div.community-tags-block` — зеркало ТЗ-201. Отличие:
гостю показываются РЕАЛЬНЫЕ данные (эндпоинт публичный), демо-заглушка не нужна.

**Бэкенд (`02e5ef1`):** как ТЗ-201 — одна правка whitelist в
`services/education/contentHtml.ts` (+`community-tags-block`); тесты
contentHtml +2 кейса (22/22). Публичность `GET /news/tags/popular`
подтверждена живым запросом без JWT (200, 10 тегов).

**Фронт (`3dfe745`, версия 8.6.58 / code 80):**
- `usePopularTags(period, limit=15)` — limit-параметр, в queryKey (кэш главной
  и урока шарятся через общий QueryClient, дублей запросов нет).
- `PopularTagsSlider` — пропсы `variant/limit/autoScroll/analyticsSource`
  (дефолты = главная не тронута); `layoutId` табов через `useId` (антиколлизия
  при двух инстансах); embedded-вариант: без section/контейнера/fade-градиентов
  (#060606 на фоне карточки были бы полосами)/автоскролла; заморозка per-tag
  `is_frozen`: карточки перекрыты + компактная плашка (побочно закрыло молчаливые
  403 на главной при заморозке).
- `CommunityTagsBlockView` — карточка + embedded-слайдер; `isError` → null-рендер
  (нет пустой рамки посреди урока).
- `RichTextField`: нода `communityTagsBlock` + кнопка тулбара (TrendingUp).
  Лимит «один блок на урок» снят в ТЗ-203.
- `LessonPage`: порталы `div.community-tags-block`; `SharedLessonPage`: порталы
  обоих теговых блоков (до этого shared показывал пустые div).

**Проверено на проде:** PUT урока `98bc9e23…` с блоком → санитайзер пропустил;
playwright: юзер — блок с данными 24ч/7д (переключение меняет счётчики
260→1355), клик по карточке подписывает (портфель вырос, тег удалён за собой);
гость — реальные данные, запрос без Authorization, клик → модалка логина;
главная — секция «Популярные теги» без изменений (скриншот). Тесты:
`populartagsslider.tz202.test.tsx` (7), `communitytags.tz202.test.tsx` (2);
vitest 543 зелёных, tsc чисто.

## Редактор конспекта (RichTextField) — актуальное устройство (2026-10-28)

**Файл:** `pulse-frontend/src/components/admin/education/RichTextField.tsx`
(TipTap v3, `shouldRerenderOnTransaction: true`). Используется в форме урока
админки для поля `text_content`. Контракт хранения: value = HTML-строка
`text_content`, та же что у TextFormatField (ТЗ-108/136); схема документа
зеркалит серверный whitelist `services/education/contentHtml.ts`, round-trip
«визуально → HTML → визуально» данные не теряет.

**Режимы:**
- «Визуально» — TipTap; холст инлайн-стилями повторяет `.edu-content` студента
  1в1 (та же типографика, что на LessonPage и в предпросмотре).
- «HTML» — textarea с моноширинным шрифтом + плашка-предупреждение о тегах,
  которые вырежет санитайзер (автор видит ДО сохранения).

**Тулбар (в порядке следования):**
undo/redo · H2/H3 (h1 нет — серверный whitelist его не держит) · жирный/курсив/
подчёркнутый (ТЗ-176 добавил `u` и в схему, и в санитайзер) · код · ссылка
(только https://…) · маркированный/нумерованный список · цитата · картинка
(кнопка/drag&drop/Ctrl+V → `POST /content-image`, в хранении `width` %) ·
callout (акцентный блок) · HTML-блок (своя вёрстка островком) · график
инструмента (живые свечи Финама, ТЗ-143) · теги портфеля (ТЗ-201, иконка Tags) ·
теги сообщества (ТЗ-202, иконка TrendingUp) · таблица 3×3 с шапкой (ТЗ-176).
Блоков тегов каждого типа может быть несколько (лимит «один на урок» снят
в ТЗ-203); в каждом NodeView — тумблер «Подсветка» (ТЗ-203).

**Баблы выделения:** картинка/chart — ширина (25/33/50/100% или «во всю
ширину» — `width: null`), заменить картинку/инструмент, удалить; таблица —
строка выше/ниже, колонка левее/правее, удалить строку/колонку/таблицу.

**Кастомные atom-ноды (пустые div с классом, данные живут вне HTML):**
- `div.chart-block` — data-атрибуты `ticker/exchange/name/tf/range/width`,
  валидируются трансформером санитайзера (ТЗ-143).
- `div.html-block` — вёрстка хранится внутри div как raw-HTML; в документе
  TipTap — в attr `data-html` (URL-encoded) через трансформы `inHtml/outHtml`
  (TipTap не рендерит raw-HTML из attr; NodeView показывает вёрстку через
  dangerouslySetInnerHTML). При вставке — модалка-подтверждение «блок
  выполняется как есть».
- `div.tag-select-block` — только class (+ опциональный `data-glow="1"`
  подсветки, ТЗ-203), контент по API юзера (ТЗ-201).
- `div.community-tags-block` — только class (+ опциональный `data-glow="1"`),
  данные публичного `/news/tags/popular` (ТЗ-202).
- `callout` — акцентный блок.
- Таблицы TipTap `Table 3×3` (header row), `resizable: false`, сериализационный
  мусор (colgroup/style) и colspan/rowspan вырезает санитайзер.

**Рендер на публичных страницах — порталами, не html-react-parser:**
`LessonPage.tsx` монтирует `chartMounts` / `tagSelectMounts` /
`communityTagsMounts` (`querySelectorAll` по div-классам, пересборка при
`segMode` озвучки); `SharedLessonPage.tsx` (шеринг урока, ТЗ-187) — те же
теговые порталы через `SafeHtmlContent innerRef` (до ТЗ-202 shared показывал
пустые div).

**Санитайзер-контракт** (`services/education/contentHtml.ts`, общий для
админского/публичного/shared-контуров; `routes/adminEducation.ts` —
re-export, «второго санитайзера» нет):
- `allowedClasses.div = ['callout', 'html-block', 'chart-block',
  'tag-select-block', 'community-tags-block']`;
- `allowedAttributes`: `a[href]`, `img[src,width]`, `div[class,
  data-ticker, data-exchange, data-name, data-tf, data-range, data-width]`
  (data-* — только для chart-block);
- таблицы принимаются, colspan/rowspan и мусор TipTap вырезаются;
- `normalizePlainText()` (ТЗ-108 v3) — plain-text без блочных тегов на записи
  и на отдаче → абзацы `<p>`, `\n` → `<br>`.

**Поля-родственники формы урока:** видео (embed-домены и нормализация rutube —
ТЗ-164), превью видео (ТЗ-188), вложения/галерея (ТЗ-199). Они НЕ часть
RichTextField, но живут в той же форме.

**Тесты:** бэкенд `src/tests/contentHtml.test.ts` (22 кейса: блоки переживают
санитайзер, чужие атрибуты/содержимое вырезаются); фронт — `lessonpage.chart
.test.tsx`, `tagpicker.tz201.test.tsx` (5), `tagselectblock.tz201.test.tsx`
(3), `populartagsslider.tz202.test.tsx` (7), `communitytags.tz202.test.tsx`
(2).

## ТЗ-203 — подсветка интерактивных блоков урока (BorderGlow), опция per-block (2026-10-30)

**Что:** автор урока может включить «Подсветку» у каждого тегового блока
(теги портфеля ТЗ-201, теги сообщества ТЗ-202). Включённая = блок обёрнут в
BorderGlow (ТЗ-145) с автопробегом по появлению во вьюпорте — 1:1 с кнопкой
«Бесплатная регистрация» на главной. Chart-block в v1 не подсвечивается
(решенение владельца). Лимит «один блок типа на урок» снят: блоков может
быть несколько, у каждого своя подсветка.

**Бэкенд (`8c00aed`):** единственная правка — единый санитайзер
`services/education/contentHtml.ts`: `div` + `data-glow` в allowedAttributes;
трансформер div валидирует значение — атрибут живёт только у
`tag-select-block`/`community-tags-block` и только со значением `"1"`
(иначе вырезается). Тесты `contentHtml.test.ts` +5 кейсов (27 зелёных):
`"1"` переживает у обоих блоков, `"0"`/мусор/чужие div вырезаются.

**Фронт (`f5cfb61`, версия 8.6.60 / code 82):**
- `GlowBlock.tsx` — обёртка: enabled=false → children как есть; enabled=true →
  BorderGlow(borderRadius 12, фон карточки #101010); при glow карточка блока
  уходит во frameless (свои border/background/margin отключаются — нет двойной
  рамки); `prefers-reduced-motion` → `animated=false` (автопробег не стартует,
  свечение по ховеру остаётся); guard на отсутствие matchMedia.
- Ноды `tagSelectBlock`/`communityTagsBlock`: атрибут `glow` (parse/render
  `data-glow="1"`; false → атрибут не пишется, обратная совместимость).
- Тумблер «Подсветка» (Sparkles) — в шапке NodeView каждого блока:
  `updateAttributes({ glow: !glow })`, undoable через TipTap history; живое
  превью с пробегом — админ видит то, что ученик.
- Тулбар: кнопки вставки блоков больше не disabled (лимит снят), `hasNodeType`
  удалён.
- Рендер порталами: `LessonPage` и `SharedLessonPage` читают
  `el.dataset.glow === '1'` у div-атома и передают проп `glow` в
  TagSelectBlockView/CommunityTagsBlockView (html-react-parser не используется).
- Shared-урок: подсветка видна гостю (главный конверсионный сценарий).

**Фикс сериализации (`057678b`, версия 8.6.62 / code 84):** первый релиз
потерял атрибут при сохранении — `renderHTML` нод возвращал статический
`{ class }` без `mergeAttributes(HTMLAttributes, …)` (attribute-level
renderHTML отбрасывался; превью работало, т.к. NodeView читает attrs
напрямую). Исправлено по образцу chartBlock: обе ноды разворачивают
HTMLAttributes. Регрессионный тест `richtextfield.glow.tz203.test.tsx` (4
кейса: glow=true → `data-glow="1"`, glow=false → чистый HTML, round-trip
парсинга обратно — на старом коде тест падает). Живой прогон на проде:
PUT урока с `data-glow="1"` → GET, атрибут на месте (round-trip
санитайзера); UI-проверка владельцем после фикса — состояние
запоминается.

**Тесты:** `glowblock.tz203.test.tsx` (3: без обёртки / BorderGlow с
radius 12 + фон / reduced-motion → animated=false); tagselectblock.tz201
+2 (frameless при glow / рамка без glow); richtextfield.glow.tz203 (4,
сериализация). vitest 552 зелёных, tsc чисто.

**ТЗ:** `ТЗ-203-подсветка-интерактивных-блоков-borderglow.md` (пути
санитайзера и html-react-parser в исходном ТЗ устарели — реализация по
коду: один санитайзер + порталы).

**v2 — фокус после пробега (`06d916c`, версия 8.6.63 / code 85):** после
завершения автопробега свечения (~4 с) фокус переходит в поле поиска тега
(мигающий курсор приглашает ввод). Цепочка: BorderGlow новый опциональный
проп `onSweepEnd` (вызывается в onEnd последней анимации пробега) →
GlowBlock прокидывает → TagSelectBlockView (проп `sweepFocus`) ищет
`input[aria-label="Поиск тега"]` внутри блока и фокусирует с
`preventScroll`. `sweepFocus` включают только LessonPage/SharedLessonPage;
в NodeView редактора выключен (не крадём фокус у автора). У гостя инпута
нет — колбэк бездействует; при `prefers-reduced-motion` пробега нет → фокуса
нет. Тесты: glowblock +1 (прокидывание onSweepEnd), tagselectblock +2
(фокус при sweepFocus / не фокусирует без). vitest 555 зелёных.
