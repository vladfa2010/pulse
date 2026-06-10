# TZ: News Source System v1 — Единый пул источников (RSS + API)

> **ID:** TZ_NEWS_SOURCE_SYSTEM_v1  
> **Дата создания:** 2026-06-10  
> **Статус:** Частично реализовано (коммит `bfc520f`)  
> **Автор:** PULSE Team  
> **Назначение:** Аудит

---

## 1. Общее описание

### 1.1. Проблема

Сейчас в PULSE только один источник новостей — RSS-агрегатор (35 источников). Для нишевых компаний (CRISPR, редкие тикеры) новостей мало — они не попадают в RSS-ленты крупных СМИ.

### 1.2. Решение

Внедрить систему NewsSourceManager — единый сервис, который:
- Агрегирует новости из **нескольких источников** (RSS + REST API)
- Опрашивает API **по тегам пользователей** (только те тикеры, что в портфелях)
- Дает **100% матчинг** по тегу (API возвращает новость с привязкой к тикеру)
- Работает **бесшовно** — словно ещё один RSS-источник

### 1.3. Что уже сделано (коммит `bfc520f`)

| # | Что | Статус |
|---|-----|--------|
| 1 | Таблица `news_sources` | ✅ Создана в schema.sql |
| 2 | Миграция RSS → `news_sources` | ✅ В `migrate-v3-enrichment` |
| 3 | Finnhub config в `news_sources` | ✅ В миграции |
| 4 | `FinnhubAdapter.ts` | ✅ Полный адаптер |
| 5 | `NewsSourceManager.ts` | ✅ Shell + интеграция |
| 6 | Cron (каждый час) | ✅ В `start()` |
| 7 | Admin endpoints | ✅ GET + PUT toggle |

### 1.4. Что ещё нужно сделать

| # | Что | Статус | Приоритет |
|---|-----|--------|-----------|
| 1 | RSS adapter в NewsSourceManager | 🔶 Не обёрнут | Высокий |
| 2 | Админка frontend (вкл/выкл) | 🔶 Нет UI | Средний |
| 3 | Перевод EN → RU (Finnhub) | 🔶 Нет | Средний |
| 4 | Cron логирование для NSM | 🔶 Нет | Низкий |
| 5 | Rate limit tracking | 🔶 Нет | Низкий |

---

## 2. Архитектура

### 2.1. Общая схема

```
┌─────────────────────────────────────────────────────────────┐
│                    NewsSourceManager                        │
│                    (каждые 60 мин)                          │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    │
│  │   Source 1  │    │   Source 2  │    │   Source N  │    │
│  │  (RSS)      │    │  (Finnhub)  │    │  (future)   │    │
│  │  enabled?   │    │  enabled?   │    │  enabled?   │    │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    │
│         │                  │                  │             │
│         ▼                  ▼                  ▼             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    │
│  │ RSSAdapter  │    │ APIAdapter  │    │ APIAdapter  │    │
│  │ fetchAllRSS │    │ fetchFinnhub│    │ future...   │    │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘    │
│         │                  │                  │             │
│         └──────────┬───────┴──────────────────┘             │
│                    │                                        │
│                    ▼                                        │
│         ┌─────────────────┐                                 │
│         │  normalize()    │                                 │
│         │  unified format │                                 │
│         └────────┬────────┘                                 │
│                  │                                          │
│                  ▼                                          │
│         ┌─────────────────┐                                 │
│         │  dedup (hash)   │                                 │
│         │  content_hash   │                                 │
│         └────────┬────────┘                                 │
│                  │                                          │
│                  ▼                                          │
│         ┌─────────────────┐                                 │
│         │  saveArticles() │                                 │
│         │  INSERT ...     │                                 │
│         │  ON CONFLICT    │                                 │
│         └─────────────────┘                                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │   news (table)  │
                    │   unified       │
                    └─────────────────┘
```

### 2.2. Таблица `news_sources`

```sql
CREATE TABLE IF NOT EXISTS news_sources (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50) NOT NULL UNIQUE,  -- 'kommersant', 'finnhub'
  display_name  VARCHAR(100) NOT NULL,         -- 'Коммерсант', 'Finnhub News'
  type          VARCHAR(20) NOT NULL,          -- 'rss' | 'api_search' | 'api_feed'
  config        JSONB DEFAULT '{}',            -- {url, api_key, rate_limit, ...}
  enabled       BOOLEAN DEFAULT true,
  last_fetch_at TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);
```

### 2.3. Поле `config` по типам

| type | config пример | Описание |
|------|--------------|----------|
| `rss` | `{"url": "https://...", "lang": "ru"}` | RSS feed URL |
| `api_search` | `{"base_url": "...", "api_key": "...", "rate_limit_rpm": 60}` | REST API params |
| `api_feed` | `{"base_url": "...", "endpoint": "/feed"}` | Feed API params |

### 2.4. Таблица `news` — расширение

Добавлено поле `source_type` (enum: `rss`, `api_search`, `api_feed`):

```sql
-- ALTER TABLE news ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'rss';
```

**ВАЖНО:** Существующие записи имеют `source_type = NULL`. Новые — `rss` или `api_search`.

---

## 3. Finnhub API Adapter (реализовано)

### 3.1. Конфигурация в БД

```sql
INSERT INTO news_sources (name, display_name, type, config, enabled) VALUES
('finnhub', 'Finnhub News', 'api_search', '{
  "base_url": "https://finnhub.io/api/v1",
  "endpoint": "/company-news",
  "api_key": "d8jc4r9r01qh6g3pfkn0",
  "rate_limit_rpm": 60,
  "rate_limit_rpd": 300,
  "schedule_minutes": 60
}', true);
```

### 3.2. Алгоритм

```
1. SELECT DISTINCT tag_id, enriched_data->>'ticker'
   FROM user_defined_tags
   JOIN portfolios ON portfolios.tag_id = user_defined_tags.tag_id
   WHERE ticker IS NOT NULL AND LENGTH(ticker) > 0

2. Для каждого тикера:
   GET https://finnhub.io/api/v1/company-news?symbol={TICKER}&from={TODAY}&to={TODAY}&token={KEY}

3. Для каждой новости:
   - content_hash = SHA256(headline + '\n' + summary)
   - matched_tags = [tag_id]  (100% match)
   - source_type = 'api_search'
   - source = 'Finnhub News'
   - source_id = 'finnhub'
   - lang_original = 'en'

4. INSERT INTO news ... ON CONFLICT (content_hash) DO UPDATE
```

### 3.3. Rate Limits

| Параметр | Значение |
|----------|----------|
| Запросов/минута | 60 |
| Запросов/день | 300 |
| Sleep между запросами | 1000 ms (60/мин) |
| При 429 | Skip → лог → следующий цикл |

### 3.4. Предупреждение: лимит 300/день

При 25 тегах × раз в час = 600 запросов/день. **Превышаем лимит в 2×.**

**Рекомендации:**
- Вариант A: 12 топ-тегов × раз в час + 13 редких × раз в день = 301
- Вариант B: Все 25 × раз в 2 часа = 300
- Вариант C: Как есть — вторая половина дня 429

### 3.5. API Key

- Хранится в `news_sources.config->>'api_key'`
- Fallback: `process.env.FINNHUB_API_KEY`
- Hardcoded default (deprecated, для dev): `d8jc4r9r01qh6g3pfkn0`

---

## 4. NewsSourceManager (реализовано)

### 4.1. Интерфейс

```typescript
class NewsSourceManager {
  async run(): Promise<void>;        // один цикл
  private isRunning: boolean;         // защита от дублирования
}

// Singleton
function getNewsSourceManager(): NewsSourceManager;
```

### 4.2. Цикл `run()`

```
1. SELECT * FROM news_sources WHERE enabled = true
2. Для каждого source:
   a. Если type = 'rss' → RSSAdapter (TODO)
   b. Если type = 'api_search' и name = 'finnhub' → FinnhubAdapter
   c. Обновить last_fetch_at
3. Завершить
```

### 4.3. Cron

```typescript
// Запуск каждые 60 минут
setInterval(() => nsm.run(), 60 * 60 * 1000);

// Первый запуск сразу при старте сервера
nsm.run();
```

### 4.4. Защита от дублирования

```typescript
if (this.isRunning) {
  console.log('[NewsSourceManager] Already running, skip');
  return;
}
this.isRunning = true;
// ... work ...
this.isRunning = false;
```

---

## 5. Admin Endpoints (реализовано)

### 5.1. Список источников

```
GET /admin/news-sources
Headers: Authorization: Bearer {JWT}

Response:
{
  "sources": [
    {
      "id": 1,
      "name": "kommersant",
      "display_name": "Коммерсант",
      "type": "rss",
      "enabled": true,
      "last_fetch_at": "2026-06-10T12:00:00Z",
      "created_at": "2026-06-10T10:00:00Z"
    },
    {
      "id": 34,
      "name": "finnhub",
      "display_name": "Finnhub News",
      "type": "api_search",
      "enabled": true,
      "last_fetch_at": null,
      "created_at": "2026-06-10T10:00:00Z"
    }
  ]
}
```

### 5.2. Вкл/выкл источника

```
PUT /admin/news-sources/:id/toggle
Headers: Authorization: Bearer {JWT}

Response:
{
  "source": {
    "id": 34,
    "name": "finnhub",
    "display_name": "Finnhub News",
    "type": "api_search",
    "enabled": false   // ← toggled
  }
}
```

---

## 6. Что ещё нужно сделать

### 6.1. RSS Adapter в NewsSourceManager (🔶 Высокий)

**Проблема:** Существующий `fetchAllRSS()` работает отдельно от NewsSourceManager. Нужно обернуть его в адаптер.

**Решение:**
```typescript
// В NewsSourceManager.run():
if (source.type === 'rss') {
  const articles = await fetchRSSFromSource(source);  // обёртка
  await saveArticles(articles);
}

// fetchRSSFromSource — принимает NewsSource вместо RssSource
// Минимум изменений: source.config.url вместо source.url
```

### 6.2. Админка Frontend (🔶 Средний)

**Нужно:** страница `/admin/sources` со списком и toggle-кнопками.

**Дизайн:** как существующая `/admin/tags` — таблица + статус.

### 6.3. Перевод EN → RU (🔶 Средний)

**Проблема:** Finnhub отдаёт на английском.

**Решение:**
- Добавить шаг перевода в `finnhubAdapter.ts`
- Использовать существующий `translateArticle()` из `translation.ts`
- Или: пометить `title_ru = null`, переводить при отображении

### 6.4. Cron логирование (🔶 Низкий)

**Проблема:** NSM не пишет в `cron_log`.

**Решение:** добавить `cron_log` INSERT в начало/конец `run()`.

### 6.5. Rate limit tracking (🔶 Низкий)

**Проблема:** не отслеживаем сколько запросов потрачено.

**Решение:** добавить `requests_today` counter в `news_sources.config`.

---

## 7. Миграция — пошаговый план

| Шаг | Команда/Действие | Результат |
|-----|-----------------|-----------|
| 1 | `POST /migrate-v3-enrichment?secret=pulse-dev-key` | Таблица `news_sources` + 33 RSS + Finnhub |
| 2 | Добавить `FINNHUB_API_KEY` в Render env (опционально) | API key из env вместо hardcoded |
| 3 | Manual Deploy на Render | Код с NSM |
| 4 | Проверить `GET /admin/news-sources` | 34 sources (33 RSS + Finnhub) |
| 5 | Проверить логи через 1 час | `[Finnhub] Fetching news for N tickers` |

---

## 8. API Reference

### 8.1. Backend Endpoints

| Endpoint | Method | Auth | Описание |
|----------|--------|------|----------|
| `/admin/news-sources` | GET | Admin | Список источников |
| `/admin/news-sources/:id/toggle` | PUT | Admin | Вкл/выкл |
| `/migrate-v3-enrichment` | POST | Secret | Миграция БД |

### 8.2. External API

| Endpoint | Описание |
|----------|----------|
| `GET https://finnhub.io/api/v1/company-news?symbol={TICKER}&from={DATE}&to={DATE}&token={KEY}` | Новости по тикеру |

### 8.3. Формат ответа Finnhub

```json
[
  {
    "datetime": 1780925643,
    "headline": "CRISPR Therapeutics AG (CRSP) выступает на конференции",
    "summary": "46-я ежегодная конференция William Blair Growth Stock...",
    "source": "SeekingAlpha",
    "url": "https://finnhub.io/api/news?id=...",
    "image": "https://...",
    "category": "conference"
  }
]
```

---

## 9. Риски

| Риск | Вероятность | Митигация |
|------|------------|-----------|
| Rate limit 429 | Высокая | Sleep, skip, лог |
| Дубли с RSS | Низкая | content_hash dedup |
| Пустые тикеры | Средняя | WHERE ticker IS NOT NULL |
| Render sleep (free tier) | Средняя | Первый запрос при логине |

---

## 10. Коммиты

| Коммит | Дата | Что |
|--------|------|-----|
| `bfc520f` | 2026-06-10 | NewsSourceManager + Finnhub adapter + admin endpoints |

---

*Document: TZ_NEWS_SOURCE_SYSTEM_v1.md*  
*Created: 2026-06-10*  
*For: Audit*
