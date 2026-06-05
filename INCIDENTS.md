# PULSE — Инциденты (Incident Runbooks)

> **Назначение:** Описание production-инцидентов с root cause, timeline, фиксом и профилактикой.
> **Формат:** Один инцидент = один раздел. Читается как чеклист при повторении симптомов.

---

## INC-001: CRON FREEZE — PostgreSQL Pool Exhaustion

| Поле | Значение |
|------|----------|
| **ID** | INC-001 |
| **Дата** | 2026-06-05 13:05 UTC |
| **Статус** | ✅ RESOLVED |
| **Серьёзность** | P0 — критический (новые статьи не появлялись на сайте) |
| **Коммит фикса** | `ba9ae87` (batch enrichment v3), `409fd92` (zombie cleanup) |

---

### Симптомы

```bash
# /debug-cron показывал 5+ циклов с finished_at: null
{"started_at":"13:05","finished_at":null,"articles_saved":0,"status":"running"}
{"started_at":"13:20","finished_at":null,"articles_saved":0,"status":"running"}
{"started_at":"13:30","finished_at":null,"articles_saved":0,"status":"running"}
{"started_at":"13:45","finished_at":null,"articles_saved":0,"status":"running"}
{"started_at":"13:55","finished_at":null,"articles_saved":0,"status":"running"}
# Последний успешный цикл: 12:55 (50+ минут назад)
```

- Новые статьи не появлялись на сайте
- `/debug-cron` — все циклы "running" но ничего не сохраняется
- `/health` — статус "ok", cron помечен как "healthy" (ложноположительный)

---

### Timeline

| Время | Событие |
|-------|---------|
| 12:55 | ✅ Последний успешный цикл: 65 fetched, 60 saved, 1 merged |
| 13:05 | ❌ Цикл запустился, 75 fetched, 0 saved — **FREEZE** |
| 13:20 | ❌ Следующий цикл тоже замерз (cron lock всё ещё удерживает мёртвый процесс) |
| 13:30 | ❌ Третий frozen цикл |
| 13:45 | ❌ Четвёртый frozen цикл |
| 13:55 | ❌ Пятый frozen цикл |
| 14:20 | 🔍 Обнаружен баг через `/debug-cron` |
| 14:25 | 🔧 Hotfix: закомментирован `populateNewsTagLinks()` в `cron.ts` (коммит `41fd79d`) |
| 14:30 | 🔧 Hard restart на Render для очистки zombie cron lock |
| 14:35 | ✅ Cron восстановился: 86 fetched, 84 saved |
| 14:45 | ✅ Второй успешный цикл подряд: 49 fetched, 49 saved |
| 15:05 | ✅ Правильный фикс: `populateNewsTagLinksBatch()` (коммит `ba9ae87`) |
| 15:15 | ✅ Zombie cleanup добавлен (коммит `409fd92`) |

---

### Root Cause Analysis

#### Неправильный код (приводящий к deadlock)

```typescript
for (const a of processed) {
  // ... INSERT INTO news ...
  
  // ❌ AWAIT внутри цикла! Каждая статья = новое соединение
  await populateNewsTagLinks(newsId, a.matched_tags, a.tag_impact);
  // populateNewsTagLinks() → pool.connect() → BEGIN → INSERT → COMMIT → release()
}
```

#### Цепочка разрушения

```
60 новых статей × pool.connect() = 60 concurrent connection requests
PostgreSQL pool max = 10 connections

1. Статьи 1-10: получают соединения, начинают транзакции
2. Статьи 11-60: встают в очередь ожидания соединения
3. Статьи 1-10: пытаются сделать INSERT → queue написи
4. Pool полностью исчерпан
5. Следующий цикл cron: тоже нужны соединения → встаёт в очередь
6. Все последующие циклы тоже ждут → CASCADE FREEZE
7. Ни один цикл не может завершиться (logCronFinish тоже needs query())
```

#### Почему это не происходило раньше

| Фактор | Раньше | В день инцидента |
|--------|--------|------------------|
| Кол-во статей | ~20-30 | **60-90** (больше RSS-источников) |
| `populateNewsTagLinks` | Не существовало (v2 ещё не было в main) | **Был включён** в цикл |
| Pool size | 10 | 10 |
| Условие deadlock | 20 < 10 = false | **60 > 10 = true** ✅ |

---

### Фикс

#### Phase 1: Hotfix (остановить кровотечение)

```typescript
// Закомментировать вызов в cron.ts
// if (a.sentiment_source === 'llm' ...) {
//   await populateNewsTagLinks(...);  ← БАН
// }
```
Результат: cron работает, enrichment отключён.

#### Phase 2: Правильный фикс (batch enrichment)

```typescript
// cron.ts — сбор задач В цикле, выполнение ПОСЛЕ
const enrichmentTasks: EnrichmentTask[] = [];

for (const a of processed) {
  // ... save article ...
  enrichmentTasks.push({ newsId, matchedTags, tagImpacts });  // ✅ без await
}

// После цикла: 1 соединение на ВЕСЬ batch
populateNewsTagLinksBatch(enrichmentTasks).catch(err => {
  console.error(`Batch enrichment failed: ${err.message}`);
});
```

```typescript
// enrichment.ts — batch функция
export async function populateNewsTagLinksBatch(tasks: EnrichmentTask[]): Promise<void> {
  if (tasks.length === 0) return;
  const client = await pool.connect();  // ← 1 connection!
  try {
    await client.query('BEGIN');
    
    // Все keyword-ссылки одним unnest
    const keywordNewsIds: string[] = [];
    const keywordTags: string[] = [];
    for (const task of tasks) {
      for (const tag of task.matchedTags) {
        keywordNewsIds.push(task.newsId);
        keywordTags.push(tag);
      }
    }
    if (keywordNewsIds.length > 0) {
      await client.query(
        `INSERT INTO news_tag_links (news_id, tag_id, link_source)
         SELECT news_id, tag_id, 'keyword'
         FROM unnest($1::text[], $2::text[]) AS t(news_id, tag_id)
         ON CONFLICT DO NOTHING`,
        [keywordNewsIds, keywordTags]
      );
    }
    
    // Все llm_impact-ссылки одним unnest
    // ... similar pattern ...
    
    // Все статьи помечаем v2
    await client.query(
      'UPDATE news SET enrichment_version = 2 WHERE id = ANY($1::text[])',
      [tasks.map(t => t.newsId)]
    );
    
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}
```

#### Phase 3: Zombie cleanup

```typescript
// В начале каждого цикла — удаляем мусор от мёртвых процессов
const cleanup = await query(
  `DELETE FROM cron_log 
   WHERE finished_at IS NULL 
     AND started_at < NOW() - INTERVAL '15 minutes'
   RETURNING id`
);
```

---

### Уроки

#### ❌ Неправильно | ✅ Правильно

| ❌ Неправильно | ✅ Правильно |
|---------------|-------------|
| `await pool.connect()` внутри `for` цикла | `pool.connect()` один раз **после** цикла |
| N соединений на N элементов | 1 соединение на весь batch |
| `await` блокирует основной поток | `.catch()` — fire-and-forget для некритичных операций |
| Нет cleanup при hard restart | Авто-cleanup мусора при старте |

#### Профилактика

1. **Никогда** не вызывать `pool.connect()` внутри for-loop без лимита concurrency
2. **Всегда** использовать batch-операции (unnest, ANY, IN)
3. **Всегда** делать fire-and-forget для enrichment (`.catch()`, не `await`)
4. **Cron lock TTL** = 10 мин (авто-очистка при зависании)
5. **Zombie cleanup** при старте каждого цикла

---

### Как диагностировать за 30 секунд

```bash
# 1. Проверить /debug-cron
curl https://pulse-api-bsov.onrender.com/debug-cron | jq

# Если 3+ записи с finished_at: null → подозрение на freeze

# 2. Проверить /health
curl https://pulse-api-bsov.onrender.com/health | jq

# Если version старая → деплой не прошёл

# 3. Решение: hard restart на Render
# Dashboard → pulse-api → Kill Instance / Manual Restart
```

---

---

## INC-002: Deferred Processor Overload — Cascade Cron Freeze

| Поле | Значение |
|------|----------|
| **ID** | INC-002 |
| **Дата** | 2026-06-05 15:35 UTC |
| **Статус** | ✅ RESOLVED |
| **Серьёзность** | P1 — высокий (cron замедлился до 15+ мин, новые статьи задерживались) |
| **Связан с** | INC-001 (pool exhaustion — первоначальная причина накопления) |
| **Коммит фикса** | `d72aecf` (`/cleanup-failed-articles` endpoint) |

---

### Симптомы

```bash
# /debug-cron — циклы успешные, НО занимают 15-20 минут вместо нормальных 5-8
{"started_at":"15:20","finished_at":"15:33","articles_saved":74,"status":"success"}  # 13 мин!
{"started_at":"15:35","finished_at":null,"articles_saved":0,"status":"running"}         # завис
{"started_at":"15:45","finished_at":null,"articles_saved":0,"status":"running"}         # завис

# Новые статьи есть, но появляются с большой задержкой
# Карусель показывает старые статьи вперёд свежих
```

- Cron циклы успешные, но длительность **×2-3 от нормы**
- Периодические zombie-записи (циклы не успевают завершиться до следующего)
- Новые статьи на сайте появляются с задержкой 10-15 минут
- Deferred processor логи: `Processing 20 failed articles` каждые 10 минут

---

### Timeline

| Время | Событие |
|-------|---------|
| 13:05 | ❌ INC-001 начался — cron freeze из-за pool exhaustion |
| 13:05-15:20 | ❌ LLM не работает — статьи накапливают `llm_error` (timeout, rate-limit) |
| 15:20 | ✅ Cron восстановился после hotfix INC-001 |
| 15:30 | 🔍 Замечено: циклы занимают 13+ минут вместо 5-8 |
| 15:35 | 🔍 Deferred processor: обработка 20 статей с ошибкой каждые 10 мин |
| 15:40 | 🔍 Подсчёт: **9276 статей** с `llm_error` в базе |
| 15:42 | 🔧 Cleanup endpoint задеплоен (`d72aecf`) |
| 15:43 | 🔧 Вызов `/cleanup-failed-articles` — удалено 9276 статей |
| 16:00 | ✅ Цикл: 94 fetched, 93 saved, finished за 8 минут ✅ (норма!) |
| 16:25 | ✅ Цикл: 72 fetched, 56 saved, finished за 6 минут ✅ |

---

### Root Cause Analysis

#### Цепочка разрушения (CASCADE)

```
INC-001: cron freeze 13:05-15:20 (2.5 часа)
    ↓
LLM не обрабатывает статьи → все получают llm_error='timeout'
    ↓
2.5 часа × 60 статей/15мин × 4 цикла = ~960 статей с ошибкой
    ↓
+ накопленные ошибки за предыдущие дни = 9276 статей
    ↓
Deferred processor каждые 10 мин: берёт 20 статей, LLM retry
    ↓
20 статей × 1 LLM batch = +30-60 секунд к каждому cron циклу
    ↓
Цикл занимает 13-15 минут вместо 5-8
    ↓
Cron lock не успевает освободиться → zombie records
    ↓
Следующий цикл ждёт lock → каскадная задержка
```

#### Почему это не происходило раньше

| Фактор | Раньше | В день инцидента |
|--------|--------|------------------|
| LLM uptime | 95%+ | **2.5 часа downtime** (INC-001) |
| Статей с ошибкой | ~50-100 | **9276** (×100 накопление) |
| Deferred load | 0-2 статьи/10мин | **20 статей/10мин** (максимум) |
| Cron длительность | 5-8 мин | **13-15 мин** (×2-3) |

---

### Фикс

#### Phase 1: Диагностика

```sql
-- Подсчёт статей с ошибкой
SELECT COUNT(*) FROM news WHERE llm_error IS NOT NULL;
-- Результат: 9276 (!!!)

-- Проверка deferred queue
SELECT llm_error, COUNT(*) 
FROM news 
WHERE llm_error IS NOT NULL AND llm_attempts < 3
GROUP BY llm_error;
-- Результат: 9276 × 'timeout', 'rate-limit', 'parse'
```

#### Phase 2: Cleanup

```bash
# Разовый вызов (auth: x-trigger-secret)
curl -X POST https://pulse-api-bsov.onrender.com/cleanup-failed-articles \
  -H "x-trigger-secret: pulse-dev-key"

# Ответ:
{"deleted": 9276, "message": "Removed 9276 articles with llm_error"}
```

**Важно:** Удалены только статьи с `llm_error`. Успешные статьи (`sentiment_source='llm'`) НЕ тронуты.

#### Phase 3: Проверка

```bash
# Повторный подсчёт
SELECT COUNT(*) FROM news WHERE llm_error IS NOT NULL;
-- Результат: 0 ✅

# Deferred processor: "Processing 0 failed articles" ✅
```

---

### Уроки

#### ❌ Неправильно | ✅ Правильно

| ❌ Неправильно | ✅ Правильно |
|---------------|-------------|
| Нет лимита на размер deferred queue | Мониторинг `COUNT(*) WHERE llm_error` |
| Нет авто-cleanup старых ошибок | Cleanup статей с `attempts >= 3` раз в сутки |
| Нет алерта на рост queue | Алерт если `llm_error > 1000` за час |

#### Профилактика

1. **Мониторинг:** `SELECT COUNT(*) FROM news WHERE llm_error IS NOT NULL` — раз в час
2. **Авто-cleanup:** `DELETE FROM news WHERE llm_error IS NOT NULL AND llm_attempts >= 3 AND last_retry_at < NOW() - INTERVAL '24 hours'`
3. **Алерт:** Если `llm_error` растёт быстрее чем обрабатывается → Telegram alert
4. **Деградация:** При LLM downtime > 30 мин — авто-отключение deferred processor

---

---

## INC-003: SQL Type Mismatch — text[] @> character varying[]

| Поле | Значение |
|------|----------|
| **ID** | INC-003 |
| **Дата** | 2026-06-05 19:00 UTC |
| **Статус** | ✅ RESOLVED |
| **Серьёзность** | P2 — высокий (admin tags tab broken) |
| **Коммит фикса** | `fba489c` |

### Симптомы
- Admin → вкладка "Теги" — пустая страница
- Console: `500 ()`
- Ошибка: `operator does not exist: text[] @> character varying[]`

### Root Cause
PostgreSQL не может сравнить `text[]` с `character varying[]` через `@>`:
```sql
n.matched_tags @> ARRAY[t.tag_id]  -- text[] @> character varying[] = ERROR
```

### Фикс
```sql
-- Было:
LEFT JOIN news n ON n.matched_tags @> ARRAY[t.tag_id]

-- Стало:
LEFT JOIN news n ON t.tag_id = ANY(n.matched_tags)  -- ← работает с любыми типами
```

**Почему ANY лучше:** не требует кастинга, использует GIN индекс, читаемее.

---

*Документ создан: 2026-06-05*
*Последнее обновление: 2026-06-05*
