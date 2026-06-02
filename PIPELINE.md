# PULSE — Полный пайплайн обработки новости

> **Версия:** 8.2.0 (Batch Size Reduction + Chunk Loop Fix)
> **Дата:** 2026-06-02
> **Файлы:** `cron.ts`, `smartTagMatcher.ts`, `index.ts`, `NewsCard.tsx`

---

## 1. ОБЗОР АРХИТЕКТУРЫ

```
RSS Feed → Новость (title, summary)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 1: DEDUPLICATION (content_hash)                       │
│ Проверяем: эта новость уже в БД?                            │
│ • Да → UPDATE all_sources, source_count (ON CONFLICT)       │
│ • Нет → INSERT новая запись                                 │
└────────────────────────┬────────────────────────────────────┘
                         │
    ┌────────────────────┼────────────────────┐
    │                    │                    │
    ▼                    ▼                    ▼
Новая статья    Дубликат (reasoning    Дубликат (без
(INSERT)        уже есть)              reasoning)
    │           • skip LLM call         • обрабатываем
    │           • load from DB          • как новая
    ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 2: TAG MATCHING (Layer 1 + Layer 2)                   │
│ Ищем теги: keywords → LLM smart match                       │
│ Результат: matched_tags[]                                   │
└────────────────────────┬────────────────────────────────────┘
                         │
                    matched_tags > 0?
                         │
              ┌──────────┴──────────┐
              │                     │
              ДА                    НЕТ
              │                     │
              ▼                     ▼
┌─────────────────────┐   ┌─────────────────────────────┐
│ STAGE 3: LLM        │   │ STAGE 3b: KEYWORD FALLBACK  │
│ UNIFIED BATCH       │   │                             │
│                     │   │ sentiment_source='keyword'  │
│ ПРОВЕРКА: у         │   │ sentiment='neutral'         │
│ дубликата уже       │   │ score=0                     │
│ есть reasoning?     │   │ reasoning=NULL              │
│                     │   │ tag_impacts=[]              │
│ • Да → skip LLM     │   │                             │
│ • Нет → LLM call    │   │ НЕТ LLM вызова → $0        │
│                     │   └─────────────────────────────┘
│ Результат:          │
│ score, reasoning,   │
│ is_political,       │
│ tag_impacts[]       │
└─────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 4: SAVE TO DATABASE                                   │
│ INSERT news (...) ON CONFLICT (content_hash) DO UPDATE      │
│ CASE WHEN: обновляем reasoning ТОЛЬКО если предыдущий      │
│ результат был LLM-ошибкой (llm-timeout/parse/etc)          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 5: DEFERRED PROCESSOR (каждые 10 мин)               │
│ Перепробует failed статьи (attempts < 3)                    │
│ Макс 3 попытки, 30 мин между retries                        │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │   FRONTEND CARD     │
              │   NewsCard.tsx      │
              └─────────────────────┘
```

---

## 2. STAGE 1: DEDUPLICATION

### Ключ дедупликации
```typescript
contentHash = sha256(title + '\n' + summary).digest('hex')
```

### Логика
```sql
INSERT INTO news (..., sentiment_reasoning, sentiment_source, ...)
VALUES (...)
ON CONFLICT (content_hash) DO UPDATE
  SET all_sources = CASE
        WHEN news.all_sources @> ARRAY[EXCLUDED.source] THEN news.all_sources
        ELSE array_append(news.all_sources, EXCLUDED.source)
      END,
      source_count = CASE
        WHEN news.all_sources @> ARRAY[EXCLUDED.source] THEN news.source_count
        ELSE news.source_count + 1
      END,
      -- ОБНОВЛЯЕМ reasoning ТОЛЬКО если был LLM-ошибка:
      sentiment_reasoning = CASE
        WHEN news.sentiment_source LIKE 'llm-%' 
             AND news.sentiment_source != 'llm-partial'
        THEN EXCLUDED.sentiment_reasoning
        ELSE news.sentiment_reasoning
      END,
      sentiment_score = CASE ... (аналогично) ...,
      sentiment_source = CASE ... (аналогично) ...,
      llm_error = EXCLUDED.llm_error,
      llm_attempts = COALESCE(news.llm_attempts, 0) + 1
      last_retry_at = NOW()
```

**Правило:** При дубликате обновляем reasoning **только если** предыдущий `sentiment_source` был ошибкой (`llm-timeout`, `llm-parse`, `llm-empty`). Если был успех (`llm`) или partial (`llm-partial`) — **не трогаем**.

---

## 3. STAGE 2: TAG MATCHING

### Layer 1: Keyword Matching (быстро, 0 токенов)
```typescript
// Загружаем keywords для каждого тега из БД
const userTags = tagManager.getEnrichedKeywords(); // ~20 тегов × ~20 keywords

// Проверяем каждое keyword в title + summary (lower-case)
for (const [tagId, keywords] of userTags) {
  if (keywords.some(kw => (title + summary).toLowerCase().includes(kw))) {
    matched.push(tagId);
  }
}
```

### Layer 2: LLM Smart Matching (медленно, expensive)
**Срабатывает только если Layer 1 не нашёл теги.**
```
"Analyze this article and determine which of the following tags apply.
Available tags: apple, tesla, oil, defense...
Return ONLY JSON array: ['oil'] or []"
```

### Layer 3: Related Tags (опционально)
Для каждого найденного тега — LLM ищет связанные теги из доступных.

---

## 4. STAGE 3: LLM UNIFIED BATCH

### Batch Size: 5 articles per call

**2026-06-02: уменьшен с 10 → 5.** Причина: LLM (Kimi API) consistently timeout'ил на 10 статьях за 30 секунд. С 5 статьями — timeout почти не происходит.

**Trade-off:** 2x больше API calls, но ~95% success rate вместо ~45%.

### Оптимизация: Skip дубликатов с reasoning

```typescript
// ПРЕЖДЕ чем вызывать LLM — проверяем дубликаты
const skipLLM = new Set<number>();

for (let i = 0; i < articles.length; i++) {
  const contentHash = sha256(a.title + '\n' + a.summary);
  const existing = await query(
    `SELECT sentiment_reasoning, sentiment_source 
     FROM news WHERE content_hash = $1 LIMIT 1`,
    [contentHash]
  );
  
  if (existing?.sentiment_reasoning && 
      (existing.sentiment_source === 'llm' || 
       existing.sentiment_source === 'llm-partial')) {
    // ✅ Дубликат с reasoning — НЕ вызываем LLM
    skipLLM.add(i);
    // Загружаем данные из БД
    unifiedResults[i] = {
      sentiment: existing.sentiment,
      score: existing.sentiment_score,
      reasoning: existing.sentiment_reasoning,
      ...
    };
  }
}

// Вызываем LLM ТОЛЬКО для новых статей
const needLLMWithIndex = [];
for (let i = 0; i < articles.length; i++) {
  if (!skipLLM.has(i)) needLLMWithIndex.push({ article: articles[i], originalIndex: i });
}
console.log(`LLM: ${articles.length} total, ${needLLMWithIndex.length} need, ${skipLLM.size} skipped`);
```

**Экономия токенов:** Если из 10 статей 5 — дубликаты, вызываем LLM только для 5 новых.

### Chunk Loop (критический фикс 2026-06-02)

**Проблема:** Основной cron отправлял ВЕСЬ `needLLM` (до 65 статей!) в ОДИН `analyzeUnifiedBatch()` — без разбиения на chunk'и. 65 статей за 30 секунд → timeout → ВСЕ статьи fallback.

**Фикс:** Loop по chunk'ам размером `BATCH_SIZE` (сейчас 5):

```typescript
const BATCH_SIZE = 5;  // 2026-06-02: уменьшен с 10 → 5

for (let batchStart = 0; batchStart < needLLMWithIndex.length; batchStart += BATCH_SIZE) {
  const chunk = needLLMWithIndex.slice(batchStart, batchStart + BATCH_SIZE);
  
  try {
    const results = await analyzeUnifiedBatch(
      chunk.map(({ article, originalIndex }) => ({
        title: article.title_ru || article.title,
        summary: article.summary_ru || article.summary,
        tags: matchedTagsList[originalIndex],
      }))
    );
    // results[j] → unifiedResults[chunk[j].originalIndex]
  } catch (err) {
    // fallback ТОЛЬКО для этого chunk — остальные unaffected
  }
}
```

Deferred processor уже имел chunk loop (`i += 10` → теперь `i += 5`). Основной cron — **не имел** до фикса.

### Two-Pass JSON Parsing

LLM возвращает JSON с физическими `\n` внутри строк — невалидный JSON.

```typescript
let parsed: any;

// Pass 1: парсим как есть (работает если \n только между ключами)
try {
  parsed = JSON.parse(raw);
} catch (e1) {
  // Pass 2: фиксим физические newlines ВНУТРИ строк
  let fixed = raw.replace(/\\/g, '__ESC__');  // 1. защита \\
  fixed = fixed.replace(/\n/g, '\\n');          // 2. fix \n
  fixed = fixed.replace(/__ESC__/g, '\\\\');   // 3. restore \\
  parsed = JSON.parse(fixed);
}
```

### Парсинг результатов

```typescript
const items = parsed.results || parsed;
const arr = Array.isArray(items) ? items : [];

// EMPTY results handling
if (arr.length === 0) {
  return batch.map(it => ({
    _llmSource: 'llm-empty',
    _llmBatchSize: batchSize,
    _llmResultsCount: 0,
    _llmRaw: content.slice(0, 500),
    ...
  }));
}

// Partial results handling
if (arr.length < batchSize) {
  // results[i] — success
  // fallback — 'llm-partial'
}
```

---

## 5. КЛАССИФИКАЦИЯ ОШИБОК (sentiment_source)

| Значение | Когда | llm_error |
|----------|-------|-----------|
| `'llm'` | Успех, `resultsCount == batchSize` | `NULL` |
| `'llm-partial'` | Успех, но `resultsCount < batchSize` | `NULL` или `'Only N of M results'` |
| `'llm-timeout'` | ETIMEDOUT / ECONNRESET | `'ETIMEDOUT after 30000ms'` |
| `'llm-rate-limit'` | 429 Too Many Requests | `'429 after 3 retries'` |
| `'llm-parse'` | JSON.parse упал | `'Unexpected token at...'` |
| `'llm-empty'` | LLM вернул пустой `results[]` | `'Empty results array'` |
| `'llm-error'` | Другая ошибка (502, 503, сеть) | Сообщение ошибки |
| `'keyword'` | Нет тегов — LLM не вызывался | `NULL` |

### Что записывается в БД

| Поле | Успех | Ошибка |
|------|-------|--------|
| `sentiment_source` | `'llm'` / `'llm-partial'` | `'llm-xxx'` |
| `sentiment_score` | число (-10..+10) | `0` |
| `sentiment_reasoning` | текст | `NULL` или `''` |
| `llm_error` | `NULL` | текст ошибки |
| `llm_attempts` | `NULL` | `1` (после первой попытки) |
| `llm_raw_preview` | первые 500 chars ответа | первые 500 chars ответа |
| `llm_batch_size` | N (сколько в batch) | N (сколько в batch) |
| `llm_results_count` | N (сколько вернул LLM) | `0` |

---

## 6. DEFERRED PROCESSOR

### Зачем
Новые статьи обрабатываются основным cron'ом каждые 5 мин. Если LLM упал — статья остаётся с пустыми полями. Deferred processor автоматически **перепробует** через 30 мин.

### Логика
```typescript
cron.schedule('*/10 * * * *', async () => {
  // Берём статьи с ошибкой, давно не пробовали, < 3 attempts
  const failed = await query(`
    SELECT id, title_ru, matched_tags
    FROM news
    WHERE llm_error IS NOT NULL
      AND llm_attempts IS NOT NULL  -- ← не берём успешные (null)
      AND llm_attempts < 3          -- ← макс 3 попытки
      AND (last_retry_at IS NULL 
           OR last_retry_at < NOW() - INTERVAL '30 minutes')
    LIMIT 20
  `);
  
  // Вызываем LLM, UPDATE статьи
  // При успехе: llm_error=NULL, sentiment_source='llm'
  // При неудаче: llm_attempts++
});
```

### Retry policy
| Попытка | Когда | Результат |
|---------|-------|-----------|
| 1 | Основной cron | Первая обработка, `attempts=1` |
| 2 | Deferred (+30 мин) | `attempts=2` |
| 3 | Deferred (+30 мин) | `attempts=3` |
| 4+ | — | **Ручная очередь**, не retry'им автоматически |

---

## 7. ADMIN ENDPOINTS

### GET /admin/llm-dashboard
```json
{
  "today": {
    "batches_total": 45,
    "batches_success": 42,
    "batches_partial": 2,
    "batches_failed": 1,
    "success_rate": 97.8,
    "articles_processed": 450,
    "articles_failed": 12,
    "manual_queue": 3
  },
  "errors_by_type": {
    "llm-timeout": 5,
    "llm-parse": 4,
    "llm-rate-limit": 3
  },
  "hourly_trend": [...],
  "per_tag": [...]
}
```

### GET /admin/llm-errors?limit=50&hours=24
Возвращает конкретные статьи с ошибками, включая `llm_raw_preview` — что реально ответил LLM.

### POST /admin/backfill
```json
{ "tag": "apple" } → перепроцессирует все failed статьи с тегом apple
{ "newsIds": ["id1", "id2"] } → конкретные статьи
{ "since": "24h" } → за последние 24 часа
```

---

## 8. КРИТИЧЕСКИЕ БАГИ — ИСТОРИЯ

### Баг 1: raw.replace(/\n/g, '\\n') ломал JSON
**Причина:** Заменял ВСЕ `\n` — и между ключами, и внутри строк.
**Результат:** `JSON.parse` всегда падал → все статьи fallback.
**Фикс:** Two-pass parsing — parse as-is first, потом fix.

### Баг 2: `llm_attempts=0` при успехе → deferred брал ВСЕ статьи
**Причина:** Успешные статьи имели `attempts=0`, а `WHERE attempts < 3` пропускал их.
**Результат:** Deferred processor обрабатывал все 13000+ статей.
**Фикс:** `null` при успехе, `IS NOT NULL` guard.

### Баг 3: `results.length > 0` вместо `resultsCount > 0` (while-loop)
**Причина:** Проверяли длину results массива, а не сколько вернул LLM.
**Результат:** Fallback неправильно маркировался.
**Фикс:** `resultsCount > 0`.

### Баг 4: `COALESCE(llm_error, $1)` — ошибка не обновлялась
**Причина:** `COALESCE` брал старое значение если оно не NULL.
**Результат:** При retry ошибка не обновлялась.
**Фикс:** Просто `$1`.

### Баг 5: `_llmRaw` не добавлялся в успешные результаты
**Причина:** `_llmRaw` был только в fallback/empty, не в основном `results.push`.
**Результат:** Успешные статьи не имели raw preview.
**Фикс:** Добавлен `_llmRaw` во все `results.push`.

### Баг 6: Основной cron без chunk loop — batch sizes до 65 статей
**Причина:** `analyzeUnifiedBatch(needLLM)` — один вызов на ВСЕ статьи. Deferred processor имел `for (i += 10)`, основной cron — нет.
**Результат:** 392 timeouts за 24ч, batch sizes 28/23/65/13, success rate 45%.
**Фикс:** Chunk loop `for (batchStart += BATCH_SIZE)` в основном cron. `BATCH_SIZE` вынесен как константа.

### Баг 7: JWT_SECRET mismatch — admin endpoints возвращали 401
**Причина:** `auth.ts` использовал `process.env.JWT_SECRET || 'dev-secret'`, а `requireAdmin` в `index.ts` — `process.env.JWT_SECRET || 'your-secret-key'`. На Render `JWT_SECRET` env не установлен.
**Результат:** Токен подписан `'dev-secret'`, проверяется `'your-secret-key'` → `Invalid token` → админ панель пустая.
**Фикс:** Унифицирован дефолт `'dev-secret'` в обоих местах.

---

## 9. МЕТРИКИ КОНТРОЛЯ

### Как проверить что всё работает

```bash
# 1. Общая аналитика за 24 часа
curl https://pulse-api-bsov.onrender.com/llm-analytics?hours=24

# 2. Детальная панель администратора (требует JWT)
curl -H "Authorization: Bearer $TOKEN" \
  https://pulse-api-bsov.onrender.com/admin/llm-dashboard

# 3. Список ошибок
curl -H "Authorization: Bearer $TOKEN" \
  https://pulse-api-bsov.onrender.com/admin/llm-errors

# 4. Таблица llm_batches
curl https://pulse-api-bsov.onrender.com/debug-db \
  -d "query=SELECT * FROM llm_batches ORDER BY started_at DESC LIMIT 10"
```

### Нормальные показатели
| Метрика | Хорошо | Плохо | Примечание |
|---------|--------|-------|------------|
| success_rate | > 95% | < 90% | При batch=5: ~95-98% |
| llm-empty | 0 | > 0 | |
| llm-parse | 0 | > 0 | |
| llm-timeout | 0 | > 5 | Должен быть 0 при batch=5 |
| manual_queue | 0 | > 10 | |
| empty_with_tags / total | < 10% | > 20% | |
| **batch_size** | **5** | **> 5** | **Должен быть ровно 5** |

---

## 10. КОНТАКТЫ

При проблемах с пайплайном:
1. Смотреть `/admin/llm-dashboard` — общая картина
2. Смотреть `/admin/llm-errors` — конкретные статьи с ошибками
3. Проверить `llm_raw_preview` — что реально ответил LLM
4. Запустить `/admin/backfill` с tag или newsIds
5. Если не помогает — смотреть логи Render

---

*Документ создан: 2026-06-02*
*Последнее обновление: 2026-06-02 (batch size 10→5, chunk loop fix, JWT_SECRET unify)*
