# PULSE — Admin: карточка тега (TagDetailModal)

> Дата: 2026-08-20
> Файл: `pulse-frontend/src/pages/admin/TagDetailModal.tsx`
> Компонент таймлайна: `pulse-frontend/src/components/admin/TagMarketTimeline.tsx`
> Поиск инструмента: `pulse-frontend/src/components/admin/InstrumentSearchInput.tsx`
> Бэкенд: `pulse-backend/src/routes/adminLegacy.ts` (`GET/PUT /admin/tags/:tagId`)
> Статус: ✅ Finam-роутинг, поиск инструмента, свободный тикер и Market Timeline работают в проде.
>
> См. также: публичный график реакции цены в карточке новости описан в `docs/market-data.md` (TZ-3 / TZ-3.1).

---

## 1. Назначение

Админская карточка тега открывается из списка тегов (`TagsTab.tsx`) и показывает:

- Полную информацию о теге (название, тип, keywords, верификация, enriched-поля).
- Inline-редактирование полей через `EditableCard`.
- **Биржевой инструмент** — поиск по справочнику Finam, ручной ввод тикера, поля `symbol`/`mic`/`exchange`/`isin`.
- График активности новостей за 30 дней (из `daily_stats` в `GET /admin/tags/:tagId`).
- **Market Timeline** — дневные свечи по тикеру тега через маркет-роутер (Finam primary) + гистограмма количества новостей по дням.
- По клику на день — интрадей 5-мин и список новостей за этот день.
- Список недавних новостей и подписчиков.
- Управление обогащением, сканированием keyword-matches и удалением тега.

---

## 2. Структура карточки

```
TagDetailModal
├── Header (название, verified, тип)
├── Editable fields
│   ├── tag_type
│   ├── Ticker ← InstrumentSearchInput + symbol/mic/exchange/isin
│   ├── websites, wikipedia_url, country
│   ├── geo_countries, geo_regions, geo_cities
│   ├── isin, description, exchange, mic
│   ├── sectors, trends, related_tags
│   └── synonyms_ru, synonyms_en
├── Activity Chart (30 дней новостей)
├── Market Timeline
│   ├── Daily candles via Finam market router
│   ├── News count bar chart
│   └── Click on day → intraday 5-min + articles
├── Recent Articles
├── Subscribers
└── Delete Tag
```

---

## 3. Биржевой инструмент (Ticker)

### 3.1 Поля

| Поле | Назначение | Источник |
|------|------------|----------|
| `ticker` | Биржевой тикер, как его видит пользователь. Может быть свободным текстом. | Ручной ввод или из подсказок Finam. |
| `symbol` | Каноничный идентификатор Finam: `TICKER@MIC` (например `SBER@MISX`). | Только при выборе из подсказок. |
| `mic` | Код биржи ISO 10383 в формате Finam (`MISX`, `XNGS`, `XNYS`). | Из `symbol` или ручное редактирование. |
| `exchange` | Человекочитаемый алиас (`MOEX`, `NASDAQ`, `NYSE`). | Алиас по `MIC_TO_ALIAS` (TZ-2.9). |
| `isin` | Международный код ценной бумаги. | Из подсказок Finam. |

### 3.2 Режимы редактирования

1. **Выбор из подсказок** — `InstrumentSearchInput` ищет по `/admin/market/search`, debounce 300 мс, минимум 2 символа. Справочник Finam прогревается при старте сервера (TZ-2.14), поэтому первый поиск отвечает сразу. При выборе сохраняется полный пакет `ticker/symbol/mic/exchange/isin`.
2. **Свободный текст** (TZ-2.12/TZ-2.13) — если админ вводит тикер вручную и не кликает по подсказке, при сохранении `symbol/mic/exchange/isin` сбрасываются в `null`. Бэкенд принимает такой тикер, но маркет-данные по нему не запрашиваются.
3. **Гибридная правка** — если после выбора инструмента текст изменился так, что он больше не совпадает с тикером из `symbol`, пакет сбрасывается автоматически (TZ-2.13).

### 3.3 Компонент `InstrumentSearchInput`

- Принимает `onPick(match)` и опциональный `onQueryChange(q)`.
- `onQueryChange` дублирует текущий текст инпута наружу, uppercase.
- При выборе варианта вызывает `onQueryChange(m.ticker)` и `onPick(m)`, чтобы родительский стейт не расходился с видимым текстом.
- Если подсказки пусты, показывает пояснение: можно сохранить как есть, но маркет-данных не будет.

---

## 4. API endpoints

### 4.1 Детали тега

```
GET /admin/tags/:tagId
```

Возвращает `TagDetailResponse`:

- `tag` — поля тега + enriched_data (включая `ticker`, `symbol`, `mic`, `exchange`, `isin`).
- `market` — блок для Market Timeline:
  ```ts
  {
    symbol: string | null;   // SBER@MISX или null
    mic: string | null;      // MISX / XNGS / ...
    source: 'saved' | 'auto' | 'none';
    ambiguous: boolean;
    candidates: { symbol: string; mic: string; name: string }[];
  }
  ```
- `daily_stats` — статистика новостей по дням (MSK, 30 дней).
- `recent_articles` — последние 20 новостей.
- `subscribers` / `subscriber_count` — подписчики тега.

### 4.2 Market Timeline

```
GET /admin/market/candles_daily?exchange=MOEX&ticker=SBER&days=90
GET /admin/market/candles_intraday?exchange=MOEX&ticker=SBER&date=2026-08-20
GET /admin/tags/:tagId/news-daily
GET /admin/tags/:tagId/articles-by-day?date=2026-08-20
```

- Параметр `exchange` понимает алиасы (`MOEX`, `NASDAQ`, `NYSE`) и любой валидный MIC из справочника Finam.
- Реальный источник данных — **Finam Trade API** (primary). Адаптер MOEX ISS сохранён в коде, но вынесен из реестра провайдеров.
- Если `symbol` сохранён в теге — `mic` берётся из него. Если только `ticker` — система резолвит тикер через `marketRouter.resolveTicker()` и берёт лучший матч (приоритет `MISX`).
- В админском таймлайне подписи оси и выбор дня по умолчанию используют `Europe/Moscow`. Публичный график реакции цены в карточке новости (TZ-3.1) использует таймзону конкретной биржи инструмента.

### 4.3 Управление тегом

```
PUT    /admin/tags/:tagId        — inline editing
POST   /admin/tags/:tagId/enrich — LLM enrichment
POST   /admin/tags/:tagId/backfill-matches — keyword matching
POST   /admin/backfill           — slug backfill
DELETE /admin/tags/:tagId
```

**PUT /admin/tags/:tagId** принимает поля из `TAG_UPDATE_RULES`, включая `ticker`, `symbol`, `mic`, `exchange`, `isin`.

- Если пришёл `ticker` без `symbol` — бэкенд сбрасывает `symbol/mic/exchange/isin` в `null` (TZ-2.12).
- Если пришёл `symbol` без `mic` — `mic` выводится из `symbol`.
- Если `symbol` и `mic` не совпадают — возвращается 400.
- Ответ содержит `updated_fields` и полный `tag` с актуальными `symbol`/`mic`/`exchange` (TZ-2.11).

---

## 5. Market Timeline — детали реализации

### 5.1 Компонент

`TagMarketTimeline.tsx` использует ECharts 6.x через lazy import:

```ts
const echarts = await import('echarts')
```

### 5.2 Гонка инициализации (fixed v3)

Проблема: данные от API могут прийти раньше, чем загрузится чанк echarts. Тогда `setOption` не вызывался и график оставался пустым.

Фикс:

```ts
const [chartReady, setChartReady] = useState(false)
// ...
chartInstanceRef.current = instance
setChartReady(true)
// ...
useEffect(() => { chart.setOption(option, true) }, [candles, dailyStats, chartReady])
```

### 5.3 Формат данных candlestick (fixed v2)

Проблема: данные свечи содержали дату внутри элемента `[date, open, close, low, high]`, но ось X уже задана категориями. Свечи не получали координат.

Фикс:

- Ось X = объединение торговых дней и дней с новостями.
- Свечи: `[open, close, low, high]`; для неторговых дней — `'-'`.
- Бары новостей: число, выровненное по той же оси.
- Клик по бару: `params.name` (дата на категориальной оси).

### 5.4 Время (MSK)

- Новости группируются по дням в MSK (`Europe/Moscow`).
- SQLite-локально: `datetime(published_at, '+3 hours')`.
- PostgreSQL-прод: `(published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date`.

### 5.5 Источник гистограммы новостей (fixed v4)

`GET /admin/tags/:tagId/news-daily` — источник гистограммы (МСК). `articles-by-day` возвращает последние 50 новостей за МСК-день.

### 5.6 mergeParams (fixed v5)

`tagMarketRoutes` смонтирован на `/admin/tags/:tagId` с `mergeParams: true`, иначе `req.params.tagId` терялся.

---

## 6. Критерии приёмки (регресс)

1. Открыть карточку SBER — график отрисовывается; данные приходят от Finam.
2. Slow 3G — график отрисовывается после загрузки чанка echarts.
3. Клик по дню с новостями — появляется интрадей 5-мин + список новостей.
4. Клик по дню без новостей — видны только свечи.
5. Переход между тегами — без утечек инстансов (dispose на unmount).
6. Редактировать Ticker → ввести `BTCUSDT` без подсказок → Save → `ticker=BTCUSDT`, остальные поля `null`.
7. Выбрать `SBER` из подсказок → Save → `symbol=SBER@MISX`, `mic=MISX`, `exchange=MOEX`.
8. `tsc --noEmit` — чисто.

---

## 7. Связанные файлы

- `pulse-frontend/src/pages/admin/TagDetailModal.tsx`
- `pulse-frontend/src/components/admin/TagMarketTimeline.tsx`
- `pulse-frontend/src/components/admin/InstrumentSearchInput.tsx`
- `pulse-frontend/src/components/admin/FinamStatusBadge.tsx`
- `pulse-frontend/src/components/admin/EditableCard.tsx`
- `pulse-backend/src/routes/adminLegacy.ts`
- `pulse-backend/src/routes/market.ts`
- `pulse-backend/src/routes/tagMarket.ts`
- `pulse-backend/src/services/market/marketRouter.ts`
- `pulse-backend/src/services/market/finamMarketAdapter.ts`
- `pulse-backend/src/services/market/exchangeTimezones.ts`
- `pulse-backend/graphify-out/tag-card-usage-flow.mmd`

---

*Последние изменения: TZ-3.1fix (iterative `zonedMidnightToUtc`), TZ-3.1 (exchange timezones), TZ-3 (news reaction chart), TZ-2.13 (free-text query wire), TZ-2.12 (free-text ticker), TZ-2.11 (symbol/mic in PUT response), TZ-2.10 (editable MIC), TZ-2.9 (exchange alias), TZ-2.7 (market block + instrument search), TZ-2.5 (provider→exchange).*

