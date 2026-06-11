# TZ: News Processor — Единое окно обработки (Layer 1 + Layer 2)

> **Статус:** TZ — Draft  
> **Приоритет:** P1 (зависит от перевода API)  
> **Создан:** 2026-06-11  
> **Связь:** TZ_FINNHUB_ADAPTER, TZ_NEWS_SOURCE_MANAGER  

---

## 1. Проблема

### Сейчас (единый pipeline в cron.ts)

```
processArticles()
├── 1. fetchAllRSS()           ← fetch
├── 2. translateBatch()        ← translate (EN→RU)
├── 3. smartMatchTags()        ← tag matching
├── 4. analyzeUnifiedBatch()   ← sentiment (Layer 1)
│   └── tag_impact + is_political (Layer 2)
├── 5. INSERT/UPDATE news      ← save
└── Всё в одной функции (500 строк)
```

**Проблемы:**
- Finnhub новости НЕ обрабатываются Layer 1+2 (translate, sentiment, tag_impact)
- Новый источник = нужно копировать translate + sentiment логику
- RSS cron = монолит. Меняешь translate — рискуешь сломать sentiment
- processArticlesLocked() = 500 строк, невозможно тестировать отдельно

### Должно быть (разделение Fetch / Process)

```
Fetch Cron (NSM)                    Process Cron (News Processor)
├── RSS: fetchAllRSS() → INSERT     SELECT * FROM news WHERE title_ru IS NULL
├── Finnhub: fetch() → INSERT       ├── translateBatch()
├── CryptoCompare: fetch() → INSERT ├── smartMatchTags()
└── (любой новый) → INSERT          ├── analyzeUnifiedBatch()
                                     │   ├── sentiment
                                     │   ├── tag_impact
                                     │   └── is_political
                                     └── UPDATE news
```

---

## 2. Архитектура

### 2.1 Принцип разделения

| Layer | Ответственность | Знает об источниках? |
|-------|----------------|---------------------|
| **Layer 0 — Fetch** | Получить сырые данные, INSERT в БД | Да — каждый adapter свой |
| **Layer 1 — Translate** | EN→RU перевод title/summary | Нет — работает со всеми |
| **Layer 2 — Sentiment** | Анализ тональности + tag_impact | Нет — работает со всеми |
| **Storage** | PostgreSQL — единое хранилище | — |

### 2.2 Признак "сырой" статьи

Статья считается **сырой** (требует обработки), если:

```sql
SELECT * FROM news
WHERE title_ru IS NULL           -- не переведена
   OR sentiment IS NULL          -- не проанализирована тональность
   OR sentiment_source IS NULL   -- не определен источник sentiment
ORDER BY published_at DESC
LIMIT 50
```

### 2.3 Признак "готовой" статьи

```sql
SELECT * FROM news
WHERE title_ru IS NOT NULL
  AND sentiment IS NOT NULL
  AND sentiment_source IS NOT NULL
```

---

## 3. Что меняется

### 3.1 Файлы: ДО → ПОСЛЕ

| # | Файл | ДО | ПОСЛЕ | Статус |
|---|------|-----|--------|--------|
| 1 | `cron.ts` | `processArticles()` = fetch → translate → sentiment → INSERT | `processArticles()` = fetch → INSERT (сырое). Убрать translate + sentiment | **Меняем** |
| 2 | `newsProcessor.ts` | Нет | Новый файл: SELECT → translate → sentiment → UPDATE | **Создаем** |
| 3 | `finnhubAdapter.ts` | `saveArticles()` = INSERT (title_ru = title_original) | Не меняем — title_ru=null (сырое) | **Уже ок** |
| 4 | `index.ts` | Один cron: `/trigger-rss` | Два cron: `/trigger-rss` (fetch) + `/trigger/process` (process) | **Меняем** |
| 5 | `schema.sql` | — | Добавить `CREATE INDEX` для process query | **Добавляем** |

### 3.2 Что НЕ трогаем

| Компонент | Почему не трогаем |
|-----------|-------------------|
| `rssFetcher.ts` | Только парсит XML. Возвращает сырые данные. Не знает о translate/sentiment |
| `newsSourceManager.ts` | Он только оркестрирует fetch. Process — отдельный слой |
| `translate.ts` | Библиотека, не меняется. Вызывается из нового newsProcessor.ts |
| `smartMatch.ts` | Библиотека, не меняется. Вызывается из нового newsProcessor.ts |
| `analyzeSentiment.ts` | Библиотека, не меняется. Вызывается из нового newsProcessor.ts |

---

## 4. SQL

### 4.1 Индекс для News Processor query

```sql
-- Для быстрого поиска "сырых" статей
CREATE INDEX IF NOT EXISTS idx_news_needs_processing 
ON news (published_at DESC) 
WHERE title_ru IS NULL OR sentiment IS NULL OR sentiment_source IS NULL;
```

### 4.2 SELECT для News Processor

```sql
-- Выбрать 50 сырых статей (из любого источника)
SELECT 
  id, title_original, summary_original, lang_original,
  source, source_id, content_hash, matched_tags
FROM news
WHERE title_ru IS NULL
   OR sentiment IS NULL
   OR sentiment_source IS NULL
ORDER BY published_at DESC
LIMIT 50
FOR UPDATE SKIP LOCKED;  -- не блокировать, пропустить если кто-то обрабатывает
```

### 4.3 UPDATE после обработки

```sql
-- Обновить одну статью
UPDATE news
SET title_ru = $1,
    summary_ru = $2,
    sentiment = $3,
    sentiment_score = $4,
    sentiment_reasoning = $5,
    sentiment_source = $6,
    is_political = $7,
    article_type = $8,
    matched_tags = $9,
    tag_impact = $10,
    llm_error = $11,
    llm_attempts = $12
WHERE id = $13
```

---

## 5. Новый файл: services/newsProcessor.ts

### 5.1 Структура

```typescript
/**
 * News Processor — единое окно обработки (Layer 1 + Layer 2)
 * 
 * Отвечает за:
 * - Перевод EN → RU (translateBatch)
 * - Sentiment analysis (analyzeUnifiedBatch)
 * - Tag matching (smartMatchTags)
 * - Tag impact + is_political
 * 
 * НЕ отвечает за:
 * - Fetch (это NewsSourceManager)
 * - INSERT новостей (это adapters)
 * 
 * Работает ТОЛЬКО с UPDATE — берет "сырые" статьи из БД,
 * обрабатывает, записывает результат обратно.
 */

import { query } from '../config/db';
import { translateBatch } from './translate';
import { smartMatchTags } from './smartMatch';
import { analyzeUnifiedBatch, UnifiedResult } from './analyzeSentiment';

interface RawArticle {
  id: string;
  title_original: string;
  summary_original: string;
  lang_original: string;
  source: string;
  source_id: string;
  content_hash: string;
  matched_tags: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN: processRawArticles()
// ═══════════════════════════════════════════════════════════════════════════
export async function processRawArticles(): Promise<void> {
  const BATCH_SIZE = 50;
  
  // 1. Выбрать сырые статьи
  const rawArticles = await selectRawArticles(BATCH_SIZE);
  if (rawArticles.length === 0) {
    console.log('[NewsProcessor] No raw articles to process');
    return;
  }
  
  console.log(`[NewsProcessor] Processing ${rawArticles.length} raw articles`);
  
  // 2. Translate EN → RU (Layer 1)
  await translateArticles(rawArticles);
  
  // 3. Tag matching (identify which tags apply)
  const matchedTagsList = await matchTags(rawArticles);
  
  // 4. Sentiment analysis (Layer 2)
  const sentimentResults = await analyzeSentiment(rawArticles, matchedTagsList);
  
  // 5. UPDATE в БД
  await saveProcessedArticles(rawArticles, matchedTagsList, sentimentResults);
  
  console.log(`[NewsProcessor] Done: ${rawArticles.length} articles processed`);
}
```

### 5.2 SELECT сырых статей

```typescript
async function selectRawArticles(limit: number): Promise<RawArticle[]> {
  const result = await query(`
    SELECT 
      id, title_original, summary_original, lang_original,
      source, source_id, content_hash, matched_tags
    FROM news
    WHERE title_ru IS NULL
       OR sentiment IS NULL
       OR sentiment_source IS NULL
    ORDER BY published_at DESC
    LIMIT $1
    FOR UPDATE SKIP LOCKED
  `, [limit]);
  
  return result.rows.map(row => ({
    id: row.id,
    title_original: row.title_original,
    summary_original: row.summary_original,
    lang_original: row.lang_original,
    source: row.source,
    source_id: row.source_id,
    content_hash: row.content_hash,
    matched_tags: parsePgArray(row.matched_tags),  // text[] → string[]
  }));
}
```

### 5.3 Translate

```typescript
async function translateArticles(articles: RawArticle[]): Promise<void> {
  const toTranslate = articles.filter(a => a.lang_original === 'en');
  if (toTranslate.length === 0) return;
  
  try {
    const titles = toTranslate.map(a => a.title_original);
    const summaries = toTranslate.map(a => a.summary_original);
    
    const translatedTitles = await translateBatch(titles);
    const translatedSummaries = await translateBatch(summaries);
    
    for (let i = 0; i < toTranslate.length; i++) {
      (toTranslate[i] as any).title_ru = translatedTitles[i] || toTranslate[i].title_original;
      (toTranslate[i] as any).summary_ru = translatedSummaries[i] || toTranslate[i].summary_original;
    }
  } catch (err: any) {
    console.error('[NewsProcessor] Translate error:', err.message);
    // Fallback: оставить title_ru = null (будет обработано при UPDATE)
  }
}
```

### 5.4 Tag Matching

```typescript
async function matchTags(articles: RawArticle[]): Promise<string[][]> {
  const results: string[][] = [];
  
  for (const article of articles) {
    const title_ru = (article as any).title_ru || article.title_original;
    const summary_ru = (article as any).summary_ru || article.summary_original;
    
    const tags = await smartMatchTags(title_ru, summary_ru);
    
    // Merge с существующими matched_tags (от Finnhub)
    const existingTags = article.matched_tags || [];
    const merged = [...new Set([...existingTags, ...tags])];
    
    results.push(merged);
  }
  
  return results;
}
```

### 5.5 Sentiment Analysis

```typescript
async function analyzeSentiment(
  articles: RawArticle[], 
  matchedTagsList: string[][]
): Promise<UnifiedResult[]> {
  
  // Оптимизация: исключить дубликаты с reasoning
  // (копируем логику из cron.ts строки 239-274)
  
  const llmAvailable = !!process.env.KIMI_API_KEY;
  if (!llmAvailable) {
    // Fallback: keyword-based
    return articles.map((_, i) => ({
      sentiment: 'neutral' as const,
      score: 0,
      reasoning: '',
      is_political: false,
      article_type: 'micro' as const,
      tag_impacts: matchedTagsList[i].map(t => ({ tag: t, score: 0, reasoning: '' })),
    }));
  }
  
  // Batch LLM анализ (копируем из cron.ts строка 285-348)
  const BATCH_SIZE = 5;
  const results: UnifiedResult[] = [];
  
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const chunk = articles.slice(i, i + BATCH_SIZE);
    const chunkTags = matchedTagsList.slice(i, i + BATCH_SIZE);
    
    try {
      const batchResults = await analyzeUnifiedBatch(
        chunk.map((a, j) => ({
          title: (a as any).title_ru || a.title_original,
          summary: (a as any).summary_ru || a.summary_original,
          tags: chunkTags[j],
        }))
      );
      
      for (let j = 0; j < batchResults.length; j++) {
        results[i + j] = batchResults[j];
      }
    } catch (err: any) {
      console.error(`[NewsProcessor] Batch failed:`, err.message);
      // Fallback for chunk
      for (let j = 0; j < chunk.length; j++) {
        results[i + j] = {
          sentiment: 'neutral' as const, score: 0, reasoning: '',
          is_political: false, article_type: 'micro' as const,
          tag_impacts: chunkTags[j].map(t => ({ tag: t, score: 0, reasoning: '' })),
        };
      }
    }
  }
  
  return results;
}
```

### 5.6 UPDATE в БД

```typescript
async function saveProcessedArticles(
  articles: RawArticle[],
  matchedTagsList: string[][],
  sentimentResults: UnifiedResult[]
): Promise<void> {
  
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const tags = matchedTagsList[i];
    const s = sentimentResults[i];
    
    try {
      await query(`
        UPDATE news
        SET title_ru = $1,
            summary_ru = $2,
            sentiment = $3,
            sentiment_score = $4,
            sentiment_reasoning = $5,
            sentiment_source = $6,
            is_political = $7,
            article_type = $8,
            matched_tags = $9,
            tag_impact = $10,
            llm_error = $11,
            llm_attempts = $12
        WHERE id = $13
      `, [
        (a as any).title_ru || a.title_original,
        (a as any).summary_ru || a.summary_original,
        s.sentiment,
        s.score,
        s.reasoning || null,
        (s as any)._llmErrorType || 'llm',
        s.is_political,
        s.article_type || 'micro',
        tags,
        JSON.stringify(s.tag_impacts || []),
        (s as any)._llmErrorMsg || null,
        (s as any)._llmErrorType ? 1 : null,
        a.id,
      ]);
    } catch (err: any) {
      console.error(`[NewsProcessor] UPDATE failed for ${a.id}:`, err.message);
    }
  }
}
```

---

## 6. Что меняется в cron.ts

### 6.1 processArticlesLocked() — УБРАТЬ

Из `processArticlesLocked()` удалить:

| Что удалить | Строки | Куда переезжает |
|-------------|--------|-----------------|
| `translateBatch()` | 194-214 | `newsProcessor.ts: translateArticles()` |
| `smartMatchTags()` | 221-230 | `newsProcessor.ts: matchTags()` |
| `analyzeUnifiedBatch()` | 232-359 | `newsProcessor.ts: analyzeSentiment()` |
| `sentiment/llm/tagged merge` | 362-389 | `newsProcessor.ts: saveProcessedArticles()` |

Оставить ТОЛЬКО:

```typescript
// cron.ts::processArticlesLocked() — ТОЛЬКО fetch + INSERT
async function processArticlesLocked() {
  // ... logging, cleanup ...
  
  // 1. Fetch RSS (enabled sources)
  const articles = await fetchAllRSS(enabledSources);
  
  // 2. INSERT as RAW (title_ru = NULL, sentiment = NULL)
  for (const a of articles) {
    await query(`
      INSERT INTO news (title_original, title_ru, summary_ru, ...)
      VALUES ($1, NULL, NULL, ...)  -- ← NULL = сырые, News Processor обработает
      ON CONFLICT (content_hash) DO NOTHING
    `);
  }
  
  // 3. НЕ запускаем translate/sentiment здесь
  //    News Processor сделает это отдельно
}
```

---

## 7. Новые endpoints

### 7.1 Trigger для News Processor

```typescript
// index.ts
app.get('/trigger/process', async (req, res) => {
  const secret = req.headers['x-trigger-secret'] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  import('./services/newsProcessor').then(({ processRawArticles }) => {
    processRawArticles().catch(e => console.error('[Process] error:', e.message));
  });
  
  res.json({ started: true });
});
```

### 7.2 Cron schedule

```typescript
// Каждые 10 минут — process raw articles
setInterval(() => {
  import('./services/newsProcessor').then(({ processRawArticles }) => {
    processRawArticles().catch(console.error);
  });
}, 10 * 60 * 1000);  // 10 min
```

---

## 8. Flow: новый источник (CryptoCompare)

### Шаг 1: Написать adapter (только fetch + INSERT)

```typescript
// services/cryptocompareAdapter.ts
export async function fetchCryptoCompareNews(config: any): Promise<void> {
  const data = await fetch(`${config.url}/data/v2/news/?lang=EN`).then(r => r.json());
  
  for (const item of data.Data) {
    // INSERT as RAW (title_ru = NULL, sentiment = NULL)
    await query(`
      INSERT INTO news (title_original, title_ru, summary_ru, sentiment, ...)
      VALUES ($1, NULL, NULL, NULL, ...)  -- ← NULL = News Processor обработает
      ON CONFLICT (content_hash) DO NOTHING
    `, [item.title, item.body, ...]);
  }
}
```

### Шаг 2: Зарегистрировать в news_sources

```sql
INSERT INTO news_sources (name, display_name, type, config, enabled)
VALUES ('cryptocompare', 'CryptoCompare News', 'api_feed', 
        '{"url": "https://min-api.cryptocompare.com"}', true);
```

### Шаг 3: NewsSourceManager вызовет автоматически

```typescript
// newsSourceManager.ts
} else if (source.type === 'api_feed') {
  if (source.name === 'cryptocompare') {
    await fetchCryptoCompareNews(source.config);
  }
}
```

### Шаг 4: News Processor обработает автоматически

```sql
-- News Processor выберет эти статьи как "сырые" и обработает
SELECT * FROM news WHERE title_ru IS NULL  -- ← включает CryptoCompare
```

**Никаких изменений в News Processor для нового источника!**

---

## 9. Тестирование

### 9.1 Тест: Finnhub → Process

```bash
# 1. Fetch Finnhub
$ curl "https://pulse-api-bsov.onrender.com/trigger/nsm?secret=..."
# → [Finnhub] Saved: 27

# 2. Check: статьи сырые
$ psql -c "SELECT COUNT(*) FROM news WHERE title_ru IS NULL AND source_id='finnhub'"
# → 27

# 3. Run News Processor
$ curl "https://pulse-api-bsov.onrender.com/trigger/process?secret=..."
# → [NewsProcessor] Processing 27 articles

# 4. Check: статьи обработаны
$ psql -c "SELECT COUNT(*) FROM news WHERE title_ru IS NOT NULL AND sentiment IS NOT NULL AND source_id='finnhub'"
# → 27
```

### 9.2 Тест: RSS → Process

```bash
# 1. Enable RSS source
# 2. Fetch RSS
$ curl -X POST "https://pulse-api-bsov.onrender.com/trigger-rss" -H "x-trigger-secret: ..."

# 3. Check: статьи сырые
$ psql -c "SELECT COUNT(*) FROM news WHERE title_ru IS NULL AND source_type='rss'"

# 4. Run News Processor
$ curl "https://pulse-api-bsov.onrender.com/trigger/process?secret=..."

# 5. Check: обработаны
```

---

## 10. Миграция (план перехода)

### Фаза 1: Подготовка (без downtime)

1. Создать `newsProcessor.ts`
2. Добавить индекс `idx_news_needs_processing`
3. Добавить endpoint `/trigger/process`
4. Добавить cron interval

### Фаза 2: Переключение RSS

1. В `cron.ts`: убрать translate + sentiment
2. RSS INSERT → `title_ru = NULL` (сырое)
3. Запустить News Processor
4. Проверить: RSS статьи обрабатываются

### Фаза 3: Finnhub

1. В `finnhubAdapter.ts`: `title_ru = NULL` (вместо `title_original`)
2. Запустить News Processor
3. Проверить: Finnhub статьи обрабатываются

### Фаза 4: Очистка

1. Удалить старый translate/sentiment код из `cron.ts`
2. Убедиться что deferred processor больше не нужен

---

## 11. Файлы

| Файл | Действие | Сложность |
|------|----------|-----------|
| `services/newsProcessor.ts` | Создать | Высокая (копия логики из cron.ts) |
| `services/cron.ts` | Убрать translate/sentiment | Средняя |
| `services/finnhubAdapter.ts` | `title_ru = NULL` | Низкая |
| `index.ts` | Добавить `/trigger/process` | Низкая |
| `models/schema.sql` | Добавить индекс | Низкая |

---

## 12. Связанные TZ

| TZ | Статус | Связь |
|-----|--------|-------|
| TZ_FINNHUB_ADAPTER | ✅ Готово | Finnhub fetch → INSERT |
| TZ_NEWS_SOURCE_MANAGER | ✅ Готово | Оркестрирует fetch |
| TZ_NEWS_PROCESSOR | 📝 Этот TZ | Обрабатывает ВСЕ новости |

---

*Document: TZ_NEWS_PROCESSOR.md*  
*Created: 2026-06-11*  
*Author: Pulse Team*
