# PULSE — Трекинг действий пользователя (user_events)

> Дата актуализации: 2026-10-22
> Backend: `pulse-backend/src/services/activityLog.ts`, `pulse-backend/src/types/events.ts`, `pulse-backend/src/index.ts` (эндпоинты трекинга)
> Frontend: `pulse-frontend/src/pages/*` (вызовы `api.post('/events/...')`)
> Админский доступ: `pulse-backend/src/routes/admin.ts` (`/api/admin/activity-log`), `pulse-backend/src/routes/adminMetrics.ts` (`/api/admin/metrics/flow`)
> TG-алерты админам: [`../../TELEGRAM_NOTIFICATIONS.md`](../../TELEGRAM_NOTIFICATIONS.md) §6.1

---

## 1. Типы событий

Единый источник правды — `USER_EVENT_TYPES` в `src/types/events.ts` (вынесен в отдельный файл, чтобы разорвать циклическую зависимость между `activityLog.ts` и `adminAlerts.ts`).

На текущий момент **59 типов**:

| Блок | Кол-во | Типы |
|------|--------|------|
| Базовые | 24 | `register`, `login`, `forgot_password`, `password_reset`, `tag_added`, `tag_removed`, `payment_completed`, `subscription_activated`, `subscription_cancelled`, `channel_connected`, `channel_disconnected` (универсальные, устарели), `telegram_connected`, `telegram_disconnected`, `email_connected`, `email_disconnected`, `sentiment_vote`, `factcheck_ordered`, `page_view_plans`, `admin_changed_plan`, `admin_extended_subscription`, `page_view_portfolio`, `portfolio_add_clicked`, `portfolio_created`, `admin_radio_flag_changed` |
| LMS (префикс `education.*`) | 26 | Аудит действий админа (курсы/программы/модерация) и студенческая аналитика. Перечень — `src/types/events.ts`, подробности — [`../education.md`](../education.md) |
| Аудит выгрузок | 1 | `admin_export_users` (ТЗ-120) |
| ТЗ-123 (алерты/антифлуд) | 8 | `position_added`, `position_closed`, `course_started`, `lesson_completed`, `course_completed`, `weekly_report_viewed`, `cascades_viewed`, `page_view_feed` |

Новые типы добавляются только в `USER_EVENT_TYPES`; хелперы логирования и алерты берут их из одного места.

---

## 2. Запись событий

Все события пишутся через `logUserEvent(userId, eventType, eventData)` (`src/services/activityLog.ts`):

- `INSERT INTO user_events (user_id, event_type, event_data)` — `event_data` JSONB.
- Асинхронно вызывается `notifyAdmins(eventType, eventData, userId)` — TG-алерты админам (см. [`TELEGRAM_NOTIFICATIONS.md`](../../TELEGRAM_NOTIFICATIONS.md) §6.1).
- **Fire-and-forget**: хелперы (`logPageViewPlans`, `logPageViewPortfolio`, `logPageViewFeed`, `logCascadesViewed`, `logWeeklyReportViewed`, `logRegister`, `logLogin` и др.) не пробрасывают ошибки; на вызове — `logUserEvent(...).catch()`. Логирование не ломает основной flow и HTTP-ответы.

События от технических учёток (`registration_source = 'monitoring-probe'`) доходят до `user_events`, но TG-алерты для них пропускаются целиком (ТЗ-123).

---

## 3. Эндпоинты трекинга

### `POST /api/events/page-view` (authMiddleware)

Whitelist из **5 страниц** (`src/index.ts:3132-3153`):

| `page` | Событие | Frontend | Шлёт при |
|--------|---------|----------|----------|
| `plans` | `page_view_plans` | `Pricing.tsx` | `isLoggedIn` |
| `portfolio` | `page_view_portfolio` | `PortfolioPage.tsx` | `isLoggedIn` |
| `cascades` | `cascades_viewed` | `CascadesPage.tsx` | `isLoggedIn` |
| `weekly-report` | `weekly_report_viewed` | `WeeklyReportPage.tsx` | `isLoggedIn` |
| `feed` | `page_view_feed` | `NewsFeed.tsx` (выкатка коммитом `5ae7aab`, 2026-10-21) | `isLoggedIn` |

Все 5 страниц шлют событие только авторизованным. Неизвестное значение `page` — ответ `{ success: true }` без записи.

### `POST /api/events/click` (authMiddleware)

Клики по кнопкам; например `{ button: 'add_portfolio' }` → `portfolio_add_clicked`.

### `POST /api/news/:id/read` (authMiddleware)

Отметка «прочитано»: пишет в `user_news_reads`. В аналитике flow (ТЗ-122) эти записи приводятся к типу `read_article`.

---

## 4. Админский доступ к событиям

### `GET /api/admin/activity-log` (`src/routes/admin.ts:621-672`)

Лента событий: **все** `user_events` (без фильтра `admin_*`).

| Параметр | Описание |
|----------|----------|
| `user_id` | Опциональный фильтр по пользователю |
| `limit` | default 100, max 500 |

Ответ: `{ logs: [...] }` с `target_email` (email пользователя-субъекта) и `actor_email` — **только если** в `event_data` есть `admin_id` (админские события: кто выполнил действие).

### `GET /api/admin/metrics/flow` (ТЗ-122)

Визуализация потока действий. Подробности — [`../../METRICS.md`](../../METRICS.md) §2.1: единая лента `user_events` (без `admin_%`) + `user_news_reads` как `read_article`, сессия = разрыв > 1800 с, 4 блока ответа (`transitions`, `session_starts`, `bubbles`, `timeline`), кэш 60 с для агрегата (`flow:all:<period>`), per-user без кэша.

### `GET /api/admin/metrics/user-paths` (ТЗ-124, v2 — Санки)

Дашборд «Пути пользователей» поверх той же ленты и сессионизации (общие CTE-кирпичи `buildEventsCte`/`SESSED_CTE`). Подробности — [`../../METRICS.md`](../../METRICS.md) §2.2: 5 блоков (`users`, `exit_points`, `conversion_paths`, `branching`, `sankey`), параметр `scope=all|functions` (контентные события исключены до подсчёта branching и sankey), кэш `paths:<period>:<scope>` 60 с. Санки «Типичные пути» — первые 3 действия сессии, сборка в чистой функции `src/services/adminSessionSankey.ts` (схлопы малых потоков <3 в `other`, потолок 60 лент). Цели конверсии — `payment_completed`, `subscription_activated`, `subscription_cancelled`; история по ним восстановлена бэкфиллом `scripts/backfill-payment-events.js` (метка `tz124_backfill` в `event_data`).

### Карточка пользователя в админке

`UserDetailModal.tsx` → `UserActivityCharts.tsx`: bubble-график активности по часам + таймлайн событий (per-user `flow`, см. выше).

---

## 5. Связанные документы

- [`../../TELEGRAM_NOTIFICATIONS.md`](../../TELEGRAM_NOTIFICATIONS.md) §6.1 — TG-алерты админам: 28 типов `ALERT_EVENT_TYPES`, антифлуд `minIntervalMin`, skip `monitoring-probe`, системные алерты.
- [`../../METRICS.md`](../../METRICS.md) — продуктовые метрики админки (секция `engagement` — `user_events`, §2.1 — `GET /metrics/flow`).
- [`../education.md`](../education.md) — события LMS (`education.*`, ТЗ-179) и flat-типы обучения из ТЗ-123.
