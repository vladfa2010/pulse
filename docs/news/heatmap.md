# Тепловая карта новостной активности (News Heatmap)

> Блок «Новостная активность» (`/activity-map`) и мини-блок «Пульс рынка» на главной. Read-only контур над существующим пайплайном новостей.

---

## Содержание

- [Архитектура](#архитектура)
- [Таблицы](#таблицы)
- [API](#api)
- [Freeze-крон](#freeze-крон)
- [Backfill](#backfill)
- [Свежесть портфеля](#свежесть-портфеля)
- [Кэширование](#кэширование)
- [Сценарии отказа](#сценарии-отказа)
- [Проверка после установки](#проверка-после-установки)
- [Регистр изменений](#регистр-изменений)

---

## Архитектура

Принцип **read-only**: существующий пайплайн новостей (`rssFetcher.ts`, `newsProcessor.ts`, cron ingest) не изменяется. Агрегатные таблицы наполняются только двумя механизмами:

1. **Backfill** — разовый скрипт, пересчитывает историю за 12 месяцев из `news`.
2. **Freeze** — ежедневный cron в 00:05 МСК, пересчитывает скользящее окно последних 3 дней.

«Сегодня» всегда считается живьём из `news` одним SELECT'ом. Прошлые дни берутся из готовых агрегатов. Если freeze отставал или таблиц ещё нет — работает **gap-fallback**: недостающие дни досчитываются из `news`, а `meta.frozen_through` показывает реальную границу заморозки.

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   news      │────▶│  backfill script │────▶│ news_tag_daily      │
│  (source)   │     │  (one-off)       │     │ user_portfolio_daily│
└─────────────┘     └──────────────────┘     │ news_all_daily      │
       │                                     └─────────────────────┘
       │                                               ▲
       │                                               │ freeze cron
       ▼                                               │
«сегодня» и gap-fallback ──────────────────────────────┘
```

### Файлы

| Файл | Назначение |
|------|------------|
| `src/services/heatmap/utils.ts` | Константы, типы, хелперы дат, квантили, `portfolioKey()` |
| `src/services/heatmapDaily.ts` | Freeze, gap-fallback, live today, portfolio freshness, mini-grids |
| `src/routes/newsHeatmap.ts` | API endpoints `/api/news_heatmap` и `/api/news_heatmap/candles` |
| `src/scripts/backfillNewsHeatmap.ts` | Разовый backfill за 12 месяцев |
| `src/services/market/finamMarketAdapter.ts` | Недельные свечи (`TIME_FRAME_W`) |
| `src/services/market/marketRouter.ts` | Провайдер-слой для свечей |
| `src/migrations/news_heatmap_v1.sql` | SQL-схема (также продублирована в boot-миграциях `src/index.ts`) |
| `src/services/cron.ts` | Регистрация freeze-крона на 00:05 МСК — `startHeatmapFreezeCron()` (TZ-49) |

---

## Таблицы

### `news_tag_daily`

```sql
CREATE TABLE IF NOT EXISTS news_tag_daily (
  tag_id    TEXT NOT NULL,
  day_msk   DATE NOT NULL,
  stories   INT NOT NULL DEFAULT 0,
  pos       INT NOT NULL DEFAULT 0,
  neg       INT NOT NULL DEFAULT 0,
  resonance INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tag_id, day_msk)
);
```

По тегу за день: количество новостей, positive/negative, сумма `source_count`.

### `user_portfolio_daily`

```sql
CREATE TABLE IF NOT EXISTS user_portfolio_daily (
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day_msk   DATE NOT NULL,
  stories   INT NOT NULL DEFAULT 0,
  pos       INT NOT NULL DEFAULT 0,
  neg       INT NOT NULL DEFAULT 0,
  resonance INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day_msk)
);
```

По пользователю за день. Новость с несколькими тегами портфеля считается **один раз** (`COUNT(DISTINCT n.id)`).

### `user_portfolio_daily_meta`

```sql
CREATE TABLE IF NOT EXISTS user_portfolio_daily_meta (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tags_hash  TEXT NOT NULL,
  rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Хеш состава портфеля (`portfolioKey()`) — SHA-256 от `tag_id` отсортированных и склеенных через `|`, обрезан до 16 символов. Если хеш не совпадает с текущим портфелем → ленивый rebuild.

### `news_all_daily`

```sql
CREATE TABLE IF NOT EXISTS news_all_daily (
  day_msk   DATE PRIMARY KEY,
  stories   INT NOT NULL DEFAULT 0,
  pos       INT NOT NULL DEFAULT 0,
  neg       INT NOT NULL DEFAULT 0,
  resonance INT NOT NULL DEFAULT 0
);
```

Агрегат по всем новостям с `cardinality(matched_tags) > 0`. Используется в публичном мини-блоке «Пульс рынка».

---

## API

### `GET /api/news_heatmap`

Карта за год / дайджест дня / почасовая сетка.

**Query-параметры:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `scope` | `all` \| `portfolio` \| `tag` | Обязательный. `all` — публичен только при `scale=year`. |
| `scale` | `year` \| `day` \| `day_hours` | По умолчанию `year`. |
| `tag_id` | string | Обязателен при `scope=tag`. |
| `date` | `YYYY-MM-DD` | Обязателен при `scale=day`. |

**Авторизация:**

- `scope=all&scale=year` — публичный (для мини-блока на главной).
- Все остальные комбинации — требуют Bearer-токен.

**Response `scale=year`:**

```json
{
  "cells": [
    {
      "date": "2026-08-28",
      "stories": 12,
      "pos": 5,
      "neg": 2,
      "resonance": 18,
      "sentiment_sign": 1,
      "spike": false
    }
  ],
  "quantiles": [3, 7, 15],
  "instrument": {
    "ticker": "SBER",
    "mic": "MISX",
    "symbol": "SBER@MISX"
  },
  "meta": {
    "generated_at": "2026-09-02T00:00:00.000Z",
    "stale": false,
    "tz": "Europe/Moscow",
    "empty": false,
    "frozen_through": "2026-09-01"
  }
}
```

- `cells` — 371 день (53 недели × 7), непрерывный годовой окно.
- `quantiles` — P50/P75/P90 по ненулевым дням, для раскраски ячеек.
- `instrument` — только для `scope=tag`; `null`, если у тега нет привязанного тикера.
- `meta.frozen_through` — последний день, покрытый заморозкой (`YYYY-MM-DD`); `null`, если история полностью live.
- `meta.empty` — `true`, если нет ни одной новости за весь год.

**Response `scale=day`:**

```json
{
  "date": "2026-08-28",
  "stories": [
    {
      "id": "uuid",
      "title": "...",
      "summary": "...",
      "source": "...",
      "url": "...",
      "published_at": "...",
      "sentiment": "positive",
      "source_count": 2,
      "matched_tags": ["SBER"]
    }
  ],
  "meta": { "generated_at": "...", "stale": false, "tz": "Europe/Moscow" }
}
```

**Response `scale=day_hours`:**

```json
{
  "days": 14,
  "cells": [
    { "day": "2026-08-28", "hour": 14, "stories": 3 }
  ],
  "meta": { "generated_at": "...", "stale": false, "tz": "Europe/Moscow" }
}
```

### `GET /api/news_heatmap/candles`

Недельные свечи для верхнего графика.

**Query-параметры:**

| Параметр | Описание |
|----------|----------|
| `index=IMOEX` или `index=SPY` | Индексная свеча. SPY листингуется на NYSE Arca → MIC `ARCX`. |
| `tag_id=SBER` | Свеча по инструменту тега |

**Response:**

```json
{
  "ticker": "IMOEX",
  "exchange": "MISX",
  "symbol": "IMOEX@MISX",
  "provider": "finam",
  "weeks": 53,
  "full_dates": ["2025-09-01", "2025-09-08", ...],
  "ohlc": [[open, close, low, high], ...],
  "volumes": [123000, ...]
}
```

**Ошибки:**

- `400 index must be IMOEX or SPY` — неизвестный индекс.
- `404 no_instrument` — у тега нет привязанного тикера.

### `GET /api/news_heatmap/mini-grids`

Мини-сетки по списку тегов (используется в блоке «Плотность ваших тегов»).

**Query:** `tag_ids=SBER,AAPL,TCSG`

**Response:**

```json
{
  "grids": [
    {
      "tag_id": "SBER",
      "cells": [...],
      "quantiles": [1, 2, 5]
    }
  ]
}
```

---

## Freeze-крон

Регистрируется как отдельная экспортируемая функция `startHeatmapFreezeCron()` в `src/services/cron.ts`, вызов — в boot-секции `src/index.ts` рядом с `startDigestCron`/`startGlobalSummaryCron`:

```ts
export function startHeatmapFreezeCron(opts?: { isShuttingDown?: () => boolean }) {
  cron.schedule('5 0 * * *', async () => {
    if (opts?.isShuttingDown?.()) return;
    const acquired = await acquireCronLock('news_heatmap_freeze');
    if (!acquired) return;  // другой инстанс уже выполняет
    try {
      await freezeHeatmapRecentDays();
    } finally {
      await releaseCronLock('news_heatmap_freeze');
    }
  }, { timezone: 'Europe/Moscow' });
}
```

> **История (TZ-49):** изначально блок жил внутри `startCron()`. Когда RSS переехал в NewsSourceManager (`TZ_REMOVE_DUPLICATE_RSS_CRON`), `startCron()` закомментировали вместе с freeze — и freeze не запускался никогда: gap-fallback досчитывал всё большее окно живьём из `news`. Фикс TZ-49: freeze вынесен в отдельную функцию, вызывается из boot-секции; блок удалён из `startCron()`, чтобы при его гипотетическом включении не было двойного расписания.

**Что делает:**

1. Пересчитывает окно `сегодня−3 ≤ день < сегодня` (вчера + два предыдущих) для трёх таблиц.
2. Использует честный `COUNT`/`SUM` из `news`, не инкременты.
3. Upsert в агрегатные таблицы (`ON CONFLICT DO UPDATE` — идемпотентно).
4. Лог: `[NewsHeatmap] freeze: done tag=N portfolio=N all=N duration_ms=N`.

**Почему окно не включает «сегодня»:** «сегодня» всегда live; заморозка включала бы почти пустую половину дня и залипала бы до следующего крона.

**Доказательства запуска:** лог регистрации `[Cron] News heatmap freeze scheduled daily at 00:05 Europe/Moscow` при старте; после 00:05 МСК — логи `[CronLock] ✅/🔓 news_heatmap_freeze` и `[NewsHeatmap] freeze: done ...`. Строка в `cron_locks` существует только во время выполнения (10-минутный TTL, удаляется в `finally`) — искать её после завершения бессмысленно. Главный индикатор здоровья: `SELECT max(day_msk) FROM news_all_daily;` = вчерашний день по МСК.

---

## Backfill

Запуск:

```bash
npx ts-node --transpile-only src/scripts/backfillNewsHeatmap.ts
```

Скрипт:

- Заполняет `news_tag_daily`, `user_portfolio_daily`, `news_all_daily` за 12 месяцев.
- Идемпотентен (upsert по primary key).
- После загрузки строк обновляет `user_portfolio_daily_meta.tags_hash` через Node-функцию `portfolioKey()` (16-символьный SHA-256).

**После деплоя новой версии с правками хеша обязательно перезапустить backfill**, чтобы формат `tags_hash` совпал с `ensurePortfolioHistoryFresh`.

---

## Свежесть портфеля

Функция `ensurePortfolioHistoryFresh(userId, tags)` вызывается в роуте при `scope=portfolio&scale=year` **перед** чтением истории.

Логика:

1. Считает текущий хеш портфеля.
2. В PostgreSQL хэш читается из `user_portfolio_daily_meta` с `FOR UPDATE`, чтобы два параллельных запроса для одного пользователя не гнали rebuild одновременно.
3. При mismatch вся операция выполняется в одной транзакции:
   - `DELETE FROM user_portfolio_daily WHERE user_id = $1` (очистка старого состава).
   - Пересчёт за 12 месяцев из `news`.
   - Запись нового хеша и `rebuilt_at`.
   - `COMMIT`.
4. SQLite-режим (локальная разработка) остаётся последовательным автокоммитом, так как `pool.connect()` там недоступен.

Частота ограничена роут-кэшем: проверка не чаще одного раза в 5 минут на пользователя.

---

## Кэширование

В `src/services/heatmapDaily.ts` in-memory LRU-кэш:

| Ключ | TTL | Назначение |
|------|-----|------------|
| `all|year|` / `all|day|YYYY-MM-DD` | 5 мин | Публичный мини-блок и годовой all |
| `{userId}|{scope}|{tagId}|{tz}|{scale}|{date}` | 5 мин | Авторизованные запросы |

Заголовок `X-Cache: hit` / `miss`.

Свечи кэшируются на уровне `finamMarketAdapter.ts` (`weeklyCache`, TTL 15 мин).

---

## Сценарии отказа

### Агрегатные таблицы отсутствуют (42P01)

- `aggregateTablesExist()` возвращает `false`.
- `getYearCells` переключается в fully-live: весь год досчитывается из `news`.
- В логах один warn: `[NewsHeatmap] history: aggregate tables missing (42P01) — fully live mode`.

### Freeze не отработал несколько дней

- Gap-fallback автоматически досчитывает дни от `frozenThrough+1` до вчера.
- «Сегодня» всегда live.
- Карта остаётся корректной.

### Смена состава портфеля

- Следующий `scope=portfolio&scale=year` триггерит rebuild.
- Старые дни без новостей по новому составу обнуляются.

### Ошибка в history-запросе

- Любой сбой `sqlYearHistory` (например, `22007 invalid input syntax for type date`) не приводит к 500.
- `getYearCells` перехватывает исключение, пишет warn и продолжает в fully-live режиме: gap-fill досчитает год из `news`.
- «Сегодня» всё равно берётся из live-запроса.

---

## Проверка после установки

```bash
# 1. Годовая карта по портфелю / тегу (с токеном)
curl -H "Authorization: Bearer $TOKEN" \
  "https://pulse-api-bsov.onrender.com/api/news_heatmap?scope=portfolio&scale=year"

# 2. scope=all — публичный, без токена
curl "https://pulse-api-bsov.onrender.com/api/news_heatmap?scope=all&scale=year"

# 3. Гость не должен иметь доступ к day/hours
curl -i "https://pulse-api-bsov.onrender.com/api/news_heatmap?scope=all&scale=day&date=2026-09-01"
# → 401 Unauthorized

# 4. Недельные свечи
curl -H "Authorization: Bearer $TOKEN" \
  "https://pulse-api-bsov.onrender.com/api/news_heatmap/candles?index=IMOEX"

# 5. Backfill выполнен: строки за 12 мес, max = вчера или сегодня
psql $DATABASE_URL -c "SELECT COUNT(*), MIN(day_msk), MAX(day_msk) FROM news_tag_daily;"
psql $DATABASE_URL -c "SELECT COUNT(*), MAX(day_msk) FROM user_portfolio_daily;"
psql $DATABASE_URL -c "SELECT COUNT(*), MIN(day_msk), MAX(day_msk) FROM news_all_daily;"

# 6. Сверка агрегата с живым запросом
psql $DATABASE_URL -c "SELECT stories FROM news_tag_daily WHERE tag_id='SBER' AND day_msk='2026-08-15';"
# должно совпасть с:
# SELECT COUNT(*) FROM news WHERE (published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date = '2026-08-15'
#   AND matched_tags @> ARRAY['SBER'];

# 7. Freeze отрабатывает ежедневно: max(day_msk) = вчера по МСК и сдвигается сам
psql $DATABASE_URL -c "SELECT max(day_msk) FROM news_all_daily;"
# Доказательства в логах: '[Cron] News heatmap freeze scheduled...' при старте,
# '[CronLock] ✅/🔓 news_heatmap_freeze' + '[NewsHeatmap] freeze: done ...' после 00:05 МСК.
# cron_locks строка живёт только во время выполнения (TTL 10 мин, удаляется в finally).

# 8. Portfolio hash format (16 символов)
psql $DATABASE_URL -c "SELECT length(tags_hash), tags_hash FROM user_portfolio_daily_meta LIMIT 1;"
```

---

## Регистр изменений

| Дата | Версия | Изменение |
|------|--------|-----------|
| 2026-09-01 | v1.0 | Базовая реализация ТЗ 11.11: роуты, freeze, backfill, frontend. |
| 2026-09-02 | v1.1 | Правки по ревью: `to_char(day_msk)` для PG, freeze не захватывает «сегодня», gap-fallback, fully-live при 42P01, portfolio freshness, унификация хеша в Node, `meta.empty`, ограничение публичного `scope=all` годовым масштабом. |
| 2026-09-02 | v1.2 | Hotfix 22007: корректные скобки `(AT TIME ZONE tz)::date` в `sqlYearHistory`, fallback на fully-live при любом сбое history-запроса. |
| 2026-09-02 | v1.3 | Hotfix day digest: параметры PG для `scale=day` и `scale=day_hours` приведены в соответствие плейсхолдерам SQL; `tz` больше не передаётся как значение параметра. |
| 2026-09-02 | v1.4 | `ensurePortfolioHistoryFresh` обёрнута в транзакцию с `SELECT ... FOR UPDATE` по хешу портфеля; SQLite-путь оставлен автокоммитным. |
| 2026-09-03 | v1.5 | TZ-49: freeze-крон вынесен из отключённого `startCron()` в `startHeatmapFreezeCron()`, регистрация в boot-секции `index.ts` с guard `isShuttingDown`. До этого freeze не запускался никогда. Правки документации: реальная реализация в разделе «Freeze-крон», корректная проверка вместо несуществующей записи в `cron_log`. |
