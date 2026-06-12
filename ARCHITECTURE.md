# PULSE — Backend Architecture

> Техническая документация backend'а. Логика, flow, принятие решений.
> Последнее обновление: 2026-06-12 (v9.5.0 — 39/39 saved + News Processor tagging + end-to-end verified)

---

## Содержание

1. [News Pipeline](#1-news-pipeline) — v9.0 flow с News Processor
2. [RSS Fetcher](#2-rss-fetcher-rssfetcherts--v90) — **только fetch + raw INSERT**
2a. [NewsSourceManager](#2a-newssourcemanager-newssourcemanagerts--v93) — единый пул (RSS+Finnhub) + **News Processor v3**
2b. [News Feed Filtering](#2b-news-feed-filtering-get-apinewstagstagid) — matched_tags, поиск по тегу
3. [Smart Tag Matching](#3-smart-tag-matching)
4. [Duplicate Detection](#4-duplicate-detection)
5. [Database Layer](#5-database-layer)
6. [Translation](#6-translation)
7. [Unified LLM Batch](#7-unified-llm-batch-v717)
8. [Sentiment Analysis](#8-sentiment-analysis)
9. [User-Defined Tags](#9-user-defined-tags)
9a. [Tag Search](#9a-tag-search--поиск-тегов-по-enriched-полям)
9b. [NewsDetailModal — enriched data](#9b-newsdetailmodal--enriched-data-блок)
9c. [Добавление тега — LLM flow](#9c-добавление-тега--llm-enrichment-flow)
9d. [TODO: GIN индекс](#9d-todo-gin-индекс-для-performance)
9e. [Обратная связь при ошибке](#9e-обратная-связь-при-ошибке-добавления-тега)
9f. [Schema fix — enriched_data в schema.sql](#9f-schema-fix--enriched_data-в-schemasql)
9g. [NewsFeed — фильтр по тегу](#9g-newsfeed--фильтр-по-тегу)
9h. [Дублирующий GET endpoint](#9h-дублирующий-get-endpoint--данные-не-подтягивались)
9i. [Tag Detail Modal — фиксы редактирования](#9i-tag-detail-modal--фиксы-редактирования-тега)
10. [API Design](#10-api-design)
10a. [Daily Summary](#10a-daily-summary--ai-саммари-для-пользователя)
11. [Cron Jobs](#11-cron-jobs)
12. [Services Map](#12-services-map)
13. [Batch Processing & Job Lock](#13-batch-processing--job-lock)
14. [Performance](#14-performance)

---

## 1. News Pipeline

### Полный flow обработки новости (v9.3 — News Processor)

**Принцип:** Fetch и Process — раздельные слои. News Processor = единое окно обогащения.

**v9.3 изменение:** News Processor обрабатывает ВСЕ статьи без тегов (EN + RU), не только EN.
Маркер обработки: `sentiment_source IS NOT NULL`.

**Verified:** 39 Finnhub статей → News Processor → matched_tags заполнены (4 nvda + другие тикеры)

```
LAYER 0 — FETCH (только сохраняет, не обрабатывает)

┌─────────────────┐     ┌─────────────────┐
│   RSS Fetcher   │     │  Finnhub Fetch  │     (любой новый adapter)
│   (cron.ts)     │     │  (finnhubAdapter)│     → INSERT сырое
│   каждые 5 мин  │     │   каждый час    │
└────────┬────────┘     └────────┬────────┘
         │                        │
         ▼                        ▼
┌─────────────────────────────────────────────────────┐
│              PostgreSQL: news                       │
│                                                     │
│  ┌─────────────────┐  ┌──────────────────────────┐ │
│  │ RU статьи       │  │ EN статьи                │ │
│  │ (TG Parser,     │  │ (RSS EN, Finnhub)        │ │
│  │  русские RSS)   │  │                          │ │
│  │                 │  │ title_ru = NULL          │ │
│  │ title_ru =      │  │ summary_ru = NULL        │ │
│  │   title_original│  │ sentiment = NULL         │ │
│  │ summary_ru =    │  │ needs_translation = TRUE │ │
│  │   summary_orig  │  │  ← маркер "сырой"       │ │
│  │                 │  │                          │ │
│  │ needs_translation│ │ News Processor обработает │ │
│  │   = FALSE       │  │ translate → sentiment    │ │
│  │  ← уже готова   │  │                          │ │
│  └─────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────┘
         │
         ▼
LAYER 1+2 — PROCESS (единое окно, EN + RU)

┌──────────────────────────────────────────────────┐
│         News Processor (newsProcessor.ts)        │
│              каждые 10 мин                        │
│  SELECT WHERE needs_translation = TRUE           │
│       OR (matched_tags = '{}'                    │
│           AND sentiment_source IS NULL)           │
│  (LIMIT 50)                                       │
│  → EN: translate + sentiment + tags              │
│  → RU: sentiment + tags (translate skip)         │
│  → sentiment_source = 'llm'/'keyword'  ◄ маркер │
│         │                                        │
│         ▼                                        │
│  ┌──────────────┐  ┌──────────────────────┐     │
│  │ Translate    │  │ Sentiment Analysis   │     │
│  │ EN → RU      │  │ + tag_impact         │     │
│  │ (best effort)│  │ + is_political       │     │
│  └──────────────┘  └──────────────────────┘     │
│         │                                        │
│         ▼                                        │
│  UPDATE: title_ru=$1, sentiment=$2,            │
│          needs_translation = FALSE               │
└──────────────────────────────────────────────────┘
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

## 2. RSS Fetcher (rssFetcher.ts) — v9.0

> **Только Layer 0 (fetch).** Вся обработка перенесена в News Processor.

### 35 источников (16 RU + 19 EN)

| Категория | Источники | Кол-во |
|-----------|-----------|--------|
| **RU** | lenta, kommersant, rbc, vedomosti, interfax, rt, izvestia | 7 |
| **RU (отключены)** | ~~tass~~, ~~ria~~ | — |
| **Finam** | finam_companies, finam_news, finam_forecasts, finam_world, finam_analytics, finam_bonds_news, finam_bonds_comments | 7 |
| **EN** | seekingalpha, reuters, bloomberg, techcrunch, cnbc, ft, wsj, economist, forbes, cnn, bbc, guardian, marketwatch | 13 |
| **Tech** | verge, wired, arstechnica, hackernews | 4 |
| **Crypto** | coindesk, cointelegraph | 2 |
| **Energy** | oilprice, mining | 2 |
| **Всего** | | **35** |

### Что делает RSS cron (cron.ts)

| Этап | ДО (v7) | ПОСЛЕ (v9) |
|------|---------|------------|
| Fetch RSS | ✅ | ✅ |
| Translate EN→RU | ✅ | ❌ **News Processor** |
| Smart Match Tags | ✅ | ❌ **News Processor** |
| Sentiment analysis | ✅ | ❌ **News Processor** |

#### INSERT — различие RU vs EN

| Язык | title_ru | summary_ru | needs_translation | Кто обрабатывает |
|------|----------|------------|-------------------|------------------|
| **RU** (`lang='ru'`) | `= title_original` (копия) | `= summary_original` | `FALSE` | **Уже готова** — не ждёт News Processor |
| **EN** (`lang='en'`) | `NULL` | `NULL` | `TRUE` | News Processor: translate + sentiment |

```sql
-- RU статья (TG Parser, русские RSS)
INSERT INTO news (title_original, title_ru, summary_ru, ... needs_translation)
VALUES ('Заголовок', 'Заголовок', 'Текст', ... FALSE)

-- EN статья (Finnhub, английские RSS)
INSERT INTO news (title_original, title_ru, summary_ru, ... needs_translation)
VALUES ('Headline', NULL, NULL, ... TRUE)
```

**EN:** NULL-поля заполняются News Processor при обработке.  
**RU:** копируются сразу — пользователь видит заголовок без ожидания.

### Управление источниками (вкл / выкл)

Источники хранятся в **коде** (`src/services/rssSources.ts`), не в БД.

#### Как отключить источник (закомментировать)

```typescript
// src/services/rssSources.ts
export const RSS_SOURCES: RssSource[] = [
  // ...
  // TODO: временно отключено — раскомментировать при необходимости
  // { id: 'tass', name: 'ТАСС', url: 'https://tass.ru/rss/v2.xml', lang: 'ru', category: 'news' },
  // { id: 'ria', name: 'РИА Новости', url: 'https://ria.ru/export/rss2/archive/index.xml', lang: 'ru', category: 'news' },
  // ...
];
```

1. Найти источник в массиве `RSS_SOURCES`
2. Закомментировать строку `//`
3. Добавить `TODO` с причиной
4. Обновить комментарий `// RSS Sources — X total` в шапке
5. **Git commit + push** → Render пересоберёт автоматически

#### Как включить источник обратно (раскомментировать)

1. Убрать `//` перед `{ id: ... }`
2. Убрать `TODO` если больше не актуален
3. Обновить комментарий `// RSS Sources — X total` в шапке
4. **Git commit + push**

#### Что происходит при отключении

| Что | Результат |
|-----|-----------|
| Новости из источника | Перестают фетчиться |
| Старые новости в БД | **Остаются**, не удаляются |
| `rss_source_meta.last_fetched_at` | Остаётся в БД, не мешает |
| Пользователи | Видят меньше новостей |

#### Почему не через БД / админку

- Простота: не нужен UI, endpoint'ы, миграции
- Безопасность: случайное удаление невозможно (только git)

---

## 2a. NewsSourceManager (newsSourceManager.ts) — v9.4

> Единый пул источников (RSS + API). Заменяет разрозненные cron-задачи.
> Дата: 2026-06-12 | Статус: В продакшене

### Архитектура

```
NewsSourceManager.run()
│
│  0. Backfill: UPDATE news SET matched_tags по тикерам (title/summary ILIKE '%TICKER%')
│  1. SELECT * FROM news_sources WHERE enabled = true
│  2. Для каждого source:
│     ├── RSS: fetchAllRSS() → saveArticles()
│     │           └── last_fetch_at обновляется ТОЛЬКО при реальном fetch
│     └── API (finnhub): fetchAndSaveFinnhubNews() → streaming fetch+save
│               └── last_fetch_at обновляется ТОЛЬКО при реальном fetch (не skip)
│  3. Catch-up: если last_fetch_at > 2ч → запуск
```

**v9.4 изменения:**
- `last_fetch_at` обновляется **только при реальном fetch**, не при skip
  - Предотвращает: infinite skip loop (0 статей → skip → last_fetch_at свежий → снова skip)
- First run определяется по `source_id = 'finnhub'` (не `source_type`)
  - Предотвращает: first run пропущен когда другие `api_search` источники есть в базе
- **Streaming**: fetch→save→discard по чанкам. Нет накопления статей в памяти.

### Таблица news_sources

| Колонка | Тип | Описание |
|---------|-----|----------|
| id | SERIAL PK | — |
| name | VARCHAR(50) | `kommersant`, `finnhub` |
| display_name | VARCHAR(100) | `Коммерсант`, `Finnhub News` |
| type | VARCHAR(20) | `rss` \| `api_search` \| `api_feed` |
| config | JSONB | `{url, api_key, rate_limit_rpm}` |
| enabled | BOOLEAN | Вкл/выкл в админке |
| last_fetch_at | TIMESTAMP | Для rate limiting |

### Admin endpoints

| Method | Path | Описание |
|--------|------|----------|
| GET | `/admin/news-sources` | Список всех источников |
| PUT | `/admin/news-sources/:id/toggle` | Вкл/выкл toggle |

### Finnhub Adapter (finnhubAdapter.ts) — v9.4

> Streaming + step-by-step INSERT. 6 критичных багов исправлены.

**Архитектура (v9.4):**

```
fetchAndSaveFinnhubNews(config)
│
│  1. SELECT тикеры (exchange='USA') из user_defined_tags + portfolios
│  2. Определить период: first run → 7 дней, обычный → 1 день
│     └── first run: COUNT(*) WHERE source_id = 'finnhub' = 0
│  3. Parallel fetch по 5 тикеров (Promise.all) + sleep(1s) между batches
│     ├── fetchWithRetry() — 3 попытки, exponential backoff
│     ├── fetchWithTimeout() — AbortController 15s
│     ├── isValidArticle() — guard (пустые headline/url пропускаются)
│     └── CircuitBreaker — 5 ошибок → 30мин пауза
│  4. aggregateByNormalizedUrl() — merge дубликатов по url_normalized
│     └── одна статья для разных тикеров = merge matched_tags
│  5. Step-by-step INSERT — каждая статья отдельным запросом
│     └── ON CONFLICT (url) DO UPDATE — merge matched_tags + all_sources
│  6. Return: { totalFetched, totalSaved, totalMerged, durationMs, errors }
```

**Результат:** 39 fetched → **39 saved, 0 errors** (verified)

**Почему step-by-step INSERT (не batch):**
- `jsonb_to_recordset` batch INSERT падает на `UNIQUE(url)` при intra-batch duplicates
- `ON CONFLICT` работает корректно только когда conflict с **уже существующей** строкой
- Step-by-step: каждая статья — отдельный запрос → `ON CONFLICT` merge'ит надежно

**Почему НЕТ aggregateByNormalizedUrl() (removed v9.5):**
- `normalizeUrl("?id=abc")` → `"finnhub.io/api/news"` — одинаковый для всех 39 статей
- `Map.get()` схлопывал 39 → 1-2 статьи — **39 потерянных статей**
- Решение: pass batch напрямую → `UNIQUE(url)` защищает (каждый `?id=xxx` уникален)

**INSERT — batch `unnest` (v9.2):**
```sql
INSERT INTO news (..., matched_tags, needs_translation)
SELECT * FROM unnest($1::text[], ..., $15::text[], $16::boolean[])
ON CONFLICT (url) DO UPDATE SET
  matched_tags = (SELECT array_agg(DISTINCT x) FROM unnest(
    array_cat(COALESCE(news.matched_tags, '{}'::text[]), EXCLUDED.matched_tags)
  ) AS t(x)),
  all_sources = (...),  -- merge
  source_count = (...)  -- recalc
-- BATCH_SIZE = 500 (один запрос на 500 статей)
```

**v9.1 → v9.4 — Исправленные баги:**

| Баг | Проблема | Фикс |
|-----|----------|------|
| **B1** | `batch.map(() => a.source_count)` → ReferenceError | `batch.map(() => 1)` |
| **B2** | `JSON.stringify(text[])` → PostgreSQL получал строку вместо массива | Убран `JSON.stringify`, pg драйвер конвертирует нативно |
| **B3** | Parallel fetch без sleep → 429 бан от Finnhub | `sleep(1000)` между batches |
| **B4** | Все статьи накапливались в `results[]` → OOM при 200+ тикерах | Streaming: fetch→save→discard по чанкам |
| **B5** | `BATCH_SIZE = 100` → 50 round-trips на 5000 статей | `BATCH_SIZE = 500` |
| **B6** | `FETCH_TIMEOUT = 30000` → Render убивал инстанс | `FETCH_TIMEOUT = 15000` |
| **B7** | `UNIQUE(url_normalized)` — `normalizeUrl()` даёт одинаковый результат для URL с разными `?id=xxx` | **Убрано** — `UNIQUE(url)` достаточно |
| **B8** | `last_fetch_at` обновлялся при skip → вечный skip цикл | Обновляется **только при реальном fetch** |
| **B9** | First run определялся по `source_type = 'api_search'` — пропускался при других API | Определяется по `source_id = 'finnhub'` |

**Конфигурируемые константы** (через `news_sources.config` JSONB):

| Параметр | Default | Описание |
|----------|---------|----------|
| `fetch_timeout_ms` | 15000 | Таймаут HTTP-запроса |
| `max_retries` | 3 | Попыток retry на тикер |
| `concurrency_limit` | 5 | Parallel fetch тикеров |
| `batch_size` | 500 | Batch INSERT размер |
| `rate_limit_delay_ms` | 1000 | Sleep между parallel batches |
| `lookback_days_first` | 7 | Дней истории при первом запуске |
| `lookback_days_regular` | 1 | Дней истории обычный запуск |
| `cb_threshold` | 5 | Ошибок до открытия Circuit Breaker |
| `cb_timeout_ms` | 1800000 | Пауза Circuit Breaker (30 мин) |

**Интерфейс:**
```typescript
// NewsSourceManager вызывает:
const result = await fetchAndSaveFinnhubNews(config);
// { totalFetched, totalSaved, totalMerged, durationMs, errors }

// Backward compatibility:
export { fetchAndSaveFinnhubNews as fetchFinnhubNews }; // alias
export { saveArticles }; // для RSS
```

**Текущие ограничения:**
- Перевод EN→RU **в News Processor** (не в адаптере)
- Интервал фетча: **5 минут** (все тикеры)
- Tiered fetching: **убран** (все тикеры каждый цикл)
- published_at: **TIMESTAMPTZ** (v9.2 миграция)

### Колонки news для bilingual

#### LLM Metrics — keyword fallback tracking

| Сценарий | `sentiment_source` | `llm_batches.status` |
|----------|-------------------|---------------------|
| LLM успех | `'llm'` | `'success'` |
| LLM частичный | `'llm-partial'` | `'partial'` |
| LLM ошибка | `'llm-error'` | `'error'` |
| **Баланс Кими пуст** | **`'keyword'`** | **`'keyword-only'`** |

Dashboard (`/admin/llm-dashboard`) показывает `keyword_fallback: N` для `'keyword-only'` батчей.

| Колонка | Назначение |
|---------|-----------|
| `title_original` | Оригинальный заголовок (EN для Finnhub) |
| `title_ru` | RU заголовок (перевод или копия original) |
| `summary_original` | Оригинальный summary |
| `summary_ru` | RU summary |
| `source_type` | `rss` \| `api_search` — для фильтрации |
| `lang_original` | `en` \| `ru` |
| `matched_tags` | TEXT[] — tag_id из Finnhub или backfill |
| `needs_translation` | BOOLEAN — маркер "сырой" статьи (TRUE = ждёт News Processor) |

**title_ru — nullable (v9.0 critical fix):**
```sql
ALTER TABLE news ALTER COLUMN title_ru DROP NOT NULL;
-- Причина: Finnhub вставляет title_ru = NULL, News Processor заполняет позже
```

**published_at — TIMESTAMPTZ (v9.2):**
```sql
ALTER TABLE news ALTER COLUMN published_at TYPE TIMESTAMPTZ;
-- Причина: timezone-aware сортировка для пользователей в разных TZ
```

**news_sources.error_count (v9.2):**
```sql
ALTER TABLE news_sources ADD COLUMN IF NOT EXISTS error_count INTEGER DEFAULT 0;
-- Счётчик ошибок для мониторинга (инкрементируется в logSourceError)
```

### News Processor (newsProcessor.ts) — v9.0

> Единое окно обработки (Layer 1 + Layer 2). Обрабатывает ТОЛЬКО сырые EN-статьи — RU уже готовы.

#### Архитектура

```
processRawArticles()
│
│  0. acquireCronLock('news-processor') — не конфликтует с RSS
│  1. SELECT * FROM news WHERE needs_translation = TRUE LIMIT 50
│     → RU статьи (needs_translation=FALSE) — пропускаются
│     → EN статьи (needs_translation=TRUE) — обрабатываются
│  2. translateArticles() — EN→RU (best effort, не блокирует sentiment)
│  3. matchTags() — smartMatchTags для каждой статьи
│  4. analyzeSentiment() — unified batch (sentiment + tag_impact + is_political)
│  5. UPDATE: needs_translation = FALSE, title_ru=$1, sentiment=$2...
```

#### Почему RU статьи не обрабатываются

| Язык | needs_translation | Причина |
|------|-------------------|---------|
| **RU** | `FALSE` | Заголовок уже на русском — копия title_original. Карточка видна сразу. |
| **EN** | `TRUE` | Нужен перевод + sentiment — обрабатывается News Processor. |

**Важно:** Если баланс Кими пуст — EN статьи показываются с оригинальным заголовком (`COALESCE(title_ru, title_original)`).

#### needs_translation маркер

| Значение | Что означает | Кто ставит |
|----------|-------------|------------|
| `TRUE` | Статья сырая — нужна обработка | RSS cron (INSERT), Finnhub (INSERT), Default |
| `FALSE` | Статья обработана — готова | News Processor (UPDATE) |

#### При duplicate (RSS + Finnhub одна новость)

```
Finnhub: INSERT needs_translation = TRUE, matched_tags = ['nvidia']
RSS:    ON CONFLICT UPDATE — matched_tags merge, needs_translation не меняет
Result: needs_translation = TRUE, matched_tags = ['nvidia', ...]
        → News Processor обработает с полным набором тегов
```

#### Cron schedule (v9.3 — "одно окно")

| Процесс | Интервал | Lock | Примечание |
|---------|----------|------|------------|
| **NSM (RSS + Finnhub)** | **5 мин** | **`nsm`** | **Единый fetch всех enabled источников** |
| **News Processor** | **10 мин** | **`news-processor`** | **Translate + sentiment + tags для EN + RU** |

**v9.3 изменения:**
- ❌ `cron.ts` отключён (`startCron()` закомментирован)
- ✅ RSS + Finnhub = один процесс `nsm.run()`
- ✅ News Processor обрабатывает EN + RU (раньше только EN)
- ✅ Маркер обработки: `sentiment_source IS NOT NULL`

#### Trigger endpoints

```bash
# NewsSourceManager (Fetch — RSS + Finnhub)
curl "https://pulse-api-bsov.onrender.com/trigger/nsm?secret=pulse-dev-key"

# News Processor (Process — translate + sentiment + tags)
curl "https://pulse-api-bsov.onrender.com/trigger/process?secret=pulse-dev-key"
```

Fallback: всегда `setInterval(5 мин / 10 мин)`. `CRON_SECRET_KEY` защищает только endpoints, не влияет на фоновые процессы.

#### Admin endpoints (v9.3)

```bash
# Count articles by filters
curl -X POST https://pulse-api-bsov.onrender.com/admin/news-count \
  -H "Content-Type: application/json" \
  -H "x-trigger-secret: pulse-dev-key" \
  -d '{"matched_tags": ["nvda"], "source_id": "finnhub"}'

# Delete articles by filters (dry_run first!)
curl -X POST https://pulse-api-bsov.onrender.com/admin/news-delete \
  -H "Content-Type: application/json" \
  -H "x-trigger-secret: pulse-dev-key" \
  -d '{"matched_tags": ["nvda"], "source_id": "finnhub", "dry_run": true}'

# Filters: matched_tags[], source_id, lang_original, date_from, date_to, title_contains
```

#### Fallback при пустом балансе Кими

| Этап | При 429 | Результат |
|------|---------|-----------|
| Translate | `catch → return` | title_ru = NULL → `COALESCE(title_ru, title_original)` покажет EN |
| Sentiment | Keyword-based | `sentiment = 'neutral'`, `sentiment_source = 'keyword'` |
| Tag matching | Всегда работает | `matched_tags` через keyword dictionary |

---

## 2b. News Feed Filtering (GET /api/news/tags/:tagId)

### Логика

```sql
-- PostgreSQL
SELECT * FROM news
WHERE $1 = ANY(matched_tags)
AND published_at > NOW() - INTERVAL '90 days'
ORDER BY published_at DESC LIMIT 50
```

| Что | Как работает |
|-----|-------------|
| Тег `nvidia` → tag_id `nvidia` | `matched_tags @> '{nvidia}'` |
| Finnhub статьи NVDA | `matched_tags = ['nvidia']` при INSERT |
| Старые RSS-статьи | Backfill по тикеру в title/summary |
| Frontend | `GET /api/news/tags/${tagId}` → NewsFeed loadArticles(tagId) |
- Прозрачность: история изменений в git log
- Trade-off: требует деплоя для каждого изменения

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
-- v9.4: DROP UNIQUE(url_normalized) — normalizeUrl() даёт одинаковый результат
-- для URL с разными query params (?id=xxx). UNIQUE(url) достаточно.
ALTER TABLE news DROP CONSTRAINT IF EXISTS news_url_norm_unique;
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

### LLM Enrichment — когда вызывается

**Критично:** LLM enrichment (описание, related_entities, key_products) вызывается
**только** при `tagType = 'auto'` или пустом `tagType`.

```typescript
// backend/src/services/tagManager.ts:createUserTag()
if (!tagType || tagType === 'auto') {
  enrichment = await enrichTagViaLLM(tagName);  // ← вызываем LLM
}
```

**Баг (2026-06-08):** Frontend передавал `tagType: 'company'` при ручном вводе:
```typescript
// frontend/src/pages/Home.tsx — ДО фикса
addTag({ tagId, tagName, tagType: 'company' })  // ← 'company' ≠ 'auto'!
```
Результат: тег создавался без `enriched_data` — пустышка (только имя).

**Фикс:** `tagType: 'company'` → `'auto'` (commit `0164be4`):
```typescript
// frontend/src/pages/Home.tsx — ПОСЛЕ фикса
addTag({ tagId, tagName, tagType: 'auto' })  // ← LLM вызовется
```

**Баг `3c9b596` (2026-06-09):** GET `/admin/tags/:tagId` не возвращал `synonyms_ru`/`synonyms_en`. PUT сохранял в `enriched_data`, но GET не извлекал — админ видел пустые поля после сейва.

**Фикс:** добавлены `synonymsRu`/`synonymsEn` в извлечение из `enriched_data` и в JSON ответ GET endpoint.

**Правило:** Frontend всегда шлёт `'auto'` — backend сам решает тип через LLM.
Админка может передать конкретный тип, но не при создании пользователем.

### Регистр тегов (Case Sensitivity)

**Все tag_id в системе — lowercase.** Регистр не влияет на матчинг, подписки, фильтрацию.

#### Почему регистро-независимость работает

| Компонент | Где lowercase | Пример |
|-----------|--------------|--------|
| **Создание tag_id** | `tagName.toLowerCase()` | `"СБЕР"` → `"сбер"` |
| **Keyword matching** | `text.toLowerCase()` + `kw.toLowerCase()` | `"Сбер"` в тексте матчит `"сбер"` |
| **Keywords в БД** | `.toLowerCase()` при генерации | `["сбер", "sber", ...]` |
| **API endpoints** | `req.params.tagId.toLowerCase()` | `"СБЕР"` → `"сбер"` |
| **matched_tags[]** | lowercase tag_id | `["сбер", "apple"]` |
| **portfolios.tag_id** | lowercase tag_id | `"сбер"` |

#### Что ОТЛИЧАЕТСЯ — только `tag_name`

| Поле | Регистр | Пример |
|------|---------|--------|
| `tag_id` (PK) | **lowercase** | `"сбер"` |
| `tag_name` (display) | **как ввели** | `"Сбер"` или `"СБЕР"` |

`tag_name` — только для отображения в UI. Вся логика работает через `tag_id`.

#### API endpoints — нормализация tagId

Все endpoint'ы с `:tagId` параметром применяют `.toLowerCase()`:

```typescript
// src/index.ts — все 5 endpoint'ов
const tagId = req.params.tagId.toLowerCase();
```

| Endpoint | Назначение |
|----------|-----------|
| `GET /admin/tags/:tagId` | Детали тега |
| `PUT /admin/tags/:tagId` | Редактирование тега |
| `DELETE /admin/tags/:tagId` | Удаление тега |
| `GET /admin/tags/:tagId/delete-preview` | Preview удаления |
| `GET /api/tags/:tagId/articles` | Статьи по тегу |

> **Защита от API-вызовов:** если кто-то вызовет `GET /admin/tags/СБЕР` — отработает корректно (→ `"сбер"`).

#### Frontend — case-insensitive safety input

`DeleteConfirmModal.tsx` — safety input для удаления тега тоже case-insensitive:

```typescript
// src/components/admin/DeleteConfirmModal.tsx
const isSafetyMatch = safetyInput.toLowerCase() === tagId.toLowerCase()
const handleDelete = async () => {
  if (safetyInput.toLowerCase() !== tagId.toLowerCase()) return
  // ...
}
```

Пользователь может ввести `"sber"`, `"SBER"` или `"Сбер"` — safety input пропустит любой регистр. Защита от mixed-case `tag_id` в БД.

#### Удаление тега — полный UX flow (SIMULATION_TAG_DELETE)

**Участники:** TagsTab → TagDetailModal → DeleteConfirmModal → Backend API

**Flow:**
```
TagsTab (список)
  → клик на тег → onSelectTag(tagId)
    → TagDetailModal mount'ится → load() → GET /admin/tags/:tagId
      → клик "Delete Tag" → setShowDeleteConfirm(true)
        → DeleteConfirmModal mount'ится → GET /admin/tags/:tagId/delete-preview
          → safety input → клик "Delete Forever"
            → DELETE /admin/tags/:tagId → 200 OK
              → onDeleted() → dispatchEvent('tag:deleted') → TagsTab filter
```

**Защитные механизмы:**

| Механизм | Где | Как работает |
|----------|-----|-------------|
| Safety input | DeleteConfirmModal | Ввод exact tag_id для подтверждения удаления |
| Case-insensitive | DeleteConfirmModal + Backend | `safetyInput.toLowerCase() === tagId.toLowerCase()` |
| Кнопка disabled | DeleteConfirmModal | `disabled={!isSafetyMatch \|\| deleting}` — защита от двойного клика |
| Транзакция | Backend | `BEGIN → 7 шагов → COMMIT/ROLLBACK` — атомарность |
| Мгновенное обновление UI | TagsTab | `addEventListener('tag:deleted')` → `filter()` — без F5 |

**Обработка ошибок:**

| Сценарий | Backend | Frontend |
|----------|---------|----------|
| Тег не найден (404) | 404 → JSON `{error: 'Tag not found'}` | `setDeleteError('Tag not found')` — красный баннер |
| Сеть упала | Нет ответа | `setLoadError('Failed to load tag')` — Retry/Close |
| Сессия протухла (401) | 401 | `clearAuth()` → редирект на логин |
| SQLite mode | 500 `{code: 'SQLITE_UNSUPPORTED'}` | `setDeleteError('SQLite mode not supported...')` |
| Race condition (другой админ удалил) | 404 на DELETE | `setDeleteError('Tag not found')` |

**Известные edge cases и фиксы:**

| # | Проблема | Фикс | Коммит |
|---|----------|------|--------|
| 1 | Вечный спиннер при ошибке загрузки TagDetailModal | `loadError` state + UI Retry/Close | `fbe813a` |
| 2 | `onClose` ДО `dispatchEvent` — потеря события | `dispatchEvent` первым в `handleDeleted` | `fbe813a` |
| 3 | `setState` на unmounted DeleteConfirmModal | `mounted`-флаг в `useEffect` cleanup | `fbe813a` |
| 4 | Double `client.release()` на 404 | Убран явный `release()`, `finally` покрывает | `ea9582d` |

---

## 9a. Tag Search — поиск тегов по enriched-полям

> **Реализовано:** 2026-06-09 (v7.20.0 — TZ_TAG_SEARCH_v2)  
> **Заменяет:** хардкод `allSuggestions` (12 тегов) в Home.tsx

### Endpoint

```
GET /api/tags/search?q={query}
```

| Параметр | Тип | Описание |
|----------|-----|----------|
| `q` | string | Строка поиска, 3-50 символов |

**Валидация:** `< 3` → 400, `> 50` → 400

### SQL — substring по 7 полям

```sql
SELECT
  tag_id,
  tag_name,
  tag_type,
  enriched_data->>'ticker' as ticker
FROM user_defined_tags
WHERE
  tag_name              ILIKE '%' || $1 || '%'   -- "Яндекс", "Apple"
  OR enriched_data->>'ticker'        ILIKE '%' || $1 || '%'   -- "AAPL"
  OR EXISTS (
    SELECT 1 FROM unnest(keywords) k
    WHERE k ILIKE '%' || $1 || '%'                -- "сбер", "sber"
  )
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      COALESCE(enriched_data->'synonyms_en', '[]'::jsonb)
    ) s WHERE s ILIKE '%' || $1 || '%'            -- "Yandex"
  )
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      COALESCE(enriched_data->'synonyms_ru', '[]'::jsonb)
    ) s WHERE s ILIKE '%' || $1 || '%'            -- "яндкс"
  )
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      COALESCE(enriched_data->'key_products', '[]'::jsonb)
    ) s WHERE s ILIKE '%' || $1 || '%'            -- "iPhone", "Falcon 9"
  )
  OR EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(
      COALESCE(enriched_data->'related_entities', '[]'::jsonb)
    ) s WHERE s ILIKE '%' || $1 || '%'            -- "Tesla", "NASA"
  )
LIMIT 10
```

**Ключевые особенности:**
- **Substring:** `ILIKE '%iph%'` находит `"iPhone"` (не exact)
- **Регистр неважен:** `ILIKE` (не `LIKE`)
- **Защита от NULL:** `COALESCE(..., '[]'::jsonb)` — пустой JSONB массив вместо NULL
- **Разные типы массивов:** `keywords` = `TEXT[]` (`unnest`), остальные = `JSONB` (`jsonb_array_elements_text`)
- **LIMIT 10** — не перегружаем dropdown

### Поля поиска (7 штук)

| # | Поле | Тип в БД | Пример | Как разворачиваем |
|---|------|----------|--------|-------------------|
| 1 | `tag_name` | `VARCHAR` | `"Яндекс"` | Прямое сравнение |
| 2 | `ticker` | `JSONB→text` | `"AAPL"` | `enriched_data->>'ticker'` |
| 3 | `keywords[]` | `TEXT[]` | `["сбер", "sber"]` | `unnest(keywords)` |
| 4 | `synonyms_en[]` | `JSONB→text[]` | `["Yandex"]` | `jsonb_array_elements_text(...)` |
| 5 | `synonyms_ru[]` | `JSONB→text[]` | `["яндкс"]` | `jsonb_array_elements_text(...)` |
| 6 | `key_products[]` | `JSONB→text[]` | `["iPhone"]` | `jsonb_array_elements_text(...)` |
| 7 | `related_entities[]` | `JSONB→text[]` | `["Tesla"]` | `jsonb_array_elements_text(...)` |

### Ответ

```json
{
  "tags": [
    {
      "tag_id": "apple",
      "tag_name": "Apple",
      "tag_type": "company",
      "ticker": "AAPL"
    }
  ],
  "total": 1
}
```

### Frontend: Home.tsx

#### State
```typescript
const [searchResults, setSearchResults] = useState<Suggestion[]>([])
const [searching, setSearching] = useState(false)
```

#### Debounce (200ms)
```typescript
useEffect(() => {
  if (searchValue.trim().length < 3) {
    setSearchResults([])
    setSearching(false)
    return
  }
  setSearching(true)
  const timer = setTimeout(async () => {
    const data = await api.get(`/tags/search?q=${encodeURIComponent(searchValue.trim())}`)
    setSearchResults(data.tags.map(t => ({
      id: t.tag_id, label: t.tag_name, type: t.tag_type
    })))
  }, 200)
  return () => clearTimeout(timer)  // отмена при новом вводе
}, [searchValue])
```

#### Формирование suggestions
```typescript
const filteredSuggestions = searchValue.trim().length < 3
  ? popularTags.filter(s => !selectedTags.some(t => t.id === s.id))
  : searchResults.filter(s => !selectedTags.some(t => t.id === s.id))
```

| Условие | Что показывается |
|---------|-----------------|
| Клик на input (пустой) | `popularTags` — 5 популярных тегов |
| Ввод `< 3 символов` | `popularTags` — fallback |
| Ввод `≥ 3 символов` | `Loader2` спиннер → потом результаты API |

#### Dropdown UI
```tsx
<motion.div className="absolute top-full left-0 right-0 mt-2 rounded-2xl ...">
  {searching && <Loader2 className="animate-spin" />}
  {filteredSuggestions.map((s, i) => (
    <button onMouseDown={() => handleSelectSuggestion(s)}>
      <span style={{backgroundColor: typeColors[s.type]}} /> {s.label}
    </button>
  ))}
</motion.div>
```

### Сценарии поиска

| Что вводит | Находит | По полю |
|-----------|---------|---------|
| `"Яндекс"` | Яндекс | `tag_name` |
| `"yandex"` | Яндекс | `synonyms_en` |
| `"AAPL"` | Apple | `ticker` |
| `"aapl"` | Apple | `ticker` (ILIKE) |
| `"iph"` | Apple | `key_products` → `"iPhone"` |
| `"сбер"` | Сбербанк | `keywords` |
| `"Tesla"` | SpaceX | `related_entities` |

### Категории тегов (tag_type)

| Категория | Пример | Цвет в UI |
|-----------|--------|-----------|
| `company` | Apple, Сбербанк, Bitcoin | `#00D4FF` |
| `sector` | Технологии, ФРС США | `#A78BFA` |
| `person` | Греф, Маск | `#FBBF24` |
| `trend` | ИИ, Криптовалюты | `#34D399` |

> **Нет категории `crypto` как отдельного типа тега.** Bitcoin создаётся с `tag_type: 'company'` или `'trend'`. RSS-источники `coindesk`/`cointelegraph` имеют `category: 'crypto'`, но это категория фида, не тип тега.

---

## 9b. NewsDetailModal — enriched data блок

> **Реализовано:** 2026-06-09 (v7.19.0)

### Endpoint для enriched data тегов новости

```
GET /api/news/:id/tag-enrichments
```

Возвращает `enriched_data` для **всех** тегов новости (matched_tags + tag_impact).

**⚠️ Порядок маршрутов критичен:** `/:id/tag-enrichments` ДОЛЖЕН идти ДО `/:id` в Express router. Иначе `"123/tag-enrichments"` попадает в `/:id` как `id = "123/tag-enrichments"` → 400.

### SQL
```sql
SELECT tag_id, tag_name, enriched_data
FROM user_defined_tags
WHERE tag_id = ANY($1::text[])  -- массив tag_id из matched_tags + tag_impact
```

### Отображение в NewsDetailModal

Для каждого тега — отдельная карточка:

| Поле | Стиль |
|------|-------|
| **tag_name** | Белый заголовок |
| **ticker** | Зелёный `$TICKER` бейдж |
| **website** | Синяя ссылка |
| **description_ru** | Серый текст |
| **related_entities[]** | Синие пилюли |
| **key_products[]** | Серые пилюли |
| **synonyms_en/ru[]** | Фиолетовые мини-бейджи |

### Загрузка (Promise.all)
```typescript
const [articleData, enrichData] = await Promise.all([
  api.get(`/news/${newsId}`),                    // детали статьи
  api.get(`/news/${newsId}/tag-enrichments`),     // enriched data тегов
])
```

---

## 9c. Добавление тега — LLM enrichment flow

> **Баг 0164be4 (2026-06-09):** Frontend передавал `tagType: 'company'` → LLM НЕ вызывался.

### Когда вызывается LLM

```typescript
// tagManager.ts:createUserTag()
if (!tagType || tagType === 'auto') {
  enrichment = await enrichTagViaLLM(tagName);   // ← ВЫЗЫВАЕТСЯ
}
```

**Только** при `tagType = 'auto'` или пустом. При конкретном типе (`'company'`, `'sector'`) — LLM **не** вызывается.

### Frontend всегда шлёт `'auto'`

```typescript
// Home.tsx — ручной ввод + Enter
addTag({ tagId, tagName, tagType: 'auto' })  // ← LLM вызовется

// handleSelectSuggestion (клик на suggestion)
addTag({ tagId: s.id, tagName: s.label, tagType: s.type })  // ← из suggestion (может быть 'auto')
```

### Flow создания тега

```
Пользователь вводит "SpaceX" → Enter
  ↓
Frontend: addTag({ tagId: "spacex", tagName: "SpaceX", tagType: "auto" })
  ↓
Backend: POST /user/tags → createUserTag()
  ↓
  if (tagType === 'auto') → enrichTagViaLLM("SpaceX")
    ├──→ tag_type: "company"
    ├──→ ticker: null
    ├──→ website: "https://www.spacex.com"
    ├──→ related_entities: ["Tesla", "NASA", "Blue Origin"]
    ├──→ synonyms_en: ["Space Exploration Technologies"]
    ├──→ synonyms_ru: ["СпейсИкс"]
    ├──→ key_products: ["Falcon 9", "Starship", "Dragon", "Starlink"]
    └──→ description_ru: "2 параграфа на русском"
  ↓
  INSERT INTO user_defined_tags (tag_id, tag_name, ..., enriched_data)
  INSERT INTO portfolios (user_id, tag_id)  -- подписка пользователя
  ↓
Frontend: setLastAddedTagId("spacex") → зелёная подсветка (1500ms)
```

### Loading state (f7f4be8)

| Состояние | Input | Иконка |
|-----------|-------|--------|
| `isAddingTag = false` | Активный | X (очистить) |
| `isAddingTag = true` | Disabled, placeholder "Создаём тег..." | Loader2 (spin) |

```typescript
setIsAddingTag(true)
try {
  const success = await addTag({...})
} finally {
  setIsAddingTag(false)  // гарантия сброса
}
```

---

## 9d. TODO: GIN индекс для performance

> **Приоритет:** P2 (не критично на текущем масштабе)  
> **Когда:** когда тегов станет 1000+ и поиск замедлится

### Проблема

Текущий SQL использует `ILIKE '%query%'` + `jsonb_array_elements_text()` — **не использует индекс**. На 1000+ тегов запрос будет медленным (100-500ms).

### Решение: PostgreSQL GIN index

```sql
-- Создать computed колонку для поиска (tsvector)
ALTER TABLE user_defined_tags ADD COLUMN search_vector tsvector;

-- Обновить существующие записи
UPDATE user_defined_tags SET search_vector = (
  setweight(to_tsvector('simple', coalesce(tag_name, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce(enriched_data->>'ticker', '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(array_to_string(keywords, ' '), '')), 'B') ||
  setweight(to_tsvector('simple', coalesce(array_to_string(
    (select array_agg(elem::text) from jsonb_array_elements_text(enriched_data->'synonyms_en') elem), ' '),'')), 'C') ||
  setweight(to_tsvector('simple', coalesce(array_to_string(
    (select array_agg(elem::text) from jsonb_array_elements_text(enriched_data->'synonyms_ru') elem), ' '),'')), 'C') ||
  setweight(to_tsvector('simple', coalesce(array_to_string(
    (select array_agg(elem::text) from jsonb_array_elements_text(enriched_data->'key_products') elem), ' '),'')), 'C') ||
  setweight(to_tsvector('simple', coalesce(array_to_string(
    (select array_agg(elem::text) from jsonb_array_elements_text(enriched_data->'related_entities') elem), ' '),'')), 'C')
);

-- Создать GIN индекс
CREATE INDEX idx_user_defined_tags_search ON user_defined_tags USING GIN(search_vector);

-- Триггер для автообновления
CREATE OR REPLACE FUNCTION update_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW.search_vector := (...);  -- та же логика
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_search_vector
  BEFORE INSERT OR UPDATE ON user_defined_tags
  FOR EACH ROW EXECUTE FUNCTION update_search_vector();
```

### SQL запрос с GIN

```sql
SELECT tag_id, tag_name, tag_type, enriched_data->>'ticker' as ticker
FROM user_defined_tags
WHERE search_vector @@ plainto_tsquery('simple', 'iph')
LIMIT 10;
```

**Результат:** 10-50ms вместо 100-500ms на 1000+ тегах.

---

## 9e. Обратная связь при ошибке добавления тега

> **TZ:** TZ_TAG_ADD_ERROR_FEEDBACK_v2  
> **Дата:** 2026-06-10  
> **Файлы:** `frontend/src/hooks/useAuth.tsx`, `frontend/src/pages/Home.tsx`

### Проблема

`addTag()` в `useAuth.tsx` глотал все ошибки:

```typescript
// БЫЛО — ошибка терялась
catch {
  return false  // пользователь не узнавал почему
}
```

Пользователь кликал «+», видел спиннер — и тишину. Причина неясна: лимит? дубль? баг?

### Решение

`addTag()` теперь возвращает объект с ошибкой:

```typescript
// СТАЛО — ошибка передаётся в UI
} catch (err: any) {
  return {
    success: false,
    error: err.message || 'Failed to add tag',
  }
}
```

**Тип:** `Promise<{ success: boolean; error?: string }>`

### HTTP-коды от backend

| Код | Когда | Что видит пользователь |
|-----|-------|----------------------|
| 403 | Лимит тегов (3 free / 10 premium) | «Tag limit reached (max 3). Upgrade to Premium for more.» |
| 409 | Дубль tag_id в портфеле | «Tag already in portfolio» |
| 404 | Тег не найден | «Tag not found» |
| 500 | Внутренняя ошибка | «Failed to add tag» (fallback) |

### UI: inline-ошибка

Вместо toast (библиотеки нет в проекте) — красный баннер под поисковым input:

```tsx
{addTagError && (
  <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs"
       style={{ backgroundColor: '#EF444415', border: '1px solid #EF444430', color: '#EF4444' }}>
    <AlertCircle size={14} />
    <span>{addTagError}</span>
    <button onClick={() => setAddTagError(null)} style={{ color: '#EF444480' }}>✕</button>
  </div>
)}
```

**Поведение:**
- Ошибка сбрасывается при повторном клике «+» (`setAddTagError(null)` перед запросом)
- Ошибка сбрасывается при успешном добавлении
- Закрывается вручную кнопкой ✕

### Edge cases

| Сценарий | Обработка |
|----------|-----------|
| Две ошибки подряд | Вторая заменяет первую |
| Успех после ошибки | Ошибка исчезает |
| Сеть упала | Fallback: «Failed to add tag» |

---

## 9f. Schema fix — enriched_data в schema.sql

> **TZ:** TZ_SCHEMA_ENRICHED_DATA_FIX  
> **Дата:** 2026-06-10  
> **Коммит:** `5a1366a`  
> **Файлы:** `src/models/schema.sql`, `src/index.ts`

### Проблема: рассинхронизация schema.sql и runtime

`enriched_data` добавлялось только через рантайм-миграцию (`index.ts:2953`), но **отсутствовало в `schema.sql`**. При редеплое Render:

1. `schema.sql` создавал `user_defined_tags` **без** `enriched_data`
2. `index.ts` делал `ALTER TABLE ADD COLUMN IF NOT EXISTS` — колонка создавалась **пустой**
3. `tag_name`, `tag_type` оставались на месте
4. `ticker`, `description`, `synonyms`, `key_products` — **пропадали** (хранились в пустом JSONB)

То же самое с `news_tag_links` — таблица создавалась через миграцию в `index.ts:1602`, но не в `schema.sql`.

### Решение

**`schema.sql` — primary source of truth:**

```sql
CREATE TABLE IF NOT EXISTS user_defined_tags (
  tag_id        VARCHAR(50) PRIMARY KEY,
  tag_name      VARCHAR(100) NOT NULL,
  tag_type      VARCHAR(20) DEFAULT 'company',
  keywords      TEXT[] DEFAULT '{}',
  enriched_data JSONB,        -- ← добавлено
  created_by    UUID REFERENCES users(id),
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Fallback для существующих БД
ALTER TABLE user_defined_tags
  ADD COLUMN IF NOT EXISTS enriched_data JSONB;

-- news_tag_links теперь тоже здесь
CREATE TABLE IF NOT EXISTS news_tag_links (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  news_id       UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  tag_id        VARCHAR(50) NOT NULL,
  impact_score  INTEGER,
  impact_reasoning TEXT,
  link_source   VARCHAR(20) NOT NULL DEFAULT 'keyword',
  link_version  INTEGER DEFAULT 1,
  linked_at     TIMESTAMP DEFAULT NOW(),
  UNIQUE(news_id, tag_id, link_source)
);
```

**`index.ts` — дублирование убрано:**
- Удалён `CREATE TABLE news_tag_links` + индексы из `/migrate-v3-enrichment`
- Оставлен `ALTER TABLE news ADD COLUMN IF NOT EXISTS enrichment_version` (это другая миграция)

### Правило

| Источник | Назначение |
|----------|-----------|
| `schema.sql` | Структура таблиц и колонок — **единая правда** |
| `index.ts` | Только runtime-логика; миграции — для обратной совместимости (не для новых таблиц) |

### Уже потерянные данные

**Не восстановить.** Этот фикс предотвращает потери в будущем. Для восстановления — ручное редактирование тегов в админке.

---

## 9g. NewsFeed — фильтр по тегу

> **TZ:** TZ_FEED_FILTER_FIX  
> **Дата:** 2026-06-10  
> **Коммит:** `e81875d`  
> **Файл:** `frontend/src/pages/NewsFeed.tsx`

### Проблема: фильтр на фронте сравнивал разные поля

```typescript
// NewsFeed.tsx (до фикса)
const matchTag = !activeTag || a.tag === activeTag
// activeTag = "Сбербанк"  (tag_name — имя)
// a.tag     = "sberbank"  (matched_tags[0] — ID)
// "sberbank" === "Сбербанк" → false → пустой результат
```

При клике на тег в Home → `/feed?tag=Сбербанк` → лента была пустой.

### Решение: backend-фильтр по tag_id

| Режим | Endpoint |
|-------|----------|
| Все новости | `GET /news?all=true` |
| По тегу | `GET /api/news/tags/{tagId}` (backend фильтр по `matched_tags`) |

**NewsFeed.tsx (после фикса):**

```typescript
// Разделение: tag_id для API, tag_name для UI
const [activeTagId, setActiveTagId] = useState<string | null>(null)
const [activeTagName, setActiveTagName] = useState<string | null>(urlTag)

const loadArticles = (tagId: string | null) => {
  const endpoint = tagId
    ? `/news/tags/${encodeURIComponent(tagId)}`   // ← backend фильтр
    : '/news?all=true'                            // ← все
  api.get(endpoint).then(data => setArticles(data.articles || []))
}
```

**Клик на тег:**
```typescript
onClick={() => {
  setActiveTagId(tag.id)          // sberbank — для API
  setActiveTagName(tag.tag_name)   // Сбербанк — для UI
  loadArticles(tag.id)
}}
```

### Поведение

| Действие | Результат |
|----------|-----------|
| Клик «Все» | `loadArticles(null)` → все новости |
| Клик «Сбербанк» | `loadArticles('sberbank')` → новости по тегу |
| `?tag=Сбербанк` в URL | Маппинг tag_name → tag_id → корректный фильтр |

### Баг: portfolio.id вместо tag_id

**Дата:** 2026-06-10  
**Коммит:** `8544e6b`

**Проблема:** GET `/user/tags` возвращает:
```json
{
  "id": "c0a97f7b-...",        // ← UUID portfolios (было использовано)
  "tag_id": "spacex",           // ← строковый ID тега (нужно)
  "tag_name": "SpaceX"
}
```

Код использовал `tag.id` (UUID) вместо `tag.tag_id` (`spacex`):
```typescript
// БЫЛО — UUID → backend не находит в matched_tags
loadArticles(tag.id)  // → /news/tags/c0a97f7b-... → 0 articles

// СТАЛО — строковый tag_id
loadArticles(tag.tag_id)  // → /news/tags/spacex → N articles
```

**Почему:** `matched_tags` в БД хранит строковые `tag_id` (`spacex`), не UUID портфеля.

**Фикс:** везде `tag.id` → `tag.tag_id`:
- `loadArticles(tag.tag_id)`
- `activeTagId = tag.tag_id`
- `tagsMap` ключ = `tag.tag_id`
- `key={tag.tag_id}`

---

## 9h. Дублирующий GET endpoint — данные не подтягивались

> **TZ:** TZ_TAG_DATA_LOADING_FIX  
> **Дата:** 2026-06-10  
> **Коммит:** `224e0f0`  
> **Файл:** `backend/src/index.ts`

### Проблема: два GET /admin/tags/:tagId endpoint'а

В файле `index.ts` оказалось **два endpoint'а** на один route:

| Строка | Route | Что возвращал |
|--------|-------|---------------|
| ~189 | `/debug-tag/:tagId` | Плоский объект с `enriched_data: {exchange}` |
| **1043** | **`/admin/tags/:tagId`** | **`{ tag: {...} }` без `exchange/trend/sector`** |

Frontend вызывал `/admin/tags/:tagId` (строка 1043) — 12 полей, без новых.

### Почему "иногда показывало, иногда нет"

| Действие | Что происходило | Результат |
|----------|----------------|-----------|
| Save | PUT пишет в `enriched_data` JSONB | 200 OK ✅ |
| После Save | PUT response возвращает `tag.exchange` | Показывает значение ✅ |
| Refresh | GET `/admin/tags/:tagId` → не извлекал exchange из JSONB | "Not set" ❌ |

### Фикс

Добавлено извлечение `exchange`, `trend`, `sector` из `ed` в основной GET endpoint (строка 1043) + включено в response.

**Response keys:** 12 → **16 полей** (`+ exchange`, `+ trend`, `+ sector`, `+ description_ru`)

---

## 9i. Tag Detail Modal — фиксы редактирования тега

> **TZ:** TZ_TAG_EDIT_v3 + TZ_TAG_FIELD_NAME_FIX  
> **Дата:** 2026-06-10  
> **Коммиты:** `5f01c3c` (backend), `95badc0`, `083d138` (frontend)

### Цепочка багов

Три взаимосвязанные проблемы при редактировании тега в админке:

| # | Баг | Проявление |
|---|-----|-----------|
| 1 | **JSONB string parsing** | `pg` driver возвращает `enriched_data` как строку, не объект. `ed.exchange` → `undefined` → "Not set" |
| 2 | **PUT response затирает поля** | PUT отвечает `{ ticker: "SBER", trend: null }` — `trend: null` перезаписывает предыдущее значение |
| 3 | **Frontend selective merge пропускает пустые** | Очистка поля → backend не включает в response → frontend не обновляет → старое значение торчит |

### Баг 1: JSONB string parsing

**PostgreSQL `pg` driver** для JSONB возвращает **строку** вместо объекта:

```typescript
// enriched_data = '{"ticker": "SBER"}' (string!)
const ed = tag.enriched_data || {};  // ed = "{\"ticker..." — строка
ed.ticker  // undefined ❌
```

**Фикс GET + PUT:** defensive JSON parse:
```typescript
let enrichedData = tag.enriched_data;
if (typeof enrichedData === 'string') {
  try { enrichedData = JSON.parse(enrichedData); } catch { enrichedData = {}; }
}
if (!enrichedData || typeof enrichedData !== 'object') enrichedData = {};
const ed = enrichedData;
```

### Баг 2: PUT response затирает неизменённые поля

**Было:** PUT возвращал ВСЕ поля с `|| null`:
```typescript
res.json({
  tag: {
    ticker: ed.ticker || null,      // ← null если пусто
    trend: ed.trend || null,        // ← ЗАТИРАЕТ предыдущее!
    sector: ed.sector || null,      // ← ЗАТИРАЕТ предыдущее!
  }
})
```

Frontend: `setData({ ...prev.tag, ...res.tag })` — `res.tag.trend = null` стирало данные.

**Стало:** selective response — только поля что реально есть в `enriched_data`:
```typescript
if (ed.ticker) tagResponse.ticker = ed.ticker;
if (ed.trend) tagResponse.trend = ed.trend;
// null не возвращается → frontend не перезаписывает
```

### Баг 3: Очистка поля — не показывает "Not set"

**Сценарий:**
1. Ticker = "SBER" → Save → ✅ "SBER"
2. Редактировать → стереть → Save → ❌ всё ещё "SBER"

**Причина:** selective merge пропускал `undefined`:
```typescript
if (value !== undefined && value !== null) {
  tagUpdates[field] = value
}
// value = undefined (пустая строка = falsy) → не попадает в merge
```

**Фикс:** явный `null` при очистке:
```typescript
if (value !== undefined && value !== null) {
  tagUpdates[field] = value
} else {
  tagUpdates[field] = null  // ← UI видит null → рисует "Not set"
}
```

### Архитектура после фиксов

```
Админка → Edit "SBER" → Save
  Frontend: handleSave() → FIELD_MAP[description] = "description_ru"
    → PUT /admin/tags/sber { ticker: "SBER" }
  Backend: validate → SQL UPDATE enriched_data JSONB merge
    → PUT response: { tag: { ticker: "SBER" } } (только ticker!)
  Frontend: selective merge — tagUpdates = { ticker: "SBER" }
    → setData({ ...prev.tag, ...tagUpdates })
    → Остальные поля не тронуты ✅

Админка → Очистить Ticker → Save
  Frontend: PUT { ticker: "" }
  Backend: "" записывается в JSONB (falsy, не попадает в response)
    → PUT response: { tag: {} } (ticker нет)
  Frontend: selective merge — updated_fields содержит "ticker"
    → value = undefined → else ветка: tagUpdates.ticker = null
    → UI: null → "Not set" ✅
```

### Поля exchange, trend, sector

> TZ: TZ_TAG_ENRICHED_FIELDS_v4 (коммиты `5700602`, `45442c4`)

Добавлены 3 поля в `enriched_data` JSONB:

| Поле | Назначение | Валидация |
|------|-----------|-----------|
| `exchange` | Биржа | `MOEX`, `NASDAQ`, `LSE` — `[A-Z][A-Za-z\.\-]*` |
| `trend` | Тренд | `AI`, `Green Energy`, `EV` — произвольная строка |
| `sector` | Сектор | `Technology`, `Finance`, `Energy` — произвольная строка |

- Все `optional: true` — можно оставить пустым
- Участвуют в `tags/search` (ILIKE)
- Отображаются в TagEnrichment цветными плашками
- Редактируются в админке inline

### API Endpoints

| Endpoint | Что делает | Защита |
|----------|-----------|--------|
| `GET /admin/tags/:tagId` | Детали тега | `requireAdmin` |
| `PUT /admin/tags/:tagId` | Редактирование | `TAG_UPDATE_RULES` валидация + `jsonbFields` whitelist |
| `DELETE /admin/tags/:tagId` | Cascade удаление | Транзакция PostgreSQL |

### Критерии проверки

- [ ] Edit Ticker → "SBER" → Save → "SBER" видно
- [ ] Edit Trend → "bullish" → Save → Ticker = "SBER", Trend = "bullish" (оба на месте)
- [ ] Close → Reopen → все значения сохранены
- [ ] Очистить Ticker → Save → "Not set"
- [ ] Переоткрыть → "Not set" ✅

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

### News Detail Modal

Модальное окно при клике на карточку новости. Заменяет `window.open(url)`.

**Endpoint'ы:**
```
GET /api/news/:id              — детали статьи (title, summary, sentiment, tag_impact...)
GET /api/news/:id/tag-enrichments  — enriched_data для всех тегов статьи
```

> ⚠️ **Порядок маршрутов критичен**: `/:id/tag-enrichments` ДОЛЖЕН идти ДО `/:id`
> в Express router. Иначе `/news/123/tag-enrichments` попадает в `/:id` как
> `id = "123/tag-enrichments"` → UUID валидация падает → 400.

**UI блоки (NewsDetailModal.tsx):**

| Блок | Данные |
|------|--------|
| **Header** | Micro/Macro бейдж, Political Shield, Copy link, Telegram share, Close |
| **Sentiment Gauge** | SVG полукруглая дуга `-10..+10`, анимация стрелки |
| **Title + RU/EN toggle** | `title_ru` / `title_original` с переключателем |
| **Summary** | `summary_ru` |
| **Reasoning Card** | `sentiment_reasoning` → 3 параграфа (Что/Почему/Каскад) |
| **Keyword Tags (Layer 1)** | `matched_tags[]` — серые пилюли с `Key` иконкой |
| **LLM Tags (Layer 2)** | `tag_impact[]` — цветные пилюли (`score` + hover tooltip) |
| **Tag Enrichments** | `GET /news/:id/tag-enrichments` — карточки тегов из БД |
| **Source Chain** | `all_sources.join(' → ')` если `source_count > 1` |
| **Original Link** | Кнопка "Открыть оригинал" → `article.url` |

**Tag Enrichment Card (на тег):**

| Поле | Источник | Стиль |
|------|----------|-------|
| Название тега | `tag_name` | Белый заголовок |
| Тикер | `ticker` | Зелёный `$TICK` бейдж |
| Сайт | `website` | Синяя ссылка |
| Описание | `description_ru` | Серый текст |
| Связанные компании | `related_entities[]` | Синие пилюли |
| Продукты | `key_products[]` | Серые пилюли |
| Синонимы EN/RU | `synonyms_en/ru[]` | Фиолетовые мини-бейджи |

**Keyboard:** ESC = закрыть, стрелки = навигация (future).  
**Animation:** Framer Motion (scale + fade, 0.25s).  
**Scroll lock:** `document.body.style.overflow = 'hidden'`.

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

### Tag Search Endpoints

```
GET /api/tags/search?q={query}
|---> Поиск тегов по enriched-полям (substring, ILIKE)
|---> q: 3-50 символов
|---> Ищет по: tag_name, ticker, keywords[], synonyms_en/ru[], key_products[], related_entities[]
|---> LIMIT 10
|---> Ответ: { tags: [{tag_id, tag_name, tag_type, ticker}], total: N }

GET /api/news/:id/tag-enrichments
|---> enriched_data для всех тегов новости (matched_tags + tag_impact)
|---> ⚠️ Порядок: ДОЛЖЕН идти ДО /:id в Express router
|---> Ответ: { tags: [{tag_id, tag_name, ticker, website, description_ru, key_products, synonyms_en, synonyms_ru, related_entities}] }
```

**Маршрутизация Express (критично):**
```typescript
// ПРАВИЛЬНО:
router.get('/:id/tag-enrichments', handler)  // ← СНАЧАЛА
router.get('/:id', handler)                   // ← ПОТОМ

// НЕПРАВИЛЬНО:
router.get('/:id', handler)                   // ← ловит "123/tag-enrichments"
router.get('/:id/tag-enrichments', handler)   // ← никогда не сработает
```

### Auth Endpoints

```
POST /api/auth/register
|---> Регистрация нового пользователя
|---> Body: { username, email, password }
|--→ Ответ: { token, user: { id, username, email, is_admin } }

POST /api/auth/login
|---> Вход по email + password
|---> Body: { email, password }
|--→ Ответ: { token, user: { id, username, email, is_admin } }
```

**Case-insensitive email (фикс 90b67f4):**

| Было | Стало |
|------|-------|
| `WHERE email = $1` | `WHERE LOWER(email) = LOWER($1)` |

```sql
-- Регистрация: проверка дубликата (case-insensitive)
SELECT id FROM users WHERE LOWER(email) = LOWER($1)

-- Логин: поиск пользователя (case-insensitive)
SELECT ... FROM users WHERE LOWER(email) = LOWER($1)
```

**Баг (2026-06-09):** PostgreSQL `=` для VARCHAR case-sensitive.
- Регистрация `Vladfa@ya.ru` → логин `vladfa@ya.ru` → "Invalid credentials"
- Можно создать два аккаунта: `vladfa@ya.ru` + `Vladfa@ya.ru`

**Фикс:** оба SQL-запроса используют `LOWER()` — регистр неважен.

---

## 10a. Daily Summary — AI-саммари для пользователя

### Назначение
Персональный AI-дайджест для авторизованного пользователя. Анализирует новости за последние 12 часов, совпадающие с тегами пользователя, и генерирует краткое текстовое саммари от лица инвестиционного аналитика.

**Только для авторизованных пользователей.** Блок отображается на главной странице над каруселями.

### Архитектура

```
┌─────────────────────┐
│   DailySummary.tsx  │  ← Frontend, главная страница
│   (src/components)  │
└────────┬────────────┘
         │ GET /api/user/summary?hours=12
         ▼
┌─────────────────────┐
│   user.ts:710       │  ← Backend route
│   /api/user/summary │
└────────┬────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐ ┌──────────┐
│ Cache │ │  LLM     │  ← Kimi API (если cache miss)
│(5 min)│ │  (30s)   │
└───────┘ └──────────┘
```

### API

```
GET /api/user/summary
Headers: Authorization: Bearer <JWT>
Query: ?hours=12 (default) | ?refresh=1 (skip cache)

Response:
{
  "summary": "За последние 12 часов в фокусе...",
  "cached": false,
  "generated_at": "2026-05-31T08:00:00.000Z",
  "articles_count": 14
}
```

### Flow

```
1. Frontend: DailySummary.tsx монтируется
   → вызывает GET /api/user/summary

2. Backend: проверяет кэш (in-memory Map, TTL 5 минут)
   ├── Cache HIT → возвращает cached ответ
   └── Cache MISS → продолжаем

3. Backend: получает теги пользователя из portfolios
   SELECT tag_id, tag_name FROM portfolios WHERE user_id = $1

4. Backend: ищет новости за 12 часов по тегам пользователя
   SELECT title_ru, summary_ru, matched_tags, sentiment
   FROM news
   WHERE published_at > NOW() - INTERVAL '12 hours'
     AND matched_tags && $userTags
   ORDER BY published_at DESC
   LIMIT 30

5. Backend: формирует prompt для LLM
   Активы клиента: Apple, Nvidia, Tesla...
   Новости:
   1. 🟢 Apple отчиталась о рекордной выручке
      Теги: apple, tech
   2. 🔴 Нефть упала на фоне слабых данных Китая
      Теги: oil
   ...

6. Backend: отправляет в Kimi API
   model: moonshot-v1-32k
   temperature: 0.3
   max_tokens: 500
   timeout: 30 сек

7. Backend: парсит ответ, сохраняет в кэш

8. Frontend: отображает summary + articles_count
```

### LLM Prompt

```typescript
function buildSummaryPrompt(tagNames: string[], articles: Article[]): string {
  return `Ты — инвестиционный аналитик PULSE. Подготовь краткое саммари 
для клиента о событиях, затрагивающих его активы.

Активы клиента: ${tagNames.join(', ')}

Новости за последние 12 часов:
${articles.map((a, i) => {
  const emoji = a.sentiment === 'positive' ? '🟢' 
    : a.sentiment === 'negative' ? '🔴' : '⚪';
  return `${i+1}. ${emoji} ${a.title}\n   ${a.summary.slice(0,200)}\n   Теги: ${a.tags?.join(', ') || ''}`;
}).join('\n\n')}

Требования к саммари:
1. Напиши на русском языке
2. Общий объем — 80-150 слов (3-5 коротких абзацев)
3. Стиль: уверенный аналитический, без воды, конкретные выводы
4. Укажи ключевые события и их влияние на активы клиента
5. Если новостей нет — "За последние 12 часов значимых событий не зафиксировано."
6. Не используй markdown-заголовки, списки, эмодзи — только плавный текст
7. Начинай с фразы типа "За последние 12 часов..." или "В фокусе..."

Саммари:`;
}
```

### Что НЕ используется (даже если есть в БД)

| Поле | Почему не используется |
|------|------------------------|
| `sentiment_score` (-10..+10) | Саммари — текстовый, не нужен числовой score |
| `is_political` | Нет фильтрации политики в саммари |
| `tag_impact.reasoning` | Не показываем почему тег повлиял — только сводку |
| `sentiment_reasoning` | LLM генерирует своё reasoning в контексте всех новостей |

### Кэширование

```typescript
const SUMMARY_CACHE_TTL = 5 * 60 * 1000; // 5 минут
const summaryCache = new Map<string, { text: string; time: number; generatedAt: string }>();
```

Кэш in-memory (не в Redis/DB) — допустимо, т.к. саммари персональный и часто обновляется.

### Отличие от Telegram Digest

| Аспект | Daily Summary (Web) | Telegram Digest |
|--------|---------------------|-----------------|
| **Канал** | Frontend (DailySummary.tsx) | Telegram Bot |
| **Endpoint** | `GET /api/user/summary` | `POST /webhook/telegram` |
| **Формат** | Текст на странице | Сообщение в TG |
| **Период** | 12 часов (фиксировано) | 3/6/12/24 часа (настраивается) |
| **Кэш** | 5 минут | Нет |
| **Автоматика** | Только по запросу (refresh) | Cron по расписанию |
| **Пользователь** | Только авторизованный | Подключённый TG |

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

### Verified Results (v9.5)

| Этап | Результат | Дата |
|------|-----------|------|
| **Finnhub first run** | 39 fetched → **39 saved, 0 errors** | 2026-06-12 |
| **News Processor tagging** | 39 Finnhub → matched_tags заполнены (4 nvda + другие) | 2026-06-12 |
| **RSS (TG Parser)** | Статьи получают теги через News Processor v3 | 2026-06-12 |
| **End-to-end** | NSM fetch → save → News Processor → теги → frontend ✅ | 2026-06-12 |

### Manual Triggers

```bash
# RSS сбор
POST /trigger/rss
POST /