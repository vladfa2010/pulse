# TZ: Finnhub API Adapter

> **ID:** TZ_FINNHUB_ADAPTER  
> **Дата:** 2026-06-10  
> **Статус:** Реализация

---

## 1. Конфигурация

```sql
INSERT INTO news_sources (name, display_name, type, config, enabled) VALUES
('finnhub', 'Finnhub News', 'api_search', '{
  "base_url": "https://finnhub.io/api/v1",
  "api_key": "d8jc4r9r01qh6g3pfkn0",
  "endpoint": "/company-news",
  "rate_limit_rpm": 60,
  "rate_limit_rpd": 300,
  "q_template": "{ticker}",
  "schedule_minutes": 60
}', true);
```

---

## 2. Алгоритм

```
1. SELECT DISTINCT tag_id, enriched_data->>'ticker' as ticker
   FROM user_defined_tags
   WHERE enriched_data->>'ticker' IS NOT NULL

2. Для каждого тикера:
   GET {base_url}/company-news?symbol={TICKER}&from={TODAY}&to={TODAY}&token={api_key}

3. Для каждой новости:
   - title_original = headline
   - title_ru = null (перевод позже)
   - summary_original = summary
   - url = url
   - published_at = datetime (unix → Date)
   - source = 'Finnhub News'
   - source_id = 'finnhub'
   - source_type = 'api_search'
   - matched_tags = [tag_id] (100% match)
   - content_hash = SHA256(headline + '\n' + summary)

4. INSERT INTO news ... ON CONFLICT (content_hash) DO UPDATE
```

---

## 3. Rate limit

- 60 req/min (rpm)
- 300 req/day (rpd) ← КРИТИЧНО
- Sleep между запросами: 60/60 = 1 сек

При 429: skip до следующего цикла

---

## 4. Маппинг tag → ticker

Использовать `enriched_data->>'ticker'` из `user_defined_tags`.

Если у тега нет ticker — не запрашиваем (skip).

---

## 5. Критерии

- [ ] Запрос по каждому тегу с ticker
- [ ] Новости сохраняются в `news`
- [ ] `matched_tags[]` предзаполнен
- [ ] `source_type` = 'api_search'
- [ ] Дедупликация по `content_hash`
- [ ] Rate limit respected (sleep 1s)
- [ ] 429 → skip, логировать
