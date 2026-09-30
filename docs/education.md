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
- ⏭ Дальше: ТЗ-100 Задачи 4–6 (прохождение/«Мои курсы» в ЛК, оплата курсов
  ЮKassa, шеринг пути), затем ТЗ-102 (UGC + ClamAV), ТЗ-103/105, ТЗ-104,
  ТЗ-107 последним.

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
4. ТЗ-102 (UGC + ClamAV), ТЗ-103/105, ТЗ-104 по команде, ТЗ-107 последним.
