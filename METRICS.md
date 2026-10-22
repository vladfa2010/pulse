# PULSE — Product Metrics (Admin Analytics)

> Дата актуализации: 2026-07-23 | Актуализировано: 2026-10-21 (ТЗ-119, ТЗ-122: секции radio/flow, правки источников метрик); 2026-10-22 (ТЗ-124 v2: блок `sankey`; ТЗ-124 v3: глубина Санки 3/5/10 + блок `coverage`, ключ кэша `paths:<period>:<scope>:<depth>`)
> Файл backend: `pulse-backend/src/routes/adminMetrics.ts`  
> Файл frontend: `pulse-frontend/src/pages/admin/ProductMetricsTab.tsx`  
> Endpoint: `GET /admin/metrics?section=<section>&period=<period>`

---

## 1. Обзор

Админская аналитика собирает продуктовые метрики из нескольких источников:

- `users` — регистрации, подписки, блокировки, last_login_at.
- `user_logins` — DAU/WAU/MAU, платформы, устройства.
- `portfolios` — теги пользователей.
- `payments` — выручка, MRR/ARR, когорты, churn.
- `promo_codes` / `user_promo_uses` — промокоды.
- `user_events` — вовлечённость.
- `user_sessions` — online-пользователи.
- `sentiment_votes` / `sentiment_user_windows` — сентимент-голосования.
- `push_subscriptions` / `user_channels` — внедрение фич.

Каждая секция кэшируется на 60 секунд в памяти (`Map`) — повторные запросы за минуту не бьют по БД.

---

## 2. Endpoint

### `GET /admin/metrics`

**Query params:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `section` | string | Название секции (см. список ниже) |
| `period` | number | Период в днях: `1`, `7`, `30`, `90` |

**Доступные секции (17):**

```
overview, daily, funnel, retention, sentiment, tags, revenue, adoption,
online, plans, mrr, promos, engagement, churn, radio, flow, paths
```

| Секция | Пояснение |
|--------|-----------|
| `radio` | Radio TTS-метрики (in-memory с момента старта процесса, `period` игнорируется) |
| `flow` | ТЗ-122: визуализация потока действий (см. `GET /metrics/flow` ниже) |
| `paths` | ТЗ-124 (+v2 Санки): дашборд «Пути пользователей» (см. `GET /metrics/user-paths` ниже; scope всегда `all`) |

**Ответ:**

```json
{
  "section": "online",
  "period": 30,
  "cached": false,
  "data": { ... }
}
```

**Ошибки:**

- `400` — неизвестная секция или невалидный period.
- `500` — внутренняя ошибка (данные не возвращаются, лог пишется).

---

## 2.1 `GET /metrics/flow` (ТЗ-122)

Отдельный endpoint визуализации потока действий пользователей. Не входит в общий список секций — свой роут.

**Query params:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `period` | number | Период в днях: `1`, `7`, `30`, `90` |
| `user_id` | uuid (опционально) | Конкретный пользователь; валидируется как uuid (невалидный → 400). Per-user запрос **не кэшируется** |

**Источник данных — единая лента:**

- `user_events` за период, **без** событий с префиксом `admin_%` (`event_type NOT LIKE 'admin_%'`)
- `user_news_reads` → приводится к типу `read_article` (`read_at AS created_at`)

**Сессия:** разрыв между последовательными событиями пользователя > **1800 сек** (= 30 мин) начинает новую сессию. Переходы считаются только внутри сессии.

**Ответ (4 блока):**

```json
{
  "period": 7,
  "user_id": null,
  "transitions": [{ "from": "login", "to": "page_view_feed", "count": 120 }],
  "session_starts": [{ "event_type": "login", "count": 80 }],
  "bubbles": [{ "hour": 9, "event_type": "page_view_feed", "count": 15 }],
  "timeline": []
}
```

| Блок | Описание |
|------|----------|
| `transitions` | Пары `prev → next` внутри сессий. Серии одинаковых подряд схлопываются (X→X не пишется), переход через границу сессии не считается. Топ-30 связок по count, остаток сворачивается в `other` по `from` |
| `session_starts` | Топ-10 типов событий, которыми начинаются сессии (первое событие юзера или после разрыва > 1800 с) |
| `bubbles` | Активность по часам: час (UTC) × тип события × count |
| `timeline` | Последние 300 событий `[{ t, type }]` — **только при запросе с `user_id`**, порядок ASC. В агрегате пустой массив |

**Кэш:** агрегат (без `user_id`) кэшируется 60 с с ключом `flow:all:<period>`; per-user — без кэша.

---

## 2.2 `GET /metrics/user-paths` (ТЗ-124, v2 — Санки типичных путей)

Дашборд «Пути пользователей» — сводка по всем юзерам поверх той же ленты
событий и сессионизации, что и `flow` (ТЗ-122): общие CTE-кирпичи
`buildEventsCte` / `SESSED_CTE` (`admin_%` исключены, `read_article` из
`user_news_reads`, сессия = разрыв > 1800 с, серии повторов схлопнуты).
Обёртка секции `paths` проксирует сюда же с `scope=all` (через общий
`/admin/metrics`) — двойной кэш осознанный, как у `flow`.

**Query params:**

| Параметр | Тип | Описание |
|----------|-----|----------|
| `period` | number | Период в днях: `1`, `7`, `30`, `90` (иначе 400) |
| `scope` | string | `all` (default) или `functions` — влияет на `branching` и `sankey`: контентные события (`read_article`, `page_view_feed`) исключаются **до** подсчёта (иначе 400) |
| `depth` | number | Глубина Санки: `3` (default), `5` или `10` (ТЗ-124 v3); невалидное значение — дефолт 3 |

**Ответ (5 блоков):**

```json
{
  "period": 30,
  "scope": "all",
  "users": [{ "user_id": "…", "email": "…", "username": "…", "plan": "pro",
              "subscription_active": true, "last_event_at": "ISO", "last_event_type": "login",
              "events_7d": 12, "events_30d": 40, "top_event_type": "sentiment_vote",
              "top_transition": { "from": "login", "to": "sentiment_vote", "count": 8 }, "ltv": 990 }],
  "exit_points": [{ "event_type": "read_article", "count": 439 }],
  "conversion_paths": [{ "goal": "payment_completed", "path": ["login", "page_view_plans", "payment_completed"], "count": 8 }],
  "branching": [{ "from": "login", "total_out": 197, "next": [{ "to": "read_article", "count": 115, "share": 58.4 }] }],
  "sankey": {
    "levels": 3,
    "nodes": [{ "id": "login#1", "label": "login" }],
    "links": [{ "source": "login#1", "target": "read_article#2", "value": 82 }],
    "coverage": [{ "level": 1, "sessions": 894, "pct": 100.0 },
                 { "level": 2, "sessions": 394, "pct": 44.1 },
                 { "level": 3, "sessions": 218, "pct": 24.4 }]
  }
}
```

| Блок | Описание |
|------|----------|
| `users` | Все юзеры, сортировка по `last_event_at` DESC, LIMIT 500. `last_event_at` и окна `events_7d/30d` — по **полной истории** (без period-фильтра, сверка с эталоном probe_tz124 блок 4); `top_event_type` и `top_transition` — за period; `ltv` = `SUM(amount) payments WHERE status='completed'` (дубли платежей ТЗ-119 в scope не входят) |
| `exit_points` | Последнее событие каждой сессии (LEAD-окно + разрыв 1800 с), топ-10 + `other` |
| `conversion_paths` | Цели: `payment_completed`, `subscription_activated`, `subscription_cancelled`. До 3 предшествующих событий в той же сессии (схлопывание серий), цель в конце пути; если цель стартует сессию — последние 3 события юзера перед ней. Топ-5 цепочек на цель, всё с `count<3` — в `other` |
| `branching` | Матрица ветвлений: узлы `from` (топ-20 по `total_out`), у каждого топ-5 `next` + `other`; `share = count/total_out`, округление 0.1; связки `count<3` — в `other`. Правила малой выборки: проценты показываются только с n |
| `sankey` | Диаграмма Санки «Типичные пути» (ТЗ-124 v2, глубина параметризована в v3): первые `depth` (3/5/10, дефолт 3) действий каждой сессии (серии схлопнуты LAG, уровни ROW_NUMBER). Узлы `id = "тип#уровень"`, `label` — сырой `event_type` (RU-лейблы накладывает фронт). Сборка — чистая функция `src/services/adminSessionSankey.ts`: узел с исходящим потоком < 3 схлопывается в `other#<уровень>`, лента с `value<3` — target в `other#<уровень>` (value сохраняется), потолок 200 лент (хвост в `other`, жёсткий slice). Консервация: сумма лент через границу уровней N→N+1 не меняется схлопами. Узлы уровня 1 без исходящих (сессии из 1 события, поток ≥ 3) включаются как источники. `levels` = запрошенный depth; **`coverage`** — для каждого уровня 1..depth сколько сессий до него дошло (`sessions`, доля `pct`, монотонно не возрастает, level 1 = 100%) — считается по **полным** длинам путей (обрезка до depth не искажает); фронт показывает подписи «шаг N: M (P%)» |

**Кэш:** 60 с по ключу `paths:<period>:<scope>:<depth>`; сверху кэш диспетчера
`paths:<period>` при загрузке через `/admin/metrics?section=paths`.

**Бэкфилл событий оплаты:** логирование `payment_completed` /
`subscription_activated` появилось 10.07.2026 (последний платёж до него —
08.07), поэтому история восстановлена скриптом
`scripts/backfill-payment-events.js` из `payments` и
`subscription_renewals` (идемпотентно, метка `tz124_backfill` в
`event_data`; откат: `DELETE FROM user_events WHERE event_data->>'tz124_backfill' = 'true'`).

---

## 3. Секции

### 3.1 `overview`

Ключевые продуктовые KPI.

| Поле | Источник | Описание |
|------|----------|----------|
| `total_users` | `users` | Всего пользователей |
| `dau` | `user_sessions` | Уникальные за 24ч — `COUNT(DISTINCT user_id)` по `last_connected_at` (ТЗ-119, не `user_logins`) |
| `wau` | `user_sessions` | Уникальные за 7 дней — по `last_connected_at` |
| `mau` | `user_sessions` | Уникальные за 30 дней — по `last_connected_at` |
| `new_users_today` | `users` | Зарегистрированы сегодня |
| `new_users_week` | `users` | Зарегистрированы за 7 дней |
| `active_subscriptions` | `users` | `subscription_active = TRUE` |
| `push_subscribers` | `push_subscriptions` | Активные push-подписки |
| `total_revenue` | `payments` | Сумма `completed` за период **по `paid_at`** (момент оплаты, не `created_at` pending) |
| `dormant_7d` | `users` + `user_sessions` | Не заходили 7+ дней — `MAX(user_sessions.last_connected_at)` |
| `dormant_30d` | `users` + `user_sessions` | Не заходили 30+ дней — `MAX(user_sessions.last_connected_at)` |
| `no_tags` | `users` | Пользователи без портфеля |
| `sub_expiring_7d` | `users` | Подписка истекает ≤7 дней |

---

### 3.2 `daily`

Графики DAU + новые пользователи по дням.

```json
{
  "daily_activity": [{ "date": "2026-07-20", "dau": 120, "new_users": 15 }],
  "signup_trend": [{ "date": "2026-07-20", "signups": 18 }]
}
```

**Логика (ТЗ-119):** активность дня = `UNION` логинов и событийной истории — `DISTINCT user_id, day` из `user_logins.login_at` **плюс** `user_events.created_at` за период. У `user_sessions` нет истории (одна строка на юзера), поэтому для daily она не подходит.

---

### 3.3 `funnel`

Воронка: Registered → Logged In → Added Tag → Read Article → Paid.

| Шаг | SQL-источник |
|-----|--------------|
| Registered | `users.created_at` |
| Logged In | `user_logins.login_at` |
| Added Tag | `portfolios.created_at` |
| Read Article | `user_news_reads.read_at` |
| Paid | `payments.status = 'completed'` |

**Логика (ТЗ-119):** единая когорта — все шаги только внутри пользователей, зарегистрированных за период. Каждый следующий шаг **вложен в предыдущий** (`user_id IN (предыдущий шаг)`), тогда `pct_of_prev ≤ 100` по построению: чтение новостей и подписка на тег не требуют друг друга, без вложения воронка на реальных данных давала 300–400%.

---

### 3.4 `retention`

Когорты, retention D1/D7/D30.

```json
{
  "retention": [
    { "cohort": "2026-07-15", "d1": 45.2, "d7": 28.5, "d30": null }
  ]
}
```

**Логика (ТЗ-119):**

- Когорты — **по неделям** (`DATE_TRUNC('week', created_at)` / SQLite `strftime('%Y-W%W')`), не по дням; лимит когорт — `ceil(retentionDays / 7)`.
- Активность dN = `last_login_at > created_at + N days` **ИЛИ** событие в `user_events` позже `created_at + N`.
- **Незрелым когортам** (самому позднему юзеру когорты не исполнилось N дней) — `null` вместо 0, фронт рендерит «—».

---

### 3.5 `sentiment`

Статистика голосований за сентимент.

| Поле | Источник |
|------|----------|
| `total_votes` | `sentiment_votes` |
| `unique_voters` | `COUNT(DISTINCT user_id)` |
| `avg_streak` | `sentiment_user_windows.streak_days` |
| `distribution.bullish` | `vote_value = 1` |
| `distribution.neutral` | `vote_value = 0` |
| `distribution.bearish` | `vote_value = -1` |

---

### 3.6 `tags`

- `avg_tags` — среднее число тегов на пользователя.
- `tag_distribution` — бакеты: 1, 2-3, 4-5, 6+.
- `top_tags` — топ-10 тегов по числу подписчиков.

---

### 3.7 `revenue`

- `cohort_ltv` — LTV по когортам (по дню регистрации).
- `ltv_trend` — динамика LTV.
- `ttfp.distribution` — время до первой оплаты.
- `conversion_velocity.buckets` — то же, что TTF (дублируется для UI).

---

### 3.8 `adoption`

Внедрение фич (процент от всех пользователей).

| Фича | Источник |
|------|----------|
| `push` | `push_subscriptions` |
| `telegram` | `user_channels` (channel = 'telegram') |
| `sentiment` | `sentiment_votes` |
| `premium` | `users.subscription_active = TRUE` |

---

### 3.9 `online`

Текущие онлайн-пользователи и история за 12 часов.

```json
{
  "online_now": 42,
  "history": [
    { "slot": "2026-07-21T10:00:00Z", "users": 38 }
  ]
}
```

**SQL-логика:**

- `online_now` — `COUNT(DISTINCT user_id)` из `user_sessions` с `last_connected_at` в последние **15 минут** (ТЗ-119; раньше было 5 — порог расширен).
- `history` — слоты по 30 минут за последние 12 часов.

---

### 3.10 `plans`

Распределение подписчиков по тарифам.

```json
{
  "plans": [
    { "id": "basic", "name": "Basic", "price": 100, "subscribers": 120, "revenue": 12000 }
  ]
}
```

**SQL:**

```sql
SELECT sp.id, sp.name, sp.price, sp.plan_level,
       COUNT(u.id) as subscribers,
       COALESCE(SUM(sp.price), 0) as revenue
FROM subscription_plans sp
LEFT JOIN users u ON u.subscription_plan = sp.id AND u.subscription_active = TRUE
WHERE sp.deleted_at IS NULL
GROUP BY sp.id, sp.name, sp.price, sp.plan_level
ORDER BY sp.plan_level;
```

---

### 3.11 `mrr`

Monthly Recurring Revenue и Annual Recurring Revenue.

```json
{
  "mrr": 45000,
  "mrr_list": 52000,
  "arr": 540000,
  "trend": [{ "month": "2026-07-01", "mrr": 45000 }]
}
```

**Логика (ТЗ-119):**

| `billing_cycle` | MRR-вклад |
|-----------------|-----------|
| `monthly` | `amount` |
| `yearly` | `amount / 12` |
| `quarterly` | `amount / 3` |
| `weekly` | `amount × 30 / 7` |
| `NULL` / `one_time` / другое | `amount × 30 / duration_days` (fallback) |

- `mrr` — нормированные **последние платежи активных подписчиков** (`subscription_active = TRUE`, подписка не истекла), а не «платежи за 30 дней»: подписка, оплаченная 31 день назад, иначе исчезает из MRR.
- `mrr_list` — прайсовая сумма (`subscription_plans.price`) по тем же активным подписчикам; подпись для фронта («списочный» MRR).
- `arr` = `mrr × 12`; `trend` — по месяцам (`paid_at`), последние 6.

---

### 3.12 `promos`

Статистика промокодов.

```json
{
  "promos": [
    {
      "id": "...",
      "code": "START50",
      "discount": 50,
      "discount_type": "percent",
      "uses": 120,
      "converted_to_paid": 45,
      "revenue": 90000
    }
  ]
}
```

**Логика (ТЗ-119):**

- `uses` — уникальные пользователи в `user_promo_uses`.
- `converted_to_paid` — уникальные пользователи с `completed` платежом, у которого `payments.promo_code = <код>`.
- `revenue` — сумма **только тех `completed` платежей, у которых проставлен этот `promo_code`** (колонку пишет `services/promo.ts` при применении промо). Ранний JOIN через `user_id` приписывал промо все платежи пользователя (и с удвоением при нескольких uses).

---

### 3.13 `engagement`

Среднее число событий на пользователя в день и распределение.

```json
{
  "avg_events": 4.2,
  "distribution": [
    { "label": "1", "value": 50 },
    { "label": "2-5", "value": 120 },
    { "label": "6-10", "value": 80 },
    { "label": "11-20", "value": 40 },
    { "label": "21+", "value": 10 }
  ]
}
```

**Источник:** `user_events` за последние 7 дней.

---

### 3.14 `churn`

Отток по месячным когортам (от первой оплаты).

```json
{
  "cohorts": [
    {
      "month": "2026-07",
      "total_subs": 50,
      "churned_30d": 5,
      "churned_90d": 2,
      "churn_rate_30d": 10.0,
      "churn_rate_90d": 4.0
    }
  ]
}
```

**Логика:**

- Когорта = месяц первого `completed` платежа пользователя (`MIN(paid_at)`).
- `churned_30d` — пользователи без повторного `completed` платежа через 30 дней после первого.
- `churned_90d` — то же, через 90 дней.
- Churn rate = `churned / total_subs × 100%`.

---

## 4. At-risk accounts

Отдельный endpoint: `GET /admin/metrics/at-risk-accounts?type=<type>&limit=50`.

**Типы:**

| Type | Описание |
|------|----------|
| `dormant_7d` | Не заходили 7+ дней |
| `dormant_30d` | Не заходили 30+ дней |
| `no_tags` | Нет тегов в портфеле |
| `sub_expiring` | Подписка истекает ≤7 дней |

Используется в UI карточкой "Группы риска" — клик открывает модалку со списком пользователей.

---

## 5. UI (ProductMetricsTab)

Все 27 блоков отображаются на одной странице админки.

| # | Блок | Секция | Визуализация |
|---|------|--------|--------------|
| 1 | Обзор KPI | `overview` | KPI cards |
| 2 | Активность (DAU + новые) | `daily` | Line chart |
| 3 | Регистрации по дням | `daily` | Line chart |
| 4 | Воронка | `funnel` | Table |
| 5 | Retention | `retention` | Table |
| 6 | Топ тегов | `tags` | Horizontal bars |
| 7 | Страны | — | Placeholder |
| 8 | Устройства | — | Placeholder |
| 9 | Платформы | — | Placeholder |
| 10 | Среднее число тегов | `tags` | KPI |
| 11 | Распределение тегов | `tags` | Bar chart |
| 12 | Сентимент | `sentiment` | KPI + bar chart |
| 13 | Push-подписчики | `adoption` | KPI |
| 14 | LTV по когортам | `revenue` | Table |
| 15 | Динамика LTV | `revenue` | Line chart |
| 16 | Время до первой оплаты | `revenue` | Bar chart |
| 17 | Скорость конверсии | `revenue` | Bar chart |
| 18 | Группы риска | `overview` | KPI cards (clickable) |
| 19 | Внедрение фич | `adoption` | KPI cards |
| 20 | Сейчас онлайн | `online` | KPI + sparkline |
| 21 | Распределение по планам | `plans` | Horizontal bars |
| 22 | MRR / ARR | `mrr` | KPI + line chart |
| 23 | Промокоды | `promos` | Table |
| 24 | Событий на пользователя | `engagement` | KPI + bar chart |
| 25 | Churn-когорты | `churn` | Table |
| 26 | Сценарии (ТЗ-122) | `flow` (агрегат `GET /metrics/flow`) | Sankey переходов + топ-10 стартов сессий (`FlowCharts.tsx`, ленивый `echartsLoader`) |
| 27 | Пути (ТЗ-124, v2/v3 — Санки с глубиной) | `paths` (агрегат `GET /metrics/user-paths`, depth=3) | Диаграмма Санки «Типичные пути» с чипами глубины 3/5/10 и подписями охвата «шаг N: M (P%)» (при depth=10 — уровни 1,3,5,8,10), сводная таблица юзеров (клик → UserDetailModal), exit-бары, цепочки к целям, аккордеон ветвлений. Общие переключатели scope/depth: любое сочетание ≠ (all, 3) догружается ленивым прямым fetch (`PathsSection.tsx` + `ProductMetricsTab.tsx`) |

> **Примечание:** нумерация в UI отличается от нумерации в `TZ_V6_METRICS.md` (где новые метрики названы 27–32), потому что общий список блоков в frontend не разбивался на отдельные карточки Placeholder.

---

## 6. Безопасность и защита

- Все endpoints требуют `adminMiddleware`.
- Параметры period ограничены `[1, 7, 30, 90]`.
- Каждый SQL обёрнут в `safeCount` / `safeFloat` / `safeQuery` — при отсутствии таблицы или ошибке возвращается 0 / пустой массив, endpoint не падает.
- Кэш 60 секунд защищает от частых обновлений.

---

## 7. Различия PostgreSQL и SQLite

| Момент | PostgreSQL | SQLite |
|--------|------------|--------|
| Тип BOOLEAN | `TRUE` / `FALSE` | `1` / `0` |
| Дата | `NOW()`, `INTERVAL`, `DATE_TRUNC` | `datetime('now')`, `strftime`, `date` |
| Максимум | `GREATEST(a, b)` | `MAX(a, b)` |
| NULLS LAST | `ORDER BY ... NULLS LAST` | ручная сортировка |

Код в `adminMetrics.ts` использует флаг `USE_SQLITE` для выбора правильного синтаксиса.

---

## 8. Тестовые запросы

```bash
# Обзор
curl -H "Authorization: Bearer <admin-token>" \
  "https://pulse-api-bsov.onrender.com/admin/metrics?section=overview&period=30"

# Online
curl -H "Authorization: Bearer <admin-token>" \
  "https://pulse-api-bsov.onrender.com/admin/metrics?section=online&period=30"

# MRR
curl -H "Authorization: Bearer <admin-token>" \
  "https://pulse-api-bsov.onrender.com/admin/metrics?section=mrr&period=30"

# Churn
curl -H "Authorization: Bearer <admin-token>" \
  "https://pulse-api-bsov.onrender.com/admin/metrics?section=churn&period=30"

# Flow (ТЗ-122): агрегат
curl -H "Authorization: Bearer <admin-token>" \
  "https://pulse-api-bsov.onrender.com/admin/metrics/flow?period=7"

# Flow: таймлайн конкретного пользователя (per-user, без кэша)
curl -H "Authorization: Bearer <admin-token>" \
  "https://pulse-api-bsov.onrender.com/admin/metrics/flow?period=7&user_id=<uuid>"

# At-risk accounts
curl -H "Authorization: Bearer <admin-token>" \
  "https://pulse-api-bsov.onrender.com/admin/metrics/at-risk-accounts?type=dormant_7d&limit=50"
```

---

## 9. Связанные документы

- `TZ_V6_METRICS.md` — техническое задание на 6 новых метрик.
- `TZ_ADMIN_ANALYTICS_v4.md` — базовое ТЗ аналитики.
- `TZ_AT_RISK_MODAL.md` — модалка at-risk accounts.
- `TZ_метрикс_BUGFIX.md` — история багфиксов метрик.
- `pulse-frontend/src/pages/admin/ProductMetricsTab.tsx` — frontend.
