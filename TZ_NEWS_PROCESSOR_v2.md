# TZ: News Processor — Единое окно обработки (Layer 1 + Layer 2)

> **Статус:** TZ — v2 (обновлено с учетом фикса dc7084b)  
> **Приоритет:** P1 (зависит от перевода API)  
> **Создан:** 2026-06-11  
> **Обновлено:** 2026-06-11  
> **Связь:** TZ_FINNHUB_v2, TZ_NEWS_SOURCE_MANAGER  

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
- ~~Finnhub новости НЕ обрабатываются Layer 1+2~~ ✅ **ИСПРАВЛЕНО** — Finnhub adapter ставит `title_ru=null`, News Processor найдет их
- Новый источник = нужно копировать translate + sentiment логику
- RSS cron = монолит. Меняешь translate — рискуешь сломать sentiment
- processArticlesLocked() = 500 строк, невозможно тестировать отдельно

### Что исправлено (коммит dc7084b)

```typescript
// finnhubAdapter.ts — БЫЛО:
a.title_ru = a.title_original;  // EN текст в RU поле — "псевдоперевод"

// finnhubAdapter.ts — СТАЛО:
// title_ru остается null — признак "сырой" статьи
```

**Результат:**
- `title_ru = NULL` — News Processor корректно найдет через `WHERE title_ru IS NULL`
- `summary_ru = NULL` — то же самое
- Логика разделения original vs translated — корректна
- Пользователь видит EN текст (через `COALESCE(title_ru, title_original)`)

### Должно быть (разделение Fetch / Process)

```
Fetch Cron (NSM)                    Process Cron (News Processor)
├── RSS: fetchAllRSS() → INSERT     SELECT * FROM news WHERE title_ru IS NULL
├── Finnhub: fetch() → INSERT       ├── translateBatch() ← best effort
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
WHERE title_ru IS NULL           -- не переведена (включая Finnhub EN новости)
   OR sentiment IS NULL          -- не проанализирована тональность
   OR sentiment_source IS NULL   -- не определен источник sentiment
ORDER BY published_at DESC
LIMIT 50
```

**Важно:** `title_ru = NULL` теперь корректное состояние для:
- RSS новостей (ожидают перевода, если lang_original = 'en')
- Finnhub новостей (EN текст, title_ru еще не заполнен)

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
| 3 | `finnhubAdapter.ts` | `title_ru = title_original` (EN копия) | `title_ru = null` (сырое) | ✅ **Уже реализовано (коммит dc7084b)** |
| 4 | `index.ts` | Один cron: `/trigger-rss` | Два cron: `/trigger-rss` (fetch) + `/trigger/process` (process) | **Меняем** |
| 5 | `schema.sql` | — | Добавить `CREATE INDEX` для process query | **Добавляем** |

### 3.2 Что НЕ трогаем

| Компонент | Почему не трогаем |
|-----------|-------------------|
| `finnhubAdapter.ts` | ✅ Уже корректно — title_ru=null |
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
-- Выбрать 50 сырых статей (из любого источника: RSS, Finnhub, etc.)
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
  
  // 2. Translate EN → RU (Layer 1) — best effort, не блокирует sentiment
  try {
    await translateArticles(rawArticles);
  } catch (err: any) {
    console.log('[NewsProcessor] Translate skipped (API unavailable), continuing with sentiment');
  }
  
  // 3. Tag matching (identify which tags apply) — ВСЕГДА
  const matchedTagsList = await matchTags(rawArticles);
  
  // 4. Sentiment analysis (Layer 2) — ВСЕГДА, даже если translate упал
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

### 5.3 Translate (best effort — НЕ блокирует sentiment)

```typescript
async function translateArticles(articles: RawArticle[]): Promise<void> {
  const toTranslate = articles.filter(a => a.lang_original === 'en' && !(a as any).title_ru);
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
    // НЕ выбрасываем ошибку — sentiment всё равно делаем
    throw err; // Пусть caller решает — но processRawArticles ловит и продолжает
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
  
  const llmAvailable = !!process.env.KIMI_API_KEY;
  
  // Оптимизация: исключить дубликаты с reasoning
  const skipLLM = new Set<number>();
  if (llmAvailable) {
    for (let i = 0; i < articles.length; i++) {
      const existingCheck = await query(
        `SELECT sentiment_reasoning, sentiment_source 
         FROM news WHERE content_hash = $1 LIMIT 1`,
        [articles[i].content_hash]
      );
      const existing = existingCheck.rows[0];
      if (existing?.sentiment_reasoning && 
          (existing.sentiment_source === 'llm' || existing.sentiment_source === 'llm-partial')) {
        skipLLM.add(i);
        // Загружаем существующие данные
        unifiedResults[i] = { /* ... */ } as UnifiedResult;
      }
    }
  }
  
  const needLLM = articles.filter((_, i) => !skipLLM.has(i));
  
  // Batch LLM анализ
  // ... (копия из cron.ts 285-348)
  
  return results;
}
```

### 5.6 UPDATE в БД (batch)

```typescript
async function saveProcessedArticles(
  articles: RawArticle[],
  matchedTagsList: string[][],
  sentimentResults: UnifiedResult[]
): Promise<void> {
  let updated = 0;
  
  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const tags = matchedTagsList[i];
    const s = sentimentResults[i];
    
    try {
      await query(`
        UPDATE news
        SET title_ru = COALESCE($1, title_ru, title_original),
            summary_ru = COALESCE($2, summary_ru, summary_original),
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
        (a as any).title_ru,
        (a as any).summary_ru,
        s.sentiment,
        s.score,
        s.reasoning || null,
        (s as any)._llmErrorType || (s as any)._llmSource || 'llm',
        s.is_political,
        s.article_type || 'micro',
        tags,
        JSON.stringify(s.tag_impacts || []),
        (s as any)._llmErrorMsg || null,
        (s as any)._llmErrorType ? 1 : null,
        a.id,
      ]);
      updated++;
    } catch (err: any) {
      console.error(`[NewsProcessor] UPDATE failed for ${a.id}:`, err.message);
    }
  }
  
  console.log(`[NewsProcessor] Updated: ${updated}/${articles.length}`);
}
```

---

## 6. Cron и Lock

### 6.1 Cron schedule

```typescript
// index.ts (или cron.ts)

// News Processor — каждые 10 минут
setInterval(() => {
  import('./services/newsProcessor').then(({ processRawArticles }) => {
    processRawArticles().catch(console.error);
  });
}, 10 * 60 * 1000);  // 10 min
```

| Параметр | Значение | Почему |
|----------|----------|--------|
| Интервал | 10 минут | Баланс между скоростью и API лимитами |
| Lock | `news-processor` | Не конфликтует с RSS cron |
| Batch size | 50 | Как у RSS — consistency |

### 6.2 Lock (конкурентность)

```typescript
// processRawQuotes() — с lock
export async function processRawArticles(): Promise<void> {
  const acquired = await acquireCronLock('news-processor');
  if (!acquired) {
    console.log('[NewsProcessor] ⏳ Another instance running, skipping');
    return;
  }
  
  try {
    // ... основная логика ...
  } finally {
    await releaseCronLock('news-processor');
  }
}
```

### 6.3 Trigger endpoint

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

---

## 7. Fallback при пустом балансе Кими

### 7.1 Сценарий: translate 429, sentiment keyword-based

```
1. SELECT 50 сырых статей
2. translateBatch() → 429 Rate Limit
   → Ловим ошибку, НЕ прерываем
   → title_ru остается null
3. smartMatchTags() → работает (не требует API)
4. analyzeUnifiedBatch() → keyword-based (не требует API)
5. UPDATE
   → title_ru = COALESCE(null, null, title_original) = title_original
   → sentiment = 'neutral' (keyword)
   → sentiment_source = 'keyword'
```

### 7.2 Что увидит пользователь

| Поле | Значение | Почему |
|------|----------|--------|
| `title_ru` | `title_original` | COALESCE(null, null, original) = original |
| `sentiment` | `'neutral'` | keyword-based fallback |
| `sentiment_source` | `'keyword'` | не LLM |

**EN текст** — но с sentiment. Лучше чем ничего.

### 7.3 Когда баланс пополнится

```
Следующий цикл (10 мин):
1. SELECT — та же статья (title_ru = original ≠ null)
2. WHERE title_ru IS NULL → НЕ попадает
3. Статья пропущена — НЕ переводится
```

⚠️ **Проблема:** После fallback статья считается "готовой" и НЕ будет переведена когда баланс появится.

### 7.4 Решение: sentiment_source маркер

```sql
-- Переводим ТОЛЬКО если sentiment_source = 'keyword' (был fallback)
-- ИЛИ title_ru IS NULL

SELECT * FROM news
WHERE title_ru IS NULL
   OR sentiment_source = 'keyword'   -- ← был fallback, нужен LLM
   OR sentiment_source IS NULL
```

---

## 8. Файлы

| # | Файл | Действие | Сложность |
|---|------|----------|-----------|
| 1 | `src/services/newsProcessor.ts` | Создать | Высокая |
| 2 | `src/index.ts` | Добавить `/trigger/process` + cron | Низкая |
| 3 | `src/services/cron.ts` | Убрать translate + sentiment | Средняя |
| 4 | `src/models/schema.sql` | Добавить partial index | Низкая |

---

## 9. Verification

### 9.1 Тест: News Processor запуск

```bash
# 1. Триггер
$ curl "https://pulse-api-bsov.onrender.com/trigger/process?secret=pulse-dev-key"
# → {"started":true}

# 2. Логи (через 30 сек)
# → [NewsProcessor] Processing N raw articles
# → [NewsProcessor] Translate: X articles
# → [NewsProcessor] Updated: Y/N

# 3. Проверка — статьи обработаны
$ curl "https://pulse-api-bsov.onrender.com/debug-latest-reasoning"
# → sentiment не null, sentiment_source = 'llm' или 'keyword'
```

### 9.2 Тест: Finnhub → Process

```bash
# 1. Finnhub fetch
$ curl "https://pulse-api-bsov.onrender.com/trigger/nsm?secret=..."

# 2. Check: сырые
$ psql -c "SELECT COUNT(*) FROM news WHERE title_ru IS NULL AND source_id='finnhub'"
# → N

# 3. Run Processor
$ curl "https://pulse-api-bsov.onrender.com/trigger/process?secret=..."

# 4. Check: обработаны
$ psql -c "SELECT COUNT(*) FROM news WHERE sentiment IS NOT NULL AND source_id='finnhub'"
# → N (все обработаны)
```

### 9.3 Тест: Fallback (без Кими)

```bash
# 1. KIMI_API_KEY = "" (или unset)
# 2. Run Processor
$ curl "https://pulse-api-bsov.onrender.com/trigger/process?secret=..."

# 3. Check: translate skipped, sentiment done
# → [NewsProcessor] Translate skipped (API unavailable), continuing with sentiment
# → title_ru = title_original (COALESCE fallback)
# → sentiment = 'neutral', sentiment_source = 'keyword'
```

---

*Document: TZ_NEWS_PROCESSOR_v2.md*  
*Created: 2026-06-11*  
*Updated: 2026-06-11 (v2.1 — добавлены lock, cron, fallback, verification)*
