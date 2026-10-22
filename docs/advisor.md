# PULSE — Advisor (клиентские портфели консультанта)

> Дата актуализации: 2026-10-22 (ТЗ-182, ТЗ-183, ТЗ-191, ТЗ-192, ТЗ-193)
> Backend: `pulse-backend/src/advisor/` (модуль-песочница, таблицы `advisor_*`)
> Frontend: `pulse-frontend/src/pages/adviser/` (страница `/adviser`)
> Гейтинг: `authMiddleware` + `requireFeature('multi_portfolio')` (`src/index.ts:3092`)

---

## 1. Назначение

Адвайзер (консультант) ведёт портфели клиентов: заводит клиентов, навешивает на
них теги из реестра ядра, получает LLM-саммари новостного фона, дайджесты и
алерты в Telegram, ставит задачи с напоминаниями. Ядро («Мой портфель» юзера)
в дайджесты адвайзера **не входит** (v5).

Таблицы — `advisor_*`, ноль ALTER'ов к ядру (`src/index.ts`, миграции ТЗ-182 v15).
Все данные жёстко изолированы по `advisor_user_id` (guard владельца на каждом
запросе; чужой/архивный клиент — 403 `advisor_client_forbidden` /
`advisor_client_archived`).

| Таблица | Назначение |
|---------|-----------|
| `advisor_clients` | Клиенты: имя, `is_archived`, `sort_order`, `last_alert_neg_at/pos_at` (кулдауны алертов) |
| `advisor_client_tags` | Теги клиента (уникальность `(client_id, tag_name)`), реестр — ядро |
| `advisor_summaries` | Precompute саммари: `(client_id, period_hours)` PK, `summary`, `articles_count`, `sentiment_mix`, `tags_snapshot` |
| `advisor_tasks` | Задачи: `due_date`, `remind_at`, `remind_channels`, `source_event_id`, `is_done` |
| `advisor_notes` | Лента заметок (ТЗ-193): до `ADVISOR_NOTE_LIMIT = 5` на клиента, текст ≤ 2000 симв.; миграция перенесла старое поле `clients.notes` в первую заметку |

## 2. Эндпоинты (`/api/advisor`)

### Клиенты и теги (`clients.ts`)

| Метод | Путь | Пояснение |
|-------|------|-----------|
| GET/POST | `/clients` | Список / создание. Создание под гейтом `portfolio_limit` тарифа (-1 = безлимит): превышение → 403 `advisor_limit_reached`. В списке (ТЗ-191 Задачи 4–5, ТЗ-192): `tags` — живые теги из реестра с цветами, `last_alert_neg_at/pos_at` (alert-line в карточке), `meta: {portfolio_limit, active_count}` для upsell-блока |
| GET/PATCH | `/clients/:id` | Карточка / правка (имя, архив, порядок) |
| GET/POST | `/clients/:id/tags` | Теги клиента; POST под гейтом `tag_limit` |
| DELETE | `/clients/:id/tags/:tagId` | Снять тег |
| GET | `/clients/:id/news` | Новости по тегам клиента |

### Саммари (`summaries.ts`)

| Метод | Путь | Пояснение |
|-------|------|-----------|
| GET | `/summaries` | Саммари клиентов по слотам расписания |
| POST | `/summaries/refresh` | Принудительный пересчёт `{client_id}` (LLM) |
| PATCH | `/summaries/schedule` | Слоты дайджеста `{slots: [час]}` — 1–2 значения |

Precompute: `runAdvisorPrecompute` (триггер `/trigger/advisor-precompute` + cron),
LLM-пул с concurrency ≤ 3. После пула — дайджест (`digest.ts`) и алерты (`alerts.ts`),
дополнительных LLM-вызовов нет:
- **Дайджест** (оба канала из `notify_prefs`): `advisor_digest` — сводка по клиентам
  (блоки «▸ Имя (N) [⚠️ негатив]», текст ≤ 600 симв.); `advisor_news` — топ-5 новостей
  за 12 ч по тегам всех активных клиентов. Пусто — не отправляется.
- **Алерты сентимента** (`alerts.ts`): пороги `neg ≥ 60%` / `pos ≥ 70%` при
  `≥ 5` статьях за 12 ч, cooldown 12 ч на (клиент, направление) через
  `last_alert_*_at`; флаги `advisor_alert_neg/pos` в `notify_prefs`.

### События и Telegram (`events.ts`, `telegramRoutes.ts`)

| Метод | Путь | Пояснение |
|-------|------|-----------|
| GET | `/events` | Лента событий по клиентам |
| POST | `/telegram/link` / `/telegram/unlink` | Привязка TG-чата адвайзера |
| GET | `/telegram/status` | Статус привязки |
| GET/PATCH | `/prefs` | Публичные настройки |
| GET/PUT | `/notify-prefs` | Каналы уведомлений (дайджест/алерты) |

### Задачи (`tasks.ts`, ТЗ-183 Задача 6)

| Метод | Путь | Пояснение |
|-------|------|-----------|
| GET | `/clients/:id/tasks`, `/tasks` | Список (фильтры по клиенту/статусу) |
| POST | `/clients/:id/tasks` | Создать `{title, due_date?, source_event_id?}` |
| PATCH | `/tasks/:id` | Правка / закрыть |
| PATCH | `/tasks/:id/reminder` | Напоминание `{remind_at, channels}` |
| GET | `/tasks/:id/ics` | Скачать `.ics` (календарь) |

Напоминания: cron `*/5 * * * *` (`startAdvisorTaskRemindersCron`), триггер
`/trigger/advisor-task-reminders`. Отправка по `remind_channels`.

### Заметки (`notes.ts`, ТЗ-193)

| Метод | Путь | Пояснение |
|-------|------|-----------|
| POST | `/clients/:id/notes` | Добавить (лимит 5 на клиента — 403 `note_limit_reached`) |
| PATCH | `/notes/:noteId` | Правка текста |
| DELETE | `/notes/:noteId` | Удалить |

## 3. Кроны

| Задача | Расписание | Модуль |
|--------|-----------|--------|
| Precompute саммари + дайджест + алерты | по слотам пользователя (1–2 в день) | `summaries.ts` |
| Напоминания по задачам | каждые 5 минут | `tasks.ts` |
| Еженедельный отчёт по клиентам | воскресенье 13:00 МСК | `weekly.ts` (ТЗ-183 Задача 9; зеркало ядерного weekly-отчёта) |

Все кроны через `CronLock` (`acquireCronLock/releaseCronLock`); LLM-ошибки по
клиенту пропускают блок без остановки крона (контроль стоимости).

## 4. Тесты и смоук

- `scripts/test_tz182.js` — клиенты/теги/лимиты/заметки (backend-пробы на SQLite);
- `scripts/test_tz183.js`, `scripts/test_tz193.js` — задачи/напоминания/.ics, заметки;
- frontend: страницы `AdviserPage` / `AdviserClientPage` (vitest).

## 5. Связанные документы

- [`../education.md`](../education.md) — автозапись на курсы (ТЗ-184) — отдельный контур,
  к Advisor не относится.
- [`TELEGRAM_NOTIFICATIONS.md`](../../TELEGRAM_NOTIFICATIONS.md) — TG-алерты **админам**
  (другой контур; Advisor шлёт через модульную обёртку `sendAdvisorTelegram` поверх
  того же бота ядра, `TELEGRAM_BOT_TOKEN`).
