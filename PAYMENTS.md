# PULSE — Платежи и тарифы (Payments & Subscriptions)

## Оглавление

1. [Обзор архитектуры](#1-обзор-архитектуры)
2. [Модель тарифов 4+1](#2-модель-тарифов-41)
3. [Таблицы базы данных](#3-таблицы-базы-данных)
4. [Flow DEMO (имитация оплаты)](#4-flow-demo-имитация-оплаты)
5. [Flow REAL (реальные платежи через YuKassa)](#5-flow-real-реальные-платежи-через-yukassa)
6. [Апгрейд и даунгрейд](#6-апгрейд-и-даунгрейд)
7. [API Endpoints](#7-api-endpoints)
8. [Активация подписки](#8-активация-подписки)
9. [Grace period и напоминания](#9-grace-period-и-напоминания)
10. [Автопродление и сохранённые карты](#10-автопродление-и-сохранённые-карты)
11. [Web-push (VAPID)](#11-web-push-vapid)
12. [Webhook auto-setup](#12-webhook-auto-setup)
13. [Переменные окружения](#13-переменные-окружения)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Обзор архитектуры

Система платежей и подписок PULSE работает в одном из двух режимов.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PULSE Payment & Subscription System                     │
│                                                                             │
│   ┌─────────────────────┐            ┌─────────────────────┐               │
│   │    DEMO mode        │            │    REAL mode        │               │
│   │  (default)          │            │  (YuKassa настроена)│               │
│   │                     │            │                     │               │
│   │  YOOKASSA_SHOP_ID   │    ───►    │  YOOKASSA_SHOP_ID   │               │
│   │       NOT set       │            │       IS set        │               │
│   │                     │            │                     │               │
│   │  • Имитация оплаты  │            │  • Реальные платежи │               │
│   │  • Подписка сразу   │            │  • Webhook + polling│               │
│   │  • Без YuKassa      │            │  • Сохранение карт  │               │
│   └─────────────────────┘            └─────────────────────┘               │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Переключение режимов

| Режим | Условие | Поведение |
|-------|---------|-----------|
| **DEMO** | `YOOKASSA_SHOP_ID` не задан | Имитация оплаты, подписка активируется мгновенно |
| **REAL** | `YOOKASSA_SHOP_ID` и `YOOKASSA_SECRET_KEY` заданы | Реальные платежи через YuKassa API |

### REAL mode flow

```
Frontend                         Backend                         YuKassa
────────                         ───────                         ───────
  │                                │                                │
  │ POST /payment/create           │                                │
  │ { planId, billingCycle }       │                                │
  │───────────────────────────────►│                                │
  │                                │ POST /v3/payments              │
  │                                │───────────────────────────────►│
  │                                │◄───────────────────────────────│
  │ { confirmation_url }           │
  │◄───────────────────────────────│
  │                                │
  │ Редирект на checkout           │
  │────────────────────────────────────────────────────────────────►│
  │                                │                                │
  │                                │ payment.succeeded (webhook)    │
  │                                │◄───────────────────────────────│
  │                                │
  │ Polling GET /status/:id        │
  │───────────────────────────────►│
  │                                │
```

---

## 2. Модель тарифов 4+1

Каталог тарифов хранится в `subscription_plans`. В UI отображаются 5 карточек: `free`, `base`, `premium`, `club`, `pro`. `club` и `pro` пока скрыты (`is_active = FALSE`, `coming_soon_label = 'Скоро'`).

| Тариф | Месяц | Год | Теги | Telegram | Push | AI summary | Alerts | Приоритет |
|-------|-------|-----|------|----------|------|------------|--------|-----------|
| `free` | 0 ₽ | 0 ₽ | 3 | — | — | — | — | normal |
| `base` | 100 ₽ | 960 ₽ | 10 | ✅ | ✅ | — | — | normal |
| `premium` | 990 ₽ | 9504 ₽ | 25 | ✅ | ✅ | ✅ | ✅ | high |
| `club` | 2500 ₽ | 24000 ₽ | ∞ | ✅ | ✅ | ✅ | ✅ | max + club |
| `pro` | 2500 ₽ | 24000 ₽ | ∞ | ✅ | ✅ | ✅ | ✅ | max + api |

### Уровни тарифов

```typescript
{ free: 0, base: 1, premium: 2, club: 3, pro: 4 }
```

Апгрейд — переход на более высокий уровень. Даунгрейд — на более низкий (в т.ч. на `free`).

### Периоды

- `monthly` — 30 дней
- `yearly` — 365 дней (скидка ~20%)

### Апгрейд (prorated)

При апгрейде пользователь доплачивает разницу за оставшиеся дни текущего периода:

```
topUp = (targetPrice - currentPrice) * (daysLeft / periodDays)
```

После успешной оплаты период **обнуляется** до полного нового срока (30 или 365 дней) — это важно, потому что prorated-доплата уже компенсирует оставшиеся дни.

### Даунгрейд

При запросе понижения тарифа флаг `scheduled_plan_downgrade` устанавливается в целевой план. Реальное понижение происходит **только после окончания оплаченного периода** (cron `processScheduledDowngrades`).

При даунгрейде лишние теги (сверх лимита нового тарифа) замораживаются (`portfolios.is_frozen = TRUE`). Замороженные теги не участвуют в персональной ленте, но сохраняют порядок и историю.

---

## 3. Таблицы базы данных

### 3.1 `subscription_plans`

```sql
CREATE TABLE subscription_plans (
  id                VARCHAR(20) PRIMARY KEY,
  name              VARCHAR(50) NOT NULL,
  price_monthly     DECIMAL(10,2) NOT NULL,
  price_yearly      DECIMAL(10,2) NOT NULL,
  yearly_discount   INTEGER DEFAULT 20,
  tag_limit         INTEGER NOT NULL,        -- -1 = безлимит
  features          JSONB NOT NULL DEFAULT '{}',
  display_order     INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN DEFAULT TRUE,
  coming_soon_label VARCHAR(50) DEFAULT NULL,
  created_at        TIMESTAMP DEFAULT NOW()
);
```

### 3.2 `users` (релевантные поля)

```sql
ALTER TABLE users
  ADD COLUMN subscription_plan VARCHAR(20) DEFAULT 'free',
  ADD COLUMN subscription_active BOOLEAN DEFAULT FALSE,
  ADD COLUMN subscription_expires_at TIMESTAMP,
  ADD COLUMN subscription_auto_renew BOOLEAN DEFAULT FALSE,
  ADD COLUMN scheduled_plan_downgrade VARCHAR(20);
```

### 3.3 `payments`

```sql
CREATE TABLE payments (
  id              UUID PRIMARY KEY,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  amount          DECIMAL(10,2) NOT NULL,
  base_amount     DECIMAL(10,2) NOT NULL,
  discount        INTEGER DEFAULT 0,
  method          VARCHAR(50) NOT NULL,
  status          VARCHAR(20) DEFAULT 'pending',
  provider_ref    VARCHAR(255),
  plan_id         VARCHAR(20) REFERENCES subscription_plans(id),
  billing_cycle   VARCHAR(10) DEFAULT 'monthly',
  duration_days   INTEGER DEFAULT 30,
  is_upgrade      BOOLEAN DEFAULT FALSE,
  paid_at         TIMESTAMP,
  created_at      TIMESTAMP DEFAULT NOW()
);
```

### 3.4 Вспомогательные таблицы

| Таблица | Назначение |
|---------|-----------|
| `subscription_renewals` | История продлений/апгрейдов (связь payment + period) |
| `user_payment_methods` | Сохранённые карты YuKassa для будущего автопродления |
| `frozen_tags` | Audit-log замороженных при даунгрейде тегов |
| `push_subscriptions` | VAPID web-push подписки |
| `subscription_notifications_sent` | Дедупликация reminder-уведомлений |
| `webhook_events` | Audit-log входящих webhook |

---

## 4. Flow DEMO (имитация оплаты)

Активируется, когда `YOOKASSA_SHOP_ID` не задан.

### Шаг 1 — Создание платежа

```http
POST /api/payment/create
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "planId": "premium",
  "billingCycle": "monthly",
  "isUpgrade": false
}
```

Response:

```json
{
  "demo": true,
  "payment": { "id": "...", "amount": 990, "status": "pending" },
  "confirmation_url": "https://pulse-frontend-jt53.onrender.com/#/payment/return?demo=1&payment_id=...&return=1"
}
```

### Шаг 2 — Return Page

Фронтенд на `/payment/return?demo=1&payment_id=...` показывает тестовую карту и кнопку "Оплатить (демо)".

### Шаг 3 — Подтверждение

```http
POST /api/payment/confirm
Authorization: Bearer <jwt>
Content-Type: application/json

{ "paymentId": "..." }
```

Backend:

```sql
UPDATE payments SET status='completed', paid_at=NOW() WHERE id='...';
-- activateSubscription(plan_id, duration_days, paymentId, isUpgrade)
```

Response:

```json
{
  "success": true,
  "message": "Subscription activated",
  "payment": { "id": "...", "plan_id": "premium", "billing_cycle": "monthly", "status": "completed" }
}
```

---

## 5. Flow REAL (реальные платежи через YuKassa)

### Шаг 1 — Создание платежа

```http
POST /api/payment/create
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "planId": "premium",
  "billingCycle": "yearly",
  "isUpgrade": false
}
```

Backend формирует чек (54-ФЗ), `receipt`, `save_payment_method='on'`, `merchant_customer_id`, `metadata` с `is_upgrade`.

Response:

```json
{
  "payment": { "id": "...", "amount": 9504, "status": "pending" },
  "confirmation_url": "https://yoomoney.ru/checkout/..."
}
```

### Шаг 2 — Редирект на YuKassa Checkout

### Шаг 3 — Return URL

После оплаты YuKassa редиректит на:

```
https://pulse.inside-trade.ru/#/payment/return?payment_id=...&return=1
```

> URL берётся из переменной `FRONTEND_URL`. Убедитесь, что в Render она равна `https://pulse.inside-trade.ru`, иначе пользователь уйдёт на старый onrender-домен.

Фронтенд начинает polling `GET /api/payment/status/:id` каждые 2 сек × 15 попыток.

### Шаг 4 — Активация

См. раздел [8. Активация подписки](#8-активация-подписки).

---

## 6. Апгрейд и даунгрейд

### 6.1 Апгрейд

```http
POST /api/payment/create
{
  "planId": "premium",
  "billingCycle": "monthly",
  "isUpgrade": true
}
```

Если `isUpgrade=true` и текущий план не ниже целевого — ошибка `400 Invalid upgrade direction`.

Сумма рассчитывается как prorated-доплата. После успешной оплаты:

- `subscription_expires_at = NOW() + 30/365 дней` (обнуление)
- `scheduled_plan_downgrade = NULL`
- замороженные теги размораживаются в пределах нового лимита

### 6.2 Расчёт доплаты

```http
GET /api/payment/upgrade-preview?targetPlan=premium&billingCycle=monthly
```

Response:

```json
{
  "currentPlan": "base",
  "targetPlan": "premium",
  "billingCycle": "monthly",
  "daysLeft": 15,
  "topUpAmount": 270,
  "fullPrice": 990,
  "newPeriodDays": 30,
  "description": "Доплата base → premium (15 дн. осталось)",
  "canUpgrade": true
}
```

### 6.3 Даунгрейд

```http
POST /api/user/downgrade
{
  "targetPlan": "base"
}
```

Проверить, какие теги заморозятся:

```http
GET /api/user/downgrade-preview?targetPlan=base
```

Response:

```json
{
  "targetPlan": "base",
  "tags": [
    { "tagId": "t1", "tagName": "Apple", "tagType": "company" }
  ]
}
```

Отмена запланированного даунгрейда:

```http
POST /api/user/downgrade/cancel
```

---

## 7. API Endpoints

### 7.1 `GET /api/plans`

Публичный список тарифов.

```json
{
  "plans": [
    {
      "id": "free",
      "name": "Free",
      "priceMonthly": 0,
      "priceYearly": 0,
      "yearlyDiscount": 20,
      "tagLimit": 3,
      "features": { "telegram": false, "push": false, ... },
      "isActive": true,
      "comingSoonLabel": null
    },
    { ... }
  ]
}
```

### 7.2 `POST /api/payment/create`

Создание платежа.

| Поле | Тип | Обязательное | Описание |
|------|-----|:------------:|----------|
| `planId` | `string` | Да | `free`/`base`/`premium`/`club`/`pro` |
| `billingCycle` | `string` | Да | `monthly` или `yearly` |
| `isUpgrade` | `boolean` | Нет | `true` для prorated-апгрейда |

Response (DEMO):

```json
{
  "demo": true,
  "payment": { "id": "...", "amount": 990, "status": "pending" },
  "confirmation_url": "..."
}
```

Response (REAL):

```json
{
  "payment": { "id": "...", "amount": 990, "status": "pending" },
  "confirmation_url": "https://yoomoney.ru/checkout/..."
}
```

### 7.3 `GET /api/payment/upgrade-preview`

Расчёт доплаты.

Query: `targetPlan`, `billingCycle`.

### 7.4 `POST /api/payment/confirm`

Demo-подтверждение.

### 7.5 `GET /api/payment/status/:id`

Polling статуса.

### 7.6 `POST /api/payment/force-check`

Ручная проверка у YuKassa.

### 7.7 `GET /api/payment/history`

История платежей пользователя.

### 7.8 `GET /api/user/tariff-status`

Полный статус тарифа для профиля.

```json
{
  "subscription": {
    "plan": "premium",
    "active": true,
    "expiresAt": "2026-08-15T10:00:00.000Z",
    "autoRenew": false,
    "daysLeft": 28,
    "inGracePeriod": false,
    "scheduledDowngrade": null
  },
  "plan": {
    "id": "premium",
    "name": "Premium",
    "tagLimit": 25,
    "features": { ... }
  },
  "tagUsage": { "active": 5, "frozen": 0, "limit": 25 },
  "savedMethods": [ ... ],
  "renewals": [ ... ]
}
```

### 7.9 `GET /api/user/downgrade-preview`

Какие теги заморозятся при даунгрейде.

### 7.10 `POST /api/user/downgrade`

Запланировать даунгрейд.

### 7.11 `POST /api/user/downgrade/cancel`

Отменить запланированный даунгрейд.

### 7.12 `POST /api/user/auto-renew`

Включить/выключить автопродление (только флаг, реальное автосписание — заглушка).

### 7.13 `DELETE /api/user/payment-methods/:id`

Удалить сохранённую карту.

---

## 8. Активация подписки

Три пути активации:

1. **Webhook** (primary, async) — YuKassa POST `/api/webhook/yookassa`
2. **Polling** (fallback, sync) — `GET /api/payment/status/:id`
3. **Force-check** (manual) — `POST /api/payment/force-check`

Все три вызывают единую функцию `activateSubscription(userId, planId, durationDays, paymentId?, isUpgrade?)`.

### Логика активации

```typescript
if (isUpgrade) {
  // Апгрейд: обнуляем период
  newExpires = now + durationDays
} else {
  // Продление: накапливаем дни
  newExpires = max(currentExpires, now) + durationDays
}

await query(`
  UPDATE users
  SET subscription_active = TRUE,
      subscription_plan = $1,
      subscription_expires_at = $2,
      scheduled_plan_downgrade = NULL
  WHERE id = $3
`, [planId, newExpires, userId])

// Разморозить теги, которые помещаются в новый лимит
await unfreezeTagsUpToLimit(userId, planId)

// Сбросить reminder-уведомления, чтобы они пришли перед следующим сроком
await query(`
  DELETE FROM subscription_notifications_sent
  WHERE user_id = $1 AND type IN ('reminder_3d', 'reminder_1d')
`, [userId])

// Записать renewal
await query(`
  INSERT INTO subscription_renewals (...)
  SELECT ... FROM payments WHERE id = $5
`, [...])
```

### Webhook

```http
POST /api/webhook/yookassa
Content-Type: application/json

{
  "type": "notification",
  "event": "payment.succeeded",
  "object": {
    "id": "2a4b6c8d-...",
    "status": "succeeded",
    "metadata": { "payment_id": "...", "is_upgrade": "true" }
  }
}
```

Backend:

- Проверяет IP-адрес YuKassa.
- Проверяет `type === 'notification'`.
- Игнорирует повторные `payment.succeeded` (idempotency по `payments.status = 'completed'`).
- Сохраняет payment method, если `object.payment_method.saved === true`.
- Активирует подписку.

> ⚠️ **ВАЖНО:** Webhook всегда возвращает 200 OK, даже при ошибках обработки. Иначе YuKassa будет ретраить.

---

## 9. Grace period и напоминания

### Grace period

После истечения `subscription_expires_at` у пользователя есть 3 дня grace period, в течение которых функции подписки всё ещё работают.

UI показывает: "Grace-период: осталось N дн.".

### Напоминания

Cron `sendSubscriptionReminders` запускается ежедневно в 10:00 UTC.

- `reminder_3d` — за 3 дня до истечения
- `reminder_1d` — за 1 день до истечения
- `grace_1d` / `grace_3d` — в grace period

Уведомления отправляются:

- В Telegram (если подключен `user_channels`)
- Push Firebase/FCM (если есть токен и `push_enabled`)
- Web-push VAPID (если есть `push_subscriptions`)

Дедупликация через `subscription_notifications_sent(user_id, type)`. При каждом успешном продлении reminder-записи сбрасываются, чтобы напоминания приходили перед следующим сроком.

### Cron даунгрейда

В том же ежедневном cron выполняется `processScheduledDowngrades()`:

- Находит пользователей с `scheduled_plan_downgrade IS NOT NULL` и `subscription_expires_at < NOW()`.
- Меняет `subscription_plan` на целевой.
- Замораживает теги сверх лимита.

---

## 10. Автопродление и сохранённые карты

### Сохранение карты

При REAL-оплате YuKassa возвращает `payment_method`. Если `saved === true`, backend сохраняет его в `user_payment_methods`.

### Автопродление

Флаг `subscription_auto_renew` хранится в `users` и переключается через `POST /api/user/auto-renew`.

> ⚠️ **Важно:** реальное автосписание (recurring payments) пока не реализовано. ЮKassa должна одобрить recurring-платежи, прежде чем включать автосписание. Флаг готов, cron-задача — заглушка.

---

## 11. Web-push (VAPID)

Браузерные push-уведомления работают через VAPID, отдельно от Firebase/FCM.

### Настройка

```bash
VAPID_PUBLIC_KEY=BK...
VAPID_PRIVATE_KEY=FH...
VAPID_SUBJECT=mailto:admin@pulse.app
```

Генерация ключей:

```bash
npx web-push generate-vapid-keys
```

### Flow

1. Фронтенд регистрирует `public/service-worker.js`.
2. Подписывается через `PushManager.subscribe()` с `applicationServerKey`.
3. Отправляет `{ endpoint, p256dh, auth }` на `POST /api/user/push-subscribe`.
4. Backend сохраняет в `push_subscriptions`.

### Endpoint

```http
GET /api/user/vapid-public-key
```

---

## 12. Webhook setup

Управление webhooks в YuKassa (`/v3/webhooks`) работает **только через OAuth**. Basic Auth (Shop ID + Secret Key) подходит для создания платежей, но не для регистрации webhook через API.

Поэтому backend **не регистрирует webhook автоматически** при старте. Webhook уже добавлен вручную в личном кабинете YuKassa:

| Параметр | Значение |
|----------|----------|
| URL | `https://pulse-api-bsov.onrender.com/api/webhook/yookassa` |
| События | `payment.succeeded`, `payment.canceled` |

Входящие уведомления от YuKassa приходят на backend, где:

- проверяется IP-адрес отправителя (только сети YuKassa);
- событие логируется в `webhook_events`;
- при `payment.succeeded` активируется подписка.

Если в будущем появится `YOOKASSA_OAUTH_TOKEN`, backend сможет автоматически проверять и обновлять webhook при старте.

---

## 13. Переменные окружения

### YuKassa

| Переменная | Описание |
|------------|----------|
| `YOOKASSA_SHOP_ID` | ID магазина |
| `YOOKASSA_SECRET_KEY` | Секретный ключ для API платежей |
| `YOOKASSA_OAUTH_TOKEN` | OAuth-токен для авто-настройки webhook (опционально) |

### URLs

| Переменная | Описание |
|------------|----------|
| `FRONTEND_URL` | URL фронтенда |
| `BACKEND_URL` | URL backend |

### Web-push

| Переменная | Описание |
|------------|----------|
| `VAPID_PUBLIC_KEY` | Публичный VAPID-ключ |
| `VAPID_PRIVATE_KEY` | Приватный VAPID-ключ |
| `VAPID_SUBJECT` | `mailto:` контакт |

### Пример `.env`

```bash
YOOKASSA_SHOP_ID=1402795
YOOKASSA_SECRET_KEY=live_xxx...
# YOOKASSA_OAUTH_TOKEN=                      # опционально, для авто-настройки webhook

FRONTEND_URL=https://pulse.inside-trade.ru
BACKEND_URL=https://pulse-api-bsov.onrender.com

VAPID_PUBLIC_KEY=BK...
VAPID_PRIVATE_KEY=FH...
VAPID_SUBJECT=mailto:admin@pulse.app
```

---

## 14. Troubleshooting

### Платёж completed, но подписка не активна

```sql
SELECT id, status, plan_id, billing_cycle, duration_days, is_upgrade, paid_at
FROM payments
WHERE id = '...';

SELECT subscription_plan, subscription_active, subscription_expires_at,
       scheduled_plan_downgrade
FROM users
WHERE id = '...';
```

### Webhook не приходит

1. Убедитесь, что webhook в ЛК YuKassa всё ещё активен:
   - URL: `https://pulse-api-bsov.onrender.com/api/webhook/yookassa`
   - События: `payment.succeeded`, `payment.canceled`
2. Проверьте доступность endpoint:
   ```bash
   curl -I https://pulse-api-bsov.onrender.com/api/webhook/yookassa
   ```
3. Проверьте, что запрос снаружи отклоняется по IP (должен вернуть 403):
   ```bash
   curl -X POST https://pulse-api-bsov.onrender.com/api/webhook/yookassa \
     -H "Content-Type: application/json" \
     -d '{"type":"notification","event":"payment.succeeded","object":{"id":"test"}}'
   ```
4. Посмотрите логи Render на строки `[YooKassa Webhook]` и таблицу `webhook_events`.

### Повторный webhook не должен продлевать подписку

Проверка:

```sql
SELECT status FROM payments WHERE provider_ref = '...';
-- Если 'completed' — activateSubscription не вызывается повторно.
```

### Диагностика даунгрейда

```sql
SELECT scheduled_plan_downgrade, subscription_expires_at
FROM users WHERE id = '...';

SELECT tag_name, frozen_at FROM frozen_tags
WHERE user_id = '...' AND unfrozen_at IS NULL;
```

### Ручная активация (если нужно)

```sql
UPDATE users
SET subscription_active = TRUE,
    subscription_plan = 'premium',
    subscription_expires_at = NOW() + INTERVAL '30 days',
    scheduled_plan_downgrade = NULL
WHERE id = '...';
```
