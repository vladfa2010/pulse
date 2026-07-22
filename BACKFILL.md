# PULSE — Tag Backfill (Retro Scan)

> Ретро-сканирование существующих новостей по keywords тега.  
> Статус: актуально для коммитов `cfcd1c4` (backend) / `3f91b30` (frontend).  
> Файлы: `pulse-backend/src/services/tagBackfill.ts`, `pulse-backend/src/index.ts`, `pulse-frontend/src/pages/admin/TagsTab.tsx`, `pulse-frontend/src/pages/admin/TagDetailModal.tsx`.

---

## 1. Зачем нужен backfill

При ingest новая статья матчится только по актуальным `keywords` тегов. Если тег появился или его keywords изменились, в базе уже могут быть статьи, в которых он упоминается. Backfill решает эту задачу: привязывает старые статьи к новому/изменённому тегу.

Раньше backfill запускался внутри `NewsSourceManager.run()` каждые 5 минут по всем USA-тикерам. Это блокировало ingestion на 40–90 секунд и работал вхолостую, потому что новые статьи уже матчатся при ingest. Текущая реализация — событийная, а не по расписанию.

---

## 2. Когда запускается

### Автоматические триггеры

| Событие | Место | Почему |
|---------|-------|--------|
| Авто-обогащение тега | `backgroundEnrichTag` | После LLM-обогащения keywords обновляются → нужно привязать старые статьи. |
| Ручное обогащение | `POST /admin/tags/:tagId/enrich` | Админ запускает обогащение → сразу после сохранения keywords. |
| Inline-редактирование | `PUT /admin/tags/:tagId` | Если изменилась колонка `keywords` (вручную или через пересборку из enriched-полей). |

### Ручные триггеры

| Endpoint | Назначение |
|----------|------------|
| `POST /admin/tags/:tagId/backfill-matches` | Dry-run или apply для одного тега. |
| `POST /admin/backfill-matches-all` | One-shot скан всех тегов в фоне. |

Важно: HTTP-ответы не блокируются. Apply-запуски и массовый скан работают fire-and-forget.

---

## 3. Архитектура

```
┌─────────────────────────────────────┐
│  user_defined_tags                  │
│  ├── keywords (колонка)             │
│  └── enriched_data (JSONB)          │
│       ├── ticker, synonyms, ...     │
│       └── _backfill (marker)        │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│  services/tagBackfill.ts            │
│  ├── buildScanKeywords()            │
│  ├── countTagMatches()  (dry-run)   │
│  └── backfillTagMatches() (apply)   │
│       ├── semaphore ≤ 2           │
│       ├── chunks by id            │
│       └── marker _backfill        │
└─────────────┬───────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│  news.matched_tags                  │
│  тег добавляется только если его      │
│  ещё нет в массиве                  │
└─────────────────────────────────────┘
```

### Матч-поверхность — keywords-first

Колонка `keywords` — это **скомпилированная** матч-поверхность. В нормальном состоянии она включает имя тега, транслит, падежные суффиксы, синонимы, продукты и тикер. Ingest-матчер читает только `keywords`. Ретро-скан делает то же самое — поэтому `keywords-first` даёт паритет между потоком и ретро.

**Ручная правка keywords — это форк.** Если админ удалил слово из `keywords`, ретро-скан его не сканирует, и поток тоже. Если добавил — оба сканируют. Fallback на `enriched_data` срабатывает только когда `keywords` пустые (legacy или ещё не обогащённый тег).

---

## 4. Алгоритм

### 4.1 Построение keywords

```ts
async function buildScanKeywords(tag): Promise<string[]>
```

1. Берём `tag.keywords` (колонка), нормализуем: `toLowerCase().trim()`, фильтруем `length >= 2`.
2. Если получился непустой список — используем его.
3. Если `keywords` пустые — динамически импортируем `buildEnrichedKeywords` из `tagManager` и компилируем keywords из `enriched_data`.

Тикер **не добавляется принудительно**. Он уже есть в `keywords` после обогащения, а принудительное добавление ломало ручные правки, когда админ удалял тикер из keywords.

### 4.2 Поиск статей

**PostgreSQL:**

```sql
WHERE (matched_tags IS NULL OR NOT ($tag_id = ANY(matched_tags)))
  AND (COALESCE(title_original, title_ru, '') || ' ' || COALESCE(summary_original, summary_ru, '')) ~* $pattern
```

- `$pattern` = `\m(tok1|tok2|…|tokN)\M` — точные границы слова (паритет с `matchTagsByKeywords`).
- `matched_tags IS NULL` обязательно: иначе статьи с `NULL` в `matched_tags` отфильтровываются (`NOT NULL` = `NULL`).

**SQLite:**

```sql
WHERE (
  matched_tags IS NULL
  OR matched_tags = '[]'
  OR matched_tags NOT LIKE '%"tag_id"%'
)
AND (
  text LIKE '%tok1%'
  OR text LIKE '%tok2%'
  OR ...
)
```

SQLite не поддерживает word-boundary regex, поэтому используется LIKE.

### 4.3 Чанкирование

- Размер чанка: `5000` статей (константа `DEFAULT_CHUNK_SIZE`).
- Keyset-пагинация по `id` (не `OFFSET`).
- Между чанками пауза `100 мс`.
- Каждый чанк обёрнут в retry: до 3 повторных попыток с паузой `500 * attempt` мс.

### 4.4 Обновление

**PostgreSQL:**

```sql
UPDATE news
SET matched_tags = COALESCE(matched_tags, '{}'::text[]) || $tag_id::text[]
WHERE id = ANY($ids::uuid[])
  AND (matched_tags IS NULL OR NOT ($tag_id = ANY(matched_tags)))
```

**SQLite:**

```sql
UPDATE news SET matched_tags = $json_array WHERE id = $id
```

В SQLite каждая строка обновляется отдельно (read-modify-write JSON), потому что SQLite не умеет `array_agg` и `ANY`.

---

## 5. Ограничения и защита

| Лимит | Значение | Почему |
|-------|----------|--------|
| `MAX_CONCURRENT_SCANS` | 2 | Не нагружать БД одновременными сканами. |
| `DEFAULT_CHUNK_SIZE` | 5000 | Короткие транзакции, не блокируют таблицу. |
| `MAX_TOKENS` | 500 | Аномально длинный список keywords = что-то сломалось; не сканируем. |
| `MAX_RETRIES` | 3 | Retry при транзиентных ошибках PG. |
| dry-run timeout | 120 сек (`SET LOCAL`) | `COUNT(*)` по большой таблице может быть долгим; pool-wide `statement_timeout = 30s` его убьёт. |

### Семафор

- `runningScans` — `Map<string, Promise<BackfillResult>>`.
- Если для тега уже идёт скан — возвращаем `skipped: true`.
- Если уже 2 скана работают — возвращаем `error: 'Too many concurrent scans...'`.
- Все отброшенные запросы логируются `console.warn`.

### Маркер `_backfill`

Сохраняется в `tag.enriched_data._backfill`:

```json
{
  "version": "1",
  "started_at": "2026-07-22T12:00:00.000Z",
  "completed_at": "2026-07-22T12:00:05.000Z",
  "matched_count": 42,
  "status": "running | completed | failed",
  "error": "..."
}
```

- `started_at` фиксируется в начале и не перезаписывается при завершении — это нужно для stale-определения.
- Если процесс умирает, маркер остаётся `running`. UI показывает его как `stale` через 1 час.

---

## 6. API

### `POST /admin/tags/:tagId/backfill-matches`

**Dry-run (по умолчанию):**

```json
POST /admin/tags/:tagId/backfill-matches
{ "dryRun": true }

200 OK
{
  "success": true,
  "dryRun": true,
  "tag_id": "sber",
  "matched": 127,
  "tokens": 12
}
```

**Apply:**

```json
POST /admin/tags/:tagId/backfill-matches
{ "dryRun": false }

200 OK
{
  "success": true,
  "tagId": "sber",
  "matched": 127,
  "scanned": 15000,
  "dryRun": false,
  "durationMs": 5234
}
```

**Если семафор занят:**

```json
200 OK
{
  "success": false,
  "tagId": "sber",
  "matched": 0,
  "scanned": 0,
  "dryRun": false,
  "durationMs": 0,
  "skipped": true,
  "error": "Too many concurrent scans (limit 2)"
}
```

**Ошибки:**
- `404` — тег не найден.
- `400` — `tokens == 0` или `tokens > 500`.

### `POST /admin/backfill-matches-all`

Запускает последовательный скан всех тегов в фоне. Per-tag алерты подавлены (`silent: true`); в конце отправляется один summary-алерт в Telegram.

```json
POST /admin/backfill-matches-all

200 OK
{
  "success": true,
  "message": "Backfill all started in background"
}
```

---

## 7. UI

### `TagsTab` — колонка «Scan»

| Статус | Вид | Когда |
|--------|-----|-------|
| `never` | серый | Маркера `_backfill` нет. |
| `running` | жёлтый, спиннер | `status === 'running'`. |
| `stale` | жёлтый, без спиннера | `status === 'running'` и `started_at` > 1 часа назад. |
| `N matched` | зелёный | `status === 'completed'`. |
| `failed` | красный | `status === 'failed'`. |

В заголовке колонки есть `Hint` с расшифровкой статусов.

### `TagDetailModal` — кнопка «Tag Scan»

1. **Tag Scan** — dry-run, показывает `matched` и `tokens`.
2. **Apply Scan** — применяет скан.
3. Если семафор занят — показывает сообщение «Сейчас идут 2 других скана. Подождите и попробуйте снова.» вместо фейкового «Scan complete: 0».
4. После успешного apply вызывается `load()` — данные тега обновляются.

---

## 8. Алерты

- При успешном/неуспешном apply одного тега отправляется Telegram-сообщение с `tagId`, `matched`, `scanned`, `durationMs`, ошибкой.
- При `backfill-matches-all` per-tag алерты подавлены; отправляется один summary-алерт `(all)` с количеством обработанных тегов, пропущенных, общим `matched` и числом ошибок.

---

## 9. Операционные заметки

### Как проверить, что скан работает

1. Открыть `TagsTab` — у целевого тега должен появиться статус `running`, затем `N matched`.
2. В логах Render искать строки:
   - `[TagBackfill] skipped (concurrency): ...` — отброшенные запросы.
   - `[TagBackfill] DONE tag=... matched=... scanned=... in ...ms` — успешное завершение.
   - `[TagBackfill] DONE all processed=... skipped=... matched=...` — массовый скан.
3. Для dry-run проверить, что `GET /admin/tags` возвращает корректный маркер в SQLite (путь `$._backfill`).

### Если `running` завис

1. `running` без `completed_at` > 1 часа → UI покажет `stale`.
2. Проверить, что процесс не умер (нет DONE-лога). Если умер — перезапустить скан вручную.
3. Если скан всё ещё работает, но слишком медленно — уменьшить `CHUNK_SIZE` или запустить вне пиковой нагрузки.

### Если dry-run возвращает 400 «Too many keywords/tokens»

Админский интерфейс позволяет править `keywords` вручную. Проверить, не скопировалась ли туда лишняя информация (например, полный текст или список из тысяч слов). Нормальный тег редко превышает 50–100 keywords.

---

## 10. Отличия от старого backfill в NewsSourceManager

| Старый backfill | Новый backfill |
|-----------------|----------------|
| Запускался каждые 5 минут | Только по событию |
| Сканировал только USA-тикеры | Сканирует по keywords всего тега |
| `ILIKE '%ticker%'` — без границ слова | `\m(...)\M` — точные границы слова |
| Блокировал ingestion | Fire-and-forget, не блокирует HTTP |
| Нет маркера | `_backfill` маркер с видимым статусом |
| Нет лимитов | Семафор, чанки, retry, токен-лимит |

---

## 11. Известные ограничения

- **Untag не поддерживается.** Удаление слова из keywords не снимает тег с уже затегированных статей. `matched_tags` только растёт. Это отдельная фича со своими рисками.
- **SQLite fallback** использует `LIKE` без границ слова — возможны ложные срабатывания, но это dev-режим.
- **Морфология** (склонения, синонимы, опечатки) — отдельная задача; текущий скан использует только те формы, которые уже есть в `keywords`.
