# Техническое задание: Индекс настроения (Sentiment Index) — v3.0 (реализовано)

**Проект:** PULSE — анализ новостей для инвесторов  
**Фича:** Индекс настроения сообщества  
**Дата:** 2026-06-26  
**Статус:** MVP реализован и задеплоен в продакшен, VoteToast V2 (Liquid Glass + 3D confetti) в продакшене  
**Актуальные коммиты:** backend `bdf0896`, frontend `c18cd4d`  
**URL:** https://pulse-frontend-jt53.onrender.com/sentiment

> Этот документ описывает **реальную реализацию** MVP. Исторический черновик с полным дизайном фичи (бейджи, лидерборд, топ-тикеры и т.д.) сохранён в `TZ_Sentiment_Index_10.md`.

---

## 1. Что такое сущность «Индекс настроения»

**Индекс настроения** — это кумулятивная сумма голосов пользователей за текущие календарные сутки по московскому времени. Он не хранится как самостоятельная запись на каждый момент времени, а вычисляется на лету из таблицы голосов `sentiment_votes`.

- Каждый день в 00:00 МСК индекс сбрасывается в `0`.
- Пользователь голосует значением `-1`, `0` или `+1`.
- Индекс(t) = Σ vote_value за текущий день.
- График строится по временным меткам голосований + стартовой точке `00:00`.

Поверх индекса на графике накладывается линия индекса **IMOEX** МосБиржи для визуальной корреляции настроения сообщества и рынка.

---

## 2. Три состояния страницы

| Состояние | Условие | Что видит пользователь |
|-----------|---------|------------------------|
| **S0: Аноним** | Пользователь не залогинен | Левая половина графика видна, правая размыта. Призыв войти. |
| **S1: Активный доступ** | Залогинен и проголосовал ≤ 30 мин назад | Полный график, персональный таймер обратного отсчёта. |
| **S2: Ожидание голоса** | Залогинен и прошло > 30 мин с последнего голоса | График полностью скрыт оверлеем «Как вы оцениваете рынок?» (blind vote). |

Ключевой принцип: у каждого пользователя **своё персональное 30-минутное окно**. Один может быть в S1, другой в S2, а график один общий.

---

## 3. Хранение данных

### 3.1. Таблица голосов `sentiment_votes`

```sql
CREATE TABLE IF NOT EXISTS sentiment_votes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vote_value      SMALLINT NOT NULL CHECK (vote_value IN (-1, 0, 1)),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  tickers         JSONB DEFAULT '[]',
  index_at_vote   INT DEFAULT 0,
  imoex_at_vote   DECIMAL(10,2),
  imoex_after_1h  DECIMAL(10,2),
  index_after_2h  INT,
  check_status    VARCHAR(20) DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_sentiment_votes_user_time ON sentiment_votes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentiment_votes_created    ON sentiment_votes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sentiment_votes_check      ON sentiment_votes(check_status, created_at);
```

**Назначение полей:**
- `vote_value` — голос пользователя (`-1`, `0`, `+1`).
- `tickers` — тикеры из портфеля пользователя на момент голоса (для будущей аналитики).
- `index_at_vote` — значение индекса **до** голоса.
- `imoex_at_vote` / `imoex_after_1h` / `index_after_2h` / `check_status` — зарезервированы под отложенные проверки бейджей (в MVP не используются, но таблица готова).

### 3.2. Таблица персональных окон `sentiment_user_windows`

```sql
CREATE TABLE IF NOT EXISTS sentiment_user_windows (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_vote_at         TIMESTAMPTZ,
  next_vote_at         TIMESTAMPTZ,
  vote_count_today     INT DEFAULT 0,
  total_votes_all_time INT DEFAULT 0,
  sync_count           INT DEFAULT 0,
  total_votes_count    INT DEFAULT 0,
  streak_days          INT DEFAULT 0,
  max_streak_days      INT DEFAULT 0,
  favorite_sentiment   VARCHAR(10) DEFAULT NULL,
  impact_sum           INT DEFAULT 0,
  last_streak_date     DATE DEFAULT NULL,
  unlocked_badges      JSONB DEFAULT '[]',
  forecast_streak      INT DEFAULT 0,
  max_forecast_streak  INT DEFAULT 0,
  contrarian_count     INT DEFAULT 0,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sentiment_windows_next_vote ON sentiment_user_windows(next_vote_at);
```

**Назначение полей:**
- `last_vote_at` / `next_vote_at` — персональное окно голосования.
- `vote_count_today` — сбрасывается cron'ом в 00:00 МСК.
- `sync_count` / `total_votes_count` — для расчёта процента синхрона.
- `impact_sum` — суммарный вклад пользователя в индекс.
- `streak_days` / `max_streak_days` / `last_streak_date` — серия дней с голосованиями.
- Поля `unlocked_badges`, `forecast_streak`, `contrarian_count` — зарезервированы под бейджи (в MVP не используются).

### 3.3. Таблица кэша рыночных данных `sentiment_index_cache`

```sql
CREATE TABLE IF NOT EXISTS sentiment_index_cache (
  date             DATE PRIMARY KEY,
  current_value    INT DEFAULT 0,
  vote_count       INT DEFAULT 0,
  imoex_candles    JSONB DEFAULT '[]',
  imoex_updated_at TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);
```

Хранит:
- `imoex_candles` — массив 5-минутных свечей IMOEX за день.
- `imoex_updated_at` — время последнего обновления кэша.
- `current_value` / `vote_count` — зарезервированы, в MVP не используются.

---

## 4. Методы хранения и получения данных

### 4.1. Бэкенд-сервис `sentimentIndex.ts`

Файл: `pulse-backend/src/services/sentimentIndex.ts`

| Функция | Назначение |
|---------|------------|
| `getCurrentIndex(date)` | Считает `SUM(vote_value)` за текущий день по МСК. |
| `getIndexHistory(date)` | Возвращает стартовую точку `00:00` + точку после каждого голоса. |
| `getVotesCountToday()` | Количество голосов за сегодня. |
| `getUserWindow(userId)` | Получает/создаёт запись `sentiment_user_windows`. |
| `canVote(windowRow)` | Проверяет, истёк ли `next_vote_at`. |
| `secondsUntilNextVote(windowRow)` | Оставшиеся секунды до следующего голоса. |
| `recordVote(userId, value)` | Записывает голос, обновляет окно, пересчитывает индекс, возвращает `newIndex`, `nextVoteAt`, `sync`. |
| `getCommunityMetrics()` | Метрики сообщества: онлайн, голоса за день, распределение за час. |
| `getUserVoteHistory(userId, limit)` | История голосов пользователя. |
| `refreshImoexCache(date)` | Запрашивает свечи IMOEX и сохраняет в кэш. |
| `getImoexData(now)` | Возвращает текущее значение + свечи IMOEX из кэша (с обновлением при необходимости). |
| `resetDailyWindows()` | Сброс `vote_count_today` и пересчёт `streak_days` в 00:00 МСК. |

### 4.2. Адаптер рыночных данных `imoexAdapter.ts`

Файл: `pulse-backend/src/services/imoexAdapter.ts`

Источник: бесплатный **MOEX ISS API**, без авторизации.

```ts
const BASE_URL = 'https://iss.moex.com/iss/engines/stock/markets/index/boards/SNDX/securities/IMOEX/candles.json';
```

Логика получения данных:
1. Запрашиваем 1-минутные свечи IMOEX за текущий день по МСК (пагинация по 500 свечей за запрос).
2. Агрегируем 1-минутные свечи в 5-минутные (OHLC) функцией `aggregateTo5min()`.
3. Заполняем пропуски (неторговое время) последним `close` — получаем `flat line` функцией `extendWithFlatLine()`.
4. Итоговая функция `getImoex5minForDay(date)` возвращает 288 точек (24 часа × 12 пятиминуток).

### 4.3. API endpoints

Файл: `pulse-backend/src/routes/sentiment.ts`

#### `GET /api/sentiment/index` (публичный)

Возвращает текущий индекс, историю для графика и свечи IMOEX.

```json
{
  "currentValue": -1,
  "history": [
    { "time": "2026-06-23T21:00:00.000Z", "value": 0 },
    { "time": "2026-06-24T18:59:32.332Z", "value": 1 },
    { "time": "2026-06-24T19:36:44.884Z", "value": 0 },
    { "time": "2026-06-24T20:06:51.368Z", "value": -1 }
  ],
  "imoex": {
    "current": 302,
    "sessionActive": false,
    "sessionStart": "2026-06-24T07:00:00.000Z",
    "sessionEnd": "2026-06-24T16:00:00.000Z",
    "candles": [
      { "time": "2026-06-23T21:00:00.000Z", "open": 307.31, "high": 307.31, "low": 307.31, "close": 307.31 },
      ...
    ]
  },
  "updatedAt": "2026-06-24T20:32:25.225Z"
}
```

> Все временные метки приходят в **UTC**. Фронтенд конвертирует их в МСК при отображении.

#### `GET /api/sentiment/status` (требует авторизации)

Возвращает персональный статус, метрики и историю голосов.

```json
{
  "state": "active",
  "secondsUntilNextVote": 847,
  "currentValue": -1,
  "personal": {
    "totalVotes": 247,
    "todayVotes": 3,
    "syncRate": 68,
    "streakDays": 12,
    "impactSum": 47
  },
  "community": {
    "onlineNow": 84,
    "votesToday": 4,
    "distribution": { "positive": 1, "neutral": 1, "negative": 1 }
  },
  "history": [
    { "time": "...", "value": 1, "indexAfter": 1 }
  ]
}
```

#### `POST /api/sentiment/vote` (требует авторизации)

Принимает голос.

**Body:** `{ "value": 1 }` (или `0`, `-1`)

**Response (201):**

```json
{
  "success": true,
  "newIndex": 0,
  "nextVoteAt": "2026-06-24T21:36:44.884Z",
  "secondsUntilNext": 1800,
  "sync": true
}
```

**Ошибки:**
- `400 Invalid vote value` — передано значение вне `[-1, 0, 1]`.
- `429 Too soon. Wait for your personal window.` — кулдаун не истёк.

### 4.4. SSE-стриминг

Файл: `pulse-backend/src/services/sse.ts`

**Endpoint:** `GET /api/sentiment/stream` (публичный)

При каждом новом голосе бэкенд рассылает всем подключённым клиентам событие:

```
event: sentiment-update

data: {"currentValue":0,"timestamp":"2026-06-24T20:36:44.884Z"}
```

Фронтенд, получив событие, перезапрашивает `/api/sentiment/index` и `/api/sentiment/status`.

Если SSE падает, работает fallback-polling каждые 10 секунд.

### 4.5. Cron-задачи

Файл: `pulse-backend/src/index.ts`

```ts
// Сброс vote_count_today и пересчёт streak в 00:00 МСК (21:00 UTC)
cron.schedule('0 21 * * *', () => {
  resetDailyWindows().catch(...);
});

// Обновление кэша IMOEX каждые 5 минут в торговые часы (MSK 10:00–23:00 → UTC 07:00–20:00)
cron.schedule('*/5 7-20 * * 1-5', () => {
  refreshImoexCache().catch(...);
});
```

---

## 5. Логика расчёта индекса и голосования

### 5.1. Расчёт текущего индекса

```ts
SELECT COALESCE(SUM(vote_value), 0) as idx
FROM sentiment_votes
WHERE created_at >= $dayStart AND created_at < $dayEnd;
```

Границы дня вычисляются по московскому времени (`getMoscowDayBounds()`), а в БД передаются как UTC.

### 5.2. История для графика

```ts
const points = [{ time: dayStartUTC, value: 0 }];
let cumulative = 0;
for (const vote of votesToday) {
  cumulative += vote.vote_value;
  points.push({ time: vote.created_at, value: cumulative });
}
```

Линия строится по этим точкам. Между голосами значение не меняется — Recharts/фронтенд держит последнее известное значение.

### 5.3. Персональное окно голосования

- При первом заходе пользователя создаётся пустая запись в `sentiment_user_windows`.
- После голоса:
  - `last_vote_at = NOW()`
  - `next_vote_at = NOW() + 30 минут`
  - `vote_count_today += 1`
  - `total_votes_all_time += 1`
  - `total_votes_count += 1`
  - `sync_count += 1` если знак голоса совпал со знаком нового индекса
  - `impact_sum += vote_value`
- Состояние `active`/`voting` определяется на фронтенде/бэкенде по условию `next_vote_at > NOW()`.

### 5.4. «Синхрон» / «Контрарианец"

```ts
const sync = Math.sign(value) === Math.sign(afterIndex);
```

- `sync === true` — голос совпал с направлением индекса после голоса.
- Используется для расчёта `syncRate` и персональной статистики.

### 5.5. Сброс дня и streak

Каждый день в 00:00 МСК (21:00 UTC):
- Для всех пользователей `vote_count_today = 0`.
- Если пользователь голосовал вчера — `streak_days += 1`, иначе `streak_days = 0`.
- `max_streak_days = MAX(max_streak_days, streak_days)`.
- `last_streak_date = сегодня` (если была серия).

---

## 6. График на фронтенде

### 6.1. Стек

- **React 19 + TypeScript**
- **Recharts** (`AreaChart`, `Line`, `XAxis`, `YAxis`, `Tooltip`, `ReferenceArea`)
- **Tailwind CSS**
- **SSE + fallback polling**

Файл: `pulse-frontend/src/pages/SentimentIndex.tsx`

### 6.2. Поток данных

1. При загрузке страницы фронтенд делает два запроса:
   - `GET /api/sentiment/index` — общий индекс и IMOEX.
   - `GET /api/sentiment/status` — персональный статус (если залогинен).
2. Подключается к `GET /api/sentiment/stream` через `EventSource`.
3. При событии `sentiment-update` или по таймеру каждые 10 секунд перезапрашивает данные.
4. Состояние определяется:
   - `anonymous` — не залогинен.
   - `active` — залогинен и `next_vote_at` в будущем.
   - `voting` — залогинен и `next_vote_at` истёк.

### 6.3. Подготовка данных для Recharts

Функция `chartData` объединяет две временные серии:

- **Индекс настроения** — точки из `indexData.history`.
- **IMOEX** — 5-минутные свечи из `indexData.imoex.candles`.

**Важное правило:** график не строится в будущее. Последнее известное значение — самая правая точка. Данные обрезаются по `clipTs`:

```ts
const nowTs = Date.now();
const lastCandleTs = imoexCandles.length > 0
  ? new Date(imoexCandles[imoexCandles.length - 1].time).getTime()
  : nowTs;
const clipTs = Math.min(nowTs, lastCandleTs);
```

- Текущий день во время торгов — обрезка по текущему времени.
- Исторический/закрытый день — показывается полный день до последней свечи.

```ts
const points = new Map<number, { value?: number; imoex?: number }>();

// Индекс
for (const p of history) {
  const ts = new Date(p.time).getTime();
  if (ts > clipTs) continue;
  points.set(ts, { ...points.get(ts), value: p.value });
}

// IMOEX
for (const c of imoexCandles) {
  const ts = new Date(c.time).getTime();
  if (ts > clipTs) continue;
  points.set(ts, { ...points.get(ts), imoex: c.close });
}

// Сортируем и заполняем пропуски последними известными значениями
const sorted = Array.from(points.keys()).sort((a, b) => a - b);
let lastValue = 0;
let lastImoex = imoexCandles[0]?.close ?? indexData?.imoex?.current ?? IMOEX_MOCK_VALUE;

return sorted.map(ts => {
  const p = points.get(ts)!;
  if (p.value !== undefined) lastValue = p.value;
  if (p.imoex !== undefined) lastImoex = p.imoex;
  return { time: ts, value: lastValue, imoex: lastImoex, label: formatTime(ts) };
});
```

### 6.4. Оси и масштаб

- **Ось X:** числовая, по timestamp (миллисекунды). Метки времени форматируются в **МСК** (`Europe/Moscow`) через `toLocaleTimeString`.
- **Левая ось Y:** индекс настроения, авто-масштаб.
- **Правая ось Y:** IMOEX, масштаб вычисляется динамически от `min`/`max` свечей с отступом 10%:

```ts
const imoexDomain = useMemo(() => {
  if (candles.length === 0) return ['auto', 'auto'];
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const pad = Math.max((max - min) * 0.1, min * 0.005);
  return [Math.floor(min - pad), Math.ceil(max + pad)];
}, [candles]);
```

### 6.5. Визуальные элементы

| Элемент | Описание |
|---------|----------|
| **Area (sentiment)** | Линия индекса цветом в зависимости от знака (`#34D399` / `#EF4444` / `#9CA3AF`) + градиентная заливка. |
| **Line (IMOEX)** | Жёлтая пунктирная линия (`#f59e0b`, `strokeDasharray="6 6"`) по правой оси. |
| **ReferenceArea** | Полупрозрачная зона торговой сессии МосБиржи (10:00–19:00 МСК). |
| **Tooltip** | Показывает время (МСК), значение индекса и значение IMOEX. |
| **CartesianGrid** | Горизонтальные линии сетки. |

### 6.6. Оверлеи и toast-фидбек

- **S0 (anonymous):** встроенная в правую часть графика стилизованная карточка (`rounded-xl`, внутренние отступы, glass/blur-фон, тонкая рамка `border-white/10`). Содержит иконку замка, заголовок «Актуальная динамика скрыта», подзаголовок и кнопку «Войти» в стиле кнопки «Начать» из Navbar (градиент `#00D4FF → #0099CC`, тёмный текст, `rounded-pill`). На десктопе карточка занимает вписанную правую половину, на мобильном — компактную карточку поверх графика.
- **S2 (voting):** полное затемнение + blur поверх графика, три кнопки голосования. Текущий индекс скрыт (blind vote).
- **Toast после голосования:** `VoteToast` монтируется **внутри карточки индекса** в абсолютном оверлее (`absolute inset-0 z-50 flex items-center justify-center pointer-events-none`), поверх графика и остальных оверлеев. Оверлей не влияет на размеры карточки. Три варианта:
  - `sync` — «Вы в синхроне с настроением сообщества» + 🔥 + брендовая синяя рамка/свечение (`#00D4FF`) + пульсация glow.
  - `balance` — «Вы держите баланс» + ⚖️ + серая/белая рамка.
  - `contrarian` — «Ваше мнение отличается — вы мыслите вне рамок» + 🧠 + фиолетовая рамка/свечение.
  - Toast показывается одинаково и на `/sentiment`, и на главной (внутри блока `SentimentChartCard`).
- **Дизайн Toast (Liquid Glass v2):**
  - Фон: `linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))`.
  - `backdrop-filter: blur(24px) saturate(180%)`.
  - Градиентная рамка через `::before` (`mask-composite: exclude`).
  - Верхний блик через `::after` (radial-gradient + `mix-blend-mode: overlay`).
  - Shine sweep: блик пробегает слева направо при появлении.
  - `border-radius: 1.25rem`, padding `1rem 1.75rem`.
- **Анимации Toast:**
  - `toastEnter` — 0.7s spring с overshoot (`translateY(30px) scale(0.85) rotateX(10deg)` → `translateY(0) scale(1) rotateX(0deg)`).
  - `toastExit` — 0.6s, чистое растворение (`opacity: 1 → 0`) на месте. Toast стартует в 0s, `glowPulse` начинается в 0.7s, растворение начинается в 4.8s, удаление в 5.3s.
  - `shineSweep` — 1.2s с задержкой 0.3s.
  - `glowPulse` — только для `sync`, бесконечная пульсация брендового синего свечения (`#00D4FF`) после появления.
- **Анимация синхрона (только `sync`):** при совпадении голоса с общим настроением вокруг центра Toast запускается полный набор эффектов:
  - **Shockwave** — 3 расширяющихся брендовых синих кольца (`#00D4FF`).
  - **3D Confetti** — 40 частиц на десктопе, 20 на мобильных (`< 768px`). Типы: `sphere`, `cube`, `ring`, `star`. 7 цветов. Траектории через CSS-переменные `--tx/--ty/--tz` → `--tx2/--ty2/--tz2`, вращение через `particleRotate`.
  - **Ambient Floaters** — 12 лёгких частиц, поднимающихся вверх и растворяющихся.
  - Все эффекты рендерятся через `createPortal` в `document.body` и центрируются по `getBoundingClientRect()` Toast'а, чтобы не обрезались родителями. Учитывается `prefers-reduced-motion`.

### 6.7. Цвета и легенда

- Индекс настроения: зелёный/красный/серый.
- IMOEX: янтарный (`#f59e0b`).
- Легенда под графиком:
  - «Индекс настроения»
  - «IMOEX»
  - «Сессия МосБиржи»

---

## 7. Роутинг и интеграция

- Страница доступна по `/sentiment`.
- Полная карточка индекса также встроена в главную страницу (`Home.tsx`) сразу после общей карусели (`GlobalNewsCarousel`) и перед блоком «Популярные теги». Для этого логика вынесена в переиспользуемый компонент `SentimentChartCard`.
- На главной весь блок `SentimentChartCard` кликабелен в зависимости от состояния:
  - **Аноним** — клик открывает модалку авторизации.
  - **Активный доступ** (пользователь видит график) — клик перенаправляет на страницу `/sentiment`.
  - **Ожидание голоса** — клик по самому блоку игнорируется, активны только кнопки голосования на оверлее S2.
- Backend router подключается как `app.use('/api/sentiment', sentimentRoutes)`.
- SSE endpoint регистрируется отдельно: `app.get('/api/sentiment/stream', ...)`.`

---

## 8. Файлы и код

### Бэкенд

| Файл | Назначение |
|------|------------|
| `pulse-backend/src/services/sentimentIndex.ts` | Вся бизнес-логика: индекс, голосование, метрики, кэш, cron-сброс. |
| `pulse-backend/src/services/imoexAdapter.ts` | Адаптер MOEX ISS API для получения свечей IMOEX. |
| `pulse-backend/src/services/sse.ts` | SSE-рассылка `sentiment-update`. |
| `pulse-backend/src/routes/sentiment.ts` | API endpoints `/api/sentiment/*`. |
| `pulse-backend/src/index.ts` | Подключение роутера, SSE endpoint, cron-задачи, миграции таблиц. |
| `pulse-backend/src/models/schema.sql` | SQL-схема таблиц. |
| `pulse-backend/src/config/db-sqlite.ts` | SQLite-вариант схемы для локальной разработки. |

### Фронтенд

| Файл | Назначение |
|------|------------|
| `pulse-frontend/src/components/SentimentChartCard.tsx` | Переиспользуемая карточка индекса: график, состояния, голосование, SSE, polling. |
| `pulse-frontend/src/pages/SentimentIndex.tsx` | Страница `/sentiment` — обёртка над `SentimentChartCard`. |
| `pulse-frontend/src/pages/Home.tsx` | Главная страница; внизу выводится `SentimentChartCard` с шириной, равной баннеру портфеля инвестиционно.рф (`max-w-[1200px]`). |

---

## 9. Что реализовано в MVP

- [x] Три состояния страницы (S0/S1/S2).
- [x] Голосование с персональным 30-минутным кулдауном.
- [x] Кумулятивный индекс настроения за текущий день по МСК.
- [x] График индекса + линия IMOEX (реальные 5-минутные свечи MOEX ISS).
- [x] Зона торговой сессии МосБиржи на графике.
- [x] Flat line IMOEX за неторговое время.
- [x] SSE-обновления + fallback polling.
- [x] Персональные метрики (totalVotes, todayVotes, syncRate, streakDays, impactSum).
- [x] Общие метрики сообщества (onlineNow, votesToday, distribution).
- [x] История голосов пользователя.
- [x] Ежедневный сброс `vote_count_today` и пересчёт `streak_days` через cron.
- [x] Кэширование свечей IMOEX в PostgreSQL.
- [x] Блок индекса настроения на главной странице (`Home`).
- [x] Toast-фидбек после голосования: три варианта (`sync`/`balance`/`contrarian`), 3D CSS-confetti + shockwave + ambient floaters при совпадении с настроением сообщества, центр взрыва — центр toast.

---

## 10. Что остаётся на будущее (вне MVP)

- [ ] Бейджи и достижения (12 шт).
- [ ] Лидерборд топ-10 пользователей.
- [ ] Топ-тикеры из портфелей голосующих.
- [ ] Отложенные проверки бейджей («Точный прогноз», «Контрарианец») через cron.
- [ ] Нормализация индекса (относительный % вместо абсолютной суммы).
- [ ] Возможность переключения рыночного актива (IMOEX / IMOEX / другие).
- [ ] Мобильная оптимизация нижних блоков (метрики, история, лидерборд).

---

## 11. Известные нюансы

1. **Поле `imoex` в API.** Имя поля историческое, но теперь внутри действительно данные по IMOEX. Переименование в `marketIndex` или `imoex` — по желанию.
2. **Fallback mock.** Если MOEX ISS недоступен, фронтенд использует `IMOEX_MOCK_VALUE = 2200` как запасное значение.
3. **Время на графике.** Все метки и тултипы отображаются в московском часовом поясе независимо от локального времени пользователя.
4. **Торговая сессия.** Сессия считается жёстко 10:00–19:00 МСК. В праздничные/сокращённые дни flat line может отличаться от реальности.
5. **Блок на главной.** На `Home` отображается та же карточка `SentimentChartCard`, что и на `/sentiment`, но без метрик сообщества (`showMetrics={false}`). Располагается сразу после общей карусели `GlobalNewsCarousel` и перед блоком «Популярные теги». Ширина блока привязана к ширине баннера портфеля инвестиционно.рф (`max-w-[1200px]`).
6. **Дизайн карточки.** Карточка использует единый с `NewsCard` liquid-glass стиль: скругление `rounded-xl`, цветная рамка по знаку индекса, highlight-линия сверху, glow-линия снизу.
7. **Анонимный оверлей.** Оформлен не как сплошная серая накладка, а как вписанная карточка внутри области графика: `rounded-xl`, padding, `backdrop-filter blur`, `border-white/10`, кнопка «Войти» — градиент `#00D4FF → #0099CC` с тёмным текстом.
8. **Toast-фидбек.** Реализован в `pulse-frontend/src/components/VoteToast.tsx` + стили в `pulse-frontend/src/index.css`. Toast монтируется внутри `SentimentChartCard` в абсолютном оверлее поверх графика, не расширяя карточку. Эффекты синхрона вынесены в портал (`createPortal` → `document.body`) и центрируются относительно toast. Срабатывают только при `variant === 'sync'`. Поддерживается `prefers-reduced-motion`: при включённой настройке confetti отключается, а длительности анимаций Toast сокращаются.
9. **Переиспользуемость.** `SentimentChartCard` используется и на `/sentiment`, и на главной. Toast-фидбек работает в обоих местах одинаково.

---

*Документ актуален для коммитов backend `90b7770` и frontend `c18cd4d`.*
