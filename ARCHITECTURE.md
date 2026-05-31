# PULSE — Backend Architecture

> Техническая документация backend'а. Логика, flow, принятие решений.
> Последнее обновление: 2026-05-31 (v7.17.4 — unified batch + 5-min cron + RSS fixes)

---

## Содержание

1. [News Pipeline](#1-news-pipeline)
2. [RSS Fetcher](#2-rss-fetcher-rssfetcherts)
3. [Smart Tag Matching](#3-smart-tag-matching)
4. [Duplicate Detection](#4-duplicate-detection)
5. [Database Layer](#5-database-layer)
6. [Translation](#6-translation)
7. [Unified LLM Batch](#7-unified-llm-batch-v717)
8. [Sentiment Analysis](#8-sentiment-analysis)
9. [User-Defined Tags](#9-user-defined-tags)
10. [API Design](#10-api-design)
11. [Cron Jobs](#11-cron-jobs)
12. [Services Map](#12-services-map)
13. [Batch Processing & Job Lock](#13-batch-processing--job-lock)
14. [Performance](#14-performance)

---

## 1. News Pipeline

### Полный flow обработки новости (v7.17)

```
┌─────────────────┐
│   RSS Fetcher   │  <-- 37 источников, batch x 4
│   (rssFetcher)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   XML Parser    │  <-- RSS 2.0 + Atom, normalizePubDate (timezone-aware)
│   (parseRSS)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  URL Normalize  │  <-- Удаляем UTM, приводим к canonical form
│  (normalizeUrl) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Translation   │  <-- EN -> RU через Kimi API (api.moonshot.ai)
│   (translate)   │  <-- Cache: translation_cache table
└────────┬────────┘
         │
         ▼
┌──────────────────────────────┐
│      Smart Match Tags        │  <-- 3-layer: keywords -> LLM -> related
│     (smartTagMatcher)        │  <-- User-defined tags + standard tags
└────────┬─────────────────────┘
         │
         ▼
┌──────────────────────────────┐
│      UNIFIED LLM BATCH       │  <-- 1 запрос на 10 статей
│         (v7.17)              │     sentiment + reasoning + is_political + tag_impacts
│  ┌─────────┐ ┌────────────┐ │
│  │Sentiment│ │  Tag Impact│ │  <-- analyzeUnifiedBatch(10)
│  │ -10..+10│ │  (per tag) │ │     returns: UnifiedResult[] x 10
│  │Reasoning│ │            │ │
│  │2 para.  │ │            │ │
│  │is_polit.│ │            │ │
│  └─────────┘ └────────────┘ │
└────────┬─────────────────────┘
         │
         ▼
┌─────────────────┐
│  Deduplicate    │  <-- content_hash + ON CONFLICT DO UPDATE
│   (cron.ts)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Save to DB    │  <-- PostgreSQL, table: news
│    (query)      │
└─────────────────┘
```

### Время обработки

| Этап | Время |
|------|-------|
| RSS Fetch (37 источников) | ~15-20 сек |
| Translate (EN -> RU) | ~10-20 сек |
| Smart Match Tags | ~5 сек |
| Unified LLM Batch | ~10-20 сек |
| Deduplicate + Save | ~3 сек |
| **Итого** | **~43-68 сек** |

---

## 2. RSS Fetcher (rssFetcher.ts)

### 37 источников

| Категория | Источники | Кол-во |
|-----------|-----------|--------|
| **RU** | lenta, kommersant, rbc, vedomosti, tass, ria, interfax, rt, izvestia | 9 |
| **Finam** | finam_companies, finam_news, finam_forecasts, finam_world, finam_analytics, finam_bonds_news, finam_bonds_comments | 7 |
| **EN** | seekingalpha, reuters, bloomberg, techcrunch, cnbc, ft, wsj, economist, forbes, cnn, bbc, guardian, marketwatch | 13 |
| **Tech** | verge, wired, arstechnica, hackernews | 4 |
| **Crypto** | coindesk, cointelegraph | 2 |
| **Energy** | oilprice, mining | 2 |
| **Всего** | | **37** |

### normalizePubDate — timezone-aware парсинг

```
ISO 8601 с Z:           "2026-05-31T07:35:31Z"           -> UTC
ISO 8601 с offset:      "2026-05-31T07:35:31+03:00"      -> с учетом offset
RSS format с timezone:  "Sat, 30 May 2026 20:06:39 +0300" -> с учетом offset
RSS format без timezone:                        
  + "+0300" для RU источников
  + "+0000" для EN источников
Fallback:               new Date(str) + проверка isNaN
```

### parseRSS — поддержка RSS 2.0 и Atom

| Формат | Элемент | Поле |
|--------|---------|------|
| **RSS 2.0** | `<item>` | Статья |
| RSS 2.0 | `<title>` | Заголовок |
| RSS 2.0 | `<description>` | Сводка |
| RSS 2.0 | `<link>` | URL |
| RSS 2.0 | `<pubDate>` | Дата публикации |
| **Atom** | `<entry>` | Статья |
| Atom | `<title>` | Заголовок |
| Atom | `<summary>` / `<content>` | Сводка |
| Atom | `<id>` / `<link href>` | URL |
| Atom | `<updated>` / `<published>` | Дата публикации |

### extractTag — CDATA + namespace

```
<title>Foo</title>                    -> "Foo"
<title><![CDATA[Foo]]></title>        -> "Foo"
<dc:title>Foo</dc:title>              -> "Foo"
```

### fetchAllRSS — ключевые изменения

```typescript
// last_fetched_at = max(article.publishedAt)  (было: fetchTime)
// Не обновляем last_fetched_at если 0 статей от источника
// Stats: lastFetchStats — per-source diagnostics

interface FetchStats {
  source: string;
  items: number;       // Всего items в RSS feed
  filtered: number;    // Отфильтровано (до last_fetched_at)
  kept: number;        // Сохранено для обработки
  httpStatus: number;  // HTTP status code
  error?: string;      // Ошибка если есть
}

// lastFetchStats: Map<string, FetchStats> — доступен через GET /debug-rss
```

---

## 3. Smart Tag Matching

### Архитектура: 3 слоя

#### Layer 1: Keyword Matching (sync, fast)

```typescript
function matchTagsByKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];

  // Стандартные теги (18 тегов)
  for (const [tagId, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      matched.push(tagId);
    }
  }

  // Пользовательские теги из user_defined_tags таблицы
  // keywords генерируются автоматически при создании тега
  const userTags = getAllUserDefinedTags(); // Record<string, string[]>
  for (const [tagId, keywords] of Object.entries(userTags)) {
    if (keywords.some(kw => lower.includes(kw))) {
      matched.push(tagId);
    }
  }

  return matched;
}
```

#### Layer 2: LLM Tag Matching (Kimi API, async)

```
Если keyword matching вернул []:
  1. Проверяем кэш (smart_tag_cache, TTL 7 дней)
  2. Если нет в кэше -> вызываем Kimi API
  3. smartMatchTags(title, summary): Promise<string[]>
  4. Парсим JSON-ответ -> получаем теги
  5. Сохраняем в кэш (TTL: 7 дней)
```

#### Layer 3: Related Tags (sync)

```typescript
const RELATED_TAGS: Record<string, string[]> = {
  'nvda':   ['tech', 'ai'],
  'tesla':  ['tech', 'ai'],
  'crypto': ['tech', 'fed', 'bank'],
  'ai':     ['tech', 'nvda'],
  'fed':    ['bank', 'gold'],
};

// Добавляем связанные теги к результатам Layer 1 + Layer 2
function addRelatedTags(matched: string[]): string[] {
  const related = new Set(matched);
  for (const tag of matched) {
    if (RELATED_TAGS[tag]) {
      RELATED_TAGS[tag].forEach(r => related.add(r));
    }
  }
  return [...related];
}
```

### Keyword Dictionary (Standard Tags)

```typescript
const TAG_KEYWORDS: Record<string, string[]> = {
  'sber':    ['сбербанк', 'сбер', 'sberbank', 'sber'],
  'gazprom': ['газпром', 'gazprom'],
  'tesla':   ['tesla', 'тесла', 'musk', 'маск', 'elon', 'cybertruck'],
  'nvda':    ['nvidia', 'nvda', 'geforce', 'rtx', 'gpu'],
  'ai':      ['ии', 'нейросет', 'chatgpt', 'openai', 'llm'],
  'crypto':  ['криптовалют', 'bitcoin', 'биткоин', 'блокчейн'],
  'fed':     ['фрс', 'federal reserve', 'powell', 'инфляц'],
  // ... 18 тегов всего
};
```

---

## 4. Duplicate Detection

### Алгоритм

```
1. Нормализация URL
   input:  "https://www.rbc.ru/business/15/02/2025/abc?utm_source=telegram"
   output: "https://rbc.ru/business/15/02/2025/abc"

2. Content Hash
   input:  title_ru + "_" + summary_ru (first 500 chars)
   method: MD5
   output: "a1b2c3d4e5f6..."

3. Insert with conflict resolution
   INSERT INTO news (..., content_hash, all_sources, source_count)
   VALUES (..., 'a1b2c3d4', ARRAY['РБК'], 1)
   ON CONFLICT (content_hash) DO UPDATE
     SET all_sources = CASE
       WHEN news.all_sources @> ARRAY[EXCLUDED.source]::text[]
       THEN news.all_sources
       ELSE array_append(news.all_sources, EXCLUDED.source)
     END,
     source_count = CASE
       WHEN news.all_sources @> ARRAY[EXCLUDED.source]::text[]
       THEN news.source_count
       ELSE news.source_count + 1
     END;
```

### Пример работы

| Шаг | Действие | all_sources | source_count |
|-----|----------|-------------|--------------|
| 1 | РБК публикует новость | `['РБК']` | 1 |
| 2 | ТАСС дублирует (тот же content_hash) | `['РБК', 'ТАСС']` | 2 |
| 3 | Лента дублирует | `['РБК', 'ТАСС', 'Лента']` | 3 |

---

## 5. Database Layer

### Query Interface

```typescript
// Единая функция для всех SQL-запросов
// Автоматически определяет SQLite vs PostgreSQL
async function query(sql: string, params: any[]): Promise<QueryResult>
```

### Миграции при старте

```sql
-- Основные колонки
ALTER TABLE news ADD COLUMN IF NOT EXISTS url_normalized TEXT;
ALTER TABLE news ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE news ADD COLUMN IF NOT EXISTS all_sources TEXT[] DEFAULT '{}';
ALTER TABLE news ADD COLUMN IF NOT EXISTS source_count INTEGER DEFAULT 1;

-- Sentiment + Tag Impact
ALTER TABLE news ADD COLUMN IF NOT EXISTS sentiment TEXT;
ALTER TABLE news ADD COLUMN IF NOT EXISTS sentiment_source TEXT;
ALTER TABLE news ADD COLUMN IF NOT EXISTS tag_impact JSONB;

-- Кэш
CREATE TABLE IF NOT EXISTS translation_cache (
  id SERIAL PRIMARY KEY,
  original_text TEXT NOT NULL UNIQUE,
  translated_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS smart_tag_cache (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  tags TEXT[] NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '7 days'
);

-- Constraints
ALTER TABLE news ADD CONSTRAINT news_content_hash_unique UNIQUE (content_hash);
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_user_id_unique UNIQUE (user_id);
ALTER TABLE user_news_reads ADD CONSTRAINT user_news_reads_unique UNIQUE (user_id, news_id);
```

---

## 6. Translation

### translate.ts

**API:** Kimi (`moonshot-v1-8k`) через `api.moonshot.ai`
> Ранее: Google Translate — был заблокирован на Render.

```typescript
// === translateBatch ===
// Основной batch-перевод
async function translateBatch(texts: string[]): Promise<string[]> {
  // 1. Фильтруем только EN тексты
  const enTexts = texts.filter(t =>
    hasLatin(t) && !hasCyrillic(t) && t.length > 5
  );

  // 2. Проверяем кэш
  const cached = await getCachedTranslations(enTexts);
  const toTranslate = enTexts.filter(t => !cached[t]);

  // 3. Отправляем batch из 5 текстов в Kimi
  const translated: string[] = [];
  for (let i = 0; i < toTranslate.length; i += 5) {
    const batch = toTranslate.slice(i, i + 5);
    const results = await translateWithKimi(batch);
    translated.push(...results);
    await saveToCache(batch, results);

    // 4. Задержка между batches
    if (i + 5 < toTranslate.length) {
      await delay(500);
    }
  }

  // 5. Мапим обратно в оригинальные позиции
  return mergeResults(texts, cached, translated);
}

// === translateWithKimi ===
async function translateWithKimi(texts: string[]): Promise<string[]> {
  const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.KIMI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'moonshot-v1-8k',
      messages: [
        {
          role: 'system',
          content: 'Translate English financial news to Russian. ' +
                   'Return ONLY a JSON array of translated strings. ' +
                   'Preserve financial terminology. Do not add commentary.'
        },
        {
          role: 'user',
          content: JSON.stringify(texts)
        }
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  const data = await response.json();
  return JSON.parse(data.choices[0].message.content);
}
```

| Параметр | Значение |
|----------|----------|
| Batch size | 5 текстов |
| Temperature | 0.1 |
| Max tokens | 2000 |
| Delay между batches | 500 мс |
| Cache | `translation_cache` table |

---

## 7. Unified LLM Batch (v7.17)

### Концепция

**Раньше (v7.15):** 3 отдельных LLM-запроса на статью:
1. Sentiment analysis
2. Tag impact analysis
3. Political detection

**Сейчас (v7.17):** 1 LLM-запрос на 10 статей возвращает все 3 результата.

```typescript
interface UnifiedResult {
  sentiment: 'positive' | 'negative' | 'neutral';
  score: number;        // -10..+10
  reasoning: string;    // 2 paragraphs: "What happened.\n\nWhy it matters."
  is_political: boolean;
  tag_impacts: TagImpact[];
}

// === analyzeUnifiedBatch ===
async function analyzeUnifiedBatch(
  items: { title: string; summary: string; tags: string[] }[]
): Promise<UnifiedResult[]> {
  // 1. Разбиваем на чанки по 10 статей
  const chunks = chunk(items, 10);
  const results: UnifiedResult[] = [];

  for (const chunk of chunks) {
    const chunkResults = await analyzeUnifiedBatchChunk(chunk);
    results.push(...chunkResults);
  }

  return results;
}

// === analyzeUnifiedBatchChunk ===
async function analyzeUnifiedBatchChunk(
  items: { title: string; summary: string; tags: string[] }[]
): Promise<UnifiedResult[]> {
  // 1 axios.post to Kimi API
  // response_format: { type: 'json_object' }
  // returns: [{ score, reasoning, is_political, tag_impacts }] x 10
}
```

### Prompt

```
Role: Анализ от инвестиционного аналитика.

Для каждой статьи верни:
- sentiment: "positive" | "negative" | "neutral"
- score: -10..+10 (числовая оценка)
- reasoning: 2 абзаца через "\n\n":
  Параграф 1: "What happened" (факты)
  Параграф 2: "Why it matters to investors" (значение)
- is_political: true для политики/войны/выборов/санкций/геополитики
- tag_impacts: массив [{ tag, impact, reasoning }] для каждого matched tag
```

### Retry Logic

```typescript
// 3 retries на 429/502/ECONNRESET/ETIMEDOUT
// Backoff: 2s -> 4s -> 8s

llmRequestWithRetry(fn, label):
  for attempt 1..3:
    try: return await fn()
    catch err:
      if status NOT IN [429, 502, ECONNRESET, ETIMEDOUT]: throw
      delay = 2s * 2^(attempt-1)  // 2s, 4s, 8s
      sleep(delay); retry
```

---

## 8. Sentiment Analysis

### Score Scale

| Score | Значение |
|-------|----------|
| -10 | Катастрофа (банкротство) |
| -5 | Сильный негатив |
| -1 | Слабый негатив |
| 0 | Нейтрально |
| +1 | Слабый позитив |
| +5 | Сильный позитив |
| +10 | Максимум (рекорд) |

### Reasoning

2 абзаца через `\n\n`:

```
Параграф 1: "What happened" (факты — что произошло)
Параграф 2: "Why it matters to investors" (значение — почему это важно для инвесторов)
```

Пример:
```
Apple reported Q2 earnings of $2.18 EPS vs $2.10 expected, 
with revenue up 5% YoY to $90.8B. Services revenue hit 
an all-time high of $23.9B.

The beat on both top and bottom lines signals resilient 
consumer demand despite macro headwinds. Services growth 
accelerates the shift to higher-margin recurring revenue, 
which the market typically rewards with multiple expansion.
```

### is_political

`is_political = true` для статей о:
- Политике / выборах
- Войне / военных действиях
- Санкциях / геополитике
- Международных отношениях

### Storage

| Поле | Тип | Описание |
|------|-----|----------|
| `sentiment` | `TEXT` | `positive` \| `negative` \| `neutral` |
| `sentiment_source` | `TEXT` | `llm` (единственный источник в v7.17) |
| `tag_impact` | `JSONB` | Массив `TagImpact[]` или `null` |
| `is_political` | `BOOLEAN` | `true` — статья политическая |

---

## 9. User-Defined Tags

### tagManager.ts

```typescript
// === createUserTag ===
// Создание тега + автоматический бэкфилл
async function createUserTag(
  userId: string,
  tagId: string,
  tagName: string,
  tagType: 'stock' | 'crypto' | 'sector'
): Promise<{ tag: UserTag; backfill: { scanned: number; matched: number } }> {

  // 1. Генерируем keywords автоматически
  const keywords = generateTagKeywords(tagName);

  // 2. INSERT INTO user_defined_tags
  const tag = await query(`
    INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords, created_by)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [tagId, tagName, tagType, keywords, userId]);

  // 3. INSERT INTO portfolios (для UI)
  await query(`
    INSERT INTO portfolios (user_id, tag_id, tag_name, tag_type)
    VALUES ($1, $2, $3, $4)
  `, [userId, tagId, tagName, tagType]);

  // 4. BACKFILL: сканируем все новости
  const backfill = await scanAllNewsForTag(tagId, keywords);

  return { tag, backfill };
}

// === generateTagKeywords ===
// Автогенерация keywords из названия тега
function generateTagKeywords(tagName: string): string[] {
  const keywords = new Set<string>();

  // Основное: lowerCase
  keywords.add(tagName.toLowerCase());

  // Транслит: латинская транслитерация (если русское слово)
  const translit = transliterateToLatin(tagName);
  keywords.add(translit.toLowerCase());

  // Склонения: суффиксные формы
  // Например, для "лукойл" -> ['лукойл', 'лукойлу', 'лукойла', 'лукойле']
  const declensions = generateDeclensions(tagName);
  declensions.forEach(d => keywords.add(d.toLowerCase()));

  return [...keywords];
}

// === scanAllNewsForTag ===
// Бэкфилл: обновляет matched_tags для существующих новостей
async function scanAllNewsForTag(
  tagId: string,
  keywords: string[]
): Promise<{ scanned: number; matched: number }> {
  // Новости без этого тега
  const { rows } = await query(`
    SELECT id, title, summary FROM news
    WHERE matched_tags IS NULL
       OR NOT (matched_tags @> ARRAY[$1]::text[])
  `, [tagId]);

  let matched = 0;
  for (const news of rows) {
    const text = `${news.title} ${news.summary || ''}`.toLowerCase();
    if (keywords.some(kw => text.includes(kw.toLowerCase()))) {
      await query(`
        UPDATE news
        SET matched_tags = array_append(COALESCE(matched_tags, ARRAY[]::text[]), $1)
        WHERE id = $2
      `, [tagId, news.id]);
      matched++;
    }
  }

  return { scanned: rows.length, matched };
}
```

### User-Defined Tags Flow

```
Пользователь создает тег "лукойл"
|
|---> generateTagKeywords("лукойл")
|     |---> ['лукойл', 'lukoil', 'лукойлу', 'лукойла', 'лукойле', 'lukoyl']
|
|---> INSERT INTO user_defined_tags
|     (tag_id='lukoil', tag_name='Лукойл', keywords=[...])
|
|---> INSERT INTO portfolios
|     (user_id, tag_id='lukoil', tag_name='Лукойл')
|
|---> BACKFILL: scanAllNewsForTag('lukoil', keywords)
|     |---> SELECT * FROM news WHERE matched_tags IS NULL OR NOT ('lukoil' = ANY(matched_tags))
|     |---> Для каждой новости: matchTagsByKeywords(title + summary)
|     |---> Если совпало -> UPDATE matched_tags = array_append(matched_tags, 'lukoil')
|     |---> Возвращает { scanned: 1523, matched: 47 }
```

---

## 10. API Design

### News Feed Logic

```
GET /api/news
|---> Без параметров:   непрочитанные по тегам (default)
|---> ?history=true:    все по тегам (read + unread)
|---> ?global=true:     все новости (без фильтра тегов)
|---> ?limit=N:         пагинация (default: 50, max: 100)
```

### SQL для каждого режима

```sql
-- Непрочитанные (default)
SELECT * FROM news
WHERE matched_tags && $1::text[]          -- теги пользователя
  AND id NOT IN (                         -- исключаем прочитанные
    SELECT news_id FROM user_news_reads WHERE user_id = $2
  )
  AND published_at > NOW() - INTERVAL '90 days'
ORDER BY published_at DESC
LIMIT 50;

-- Все по тегам (?history=true)
SELECT * FROM news
WHERE matched_tags && $1::text[]
  AND published_at > NOW() - INTERVAL '90 days'
ORDER BY published_at DESC
LIMIT 50;

-- Global (?global=true)
SELECT * FROM news
WHERE published_at > NOW() - INTERVAL '90 days'
ORDER BY published_at DESC
LIMIT 50;
```

### User Tags

```
POST /api/user/tags/custom
Body: { "tagName": "лукойл", "tagType": "stock" }
Response: { "tag": { "tag_id": "lukoil", ... }, "backfill": { "scanned": 1523, "matched": 47 } }
```

### Debug Endpoints

```
GET /debug-env
|---> Returns: { kimi_key_set: boolean, db_url_set: boolean, node_env: string }

GET /debug-db
|---> Returns: { news_count: number, users_count: number, last_article: string }

GET /debug-rss         <-- NEW v7.17
|---> Returns: per-source RSS diagnostics
|---> { sources: [{ name, last_fetched_at, article_count, last_fetch_stats }] }

GET /debug-cron        <-- NEW v7.17
|---> Returns: cron health (recent runs, 24h stats)
|---> { recent_runs: [...], stats_24h: { total: N, successful: M, failed: F } }

GET /debug-system      <-- NEW v7.17
|---> Returns: DB health, cron locks, test insert
|---> { db: "ok", locks: [...], test_insert: "ok" }

GET /test-rss          <-- NEW v7.17
|---> Fetch RSS without saving (diagnostic)
|---> Returns: raw RSS items per source

GET /test-process      <-- NEW v7.17
|---> Full process synchronously with await
|---> Returns: { fetched: N, translated: N, matched: N, saved: N, duration_ms: N }

GET /tag-stats
|---> Returns: { total_tags: number, user_tags: number, news_with_tags: number }
```

### Backfill Routes

```
GET /backfill-translate?secret=pulse-dev-key
|---> Перевод существующих EN заголовков (batch через Kimi API)

GET /backfill-tags?secret=pulse-dev-key
|---> Ретегирование статей без matched_tags (3-layer matching)
```

---

## 11. Cron Jobs

### RSS Aggregator

```typescript
// Каждые 5 минут (было 15)
cron.schedule('*/5 * * * *', processArticles);

// Job lock: PostgreSQL cron_locks table
// TTL: 10 минут (было 15) — safety margin для 5-min schedule

// Первый запуск через 2 минуты после старта
setTimeout(processArticles, 2 * 60 * 1000);
```

### Weekly Reports

```typescript
// Каждое воскресенье в 13:00
cron.schedule('0 13 * * 0', generateReport);
```

### Manual Triggers

```bash
# RSS сбор
POST /trigger-rss
Header: x-trigger-secret: pulse-dev-key

# Перевод существующих EN заголовков
GET /backfill-translate?secret=pulse-dev-key

# Перетегирование статей без matched_tags
GET /backfill-tags?secret=pulse-dev-key

# Полная синхронная обработка (diagnostic)
GET /test-process              # <-- NEW v7.17
```

---

## 12. Services Map

```
src/
|---> services/
|     |---> cron.ts              # RSS pipeline (fetch -> translate -> tags -> unified batch -> save)
|     |---> smartTagMatcher.ts   # 3-layer tag matching
|     |---> rssFetcher.ts        # RSS fetch + XML parse (37 sources, Atom+RSS2.0, timezone-aware)
|     |---> rssSources.ts        # 37 RSS sources config
|     |---> translate.ts         # Kimi API translation + cache
|     |---> tagManager.ts        # User-defined tags + keyword generation + backfill
|     |---> unifiedBatch.ts      # <-- NEW v7.17: unified LLM batch (sentiment + tag_impact + is_political)
|     |---> reports.ts           # Weekly email reports
|
|---> routes/
|     |---> news.ts              # GET /api/news (3 modes)
|     |---> auth.ts              # Login/register
|     |---> user.ts              # Tags CRUD + user-defined tags
|     |---> debug.ts             # Debug endpoints (debug-env, debug-db, debug-rss, debug-cron, debug-system)
|     |---> test.ts              # <-- NEW v7.17: test-rss, test-process
|     |---> ...
|
|---> models/
|     |---> schema.sql           # PostgreSQL schema
|
|---> middleware/
|     |---> auth.ts              # JWT verification
|     |---> rateLimit.ts         # Rate limiting
|
|---> index.ts                   # Entry point, routes, cron
```

---

## 13. Batch Processing & Job Lock

### Unified Batch (v7.17)

```typescript
// 1 LLM-запрос на 10 статей:
//   sentiment + score + reasoning + is_political + tag_impacts
analyzeUnifiedBatch(items: {title, summary, tags}[]): Promise<UnifiedResult[]>
  |---> analyzeUnifiedBatchChunk(10 articles)
        |---> 1 axios.post to Kimi API (response_format: { type: 'json_object' })
        |---> returns: [{ score, reasoning, is_political, tag_impacts }] x 10
```

### Legacy Batch (v7.13-7.15) — REPLACED

```
v7.13: analyzeSentimentBatch       (sentiment only)
v7.14: analyzeTagImpactBatch       (tag_impact only)
v7.15: 2 separate LLM calls per batch

v7.17: analyzeUnifiedBatch         (everything in 1 call)  <-- REPLACES above
```

### Retry Logic

```typescript
llmRequestWithRetry(fn, label):
  for attempt 1..3:
    try: return await fn()
    catch err:
      if status NOT IN [429, 502, ECONNRESET, ETIMEDOUT]: throw
      delay = 2s * 2^(attempt-1)  // 2s, 4s, 8s
      sleep(delay); retry
```

### Distributed Job Lock

```sql
CREATE TABLE cron_locks (
  job_name VARCHAR(50) PRIMARY KEY,
  locked_at TIMESTAMP,
  locked_by VARCHAR(100),
  expires_at TIMESTAMP
);
```

**Acquire:**
```sql
INSERT INTO cron_locks (job_name, locked_at, locked_by, expires_at)
VALUES ('rss-aggregator', NOW(), 'instance-id', NOW() + 10min)
ON CONFLICT (job_name) DO UPDATE
  SET locked_at = NOW(), locked_by = 'instance-id', expires_at = NOW() + 10min
  WHERE cron_locks.expires_at < NOW()  -- only if expired
RETURNING locked_by
```

**Release:** `DELETE FROM cron_locks WHERE job_name = 'rss-aggregator' AND locked_by = 'instance-id'`

**TTL:** 10 минут (cron runs ~43-68 сек, 10 = safety margin для 5-min schedule + crash recovery).

### Performance Comparison

| Метрика | v7.15 (separate) | v7.17 (unified) | Ускорение |
|---------|-------------------|-----------------|-----------|
| LLM calls на 10 статей | 2 (sentiment + tag_impact) | 1 (unified) | **2x** |
| Total LLM time (10 articles) | ~4 сек | ~2-3 сек | **1.5x** |
| Cron interval | 15 мин | 5 мин | **3x чаще** |
| Sources | 20 | 37 | **+85%** |
| Lock TTL | 15 мин | 10 мин | — |

---

## 14. Performance

### Полный pipeline (37 источников)

| Этап | Время |
|------|-------|
| RSS Fetch (37 sources, batch x 4) | ~15-20 сек |
| Translate (EN -> RU) | ~10-20 сек |
| Smart Match Tags (Layer 1+2+3) | ~5 сек |
| Unified LLM Batch (sentiment + tag_impact + is_political) | ~10-20 сек |
| Deduplicate + Save | ~3 сек |
| **Итого** | **~43-68 сек** |

### Bottlenecks

```
1. LLM API latency        <-- unified batch сокращает на 40%
2. Translation batch      <-- cache hit rate ~60%
3. RSS fetch (37 sources) <-- parallel batches x 4
```

### Monitoring

```
GET /debug-cron    -> 24h stats: total runs, success rate, avg duration
GET /debug-rss     -> per-source: items, filtered, kept, errors
GET /debug-system  -> DB health, lock status, test insert
GET /test-process  -> full sync process with timing breakdown
```