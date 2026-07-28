# PULSE — Admin: карточка тега (TagDetailModal)

> Дата: 2026-07-28
> Файл: `pulse-frontend/src/pages/admin/TagDetailModal.tsx`
> Компонент таймлайна: `pulse-frontend/src/components/admin/TagMarketTimeline.tsx`
> Бэкенд: `pulse-backend/src/routes/market.ts`, `pulse-backend/src/routes/tagMarket.ts`, `pulse-backend/src/services/market/`
> Статус: ✅ Market Timeline (MOEX + новости) работает в проде

---

## 1. Назначение

Админская карточка тега открывается из списка тегов (`TagsTab.tsx`) и показывает:

- Полную информацию о теге (название, тип, keywords, верификация, enriched-поля).
- Inline-редактирование полей через `EditableCard`.
- График активности новостей за 30 дней (из `daily_stats` в `GET /admin/tags/:tagId`).
- **Market Timeline** — дневные свечи MOEX по тикеру тега + гистограмма количества новостей по дням.
- По клику на день — интрадей 5-мин и список новостей за этот день.
- Список недавних новостей и подписчиков.
- Управление обогащением, сканированием keyword-matches и удалением тега.

---

## 2. Структура карточки

```
TagDetailModal
├── Header (название, тикер, verified, тип)
├── Editable fields
│   ├── tag_type, tag_name, keywords
│   ├── websites, wikipedia_url, country
│   ├── geo_countries, geo_regions, geo_cities
│   ├── isin, description, exchange
│   ├── sectors, trends, related_tags
│   └── synonyms_ru, synonyms_en
├── Activity Chart (30 дней новостей)
├── Market Timeline (NEW)
│   ├── MOEX daily candlestick
│   ├── News count bar chart
│   └── Click on day → intraday 5-min + articles
├── Recent Articles
├── Subscribers
└── Delete Tag
```

---

## 3. API endpoints

### 3.1 Детали тега

```
GET /admin/tags/:tagId
```

Возвращает `TagDetailResponse`:

- `tag` — поля тега + enriched_data.
- `daily_stats` — статистика новостей по дням (MSK, 30 дней).
- `recent_articles` — последние 20 новостей.
- `subscribers` / `subscriber_count` — подписчики тега.

### 3.2 Market Timeline

```
GET /admin/market/candles_daily?provider=MOEX&ticker=SBER&days=90
GET /admin/market/candles_intraday?provider=MOEX&ticker=SBER&date=2026-07-28
GET /admin/tags/:tagId/news-daily
GET /admin/tags/:tagId/articles-by-day?date=2026-07-28
```

Провайдер: `MOEX` ( Moscow Exchange ISS API).

### 3.3 Управление тегом

```
PUT    /admin/tags/:tagId        — inline editing
POST   /admin/tags/:tagId/enrich — LLM enrichment
POST   /admin/tags/:tagId/backfill-matches — keyword matching
POST   /admin/backfill           — slug backfill
DELETE /admin/tags/:tagId
```

---

## 4. Market Timeline — детали реализации

### 4.1 Компонент

`TagMarketTimeline.tsx` использует ECharts 6.x через lazy import:

```ts
const echarts = await import('echarts')
```

### 4.2 Гонка инициализации (fixed v3)

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

### 4.3 Формат данных candlestick (fixed v2)

Проблема: данные свечи содержали дату внутри элемента `[date, open, close, low, high]`, но ось X уже задана категориями. Свечи не получали координат.

Фикс:

- Ось X = объединение торговых дней (MOEX) и дней с новостями.
- Свечи: `[open, close, low, high]`; для неторговых дней — `'-'`.
- Бары новостей: число, выровненное по той же оси.
- Клик по бару: `params.name` (дата на категориальной оси).

### 4.4 Время (MSK)

- Новости группируются по дням в MSK (`Europe/Moscow`).
- SQLite-локально: `datetime(published_at, '+3 hours')`.
- PostgreSQL-прод: `(published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Moscow')::date`.

---

## 5. Критерии приёмки (регресс)

1. Открыть карточку SBER в инкогнито / с disabled cache — график отрисовывается.
2. Slow 3G — график отрисовывается после загрузки чанка echarts.
3. Клик по дню с новостями — появляется интрадей 5-мин + список новостей.
4. Клик по дню без новостей — видны только свечи.
5. Переход между тегами — без утечек инстансов (dispose на unmount).
6. `tsc --noEmit` — чисто.

---

## 6. Связанные файлы

- `pulse-frontend/src/pages/admin/TagDetailModal.tsx`
- `pulse-frontend/src/components/admin/TagMarketTimeline.tsx`
- `pulse-frontend/src/components/admin/EditableCard.tsx`
- `pulse-backend/src/index.ts` (GET /admin/tags/:tagId)
- `pulse-backend/src/routes/market.ts`
- `pulse-backend/src/routes/tagMarket.ts`
- `pulse-backend/src/services/market/marketRouter.ts`
- `pulse-backend/src/services/market/moexIssAdapter.ts`
- `pulse-backend/src/services/market/utils.ts`
- `pulse-backend/graphify-out/tag-card-usage-flow.mmd`

---

*Последние фиксы: `4a15359` (ECharts race v3), `933be69` (candlestick data format v2), `1d3a75e` (empty-candle warning).*