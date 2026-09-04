# Календарь инвестора

> Бэкенд блока «Календарь инвестора». Хранит корпоративные события, отдаёт клиентам сгруппированный снапшот, позволяет админам загружать срезы провайдеров и редактировать события вручную.

---

## Обзор

### Двухслойная модель данных

| Слой | Таблица | Назначение |
|------|---------|------------|
| Raw | `calendar_events_raw` | Сырые срезы по источникам (`investmint`, `smartlab`, `manual`, `legacy`, …) + tombstone-строки. |
| Canonical | `calendar_events` | Дедуплицированная, приоритизированная картина, которую видят пользователи. |

### Источники и приоритет

Приоритет источников (от высшего к низшему):

```
manual > investmint > smartlab > bcs > global > legacy
```

- `manual` — ручные правки админа через CRUD.
- `investmint`, `smartlab` — провайдерские фиды, загружаемые JSON-файлами.
- `bcs`, `global` — зарезервированные слоты под будущие провайдеры (заглушки).
- `legacy` — данные, перенесённые из старой однослойной схемы (бывшие `saveCalendarSnapshot` / `mergeCalendarSnapshot`, удалены в пользу ingest-путей).

### Жизненный цикл события

1. Админ загружает сырой JSON через `POST /api/admin/calendar/:source`.
2. Бэкенд выбирает адаптер (`auto` или явный `:source`), парсит файл в `NormalizedEvent[]`.
3. `toRawRows()` разворачивает события в плоские строки `calendar_events_raw` (одна строка на компанию).
4. `buildCanonicalRows()` строит канонический срез с учётом приоритетов и tombstone.
5. `matchCalendarTags()` сопоставляет каждую строку с тегами (keyword + LLM-фолбэк).
6. В короткой транзакции заменяется срез провайдера и перезаписывается `calendar_events`.
7. Бэкенд шлёт `event: calendar:refresh` по SSE.

### Ключевые свойства

- **CRUD вне транзакции LLM**: редактор пишет правки в `calendar_events_raw` внутри короткой транзакции, а матчинг тегов и пересборка канона выполняются уже после коммита (`rewriteCanonicalFromRaw`). LLM не держит открытую транзакцию.
- **Single-flight для загрузок**: параллельные `POST /api/admin/calendar/:source` сериализуются через `ingestFlight`, чтобы не гонялись за одним источником.
- **Tombstone-строки**: удалённые/изменённые вручную события оставляют suppressor-записи в `calendar_events_raw`, чтобы провайдерские срезы не воскрешали старые данные.
- **Per-provider stale alerts**: Telegram-уведомления об устаревании фида отправляются раз в сутки для каждого провайдера отдельно.
- **Рубильник LLM-матчинга**: `calendar_settings.llm_enabled` позволяет админу отключать LLM-фолбэк при сопоставлении тегов.
- **Grace-окно и архив**: сырые срезы провайдеров заменяются только внутри «живого» окна `server_date − 14` дней. Строки старше окна сохраняются (архив) и дедуплицируются по ключу `(source, date, title, kind, ticker)` — повторные загрузки не создают дубликатов в архиве. Админка может просматривать архив отдельно через `GET /api/admin/calendar/history`.

---

## Endpoints

### Публичный endpoint

#### `GET /api/calendar`

Публичный. Возвращает сгруппированный снапшот за окно: `server_date - 2` … `server_date + 120` дней.

**Response 200** (`CalendarResponse`):

```json
{
  "server_date": "2026-08-30",
  "generated_at": "2026-08-30T09:15:00.000Z",
  "stale": false,
  "days": [
    {
      "date": "2026-08-30",
      "weekday": "вс",
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
| `generated_at` | ISO string \| null | `MAX(uploaded_at)` из `calendar_sources` (null, если источников ещё нет). |
| `stale` | boolean | `true`, если последняя дата в каноне меньше `server_date - 2`. |
| `days` | array | Дни с группами событий, отсортированные по дате. |

**Response 503** — снапшот ещё не загружен:

```json
{ "error": "calendar_not_loaded" }
```

---

### `POST /api/admin/calendar/:source`

Загрузка сырого среза провайдера (M3). `:source` — `auto` или один из зарегистрированных адаптеров (`investmint`, `smartlab`).

Query-параметры:

| Параметр | Описание |
|----------|----------|
| `dry_run=1` | Не пишет в БД, возвращает полный контракт: `parsed`, `diff`, `samples`, `generated_at`. |

**Request body** — сырое JSON провайдера.

**Live-ответ 200** (без `dry_run`) — быстрый: канон пересобирается в фоне
(`scheduleCanonicalRewrite` с коалесцингом, SSE-broadcast и инвалидация кэша
внутри пересборки), LLM-матчинг не блокирует ответ:

```json
{
  "parsed": {
    "days": 5,
    "events": 12,
    "no_ticker": 1,
    "skipped": 0,
    "date_from": "2026-09-05",
    "date_to": "2026-09-12",
    "warnings": []
  },
  "queued": true
}
```

Полей `diff`, `samples`, `generated_at` в live-ответе нет — diff для админки
считается только в `dry_run`-превью.

**Response 200 dry_run**:

```json
{
  "parsed": {
    "days": 5,
    "events": 12,
    "warnings": []
  },
  "diff": {
    "new_events": 10,
    "updated_events": 0,
    "confirmed_upgrades": 0,
    "confirmations": 2,
    "removed_events": 0
  },
  "samples": {
    "new": ["2026-08-30|SBER|МСФО", "..."],
    "removed": [],
    "upgraded": []
  },
  "generated_at": "2026-08-30T10:00:00.000Z"
}
```

**Response 400**:

```json
{ "error": "формат не распознан" }
```

```json
{ "error": "формат неоднозначен, укажите :source", "candidates": ["investmint", "smartlab"] }
```

```json
{ "error": "слишком короткий срез", "warnings": [] }
```

---

### `GET /api/admin/calendar/sources`

Возвращает массив источников в порядке `PROVIDER_PRIORITY`.

**Response 200**:

```json
[
  { "source": "manual", "uploaded_at": "...", "events_count": 0, "last_stale_alert_at": null, "stale": false },
  { "source": "investmint", "uploaded_at": "...", "events_count": 120, "last_stale_alert_at": null, "stale": false }
]
```

Поля:

- `events_count` — число строк в `calendar_events_raw` для этого источника.
- `days_count` — число уникальных дат у источника.
- `max_date` — максимальная дата события источника.
- `stale` — `true`, если `max_date < server_date - 2`.
- `last_warnings` — JSON-массив варнингов последней загрузки (или `null`).

---

### `DELETE /api/admin/calendar/sources/:source`

Удаляет весь raw-срез провайдера (`DELETE FROM calendar_events_raw WHERE source = $source` + запись из `calendar_sources`) в транзакции и сразу отвечает. Канон пересобирается в фоне (`scheduleCanonicalRewrite`, SSE-broadcast — внутри пересборки). Поддерживается только `legacy`; остальные источники перезаписываются через POST ingest.

**Response 200**:

```json
{ "success": true }
```

---

### `GET /api/admin/calendar/events`

Только для администраторов. Возвращает список групп событий с пагинацией и фильтрами.

**Query-параметры:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `search` | string | Поиск по `title`, `company` или `ticker` (case-insensitive). |
| `kind` | string | Точное совпадение по `kind`. |
| `status` | string | Точное совпадение по `status`. |
| `date_from` | string | Нижняя граница даты (YYYY-MM-DD). |
| `date_to` | string | Верхняя граница даты (YYYY-MM-DD). |
| `past` | `true` | Показать события из архива (`date < server_date − 14`). При `past=true` сортировка `date ASC`, иначе `date DESC`. |
| `tombstones` | `true` | Показать удалённые (tombstone) события вместо живых. |
| `limit` | number | Размер страницы (по умолчанию `50`). |
| `offset` | number | Смещение (по умолчанию `0`). |

По умолчанию (без `past` и без явных `date_from`/`date_to`) возвращаются только события из «живого» окна: `date >= server_date − 14`.


**Response 200**:

```json
{
  "events": [
    {
      "date": "2026-08-30",
      "weekday": "вс",
      "title": "Годовой отчёт",
      "kind": "МСФО",
      "status": "confirmed",
      "companies": [
        { "name": "Сбербанк", "ticker": "SBER", "sources": ["investmint"], "tag_ids": ["sber"] }
      ],
      "companies_count": 1,
      "sources": ["investmint"],
      "tag_ids": ["sber"],
      "possible_duplicate": false
    }
  ],
  "total": 1
}
```

> Поле `companies` заполнено для каждой группы: админская таблица отображает список компаний прямо в строке. Полный состав с `matched_via` для каждой компании по-прежнему доступен через `GET /api/admin/calendar/events/:date/:title/:kind`.

---

### `GET /api/admin/calendar/history`

Только для администраторов. Возвращает архивные события — канонические строки с `date < server_date − 14` (вне «живого» окна). Используется для просмотра прошедших/замороженных событий без смешивания с активным календарём.

**Query-параметры:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `ticker` | string | Фильтр по тикеру (case-insensitive, LIKE). |
| `from` | string | Нижняя граница даты (YYYY-MM-DD). |
| `to` | string | Верхняя граница даты (YYYY-MM-DD). |
| `search` | string | Поиск по `title`, `company` или `ticker`. |
| `limit` | number | Размер страницы (по умолчанию `50`). |
| `offset` | number | Смещение (по умолчанию `0`). |

**Response 200**:

```json
{
  "events": [
    {
      "date": "2026-07-30",
      "weekday": "чт",
      "title": "МСФО 2КВ2026",
      "kind": "МСФО",
      "status": "confirmed",
      "companies": [
        { "name": "Сбербанк", "ticker": "SBER", "sources": ["investmint"], "tag_ids": ["sber"] }
      ],
      "companies_count": 1,
      "sources": ["investmint"],
      "tag_ids": ["sber"],
      "possible_duplicate": false
    }
  ],
  "total": 1
}
```

Сортировка: `date DESC, title ASC`.

---

### `GET /api/admin/calendar/events/:date/:title/:kind`

Только для администраторов. Возвращает одну группу событий вместе со списком компаний.

**Response 200**:

```json
{
  "event": {
    "date": "2026-08-30",
    "weekday": "вс",
    "title": "Годовой отчёт",
    "kind": "МСФО",
    "status": "confirmed",
    "companies": [
      { "name": "Сбербанк", "ticker": "SBER", "tag_ids": ["sber"], "matched_via": "keyword" }
    ],
    "companies_count": 1,
    "sources": ["investmint"],
    "tag_ids": ["sber"],
    "possible_duplicate": false
  }
}
```

**Response 404** — группа не найдена.

---

### `POST /api/admin/calendar/events`

Только для администраторов. Создаёт новую группу событий в `source = 'manual'`.

**Request body** (`CalendarAdminEvent`):

```json
{
  "date": "2026-08-30",
  "weekday": "вс",
  "title": "Годовой отчёт",
  "kind": "МСФО",
  "status": "confirmed",
  "companies": [
    { "name": "Сбербанк", "ticker": "SBER" }
  ]
}
```

**Response 200**:

```json
{ "success": true }
```

**Response 400** — ошибка валидации.

**Response 409** — группа с такой парой `date + title + kind` уже существует (`Event group already exists`).

---

### `PUT /api/admin/calendar/events/:date/:title/:kind`

Только для администраторов. Полностью заменяет существующую группу. Параметры пути — старый ключ группы; тело — новое состояние (можно сменить дату, заголовок или тип).

**Request body** — то же, что и для `POST`.

**Response 200**:

```json
{ "success": true }
```

**Response 404** — исходная группа не найдена.

---

### `DELETE /api/admin/calendar/events/:date/:title/:kind`

Только для администраторов. Удаляет группу событий целиком, оставляя tombstone-строки.

**Response 200**:

```json
{ "success": true }
```

**Response 404** — группа не найдена.

---

### `GET /api/admin/calendar/events?tombstones=true`

Только для администраторов. Возвращает удалённые (tombstone) события, которые можно восстановить.

**Response 200**:

```json
{
  "events": [
    {
      "date": "2026-08-30",
      "weekday": "вс",
      "title": "Отчёт Лукойла",
      "kind": "МСФО",
      "status": "expected",
      "companies": [{ "name": "Лукойл", "ticker": "__deleted__" }],
      "companies_count": 1,
      "sources": ["manual"],
      "original_title": "Отчёт Лукойла",
      "deleted_ticker": "LKOH"
    }
  ]
}
```

| Поле | Описание |
|------|----------|
| `title` | Оригинальный title события (`original_title`). |
| `original_title` | Дубль `title` для однозначности. |
| `deleted_ticker` | Тикер, по которому строится `tombstone_key` (пустая строка для UNKNOWN-тикера). |
| `kind` | Оригинальный `kind` удалённого события. |

### `DELETE /api/admin/calendar/events/tombstone`

Восстанавливает удалённое событие, снимая tombstone.

**Query**:

- `date` — дата события.
- `title` — для известного тикера это `deleted_ticker`; для UNKNOWN-тикера фронт может прислать пустую строку или название компании (restore попробует оба варианта).
- `company` — название компании.
- `original_title` (опционально) — дизамбигуатор, если несколько tombstone делят один `tombstone_key`.

**Response 200**:

```json
{ "success": true }
```

---

### `GET /api/admin/calendar/settings`

Только для администраторов. Возвращает состояние рубильника LLM-матчинга тегов.

**Response 200**:

```json
{ "llm_enabled": true }
```

### `PUT /api/admin/calendar/settings`

Только для администраторов. Включает или выключает LLM-матчинг тегов для календаря.

**Request body**:

```json
{ "llm_enabled": false }
```

**Response 200**:

```json
{ "llm_enabled": false }
```

**Response 400**:

```json
{ "error": "llm_enabled must be a boolean" }
```

> При выключении keyword-слой (Layer 1) продолжает работать. Следующий rebuild при включении автоматически догонит ранее unmatched-события через LLM.

---

## Схема данных

### `calendar_events`

Каноническое хранилище всех событий.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | UUID PK | Авто-ID. |
| `date` | DATE NOT NULL | Дата события. |
| `weekday` | VARCHAR(2) NOT NULL | День недели. |
| `title` | TEXT NOT NULL | Название события. |
| `kind` | VARCHAR(10) NOT NULL | `МСФО` \| `РСБУ` \| `СД` \| `СА` \| `Дивиденды` \| `Другое`. |
| `status` | VARCHAR(10) NOT NULL | `confirmed` \| `expected`. |
| `company` | VARCHAR(100) NOT NULL | Название компании. |
| `ticker` | VARCHAR(10) NOT NULL | Тикер. |
| `uploaded_at` | TIMESTAMP | Время загрузки/пересборки. |
| `sources` | TEXT (JSON `string[]`) | Источники, подтвердившие это событие. |
| `possible_duplicate` | BOOLEAN | `true`, если несколько источников дали одинаковый ключ с разными деталями. |
| `tag_ids` | TEXT (JSON `string[]`) | Привязанные теги (М6). |
| `matched_via` | TEXT | `keyword` \| `llm` \| `NULL`. |

Индекс: `idx_calendar_events_date` по полю `date`.
UNIQUE: `(date, title, kind, ticker)`.

### `calendar_events_raw`

Сырые срезы провайдеров и ручные правки.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | UUID PK | Авто-ID. |
| `source` | VARCHAR(20) NOT NULL | `manual` \| `investmint` \| `smartlab` \| `legacy` \| `bcs` \| `global`. |
| `date` | DATE NOT NULL | Дата события. |
| `weekday` | VARCHAR(2) NOT NULL | День недели (значение парсера). |
| `title` | TEXT NOT NULL | Название события. |
| `kind` | VARCHAR(10) NOT NULL | Тип события. |
| `status` | VARCHAR(10) NOT NULL | `confirmed` \| `expected`. |
| `company` | VARCHAR(100) NOT NULL | Название компании. |
| `ticker` | VARCHAR(10) NOT NULL | Тикер; может быть `UNKNOWN`. |
| `uploaded_at` | TIMESTAMP | Время загрузки/правки. |
| `tombstone_key` | TEXT | Ключ подавления для tombstone-строк. |
| `original_title` | TEXT | Оригинальный title события в tombstone. |

Индексы: `idx_cal_raw_source`, `idx_cal_raw_key(date, ticker)`.

### `calendar_sources`

Per-source метаданные.

| Поле | Тип | Описание |
|------|-----|----------|
| `source` | VARCHAR(20) PK | Источник. |
| `uploaded_at` | TIMESTAMP | Время последней успешной загрузки/изменения. |
| `last_stale_alert_at` | TIMESTAMP | Время последнего Telegram-алерта об устаревании. |
| `last_warnings` | TEXT | JSON-массив варнингов последней загрузки. |

### `calendar_settings`

Runtime-настройки календаря.

| Поле | Тип | Описание |
|------|-----|----------|
| `key` | TEXT PK | Ключ настройки. |
| `value` | TEXT | `'true'` \| `'false'` для `llm_enabled`. |

### `calendar_meta`

Одна строка с метаданными снапшота. **Legacy/не используется** после перехода на `calendar_sources`, но остаётся для обратной совместимости и boot-миграции.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | INTEGER PK CHECK(id = 1) | Только одна строка. |
| `uploaded_at` | TIMESTAMP | Время последней успешной загрузки (legacy). |
| `last_stale_alert_at` | TIMESTAMP | Время последнего Telegram-алерта (legacy). |

---

## Сервис `services/calendar.ts`

### `getCalendarData(): CalendarResponse`

1. Получает `server_date` по Europe/Moscow.
2. Читает `generated_at` как `MAX(uploaded_at)` из `calendar_sources` (null, если источников ещё нет).
3. Запрашивает строки за окно `server_date - 2` … `server_date + 120`.
4. Группирует строки в `CalendarDay[]`:
   - дни отсортированы по дате;
   - группы внутри дня отсортированы по `title` (`localeCompare('ru')`);
   - компании сохраняют порядок из снапшота.
5. Вычисляет `stale`:
   ```ts
   stale = days.length === 0 || days[days.length - 1].date < serverDate - 2 days
   ```
6. Если `stale === true`, запускает `maybeSendProviderStaleAlerts()` (fire-and-forget).

### `rewriteCanonicalFromRaw(): RebuildCanonicalResult`

Пересобирает канонический срез из `calendar_events_raw` **вне транзакции**:

1. Читает все raw-строки.
2. `buildCanonicalRowsWithStats` — чистая функция, строит канон + считает `possible_duplicate`.
3. `matchCalendarTags` — async, может дергать LLM (или нет, см. `getCalendarLlmEnabled`).
4. Короткая транзакция: `DELETE FROM calendar_events` + `INSERT` канонических строк.

Используется CRUD, legacy-очисткой и бут-миграцией. Благодаря этому LLM не держит открытую транзакцию.

**Backward-совместимый alias:** `rebuildCanonical()` просто делегирует `rewriteCanonicalFromRaw()`.

### `getCalendarLlmEnabled(): Promise<boolean>`

Читает рубильник `llm_enabled` из `calendar_settings`.

- Дефолт `true` (если таблица/ключ отсутствуют).
- Env `CALENDAR_TAGS_LLM=off` — жёсткий аварийный override, возвращает `false` вне зависимости от БД.
- Влияет только на календарный `matchCalendarTags`; новостной пайплайн не трогается.

### `listCalendarEventGroups(filters): { events, total }`

Возвращает страницу групп событий. Поддерживает фильтры:

- `search` — ищет по `title` и по компаниям внутри группы;
- `kind` — точное совпадение;
- `status` — точное совпадение;
- `possible_duplicate` — только группы с флагом дубля;
- `tombstones` — только удалённые события;
- `limit`/`offset` — пагинация.

Сортировка: `date DESC, title ASC`. В списке `companies` всегда пустой, `companies_count` — количество строк в группе.

### `listCalendarHistory(filters): { events, total }`

Возвращает страницу архивных групп событий (`date < server_date − 14`). Поддерживает фильтры:

- `ticker` — поиск по тикеру (ILIKE);
- `from` / `to` — диапазон дат;
- `search` — поиск по `title` и компаниям внутри группы;
- `limit` / `offset` — пагинация.

Сортировка: `date DESC, title ASC`.

### `getCalendarEventGroup(date, title, kind): CalendarAdminEvent | null`

Возвращает одну группу со списком компаний, отсортированным по тикеру. Если группа не найдена — `null`.

### `createCalendarEventGroup(event)`

Создаёт новую группу:

1. Валидирует тело через `validateCalendarAdminEvent()`.
2. В транзакции проверяет, что группа `(date, title, kind)` ещё не существует, и вставляет одну raw-строку на каждую компанию (`source = 'manual'`).
3. Если группа уже есть — бросает `CalendarAdminError('Event group already exists', 409)`.
4. После коммита `rewriteCanonicalFromRaw()` с LLM-матчингом вне транзакции.
5. Рассылает `calendar:refresh` по SSE.

### `updateCalendarEventGroup(oldDate, oldTitle, oldKind, event)`

Полностью заменяет группу:

1. Валидирует тело.
2. В транзакции удаляет старые manual-строки, добавляет tombstone-строки для исчезнувших ключей и вставляет новые manual-строки.
3. После коммита `rewriteCanonicalFromRaw()`.
4. Рассылает `calendar:refresh` по SSE.

### `deleteCalendarEventGroup(date, title, kind)`

Удаляет группу:

1. В транзакции вставляет tombstone-строки (`ticker = '__deleted__'`) для всех компаний группы.
2. После коммита `rewriteCanonicalFromRaw()`.
3. Рассылает `calendar:refresh` по SSE.

### `buildCanonicalRows(rawRows): CanonicalRow[]`

Чистая функция, строит канонический срез из сырых строк без обращения к БД. Используется в `rewriteCanonicalFromRaw` и в `dry_run`.

### `buildCanonicalRowsWithStats(rawRows): { canonical, duplicateCount }`

То же, что и `buildCanonicalRows`, но дополнительно считает `possible_duplicate` — группы, где несколько источников дали одинаковый ключ, но различаются в `title`/`company`/`status`.

### `validateProviderSlice(source, events, serverDate): { reject?, warnings }`

Sanity-проверки перед записью среза:

- 0 событий → reject;
- уникальных дат < 5 → reject;
- `max_date < server_date - 2` → warning;
- событий без тикера > 20% → warning.

### `ingestProviderSlice(source, flatRows, dryRun, warnings): IngestResult`

Заменяет срез провайдера внутри «живого» окна; канон пересобирается в фоне.

- Работает под in-memory single-flight (promise-цепочка `ingestFlight`), параллельные загрузки сериализуются (для строк внутри «живого» окна).
- **Live (dryRun=false)**:
  - **Короткая транзакция**: `DELETE raw WHERE source = $source AND date >= server_date − 14` → `INSERT flatRows` (замороженные строки `date < server_date − 14` не удаляются; входящие архивные строки дедуплицируются по ключу `(source, date, title, kind, ticker)`) → `UPSERT calendar_sources` (в т.ч. `last_warnings`).
  - После commit — `scheduleCanonicalRewrite()`: LLM-матчинг, пересборка канона, SSE-broadcast и инвалидация кэша уходят в фон, ответ не блокируется.
  - Возвращает `{ canonical: [], generatedAt: null, diff: EMPTY_DIFF, queued: true }` — дискриминатор `queued` используется роутом для выбора короткого контракта ответа.
- **dry_run**: без транзакции и записи. Симулирует канон (`buildCanonicalRows` на симуляции с замороженными строками), считает `computeDiff`, матчинг тегов **не** вызывается (экономия токенов). Возвращает полный `{ canonical, generatedAt, diff }`.

### `uploadManualSlice(items, dryRun): ManualUploadResult`

Свободная загрузка событий в ручной срез (роут `POST /api/admin/calendar/manual/upload`,
объявлен ДО `/calendar/:source`). **Merge-only**: только добавляет, ничего не
удаляет, лимит дат фидов не действует. Свободный формат item'ов: `date` + `title`
(с опциональным префиксом `ТИКЕР:`), опционально `ticker`/`company`/`kind`/`status`.

- Парсинг item'ов: `parseTickerTitle` (общий хелпер из smartlab-адаптера),
  `detectKind`/`detectStatus` из classify, fallback company → ticker → title.
- Дедуп по ВСЕМ manual-строкам (включая архивные) по `(date, title, kind, ticker)`
  + дубли внутри файла → `duplicates`.
- Томбстоун на merge-ключ (`makeCanonicalKey`) → tombstone удаляется, событие
  «воскресает» → `resurrected` (live-строка, пережившая delete, не дублируется).
- Одна tx: tombstone-DELETE + INSERT + `touchCalendarSource('manual')`; после
  commit — `scheduleCanonicalRewrite()`.
- Ответ: `{ total, added, duplicates, resurrected, invalid: [{index, reason}], dry_run }`.
  Ошибки по элементам не фатальны. Пустое/не-массив тело → 400.



### `writeCanonicalRows(q, rows)`

Внутри транзакции полностью перезаписывает `calendar_events`: `DELETE` + `INSERT` строк с `tag_ids`/`matched_via`.

### `computeDiff(snapshot, newCanonical): DiffResult`

Сравнивает текущий канон (Map ключ → строки) с новым. Возвращает счётчики:

- `new_events` — новые ключи в каноне;
- `updated_events` — ключ сохранился, изменился `title` или `company`;
- `confirmed_upgrades` — `expected → confirmed`;
- `confirmations` — `sources` вырос без появления нового ключа;
- `removed_events` — ключ полностью ушёл из канона.

`samples` содержит до 20 ключей на категорию.

### `getCanonicalSnapshot(): Map<string, CanonicalRow[]>`

Читает `calendar_events` и группирует по ключу диффа.

### `maybeSendProviderStaleAlerts()`

Глобальный `maybeSendStaleAlert` заменён на per-provider алерты.

Условия отправки алерта:

1. Провайдер — один из feed-источников: `investmint`, `smartlab`, `bcs`, `global`.
2. У провайдера есть запись в `calendar_sources`.
3. `MAX(date)` по `calendar_events_raw WHERE source = <provider>` строго меньше `server_date - 2`.
4. С последнего алерта этого провайдера прошло больше 24 часов (кулдаун через `calendar_sources.last_stale_alert_at`).
5. Есть активные админы с `tg_chat_id` в `admin_tg_settings`.

`manual` и `legacy` не проверяются.

Сообщение в Telegram:

```
Провайдер <source> протух: покрытие до <maxDate> (серверная дата <serverDate>)
```

После успешной отправки обновляет `calendar_sources.last_stale_alert_at`.

---

## Адаптеры провайдеров (`src/services/calendarAdapters/`)

Модуль изолирует знание о форматах внешних провайдеров. Каждый провайдер реализует интерфейс `CalendarAdapter`:

```typescript
export interface CalendarAdapter {
  source: string
  stub?: boolean
  detect(raw: unknown): number   // 0..1
  parse(raw: unknown): { events: NormalizedEvent[]; warnings: ParseWarnings }
}
```

**Файлы:**

| Файл | Назначение |
|------|-----------|
| `types.ts` | `CalendarAdapter`, `NormalizedEvent`, `ParseWarnings`, `NormalizedCompany` |
| `classify.ts` | Единые `detectKind` / `detectStatus` для бэка и фронта |
| `dateUtils.ts` | `pad`, `inferYear`, `inferYearWithWeekday`, `getWeekday`, `toDateString` |
| `investmint.ts` | Адаптер для `investmint_calendar.json` (date + events[]) |
| `smartlab.ts` | Адаптер для smartlab-массива `{ date, title }` |
| `bcs.ts` | Заглушка под будущий BCS-источник |
| `global.ts` | Заглушка под будущий global-источник |
| `index.ts` | Реестр, `detectAdapter()`, `toRawRows()` |

**`detectAdapter(raw)`** выбирает адаптер с максимальным `score >= 0.5`. Если два лидера отличаются менее чем на `0.001`, файл считается неоднозначным и отклоняется.

**`toRawRows(events, source)`** разворачивает `NormalizedEvent[]` в плоские строки `calendar_events_raw`: одна строка на одну компанию, тикер uppercase.

**Определение года (investmint).** Investmint не передаёт год (`"30 июля чт"`). `inferYearWithWeekday(day, month, fileWd)` выбирает между текущим и следующим годом по совпадению дня недели из файла, чтобы прошедшие месяцы текущего года не улетали в следующий.

**Фрагменты investmint.** Провайдер дублирует события фрагментами (только title, только компания и т.п.). Если нераспознанная строка является подстрокой уже распознанного события того же дня — она игнорируется молча, не засчитываясь в `warnings.skipped`.

**Верификация:**

```bash
npm run verify:calendarAdapters
```

Скрипт `scripts/calendar-m2-verify.js` проверяет detect, parse, shape и parity с замороженными фронтовыми парсерами.

---

## Архив событий (M7)

Файл: `src/services/calendar.ts` + `src/routes/admin.ts`.

### Grace-окно

`ARCHIVE_GRACE_DAYS = 14`. Все события с `date >= server_date − 14` считаются «живыми» и заменяются при загрузке провайдера. События старше границы попадают в архив и не удаляются при обычном инжесте.

### Дедупликация архивных строк

При загрузке провайдерского среза для каждой архивной строки вычисляется ключ `(source, date, title, kind, ticker)`. Если строка с таким ключом уже есть в `calendar_events_raw` — она пропускается, в `warnings` добавляется запись `пропущено замороженных дубликатов: N`.

### Endpoint `GET /api/admin/calendar/history`

Возвращает канонические группы с `date < server_date − 14`. Поддерживает фильтры по тикеру, дате и поиску. Сортировка `date DESC`.

### Endpoint `GET /api/admin/calendar/events` — архивный режим

Query-параметр `past=true` переключает выдачу на архив (`date < server_date − 14`) и меняет сортировку на `date ASC`. Параметры `date_from`/`date_to` позволяют задать произвольный диапазон без привязки к grace-окну.

### Симуляция канона в ingest (фикс М7-Б.1)

`ingestProviderSlice` симулирует канон до записи. После перехода на date-scoped DELETE фильтр симуляции обязан включать **замороженные строки текущего источника** (`r.source !== source || r.date < windowStart`) — иначе архив выпадал из канона при каждом инжесте («мигание»: фоновая `rewriteCanonicalFromRaw` возвращала архив, следующий ingest снова его терял). Без фикса dry_run-превью показывало ложные `removed_events` по архиву.

### Verify M7

`scripts/calendar-m7-verify.js` (6 тестов, все через HTTP-роуты):

1. Накопление архива: второй ingest без архивной даты не теряет её из raw и канала
2. Корректировка в grace: событие `server_date − 1` перезаписывается replace-режимом (статус обновляется)
3. Годовой файл дважды: raw count стабилен, warning `пропущено замороженных дубликатов: N`
4. Томбстоун на архивном: delete/restore через CRUD работают, ingest не воскрешает удалённое
5. Публичное окно: архив не отдаётся в `GET /api/calendar` (−2…+120), отдаётся в `GET /api/admin/calendar/history`
6. dry_run: превью без ложных `removed_events` по архиву, таблицы не изменяются

Запуск: `npm run verify:calendarM7` (SQLite) / `npm run verify:calendarM7:pg` (PostgreSQL).

## Верификация в режиме PostgreSQL

Календарь активно использует диалектно-зависимые конструкции (`text[]`, `NOW()`, транзакции, DDL-ограничения). SQLite-режим остаётся для быстрой локальной итерации, но **перед каждым деплоем backend обязателен прогон в PG-режиме**.

### Локальный Postgres

Стенд — Homebrew PostgreSQL 17 (см. DEPLOYMENT.md «Локальный dev-стенд: PostgreSQL»), тестовая БД создаётся одноразово:

```bash
createdb pulse_dev_test
```

Дальше `DATABASE_URL_TEST` не нужен: по умолчанию bootstrap использует
`postgres://$USER@localhost:5432/pulse_dev_test` (переопределяется через `DATABASE_URL_TEST`).

### Запуск

```bash
# один модуль
npm run verify:calendarM5:pg

# вся цепочка M1–M7
npm run verify:calendar:pg
```

### Как это работает

- `CALENDAR_VERIFY_PG=1` активирует bootstrap `scripts/lib/calendar-verify-env.js`.
- Bootstrap подключается к `DATABASE_URL_TEST`, **предварительно дропая и пересоздавая схему `public`**.
- Гвард безопасности: если `DATABASE_URL_TEST` не содержит `test` в имени БД — сьют падает до первого запроса.
- Применяется `src/models/schema.sql` + `uuid-ossp`/`pgcrypto`, затем `runCalendarV2Migrations()`.

### Fallout PG-режима (статус на 2026-09-05)

**Исправлено в М7** (регрессия зелёная в обоих режимах, SQLite + PG):
- ✅ Тестовый администратор — фиксированный UUID вместо строки `admin1`.
- ✅ `is_admin` — `TRUE` вместо `1` (строгий boolean PG).
- ✅ DATE-ассерты — нормализация через `toDateStr()` (PG возвращает Date, SQLite — строку).

**Исправлено в прод-коде по находкам PG-стенда:**
- ✅ `normalizeDbDate()` — локальные геттеры вместо UTC (сдвиг даты на −1 день в TZ восточнее UTC).
- ✅ `restoreCalendarEventGroup` — `CAST($2 AS TEXT)` (PG: 'could not determine data type' при null).
- ✅ `schema.sql` — llm-колонки news + сверка runtime-колонок + порядок индексов.

**Осталось (чинить по мере прогонов М1–М6):**
- Скрипты М1–М6 могут содержать те же SQLite-паттерны (`admin1`, `datetime('now')`, строковые id) — в PG-режиме потребуют таких же мелких правок, как М7.

---

## Матчинг событий к тегам (M6)

Файл: `src/services/calendar.ts` + `src/services/smartTagMatcher.ts`.

Каждая каноническая строка `calendar_events` теперь хранит привязанные теги:

| Поле | Тип | Описание |
|------|-----|----------|
| `tag_ids` | TEXT (JSON `string[]`) | Список `tag_id` из `user_defined_tags`. |
| `matched_via` | TEXT | `keyword`, `llm` или `NULL` (не сматчилось). |

**Конвейер:**

1. `buildCanonicalRows(rawRows)` / `buildCanonicalRowsWithStats(rawRows)` — чистая функция, строит канон (без тегов).
2. `matchCalendarTags(canonical)` — async, вызывается **до** записи в транзакцию:
   - текст для матчинга = `title + company + ticker`;
   - сначала `smartMatchTagsWithVia(...)` keyword-слой (`Layer 1`);
   - если keyword не дал тегов — LLM-фолбэк (`Layer 2`) с кэшем `smart_tag_cache`;
   - LLM-фолбэк управляется `getCalendarLlmEnabled()` (рубильник + env `CALENDAR_TAGS_LLM`);
   - повторные одинаковые тексты дедуплицируются внутри пересборки.
3. `writeCanonicalRows(q, rows)` — DELETE/INSERT `calendar_events` уже с `tag_ids`/`matched_via`.

**Ingest:**

- Боевой путь: читает raw, симулирует срез, `buildCanonicalRows` → `matchCalendarTags` вне tx → одна tx: замена raw-среза + `writeCanonicalRows`. Окна «канон без тегов» нет.
- `dry_run` матчинг **не** вызывает — не тратит LLM-токены.

**CRUD редактора (M5):** `create`/`update`/`delete`/`restore` пишут правки в `calendar_events_raw` внутри короткой транзакции, а матчинг и запись канона выполняют через `rewriteCanonicalFromRaw()` уже после коммита. LLM не держит транзакцию.

**Admin API:**

- `GET /api/admin/calendar/events` — в группе добавляется `tag_ids` (объединение тегов всех строк группы).
- `GET /api/admin/calendar/events/:date/:title/:kind` — в `companies[]` добавляется `tag_ids` и `matched_via`; в группе — `tag_ids`.
- Публичный `GET /api/calendar` **не изменился** (теги не отдаются в публичном API).

**Верификация:**

```bash
npm run verify:calendarM6
```

Скрипт `scripts/calendar-m6-verify.js` проверяет:

- событие «Заседание ЦБ РФ» → тег `цб`, `matched_via = 'keyword'`;
- событие Лукойла → тег `lkoh`, `matched_via = 'llm'`;
- повторная пересборка не дергает LLM (кэш);
- `dry_run` не дергает LLM;
- tombstone-события не матчатся;
- admin GET отдаёт `tag_ids`/`matched_via`;
- после боевого ingest нет строк с `matched_via IS NULL`;
- регрессии M1–M5 зелёные.

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

Boot-миграция также:

- переносит старые `calendar_events` в `calendar_events_raw` с `source = 'legacy'` (`migrateExistingCalendarToRaw`);
- добавляет отсутствующие колонки (`sources`, `possible_duplicate`, `tag_ids`, `matched_via`, `last_warnings`);
- обновляет UNIQUE-констрейнт на `(date, title, kind, ticker)`.

---

## Дата по Москве

`services/calendar.ts` → `getMskDateString()`:

- Запрашивает серверное время через `SELECT ${nowSql()} as now`.
- Прибавляет `+3 часа` к UTC-времени.
- Возвращает строку `YYYY-MM-DD`.

> Для PostgreSQL и SQLite используется один и тот же подход: серверное время в JS, потом сдвиг на MSK. Это избегает различий в timezone-функциях СУБД.

---

## TODO / Известные ограничения

> **Год в raw-формате `investmint_calendar.json` не передаётся.**
> `inferYearWithWeekday` выбирает год по совпадению дня недели, но если в файле weekday отсутствует или некорректен, используется эвристика «месяц < текущего → следующий год». Это работает для "future-looking" снапшотов, но может ошибаться на исторических или нестандартных файлах.
>
> **Рекомендуемое улучшение:**
> 1. Поддержать год явно в строке даты (`"1 января 2027 пн"`), с fallback на эвристику.
> 2. Добавить в админ-форму поле "Год снапшота", которое передаётся на бэкенд вместе с `days`.

---

## Связанные файлы

| Файл | Назначение |
|------|-----------|
| `src/routes/calendar.ts` | Публичный роут `GET /api/calendar`. |
| `src/routes/admin.ts` | Админские роуты календаря: загрузка срезов, CRUD событий, настройки. |
| `src/services/calendar.ts` | Вся бизнес-логика календаря. |
| `src/services/sse.ts` | `broadcastCalendarRefresh()`. |
| `src/services/calendarAdapters/` | Адаптеры провайдеров (M2). |
| `src/services/smartTagMatcher.ts` | Keyword + LLM матчинг тегов. |
| `src/models/schema.sql` | SQL-схема таблиц. |
| `src/index.ts` | Boot-миграции, mount роута `/api/calendar`. |
| `scripts/calendar-m2-verify.js` | Verify-скрипт для адаптеров. |
| `scripts/calendar-m3-verify.js` | Verify-скрипт для Ingest API и диффа. |
| `scripts/calendar-m5-verify.js` | Verify-скрипт для CRUD и tombstones. |
| `scripts/calendar-m6-verify.js` | Verify-скрипт для матчинга событий к тегам. |
| `tests/calendarAdapters/` | Fixtures и reference-парсеры для verify. |
| `docs/ingest.md` | Документация endpoint'а загрузки срезов. |
