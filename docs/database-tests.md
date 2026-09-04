# Тесты базы данных (pulse-backend)

Единый реестр verify-скриптов, проверяющих работу с БД. Основной контур — **PostgreSQL**
(прод на Render = PG 16, локальный стенд = Homebrew PostgreSQL 17). SQLite-режим
(`USE_SQLITE=true`) остаётся legacy fallback для быстрой итерации; новые задачи и
gate-прогоны перед деплоем выполняются на PG.

Все скрипты идемпотентны: каждый пересоздаёт схему своей тестовой БД с нуля
(`DROP SCHEMA public CASCADE` / эквивалент) и сам накатывает `src/models/schema.sql`.

## Тестовые базы

| БД | Используют | Примечание |
|----|-----------|------------|
| `pulse_dev_test`  | `scripts/lib/calendar-verify-env.js` — календарь М1–М7 + manual-upload | переопределяется через `DATABASE_URL_TEST` |
| `pulse_dev_test2` | `scripts/db-news-queries-verify.js` | переопределяется через `NEWS_QUERIES_VERIFY_DB` |
| `pulse_dev_test3` | `scripts/db-schema-parity-verify.js` | переопределяется через `SCHEMA_PARITY_DB` |

- Имя БД **обязано содержать `test`** — гвард безопасности: сьют падает до первого
  запроса, если URL вдруг указывает на dev/prod.
- Создание одноразовое: `createdb pulse_dev_test` (и `_test2`, `_test3`).
- Эти БД — расходники, в них можно не сохранять данные между прогонами.

## Реестр тестов

### 1. Календарь: М1–М7 + manual-upload

Проверяют ingest, адаптеры, дифф, админку мультиисточника, CRUD/tombstones,
матчинг к тегам, архив и ручной срез. Детали — в `docs/calendar.md`.

```bash
# вся цепочка
npm run verify:calendar          # SQLite
npm run verify:calendar:pg       # PostgreSQL — gate перед деплоем

# отдельный модуль
npm run verify:calendarM5        # SQLite
npm run verify:calendarM5:pg     # PostgreSQL
```

PG-режим включается переменной `CALENDAR_VERIFY_PG=1` (bootstrap в
`scripts/lib/calendar-verify-env.js`). **Перед каждым деплоем backend обязателен
прогон `npm run verify:calendar:pg`.**

Статус: на 2026-09-05 вся цепочка **M1–M7 + manual-upload зелёная в обоих
режимах** (SQLite и PG). Прод-багов в `src/*.ts` по итогам перевода не
потребовалось — продуктовый код уже dual-mode (`nowSql()`, массивы-параметры);
правки коснулись только самих verify-скриптов. Детали — `docs/calendar.md`
«Верификация в режиме PostgreSQL».

### 2. Schema parity — `verify:db:schema`

Файл: `scripts/db-schema-parity-verify.js`. БД: `pulse_dev_test3`.

Что проверяет:

- `src/models/schema.sql` применяется к чистой БД **дважды подряд без ошибок**
  (идемпотентность: вся DDL — `IF NOT EXISTS`, ловит дубли индексов/колонок);
- критичные таблицы созданы (чек-лист из 14 шт.: `users`, `news`,
  `user_defined_tags`, `calendar_events`, `push_subscriptions`,
  `subscription_plans` и др.);
- сид тарифов `subscription_plans` валиден (5 планов, free-тариф существует).

Это сторож против drift'а схемы: любая ручная правка DDL на проде или
забытая колонка в schema.sql делает тест красным. См. «Политика DDL».

```bash
npm run verify:db:schema
```

### 3. TZ parity — `verify:db:tz`

Файл: `scripts/db-tz-verify.js`.

Форкает сам себя в двух таймзонах (`TZ=UTC` и `TZ=Asia/Yekaterinburg`, UTC+5)
и сравнивает результат `normalizeDbDate()` (экспорт из `dist/services/calendar.js`).
Защищает от сдвига даты на −1 день в TZ восточнее UTC — баг, который жил в проде
(вечерние события отображались «вчера»). БД не требует.

```bash
npm run verify:db:tz
```

### 4. News queries PG-smoke — `verify:newsQueries`

Файл: `scripts/db-news-queries-verify.js`. БД: `pulse_dev_test2`.

17 проверок новостного контура **через реальные роуты** на живом сервере
(dist/index.js): лента, популярные теги, дайджест дня (`scale=day`),
`day_hours`, годовые карты (all/tag/portfolio), `freezeHeatmapRecentDays`,
глобальная сводка с мок-LLM (в т.ч. TZ-50 stale-fallback), резолвер названий
бумаг. Баги, пойманные этим стендом: `sqlDayHours` (42P18 — неверный номер
параметра `$2` вместо `$1`), `ensurePortfolioHistoryFresh` (42703 — `GROUP BY 1`
в PG-ветке), отсутствующий экспорт `findPositionCompanyName`.

```bash
npm run verify:newsQueries
```

## Политика DDL (обязательна перед любой схемной правкой)

1. **Любое изменение схемы — только через файлы в репо:**
   - `src/models/schema.sql` — bootstrap пустой БД (PG-only; SQLite-схема живёт
     отдельно в `src/models/db-sqlite.ts` и schema.sql не использует);
   - runtime-миграции — `runCalendarV2Migrations()` (`src/services/calendar.ts`)
     и идемпотентные `ALTER TABLE ... IF NOT EXISTS` в `src/index.ts`.
2. **Ручной DDL на проде запрещён.** Правка через Render psql/консоль не попадёт
   в репо → `verify:db:schema` красный при следующем пересоздании, а локальный
   стенд и прод разойдутся.
3. **Порядок при схемной правке:**
   1. правишь `schema.sql` (и/или миграцию);
   2. `npm run verify:db:schema` — зелёный;
   3. смоук-старт `node dist/index.js` → лог `[PostgreSQL] Schema initialized`;
   4. `npm run verify:calendar:pg` — регрессия зелёная;
   5. коммит.
4. **Запрещены точки с запятой внутри SQL-комментариев в schema.sql.**
   Bootstrap verify-стендов сплиттит файл по `;` до вырезания комментариев — `;`
   в комментарии режет statement посреди текста и PG-режим падает со
   `syntax error` у всех скриптов сразу (поймано 2026-09-05 на комментарии
   `cron_locks`). Комментарии пишем без `;`.
5. Перед деплоем: `verify:calendar:pg` + `verify:db:schema` зелёные.

## История находок (что поймали эти тесты)

| Дата | Тест | Находка |
|------|------|---------|
| 2026-09-04 | PG-стенд М7 | `llm`-колонки `news` отсутствовали в schema.sql; сверка runtime-колонок; порядок индексов |
| 2026-09-04 | PG-стенд М7 | `normalizeDbDate()` — локальные геттеры вместо UTC (TZ-сдвиг даты) |
| 2026-09-04 | PG-стенд М7 | `restoreCalendarEventGroup` — `CAST($2 AS TEXT)` (PG: 'could not determine data type' при null) |
| 2026-09-05 | Schema parity | `cron_locks` в schema.sql была SQLite-формы (`lock_key`); прод-код использует `job_name/locked_by/expires_at` |
| 2026-09-05 | Schema parity | `subscription_plans`: `price_monthly`/`price_yearly` NOT NULL отсутствовали в schema.sql (деплойная ошибка на Render) |
| 2026-09-05 | News queries | `heatmapDaily.sqlDayHours` — 42P18 (`$2` вместо `$1` в PG-SQL); роут `newsHeatmap.ts` передавал лишний параметр |
| 2026-09-05 | News queries | `ensurePortfolioHistoryFresh` — `GROUP BY 1` → 42703 в PG-ветке (ложилась каждая годовая карта портфеля) |
| 2026-09-05 | Calendar М1–М6 + manual | Скрипты использовали SQLite-паттерны (`admin1`, `datetime('now')`, `?`, `is_admin = 1`) — не работали в PG-режиме; продуктовый код пострадал только в одном месте — `;` в комментарии schema.sql ломала сплиттер bootstrap'а |
| 2026-09-05 | News queries (ТЗ-11.11fix14) | `getYearCells`: gap-fallback дочитывал только хвост `(frozenThrough; вчера]` — после первого freeze без backfill «голова» года пустовала в проде. Добавлен head-fill `[allDates[0]; firstFrozen-1]`; тест 17 изолирует инцидент (негативная проверка: без фикса ячейка пустая) |
