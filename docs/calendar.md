# Календарь инвестора

> Бэкенд блока «Календарь инвестора». Хранит снапшот корпоративных событий, отдаёт его клиентам, позволяет админу загружать новый снапшот.

---

## Обзор

- Двухслойная модель: `calendar_events_raw` (срезы по источникам) + `calendar_events` (canonical, дедуплицированная картина).
- Источники: `legacy`, `manual`, `investmint`, `smartlab`, `bcs` (заглушка), `global`.
- Приоритет источников: `manual > investmint > smartlab > bcs > global > legacy`.
- Загрузка провайдерского среза: `POST /api/admin/calendar/:source` с `?dry_run=1`.
- CRUD событий в админке пишет в `calendar_events_raw` с `source = 'manual'` и пересобирает canonical.
- Удалённые/изменённые события оставляют tombstone-строки в `calendar_events_raw` (`ticker = '__deleted__'` + `tombstone_key` + `original_title`), чтобы provider-срезы не воскрешали их.
- Чтение публичное: `GET /api/calendar` отдаёт `calendar_events`.
- После успешной загрузки бэкенд рассылает `event: calendar:refresh` по SSE.
- Telegram-алерты о протухании — per-provider, cooldown 24 ч через `calendar_sources.last_stale_alert_at`.
- Сырые данные провайдеров проходят через `src/services/calendarAdapters/` (M2).

---

## Endpoints

### Публичный endpoint

#### `GET /api/calendar`

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
| `generated_at` | ISO string \| null | Время последней загрузки любого провайдерского среза (`MAX(uploaded_at)` из `calendar_sources`). |
| `stale` | boolean | `true`, если последняя дата в БД меньше `server_date - 2`. |
| `days` | array | Список дней с группами событий. |

**Response 503** — снапшот ещё не загружен:

```json
{ "error": "calendar_not_loaded" }
```

---

### `POST /api/admin/calendar/:source`

Загрузка сырого среза провайдера (M3). `:source` — `auto` или один из зарегистрированных адаптеров (`investmint`, `smartlab`). Query `?dry_run=1` выполняет конвейер без записи в БД.

**Request body** — сырое JSON провайдера.

**Response 200**:

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
    "new": ["2026-08-29|SBER|МСФО", "..."],
    "removed": [],
    "upgraded": []
  },
  "generated_at": "2026-08-29T10:00:00.000Z"
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

### `GET /api/admin/calendar/sources`

Возвращает массив источников в порядке `PROVIDER_PRIORITY`.

**Response 200**:

```json
[
  { "source": "manual", "uploaded_at": "...", "events_count": 0, "last_stale_alert_at": null, "stale": false },
  { "source": "investmint", "uploaded_at": "...", "events_count": 120, "last_stale_alert_at": null, "stale": false }
]
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
| `limit` | number | Размер страницы (по умолчанию `50`). |
| `offset` | number | Смещение (по умолчанию `0`). |

**Response 200**:

```json
{
  "events": [
    {
      "date": "2026-08-29",
      "weekday": "сб",
      "title": "Годовой отчёт",
      "kind": "МСФО",
      "status": "confirmed",
      "companies": [],
      "companies_count": 1
    }
  ],
  "total": 1
}
```

> Поле `companies` в списке пустое намеренно, чтобы не раздувать payload. Полный состав группы запрашивается отдельным `GET /api/admin/calendar/events/:date/:title/:kind`.

---

### `GET /api/admin/calendar/events/:date/:title/:kind`

Только для администраторов. Возвращает одну группу событий вместе со списком компаний.

**Response 200**:

```json
{
  "event": {
    "date": "2026-08-29",
    "weekday": "сб",
    "title": "Годовой отчёт",
    "kind": "МСФО",
    "status": "confirmed",
    "companies": [
      { "name": "Сбербанк", "ticker": "SBER" }
    ],
    "companies_count": 1
  }
}
```

**Response 404** — группа не найдена.

---

### `POST /api/admin/calendar/events`

Только для администраторов. Создаёт новую группу событий.

**Request body** (`CalendarAdminEvent`):

```json
{
  "date": "2026-08-29",
  "weekday": "сб",
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

**Response 400** — ошибка валидации (все те же правила, что и для снапшота).

**Response 409** — группа с такой парой `date + title + kind` уже существует (`Event group already exists`).

---

### `PUT /api/admin/calendar/events/:date/:title/:kind`

Только для администраторов. Полностью заменяет существующую группу. Параметры пути — старый ключ группы; тело — новое состояние (при этом `date`/`title`/`kind` в теле могут отличаться, т.е. можно перенести событие на другую дату или сменить тип).

**Request body** — то же, что и для `POST`.

**Response 200**:

```json
{ "success": true }
```

**Response 404** — исходная группа не найдена.

---

### `DELETE /api/admin/calendar/events/:date/:title/:kind`

Только для администраторов. Удаляет группу событий целиком.

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
      "date": "2026-08-29",
      "weekday": "сб",
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

> При выключении Layer 1 (keyword) продолжает работать. Следующий rebuild при включении автоматически догонит ранее unmatched-события через LLM.

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

### `calendar_settings`

Runtime-настройки календаря. Пока одна: `llm_enabled`.

| Поле | Тип | Описание |
|------|-----|----------|
| `key` | TEXT PRIMARY KEY | Ключ настройки. |
| `value` | TEXT | `'true'` / `'false'`. |

---

## Сервис `services/calendar.ts`

### `validateCalendarDays(days): CalendarDay[]`

Проверяет снапшот по правилам выше. Бросает `Error` с понятным сообщением.

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
2. `buildCanonicalRowsWithStats` — чистая функция.
3. `matchCalendarTags` — async, может дергать LLM (или нет, см. `getCalendarLlmEnabled`).
4. Короткая транзакция: `DELETE FROM calendar_events` + `INSERT` канонических строк.

Используется CRUD, legacy-очисткой и бут-миграцией. Благодаря этому LLM не держит открытую транзакцию.

### `getCalendarLlmEnabled(): Promise<boolean>`

Читает рубильник `llm_enabled` из `calendar_settings`.

- Дефолт `true` (если таблица/ключ отсутствуют).
- Env `CALENDAR_TAGS_LLM=off` — жёсткий аварийный override, возвращает `false` вне зависимости от БД.
- Влияет только на календарный `matchCalendarTags`; новостной пайплайн не трогается.

### `saveCalendarSnapshot(days): { daysCount, eventsCount }`

**Legacy-обёртка** для обратной совместимости (M1). Теперь работает через raw-модель:

1. Валидирует вход.
2. Раскладывает дни в плоские raw-строки с `source = 'legacy'`.
3. В транзакции `DELETE FROM calendar_events_raw WHERE source = 'legacy'` и `INSERT` новых строк.
4. После коммита `rewriteCanonicalFromRaw()`.
5. `broadcastCalendarRefresh()`.

### `mergeCalendarSnapshot(days): { daysCount, eventsCount, addedDays, addedEvents }`

**Legacy-обёртка** (M1). Добавляет только отсутствующие `legacy`-строки, затем `rewriteCanonicalFromRaw()`.

### `listCalendarEventGroups(filters): { events, total }`

Возвращает страницу групп событий. Поддерживает фильтры:

- `search` — ищет по `title` и по компаниям внутри группы;
- `kind` — точное совпадение;
- `status` — точное совпадение;
- `limit`/`offset` — пагинация.

Сортировка: `date DESC, title ASC`. В списке `companies` всегда пустой, `companies_count` — количество строк в группе.

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

Чистая функция, строит канонический срез из сырых строк без обращения к БД. Используется в `rebuildCanonical` и в `dry_run`.

### `validateProviderSlice(source, events, serverDate): { reject?, warnings }`

Sanity-проверки перед записью среза:

- 0 событий → reject;
- уникальных дат < 5 → reject;
- `max_date < server_date - 2` → warning;
- событий без тикера > 20% → warning.

### `ingestProviderSlice(source, flatRows, dryRun): { canonical, generatedAt }`

Заменяет срез провайдера и пересобирает канон.

- Работает под in-memory single-flight (promise-цепочка), параллельные загрузки сериализуются.
- В обычном режиме: транзакция `DELETE raw → INSERT flatRows → UPSERT calendar_sources → rebuildCanonical`.
- В `dry_run`: без транзакции и записи, симуляция в памяти через `buildCanonicalRows`.

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
  detect(raw: unknown): number   // 0..1
  parse(raw: unknown): { events: NormalizedEvent[]; warnings: ParseWarnings }
}
```

**Файлы:**

| Файл | Назначение |
|------|-----------|
| `types.ts` | `CalendarAdapter`, `NormalizedEvent`, `ParseWarnings` |
| `classify.ts` | Единые `detectKind` / `detectStatus` для бэка и фронта |
| `dateUtils.ts` | `pad`, `inferYear`, `inferYearWithWeekday`, `getWeekday`, `toDateString` |
| `investmint.ts` | Адаптер для `investmint_calendar.json` (date + events[]) |
| `smartlab.ts` | Адаптер для smartlab-массива `{ date, title }` |
| `bcs.ts` | Заглушка под будущий BCS-источник |
| `index.ts` | Registry, `detectAdapter()`, `toRawRows()` |

**`detectAdapter(raw)`** выбирает адаптер с максимальным `score >= 0.5`. Если два лидера отличаются менее чем на `0.001`, файл считается неоднозначным и отклоняется.

**`toRawRows(events, source)`** разворачивает `NormalizedEvent[]` в плоские строки `calendar_events_raw`: одна строка на одну компанию, тикер uppercase.

**Определение года (investmint).** Investmint не передаёт год (`"30 июля чт"`). `inferYearWithWeekday(day, month, fileWd)` выбирает между текущим и следующим годом по совпадению дня недели из файла, чтобы прошедшие месяцы текущего года не улетали в следующий.

**Фрагменты investmint.** Провайдер дублирует события фрагментами (только title, только компания и т.п.). Если нераспознанная строка является подстрокой уже распознанного события того же дня — она игнорируется молча, не засчитываясь в `warnings.skipped`.

**Верификация:

```bash
npm run verify:calendarAdapters
```

Скрипт `scripts/calendar-m2-verify.js` проверяет detect, parse, shape и parity с замороженными фронтовыми парсерами.

---

## Матчинг событий к тегам (M6)

Файл: `src/services/calendar.ts` + `src/services/smartTagMatcher.ts`.

Каждая каноническая строка `calendar_events` теперь хранит привязанные теги:

| Поле | Тип | Описание |
|------|-----|----------|
| `tag_ids` | `TEXT` (JSON `string[]`) | Список `tag_id` из `user_defined_tags`. |
| `matched_via` | `TEXT` | `'keyword'`, `'llm'` или `NULL` (не сматчилось). |

**Конвейер:**

1. `buildCanonicalRows(rawRows)` — чистая функция, строит канон (как раньше, без тегов).
2. `matchCalendarTags(canonical)` — async, вызывается **до** записи в транзакцию:
   - текст для матчинга = `${title} ${company} ${ticker}`;
   - сначала `smartMatchTagsWithVia(...)` keyword-слой (`Layer 1`);
   - если keyword не дал тегов — LLM-фолбэк (`Layer 2`) с кэшем `smart_tag_cache`;
   - повторные одинаковые тексты дедуплицируются внутри пересборки.
3. `writeCanonicalRows(q, rows)` — DELETE/INSERT `calendar_events` уже с `tag_ids`/`matched_via`.

**Ingest:**

- Боевой путь: читает raw, симулирует срез, `buildCanonicalRows` → `matchCalendarTags` вне tx → одна tx: замена raw-среза + `writeCanonicalRows`. Окна «канон без тегов» нет.
- `dry_run` матчинг **не** вызывает — не тратит LLM-токены.

**CRUD редактора (M5):** `create`/`update`/`delete`/`restore` пишут правки в `calendar_events_raw` внутри короткой транзакции, а матчинг и запись канона выполняют через `rewriteCanonicalFromRaw()` уже после коммита. LLM не держит транзакцию.

**Admin API:**

- `GET /api/admin/calendar/events` — в группе добавляется `tag_ids` (объединение тегов всех строк группы).
- `GET /api/admin/calendar/events/:date/:title/:kind` — в `companies[]` добавляется `tag_ids` и `matched_via`; в группе — `tag_ids`.
- Публичный `GET /api/calendar` **не изменился**.

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
> Фронтендная эвристика (`CalendarTab.tsx` → `inferYear`) решает, относить дату к текущему или следующему году, по правилу: месяц < текущего → следующий год. Это работает для "future-looking" снапшотов, но может ошибаться на исторических или нестандартных файлах.
>
> **Рекомендуемое улучшение:**
> 1. Поддержать год явно в строке даты (`"1 января 2027 пн"`), с fallback на эвристику.
> 2. Добавить в админ-форму поле "Год снапшота", которое передаётся на бэкенд вместе с `days`.

---

## Связанные файлы

| Файл | Назначение |
|------|-----------|
| `src/routes/calendar.ts` | Публичный роут `GET /api/calendar`. |
| `src/routes/admin.ts` | Админские роуты календаря: загрузка снапшота и CRUD событий. |
| `src/services/calendar.ts` | Вся бизнес-логика календаря. |
| `src/services/sse.ts` | `broadcastCalendarRefresh()`. |
| `src/services/calendarAdapters/` | Адаптеры провайдеров (M2). |
| `src/models/schema.sql` | SQL-схема таблиц. |
| `src/index.ts` | Boot-миграции, mount роута `/api/calendar`. |
| `scripts/calendar-m2-verify.js` | Verify-скрипт для адаптеров. |
| `scripts/calendar-m3-verify.js` | Verify-скрипт для Ingest API и диффа. |
| `scripts/calendar-m6-verify.js` | Verify-скрипт для матчинга событий к тегам. |
| `tests/calendarAdapters/` | Fixtures и reference-парсеры для verify. |
| `docs/ingest.md` | Документация endpoint'а загрузки срезов. |
