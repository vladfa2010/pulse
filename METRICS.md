# PULSE — Product Metrics (Admin Analytics)

> Дата актуализации: 2026-07-23  
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

**Доступные секции:**

```
overview, daily, funnel, retention, sentiment, tags, revenue, adoption,
online, plans, mrr, promos, engagement, churn
```

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

## 3. Секции

### 3.1 `overview`

Ключевые продуктовые KPI.

| Поле | Источник | Описание |
|------|----------|----------|
| `total_users` | `users` | Всего пользователей |
| `dau` | `user_logins` | Уникальные за 24ч |
| `wau` | `user_logins` | Уникальные за 7 дней |
| `mau` | `user_logins` | Уникальные за 30 дней |
| `new_users_today` | `users` | Зарегистрированы сегодня |
| `new_users_week` | `users` | Зарегистрированы за 7 дней |
| `active_subscriptions` | `users` | `subscription_active = TRUE` |
| `push_subscribers` | `push_subscriptions` | Активные push-подписки |
| `total_revenue` | `payments` | Сумма `completed` за период |
| `dormant_7d` | `users` | Не заходили 7+ дней |
| `dormant_30d` | `users` | Не заходили 30+ дней |
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

---

### 3.4 `retention`

Когорты по дню регистрации, retention D1/D7/D30.

```json
{
  "retention": [
    { "cohort": "2026-07-15", "d1": 45.2, "d7": 28.5, "d30": 12.1 }
  ]
}
```

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

- `online_now` — `COUNT(DISTINCT user_id)` из `user_sessions` с `last_connected_at` в последние 5 минут.
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
  "arr": 540000,
  "trend": [{ "month": "2026-07-01", "mrr": 45000 }]
}
```

**Логика:**

| `billing_cycle` | MRR-вклад |
|-----------------|-----------|
| `monthly` | `amount` |
| `yearly` | `amount / 12` |
| `quarterly` | `amount / 3` |
| `weekly` | `amount × 30 / 7` |
| `NULL` / `one_time` / другое | `amount × 30 / duration_days` (fallback) |

MRR берётся за последние 30 дней; trend — по месяцам, последние 6.

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

**Логика:**

- `uses` — уникальные пользователи в `user_promo_uses`.
- `converted_to_paid` — из них те, у кого есть `completed` платёж.
- `revenue` — сумма всех `completed` платежей пользователей, применивших промокод.

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

Все 14 секций отображаются на одной странице админки.

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
