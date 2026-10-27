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
- **Ресурсы VDS (состояние на 2026-10-14 → 27.10):** хост **4 CPU / 6 ГБ**
  (ресайз владельца 14.10.2026); контейнеру TEI: `RAYON_NUM_THREADS=1`,
  `cpus 1.5`, mem **4500m** — текущие значения из `docker-compose.yml`
  (коммит `d245639`) и с VPS совпадают. История: на 4500m при RAYON=2
  warmup-спайк candle (~4,55 ГБ) получал cgroup-OOM (dmesg 14.10), поэтому
  RAYON снесли до 1 (инференс однопоточный, ядро не отнимается у сайта),
  cpus оставили 1.5 — запас для 4 токенизатор-воркеров и HTTP-слоя (иначе
  /health отвечал 6–21 с и healthcheck мигал unhealthy). RAM: лимит 9G был
  ошибкой (выше физики хоста — хостовый OOM-killer убивал TEI каждые ~25 мин,
  global_oom в dmesg 14.10); 4500m = warmup ~4.1 ГБ влезает, остальное
  контейнеры + ОС в 6 ГБ. Батч бэкфилла обязан быть ≤ 8 (батч 32 раздувает
  RSS candle выше лимита — `5eb995a`).
  Замер одиночного запроса 7,2 с — на 2 ядрах (RAYON=2) до перехода на 1;
  флаги TEI: `--max-client-batch-size 32 --max-batch-tokens 4096
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

Поиск в ленте — гибридный (ТЗ-161, 2026-10-16): точная ветка ILIKE идёт
первыми (word-AND по словам запроса, ТЗ-163 — порядок слов не важен, слова
≥2 символов, каждое в любом из 4 текстовых полей), семантика добивает до
`limit` кандидатами из HNSW-топ-50 без дат-фильтра, скор = косинус + буст
свежести (+0.10 ≤14 сут, +0.05 ≤90 сут). TEI недоступен → молчаливый
фолбэк exact-only (5 с). Ответ помечает `match_type`/`similarity`.
| Темы каскадов | Python-sidecar `topics-worker` (кластеризация, 03:40 МСК) + `services/cron.ts` (нейминг тем) | cron (ТЗ-115, `TOPICS_ENABLED` на VPS) | окно 14 дней, `embedding IS NOT NULL` | не считает заново — ест готовые векторы новостей |
| Мэтчинг курсов ↔ новости | `services/education/match.ts` | триггер при сохранении курса (`scheduleCourseReembedding`, при `EDUCATION_MATCH_ENABLED`) + ретроскан при publish и смене порога | `title + '\n' + description + '\n' + названия уроков`, обрезка 1000 | `courses.embedding` |
| Бэкфилл курсов | `scripts/backfill-course-embeddings.js` | ручной запуск (идемпотентен) | то же | `courses.embedding` |
| **Граф знаний уроков** | `services/education/knowledgeGraph.ts` | cron 04:50 MSK (`education-knowledge-graph`, CronLock) + ручной запуск | `title + ' ' + plain(text_content)` (HTML→plain), обрезка 1000 | `lesson_embeddings`, `lesson_similarity`, `course_similarity` |

Как из эмбеддингов курса получаются предложения новостей (RECALL → RANK →
запись) — отдельный раздел ниже, тонкости в `education.md` §ТЗ-103.

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
строк, полный перебор дешевле индекса. Индекс для `news` закреплён
файлом-стражем `news_embedding_hnsw.sql` (ТЗ-161 задача 1): на проде no-op,
на новых окружениях создаётся вручную через `psql -f`. После бэкфилла —
одноразовый `ANALYZE news` (задача 2; ночной cron поддерживает дальше).

## Мэтчинг курсов ↔ новости: как определяются предложения

Контур: `services/education/match.ts` (фичефлаг `EDUCATION_MATCH_ENABLED`),
таблица `course_match_suggestions`, решения attach/dismiss принимает редактор
в админке (таба «Новости» редактора курса). Текст для вектора курса —
`title + '\n' + description + '\n' + названия уроков` (обрезка 1000); пересчёт
вектора — при publish, смене title/description, CRUD уроков (`scheduleCourseReembedding`,
асинхронно, без LLM-расходов на сам вектор).

**Кандидат (RECALL)** — пара курс↔новость попадает в RANK, если совпал хотя
бы один сигнал:
- общие теги (`course_tags` ∩ `news.matched_tags`),
- новость в топ-10 по косинусу `courses.embedding <=> news.embedding` (PG).

**Запись в `course_match_suggestions` (после RANK)** — пара сохраняется,
если выполнено ЛЮБОЕ из трёх (ТЗ-103 + ТЗ-177):
1. **LLM-ранкер:** score ≥ 0.5. Кими оценивает батчи по 8 пар, JSON-вердикты
   `{score, reason}`, fail-closed, общий суточный лимит. Выключатель —
   настройка `match_llm_enabled` (вкл/выкл в админке, таб «Образование»,
   ТЗ-172): при выключенном ранкере LLM не дёргается вообще, пары идут по
   путям 2–3 (score NULL).
2. **Тег-матч:** есть общие теги (reason «общий тег: X»).
3. **Порог косинуса курса (ТЗ-177):** `courses.embedding_threshold` не NULL и
   `sim >= порог`. Порог задаёт редактор в админке (0.30–0.95, пусто — выкл),
   миграция `lms_v9_course_threshold.sql`. Пары без LLM: `score NULL`,
   source `'embedding'`, reason «косинус X ≥ порога Y». Подбор порога: типичный
   косинус курс↔новость 0.6–0.75; 0.9 недостижимо и даёт пустую выдачу.

Поле `source`: `'tag'` | `'embedding'` | `'both'` (тег + есть эмбеддинги).
`ON CONFLICT (course_id, news_id) DO NOTHING` — повторный мэтчинг не
перетирает решение редактора.

**Когда гоняется мэтчинг:**
- новость прошла пайплайн (хук `matchNewsToCourses` в `newsProcessor`,
  асинхронно, ошибки не валят парсинг);
- курс опубликован → ретроскан ≤200 новостей за 14 дней;
- **сменён порог курса → `retroscanCourse`** (триггерится из PUT
  `/courses/:id`, асинхронно; UI перечитывает список сразу и через 30 с);
- cron-страховка `matchUnprocessedNews()` ежечасно (новости за 2 ч без строк
  в suggestions).

Верификация на проде (курс с порогом 0.6, 2026-10-16): ретроскан дал 7/7
предложений source='embedding', sim 0.606–0.656.

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
- **2026-10-14 (вечер):** VDS ресайз до 4 CPU / 6 ГБ; TEI: RAYON=2, cpus 2,
  mem 4500m → 5000m (cgroup-OOM warmup-спайка, dmesg), затем финальная
  конфигурация **RAYON=1, cpus 1.5, mem 4500m** (`d245639` + решение владельца:
  1 поток = 1 выделенное ядро, запас cpus для токенизаторов) — актуально
  и на 27.10 (git == VPS, сверено). E2E одиночного запроса: 244 с (холодный)
  → 7,2 с (замер на RAYON=2 до финального перехода).
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
- **2026-10-27 (наблюдение → закрыто):** при RAYON=1 одиночный embed в TEI
  занимает 4–6 с (inference ~4,2 с + очередь), а реалтайм-семантика поиска
  (`/api/news/search`) была ограничена `SEMANTIC_SEARCH_TIMEOUT_MS = 5000`
  (`news.ts`) → под нагрузкой семантическая ветка уходила в молчаливый
  exact-only фолбэк (5 фолбэков/24ч, все таймауты; спайк очереди TEI:
  41 с queue у одного запроса). Трейд-off лимитов 14.10, а не регрессия.
  **Решение владельца 27.10:** таймаут поднят до **15 с**, env-overridable
  (`8b5b864`). Проверка: sparse-запрос «волатильность имплицитная»
  (лексики 0) → 8,5 с, 20 семантических результатов с similarity.
  Замечание: релевантность верхних семантических результатов для редких
  русских запросов у модели 0.6B умеренная (sim ~0.6, англоязычные хиты) —
  порога отсечения нет по ТЗ-161, крутить при желании отдельно.
  Следить: `docker logs pulse-backend | grep 'Semantic search unavailable'`.
- **2026-10-16:** ТЗ-161/163 — гибридный поиск в ленте (word-AND exact +
  семантика с бустом свежести, `match_type`/`similarity` в ответе) и
  файл-страж HNSW + `ANALYZE news` после бэкфилла. ТЗ-177 — порог косинуса
  курса (`courses.embedding_threshold`, миграция `lms_v9`): третий путь
  записи предложений без LLM, ретроскан при смене порога; фикс потери порога
  в UI при переключении табы (синк на уровень редактора + поле добавлено в
  карточку курса админки). ТЗ-172 — выключатель LLM-ранкера в админке
  (`match_llm_enabled`).
- **2026-10-27 (блокер REVIEW-TZ-161_163):** word-AND в lexical-ветке триммил
  края слов через `\W` — а `\w` в JS строго ASCII, поэтому `\W` матчил
  кириллицу и съедал русские слова целиком («санкции трампа» → пустой
  searchWords → молчаливый фолбэк на подстроку). Фикс: `[^\p{L}\p{N}]`
  (`986429f`). Проверка на проде: «санкции трампа» 2 → 45 результатов,
  перестановки находятся; «AI нефть» — AND семантика 50/50. Тем же коммитом
  ниты: `hasMore` по лексическому счётчику (семант. докиды не обрывают
  пагинацию), CONCURRENTLY в HNSW-страже, трим пунктуации в `highlight.tsx`.

**Производительность TEI (ориентиры VDS 4 CPU / RAYON=1, 2026-10-27):** одиночный
embed — 4–6 с (inference ~4,2 с); 8 коротких текстов — 60–300 с (очередь +
инференс ~20–50 с), заголовки ответа — только по завершении; `/health` под
нагрузкой до 15–20 с. Ночью на пустой очереди — заметно быстрее.
