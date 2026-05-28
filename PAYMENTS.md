# PULSE Payment System — Техническая документация

## Оглавление

1. [Обзор архитектуры](#1-обзор-архитектуры)
2. [Таблицы базы данных](#2-таблицы-базы-данных)
3. [Flow DEMO (имитация оплаты)](#3-flow-demo-имитация-оплаты)
4. [Flow REAL (реальные платежи через YuKassa)](#4-flow-real-реальные-платежи-через-yukassa)
5. [API Endpoints](#5-api-endpoints)
6. [Активация подписки](#6-активация-подписки)
7. [Webhook auto-setup](#7-webhook-auto-setup)
8. [Тестовые карты YuKassa](#8-тестовые-карты-yukassa)
9. [Переменные окружения](#9-переменные-окружения)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Обзор архитектуры

Система платежей PULSE работает в одном из двух режимов, определяемых наличием
credentials YuKassa в переменных окружения.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        PULSE Payment System                                 │
│                                                                             │
│   ┌─────────────────────┐            ┌─────────────────────┐               │
│   │    DEMO mode        │            │    REAL mode        │               │
│   │  (default)          │            │  (YuKassa настроена)│               │
│   │                     │            │                     │               │
│   │  YOOKASSA_SHOP_ID   │            │  YOOKASSA_SHOP_ID   │               │
│   │       NOT set       │    ───►    │       IS set        │               │
│   │                     │            │                     │               │
│   │  • Имитация оплаты  │            │  • Реальные платежи │               │
│   │  • Premium сразу    │            │  • Через API        │               │
│   │  • Без YuKassa      │            │  • Webhook + polling│               │
│   └─────────────────────┘            └─────────────────────┘               │
│                                                                             │
│   Переключение: установить YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Переключение режимов

| Режим | Условие | Поведение |
|-------|---------|-----------|
| **DEMO** | `YOOKASSA_SHOP_ID` **не задан** или пуст | Имитация оплаты, Premium активируется мгновенно |
| **REAL** | `YOOKASSA_SHOP_ID` **и** `YOOKASSA_SECRET_KEY` заданы | Реальные платежи через API YuKassa |

### Общая архитектура (REAL mode)

```
┌──────────────┐     POST /payment/create      ┌──────────────┐
│   Frontend   │ ─────────────────────────────►│   Backend    │
│  (React App) │                               │  (PULSE API) │
└──────────────┘                               └──────┬───────┘
       ▲                                              │
       │                                              │ YuKassa API
       │  3. Redirect                                 │  (create payment)
       │  6. Polling (2s x 15)                        │
       │  7. Force-check                              ▼
       │                                      ┌──────────────┐
       └──────────────────────────────────────│   YuKassa    │
                                              │   (Kassa)    │
                                              └──────┬───────┘
                                                     │
                                                     │ payment.succeeded
                                              4. Webhook (async)
                                                     │
                                              ┌──────▼───────┐
                                              │   Backend    │
                                              │  /webhook/   │
                                              │   yookassa   │
                                              └──────────────┘
```

---

## 2. Таблицы базы данных

### 2.1 Таблица `payments`

```sql
CREATE TABLE payments (
  id               UUID PRIMARY KEY,
  user_id          UUID REFERENCES users(id),
  amount           INTEGER,          -- итоговая сумма (со скидкой)
  base_amount      INTEGER,          -- базовая сумма до скидки
  discount         INTEGER,          -- скидка в процентах
  method           VARCHAR(50),      -- 'bank_card'
  status           VARCHAR(20),      -- 'pending' | 'completed' | 'failed'
  provider_ref     VARCHAR,          -- ID платежа в YuKassa
  paid_at          TIMESTAMP,
  created_at       TIMESTAMP DEFAULT NOW()
);
```

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | `UUID PK` | Уникальный ID платежа (генерирует backend) |
| `user_id` | `UUID FK → users.id` | Владелец платежа |
| `amount` | `INTEGER` | Итоговая сумма в копейках (со скидкой) |
| `base_amount` | `INTEGER` | Базовая сумма в копейках (до скидки) |
| `discount` | `INTEGER` | Размер скидки в процентах (0-100) |
| `method` | `VARCHAR(50)` | Способ оплаты (`'bank_card'`) |
| `status` | `VARCHAR(20)` | Статус: `pending` \| `completed` \| `failed` |
| `provider_ref` | `VARCHAR` | ID платежа в YuKassa (заполняется в REAL mode) |
| `paid_at` | `TIMESTAMP` | Дата/время успешной оплаты |
| `created_at` | `TIMESTAMP` | Дата/время создания записи |

### 2.2 Таблица `users` (поля подписки)

```sql
-- Только релевантные поля (остальные опущены)
CREATE TABLE users (
  id                       UUID PRIMARY KEY,
  -- ... другие поля ...
  subscription_active      BOOLEAN DEFAULT FALSE,
  subscription_expires_at  TIMESTAMP
);
```

| Колонка | Тип | Описание |
|---------|-----|----------|
| `subscription_active` | `BOOLEAN` | Активна ли Premium подписка |
| `subscription_expires_at` | `TIMESTAMP` | Дата окончания подписки |

> ⚠️ **CRITICAL BUG FIX:** `subscription_active = TRUE` (не `1`!)  
> PostgreSQL тип `BOOLEAN` требует литералы `TRUE`/`FALSE`, не `1`/`0`.  
> Использование `1` вызывает ошибку типа при UPDATE.

### 2.3 ER-диаграмма

```
┌──────────────────────────┐         ┌──────────────────────────┐
│         users            │         │        payments          │
├──────────────────────────┤         ├──────────────────────────┤
│ PK  id              UUID │◄────────┤ FK  user_id         UUID │
│     ...                  │    1:M  │     amount         INT   │
│     subscription_active  │         │     base_amount    INT   │
│     subscription_expires │         │     discount       INT   │
│                          │         │     method         VARCHAR│
│                          │         │     status         VARCHAR│
│                          │         │     provider_ref   VARCHAR│
│                          │         │     paid_at        TS     │
│                          │         │     created_at     TS     │
└──────────────────────────┘         └──────────────────────────┘
```

---

## 3. Flow DEMO (имитация оплаты)

Активируется, когда `YOOKASSA_SHOP_ID` **не задан** в переменных окружения.

```
Шаг 1          Шаг 2              Шаг 3              Шаг 4
───────        ─────              ─────              ─────
Фронтенд  →  Backend        →  Return Page      →  Backend
создаёт      создаёт запись    (demo=1)           активирует
платёж       в payments        показывает         подписку
             demo=true         тестовые данные
             confirmation_url  карты + кнопку
             с demo=1          "Оплатить (демо)"
```

### Пошаговый разбор

#### Шаг 1 — Создание платежа

**Request:**
```http
POST /api/payment/create
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "amount": 99000,       // 990 ₽ в копейках
  "base_amount": 99000,
  "discount": 0,
  "method": "bank_card"
}
```

**Response (DEMO mode):**
```json
{
  "demo": true,
  "payment_id": "550e8400-e29b-41d4-a716-446655440000",
  "confirmation_url": "https://pulse-frontend-jt53.onrender.com/payment/return?demo=1&payment_id=550e8400-e29b-41d4-a716-446655440000"
}
```

#### Шаг 2 — Backend создаёт запись

```sql
INSERT INTO payments (id, user_id, amount, base_amount, discount,
                      method, status, created_at)
VALUES (
  '550e8400-e29b-41d4-a716-446655440000',  -- payment_id
  '123e4567-e89b-12d3-a456-426614174000',  -- user_id (из JWT)
  99000,                                    -- amount (копейки)
  99000,                                    -- base_amount
  0,                                        -- discount (%)
  'bank_card',                              -- method
  'pending',                                -- status
  NOW()                                     -- created_at
);
```

#### Шаг 3 — Return Page (фронтенд)

URL: `https://pulse-frontend-jt53.onrender.com/payment/return?demo=1&payment_id=550e8400-e29b-41d4-a716-446655440000`

Фронтенд обнаруживает `demo=1` и отображает:

```
┌─────────────────────────────────────────┐
│         💳 ТЕСТОВАЯ ОПЛАТА (DEMO)      │
│                                         │
│   Номер карты:  5555 5555 5555 4477     │
│   Срок:         12 / 25                 │
│   CVV:          000                     │
│                                         │
│   Сумма: 990 ₽                          │
│                                         │
│   [  ✅  Оплатить (демо)  ]             │
│                                         │
│   Данные кликабельны для копирования    │
└─────────────────────────────────────────┘
```

#### Шаг 4 — Подтверждение оплаты

**Request:**
```http
POST /api/payment/confirm
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "payment_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Backend выполняет:**
```sql
-- Обновить статус платежа
UPDATE payments
SET status = 'completed',
    paid_at = NOW()
WHERE id = '550e8400-e29b-41d4-a716-446655440000';

-- Активировать подписку (CRITICAL: TRUE, не 1!)
UPDATE users
SET subscription_active = TRUE,
    subscription_expires_at = NOW() + INTERVAL '30 days'
WHERE id = '123e4567-e89b-12d3-a456-426614174000';
```

**Response:**
```json
{
  "success": true,
  "status": "completed",
  "subscription_active": true,
  "subscription_expires_at": "2025-02-15T14:30:00.000Z"
}
```

---

## 4. Flow REAL (реальные платежи через YuKassa)

Активируется, когда **обе** переменные заданы: `YOOKASSA_SHOP_ID` и `YOOKASSA_SECRET_KEY`.

```
┌─────────┐    create     ┌──────────┐   YuKassa API   ┌──────────┐
│ Frontend│ ────────────► │ Backend  │ ───────────────►│ YuKassa  │
└─────────┘               └──────────┘                 └──────────┘
     ▲                                                      │
     │ redirect                                              │ payment
     │ confirmation_url                                     │ processing
     │                                                     │
┌────┴─────────────────────────────┐                       │
│  YuKassa Checkout Page           │◄──────────────────────┘
│  (пользователь вводит карту)     │
└───────────────┬──────────────────┘
                │ redirect to return_url
                ▼
┌───────────────┴──────────────────┐
│  PULSE Return Page               │
│  Frontend начинает polling       │
│  GET /payment/status/:id         │
│  каждые 2 сек x 15 попыток       │
└──────────────────────────────────┘
                │
                │  Webhook (async)  OR  Polling (sync fallback)
                ▼
┌──────────────────────────────────┐
│  Активация подписки              │
│  subscription_active = TRUE      │
│  subscription_expires_at = +30d  │
└──────────────────────────────────┘
```

### Пошаговый разбор

#### Шаг 1 — Создание платежа

**Request:**
```http
POST /api/payment/create
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "amount": 99000,
  "base_amount": 99000,
  "discount": 0,
  "method": "bank_card"
}
```

**Backend → YuKassa API:**
```http
POST https://api.yookassa.ru/v3/payments
Authorization: Basic <base64(SHOP_ID:SECRET_KEY)>
Idempotence-Key: <payment_id>
Content-Type: application/json

{
  "amount": {
    "value": "990.00",
    "currency": "RUB"
  },
  "confirmation": {
    "type": "redirect",
    "return_url": "https://pulse-frontend-jt53.onrender.com/payment/return?payment_id=550e8400-e29b-41d4-a716-446655440000"
  },
  "capture": true,
  "description": "PULSE Premium — 30 дней"
}
```

**Response от YuKassa:**
```json
{
  "id": "2a4b6c8d-0e1f-2a3b-4c5d-6e7f8a9b0c1d",
  "status": "pending",
  "amount": { "value": "990.00", "currency": "RUB" },
  "confirmation": {
    "type": "redirect",
    "confirmation_url": "https://yoomoney.ru/checkout/payments/v2/contract?orderId=2a4b6c8d..."
  },
  "created_at": "2025-01-16T14:30:00.000Z"
}
```

**Backend сохраняет `provider_ref`:**
```sql
INSERT INTO payments (id, user_id, amount, base_amount, discount,
                      method, status, provider_ref, created_at)
VALUES (
  '550e8400-e29b-41d4-a716-446655440000',
  '123e4567-e89b-12d3-a456-426614174000',
  99000, 99000, 0,
  'bank_card', 'pending',
  '2a4b6c8d-0e1f-2a3b-4c5d-6e7f8a9b0c1d',  -- ← provider_ref
  NOW()
);
```

**Response на фронтенд:**
```json
{
  "demo": false,
  "payment_id": "550e8400-e29b-41d4-a716-446655440000",
  "confirmation_url": "https://yoomoney.ru/checkout/payments/v2/contract?orderId=2a4b6c8d..."
}
```

#### Шаг 2 — Редирект на YuKassa Checkout

Фронтенд редиректит пользователя на `confirmation_url` — страницу ввода карты YuKassa.

#### Шаг 3 — Пользователь вводит карту

Пользователь заполняет форму на странице YuKassa и нажимает "Оплатить".

#### Шаг 4 — YuKassa редиректит на return_url

```
YuKassa ──► https://pulse-frontend-jt53.onrender.com/payment/return?payment_id=550e8400-e29b-41d4-a716-446655440000
```

Фронтенд на return page НЕ обнаруживает `demo=1`, поэтому:
1. Не показывает тестовые данные карты
2. Начинает **polling** статуса платежа

#### Шаг 5 — Активация подписки (webhook или polling)

См. раздел [6. Активация подписки](#6-активация-подписки).

---

## 5. API Endpoints

### 5.1 `POST /api/payment/create` — Создание платежа

Создаёт запись в `payments` и возвращает `confirmation_url` для оплаты.

**Request:**
```http
POST /api/payment/create
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "amount": 99000,
  "base_amount": 99000,
  "discount": 0,
  "method": "bank_card"
}
```

**Response (DEMO):**
```json
{
  "demo": true,
  "payment_id": "550e8400-e29b-41d4-a716-446655440000",
  "confirmation_url": "https://pulse-frontend-jt53.onrender.com/payment/return?demo=1&payment_id=550e8400-e29b-41d4-a716-446655440000"
}
```

**Response (REAL):**
```json
{
  "demo": false,
  "payment_id": "550e8400-e29b-41d4-a716-446655440000",
  "confirmation_url": "https://yoomoney.ru/checkout/payments/v2/contract?orderId=2a4b6c8d..."
}
```

| Поле | Тип | Обязательное | Описание |
|------|-----|:------------:|----------|
| `amount` | `integer` | Да | Итоговая сумма в копейках |
| `base_amount` | `integer` | Да | Базовая сумма до скидки в копейках |
| `discount` | `integer` | Да | Скидка в процентах (0-100) |
| `method` | `string` | Да | Способ оплаты: `'bank_card'` |

---

### 5.2 `POST /api/payment/confirm` — Demo-подтверждение

Работает **только в DEMO mode**. Имитирует успешную оплату и сразу активирует подписку.

**Request:**
```http
POST /api/payment/confirm
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "payment_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response (успех):**
```json
{
  "success": true,
  "status": "completed",
  "subscription_active": true,
  "subscription_expires_at": "2025-02-15T14:30:00.000Z"
}
```

**Response (REAL mode — отклонено):**
```json
{
  "error": "Demo confirmation is not available in REAL mode"
}
```

---

### 5.3 `GET /api/payment/status/:id` — Проверка статуса платежа

Используется фронтендом для **polling** статуса платежа. В REAL mode делает запрос к YuKassa API.

**Request:**
```http
GET /api/payment/status/550e8400-e29b-41d4-a716-446655440000
Authorization: Bearer <jwt_token>
```

**Response (DEMO — completed):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "amount": 99000,
  "paid_at": "2025-01-16T14:30:15.000Z",
  "demo": true
}
```

**Response (REAL — polling in progress):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "amount": 99000,
  "provider_ref": "2a4b6c8d-0e1f-2a3b-4c5d-6e7f8a9b0c1d",
  "demo": false
}
```

**Response (REAL — completed):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "amount": 99000,
  "paid_at": "2025-01-16T14:30:45.000Z",
  "provider_ref": "2a4b6c8d-0e1f-2a3b-4c5d-6e7f8a9b0c1d",
  "demo": false
}
```

---

### 5.4 `POST /api/payment/force-check` — Принудительная проверка

Ручная проверка статуса у YuKassa. Полезна, когда webhook не доставлен и polling завершился по таймауту.

**Request:**
```http
POST /api/payment/force-check
Content-Type: application/json
Authorization: Bearer <jwt_token>

{
  "payment_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Response (YuKassa подтвердила):**
```json
{
  "success": true,
  "status": "completed",
  "message": "Payment confirmed via YuKassa API",
  "subscription_activated": true
}
```

**Response (всё ещё pending):**
```json
{
  "success": true,
  "status": "pending",
  "message": "Payment is still pending in YuKassa"
}
```

**Response (отменён):**
```json
{
  "success": true,
  "status": "failed",
  "message": "Payment was canceled in YuKassa"
}
```

---

### 5.5 `GET /api/payment/history` — История платежей

Возвращает список всех платежей текущего пользователя (последние первыми).

**Request:**
```http
GET /api/payment/history
Authorization: Bearer <jwt_token>
```

**Response:**
```json
{
  "payments": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "amount": 99000,
      "base_amount": 99000,
      "discount": 0,
      "method": "bank_card",
      "status": "completed",
      "provider_ref": "2a4b6c8d-0e1f-2a3b-4c5d-6e7f8a9b0c1d",
      "paid_at": "2025-01-16T14:30:45.000Z",
      "created_at": "2025-01-16T14:30:00.000Z"
    },
    {
      "id": "660e8400-e29b-41d4-a716-446655440001",
      "amount": 69300,
      "base_amount": 99000,
      "discount": 30,
      "method": "bank_card",
      "status": "failed",
      "provider_ref": null,
      "paid_at": null,
      "created_at": "2025-01-10T09:15:00.000Z"
    }
  ]
}
```

---

## 6. Активация подписки

Реализована **тройная надёжность** активации — подписка активируется при любом из трёх событий:

```
┌──────────────────────────────────────────────────────────────┐
│                    Тройная активация                         │
│                                                              │
│  ┌──────────────┐                                            │
│  │  1. Webhook  │  ← PRIMARY (async)                        │
│  │     70%      │     YuKassa POST /webhook/yookassa         │
│  └──────┬───────┘                                            │
│         │                                                    │
│  ┌──────┴───────┐                                            │
│  │  2. Polling  │  ← FALLBACK (sync)                        │
│  │     25%      │     Frontend GET /status/:id каждые 2с     │
│  └──────┬───────┘                                            │
│         │                                                    │
│  ┌──────┴───────┐                                            │
│  │ 3. Force-check│  ← MANUAL                                  │
│  │      5%      │     Frontend POST /force-check             │
│  └──────────────┘                                            │
│                                                              │
│  Все три вызывают:                                           │
│  UPDATE users SET subscription_active = TRUE,                │
│                  subscription_expires_at = NOW() + 30d       │
│                                                              │
│  UPDATE payments SET status = 'completed', paid_at = NOW()   │
└──────────────────────────────────────────────────────────────┘
```

### 6.1 Webhook (Primary — async)

YuKassa асинхронно отправляет webhook при изменении статуса платежа.

**Endpoint:** `POST /api/webhook/yookassa`

**Request от YuKassa:**
```http
POST /api/webhook/yookassa
Content-Type: application/json

{
  "type": "notification",
  "event": "payment.succeeded",
  "object": {
    "id": "2a4b6c8d-0e1f-2a3b-4c5d-6e7f8a9b0c1d",
    "status": "succeeded",
    "amount": { "value": "990.00", "currency": "RUB" },
    "income_amount": { "value": "960.30", "currency": "RUB" },
    "paid": true,
    "created_at": "2025-01-16T14:30:00.000Z",
    "captured_at": "2025-01-16T14:30:45.000Z"
  }
}
```

**Обработка на backend:**

```javascript
// Псевдокод обработчика webhook
if (event === 'payment.succeeded') {
  // 1. Найти платёж по provider_ref
  const payment = await db.query(
    "SELECT * FROM payments WHERE provider_ref = $1",
    [object.id]
  );

  // 2. Обновить статус платежа
  await db.query(
    "UPDATE payments SET status = 'completed', paid_at = NOW() WHERE id = $1",
    [payment.id]
  );

  // 3. Активировать подписку (CRITICAL: TRUE, не 1!)
  await db.query(
    `UPDATE users
     SET subscription_active = TRUE,
         subscription_expires_at = NOW() + INTERVAL '30 days'
     WHERE id = $1`,
    [payment.user_id]
  );
}

if (event === 'payment.canceled') {
  await db.query(
    "UPDATE payments SET status = 'failed' WHERE provider_ref = $1",
    [object.id]
  );
}

// ВСЕГДА возвращаем 200 OK
// Иначе YuKassa будет ретраить webhook
response.status(200).send();
```

> ⚠️ **ВАЖНО:** Всегда возвращайте HTTP 200 на webhook, даже при ошибках обработки.  
> YuKassa ретраит webhook при любом не-200 ответе (до N попыток с экспоненциальной задержкой).

---

### 6.2 Polling (Fallback — sync)

Фронтенд периодически опрашивает статус после редиректа с YuKassa.

**Параметры polling:**

| Параметр | Значение |
|----------|----------|
| Интервал | 2 секунды |
| Макс. попыток | 15 |
| Общее время | 30 секунд |
| После таймаута | Кнопка "Проверить принудительно" |

```
Frontend Timeline (после редиректа с YuKassa):
═══════════════════════════════════════════════════════════════
  0s     GET /status/:id  → { status: "pending" }
  2s     GET /status/:id  → { status: "pending" }
  4s     GET /status/:id  → { status: "pending" }
  ...
 14s     GET /status/:id  → { status: "pending" }
 16s     GET /status/:id  → { status: "completed" }  ← webhook пришёл!
         Активация подписки, редирект на страницу успеха
═══════════════════════════════════════════════════════════════
 30s     (15 попыток исчерпаны)
         Показать кнопку "Проверить принудительно"
```

---

### 6.3 Force-check (Manual)

Ручная проверка статуса у YuKassa. Вызывается пользователем по кнопке.

```
Frontend:  [Проверить принудительно]
              │
              ▼
Backend:  POST /force-check
              │
              ▼
          GET https://api.yookassa.ru/v3/payments/{provider_ref}
              │
              ▼
          Обновить статус + активировать подписку (если succeeded)
              │
              ▼
Frontend:  { "status": "completed", "subscription_activated": true }
```

---

### 6.4 SQL-логика активации (единая для всех трёх путей)

```sql
-- ═══════════════════════════════════════════════════════════
-- АКТИВАЦИЯ ПОДПИСКИ (единая для webhook / polling / force-check)
-- ═══════════════════════════════════════════════════════════

-- Шаг 1: Обновить статус платежа
UPDATE payments
SET status = 'completed',
    paid_at = NOW()
WHERE id = :payment_id
  AND status != 'completed';  -- idempotency guard

-- Шаг 2: Активировать подписку (CRITICAL: TRUE, не 1!)
UPDATE users
SET subscription_active = TRUE,
    subscription_expires_at = NOW() + INTERVAL '30 days'
WHERE id = :user_id;

-- Проверка idempotency:
-- Повторный вызов с тем же payment_id НЕ сломает подписку
-- subscription_expires_at будет перезаписан на NOW() + 30d
```

---

## 7. Webhook auto-setup

Webhook настраивается автоматически при старте сервера через 5 секунд.

```javascript
// Псевдокод
setTimeout(async () => {
  if (isRealMode()) {
    const webhookUrl = `${BACKEND_URL}/api/webhook/yookassa`;

    // Проверить существующие webhooks
    const webhooks = await yookassaApi.getWebhooks();

    // Если webhook ещё не настроен — создать
    if (!webhooks.includes(webhookUrl)) {
      await yookassaApi.createWebhook({
        event: "payment.succeeded",
        url: webhookUrl
      });
      await yookassaApi.createWebhook({
        event: "payment.canceled",
        url: webhookUrl
      });
      console.log("YuKassa webhook configured:", webhookUrl);
    }
  }
}, 5000);
```

**Что настраивается:**

| Событие | Действие |
|---------|----------|
| `payment.succeeded` | Активировать подписку |
| `payment.canceled` | Установить статус `failed` |

**URL webhook:**
```
${BACKEND_URL}/api/webhook/yookassa

# Пример:
https://pulse-api-bsov.onrender.com/api/webhook/yookassa
```

---

## 8. Тестовые карты YuKassa

### 8.1 Успешная оплата

| Поле | Значение |
|------|----------|
| Номер карты | `5555 5555 5555 4477` |
| Срок действия | `12 / 25` (любая будущая дата) |
| CVV | `000` (любые 3 цифры) |
| Код 3-D Secure | `123` |

### 8.2 Отказ банка

| Поле | Значение |
|------|----------|
| Номер карты | `5555 5555 5555 4444` |
| Срок действия | `12 / 25` |
| CVV | `000` |

### 8.3 Требуется 3-D Secure

| Поле | Значение |
|------|----------|
| Номер карты | `5555 5555 5555 4477` |

При запросе 3-D Secure ввести код `123`.

---

## 9. Переменные окружения

### Обязательные (для REAL mode)

| Переменная | Описание | Пример |
|------------|----------|--------|
| `YOOKASSA_SHOP_ID` | ID магазина в YuKassa | `123456` |
| `YOOKASSA_SECRET_KEY` | Секретный ключ YuKassa | `test_xxx...` или `live_xxx...` |

### Обязательные (общие)

| Переменная | Описание | Пример |
|------------|----------|--------|
| `FRONTEND_URL` | URL фронтенд-приложения | `https://pulse-frontend-jt53.onrender.com` |
| `BACKEND_URL` | URL backend API | `https://pulse-api-bsov.onrender.com` |

### Переключение режимов

```bash
# DEMO mode (default) — имитация оплаты
YOOKASSA_SHOP_ID=          # пусто или не задано
YOOKASSA_SECRET_KEY=       # пусто или не задано

# REAL mode — реальные платежи
YOOKASSA_SHOP_ID=123456
YOOKASSA_SECRET_KEY=test_xxx...   # test-режим YuKassa
# или
YOOKASSA_SECRET_KEY=live_xxx...   # продакшен YuKassa
```

### Полный пример `.env`

```bash
# ═══════════════════════════════════════════
# PULSE Payment System — Environment Variables
# ═══════════════════════════════════════════

# YuKassa (оставить пустыми для DEMO mode)
YOOKASSA_SHOP_ID=123456
YOOKASSA_SECRET_KEY=test_xxx...

# Application URLs
FRONTEND_URL=https://pulse-frontend-jt53.onrender.com
BACKEND_URL=https://pulse-api-bsov.onrender.com
```

---

## 10. Troubleshooting

### 10.1 SQL-запросы для диагностики

#### Проверить статус конкретного платежа
```sql
SELECT
  p.id,
  p.status,
  p.provider_ref,
  p.amount,
  p.paid_at,
  p.created_at,
  u.email
FROM payments p
JOIN users u ON u.id = p.user_id
WHERE p.id = '550e8400-e29b-41d4-a716-446655440000';
```

#### Проверить подписку пользователя
```sql
SELECT
  id,
  email,
  subscription_active,
  subscription_expires_at,
  CASE
    WHEN subscription_expires_at > NOW() THEN 'valid'
    ELSE 'expired'
  END as subscription_state
FROM users
WHERE id = '123e4567-e89b-12d3-a456-426614174000';
```

#### Все pending платежи
```sql
SELECT
  p.id,
  p.user_id,
  u.email,
  p.amount / 100.0 as amount_rub,
  p.provider_ref,
  p.created_at,
  NOW() - p.created_at as pending_for
FROM payments p
JOIN users u ON u.id = p.user_id
WHERE p.status = 'pending'
ORDER BY p.created_at DESC;
```

#### Найти платёж по provider_ref (YuKassa ID)
```sql
SELECT *
FROM payments
WHERE provider_ref = '2a4b6c8d-0e1f-2a3b-4c5d-6e7f8a9b0c1d';
```

#### Статистика платежей
```sql
SELECT
  status,
  COUNT(*) as count,
  SUM(amount) / 100.0 as total_rub
FROM payments
GROUP BY status;
```

### 10.2 Частые ошибки

#### Ошибка: `subscription_active` не обновляется

**Симптом:** Платёж `completed`, но у пользователя `subscription_active = FALSE`.

**Причина:** Возможно, используется `1` вместо `TRUE` для BOOLEAN.

**Проверка:**
```sql
-- Проверить текущее значение
SELECT subscription_active, subscription_expires_at
FROM users WHERE id = 'xxx';

-- Ручная активация (если нужно)
UPDATE users
SET subscription_active = TRUE,           -- ← TRUE, не 1!
    subscription_expires_at = NOW() + INTERVAL '30 days'
WHERE id = 'xxx';
```

#### Ошибка: Webhook не приходит

**Проверка:**
```bash
# Убедиться, что webhook настроен (YuKassa API)
curl -u "SHOP_ID:SECRET_KEY" \
  https://api.yookassa.ru/v3/webhooks

# Проверить, что endpoint доступен
curl -I https://pulse-api-bsov.onrender.com/api/webhook/yookassa
```

**Решения:**
1. Проверить, что `BACKEND_URL` корректен в `.env`
2. Перезапустить сервер (webhook настраивается через 5 сек)
3. Проверить firewall / ingress rules (порт 443 открыт)

#### Ошибка: "Demo confirmation is not available in REAL mode"

**Симптом:** `POST /payment/confirm` возвращает 403.

**Причина:** Сервер работает в REAL mode (заданы `YOOKASSA_SHOP_ID` + `YOOKASSA_SECRET_KEY`).

**Решение:** В REAL mode оплата происходит через YuKassa, `/confirm` не используется.

#### Ошибка: Polling завершился по таймауту (30 сек)

**Симптом:** 15 попыток × 2 сек = статус всё ещё `pending`.

**Действия:**
1. Нажать кнопку **"Проверить принудительно"** → `POST /force-check`
2. Проверить статус в YuKassa Dashboard
3. Проверить логи webhook (возможно, webhook не доставлен)

### 10.3 Логи для проверки

```
# Старт сервера — проверка режима и настройка webhook
[INFO] Payment mode: REAL (YuKassa configured)
[INFO] YuKassa webhook configured: https://pulse-api-bsov.onrender.com/api/webhook/yookassa

# Создание платежа
[INFO] Payment created: id=550e8400-e29b-41d4-a716-446655440000, amount=99000, demo=false
[INFO] YuKassa payment created: provider_ref=2a4b6c8d-0e1f-2a3b-4c5d-6e7f8a9b0c1d

# Webhook
[INFO] Webhook received: event=payment.succeeded, provider_ref=2a4b6c8d...
[INFO] Payment activated: id=550e8400-e29b-41d4-a716-446655440000
[INFO] Subscription activated: user_id=123e4567..., expires_at=2025-02-15T14:30:00Z

# Polling
[INFO] Status check: payment_id=550e8400-e29b-41d4-a716-446655440000, status=pending
[INFO] Status check: payment_id=550e8400-e29b-41d4-a716-446655440000, status=completed

# Force-check
[INFO] Force-check: payment_id=550e8400-e29b-41d4-a716-446655440000, status=completed
[INFO] Subscription activated via force-check: user_id=123e4567...
```

### 10.4 Проверка цепочки платежа

```sql
-- Полная цепочка: пользователь → платёж → подписка
SELECT
  u.id as user_id,
  u.email,
  u.subscription_active,
  u.subscription_expires_at,
  p.id as payment_id,
  p.status as payment_status,
  p.amount / 100.0 as amount_rub,
  p.provider_ref,
  p.paid_at,
  CASE
    WHEN u.subscription_active AND u.subscription_expires_at > NOW()
      THEN '✅ Premium active'
    WHEN u.subscription_active AND u.subscription_expires_at <= NOW()
      THEN '⚠️  Premium expired'
    ELSE '❌ No subscription'
  END as premium_state
FROM users u
LEFT JOIN payments p ON p.user_id = u.id
WHERE u.id = '123e4567-e89b-12d3-a456-426614174000'
ORDER BY p.created_at DESC;
```

---

## Приложение: Полная последовательность вызовов (REAL mode)

```
┌─────────┐                              ┌──────────┐                              ┌──────────┐
│ Frontend│                              │ Backend  │                              │ YuKassa  │
└────┬────┘                              └────┬─────┘                              └────┬─────┘
     │                                        │                                         │
     │  1. POST /payment/create               │                                         │
     │ ──────────────────────────────────────►│                                         │
     │                                        │                                         │
     │                                        │  2. POST /v3/payments                   │
     │                                        │ ───────────────────────────────────────►│
     │                                        │                                         │
     │                                        │  3. { confirmation_url, provider_ref }  │
     │                                        │ ◄───────────────────────────────────────│
     │                                        │                                         │
     │  4. { demo: false, payment_id,         │                                         │
     │       confirmation_url }               │                                         │
     │ ◄──────────────────────────────────────│                                         │
     │                                        │                                         │
     │  5. Редирект на confirmation_url       │                                         │
     │ ───────────────────────────────────────────────────────────────────────────────► │
     │                                        │                                         │
     │  6. Пользователь вводит карту          │                                         │
     │     на странице YuKassa                │                                         │
     │                                        │                                         │
     │  7. Редирект на return_url             │                                         │
     │ ◄────────────────────────────────────────────────────────────────────────────────│
     │                                        │                                         │
     │  8. GET /payment/status/:id            │                                         │
     │     (каждые 2сек x 15)                 │                                         │
     │ ──────────────────────────────────────►│                                         │
     │                                        │  9a. GET /v3/payments/{provider_ref}    │
     │                                        │ ───────────────────────────────────────►│
     │                                        │  9b. { status: "succeeded" }            │
     │                                        │ ◄───────────────────────────────────────│
     │                                        │                                         │
     │  10a. { status: "completed" }          │                                         │
     │ ◄──────────────────────────────────────│                                         │
     │                                        │                                         │
     │            ════════════════════════════════════════════════                      │
     │            ALTERNATIVE: Webhook (async)                     ════►               │
     │                                                             │    │              │
     │                                        10b. POST /webhook/yookassa              │
     │                                        { event: "payment.succeeded" }           │
     │                                                             │◄──────────────────│
     │                                        11. UPDATE payments + users               │
     │                                                             │                   │
     │                                        12. 200 OK          │                    │
     │                                                             │──────────────────►│
     │            ════════════════════════════════════════════════                      │
     │                                        │                                         │
     │  13. Подписка активирована!            │                                         │
     │     Редирект на страницу успеха        │                                         │
```

---

*Документ сгенерирован для PULSE Payment System v1.0*
