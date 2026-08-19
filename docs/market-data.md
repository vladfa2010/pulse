# Маркет-дата (свечи и котировки)

## Активные провайдеры

Единственный активный провайдер маркет-данных — **Finam Trade API** (`https://api.finam.ru`).
Он обслуживает все биржи, которые сейчас используются в тегах:

| Наша биржа | Finam MIC | Пример символа |
|------------|-----------|----------------|
| MOEX       | MISX      | `SBER@MISX`    |
| NASDAQ     | XNGS      | `MDLN@XNGS`    |
| NYSE       | XNYS      | `SECZ@XNYS`    |

Адаптер MOEX ISS (`src/services/market/moexIssAdapter.ts`) сохранён в репозитории, но
**вынесен из реестра провайдеров** на период отладки Finam. Чтобы вернуть его как резерв,
достаточно импортировать `moexIssAdapter` в `marketRouter.ts` и добавить в `PROVIDERS`.

## Переменные окружения

```bash
# Service-level key for market data (quotes/candles). NOT a per-user broker key.
FINAM_MARKET_SECRET=tapi_sk_...
```

- Ключ — сервисный, один на всё приложение.
- Используется только на бэкенде, на фронт не уходит.
- Ротация: заменить значение в Render Environment и перезапустить сервис.
- **Не путать** с per-user ключами Finam из `broker_keys`, которые нужны для портфеля.

## Спецификация Finam

- Авторизация: `POST /v1/sessions` с `{ secret }` → JWT `token`.
- Свечи: `GET /v1/instruments/{symbol}/bars`
  - `symbol` — `{ticker}@{MIC}`, URL-encoded.
  - `timeframe` — `TIME_FRAME_D` (дневки), `TIME_FRAME_M5` (5 минут).
  - `interval.start_time` / `interval.end_time` — ISO UTC.
- Последняя цена: `GET /v1/instruments/{symbol}/quotes/latest`.
- Справочник торговых инструментов: `GET /v1/assets` (**только по HTTP/2** — см. раздел ниже).
- Справочник бирж: `GET /v1/exchanges`.

## Проверенные ловушки

- Числа приходят в объектах `{ value: "276.54" }`.
- Объём может быть в экспоненциальной записи (`"2.7871357E7"`) — используем `parseFloat`, не `parseInt`.
- Несуществующий тикер с валидным MIC возвращает **HTTP 404** `{ code: 5 }` — нормализуем в `finam_not_found`.
- Пустой `bars: []` при HTTP 200 означает «тикер валиден, в интервале нет торгов» (выходные, приостановка) — это валидный ответ.
- Символ без `@MIC` → HTTP 400.
- Индексы (`IMOEX@MISX`) работают через тот же `/bars`.
- Ежедневное техобслуживание Finam: **05:00–06:15 МСК**. В это окно роуты отдают 503 с кодом `finam_maintenance`.
- Rate limit: ~200 запросов в минуту на метод.
- `GET /v1/assets` возвращает ~3.5 МБ (~16 800 инструментов) одним ответом. По HTTP/1.1 Finam отдаёт **детерминированный 500** `"Response not transcoded because the transcoder's internal buffer size exceeds the configured limit"`. Node.js клиенты (axios, fetch, https) говорят по HTTP/1.1, поэтому этот эндпоинт ходит через встроенный модуль `http2` Node.js. Остальные эндпоинты мелкие и остаются на axios/HTTP/1.1.

## Транспорт для `/v1/assets`

Функция `getAssets()` в `src/services/market/finamMarketAdapter.ts` использует **HTTP/2**:

```ts
import http2 from 'http2';
// ...
const client = http2.connect(FINAM_BASE_URL);
const req = client.request({ ':path': '/v1/assets', ':method': 'GET', authorization: jwt });
```

Причина: `GET /v1/assets` — единственный эндпоинт с большим ответом (~3.5 МБ). Finam по HTTP/1.1 отдаёт для него детерминированный 500, retry не помогает. HTTP/2 сжимает/фрагментирует ответ и Finam отдаёт 200 стабильно.

Пробовавшиеся и отвергнутые варианты:
- Retry на 500 — бесполезен (ошибка детерминированная).
- `/v1/assets/all` (пагинация) — работает по HTTP/1.1, но возвращает 135 000+ инструментов включая архивные/OTC; полный обход не завершается за разумное время и `MDLN` находился только на ~43-й странице.

## Добавление новой биржи

1. Найти MIC через `GET /v1/exchanges` (или документацию Finam).
2. Добавить строку в `EXCHANGE_TO_MIC` в `src/services/market/finamMarketAdapter.ts`.
3. Добавить биржу в `SUPPORTED_EXCHANGES` и `PROVIDERS` в `src/services/market/marketRouter.ts`.
4. Перезапустить деплой.

## Кэширование

Все кэши в памяти процесса:

| Данные | TTL |
|--------|-----|
| Дневные свечи | 15 мин |
| 5-минутные свечи сегодня | 1 мин |
| 5-минутные свечи прошлых дней | 1 год (неизменны) |
| Последняя цена | 1 мин |
| Пустой результат (нет тикера) | 15 мин |
| Справочник `/v1/assets` | 24 ч, ручная инвалидация через админ-роут |

## Контракт API

Админские эндпоинты:

- `GET /admin/market/candles_daily?ticker=SBER&exchange=MOEX&days=90`
- `GET /admin/market/candles_intraday?ticker=SBER&exchange=MOEX&date=2026-08-18`

Ответ содержит поле `provider: "finam"`. Исторический параметр `?provider=MOEX` в URL
воспринимается как алиас для `exchange`; реальный источник данных всегда в поле `provider`.

### Маппинг ошибок Finam → HTTP

| Код ошибки | HTTP | Текст |
|------------|------|-------|
| `finam_no_key` | 503 | Маркет-данные не настроены на сервере |
| `finam_auth_failed` | 503 | Ошибка авторизации в источнике данных |
| `finam_rate_limited` | 503 | Превышен лимит запросов |
| `finam_maintenance` | 503 | Техобслуживание 05:00–06:15 МСК |
| `finam_not_found` | 404 | Инструмент не найден |
| `finam_bad_exchange` | 400 | Биржа не поддерживается |
| остальные | 502 | Сообщение из ошибки |

## Отделение от brokerApi/finamAdapter.ts

Файлы `services/market/finamAuth.ts` и `services/brokerApi/finamAdapter.ts` сознательно
не объединены в общий модуль:

- Маркет-дата — сервисный ключ, публичные котировки, кэширование, другие сценарии отказа.
- Брокерский адаптер — per-user ключ, приватный портфель, обогащение названий бумаг, свои retry-политики.

## Smoke-тест

```bash
FINAM_MARKET_SECRET=tapi_sk_... npx ts-node --transpile-only src/scripts/testFinamMarket.ts
```
