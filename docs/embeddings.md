# Эмбеддинги PULSE — модель, инфраструктура, продюсеры, эксплуатация

Единая точка входа по всему контуру векторов. Детали фич живут в своих
модулях (`cascades.md` — кластеризация новостей, `topics.md` — темы,
`education.md` — LMS), здесь — сквозная логика, общая инфра и регламенты.

## Модель и инфраструктура

- **Модель:** `Qwen/Qwen3-Embedding-0.6B`, размерность **1024** (константа
  `EMBEDDING_DIM`). Без instruction-префикса: все задачи симметричные
  (новость ↔ новость, урок ↔ урок).
- **Сервер:** [text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference)
  (TEI), образ `ghcr.io/huggingface/text-embeddings-inference:cpu-1.9`,
  digest закреплён в `docker-compose.yml` (ТЗ-91).
- **Сеть:** контейнер `pulse-embeddings`, порт наружу **не публикуется**.
  Бекенд ходит по внутренней сети compose: `EMBEDDINGS_URL=http://embeddings:80`
  (дефолт в `src/services/embeddings.ts`, переопределяется env).
- **Ресурсы VDS (состояние на 2026-10-14 вечер):** хост **4 CPU / 6 ГБ**
  (CPU поднял владелец); контейнеру TEI постоянно **2 ядра**:
  `RAYON_NUM_THREADS=2`, `cpus 2`, mem **5000m** — на 4500m warmup-спайк
  candle (~4,55 ГБ при RAYON=2) получал cgroup-OOM, факт из dmesg 14.10.
  Одиночный запрос: **7,2 с** (на 1 ядре было 20–60 с очереди + инференс).
  Флаги TEI: `--max-client-batch-size 32 --max-batch-tokens 4096
  --tokenization-workers 4`. История ресурсов: DEPLOYMENT.md §ТЗ-91
  (было 22 CPU / 8G RAM, вернули после бэкфилла 2026-09-12).

## Клиент — `src/services/embeddings.ts`

Единый клиент для всех продюсеров, второй клиент не плодим.

- `embedBatch(texts)` — POST `{EMBEDDINGS_URL}/embed`, body
  `{"inputs": [...]}`, батч ≤ `EMBEDDING_MAX_BATCH=32` (зеркалит
  `--max-client-batch-size`). Один retry через 5 с, затем throw.
- **Транспорт — `node:http` с keep-alive, НЕ fetch** (2026-10-14): у undici
  дефолтный `headersTimeout 300 с`, а TEI отдаёт заголовки только после
  полного инференса → медленные запросы умирали с
  `UND_ERR_HEADERS_TIMEOUT` при живом сервере. Общий таймаут запроса —
  600 000 мс (инцидент 2026-09-11: 30 000 мс из ТЗ-91 рвало ночной бэкфилл).
- **Санитизация Unicode:** TEI (serde_json) отклоняет JSON с непарными
  суррогатами → `stripLoneSurrogates()` перед отправкой (инцидент 2026-09-11,
  битый Unicode в старых новостях гасил батч целиком HTTP 400).
- Валидация ответа: массив той же длины, каждый вектор ровно 1024 float.
- `embeddingText(title_ru, summary_ru)` — единый формат текста новостей:
  `title + ' ' + COALESCE(summary, '')`, обрезка `EMBEDDING_MAX_TEXT=1000`.

## Кто использует (все через тот же клиент и тот же TEI)

| Продюсер | Где | Когда | Текст | Куда пишет |
|---|---|---|---|---|
| Кластеризация новостей | `services/clustering.ts` | hook в ingest (fire-and-forget при `CLUSTERING_ENABLED=true`) + cron `*/15` catch-up | `embeddingText(title_ru, summary_ru)` | `news.embedding` (pgvector) → `cluster_id` |
| Бэкфилл новостей | `scripts/backfillEmbeddings.ts` | ручной запуск; партиции `BACKFILL_MOD/REM`, `BACKFILL_BATCH_SIZE` (деф. 16) | то же | `news.embedding`; skipped → `logs/backfill_embeddings_skipped.json` |
| Смысловой поиск | `routes/news.ts` (`/api/news/search`) | реалтайм, по запросу юзера | запрос целиком, 1 текст (свой таймаут `SEMANTIC_SEARCH_TIMEOUT_MS`) | не пишет, ищет по `news.embedding` (HNSW) |
| Темы каскадов | Python-sidecar `topics-worker` (кластеризация, 03:40 МСК) + `services/cron.ts` (нейминг тем) | cron (ТЗ-115, `TOPICS_ENABLED` на VPS) | окно 14 дней, `embedding IS NOT NULL` | не считает заново — ест готовые векторы новостей |
| Мэтчинг курсов ↔ новости | `services/education/match.ts` | триггер при сохранении курса (`scheduleCourseReembedding`, при `EDUCATION_MATCH_ENABLED`) | `title + '\n' + description + '\n' + названия уроков`, обрезка 1000 | `courses.embedding` |
| Бэкфилл курсов | `scripts/backfill-course-embeddings.js` | ручной запуск (идемпотентен) | то же | `courses.embedding` |
| **Граф знаний уроков** | `services/education/knowledgeGraph.ts` | cron 04:50 MSK (`education-knowledge-graph`, CronLock) + ручной запуск | `title + ' ' + plain(text_content)` (HTML→plain), обрезка 1000 | `lesson_embeddings`, `lesson_similarity`, `course_similarity` |

Координации «общей очереди» между продюсерами нет: TEI сериализует входящие
батчи во внутреннюю очередь (`max-batch-tokens`), а конкуренцию разруливают
CronLock'и (кластеризация, KG-джоба), флаги и тайминги. Дневной реалтайм
(поиск, мэтчинг) — короткие тексты, не конфликтуют. Тяжёлые батчи —
ночью.

## Хранилища векторов

| Таблица | Тип вектора | Индекс | Миграция |
|---|---|---|---|
| `news.embedding` | `vector(1024)` pgvector | HNSW `news_embedding_hnsw` (cosine), **ручной** после бэкфилла + `ANALYZE` | `news_embeddings_v1.sql` |
| `courses.embedding` | `vector(1024)` pgvector | — (выборки по всем курсам, мало строк) | `lms_v3_matching.sql` |
| `lesson_embeddings.vector` | `BYTEA` (float32 LE ×1024) | PK `lesson_id`; `text_hash` для инкрементальности | `lms_v8_knowledge_graph.sql` |
| `lesson_similarity` / `course_similarity` | снапшоты рёбер графа | индексы по обеим колонкам пар | `lms_v8_knowledge_graph.sql` |

HNSW для `news` сознательно единственный: остальные таблицы — десятки/сотни
строк, полный перебор дешевле индекса.

## Пороги графа знаний (env, `src/config/knowledgeGraph.ts`)

| Env | Дефолт | Назначение |
|---|---|---|
| `KG_LESSON_CROSS_TOP` / `KG_LESSON_CROSS_MIN_SIM` | 5 / 0.55 | топ рёбер урок↔урок других курсов + рекомендации |
| `KG_LESSON_INTRA_TOP` / `KG_LESSON_INTRA_MIN_SIM` | 3 / 0.60 | топ рёбер внутри курса |
| `KG_COURSE_TOP_PAIRS` / `KG_COURSE_MIN_SIM` | 10 / 0.45 | `course_similarity`: итог = среднее (`cos(courses.embedding)`, среднее топ-10 cross-пар уроков); при 0 cross-пар — только косинус курсов |
| `EDUCATION_GRAPH_ENABLED` | unset = off | фичефлаг эндпоинтов графа (`/api/education/graph`, `/courses/:slug/graph` → 404 без флага) |

## Эксплуатация

**Прогоны:**
- KG-джоба: инкрементальна по SHA-256 `text_hash` — повторный запуск дешёвый
  (пересчёт только изменившихся уроков). Ручной запуск:
  `docker exec pulse-backend node -e "require('/app/dist/services/education/knowledgeGraph').rebuildKnowledgeGraph().then(...)"`
  (лог смотреть отдельно, процесс долгий — не более одного одновременно, CronLock
  на cron-прогоне).
- Бэкфиллы — только ручные (таблица скриптов выше).

**Верификация после прогона:**
```sql
SELECT count(*) FROM lesson_embeddings;          -- = числу уроков published-курсов
SELECT count(*) FROM lesson_similarity;          -- рёбра уроков
SELECT round(sim::numeric,3), a.title, b.title
  FROM lesson_similarity ls
  JOIN course_lessons a ON a.id=ls.lesson_a
  JOIN course_lessons b ON b.id=ls.lesson_b
 ORDER BY sim DESC LIMIT 10;                      -- spot-check: пары должны быть осмысленными
```

**Типовые инциденты (хронология):**
- **2026-09-11:** таймаут 30 с рвал ночной бэкфилл → поднят до 600 с;
  битый Unicode гасил батчи HTTP 400 → `stripLoneSurrogates`.
- **2026-10-14 (вечер):** VDS поднят до 4 CPU, TEI постоянно на 2 ядрах
  (RAYON=2, cpus 2); mem 4500m → 5000m (cgroup-OOM warmup-спайка при
  RAYON=2, dmesg). E2E одиночного запроса: 244 с (холодный) → 7,2 с.
  Флаги `EDUCATION_GRAPH_ENABLED` / `EDUCATION_MATCH_ENABLED` включены
  (compose + `/opt/pulse/.env`), бэкфилл `courses.embedding` 8/8, первичный
  ретроскан мэтчинга пройден (строгий LLM-фильтр: 28 кандидатов → 1
  высококачественная связка).
- **2026-10-14:** undici `headersTimeout 300 с` гасил запросы к однопоточному
  TEI (`UND_ERR_HEADERS_TIMEOUT`) → клиент переведён на `node:http`;
  батч KG-джобы уменьшен 32 → 8 (у `embeddings.ts` лимит общий 32, KG шлёт
  по 8 — запас под очередь TEI). Сопутствующее: у существующих курсов
  `courses.embedding` был NULL (триггер появился позже импорта курсов) —
  лечится `scripts/backfill-course-embeddings.js`, без него `course_similarity`
  пустой по построению.

**Производительность TEI (ориентиры VDS 3 CPU, 2026-10-14):** 8 коротких
текстов — 60–300 с (очередь + инференс ~20–50 с), заголовки ответа — только
по завершении; `/health` под нагрузкой до 15–20 с. Ночью на пустой очереди —
заметно быстрее.
