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

*Документ создан: 2026-06-05*
*Последнее обновление: 2026-06-05*
