# План: Реализация ТЗ LLM Error Tracking v3

## Этапы

### Stage 1: Миграция БД
- ALTER TABLE news: 6 новых колонок
- CREATE TABLE llm_batches
- Индексы
- Проверить применение

### Stage 2: smartTagMatcher.ts
- Partial success detection (arr.length vs batch.length)
- llm-empty handling
- While-loop fallback с _llmSource='llm-partial'
- _llmRaw preview

### Stage 3: cron.ts
- batchStartTime определение
- Catch-блок: классификация ошибки + llm_batches INSERT
- Merge-цикл: _llm* поля
- INSERT: CASE WHEN в ON CONFLICT

### Stage 4: Deferred Processor
- processDeferredArticles() функция
- Retry логика (max 3)
- Cron job каждые 10 мин

### Stage 5: Admin Endpoints
- GET /admin/llm-errors
- POST /admin/backfill
- GET /admin/llm-dashboard

### Stage 6: Telegram Alerting
- Success rate check
- Alert при < 90%

### Stage 7: Build + Deploy
- tsc --noEmit
- git commit + push
