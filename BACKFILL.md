# PULSE — Tag Backfill (Retro Scan)

> Ретро-сканирование существующих новостей по keywords тега.  
> Статус: актуально после TZ-6 / TZ-6.1 / TZ-6.2 / TZ-6.3 / TZ-7 / TZ-7.4.  
> Файлы: `pulse-backend/src/services/tagBackfill.ts`, `pulse-backend/src/services/tagManager.ts`, `pulse-backend/src/index.ts`, `pulse-backend/src/routes/adminLegacy.ts`, `pulse-frontend/src/pages/admin/TagsTab.tsx`, `pulse-frontend/src/pages/admin/TagDetailModal.tsx`.

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
┌─────────────────────────────────────────────────────────────────────────┐
│  user_defined_tags                                                      │
│  ├── keywords (колонка)                                                 │
│  └── enriched_data (JSONB)                                              │
│       ├── ticker, synonyms, ...                                         │
│       └── _backfill (marker)                                            │
└───────────────────────┬───────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  services/tagBackfill.ts                                              │
│  ├── buildScanKeywords()                                                │
│  ├── countTagMatches()  (dry-run)                                       │
│  └── backfillTagMatches() (apply)                                       │
│       ├── FIFO queue (backfillQueue)                                    │
│       ├── max 1 concurrent scan (TZ-6.1)                               │
│       ├── priority jump for admin/manual triggers                        │
│       ├── sync mode for manual backfill-matches endpoint                 │
│       ├── chunks by id                                                   │
│       ├── 2 s delay between chunks (TZ-6)                                │
│       └── marker _backfill                                               │
└───────────────────────┬───────────────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  news.matched_tags                                                       │
│  тег добавляется только если его ещё нет в массиве                     │
└─────────────────────────────────────────────────────────────────────────┘
```

### Защита БД от шторма (TZ-6)

- **FIFO-очередь** вместо семафора: все запросы встают в очередь, admin-ручники — в голову (`priority: true`).
- **Один параллельный скан** (`MAX_CONCURRENT_SCANS = 1`, TZ-6.1): на инстансе 256 MB/1 CPU два seq scan'а по `news` не укладывались в ресурсы.
- **Пауза 2 сек между чанками** (`CHUNK_DELAY_MS = 2000`): даёт дышать пулу соединений и не перегружать WAL/IO.
- **Дедупликация:** тег, уже в очереди или в работе, не добавляется повторно, возвращается `skipped: true`.

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

### 4.3 Чанкирование и таймауты

- Размер чанка: `DEFAULT_CHUNK_SIZE` (env `TAG_BACKFILL_CHUNK_SIZE`, по умолчанию `5000`) статей.
- Keyset-пагинация по `id` (не `OFFSET`).
- Между чанками пауза `2 сек` (`CHUNK_DELAY_MS = 2000`, TZ-6). Раньше было 100 мс, но на 256 MB БД последовательные тяжёлые UPDATE'ы шли волной и мешали пользовательским запросам.
- Каждый чанк обёрнут в retry: до 3 повторных попыток с паузой `500 * attempt` мс.
- PostgreSQL: каждый scan-чанк выполняется в транзакции с `SET LOCAL statement_timeout = '120000ms'` (env `TAG_BACKFILL_QUERY_TIMEOUT_MS`, по умолчанию `120000` мс) через `queryWithTimeout`, чтобы не упереться в pool-wide `statement_timeout = 30s`.
- SQLite: `queryWithTimeout` использует `Promise.race` с тем же таймаутом.

### 4.4 Обновление

**PostgreSQL:**

```sql
UPDATE news
SET matched_tags = COALESCE(matched_tags, '{}'::text[]) || ARRAY[$tag_id]
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
| `MAX_CONCURRENT_SCANS` | 1 | На 256 MB/1 CPU два параллельных seq scan'а по `news` не укладывались (TZ-6.1). |
| `DEFAULT_CHUNK_SIZE` | `5000` (env `TAG_BACKFILL_CHUNK_SIZE`) | Короткие транзакции, не блокируют таблицу. |
| `CHUNK_DELAY_MS` | `2000` | Пауза между чанками, чтобы не штормить БД (TZ-6). |
| `DEFAULT_QUERY_TIMEOUT_MS` | `120000` (env `TAG_BACKFILL_QUERY_TIMEOUT_MS`) | Защита scan-запросов от pool-wide `statement_timeout`. |
| `MAX_TOKENS` | `500` | Аномально длинный список keywords = что-то сломалось; не сканируем. |
| `MAX_RETRIES` | 3 | Retry при транзиентных ошибках PG. |
| `WAKEUP_BATCH_SIZE` | 1000 | Размер пакета `UPDATE news SET needs_translation = TRUE` для no-tags статей (TZ-6.3). |
| `WAKEUP_COALESCE_MS` | 5000 | Дебаунс для множественных вызовов `wakeUpNoTagsArticlesCoalesced`. |
| `WAKEUP_DEFER_MS` | 30000 | Если backfill занят, wakeUp откладывается и перепроверяется (TZ-6.3). |
| dry-run timeout | 120 сек (`SET LOCAL`) | `COUNT(*)` по большой таблице может быть долгим; pool-wide `statement_timeout = 30s` его убьёт. |

### FIFO-очередь + rerun

- `backfillQueue` — массив `QueueItem`.
- `queuedTags` — `Set<string>` тегов, уже стоящих в очереди.
- `activeScans` — `Set<string>` тегов, чей скан выполняется прямо сейчас.
- `activeCount` — число активных сканов (0..1).
- `processQueue()` — при появлении свободного слота берёт следующий элемент из головы очереди.
- `backfillTagMatches(..., { priority: true })` вставляет в голову очереди; используется для admin/manual триггеров.
- `backfillTagMatches(..., { sync: true, priority: true })` ждёт завершения; используется в `POST /admin/tags/:tagId/backfill-matches`.
- Тег, уже в очереди или в работе, не добавляется повторно — возвращается `skipped: true`.
- `unshift` для priority — O(n), приемлем при очереди в десятки тегов; если станет сотни регулярно — заменить на две очереди (priority + bulk).

### Coalesced + batched wakeUp (TZ-6.3)

- `wakeUpNoTagsArticles()` теперь батчевый UPDATE по `WAKEUP_BATCH_SIZE` строк с паузой 200 мс между батчами.
- `wakeUpNoTagsArticlesCoalesced()` дебаунсит множественные вызовы и перед запуском проверяет `isBackfillBusy()`. Если backfill работает — wakeUp откладывается на 30 с, максимум 40 раз подряд (~20 мин страховка).
- Прямой `wakeUpNoTagsArticles()` оставлен для cron `/trigger/wake-no-tags`.
- Индекс `idx_news_no_tags_wakeup ON news(id) WHERE sentiment_source = 'no-tags' AND (matched_tags IS NULL OR matched_tags = '{}')` создан в бут-миграциях (TZ-6.2), чтобы `SELECT id FROM news WHERE ... LIMIT 1000` не делал seq scan.

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

По умолчанию endpoint работает в режиме dry-run. POST без body или с `{}` тоже выполняет dry-run — логируется строка `[AdminBackfillMatches] tag=... dryRun=true`. Для apply необходимо явно передать `{ "dryRun": false }`.

**Dry-run:**

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

**Если скан уже выполняется или стоит в очереди:**

```json
200 OK
{
  "success": true,
  "tagId": "sber",
  "matched": 0,
  "scanned": 0,
  "dryRun": false,
  "durationMs": 0,
  "skipped": true,
  "message": "Сканирование уже выполняется или в очереди"
}
```

Тег дедуплицируется на входе: повторный запрос не ставится в очередь дважды, а сразу возвращает `skipped: true`. После завершения текущего скана rerun автоматически не запускается — админ может нажать кнопку снова.


**Ошибки:**
- `404` — тег не найден.
- `400` — `tokens == 0` или `tokens > 500`. Ответ содержит `message` на русском.

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
3. Если скан для этого тега уже идёт или стоит в очереди — показывает сообщение «Сканирование уже выполняется или в очереди». Тег дедуплицируется: повторный запрос не ставится в очередь дважды.
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
   - `[TagBackfill] queued <tagId> (queue=N, active=M)` — тег добавлен в FIFO-очередь.
   - `[TagBackfill] skipped (already queued or running): <tagId>` — повторный запрос отброшен дедупликацией.
   - `[TagBackfill] DONE tag=<tagId> matched=... scanned=... in ...ms` — успешное завершение.
   - `[TagBackfill] DONE all processed=... skipped=... matched=... errors=... in ...ms` — массовый скан.
   - `[TagManager] wakeUp deferred (N/40): backfill busy` — wakeUp no-tags отложен из-за занятой очереди backfill.
3. Для dry-run проверить, что `GET /admin/tags` возвращает корректный маркер в SQLite (путь `$._backfill`).

### Переменные окружения

| Переменная | Значение по умолчанию | Описание |
|------------|----------------------|----------|
| `TAG_BACKFILL_CHUNK_SIZE` | `5000` | Размер чанка при ретро-скане. |
| `TAG_BACKFILL_QUERY_TIMEOUT_MS` | `120000` | `statement_timeout` для scan-чанков PostgreSQL и `Promise.race` для SQLite. |

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
| Нет лимитов | FIFO-очередь, 1 параллельный скан, чанки, retry, токен-лимит |

---

## 11. Известные ограничения

- **Untag не поддерживается.** Удаление слова из keywords не снимает тег с уже затегированных статей. `matched_tags` только растёт. Это отдельная фича со своими рисками.
- **SQLite fallback** использует `LIKE` без границ слова — возможны ложные срабатывания, но это dev-режим.
- **Морфология** (склонения, синонимы, опечатки) — отдельная задача; текущий скан использует только те формы, которые уже есть в `keywords`.
