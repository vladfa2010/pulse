# PULSE — Backend Architecture

> Техническая документация бэкенда. Логика, flow, принятие решений.
> Последнее обновление: 2026-05-27

---

## Содержание

1. [News Pipeline](#news-pipeline)
2. [Smart Tag Matching](#smart-tag-matching)
3. [Duplicate Detection](#duplicate-detection)
4. [Database Layer](#database-layer)
5. [API Design](#api-design)
6. [Cron Jobs](#cron-jobs)

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
│   Translation   │  ← EN → RU через Google Translate API
│   (translate)   │  ← Cache: translation_cache table
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    Sentiment    │  ← Keyword-based: позитив/негатив/нейтраль
│   (cron.ts)     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Smart Match   │  ← 3-layer: keywords → LLM → related
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
| Translation (EN→RU) | ~5-10 сек |
| Sentiment Analysis | ~1 сек |
| Smart Tag Matching | ~2-5 сек |
| Deduplicate + Save | ~3-5 сек |
| **Итого** | **~30-40 сек** |

---

## Smart Tag Matching

### Архитектура

```typescript
// Layer 1: Keyword Matching (sync, fast)
function matchTagsByKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const matched: string[] = [];
  
  for (const [tagId, keywords] of Object.entries(TAG_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      matched.push(tagId);
    }
  }
  return matched;
}
```

### Keyword Dictionary

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

### LLM Fallback (Layer 2)

```
Если keyword matching вернул []:
  1. Проверяем кэш (smart_tag_cache)
  2. Если нет в кэше → вызываем Kimi API
  3. Парсим JSON-ответ → получаем теги
  4. Сохраняем в кэш (TTL: 7 дней)
```

### Related Tags (Layer 3)

```typescript
const RELATED_TAGS: Record<string, string[]> = {
  'nvda':   ['tech', 'ai'],
  'tesla':  ['tech', 'ai'],
  'crypto': ['tech', 'fed', 'bank'],
  'ai':     ['tech', 'nvda'],
  'fed':    ['bank', 'gold'],
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
-- Добавляем колонки, если их нет
ALTER TABLE news ADD COLUMN IF NOT EXISTS url_normalized TEXT;
ALTER TABLE news ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE news ADD COLUMN IF NOT EXISTS all_sources TEXT[] DEFAULT '{}';
ALTER TABLE news ADD COLUMN IF NOT EXISTS source_count INTEGER DEFAULT 1;

-- Constraints
ALTER TABLE news ADD CONSTRAINT news_content_hash_unique UNIQUE (content_hash);
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_user_id_unique UNIQUE (user_id);
ALTER TABLE user_news_reads ADD CONSTRAINT user_news_reads_unique UNIQUE (user_id, news_id);
```

---

## API Design

### News Feed Logic

```
GET /api/news
├── Без параметров: непрочитанные по тегам
├── ?all=true:      все по тегам (read + unread)
├── ?global=true:   все новости (без фильтра тегов)
└── ?limit=N:       пагинация (default: 50, max: 100)
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

-- Все по тегам (?all=true)
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

# Перетегирование статей
GET /backfill-tags?secret=pulse-dev-key
```

---

## Services Map

```
src/
├── services/
│   ├── cron.ts              # RSS pipeline (fetch → translate → tag → save)
│   ├── smartTagMatcher.ts   # 3-layer tag matching + related tags
│   ├── rssFetcher.ts        # RSS fetch + XML parse
│   ├── rssSources.ts        # 20 RSS sources config
│   ├── translate.ts         # Google Translate + cache
│   └── reports.ts           # Weekly email reports
├── routes/
│   ├── news.ts              # GET /api/news (3 modes)
│   ├── auth.ts              # Login/register
│   ├── user.ts              # Tags CRUD + related
│   └── ...
├── models/
│   └── schema.sql           # PostgreSQL schema
├── middleware/
│   ├── auth.ts              # JWT verification
│   └── rateLimit.ts         # Rate limiting
└── index.ts                 # Entry point, routes, cron
```
