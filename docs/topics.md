# Темы — бэкенд

Ночная HDBSCAN-кластеризация эмбеддингов новостей в «темы недели» — третий,
самый крупный уровень пирамиды поверх каскадов и сюжетов:

```
ТЕМА (недели–месяцы, HDBSCAN, LLM-нейминг)
  └── СЮЖЕТ (дни–недели, LLM-группировка каскадов, cron 1/час)
        └── КАСКАД (часы–сутки, cosine-склейка, реалтайм)
```

Тема — это не событие, а **фоновый предмет новостного поля** («Повышение ставки
ФРС», «Курс юаня»): скопление похожих новостей за окно в 14 дней, которое
каскады (события) только наполняют. Поэтому в UI тема помечена дисклеймером
«тема — фон, не лента событий».

Каскады и сюжеты описаны в `cascades.md`, методология порогов и ловушек —
в `Методология_поиска_новостных_каскадов_PULSE.md`. ТЗ: ТЗ-115
(HDBSCAN-python-sidecar). Темы живут **только на VPS**: на Render нет ни
таблиц, ни флагов — ручки отвечают `404 topics_disabled`.

## Компоненты

| Компонент | Где | Что делает |
|---|---|---|
| `topics-worker` | `topics_worker/main.py`, контейнер `pulse-topics-worker` (Python-sidecar, one-shot, `--profile worker`) | Кластеризация окна новостей → `topics` / `topic_items` / `topic_runs`. LLM не знает |
| `topics-naming` | `src/services/cron.ts` (`startTopicsNamingCron`, крон 04:10 МСК в процессе backend) | LLM-имена для безымянных тем последнего прогона (≤30 за запуск) |
| API | `src/routes/marketPublic.ts` | `GET /api/market/topics`, `GET /api/market/topic?id=` |

## Пайплайн прогона (03:40 МСК, хостовый cron VPS)

Команда запуска (каноническая): из `/opt/pulse`
`docker compose --profile worker run --rm topics-worker`. В `compose up -d`
воркер не входит (profile) — это осознанно: прогон раз в сутки.

Шаги (`topics_worker/main.py`):

1. **INSERT `topic_runs`** (status `running`, params из env) — отдельным
   коммитом; run_id — сквозной идентификатор прогона.
2. **Загрузка окна**: `news.published_at >= now() - 14 дней AND embedding IS
   NOT NULL` (это те же Qwen3-эмбеддинги, что у каскадов — ТЗ-91, TEI).
   Обязательный probe: shape `(N, 1024)` в лог, иначе RuntimeError.
3. **L2-ренормализация строк**: Qwen3 нормализован, но после кастов гарантируем
   единичные длины — тогда euclidean ≈ cosine для HDBSCAN.
4. **PCA 1024 → 50** (`random_state=0` — детерминизм, см. инцидент 2026-09-18).
   Сырые 1024-мерные вектора страдают от проклятия размерности; precomputed
   косинус-матрица 5k×5k — ещё ок, но рост N делает её неприемлемой.
5. **HDBSCAN**: `min_cluster_size=8`, `min_samples=3`, `metric='euclidean'`,
   `cluster_selection_method='leaf'` (default, env
   `TOPICS_CLUSTER_SELECTION_METHOD`). Шум = label −1, в таблицы не пишется,
   только считается `noise_count`. Здоровая картина: ~90–110 кластеров,
   шум ~3.2k из ~5k, максимальный кластер ≲ 150.
6. **Статистики по кластеру**: `news_count`, `span_days`, `sources_count`,
   `daily` (гистограмма по московским суткам), `keywords` (TF-IDF top-10 по
   `title_ru || ' ' || summary_ru`), `trend` (сумма последних 3 ПОЛНЫХ
   московских дней vs предыдущие 3, пороги ±25%: growing/stable/fading).
   Неполный текущий день в тренд не включается.
7. **Jaccard-склейка с прошлым прогоном**: overlap = |пересечение news_id| /
   |объединение|, порог 0.3. Сматченная тема наследует `prev_topic_id` +
   `name`/`summary` (`named=true` сразу, LLM не дёргается). Один старый
   кластер наследует только один новый (максимальный overlap).
8. **is_core**: `membership_probabilities_ >= 0.5` (soft-матрица в hdbscan ≥
   0.8.34 убрана из атрибутов fit; `probabilities_` — вероятность принадлежности
   назначенному кластеру, для диагонали эквивалентна).
9. **Запись ОДНОЙ транзакцией**: topics + topic_items батчами по 1000 +
   `UPDATE topic_runs SET status='done'`. Любое исключение → ROLLBACK +
   `status='error'` + non-zero exit (иначе упавший прогон висел бы `running`
   навсегда — баг был, исправлен в `5b159b3`). psycopg3: явный `conn.commit()`,
   `conn.transaction()` тут нельзя (SAVEPOINT-ловушка, см. комментарий в коде).

Падение воркера сайт не затрагивает: в `topic_runs` строка `error`, API
продолжает отдавать последний done-прогон.

## Нейминг (04:10 МСК, Node-cron в backend)

- Защита: `acquireCronLock('topics-naming')` + флаг шатдауна.
- Выборка: безымянные темы последнего done-прогона, `ORDER BY news_count DESC
  LIMIT 30` (`TOPICS_NAMING_LIMIT`) — разгребает накопленное после сбоев
  за несколько ночей.
- LLM: конвенции §9.1 методологии (как storyGrouper): `kimi-k2.6`, temperature
  из `VERIFIER_MODEL_TEMPERATURE`, thinking disabled для kimi-k*,
  `response_format: json_object`, таймаут 60 с, max_tokens 500.
- Промпт: top-8 заголовков (максимум 2 на источник) + TF-IDF-ключевые слова →
  строго `{"name": "2–5 слов", "summary": "одно предложение"}`. Запрещены
  generic-имена («Новости», «Экономика») — требуется конкретный предмет.
- **Fail-closed**: невалидный JSON / пустое name → тема остаётся unnamed.
- Запись: `UPDATE topics SET name, summary, named=true WHERE id=$1 AND
  named=false` — условие `named=false` страхует от гонки двух запусков.
- Стоимость: ≤1 вызов на НОВУЮ тему в сутки; сматченные через Jaccard темы
  наследуют имя бесплатно.
- `nameTopicWithLlm` экспортирован из `src/services/cron.ts` — можно дёрнуть
  разовой джобой внутри контейнера (`docker cp` скрипт + `docker exec … node`),
  если нейминг нужен не дожидаясь крона.

## Таблицы (`src/migrations/topics_v1.sql`, ТОЛЬКО VPS)

Миграция обёрнута в транзакцию (осознанное отклонение от стиля
`news_embeddings_v1.sql` — для 3 таблиц с FK атомарность важнее). На
Render-БД НЕ применять: там вкладка скрыта флагом, таблиц быть не должно.

| Таблица | Назначение | Ключевые поля |
|---|---|---|
| `topic_runs` | один прогон = одна строка | `status` running/done/error, `window_days`, `news_count`, `topics_found`, `noise_count`, `params` jsonb, `error`, `started_at`/`finished_at` |
| `topics` | тема одного прогона | `run_id → topic_runs` (CASCADE), `prev_topic_id → topics` (Jaccard-наследование), `label` (номер кластера HDBSCAN), `name`/`summary`/`named`, `keywords` jsonb, `news_count`, `span_days`, `sources_count`, `trend`, `daily` jsonb, `created_at` |
| `topic_items` | состав темы | PK (`topic_id`, `news_id`), оба FK ON DELETE CASCADE, `is_core` |

Индексы: `idx_topic_items_news(news_id)`, `idx_topics_run(run_id)`.
API читает всегда **последний done-прогон** (`ORDER BY finished_at DESC`).

## API (`src/routes/marketPublic.ts`)

Обе ручки публичные, read-only, кэш in-memory Map TTL 15 мин (темы меняются
раз в сутки — TTL как у `/stories`; заголовок `X-Cache: hit|miss`).
При `TOPICS_ENABLED !== 'true'` — `404 {error:'topics_disabled'}` БЕЗ обращения
к таблицам (на Render их нет).

- **GET `/api/market/topics`** — темы последнего done-прогона, сортировка
  `news_count DESC`. Payload: `run_at`, `window_days`, `topics_total`,
  `news_covered`, `noise_count`, `topics[]`. Unnamed-темы отдаются строго с
  `name=null, summary=null` (не пустая строка) — фронт показывает
  «Тема без названия (формируется)». Прогонов ещё не было → пустое состояние
  `topics_total: 0` (не ошибка).
- **GET `/api/market/topic?id=<uuid>`** — детальная карточка: поля темы +
  `news` (topic_items JOIN news, time DESC, лимит 200) + каскады в теме
  (JOIN cluster_items по news_id, overlap DESC, лимит 20) + сюжеты в теме
  (news_id → cluster_items → clusters.story_id, overlap DESC, лимит 20).
  Ошибки: 400 `id required`, 404 `topic_not_found`.

## Флаги и параметры

| Флаг / env | Где | Эффект |
|---|---|---|
| `TOPICS_ENABLED=true` | env backend (`/opt/pulse/.env` на VPS) | Гейтит крон нейминга и API: без флага ручки `404 topics_disabled`. На Render переменной нет |
| `VITE_TOPICS_ENABLED=true` | env сборки фронта, **инлайн** (`VITE_TOPICS_ENABLED=true npm run build`, шаг 3.2 DEPLOYMENT.md) | Вкладка «Темы» на странице «Каскады». Ни в одном `.env` файла нет — Render Static Site флаг не должен видеть. Без него вкладки нет, `?tab=topics` откатывается на «Каскады» |
| `TOPICS_WINDOW_DAYS` | env воркера | Окно прогона (default 14) |
| `TOPICS_MIN_CLUSTER_SIZE` | env воркера | HDBSCAN min_cluster_size (default 8) |
| `TOPICS_MIN_SAMPLES` | env воркера | HDBSCAN min_samples (default 3) |
| `TOPICS_PCA_DIMS` | env воркера | Число PCA-компонент (default 50) |
| `TOPICS_JACCARD_THRESHOLD` | env воркера | Порог наследования имени (default 0.3) |
| `TOPICS_CLUSTER_SELECTION_METHOD` | env воркера | `leaf` (default) — см. инцидент ниже |

Каскады/сюжеты и их API от этих флагов **не зависят** — работают всегда.

## Операции

```bash
ssh root@155.212.216.142 && cd /opt/pulse
crontab -l | grep topics-worker          # 03:40 МСК, запись в logs/topics-worker.log
docker compose --profile worker run --rm topics-worker   # ручной прогон (one-shot, безопасно)
tail -20 logs/topics-worker.log          #probe shape, PCA, HDBSCAN, Jaccard, завершение
docker exec pulse-postgres psql -U pulse_user -d pulse \
  -c "SELECT started_at, status, topics_found, noise_count, error FROM topic_runs ORDER BY started_at DESC LIMIT 5;"
docker compose build topics-worker       # после правок main.py — образ не пересобирается сам
```

Ручной прогон безопасен: пишет новую строку run, API переключится на него
после истечения кэша (≤15 мин). Ручной нейминг — разовой джобой через
экспортированный `nameTopicWithLlm` (см. «Нейминг»).

## Известные инциденты и диагностика

**2026-09-18 — мега-кластер (2 темы вместо ~95).** Прогон 03:40 выдал 2
кластера: один захватил 96% новостей (4905/5012). Данные и эмбеддинги были
здоровы (нормы = 1, 5018 уникальных векторов, типичная похожесть на месте) —
причина в бистабильности алгоритма:

- PCA по умолчанию — randomized SVD **без seed**: каждый прогон получал чуть
  другой базис (полярность зафиксирована: `random_state=0`).
- `cluster_selection_method='eom'` на наших данных имеет два устойчивых
  исхода: «~95 тем» и «мега-кластер». Эксперименты того дня: exact SVD → 2
  кластера; randomized seed 0 → 98; seed 1 → 2. Плотные «мосты» в иерархии
  EOM схлопывали почти всё в один кластер; `min_samples` 10/25 проблему не
  лечили (мега-кластер сохранялся).
- Фикс: `leaf` (выбирает гомогенные мелкие кластеры, мосты не тянет:
  103–107 кластеров, max ≈ 70, шум ≈ 3.3k — сопоставимо со здоровыми
  прогонами 16–17.09) + детерминированный PCA.

Симптомы повторения: в логе `HDBSCAN (leaf): кластеров N` с N ≤ 5 или
`max_size` кластера > 50% от clustered. Диагностика: лог прогона, затем
`SELECT started_at, topics_found, noise_count, status, params FROM topic_runs
ORDER BY started_at DESC LIMIT 5` и проверка эмбеддингов (нормы, уникальность,
случайные пары — скрипты-примеры в git-истории инцидента, коммит `1bfc1be`).

## Связи

- `cascades.md` — каскады и сюжеты (уровни ниже), общий `/api/market/*`.
- `Методология_поиска_новостных_каскадов_PULSE.md` — концепция пирамиды,
  конвенции LLM (§9.1), fail-closed (§9.3).
- `DEPLOYMENT.md` (~строки 590–615) — операционная часть: cron, compose,
  память воркера (`mem_limit: 2g`, `restart: "no"`).
- Фронтенд: `pulse-frontend/docs/cascades.md` (вкладка «Темы», фиче-флаги).
- ТЗ: `сделанные тз/ТЗ-115-темы-hdbscan-python-sidecar.md`.
