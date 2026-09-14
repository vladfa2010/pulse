# Каскады и сюжеты — бэкенд

Поиск новостных каскадов (одно событие — много перепечаток) и сюжетов (группы каскадов об одном факте). Публичный блок `/api/market/*`, фиче-флаг всего пайплайна — `CLUSTERING_ENABLED=true` (по умолчанию выключено). Методология — `Методология_поиска_новостных_каскадов_PULSE.md` в корне workspace, ТЗ-91 (эмбеддинги), ТЗ-92 (реалтайм), ТЗ-95 (доработки по ревью), ТЗ-97 (многодневный график), ТЗ-99 (id/url маркеров).

## Карта пайплайна

```
RSS/источники → newsProcessor (тегирование чанка)
  → embedAndClusterBatch (эмбеддинг Qwen3 через TEI → news.embedding)
  → clusterOne (top-10 косинусных кандидатов, окно 48 ч назад)
       sim ≥ 0.80 (T1)        → attachToCluster (авто-склейка)
       0.55 ≤ sim < 0.80       → серая зона → verifyPair (LLM, Moonshot/Kimi)
       sim < 0.55 (T2)         → одиночка
       числовое вето / рубрики → отброс до LLM
  → clusters / cluster_items (source='realtime')
  → runStoryGrouping (cron 1/час, LLM: кластер → существующий/новый сюжет)
  → stories + clusters.story_id
  → GET /api/market/{cascades,stories,cascade-chart,cascade-graph,cascade-research}
```

Догоняющий контур: cron каждые 15 мин достраивает `embedding IS NULL` за 7 дней; исторический бэкфилл — вручную скриптами (см. «Бэкфиллы»).

## Маршруты — `src/routes/marketPublic.ts`

Монтирование: `src/index.ts` — `app.use('/api/market', marketPublicRoutes)`. Все эндпоинты публичные, SQL — прямо в файле, кэш in-memory Map, TTL совпадает со staleTime фронта (`pulse-frontend/docs/cascades.md`).

| Эндпоинт | Строки | TTL кэша |
|---|---|---|
| `GET /news-chart?news_id=` | :81 | 60 с / 24 ч / 15 мин |
| `GET /cascades?window=24h\|7d\|30d` | :292 | 60 с |
| `GET /cascade-graph?window=7d\|30d` | :369 | 15 мин |
| `GET /cascade-research?window=7d\|30d` | :444 | 15 мин |
| `GET /cascade-chart?cluster_id=` | :561 | 15 мин |
| `GET /stories` | :725 | 15 мин |

Заметка: `src/routes/market.ts` (админские `/admin/market/candles_*`) импортируется в `index.ts`, но не смонтирован — мёртвый импорт, кандидат на чистку.

## Реалтайм-кластеризация

**Hook в ingest:** `src/services/newsProcessor.ts` — после тегирования чанка, fire-and-forget: `if (CLUSTERING_ENABLED==='true') void embedAndClusterBatch(chunk.map(a => a.id))`.

**Ядро — `src/services/clustering.ts`:**

- `embedAndClusterBatch(newsIds)` (:232) — выборка новостей без вектора → `embedBatch` (≤32) → `UPDATE news SET embedding` → `withNewsLock` → `clusterOne`.
- `clusterEmbeddedBatch(newsIds)` (:281) — то же для уже имеющих вектор (`cluster_id IS NULL`), TEI не дёргается; для исторического бэкфилла.
- `withNewsLock` (:98) — транзакция + `pg_try_advisory_xact_lock('cluster:'||id)` — дедупликация гонки NewsProcessor↔cron (ТЗ-95 1б).
- `clusterOne` (:312) — пропуск рубрик (`isRubricTitle`); top-10 кандидатов по косинусу `embedding <=> $1` в окне `CANDIDATE_WINDOW_HOURS=48` назад; **трёхзонная логика**:
  - `sim ≥ CLUSTER_T1 (0.80)` → `attachToCluster` без LLM;
  - `CLUSTER_T2 (0.55) ≤ sim < T1` → **серая зона** → `verifyPair()` (LLM, ТЗ-95 задача 3);
  - `sim < T2` → одиночка.
- `attachToCluster` (:129) — `FOR UPDATE` на кандидате и кластере; кластер старше `CLUSTER_GAP_HOURS=36` ч не принимает (новость — одиночка); `INSERT cluster_items ON CONFLICT DO NOTHING` + идемпотентный `UPDATE clusters` (size+1, `GREATEST` last_seen/max_sim, verdict не деградирует ниже ранга — ТЗ-95 1а/2); кандидат без кластера → создание `clusters(kind='cascade', source='realtime', size=2)`.

**Правила — `src/services/clusteringRules.ts`** (чистые функции, реэкспортируются из clustering.ts):
- `significantNumbers` — значимые числа (длина ≥2; годы 2025–2027 незначимы);
- `numericVeto` — оба заголовка имеют значимые числа и пересечение пусто → не клеим («763 беспилотника» ≠ «258 беспилотников»);
- `isRubricTitle` — рубрикаторы по чёрному списку `RUBRIC_BLACKLIST` (`src/config/clustering.ts`).

**LLM-верификатор — `src/services/clusterVerifier.ts`:** `verifyPair(a, b, sim)` → Moonshot `POST /v1/chat/completions`, модель `KIMI_MODEL || 'kimi-k2.6'`, temperature 0.6, thinking off, `response_format json_object`, таймаут 60 с. Суточный потолок `VERIFIER_DAILY_LIMIT=2000` (in-memory, сброс по UTC; при превышении пары отклоняются). Парсинг только по явным ключам `same_fact/confidence/reason` — fail-closed. Промпт — `src/services/clusterVerifierPrompt.ts` («тот же факт-событие, а не тема»).

## Сюжеты — `src/services/storyGrouper.ts` (ТЗ-92 задача 5)

Story — **LLM-сущность**. Cron `0 * * * *` → `runStoryGrouping()`: кандидаты — `clusters WHERE story_id IS NULL AND (size >= 8 OR жизнь > 24ч)` (до 30); на каждый — до 4 первых заголовков, плюс до 30 существующих сюжетов; одним вызовом Kimi назначить существующий сюжет или создать новый (title+summary). Записывает `clusters.story_id`, новые — `INSERT INTO stories`; `refreshStoryBounds()` пересчитывает `started_at=min`, `last_seen_at=max` членов.

## Эндпоинты — что откуда берётся

- **/market/cascades** (:292) — один SQL из `clusters`, фильтр `last_seen_at > NOW() - window`, `ORDER BY size DESC LIMIT 200`; `first_news` и `sources` — через `LEFT JOIN LATERAL` к `cluster_items`/`news`.
- **/market/cascade-chart** (:561) — якорь `clusters.first_published_at ?? last_seen_at`; теги — `unnest(matched_tags)` членов (fallback `clusters.tags`); свечи — `buildInstrumentsForTags()` (:133): до 3 тегов с инструментом (`enriched_data.symbol` вида `TICKER@MIC`), провайдер `marketRouter.getIntraday5min` (Finam Trade API — единственный зарегистрированный), при пустом дне сдвиг к ближайшему торговому (назад до 5 дней, потом вперёд), флаг `shifted`. Многодневность (ТЗ-97): `getIntraday5minRange`, крышка `CASCADE_CHART_MAX_RANGE_DAYS=14`, `truncated=true` при обрезке, «дотяжка» следующих торговых дней, `range_fallback=true` если Finam не отдал; `dates`/`covered_until` — только многодневным. `news_markers` (:682, ТЗ-99): `n.id, n.url, n.published_at, n.title_ru, n.source` по `cluster_items` ASC.
- **/market/stories** (:725) — `stories LEFT JOIN clusters`, `ORDER BY last_seen_at DESC, size DESC LIMIT 500`.
- **/market/cascade-graph** (:369) — каскады окна с `items[{lag, source, title, t}]` (`json_agg`), сюжеты этих кластеров, `feed` — ВСЕ новости окна (фон force-графа).
- **/market/cascade-research** (:444) — один CTE: первоисточники (`row_number ORDER BY lag_min`), медианный второй лаг, доли дублей ≤10/≤60 мин, по источникам `first_count/participations/median_lag_not_first`.

## Бэкфиллы и скрипты

| Скрипт | Запуск | Параметры |
|---|---|---|
| `src/scripts/backfillEmbeddings.ts` | `npx ts-node --transpile-only src/scripts/backfillEmbeddings.ts` | `BACKFILL_BATCH_SIZE` (деф. 16, ≤32), `BACKFILL_MOD/BACKFILL_REM` — партиции по `hashtext(id)%MOD` для параллельных воркеров; skipped → `logs/backfill_embeddings_skipped.json` |
| `src/scripts/backfillClusters.ts` | аналогично | `BATCH=200`, резюмируемый (`cluster_id IS NULL`), без TEI, серая зона через LLM-верификатор (суточный лимит) |
| `src/scripts/importCascadeSnapshot.ts` | аналогично | вход `cascade_import.json` в корне; исторические кластеры `source='sandbox-import'`, идемпотентен |
| `src/scripts/dumpCalibrationPairs.ts` | аналогично | `calibration_pairs.csv`: позитивы — пары внутри sandbox-кластеров, негативы — 10 000 случайных пар с разницей >3 суток |

Cron-запуска для бэкфиллов нет — только ручной. Регулярные cron (`src/services/cron.ts`, `startClusteringCron()`): `*/15 * * * *` — catch-up эмбеддингов (≤200, `embedding IS NULL AND published_at > NOW() - 7 days`); `0 * * * *` — `runStoryGrouping()`. Блокировка — `acquireCronLock`.

## Таблицы и индексы

Миграции **только ручные** (`psql -f`): `src/migrations/news_embeddings_v1.sql` (ТЗ-91), `news_embeddings_v2.sql` (ТЗ-92). В `src/models/schema.sql` кластерных таблиц нет.

- `news`: `+ embedding vector(1024)`, `+ cluster_id UUID`.
- `clusters`: `id, kind (cascade|story_candidate), tags[], verdict (сильный|средний|сомнительный), max_sim, first_published_at, last_seen_at, size, source (realtime|sandbox-import), story_id (v2)`.
- `cluster_items`: `cluster_id, news_id` (FK ON DELETE CASCADE), `lag_min`, PK `(cluster_id, news_id)`; индексы `cluster_items_news(news_id)`, `clusters_last_seen(last_seen_at)`.
- `stories`: `id, title, summary, started_at, last_seen_at`; индекс `clusters_story(story_id)`.
- **HNSW в миграциях нет** — строится вручную после бэкфилла: `CREATE INDEX CONCURRENTLY news_embedding_hnsw ON news USING hnsw (embedding vector_cosine_ops); ANALYZE news;` (см. `DEPLOYMENT.md`, `ARCHITECTURE.md`).

## Внешние сервисы

- **Эмбеддинги — TEI** (`src/services/embeddings.ts`): `EMBEDDINGS_URL` (деф. `http://embeddings:80`), `POST /embed`, `EMBEDDING_MAX_BATCH=32`, `EMBEDDING_DIM=1024`, `EMBEDDING_MAX_TEXT=1000`, таймаут 600 000 мс (инцидент 2026-09-11), 1 retry, `embeddingText(title, summary)` — единый формат текста. Контейнер: `docker-compose.yml` — `text-embeddings-inference:cpu-1.9`, модель `Qwen/Qwen3-Embedding-0.6B`, `--max-client-batch-size 32 --max-batch-tokens 4096`, mem 3g/cpus 1.0, порт наружу не публикуется.
- **LLM — Moonshot/Kimi**: верификатор пар и story-группировщик. Калибровка порогов — `dumpCalibrationPairs.ts` + ручной анализ CSV, отдельного LLM-клиента нет.

## Проверки

- `scripts/clustering-veto-verify.js` — регрессионные проверки `numericVeto`/`significantNumbers`/`isRubricTitle` без БД; `npm run verify:clusteringVeto`.
- `scripts/db-news-queries-verify.js` — PG-smoke тяжёлых новостных SQL через код из `dist/`.
