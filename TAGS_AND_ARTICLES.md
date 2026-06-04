# PULSE — Теги и Статьи: Полная архитектура и спецификация

> **Версия:** 9.0
> **Дата:** 2026-06-04
> **Статус:** Production
> **Файлы:** `cron.ts`, `smartTagMatcher.ts`, `enrichment.ts`, `index.ts`

---

## Содержание

1. [Обзор архитектуры](#1-обзор-архитектуры)
2. [Схема данных](#2-схема-данных)
3. [Полный pipeline обработки статьи](#3-полный-pipeline-обработки-статьи)
4. [Tag Matching (3 уровня)](#4-tag-matching-3-уровня)
5. [LLM Unified Batch](#5-llm-unified-batch)
6. [Article Enrichment v3.0](#6-article-enrichment-v30)
7. [Гибридное хранилище и поиск](#7-гибридное-хранилище-и-поиск)
8. [Полная спецификация полей](#8-полная-спецификация-полей)
9. [Классификация ошибок](#9-классификация-ошибок)
10. [API Endpoints](#10-api-endpoints)
11. [Метрики и мониторинг](#11-метрики-и-мониторинг)
12. [Чеклисты](#12-чеклисты)

---

## 1. Обзор архитектуры

### 1.1 Целевая модель

Каждая статья проходит через конвейер из 5 стадий. На выходе — структурированные данные, пригодные для поиска, аналитики и персонализации.

```
┌─────────────────────────────────────────────────────────────────┐
│                         STAGE 1: DEDUP                           │
│  content_hash = SHA256(title + summary)                          │
│  ON CONFLICT (content_hash) → UPDATE all_sources, source_count   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│                      STAGE 2: TAG MATCHING                       │
│  Layer 1: Keyword matching (0 токенов)                          │
│  Layer 2: LLM smart matching (expensive, fallback)              │
│  Layer 3: Hashtag matching (0 токенов, external DB)           │
│  Результат: matched_tags[]                                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│                   STAGE 3: LLM UNIFIED BATCH                     │
│  1 запрос = 5 статей × (sentiment + reasoning + tag_impacts)    │
│  Batch size: 5 (раньше 10 — timeout)                           │
│  Timeout: 30000ms                                               │
│  Язык: English (prompt и response)                              │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│                      STAGE 4: SAVE TO DB                         │
│  ON CONFLICT (content_hash) DO UPDATE                            │
│  CASE WHEN: reasoning обновляется ТОЛЬКО при llm-ошибке        │
│  Fallback: keyword (score=0, reasoning=NULL)                    │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│              STAGE 4a: ARTICLE ENRICHMENT (v3.0)                 │
│  Атомарная транзакция:                                          │
│    1. INSERT keyword-ссылки (link_source='keyword')              │
│    2. INSERT llm_impact-ссылки (link_source='llm_impact')        │
│    3. UPDATE enrichment_version = 2                              │
│  Если транзакция упала → fallback к JSONB (enrichment_version=1) │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│               STAGE 5: DEFERRED PROCESSOR                        │
│  Перепробует failed статьи каждые 10 мин                         │
│  Max 3 попытки, 30 мин между retries                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Схема данных

### 2.1 Таблица `news` — основная таблица статей

| Колонка | Тип | Nullable | Описание |
|---------|-----|----------|----------|
| `id` | UUID | NO | Первичный ключ, генерируется автоматически |
| `title_original` | VARCHAR(500) | YES | Оригинальный заголовок (EN если исходный EN) |
| `title_ru` | VARCHAR(500) | YES | Перевод на русский (Kimi API) |
| `summary_ru` | TEXT | YES | Перевод summary на русский |
| `source` | VARCHAR(50) | NO | RSS-источник (bloomberg, interfax, ...) |
| `source_id` | VARCHAR(200) | YES | GUID из RSS feed |
| `url` | VARCHAR(500) | NO | Оригинальный URL статьи |
| `url_normalized` | VARCHAR(500) | NO | Нормализованный URL (для дедупликации) |
| `content_hash` | VARCHAR(64) | NO | SHA256(title + summary), UNIQUE |
| `all_sources` | TEXT[] | NO | Все источники дубликатов |
| `source_count` | INTEGER | NO DEFAULT 1 | Сколько источников нашли эту статью |
| `published_at` | TIMESTAMP | NO | Время публикации (из RSS) |
| `lang_original` | VARCHAR(10) | YES | Язык оригинала (en, ru) |
| `sentiment` | VARCHAR(20) | YES | positive / negative / neutral |
| `sentiment_score` | INTEGER | YES | -10..+10 (числовая оценка) |
| `sentiment_reasoning` | TEXT | YES | 3 параграфа анализа (English) |
| `sentiment_source` | VARCHAR(20) | YES | Откуда результат (llm, llm-partial, keyword, llm-timeout, ...) |
| `llm_error` | VARCHAR(50) | YES | Тип ошибки LLM (timeout, rate-limit, parse, ...) |
| `llm_attempts` | INTEGER | YES | Сколько попыток было (max 3) |
| `llm_raw_preview` | TEXT | YES | Сырой ответ LLM (последние 2000 символов) |
| `llm_batch_size` | INTEGER | YES | Сколько статей было в батче |
| `llm_results_count` | INTEGER | YES | Сколько результатов вернул LLM |
| `is_political` | BOOLEAN | YES | Политическая новость? |
| `article_type` | VARCHAR(20) | YES | micro (1-2 тега) / macro (3+ тега, широкое влияние) |
| `matched_tags` | TEXT[] | YES | Теги найденные Layer 1/2/3 |
| `tag_impact` | JSONB | YES | `[{"tag": "apple", "score": 8, "reasoning": "..."}]` |
| **enrichment_version** | **INTEGER** | **YES DEFAULT 1** | **1 = старая статья (JSONB), 2 = обогащённая (news_tag_links)** |
| `created_at` | TIMESTAMP | NO DEFAULT NOW() | Время создания записи |
| `updated_at` | TIMESTAMP | NO DEFAULT NOW() | Время последнего обновления |

**Индексы на `news`:**
- `PRIMARY KEY (id)`
- `UNIQUE (content_hash)` — дедупликация
- `idx_news_published_at` — сортировка по времени
- `idx_news_source` — фильтр по источнику
- `idx_news_matched_tags` — GIN на TEXT[]
- `idx_news_tag_impact_gin` — GIN на JSONB (для поиска по тегу в старых статьях)
- `idx_news_enrichment_version` — фильтр v1/v2

### 2.2 Таблица `news_tag_links` — связь статья-тег (v3.0)

| Колонка | Тип | Nullable | Описание |
|---------|-----|----------|----------|
| `id` | UUID | NO | Первичный ключ |
| `news_id` | UUID | NO | Ссылка на `news.id` (ON DELETE CASCADE) |
| `tag_id` | VARCHAR(50) | NO | ID тега (apple, sber, россия, ...) |
| `impact_score` | INTEGER | YES | -10..+10, влияние на этот конкретный тег |
| `impact_reasoning` | TEXT | YES | 1 предложение — почему такой score |
| `link_source` | VARCHAR(20) | NO DEFAULT 'keyword' | Откуда взялась связь |
| `link_version` | INTEGER | NO DEFAULT 1 | Версия обогащения (для будущих пересчётов) |
| `linked_at` | TIMESTAMP | NO DEFAULT NOW() | Когда связь создана |

**Ограничение:** `UNIQUE (news_id, tag_id, link_source)` — один тег может иметь несколько связей с разными source.

**Индексы:**
- `PRIMARY KEY (id)`
- `idx_news_tag_links_news_id` — поиск всех тегов статьи
- `idx_news_tag_links_tag_id` — поиск всех статей по тегу

### 2.3 Таблица `user_defined_tags` — пользовательские теги

| Колонка | Тип | Nullable | Описание |
|---------|-----|----------|----------|
| `tag_id` | VARCHAR(50) | NO | Первичный ключ (apple, sber, россия) |
| `tag_name` | VARCHAR(100) | NO | Отображаемое имя (Apple, Сбер) |
| `tag_type` | VARCHAR(20) | NO | company / sector / person / commodity |
| `keywords` | TEXT[] | YES | Ключевые слова для Layer 1 matching |
| `enriched_data` | JSONB | YES | `{ticker, related_entities, synonyms, ...}` |
| `created_at` | TIMESTAMP | NO DEFAULT NOW() | Когда создан |
| `updated_at` | TIMESTAMP | NO DEFAULT NOW() | Когда обновлён |

### 2.4 Таблица `portfolios` — подписки пользователей на теги

| Колонка | Тип | Nullable | Описание |
|---------|-----|----------|----------|
| `user_id` | UUID | NO | Ссылка на `users.id` |
| `tag_id` | VARCHAR(50) | NO | Ссылка на `user_defined_tags.tag_id` |
| `tag_name` | VARCHAR(100) | NO | Копия имени тега (денормализация) |
| `tag_type` | VARCHAR(20) | NO | Тип тега |
| `created_at` | TIMESTAMP | NO DEFAULT NOW() | Когда подписался |

**Первичный ключ:** `(user_id, tag_id)`

---

## 3. Полный pipeline обработки статьи

### 3.1 Stage 1: Dedup (content_hash)

```typescript
const contentHash = crypto
  .createHash('sha256')
  .update(title + '\n' + summary)
  .digest('hex');
```

**ON CONFLICT логика:**
- Новая статья → INSERT
- Дубликат (тот же content_hash) → UPDATE all_sources[], source_count++
- Reasoning обновляется ТОЛЬКО если предыдущий результат был LLM-ошибкой

### 3.2 Stage 2: Tag Matching (3 уровня)

#### Layer 1: Keyword Matching (0 токенов)

```typescript
// tagManager.getEnrichedKeywords() возвращает Map<tag_id, keywords[]>
// Например: "apple" → ["apple", "aapl", "tim cook", "iphone maker"]

for (const [tagId, keywords] of userTags) {
  if (keywords.some(kw => (title + summary).toLowerCase().includes(kw))) {
    matched.push(tagId);
  }
}
```

**Сложность:** O(T × K × L) где T — теги, K — keywords/тег, L — длина текста.

#### Layer 2: LLM Smart Matching (expensive fallback)

Срабатывает ТОЛЬКО если Layer 1 не нашёл теги. Отдельный LLM call.

#### Layer 3: Hashtag Matching (0 токенов, external DB)

```typescript
// Статья из внешней БД: "В #Сбербанке отчитались... #экономика #SBER"
const hashtags = extractHashtags(text);  // ["сбербанке", "экономика", "sber"]
// mapHashtagsToTags: exact match по tag_id или keywords
```

### 3.3 Stage 3: LLM Unified Batch

**Prompt (English):**
```
You are an experienced investment analyst. Analyze each article.

For EACH relevant tag provide:
- score (-10 to +10)
- reasoning (1 sentence)

Tags: ${tags.join(', ')}

Return JSON: {"results": [{"score": N, "reasoning": "...", "tag_impacts": [{"tag": "...", "score": N, "reasoning": "..."}]}]}
```

**Параметры:**
- Batch size: 5
- Timeout: 30000ms
- Max retries: 3
- Language: English (prompt и response)

### 3.4 Stage 4: Save to DB

**ON CONFLICT (content_hash) DO UPDATE** с CASE WHEN:
```sql
sentiment_reasoning = CASE
  WHEN news.sentiment_source LIKE 'llm-%' AND news.sentiment_source != 'llm-partial'
  THEN EXCLUDED.sentiment_reasoning
  ELSE news.sentiment_reasoning
END
```

### 3.5 Stage 4a: Article Enrichment (v3.0)

**Только для:** `sentiment_source IN ('llm', 'llm-partial')`

**Атомарная транзакция:**
1. `INSERT INTO news_tag_links ... link_source='keyword'` — все matched_tags
2. `INSERT INTO news_tag_links ... link_source='llm_impact'` — все tag_impacts
3. `UPDATE news SET enrichment_version = 2 WHERE id = $1`

**Если транзакция упала:**
- enrichment_version остаётся 1 (или NULL)
- Статья доступна через старый JSONB путь
- Поиск работает (старая часть UNION)

### 3.6 Stage 5: Deferred Processor

```
Каждые 10 минут:
  1. Найти статьи с llm_error IS NOT NULL AND llm_attempts < 3
  2. Фильтр: last_retry_at IS NULL OR last_retry_at < NOW() - 30 мин
  3. Max 20 статей за цикл
  4. Повторить LLM unified batch
  5. При успехе: llm_error=NULL, sentiment_source='llm', populateNewsTagLinks()
```

---

## 4. Tag Matching: 3 уровня детально

### 4.1 Layer 1: Keyword Matching

**Как работает:**
```typescript
// Загружаем все теги с их keywords
const userTags = tagManager.getEnrichedKeywords();
// Map: "apple" → ["apple", "aapl", "tim cook", "iphone maker", "cupertino"]

// Для каждой статьи проверяем все теги
const matched: string[] = [];
for (const [tagId, keywords] of userTags) {
  const text = (article.title + ' ' + article.summary).toLowerCase();
  if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
    matched.push(tagId);
  }
}
```

**Когда срабатывает:** Всегда, для всех статей.

**Стоимость:** 0 токенов.

**Точность:** Высокая (exact match keywords).

**Ограничение:** Только теги с заполненными keywords.

### 4.2 Layer 2: LLM Smart Matching

**Когда срабатывает:** Только если Layer 1 вернул пустой результат.

**Стоимость:** ~$0.002-0.005 за статью.

**Prompt:**
```
Analyze this article. Which of these tags are relevant?
Tags: [список всех тегов платформы]

Return JSON: {"matched_tags": ["tag1", "tag2"]}
```

### 4.3 Layer 3: Hashtag Matching (External DB)

**Когда срабатывает:** Для статей из внешней PostgreSQL.

**Как работает:**
```typescript
function extractHashtags(text: string): string[] {
  const matches = text.match(/#(\w+)/g);
  return matches ? matches.map(m => m.slice(1).toLowerCase()) : [];
}

// "В #Сбербанке отчитались... #экономика #SBER"
// → ["сбербанке", "экономика", "sber"]

function mapHashtagsToTags(hashtags: string[]): string[] {
  const matched: string[] = [];
  for (const h of hashtags) {
    // Exact match по tag_id
    if (allTags.has(h)) matched.push(h);
    // Match по keywords
    else {
      for (const [tagId, keywords] of userTags) {
        if (keywords.includes(h)) { matched.push(tagId); break; }
      }
    }
  }
  return [...new Set(matched)]; // dedup
}
```

**Стоимость:** 0 токенов.

**link_source:** `'hashtag'`

---

## 5. LLM Unified Batch

### 5.1 Параметры

| Параметр | Значение |
|----------|----------|
| Batch size | 5 (раньше 10 — timeout) |
| Timeout | 30000ms |
| Max retries | 3 |
| Language | English |
| Model | moonshot-v1-32k |

### 5.2 Chunk Loop

```typescript
const BATCH_SIZE = 5;

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
  } catch (err) {
    // fallback ТОЛЬКО для этого chunk
  }
}
```

### 5.3 Two-Pass JSON Parsing

```typescript
let parsed: any;
try {
  parsed = JSON.parse(raw);  // Pass 1: как есть
} catch (e1) {
  let fixed = raw.replace(/\\/g, '__ESC__');
  fixed = fixed.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  fixed = fixed.replace(/__ESC__/g, '\\\\');
  parsed = JSON.parse(fixed);  // Pass 2: с фиксом
}
```

### 5.4 Результат (UnifiedResult)

| Поле | Тип | Описание |
|------|-----|----------|
| `sentiment` | 'positive' \| 'negative' \| 'neutral' | Общий sentiment |
| `score` | number | -10..+10 |
| `reasoning` | string | 3 параграфа (facts + direct impact + secondary) |
| `is_political` | boolean | Политическая новость? |
| `article_type` | 'micro' \| 'macro' | micro = 1-2 тега, macro = 3+ широкое влияние |
| `tag_impacts` | TagImpact[] | Влияние на каждый тег |

**TagImpact:**
| Поле | Тип | Описание |
|------|-----|----------|
| `tag` | string | ID тега |
| `score` | number | -10..+10 (влияние на этот тег) |
| `reasoning` | string | 1 предложение — почему |

---

## 6. Article Enrichment v3.0

### 6.1 Зачем

**До v3.0:** LLM результаты шли в `news.tag_impact` (JSONB). Поиск по тегу — невозможен (нет JOIN, нет индекса на `->>'tag'`).

**После v3.0:** Результаты денормализуются в `news_tag_links`. Поиск — мгновенный, аналитика — полная.

### 6.2 populateNewsTagLinks() — полная реализация

```typescript
async function populateNewsTagLinks(
  newsId: string,
  matchedTags: string[],
  tagImpacts: TagImpact[],
): Promise<void> {
  if (!pool) return;  // SQLite — skip

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Keyword-ссылки
    if (matchedTags.length > 0) {
      await client.query(
        `INSERT INTO news_tag_links (news_id, tag_id, link_source)
         SELECT $1, unnest($2::text[]), 'keyword'
         ON CONFLICT DO NOTHING`,
        [newsId, matchedTags]
      );
    }

    // 2. LLM impact-ссылки (фильтр пустых)
    const valid = tagImpacts.filter(
      ti => !(ti.score === 0 && (!ti.reasoning || ti.reasoning.trim() === ''))
    );
    if (valid.length > 0) {
      await client.query(
        `INSERT INTO news_tag_links 
           (news_id, tag_id, impact_score, impact_reasoning, link_source)
         SELECT $1, tag, score, reasoning, 'llm_impact'
         FROM unnest($2::text[], $3::int[], $4::text[]) AS t(tag, score, reasoning)
         ON CONFLICT DO UPDATE SET
           impact_score = EXCLUDED.impact_score,
           impact_reasoning = EXCLUDED.impact_reasoning`,
        [newsId, valid.map(t => t.tag), valid.map(t => t.score), valid.map(t => t.reasoning)]
      );
    }

    // 3. Помечаем обогащённой
    await client.query(
      'UPDATE news SET enrichment_version = 2 WHERE id = $1',
      [newsId]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
```

### 6.3 Значения link_source

| Значение | Откуда | Когда |
|----------|--------|-------|
| `'keyword'` | Layer 1 keyword matching | Тег найден в тексте по keywords |
| `'llm_impact'` | Unified batch tag_impacts | LLM оценил влияние тега |
| `'hashtag'` | External DB extractHashtags | Тег из #хештега внешней БД |
| `'related'` | related_entities денормализация | Связанный тег (будущее) |
| `'user'` | Ручное назначение | Админ добавил |

### 6.4 Fallback при ошибке

| | Успех | Ошибка populate |
|---|-------|----------------|
| enrichment_version | 2 | 1 (или NULL) |
| news_tag_links | Заполнены | Пусто |
| tag_impact JSONB | Заполнен | Заполнен |
| Поиск | Через news_tag_links | Через tag_impact JSONB |

---

## 7. Гибридное хранилище и поиск

### 7.1 Почему гибридное

Мы НЕ пересчитываем старые статьи (экономим токены). Старые — в JSONB, новые — в news_tag_links.

### 7.2 SQL поиск

```sql
WITH combined AS (
  -- Часть 1: НОВЫЕ статьи (v2, enrichment_version = 2)
  SELECT n.*, l.impact_score, l.impact_reasoning,
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

  -- Часть 2: СТАРЫЕ статьи (v1)
  SELECT n.*, (t->>'score')::int, t->>'reasoning', 99
  FROM news n,
  LATERAL jsonb_array_elements(n.tag_impact) t
  WHERE n.tag_impact @> jsonb_build_array(jsonb_build_object('tag', 'nvidia'))
    AND t->>'tag' = 'nvidia'
    AND (n.enrichment_version IS NULL OR n.enrichment_version < 2)
    AND n.published_at > NOW() - INTERVAL '7 days'
)
SELECT DISTINCT ON (id) *
FROM combined
ORDER BY id, source_priority, published_at DESC
LIMIT 50;
```

### 7.3 source_priority

| Приоритет | Значение | Почему |
|-----------|----------|--------|
| 0 | `llm_impact` | Лучший контекст — LLM анализировал |
| 1 | `keyword` | Тег найден, но LLM не оценивал |
| 2 | `hashtag` / другие | Внешний источник |
| 99 | Старые статьи | JSONB путь — нет source_priority |

---

## 8. Полная спецификация полей

### 8.1 Поля `news` — детально

#### `sentiment_source` — откуда результат

| Значение | Когда | enrichment_version | Описание |
|----------|-------|-------------------|----------|
| `'llm'` | Успех, полный batch | 2 (если populate ок) | Все статьи в батче проанализированы |
| `'llm-partial'` | Успех, неполный batch | 2 (если populate ок) | Часть статей — fallback |
| `'llm-timeout'` | ETIMEDOUT | 1 | Timeout 30 секунд |
| `'llm-rate-limit'` | HTTP 429 | 1 | Rate limit Kimi API |
| `'llm-parse'` | JSON.parse упал | 1 | Невалидный JSON от LLM |
| `'llm-empty'` | Пустой results[] | 1 | LLM вернул пустой массив |
| `'llm-error'` | Другая ошибка | 1 | Любая другая ошибка |
| `'keyword'` | Нет тегов | 1 | Layer 1 не нашёл теги, LLM не вызывался |

#### `article_type` — тип статьи

| Значение | Когда | Описание |
|----------|-------|----------|
| `'micro'` | 1-2 тега, узкое влияние | Конкретная компания/событие |
| `'macro'` | 3+ тега, широкое влияние | Рыночное событие, сектор |

#### `enrichment_version` — версия обогащения

| Значение | Что значит | Где ищем теги |
|----------|-----------|---------------|
| `NULL` | Старая статья (до v3.0) | `tag_impact` JSONB |
| `1` | Старая статья или populate упал | `tag_impact` JSONB |
| `2` | Обогащённая статья (v3.0) | `news_tag_links` + `tag_impact` |

### 8.2 Поля `news_tag_links` — детально

#### `impact_score` — влияние на тег

| Значение | Интерпретация |
|----------|--------------|
| +10 | Максимально позитивное |
| +5..+9 | Сильно позитивное |
| +1..+4 | Слабо позитивное |
| 0 | Нейтральное (фильтруется при populate) |
| -1..-4 | Слабо негативное |
| -5..-9 | Сильно негативное |
| -10 | Максимально негативное |

#### `impact_reasoning` — почему такой score

Примеры:
- `"Earnings beat 15% above consensus drives investor optimism"`
- `"Sanctions announcement directly impacts revenue streams"`
- `"Fed rate cut lifts entire tech sector including Apple"`

---

## 9. Классификация ошибок

### 9.1 LLM ошибки (sentiment_source)

| Код | Причина | Retry? | Митигация |
|-----|---------|--------|-----------|
| `llm-timeout` | 30 секунд прошло | Да (deferred) | Уменьшить batch size |
| `llm-rate-limit` | HTTP 429 | Да (deferred) | exponential backoff |
| `llm-parse` | JSON.parse упал | Да (deferred) | Two-pass parsing |
| `llm-empty` | Пустой results[] | Да (deferred) | Проверить prompt |
| `llm-error` | Другая ошибка | Да (deferred) | Логировать |

### 9.2 Populate ошибки (enrichment)

| Код | Причина | Retry? | Fallback |
|-----|---------|--------|----------|
| Transaction deadlock | Конкурентный доступ | Нет | JSONB поиск |
| Connection lost | Pool connection dropped | Нет | JSONB поиск |
| Constraint violation | UNIQUE conflict | Нет | JSONB поиск |

---

## 10. API Endpoints

### 10.1 GET /news/search?tag={tag}&days={days}&limit={limit}

**Гибридный поиск по тегу.** Ищет в новых (news_tag_links) и старых (tag_impact JSONB) статьях.

**Параметры:**
| Параметр | Тип | Default | Max | Описание |
|----------|-----|---------|-----|----------|
| `tag` | string | — | — | ID тега (nvidia, apple, сбер) |
| `days` | integer | 7 | 90 | За сколько дней искать |
| `limit` | integer | 50 | 100 | Максимум результатов |

**Ответ:**
```json
{
  "tag": "nvidia",
  "days": 7,
  "count": 23,
  "articles": [
    {
      "id": "...",
      "title_ru": "NVIDIA отчиталась...",
      "impact_score": 8,
      "impact_reasoning": "Earnings beat 15% above consensus",
      "published_at": "2026-06-04T10:00:00Z"
    }
  ]
}
```

### 10.2 POST /migrate-v3-enrichment

**Запускает миграцию schema.** Требует `x-trigger-secret`.

**Создаёт:**
- `news_tag_links` таблицу
- `news.enrichment_version` колонку
- 4 индекса

### 10.3 Admin endpoints

| Endpoint | Метод | Описание |
|----------|-------|----------|
| `/admin/llm-dashboard` | GET | KPI, errors, hourly trend |
| `/admin/llm-errors` | GET | Failed articles |
| `/admin/backfill` | POST | Переобработать тег |
| `/admin/source-stats` | GET | Статистика по RSS-источникам |
| `/admin/users` | GET | Список пользователей |
| `/admin/users/:id` | GET | Детали пользователя |
| `/admin/tags` | GET | Список тегов с агрегатами |
| `/admin/tags/:tagId` | GET | Детали тега |

---

## 11. Метрики и мониторинг

### 11.1 Нормальные показатели

| Метрика | Хорошо | Тревога | Критично |
|---------|--------|---------|----------|
| LLM success rate | > 95% | < 90% | < 70% |
| Batch size | 5 | > 5 | > 10 |
| llm-timeout | 0 | > 5/час | > 20/час |
| enrichment_version=2 / total_llm | > 90% | < 70% | < 50% |
| populate failure rate | < 1% | > 5% | > 20% |

### 11.2 Ключевые SQL-запросы для мониторинга

```sql
-- Соотношение v2 к total llm
SELECT 
  COUNT(*) FILTER (WHERE enrichment_version = 2) as v2,
  COUNT(*) FILTER (WHERE sentiment_source LIKE 'llm%') as total_llm,
  ROUND(100.0 * COUNT(*) FILTER (WHERE enrichment_version = 2) / 
    NULLIF(COUNT(*) FILTER (WHERE sentiment_source LIKE 'llm%'), 0), 1) as ratio_pct
FROM news;

-- populate failures за последний час
SELECT COUNT(*) 
FROM news 
WHERE sentiment_source IN ('llm', 'llm-partial')
  AND (enrichment_version IS NULL OR enrichment_version < 2)
  AND created_at > NOW() - INTERVAL '1 hour';

-- Распределение по link_source
SELECT link_source, COUNT(*) 
FROM news_tag_links 
GROUP BY link_source;
```

---

## 12. Чеклисты

### 12.1 Разработка

- [ ] Таблица `news_tag_links` создана
- [ ] Колонка `enrichment_version` добавлена
- [ ] GIN индекс на `tag_impact`
- [ ] `pool` экспортирован из `db.ts`
- [ ] `populateNewsTagLinks()` реализована
- [ ] Batch INSERT через `unnest`
- [ ] Try/catch в cron вокруг populate
- [ ] `llm-partial` тоже обогащается
- [ ] SQL injection fix (`jsonb_build_array`)
- [ ] SQLite GIN skip

### 12.2 Деплой

- [ ] Миграция запущена (`/migrate-v3-enrichment`)
- [ ] Таблица создана без ошибок
- [ ] Индексы созданы
- [ ] Cron не падает (логи 15 минут)
- [ ] Новые статьи enrichment_version = 2
- [ ] news_tag_links > 0
- [ ] Поиск `/news/search?tag=X&days=1` работает
- [ ] Fallback работает (populate упал → JSONB)

### 12.3 Пост-деплой аудит

- [ ] enrichment_version=2 / total_llm > 90%
- [ ] populate failure rate < 1%
- [ ] SQL injection fix (тег с кавычками)
- [ ] llm-partial обогащаются
- [ ] Старые статьи не тронуты

---

## Приложение: Полная ER-диаграмма

```
┌──────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│     users        │     │  user_defined_tags   │     │     news         │
├──────────────────┤     ├──────────────────────┤     ├──────────────────┤
│ id (PK)          │     │ tag_id (PK)          │     │ id (PK)          │
│ email (UNIQUE)   │◄────┤ tag_name             │     │ content_hash (U) │
│ username         │     │ tag_type             │     │ title_ru         │
│ is_admin         │     │ keywords[]           │     │ sentiment        │
│ is_blocked       │     │ enriched_data (JSONB)│     │ sentiment_score  │
│ ...              │     │ ...                  │     │ sentiment_source │
└────────┬─────────┘     └──────────┬───────────┘     │ enrichment_ver   │
         │                          │                 │ tag_impact (JSON)│
         │                          │                 │ matched_tags[]   │
         │    ┌─────────────────────┘                 └────────┬─────────┘
         │    │                                                │
         │    │    ┌──────────────────────┐                   │
         │    │    │  news_tag_links      │◄──────────────────┘
         │    │    ├──────────────────────┤  (v3.0 enrichment)
         │    └───►│ id (PK)              │
         │         │ news_id (FK → news)  │
         │         │ tag_id (FK → tags)   │
         │         │ impact_score         │
         │         │ impact_reasoning     │
         │         │ link_source          │
         │         │ link_version         │
         │         │ linked_at            │
         │         └──────────────────────┘
         │
    ┌────┴──────────────┐
    │   portfolios      │
    ├───────────────────┤
    │ user_id (FK)      │
    │ tag_id (FK)       │
    │ tag_name          │
    │ tag_type          │
    │ created_at        │
    └───────────────────┘
```

---

*Документ создан: 2026-06-04*
*Версия: 9.0 — Article Enrichment + Hybrid Storage*
