# Календарь инвестора

> Бэкенд блока «Календарь инвестора». Хранит снапшот корпоративных событий, отдаёт его клиентам, позволяет админу загружать новый снапшот.

---

## Обзор

- Данные хранятся **плоско** в `calendar_events` и **мета-снапшот** в `calendar_meta`.
- Загрузка только через админку: `POST /api/admin/calendar`.
- Чтение публичное: `GET /api/calendar`.
- После успешной загрузки бэкенд рассылает `event: calendar:refresh` по SSE.
- Если данные устарели, раз в сутки админам отправляется Telegram-алерт.

---

## Endpoints

### `GET /api/calendar`

Публичный. Возвращает сгруппированный снапшот за окно: `server_date - 2` … `server_date + 120` дней.

**Response 200** (`CalendarResponse`):

```json
{
  "server_date": "2026-08-29",
  "generated_at": "2026-08-29T09:15:00.000Z",
  "stale": false,
  "days": [
    {
      "date": "2026-08-29",
      "weekday": "сб",
      "groups": [
        {
          "title": "Годовой отчёт",
          "kind": "МСФО",
          "status": "confirmed",
          "companies": [
            { "name": "Сбербанк", "ticker": "SBER" }
          ]
        }
      ]
    }
  ]
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `server_date` | `YYYY-MM-DD` | Текущая дата по Europe/Moscow. |
| `generated_at` | ISO string | Время последней загрузки снапшота. |
| `stale` | boolean | `true`, если последняя дата в БД меньше `server_date - 2`. |
| `days` | array | Список дней с группами событий. |

**Response 503** — снапшот ещё не загружен:

```json
{ "error": "calendar_not_loaded" }
```

---

### `POST /api/admin/calendar`

Только для администраторов (`adminMiddleware`). Тело — снапшот дней.

**Request body**:

```json
{
  "days": [
    {
      "date": "2026-08-29",
      "weekday": "сб",
      "groups": [
        {
          "title": "Годовой отчёт",
          "kind": "МСФО",
          "status": "confirmed",
          "companies": [
            { "name": "Сбербанк", "ticker": "SBER" }
          ]
        }
      ]
    }
  ]
}
```

**Response 200**:

```json
{
  "success": true,
  "days_count": 1,
  "events_count": 1
}
```

**Response 400** — ошибка валидации:

```json
{ "error": "<описание ошибки>" }
```

#### Правила валидации (`services/calendar.ts`)

- `days` — непустой массив.
- Каждый день:
  - `date` — `YYYY-MM-DD`;
  - `weekday` — непустая строка (`'пн'`..`'вс'`);
  - `groups` — непустой массив.
- Даты не должны повторяться.
- Внутри дня группы не должны дублироваться по паре `title + kind`.
- `kind` ∈ `['МСФО', 'РСБУ', 'СД', 'СА', 'Дивиденды', 'Другое']`.
- `status` ∈ `['confirmed', 'expected']`.
- Каждая группа содержит непустой массив `companies`.
- Внутри группы тикеры не должны повторяться (сравнение `toUpperCase()`).
- У компании обязательны `name` и `ticker`.

---

## Схема данных

### `calendar_events`

Плоское хранилище всех событий.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | UUID / TEXT PK | Авто-ID. |
| `date` | DATE NOT NULL | Дата события. |
| `weekday` | VARCHAR(2) NOT NULL | День недели. |
| `title` | TEXT NOT NULL | Название события. |
| `kind` | VARCHAR(10) NOT NULL | Тип события. |
| `status` | VARCHAR(10) NOT NULL | `confirmed` / `expected`. |
| `company` | VARCHAR(100) NOT NULL | Название компании. |
| `ticker` | VARCHAR(10) NOT NULL | Тикер. |
| `uploaded_at` | TIMESTAMP | Время загрузки снапшота. |
| | UNIQUE(date, title, ticker) | Защита от дубликатов одной компании в одном событии. |

Индекс: `idx_calendar_events_date` по полю `date`.

### `calendar_meta`

Одна строка с метаданными снапшота.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | INTEGER PK CHECK(id = 1) | Только одна строка. |
| `uploaded_at` | TIMESTAMP | Время последней успешной загрузки. |
| `last_stale_alert_at` | TIMESTAMP | Время последнего Telegram-алерта об устаревании. |

---

## Сервис `services/calendar.ts`

### `validateCalendarDays(days): CalendarDay[]`

Проверяет снапшот по правилам выше. Бросает `Error` с понятным сообщением.

### `getCalendarData(): CalendarResponse`

1. Получает `server_date` по Europe/Moscow.
2. Читает `generated_at` из `calendar_meta`.
3. Запрашивает строки за окно `server_date - 2` … `server_date + 120`.
4. Группирует строки в `CalendarDay[]`:
   - дни отсортированы по дате;
   - группы внутри дня отсортированы по `title` (`localeCompare('ru')`);
   - компании сохраняют порядок из снапшота.
5. Вычисляет `stale`:
   ```ts
   stale = days.length === 0 || days[days.length - 1].date < serverDate - 2 days
   ```
6. Если `stale === true`, запускает `maybeSendStaleAlert()` (fire-and-forget).

### `saveCalendarSnapshot(days): { daysCount, eventsCount }`

1. Валидирует вход.
2. Раскладывает дни в плоские строки.
3. Выполняет транзакцию:
   - `DELETE FROM calendar_events`;
   - `INSERT` каждой строки;
   - `UPSERT` в `calendar_meta` (`id = 1`).
4. Транзакция реализована через `pool.connect()` для PostgreSQL и через обычный `query('BEGIN'/'COMMIT'/'ROLLBACK')` для SQLite.
5. После коммита вызывает `broadcastCalendarRefresh()`.

### `maybeSendStaleAlert()`

Условия отправки алерта:

1. `calendar_meta` существует.
2. `MAX(date)` в `calendar_events` строго меньше `server_date - 2` (данные действительно устарели).
3. С последнего алерта прошло больше 24 часов.
4. Есть активные админы с `tg_chat_id` в `admin_tg_settings`.

Сообщение в Telegram:

```
⚠️ Календарь инвестора устарел
Последние данные: <maxDate>
Серверная дата: <serverDate>
Загрузите новый снапшот через админку.
```

После успешной отправки обновляет `last_stale_alert_at`.

---

## SSE

Файл: `services/sse.ts`.

### `broadcastCalendarRefresh()`

Отправляет всем SSE-подписчикам событие:

```
event: calendar:refresh
data: {}

```

Фронтенд в `useSseNews` ловит его и инвалидирует `queryKey: ['calendar']`.

---

## Миграции

Создание таблиц есть в двух местах:

1. **`src/models/schema.sql`** — для чистых установок.
2. **`src/index.ts`** — boot-миграции, метка `TZ_CALENDAR`.

Boot-миграция использует `USE_SQLITE` для выбора между `UUID DEFAULT uuid_generate_v4()` (Postgres) и `TEXT DEFAULT lower(hex(randomblob(16)))` (SQLite), а также `NOW()` vs `datetime('now')`.

---

## Дата по Москве

`services/calendar.ts` → `getMskDateString()`:

- Запрашивает серверное время через `SELECT ${nowSql()} as now`.
- Прибавляет `+3 часа` к UTC-времени.
- Возвращает строку `YYYY-MM-DD`.

> Для PostgreSQL и SQLite используется один и тот же подход: серверное время в JS, потом сдвиг на MSK. Это избегает различий в timezone-функциях СУБД.

---

## Связанные файлы

| Файл | Назначение |
|------|-----------|
| `src/routes/calendar.ts` | Публичный роут `GET /api/calendar`. |
| `src/routes/admin.ts` | Админский роут `POST /api/admin/calendar`. |
| `src/services/calendar.ts` | Вся бизнес-логика календаря. |
| `src/services/sse.ts` | `broadcastCalendarRefresh()`. |
| `src/models/schema.sql` | SQL-схема таблиц. |
| `src/index.ts` | Boot-миграции, mount роута `/api/calendar`. |
