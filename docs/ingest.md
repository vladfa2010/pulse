# Ingest API провайдерских срезов

> M3/M4 календаря. Единая точка загрузки сырых файлов провайдеров, их парсинга, замены среза, пересборки канона и получения дифф-сводки.

---

## Endpoint

### `POST /api/admin/calendar/:source`

Требует авторизации администратора.

- `:source` — `auto` или имя адаптера (`investmint`, `smartlab`).
  Заглушки (`bcs`, `global`) и устаревший legacy-загрузчик не допускаются — вернёт 400.
- Query: `?dry_run=1` — пробный прогон без записи в БД.
- Body: сырое JSON провайдера (Content-Type: `application/json`).

> Старый `POST /api/admin/calendar` (загрузка `days[]` целиком) удалён в М5.
> Все провайдерские срезы загружаются через `POST /api/admin/calendar/:source`.

#### Пример

```bash
# Автодетект формата
curl -X POST "https://api.example.com/api/admin/calendar/auto" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d @investmint.json

# Явный источник + dry_run
curl -X POST "https://api.example.com/api/admin/calendar/investmint?dry_run=1" \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d @investmint.json
```

---

## Response 200

### Live (без `dry_run`) — быстрый ответ

Канон пересобирается в фоне (`scheduleCanonicalRewrite` с коалесцингом), LLM-матчинг
не блокирует ответ. Тело — только parse-статистика:

```json
{
  "parsed": {
    "days": 5,
    "events": 12,
    "no_ticker": 0,
    "skipped": 0,
    "date_from": "2026-09-05",
    "date_to": "2026-09-12",
    "warnings": []
  },
  "queued": true
}
```

Полей `diff`, `samples`, `generated_at` в live-ответе нет.

### dry_run (`?dry_run=1`) — полное превью

```json
{
  "parsed": {
    "days": 5,
    "events": 12,
    "no_ticker": 0,
    "skipped": 0,
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
    "new": ["2026-08-29|SBER|МСФО"],
    "removed": [],
    "upgraded": []
  },
  "generated_at": "2026-08-29T10:00:00.000Z"
}
```

| Поле | Описание |
|------|----------|
| `parsed.days` | Количество уникальных дат в распознанных событиях. |
| `parsed.events` | Количество распознанных событий. |
| `parsed.no_ticker` | Количество событий без тикера (из `ParseWarnings.noTicker`). |
| `parsed.skipped` | Количество пропущенных строк (из `ParseWarnings.skipped`). |
| `parsed.warnings` | Массив warning'ов адаптера и sanity-проверок. |
| `queued` | Только live-ответ: канон пересобирается в фоне. |
| `diff.new_events` | Новые ключи в каноне (только dry_run). |
| `diff.updated_events` | Ключ сохранился, изменился `title` или `company` (только dry_run). |
| `diff.confirmed_upgrades` | `expected → confirmed` (только dry_run). |
| `diff.confirmations` | `sources` вырос без появления нового ключа (склейка провайдеров; только dry_run). |
| `diff.removed_events` | Ключ полностью ушёл из канона (только dry_run). |
| `samples` | До 20 ключей на категорию для превью (только dry_run). |
| `generated_at` | `MAX(uploaded_at)` из `calendar_sources` (только dry_run). |

---

## Response 400

**Неоднозначный формат:**

```json
{
  "error": "формат неоднозначен, укажите :source",
  "candidates": ["investmint", "smartlab"]
}
```

**Формат не распознан:**

```json
{ "error": "формат не распознан" }
```

**Неизвестный источник:**

```json
{ "error": "неизвестный источник: bcs" }
```

**Источник пока не поддерживается (stub-адаптер):**

```json
{ "error": "источник пока не поддерживается" }
```

**Отклонённые sanity-проверки:**

```json
{ "error": "слишком короткий срез", "warnings": [] }
```

```json
{ "error": "формат не распознан", "warnings": [] }
```

**Причины reject:**

- 0 событий после парсинга;
- уникальных дат < 5.

**Warnings:**

- все даты в прошлом (`max_date < server_date - 2`);
- событий без тикера > 20%.

---

## Поведение live (без dry_run)

- Транзакция: date-scoped `DELETE` raw-среза → `INSERT` новых строк → `UPSERT calendar_sources` (в т.ч. `last_warnings`).
- После commit — `scheduleCanonicalRewrite()`: LLM-матчинг, пересборка канона, SSE-broadcast и инвалидация кэша — всё в фоне с коалесцингом (одна пересборка идёт, максимум одна в очереди).
- Ответ уходит сразу после транзакции: `{ parsed, queued: true }`.
- Замороженные строки (`date < server_date − 14`) не удаляются; входящие архивные строки дедуплицируются по ключу `(source, date, title, kind, ticker)`.

## Поведение dry_run

- Транзакция не открывается, таблицы не изменяются.
- Текущий raw читается из БД, срез `:source` заменяется в памяти (включая замороженные строки текущего источника).
- `buildCanonicalRows` строит новый канон на симулированном наборе.
- `computeDiff` возвращает счётчики и samples — это наполнение превью-модалки админки.
- LLM-матчинг **не** вызывается (экономия токенов).

---

## Sources endpoint

### `GET /api/admin/calendar/sources`

Требует авторизации администратора. Возвращает массив источников в порядке `manual > investmint > smartlab > bcs > global > legacy`.

```bash
curl "https://api.example.com/api/admin/calendar/sources" \
  -H "Authorization: Bearer <admin-token>"
```

**Response 200**:

```json
[
  {
    "source": "investmint",
    "uploaded_at": "2026-08-29T09:15:00.000Z",
    "events_count": 120,
    "days": 91,
    "last_stale_alert_at": null,
    "last_warnings": [],
    "stale": false,
    "feed": true,
    "adapter_ready": true
  }
]
```

- `feed: true` для источников с файлом: `investmint`, `smartlab`, `bcs`, `global`.
- `adapter_ready: true` только если адаптер существует и не является stub.
- `days` — COUNT(DISTINCT date) в raw-срезе источника.
- `last_warnings` — предупреждения последней загрузки.

Незагружавшиеся источники возвращаются с `uploaded_at: null`, `events_count: 0`, `days: 0`, `stale: false`.

---

## Внутренний конвейер

1. `req.body` передаётся в `detectAdapter(raw)` если `:source = auto`.
2. Адаптер парсит файл → `NormalizedEvent[]` + warnings.
3. `validateProviderSlice` проверяет reject/warnings.
4. `toRawRows` превращает события в `CalendarRawRow[]`.
5. `ingestProviderSlice` выполняется под in-memory single-flight:
   - live: транзакция (date-scoped DELETE + INSERT + UPSERT sources) → `scheduleCanonicalRewrite()` в фоне → возврат `{queued: true}`;
   - dry_run: симуляция канона на замороженных строках + новом срезе → `computeDiff` → возврат полного контракта без записи в БД.
6. Фоновая пересборка (`rewriteCanonicalFromRaw` + `matchCalendarTags` + `writeCanonicalRows` в транзакции) сама делает `broadcastCalendarRefresh()` + `invalidateCalendarCache()` после успешной записи канона.

---

## Схема raw-таблицы

`calendar_events_raw` хранит плоские строки, по одной на компанию в событии:

```text
source, date, weekday, title, kind, status, company, ticker, uploaded_at
```

Дополнительные поля, используемые ручным CRUD и tombstone-механизмом (М5):

- `tombstone_key TEXT` — канонический ключ `date|ticker` или `date|n:<company>`,
  который tombstone-строка подавляет. Позволяет стабильно матчить tombstone
  независимо от будущих изменений в fallback-логике.
- `original_title TEXT` — оригинальный `title` удалённого события. Сохраняется
  для отображения в списке tombstones и для дизамбигуации restore, когда
  несколько tombstone делят один `tombstone_key`.

Tombstone-строки — это строки с `source = 'manual'` и `ticker = '__deleted__'`.
Они не отображаются в публичном календаре, но подавляют canonical-события
с совпадающим `tombstone_key` при пересборке канона.
