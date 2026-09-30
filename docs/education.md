# LMS «Образование» — документация модуля

Образовательная платформа PULSE. ТЗ пакета: `ТЗ-100` (витрина/прохождение/оплата),
`ТЗ-101` (админка), `ТЗ-102` (UGC + модерация), `ТЗ-103` (мэтчинг с новостями),
`ТЗ-104` (симуляторы), `ТЗ-105` (программы), `ТЗ-107` (граф знаний).
Порядок внедрения — по README пакета; этот документ ведётся по мере реализации.

## Статус: шаг 1 (ТЗ-100 Задача 1 + 1а) — готово

- Схема БД: 11 таблиц (`courses`, `course_categories`, `course_tags`,
  `course_lessons`, `lesson_tests`, `course_materials`, `course_enrollments`,
  `course_tariffs`, `user_path_shares`, `lesson_progress`, `news_course_links`).
- Storage-драйвер файлов + единая точка проверки доступа.

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
2. ТЗ-101: админка курсов/уроков/категорий (upload обложек/материалов через
   драйвер, magic-bytes валидация, санитизация markdown).
3. ТЗ-100 Задачи 2–6: публичный API, витрина (пиксельный перенос мокапа),
   прохождение, оплата курсов через контур ЮKassa, шеринг пути.
4. ТЗ-102 (UGC + ClamAV), ТЗ-103/105, ТЗ-104 по команде, ТЗ-107 последним.
