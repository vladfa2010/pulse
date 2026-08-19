# Портфели брокеров и облако рекомендуемых тегов

> V1 фича: подключение брокерских счетов через API-ключи, автоматическая синхронизация позиций, сводный/поброкерный анализ портфеля и подписка на новости по бумагам из облака тегов.

## Возможности V1

- Добавление API-ключей брокеров: **Финам**, **БКС**, **Инсайд брокер** (заглушка).
- Автоматическая синхронизация позиций каждые 15 минут (MSK).
- Просмотр портфеля в режимах **по брокерам** и **консолидированно**.
- Расчёт текущей рыночной стоимости, PnL и веса позиций через маркет-провайдер Finam (см. [`market-data.md`](./market-data.md)).
- **Облако рекомендуемых тегов** — подписка на новости по бумагам из портфеля с учётом лимита тегов тарифа.

---

## Архитектура

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend                                                    │
│  /portfolio          → PortfolioPage.tsx                     │
│  /profile (brokers)  → account/BrokersTab.tsx                │
│  RecommendedTagsCloud → useRecommendedTags()                   │
└──────────────────────────┬───────────────────────────────────┘
                           │ REST / JWT
┌──────────────────────────▼───────────────────────────────────┐
│  Backend                                                     │
│  /api/broker-keys    → brokerKeyService.ts                    │
│  /api/portfolio      → brokerPortfolioService.ts              │
│  portfolioSync/worker.ts → cron каждые 15 минут               │
│  brokerApi/          → finamAdapter.ts, bcsAdapter.ts,         │
│                        insideAdapter.ts                       │
│  services/crypto.ts  → AES-256-GCM для API-токенов            │
│  services/market/    → getCurrentPricesBatch (Finam)          │
└──────────────────────────────────────────────────────────────┘
```

---

## Схема данных

### `broker_keys`

Хранит зашифрованные API-токены брокеров.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | UUID | PK |
| `user_id` | UUID FK → users | Владелец |
| `broker` | TEXT | `inside` / `finam` / `bcs` |
| `label` | TEXT | Пользовательская метка |
| `token_encrypted` | TEXT | AES-256-GCM, формат `iv:authTag:ciphertext` |
| `token_tail` | TEXT | Последние 4 символа открытого токена |
| `status` | TEXT | `ok` / `error` |
| `last_error` | TEXT | Последняя ошибка синхронизации |
| `consecutive_failures` | INTEGER | Счётчик неудач |
| `last_synced_at` | TIMESTAMPTZ | Время успешной синхронизации |

### `broker_portfolios`

Портфель, привязанный к одному ключу брокера (V1).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | UUID | PK |
| `user_id` | UUID FK → users | Владелец |
| `broker` | TEXT | Брокер |
| `name` | TEXT | Название портфеля |
| `source` | TEXT | `api` / `manual` / `import` (V1 только `api`) |
| `broker_key_id` | UUID FK → broker_keys | Ключ для синхронизации |
| `last_synced_at` | TIMESTAMPTZ | Время последней синхронизации |

### `broker_positions`

Позиции внутри портфеля.

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | UUID | PK |
| `broker_portfolio_id` | UUID FK → broker_portfolios | Портфель |
| `ticker` | TEXT | Тикер бумаги |
| `exchange` | TEXT | Биржа (MOEX / NASDAQ / NYSE / ...) |
| `company_name` | TEXT | Название компании |
| `quantity` | NUMERIC | Количество |
| `avg_price` | NUMERIC | Средняя цена покупки (может быть null) |
| `currency` | TEXT | Валюта позиции |
| `external_id` | TEXT | Внешний ID бумаги в брокере |
| `source` | TEXT | `api` / `manual` / `import` |

### `securities`

Кэш названий бумаг из API брокера (Finam).

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | UUID | PK |
| `ticker` | TEXT | Тикер / ISIN |
| `exchange` | TEXT | Биржа |
| `short_name` | TEXT | Название (NULL при негативном кэше) |
| `isin` | TEXT | ISIN |
| `sec_type` | TEXT | `EQUITIES`, `BONDS` и т.д. |
| `source` | TEXT | Источник (default `finam`) |
| `resolved_at` | TIMESTAMPTZ | Время кэширования |

---

## API Endpoints

### Broker keys

| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/broker-keys` | Список ключей |
| POST | `/api/broker-keys` | Создать ключ (с проверкой в брокере) |
| PATCH | `/api/broker-keys/:id` | Обновить ключ/метку |
| DELETE | `/api/broker-keys/:id` | Удалить ключ вместе с привязанным портфелем и позициями |
| POST | `/api/broker-keys/:id/test` | Проверить ключ |

**Лимит:** `brokerKeyLimiter` — 10 запросов/мин на пользователя/IP.

### Portfolio

| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/portfolio` | Список портфелей |
| POST | `/api/portfolio` | Создать портфель и сразу синхронизировать |
| PATCH | `/api/portfolio/:id` | Обновить портфель |
| DELETE | `/api/portfolio/:id` | Удалить портфель |
| GET | `/api/portfolio/:id/positions` | Позиции портфеля |
| POST | `/api/portfolio/:id/sync` | Ручная синхронизация |
| GET | `/api/portfolio/summary?mode=by-broker\|consolidated` | Сводка с ценами и PnL |
| GET | `/api/portfolio/recommended-tags` | Облако рекомендуемых тегов + лимит |
| POST | `/api/portfolio/recommended-tags/subscribe` | Подписаться на тег по тикеру |

---

## Адаптеры брокеров

Все адаптеры реализуют единый интерфейс `BrokerAdapter`:

```ts
interface BrokerAdapter {
  broker: Broker;
  testKey(token: string): Promise<TestKeyResult>;
  getPositions(token: string): Promise<{ positions: BrokerPosition[]; newToken?: string }>;
}
```

### Финам

- `secret` → POST `/v1/sessions` → JWT (`token`, не `access_token`).
- JWT → POST `/v1/sessions/details` → `account_ids` (snake_case), `readonly`.
- GET `/v1/accounts/{account_id}` → positions.
- Поля ответа — **snake_case**: `average_price`, `current_price`, `daily_pnl`.
- Числа приходят в объектах: `quantity.value`, `average_price.value`.
- `average_price.value === "0.0"` интерпретируется как `NULL` (позиция зачислена без покупки).
- Символ: `SBER@MISX` (MOEX/RUB), `MDLN@XNGS` (NASDAQ/USD), `SECZ@XNYS` (NYSE/USD), `RU000A1053P7@MISX` (облигации).
- Названия бумаг (`companyName`) обогащаются через `GET /v1/assets/{symbol}?account_id={id}` и кэшируются в таблице `securities` (30 дней — позитив, 7 дней — негатив). Первичный источник имён — API брокера, не MOEX ISS.
- Невалидный/протухший токен возвращает **HTTP 500** `{ code: 2, message: "" }` → адаптер переводит в `broker_key_invalid`.
- Пропускает синхронизацию в техническое окно 05:00–06:15 МСК.

### БКС

- `refresh_token` → Keycloak → `access_token` + новый `refresh_token`.
- `GET /trade-api-bff-portfolio/api/v1/portfolio` → positions.
- Автоматически сохраняет новый `refresh_token` после синхронизации.
- Фильтрует только `term='T0'` и `type='depoLimit'` (остальное — деньги/внебиржевое).

### Инсайд брокер

Заглушка (stub). Возвращает `broker_unavailable` до появления REST-спецификации.

---

## Синхронизация

Cron-воркер `services/portfolioSync/worker.ts` запускается каждые 15 минут по московскому времени.

- Обрабатывает активные ключи со статусом `ok`.
- 5 параллельных воркеров с jitter для снижения нагрузки на API брокеров.
- При 3+ неудачах подряд ключ переводится в `error`.
- При `401` / `broker_key_invalid` ключ сразу переводится в `error`.
- Finam-адаптер пропускает окно планового техобслуживания.
- Ручная синхронизация: `POST /api/portfolio/:id/sync` — обновляет позиции по конкретному портфелю on-demand.

---

## Расчёт цен и PnL

`services/market/marketRouter.ts`:

- `getCurrentPrice(ticker)` — MOEX ISS, сначала текущие 1-минутные свечи, fallback на последнюю дневную свечу.
- `getCurrentPricesBatch(items)` — пакетный запрос с кэшем 60 сек и конкурентностью 10.

Сводка считает:
- `cost = quantity * avg_price` (null, если нет avg_price).
- `marketValue = quantity * currentPrice` (null, если нет цены).
- `pnl = marketValue - cost`.
- `weightPct = marketValue / totalMarketValue`.

---

## Облако рекомендуемых тегов

`GET /api/portfolio/recommended-tags` возвращает:

```json
{
  "tags": [
    { "ticker": "SBER", "exchange": "MOEX", "companyName": "Сбербанк", "suggestedTag": "SBER", "status": "available", "existingTagId": "...", "weightPct": 25.5 }
  ],
  "tagLimit": { "used": 7, "limit": 10 }
}
```

- `suggestedTag` — тикер бумаги **без символа `#`** (хэштег-логика в PULSE не используется).
- `exchange` — реальная биржа позиции (`MOEX`, `NASDAQ`, `NYSE` и т.д.), а не хардкод `MOEX`.
- `companyName` — название компании из `broker_positions.company_name` или кэша `securities`.

Статусы тега:
- `available` — можно подписаться.
- `subscribed` — уже подписан.
- `created-new` — тег создан и подписка оформлен.
- `limit-reached` — лимит тегов тарифа исчерпан.

Лимит берётся из `subscription_plans.tag_limit`. `used` — количество активных (не замороженных) подписок пользователя в таблице `portfolios`.

### Создание тега из облака

`POST /api/portfolio/recommended-tags/subscribe` (body: `{ ticker, exchange }`):

1. Ищет `company_name` позиции пользователя, затем в кэше `securities`, затем фолбэк на тикер.
2. `tag_id` формируется как `slugifyTagId(companyName)` — слаг на русском/английском, **не UUID**.
3. `tag_name` = название компании, либо тикер, если имя неизвестно.
4. `keywords` = `[ticker.toLowerCase(), companyName.toLowerCase()]`.
5. `enriched_data` = `{ ticker, exchange, companyName }` — нужен маркет-роутеру и матчингу новостей.
6. Сначала ищет существующий тег по `enriched_data->>'ticker' + exchange`, затем по `tag_id`, чтобы не дублировать.
7. Если тег уже существовал с именем-тикером (фолбэк), при подписке обновляет `tag_name` и `keywords` до реального названия компании; `tag_id` не меняется.
8. После создания/подписки запускает `backgroundEnrichTag()` — фоновое LLM-обогащение синонимами/сектором.
9. Если пользователь уже создал ручной тег с таким именем (`createUserTag` разрешает по имени/транслиту), подписка идёт на существующий тег, а его `enriched_data` дополняется `ticker/exchange/companyName`.

### Докачка имени при синхронизации

При каждом `applyPositionDiff` (ручная/автоматическая синхронизация) для каждой позиции с непустым `company_name` запускается `backfillTagFromPositionCompanyName()`:
- ищет теги по `enriched_data.ticker + exchange`;
- если `tag_name` равно тикеру, обновляет его до `company_name`;
- мёрджит `keywords`: добавляет `companyName.toLowerCase()`;
- обновляет `enriched_data.companyName`.

`tag_id` остаётся прежним, поэтому подписки `portfolios.tag_id` не ломаются.

### Утилиты

- `src/utils/slugifyTag.ts` — `slugifyTagId(name)`: нижний регистр, кириллица сохраняется, пробелы → `_`, максимум 50 символов.

---

## Безопасность

- API-токены брокеров хранятся только в зашифрованном виде.
- Шифрование: **AES-256-GCM**, формат `iv:authTag:ciphertext` (hex).
- Ключ шифрования: `ENCRYPTION_KEY` (64 hex-символа, 32 байта) из переменных окружения.
- При отсутствии ключа backend стартует, но добавление/синхронизация ключей брокеров возвращает ошибку.
- В `/health` отображается статус `ENCRYPTION_KEY` (`present`, `length`, `valid`).

---

## Окружение

Для работы фичи обязательно:

```env
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
```

Генерация ключа:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Ограничения V1 / Backlog

- Ручное добавление позиций (`source = 'manual'`) — в backlog.
- Импорт позиций из CSV/Excel (`source = 'import'`) — в backlog.
- Адаптер **Инсайд брокер** — заглушка, ждёт REST API.
- Цены только для **MOEX**. NASDAQ/NYSE — через Finnhub/другой адаптер в backlog.
- Только рублёвые/основные валютные позиции; валютный риск не учитывается.
