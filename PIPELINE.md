# PULSE — Полный пайплайн обработки новости (v9.0)

> **Версия:** 9.1 (kimi-k2.5 + Cron Freeze Runbook)
> **Дата:** 2026-06-05
> **Файлы:** `cron.ts`, `smartTagMatcher.ts`, `enrichment.ts`, `index.ts`
> **LLM Model:** `kimi-k2.5` (default)

---

## 0. LLM MODEL CONFIGURATION

### 0.1 Where to change model (5 files)

| # | File | Line | Variable | Purpose |
|---|------|------|----------|---------|
| 1 | `smartTagMatcher.ts` | 26 | `KIMI_MODEL` | Sentiment analysis, tag matching, unified batch |
| 2 | `translate.ts` | 36 | `KIMI_MODEL` | EN→RU translation |
| 3 | `tagManager.ts` | 16 | `KIMI_MODEL` | Tag enrichment, keyword expansion |
| 4 | `user.ts` | 670 | `KIMI_MODEL_SUMMARY` | Summary generation |
| 5 | `index.ts` | 1275 | — | `/health` debug endpoint |

**Quick switch (no deploy):** Set env var `KIMI_MODEL=moonshot-v1-32k` on Render.

---

### 0.2 moonshot-v1-32k (default, fast)

Use when: cron speed is critical, budget secondary.

| Parameter | Value | Code |
|-----------|-------|------|
| **temperature** | 0.1 (sentiment/tag), 0.3 (translate/summary) | `0.1` / `0.3` |
| **timeout API** | 15 sec (sentiment), 30 sec (translate) | `15000` / `30000` |
| **batch size** (translate) | 5 | `5` |
| **max_tokens** (translate) | 3000 | `3000` |
| **retry delay** | 500 ms | `500` |
| **thinking** | NOT needed (n/a for this model) | — |

---

### 0.3 kimi-k2.5 (cheaper, slower, 262K context)

Use when: need large context window, ok with slower cron.

**⚠️ CRITICAL:** `kimi-k2.5` runs in **Thinking mode** by default. Thinking mode requires `temperature: 1.0` and returns output in `reasoning_content` field (NOT `content`). **For API calls with JSON/text parsing, ALWAYS disable thinking:**

```typescript
{
  model: 'kimi-k2.5',
  temperature: 0.6,
  thinking: { type: 'disabled' },                // ← ALWAYS for API parsing!
  response_format: { type: 'json_object' },
}
```

| Case | temperature | thinking | Result |
|------|-------------|----------|--------|
| Instant mode (API parsing) | 0.6 | `{ type: 'disabled' }` | ✅ Works — output in `content` |
| Thinking mode (chat UI) | 1.0 | omitted/default | ⚠️ Output in `reasoning_content`, `content` empty |
| Broken | 0.6 | omitted/default | ❌ HTTP 400 |

| Parameter | Value | Code |
|-----------|-------|------|
| **temperature** | 0.6 (all services) | `KIMI_MODEL.startsWith('kimi-k') ? 0.6 : ...` |
| **thinking** | `{ type: 'disabled' }` | REQUIRED for all API calls |
| **timeout API** | 30 sec (sentiment), 60 sec (translate) | `30000` / `60000` |
| **batch size** (translate) | 3 (smaller = faster) | `isK2 ? 3 : 5` |
| **max_tokens** (translate) | 4000 | `isK2 ? 4000 : 3000` |
| **retry delay** | 1000 ms | `1000` |

---

### 0.4 Switching between models

#### Option A: Env var (no code change, no deploy)
```bash
# Render Dashboard → Environment → Add:
KIMI_MODEL = moonshot-v1-32k   # or kimi-k2.5
# Save → auto-redeploy in 30 sec
```

#### Option B: Code change (default fallback)
Edit 5 files (see 0.1), change `|| 'kimi-k2.5'` to `|| 'moonshot-v1-32k'`.

#### Check current model
```bash
curl https://pulse-api-bsov.onrender.com/health | jq .kimi_model
```

---

### 0.6 FINAL CONFIG (2026-06-05)

```
smartTagMatcher.ts  →  moonshot-v1-32k  (cron speed)
translate.ts        →  moonshot-v1-32k  (cron speed)
tagManager.ts       →  moonshot-v1-32k  (cron speed)
user.ts (summary)   →  kimi-k2.5        (cheaper, 10-min cache)
index.ts (/health)  →  moonshot-v1-32k  (default display)
```

| Service | Model | Temperature | Thinking |
|---------|-------|-------------|----------|
| Cron (sentiment/tags/translate) | `moonshot-v1-32k` | 0.1 / 0.3 | n/a |
| Summary | `kimi-k2.5` | 0.6 | `{ type: 'disabled' }` |

**Why:** Cron speed is critical — 2-4 min cycles. Summary has 10-min cache — speed doesn't matter, cost does.

---

### 0.7 Lesson: NEVER use thinking mode for API parsing

**What happened with summary:**
- Enabled thinking mode (temperature 1.0, thinking default)
- API returned: `{ content: "", reasoning_content: "deep analysis..." }`
- Code parsed: `content` → empty string → "Failed to generate summary"

**Rule:** All PULSE API calls parse `content` field. Thinking mode puts output in `reasoning_content`. **Always use `{ type: 'disabled' }` for API calls.**

---

### 0.5 History

| Date | Model | Temperature | Notes |
|------|-------|-------------|-------|
| Before 2026-06-05 | `moonshot-v1-32k` | 0.1 / 0.3 | Baseline |
| 2026-06-05 | `kimi-k2.5` | 1.0 | First attempt — too slow |
| 2026-06-05 | `moonshot-v1-32k` | 0.1 / 0.3 | Reverted (INC-002) |
| 2026-06-05 | `kimi-k2.5` | 0.6 | With `thinking: { type: 'disabled' }` |
| 2026-06-05 | `kimi-k2.5` | 1.0 | Summary thinking mode — **BROKEN** (reasoning_content vs content) |
| 2026-06-05 | `kimi-k2.5` | 0.6 | Summary back to Instant mode — **FIXED** |
| 2026-06-05 | **Hybrid** | see 0.6 | **FINAL: cron=moonshot, summary=kimi-k2.5** |

---

## 1. ОБЗОР АРХИТЕКТУРЫ

```
RSS Feed / External DB → Новость (title, summary, hashtags?)
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
│ External DB: extractHashtags() → mapHashtagsToTags()        │
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
              ┌──────────┴──────────┐
              │                     │
              Успех (llm)          Ошибка
              │                     │
              ▼                     ▼
┌─────────────────────────┐  ┌─────────────────────────────┐
│ STAGE 4a: ENRICHMENT    │  │ Fallback:                   │
│ Денормализация LLM      │  │ enrichment_version = 1      │
│ результатов в           │  │ (старая статья)             │
│ news_tag_links          │  └─────────────────────────────┘
│                         │
│ • keyword-ссылки        │
│ • llm_impact-ссылки     │
│ • enrichment_version=2  │
│ (атомарная транзакция)  │
└─────────────────────────┘
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
      sentiment_reasoning = CASE
        WHEN news.sentiment_source LIKE 'llm-%' 
             AND news.sentiment_source != 'llm-partial'
        THEN EXCLUDED.sentiment_reasoning
        ELSE news.sentiment_reasoning
      END,
      ...
```

---

## 3. STAGE 2: TAG MATCHING

### Layer 1: Keyword Matching (0 токенов)
```typescript
const userTags = tagManager.getEnrichedKeywords();
for (const [tagId, keywords] of userTags) {
  if (keywords.some(kw => (title + summary).toLowerCase().includes(kw))) {
    matched.push(tagId);
  }
}
```

### Layer 2: LLM Smart Matching (expensive)
Срабатывает только если Layer 1 не нашёл теги.

### External DB: Hashtag Matching (0 токенов, будущее)
```typescript
// Статья из внешней БД: "В #Сбербанке отчитались... #экономика #SBER"
const hashtags = extractHashtags(text);  // ["сбербанке", "экономика", "sber"]
const matchedTags = mapHashtagsToTags(hashtags);  // ["сбер", "россия"]
// → LLM unified batch, link_source='hashtag'
```

---

## 4. STAGE 3: LLM UNIFIED BATCH

### LLM Model: `kimi-k2.5` (since 2026-06-05)

| Параметр | `moonshot-v1-32k` (legacy) | `kimi-k2.5` (default) |
|----------|---------------------------|----------------------|
| Input цена | $1.00 / 1M tokens | **$0.60** (−40%) |
| Output цена | $3.00 / 1M tokens | **$2.50** (−17%) |
| Context window | 32K | **262K** (×8) |
| Temperature | 0.1 | **1.0** (требование модели) |
| Timeout | 15 сек | **30 сек** |

Переключение: env var `KIMI_MODEL` или дефолт в коде (`smartTagMatcher.ts`, `translate.ts`, `tagManager.ts`, `user.ts`).

### Batch Size: 5 articles per call

**2026-06-02: уменьшен с 10 → 5.** API timeout'ил на 10 статьях за 30 секунд. С 5 — ~95% success rate.

### Chunk Loop
```typescript
const BATCH_SIZE = 5;
for (let batchStart = 0; batchStart < needLLMWithIndex.length; batchStart += BATCH_SIZE) {
  const chunk = needLLMWithIndex.slice(batchStart, batchStart + BATCH_SIZE);
  try {
    const results = await analyzeUnifiedBatch(...);
  } catch (err) {
    // fallback ТОЛЬКО для этого chunk
  }
}
```

### Two-Pass JSON Parsing
```typescript
try {
  parsed = JSON.parse(raw);  // Pass 1: как есть
} catch (e1) {
  let fixed = raw.replace(/\\/g, '__ESC__');
  fixed = fixed.replace(/\n/g, '\\n');
  fixed = fixed.replace(/__ESC__/g, '\\\\');
  parsed = JSON.parse(fixed);  // Pass 2: с фиксом
}
```

---

## 5. STAGE 4a: ARTICLE ENRICHMENT (НОВОЕ — v3.0)

### Зачем

До v3.0: LLM анализировал статью → результаты шли в `news.tag_impact` (JSONB). **Поиск по тегу невозможен** — JSONB не даёт JOIN по тегу, нет индекса на `->>'tag'`.

После v3.0: Результаты LLM **денормализуются** в `news_tag_links` — реляционную таблицу. **Поиск по тегу — мгновенный**, impact score доступен, можно строить аналитику.

### Что сохраняется

| Источник | Поле | Значение |
|----------|------|----------|
| `matched_tags` (Layer 1) | `news_tag_links.tag_id` | Тег найден keyword matching |
| `matched_tags` (Layer 1) | `news_tag_links.link_source` | `'keyword'` |
| `tag_impacts[]` (LLM) | `news_tag_links.tag_id` | Тег проанализирован LLM |
| `tag_impacts[]` (LLM) | `news_tag_links.impact_score` | -10..+10 (влияние на тег) |
| `tag_impacts[]` (LLM) | `news_tag_links.impact_reasoning` | Почему такой score |
| `tag_impacts[]` (LLM) | `news_tag_links.link_source` | `'llm_impact'` |
| External DB hashtag | `news_tag_links.link_source` | `'hashtag'` (будущее) |
| — | `news_tag_links.link_version` | 1 (для будущих пересчётов) |
| — | `news.enrichment_version` | 2 (статья обогащена v3.0) |

### Таблица news_tag_links

```sql
CREATE TABLE news_tag_links (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  news_id         UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  tag_id          VARCHAR(50) NOT NULL,
  impact_score    INTEGER,              -- из tag_impacts[i].score
  impact_reasoning TEXT,                -- из tag_impacts[i].reasoning
  link_source     VARCHAR(20) NOT NULL DEFAULT 'keyword',
    -- 'keyword'    = matched_tags (Layer 1)
    -- 'llm_impact' = из unified batch tag_impacts
    -- 'hashtag'    = из внешней БД (#тег)
    -- 'related'    = денормализация related_tags
    -- 'user'       = ручное назначение
  link_version    INTEGER DEFAULT 1,
  linked_at       TIMESTAMP DEFAULT NOW(),
  UNIQUE(news_id, tag_id, link_source)
);
```

### Значения link_source

| Значение | Откуда | Пример |
|----------|--------|--------|
| `'keyword'` | Layer 1: keyword matching нашёл тег в тексте | `"apple"` найдено в title |
| `'llm_impact'` | Layer 3: LLM оценил влияние тега в unified batch | `"apple"` → score=8, reasoning="Earnings beat" |
| `'hashtag'` | External DB: текст содержал `#тег` | `#сбер` → `"сбер"` |
| `'related'` | Денормализация: тег связан с matched (будущее) | `"iphone"` связан с `"apple"` |
| `'user'` | Ручное назначение админом | — |

### Транзакция (атомарность)

```typescript
const client = await pool.connect();
try {
  await client.query('BEGIN');
  
  // 1. Batch INSERT keyword-ссылок
  await client.query(
    `INSERT INTO news_tag_links (news_id, tag_id, link_source)
     SELECT $1, unnest($2::text[]), 'keyword'`,
    [newsId, matchedTags]
  );
  
  // 2. Batch INSERT llm_impact-ссылок
  await client.query(
    `INSERT INTO news_tag_links (news_id, tag_id, impact_score, impact_reasoning, link_source)
     SELECT $1, tag, score, reasoning, 'llm_impact'
     FROM unnest($2::text[], $3::int[], $4::text[]) AS t(tag, score, reasoning)`,
    [newsId, validImpacts.map(t => t.tag), validImpacts.map(t => t.score), validImpacts.map(t => t.reasoning)]
  );
  
  // 3. Помечаем статью обогащённой
  await client.query(
    'UPDATE news SET enrichment_version = 2 WHERE id = $1',
    [newsId]
  );
  
  await client.query('COMMIT');
} catch (e) {
  await client.query('ROLLBACK');  // ← атомарность
  throw e;
} finally {
  client.release();
}
```

**Важно:** Если транзакция упала — статья остаётся с `enrichment_version = 1` (или NULL). Поиск найдёт её через старый JSONB путь (`tag_impact`). **Ничего не ломается.**

### Fallback: что если populate упал

| Что | Результат |
-----|----------|
| Статья | ✅ Сохранена со `sentiment_source='llm'` |
| `tag_impact` JSONB | ✅ Заполнен |
| `news_tag_links` | ❌ Нет записей |
| `enrichment_version` | ❌ 1 (не 2) |
| Поиск | ✅ Работает через JSONB (старая часть UNION) |

---

## 6. ГИБРИДНОЕ ХРАНИЛИЩЕ (v1 + v2)

### Почему гибридное

Мы НЕ пересчитываем старые статьи (экономим токены). Старые статьи ищутся через `tag_impact` JSONB, новые — через `news_tag_links`.

### SQL: поиск по тегу

```sql
WITH combined AS (
  -- Часть 1: НОВЫЕ статьи (v2, enrichment_version = 2)
  SELECT 
    n.id, n.title_ru, n.summary_ru, n.source, n.published_at,
    n.sentiment, n.sentiment_score,
    l.impact_score, l.impact_reasoning,
    CASE l.link_source
      WHEN 'llm_impact' THEN 0
      WHEN 'keyword'    THEN 1
      ELSE 2
    END as source_priority
  FROM news n
  JOIN news_tag_links l ON l.news_id = n.id
  WHERE l.tag_id = 'nvidia'
    AND n.published_at > NOW() - INTERVAL '7 days'

  UNION ALL

  -- Часть 2: СТАРЫЕ статьи (v1, enrichment_version IS NULL OR < 2)
  SELECT 
    n.id, n.title_ru, n.summary_ru, n.source, n.published_at,
    n.sentiment, n.sentiment_score,
    (t->>'score')::int as impact_score,
    t->>'reasoning' as impact_reasoning,
    99 as source_priority
  FROM news n,
  LATERAL jsonb_array_elements(n.tag_impact) t
  WHERE n.tag_impact @> '[{"tag": "nvidia"}]'     -- GIN index!
    AND t->>'tag' = 'nvidia'                         -- точное совпадение
    AND (n.enrichment_version IS NULL OR n.enrichment_version < 2)
    AND n.published_at > NOW() - INTERVAL '7 days'
)
SELECT DISTINCT ON (id) *
FROM combined
ORDER BY id, source_priority, published_at DESC
LIMIT 50;
```

### source_priority — приоритет источника

| Приоритет | Значение | Когда выбирается |
|-----------|----------|-----------------|
| 0 (высший) | `llm_impact` | LLM анализировал этот тег — лучший контекст |
| 1 | `keyword` | Тег найден keyword matching |
| 2 | `hashtag` / другие | Внешняя БД |
| 99 | старые статьи | JSONB путь (нет source_priority) |

---

## 7. КЛАССИФИКАЦИЯ ОШИБОК (sentiment_source)

| Значение | Когда | enrichment_version |
|----------|-------|-------------------|
| `'llm'` | Успех, полный batch | 2 (если populate сработал) |
| `'llm-partial'` | Успех, неполный batch | 2 (если populate сработал) |
| `'llm-timeout'` | ETIMEDOUT | 1 или NULL |
| `'llm-rate-limit'` | 429 | 1 или NULL |
| `'llm-parse'` | JSON.parse упал | 1 или NULL |
| `'llm-empty'` | Пустой results[] | 1 или NULL |
| `'llm-error'` | Другая ошибка | 1 или NULL |
| `'keyword'` | Нет тегов — LLM не вызывался | 1 или NULL |

---

## 8. DEFERRED PROCESSOR

```typescript
cron.schedule('*/10 * * * *', async () => {
  const failed = await query(`
    SELECT id, title_ru, matched_tags
    FROM news
    WHERE llm_error IS NOT NULL
      AND llm_attempts IS NOT NULL
      AND llm_attempts < 3
      AND (last_retry_at IS NULL 
           OR last_retry_at < NOW() - INTERVAL '30 minutes')
    LIMIT 20
  `);
  // При успехе: llm_error=NULL, sentiment_source='llm', populateNewsTagLinks() вызовется
});
```

---

## 9. КРИТИЧЕСКИЕ БАГИ — ИСТОРИЯ

### Баг 1-5: [см. предыдущие версии]

### Баг 6: Основной cron без chunk loop
**Причина:** Один вызов на 65 статей → timeout.
**Фикс:** Chunk loop `BATCH_SIZE = 5`.

### Баг 7: JWT_SECRET mismatch
**Причина:** `'dev-secret'` vs `'your-secret-key'`.
**Фикс:** Унифицирован дефолт.

### Баг 8: N+1 INSERT в populateNewsTagLinks (ТЗ v2.0)
**Причина:** Цикл `for (tag of matchedTags) { await query('INSERT ...') }` — 30 запросов на статью.
**Фикс:** Batch `unnest()` — 2 запроса.

### Баг 9: DISTINCT ON + UNION ALL (ТЗ v2.0)
**Причина:** `DISTINCT ON` перед `UNION ALL` — syntax error в PostgreSQL.
**Фикс:** CTE + `DISTINCT ON` в финальном SELECT.

### 🚨 Баг 10: CRON FREEZE — pool exhaustion (2026-06-05)
**Полный runbook:** [INCIDENTS.md — INC-001](INCIDENTS.md#inc-001-cron-freeze--postgresql-pool-exhaustion)

Кратко: `await pool.connect()` внутри for-loop 60 статей при pool=10 → deadlock → cascade freeze всех циклов.

**Фикс:** `populateNewsTagLinksBatch()` — 1 connection на весь batch после цикла (fire-and-forget).

---

## 10. МЕТРИКИ КОНТРОЛЯ

### Нормальные показатели
| Метрика | Хорошо | Плохо |
|---------|--------|-------|
| success_rate | > 95% | < 90% |
| batch_size | 5 | > 5 |
| llm-timeout | 0 | > 5 |
| **enrichment_version=2 / total_llm** | **> 90%** | **< 50%** |

### Проверка enrichment
```sql
-- Соотношение v2 к общему числу llm-статей
SELECT 
  COUNT(*) FILTER (WHERE enrichment_version = 2) as v2,
  COUNT(*) FILTER (WHERE sentiment_source LIKE 'llm%') as total_llm
FROM news;
```

---

*Документ создан: 2026-06-02*
*Версия 9.0 — Article Enrichment v3.0 (news_tag_links, гибридное хранилище)*
*Версия 9.1 — переключение на kimi-k2.5, добавлен runbook CRON FREEZE*

> **⚠️ ВАЖНО: Пос
---

## 11. SQL BEST PRACTICES

### 11.1 ❌ NEVER use COALESCE for partial UPDATE

**Hard rule:** For partial updates, always use `CASE WHEN $N IS NOT NULL`, never `COALESCE($N, column)`.

```sql
-- ❌ WRONG — silently overwrites with [] / {} / '':
UPDATE tags SET keywords = COALESCE($2, keywords) WHERE id = $1;
-- $2 = [] → keywords becomes [] (data loss!)

-- ✅ CORRECT — only updates when field is explicitly sent:
UPDATE tags SET keywords = CASE WHEN $2 IS NOT NULL THEN $2 ELSE keywords END WHERE id = $1;
-- $2 = null → keywords unchanged (partial update works)
-- $2 = [] → keywords = [] (but caught by validation minItems)
```

**Why COALESCE fails:**

| `$param` value | `COALESCE($param, old)` | `CASE WHEN $param IS NOT NULL...` |
|---------------|------------------------|-----------------------------------|
| `null` | `old` ✅ | `old` ✅ |
| `['foo']` | `['foo']` ✅ | `['foo']` ✅ |
| `[]` | `[]` ❌ **silent overwrite** | `[]` ✅ (validation catches it) |
| `''` | `''` ❌ **silent overwrite** | `''` ✅ (validation catches it) |
| `{}` | `{}` ❌ **silent overwrite** | `{}` ✅ (validation catches it) |

**Applies to:** arrays (`text[]`, `varchar[]`), JSONB, and even `text` fields.

**Full reference:** [INCIDENTS.md — INC-004](INCIDENTS.md#inc-004-coalesce-partial-update-bug)

### 11.2 Code review checklist for UPDATE statements

- [ ] Any `COALESCE($param, column)` in UPDATE? → RED FLAG
- [ ] Arrays/JSONB/text fields use `CASE WHEN`?
- [ ] Validation happens BEFORE SQL (not after)?
- [ ] Test with `[]`, `{}`, `''` as input — does it preserve old value?

---

*Документ создан: 2026-06-02*
*Версия 9.2 — добавлен SQL Best Practices (COALESCE rule)*
*Версия 9.1 — переключение на kimi-k2.5, добавлен runbook CRON FREEZE*
*Версия 9.0 — Article Enrichment v3.0 (news_tag_links, гибридное хранилище)*
