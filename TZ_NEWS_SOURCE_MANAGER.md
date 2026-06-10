# TZ: NewsSourceManager — Единый пул источников (RSS + API)

> **ID:** TZ_NEWS_SOURCE_MANAGER  
> **Дата:** 2026-06-10  
> **Статус:** Архитектурное ТЗ — ожидает API endpoint'ы и rate limits

---

## 1. Цель

Заменить разрозненные cron-задачи (RSS отдельно, API отдельно) на единый сервис `NewsSourceManager`. Один цикл — все источники.

| До | После |
|----|-------|
| `fetchAllRSS()` — один cron | `NewsSourceManager.run()` — единый цикл |
| RSS жёстко в коде | Все источники в таблице `news_sources` |
| Вкл/выкл — комментировать код | Вкл/выкл — toggle в админке |
| API — отдельный сервис | API — адаптер внутри Manager |

---

## 2. Архитектура

```
NewsSourceManager (каждые 15 мин)
│
│  1. SELECT * FROM news_sources WHERE enabled = true
│  2. Для каждого source:
│     ├── RSS адаптер (если source.type = 'rss')
│     │     └── fetchAllRSS() — существующий код
│     │
│     └── API адаптер (если source.type = 'api_search')
│           └── Собрать DISTINCT tag_id из portfolios
│           └── Для каждого тега: запрос к API
│           └── Нормализовать → INSERT INTO news
│
│  3. UPDATE news_sources SET last_fetch_at = NOW()
│  4. Следующий цикл через 15 мин
```

---

## 3. Таблица news_sources

```sql
CREATE TABLE IF NOT EXISTS news_sources (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50) NOT NULL,      -- "kommersant", "api_world_1"
  display_name  VARCHAR(100) NOT NULL,     -- "Коммерсант", "NewsAPI World"
  type          VARCHAR(20) NOT NULL,      -- 'rss' | 'api_search' | 'api_feed'
  config        JSONB DEFAULT '{}',        -- {url, api_key, rate_limit, ...}
  enabled       BOOLEAN DEFAULT true,
  last_fetch_at TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Уникальность имени
CREATE UNIQUE INDEX IF NOT EXISTS idx_news_sources_name ON news_sources(name);
```

### Миграция существующих RSS

```sql
INSERT INTO news_sources (name, display_name, type, config, enabled) VALUES
('kommersant', 'Коммерсант', 'rss', '{"url": "https://www.kommersant.ru/RSS/news.xml"}', true),
('interfax', 'Интерфакс', 'rss', '{"url": "https://www.interfax.ru/rss.asp"}', true)
-- ... все 33 источника из RSS_SOURCES
ON CONFLICT (name) DO NOTHING;
```

### Поле config по типам

| type | config пример |
|------|--------------|
| `rss` | `{"url": "https://..."}` |
| `api_search` | `{"base_url": "https://api.news.com", "api_key": "...", "rate_limit_rpm": 60, "q_template": "{tag_name}"}` |
| `api_feed` | `{"base_url": "https://...", "endpoint": "/feed"}` |

---

## 4. NewsSourceManager — интерфейс

```typescript
// src/services/newsSourceManager.ts

interface NewsSource {
  id: number;
  name: string;
  display_name: string;
  type: 'rss' | 'api_search' | 'api_feed';
  config: Record<string, any>;
  enabled: boolean;
  last_fetch_at: Date | null;
}

interface FetchedArticle {
  title_original: string;
  title_ru?: string;
  summary_original?: string;
  summary_ru?: string;
  url: string;
  published_at: Date;
  source: string;        -- source_name (display_name)
  source_id: string;     -- source.name (identifier)
  source_type: string;   -- 'rss' | 'api_search' | 'api_feed'
  lang_original: string;
  matched_tags?: string[];  -- для API: сразу известный тег
}

class NewsSourceManager {
  async run(): Promise<void>;
  private async fetchRSS(source: NewsSource): Promise<FetchedArticle[]>;
  private async fetchAPISearch(source: NewsSource): Promise<FetchedArticle[]>;
  private async saveArticles(articles: FetchedArticle[]): Promise<void>;
}
```

---

## 5. RSS адаптер

**Существующий код — обёртка.** `fetchAllRSS()` уже работает. Меняем:

| До | После |
|----|-------|
| `RSS_SOURCES` hardcoded array | `SELECT * FROM news_sources WHERE type = 'rss'` |
| `source.url` из массива | `source.config.url` из БД |
| `source.id` как ключ | `source.name` как ключ |

**Минимум изменений** — `rssFetcher.ts` принимает `NewsSource[]` вместо `RssSource[]`.

---

## 6. API адаптер (новый)

```typescript
async fetchAPISearch(source: NewsSource): Promise<FetchedArticle[]> {
  // 1. Собрать DISTINCT теги из portfolios
  const tagResult = await query(`
    SELECT DISTINCT t.tag_id, t.tag_name, t.enriched_data
    FROM user_defined_tags t
    JOIN portfolios p ON p.tag_id = t.tag_id
  `);
  const tags = tagResult.rows;

  // 2. Для каждого тега — запрос к API
  const articles: FetchedArticle[] = [];
  for (const tag of tags) {
    const queryStr = this.buildQuery(tag, source.config.q_template);
    const apiArticles = await this.callAPI(source.config, queryStr);

    for (const a of apiArticles) {
      articles.push({
        ...a,
        matched_tags: [tag.tag_id],  -- 100% match, тег известен
        source_type: source.type,
        source: source.display_name,
        source_id: source.name,
      });
    }

    // Rate limit: sleep между запросами
    await this.respectRateLimit(source.config.rate_limit_rpm);
  }

  return articles;
}
```

**buildQuery:**
```typescript
private buildQuery(tag: any, template: string): string {
  // Использовать английское имя тега
  const enName = tag.enriched_data?.synonyms_en?.[0] || tag.tag_name;
  return template.replace('{tag_name}', enName);
}
```

---

## 7. Save articles (общий)

```typescript
async saveArticles(articles: FetchedArticle[]): Promise<void> {
  for (const a of articles) {
    const contentHash = crypto.createHash('sha256')
      .update(a.title_ru || a.title_original + '\n' + (a.summary_ru || ''))
      .digest('hex');

    await query(`
      INSERT INTO news (
        title_original, title_ru, summary_original, summary_ru,
        source, source_id, source_type, url, content_hash,
        all_sources, source_count, published_at, lang_original,
        matched_tags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$5], 1, $10, $11, $12)
      ON CONFLICT (content_hash) DO UPDATE SET
        all_sources = array_append_unique(news.all_sources, EXCLUDED.source),
        source_count = array_length(array_append_unique(news.all_sources, EXCLUDED.source), 1)
    `, [
      a.title_original, a.title_ru, a.summary_original, a.summary_ru,
      a.source, a.source_id, a.source_type, a.url, contentHash,
      a.published_at, a.lang_original, a.matched_tags || []
    ]);
  }
}
```

**source_type** добавляется в INSERT. Существующий `source` — display_name, `source_id` — identifier.

---

## 8. Админка — вкл/выкл источников

```typescript
// GET /admin/news-sources
app.get('/admin/news-sources', requireAdmin, async (req, res) => {
  const result = await query(`SELECT id, name, display_name, type, enabled, last_fetch_at FROM news_sources ORDER BY type, name`);
  res.json({ sources: result.rows });
});

// PUT /admin/news-sources/:id/toggle
app.put('/admin/news-sources/:id/toggle', requireAdmin, async (req, res) => {
  const result = await query(`UPDATE news_sources SET enabled = NOT enabled WHERE id = $1 RETURNING *`, [req.params.id]);
  res.json({ source: result.rows[0] });
});
```

---

## 9. Миграция — пошаговый план

| Шаг | Что | Риск |
|-----|-----|------|
| 1 | Создать `news_sources` таблицу | Низкий |
| 2 | Перенести RSS в `news_sources` | Низкий |
| 3 | Добавить `source_type` в `news` | Низкий (ALTER COLUMN IF NOT EXISTS) |
| 4 | Создать `NewsSourceManager` shell | Низкий |
| 5 | RSS адаптер — обёртка | Средний — проверить fetch |
| 6 | Заменить cron вызов | Средний — мониторинг |
| 7 | API адаптер (заглушка) | Низкий |
| 8 | Подключить API источники | Зависит от API provider |
| 9 | Админка вкл/выкл | Низкий |

---

## 10. Что нужно от пользователя

| Что | Зачем |
|-----|-------|
| API endpoint'ы (2+ источника) | Реализовать адаптер |
| Rate limits (rpm, rpd) | Respect rate limiting |
| Формат ответа API | Парсинг новостей |
| Параметры запроса (q, from, to, language) | Build query |
| Аутентификация API (api_key, header) | callAPI реализация |

---

## 11. Критерии приёмки

- [ ] RSS источники работают как раньше
- [ ] Включение/выключение RSS через админку
- [ ] API источник запрашивает по тегам портфелей
- [ ] API новости вливаются в ту же таблицу `news`
- [ ] Дедупликация по `content_hash` работает (RSS + API)
- [ ] `source_type` = 'api_search' у API-новостей
- [ ] `matched_tags[]` предзаполнен для API-новостей
- [ ] Rate limit — не превышаем, логируем

---

*Document: TZ_NEWS_SOURCE_MANAGER.md*  
*Created: 2026-06-10*  
*Status: Draft — awaiting API details*
