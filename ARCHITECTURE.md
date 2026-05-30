# PULSE — Backend Architecture

> Техническая документация бэкенда. Логика, flow, принятие решений.
> Последнее обновление: 2026-05-30 (v7.15 — batch processing + job lock)

---

## Содержание

1. [News Pipeline](#news-pipeline)
2. [Smart Tag Matching](#smart-tag-matching)
3. [Duplicate Detection](#duplicate-detection)
4. [Database Layer](#database-layer)
5. [Translation](#translation)
6. [Sentiment Analysis](#sentiment-analysis)
7. [User-Defined Tags](#user-defined-tags)
8. [API Design](#api-design)
9. [Cron Jobs](#cron-jobs)
10. [Services Map](#services-map)

---

## News Pipeline

### Полный flow обработки новости

```
┌─────────────────┐
│   RSS Fetcher   │  ← 20 источников, batch по 4
│   (rssFetcher)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   XML Parser    │  ← Извлекаем <item>: title, link, pubDate, summary
│   (parseRSS)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  URL Normalize  │  ← Удаляем UTM, приводим к canonical form
│  (normalizeUrl) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Translation   │  ← EN → RU через Kimi API (api.moonshot.ai)
│   (translate)   │  ← Cache: translation_cache table
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Sentiment    │  ← 3-level: keywords → LLM → tag impact
│  (cron.ts /     │
│   smartTagMatcher)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Smart Match   │  ← 3-layer: keywords → LLM → related
│ (smartTagMatcher)│  ← User-defined tags + standard tags
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Tag Impact    │  ← LLM-анализ влияния тегов (tag_impact JSONB)
│ (smartTagMatcher)│
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Deduplicate    │  ← content_hash + ON CONFLICT DO UPDATE
│   (cron.ts)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Save to DB    │  ← PostgreSQL, table: news
│    (query)      │
└─────────────────┘
```

### Время обработки

| Этап | Время |
|------|-------|
| RSS Fetch (20 источников) | ~15 сек |
| Translation (EN→RU, LLM) | ~10-20 сек |
| Sentiment Analysis | ~5 сек |
| Smart Tag Matching | ~5 сек |
| Deduplicate + Save | ~3 сек |
| **Итого** | **~38-48 сек** |

---

## Smart Tag Matching

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
  2. Если нет в кэше → вызываем Kimi API
  3. smartMatchTags(title, summary): Promise<string[]>
  4. Парсим JSON-ответ → получаем теги
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

## Duplicate Detection

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

## Database Layer

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

## Translation

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

## Sentiment Analysis

Двухуровневая система:

### Level 1: Keyword-based (cron.ts)

```typescript
// Быстрый, не требует API ключа
function analyzeSentimentKeywords(text: string): 'positive' | 'negative' | 'neutral' {
  const lower = text.toLowerCase();
  const positiveWords = ['рост', 'прибыль', 'bull', 'surge', 'gain', 'moon'];
  const negativeWords = ['падение', 'убыток', 'bear', 'crash', 'loss', 'dump'];

  let score = 0;
  positiveWords.forEach(w => { if (lower.includes(w)) score++; });
  negativeWords.forEach(w => { if (lower.includes(w)) score--; });

  return score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
}
// sentiment_source = 'keyword'
```

### Level 2: LLM (Kimi API) — smartTagMatcher.ts

```typescript
async function analyzeSentimentLLM(
  title: string,
  summary: string
): Promise<'positive' | 'negative' | 'neutral'> {
  const response = await callKimiAPI([
    {
      role: 'system',
      content: 'Analyze sentiment of this financial news. ' +
               'Return ONLY JSON: {"sentiment": "positive"|"negative"|"neutral"}'
    },
    {
      role: 'user',
      content: `Title: ${title}\nSummary: ${summary}`
    }
  ]);
  // sentiment_source = 'llm'
  return JSON.parse(response).sentiment;
}
```

### Level 3: Tag Impact — smartTagMatcher.ts

```typescript
interface TagImpact {
  tag: string;
  impact: 'positive' | 'negative' | 'neutral';
  reasoning: string;
}

async function analyzeTagImpact(
  title: string,
  summary: string,
  tags: string[]
): Promise<TagImpact[]> {
  const response = await callKimiAPI([
    {
      role: 'system',
      content: 'Analyze impact of each tag on the financial news. ' +
               'Return ONLY JSON array: [{"tag": "...", "impact": "...", "reasoning": "..."}]'
    },
    {
      role: 'user',
      content: `Title: ${title}\nSummary: ${summary}\nTags: ${tags.join(', ')}`
    }
  ]);

  const impacts: TagImpact[] = JSON.parse(response);
  // Сохраняем в news.tag_impact (JSONB column)
  return impacts;
}
```

### Storage

| Поле | Тип | Описание |
|------|-----|----------|
| `sentiment` | `TEXT` | `positive` \| `negative` \| `neutral` |
| `sentiment_source` | `TEXT` | `keyword` \| `llm` — какой уровень определил |
| `tag_impact` | `JSONB` | Массив `TagImpact[]` или `null` |

---

## User-Defined Tags

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
  // Например, для "лукойл" → ['лукойл', 'лукойлу', 'лукойла', 'лукойле']
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
Пользователь создаёт тег "лукойл"
│
├─→ generateTagKeywords("лукойл")
│   └─→ ['лукойл', 'lukoil', 'лукойлу', 'лукойла', 'лукойле', 'lukoyl']
│
├─→ INSERT INTO user_defined_tags
│   (tag_id='lukoil', tag_name='Лукойл', keywords=[...])
│
├─→ INSERT INTO portfolios
│   (user_id, tag_id='lukoil', tag_name='Лукойл')
│
└─→ BACKFILL: scanAllNewsForTag('lukoil', keywords)
    ├─→ SELECT * FROM news WHERE matched_tags IS NULL OR NOT ('lukoil' = ANY(matched_tags))
    ├─→ Для каждой новости: matchTagsByKeywords(title + summary)
    └─→ Если совпало → UPDATE matched_tags = array_append(matched_tags, 'lukoil')
        └─→ Возвращает { scanned: 1523, matched: 47 }
```

---

## API Design

### News Feed Logic

```
GET /api/news
├── Без параметров:   непрочитанные по тегам (default)
├── ?history=true:    все по тегам (read + unread)
├── ?global=true:     все новости (без фильтра тегов)
└── ?limit=N:         пагинация (default: 50, max: 100)
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
└── Returns: { kimi_key_set: boolean, db_url_set: boolean, node_env: string }

GET /debug-db
└── Returns: { news_count: number, users_count: number, last_article: string }

GET /tag-stats
└── Returns: { total_tags: number, user_tags: number, news_with_tags: number }
```

### Backfill Routes

```
GET /backfill-translate?secret=pulse-dev-key
└── Перевод существующих EN заголовков (batch через Kimi API)

GET /backfill-tags?secret=pulse-dev-key
└── Ретегирование статей без matched_tags (3-layer matching)
```

---

## Cron Jobs

### RSS Aggregator

```typescript
// Каждые 15 минут
cron.schedule('*/15 * * * *', processArticles);

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
```

---

## Services Map

```
src/
├── services/
│   ├── cron.ts              # RSS pipeline (fetch → translate → sentiment → tag → save)
│   ├── smartTagMatcher.ts   # 3-layer tag matching + LLM sentiment + tag impact
│   ├── rssFetcher.ts        # RSS fetch + XML parse
│   ├── rssSources.ts        # 20 RSS sources config
│   ├── translate.ts         # Kimi API translation + cache
│   ├── tagManager.ts        # User-defined tags + keyword generation + backfill
│   └── reports.ts           # Weekly email reports
├── routes/
│   ├── news.ts              # GET /api/news (3 modes)
│   ├── auth.ts              # Login/register
│   ├── user.ts              # Tags CRUD + user-defined tags
│   ├── debug.ts             # Debug endpoints (/debug-env, /debug-db, /tag-stats)
│   └── ...
├── models/
│   └── schema.sql           # PostgreSQL schema
├── middleware/
│   ├── auth.ts              # JWT verification
│   └── rateLimit.ts         # Rate limiting
└── index.ts                 # Entry point, routes, cron
```

---

## 11. Batch Processing & Job Lock (v7.13-7.15)

### Batch Sentiment (v7.13)

```typescript
// 10 статей за 1 LLM-запрос вместо 10 отдельных
analyzeSentimentBatch(articles: {title, summary}[])
  → analyzeSentimentBatchChunk(10 articles)
    → 1 axios.post to Kimi API
    → returns: [{sentiment, score, reasoning}] × 10
```

**Prompt:** `response_format: { type: "json_object" }` — гарантия валидного JSON.

### Batch Tag Impact (v7.14)

```typescript
// 10 статей за 1 LLM-запрос вместо 10 отдельных
analyzeTagImpactBatch(items: {title, summary, tags}[])
  → analyzeTagImpactBatchChunk(10 articles)
    → returns: [[{tag, impact, reasoning}]] × 10
```

### Retry Logic (v7.14.1)

```typescript
llmRequestWithRetry(fn, label):
  for attempt 1..3:
    try: return await fn()
    catch err:
      if status NOT IN [429, 502, ECONNRESET, ETIMEDOUT]: throw
      delay = 2s × 2^(attempt-1)  // 2s, 4s, 8s
      sleep(delay); retry
```

### Distributed Job Lock (v7.15)

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
VALUES ('rss-aggregator', NOW(), 'instance-id', NOW() + 15min)
ON CONFLICT (job_name) DO UPDATE
  SET locked_at = NOW(), locked_by = 'instance-id', expires_at = NOW() + 15min
  WHERE cron_locks.expires_at < NOW()  -- only if expired
RETURNING locked_by
```

**Release:** `DELETE FROM cron_locks WHERE job_name = 'rss-aggregator' AND locked_by = 'instance-id'`

**TTL:** 15 минут (cron runs ~2-3 min, 15 = safety margin for crash recovery).

### Performance Comparison

| Метрика | v7.12 (sequential) | v7.14 (batch) | Ускорение |
|---------|---------------------|---------------|-----------|
| Sentiment (10 articles) | 10 × 500ms = 5s | 1 × 2000ms = 2s | **2.5×** |
| Tag Impact (10 articles) | 10 × 500ms = 5s | 1 × 2000ms = 2s | **2.5×** |
| **Total LLM time** | **~10s** | **~4s** | **2.5×** |
| Cron interval | 5 min | 15 min | — |
