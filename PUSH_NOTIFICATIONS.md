# Уведомления в PULSE (Notifications)

> Backend управляет уведомлениями через единую матрицу **продукт × канал**.
> Этот документ заменяет/расширяет предыдущий `PUSH_NOTIFICATIONS.md`.

---

## Архитектура

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend (Profile → Notifications)                        │
│  NotificationMatrix.tsx → GET/PUT /api/user/notification-matrix
└──────────────────────────┬─────────────────────────────────┘
                           │ JWT
┌──────────────────────────▼─────────────────────────────────┐
│  Backend                                                    │
│  routes/notifications.ts   → CRUD матрицы + тихие часы       │
│  services/notifications/                                    │
│    - types.ts              → продукты, каналы, дефолты       │
│    - subscriptions.ts    → чтение/запись подписок          │
│    - entitlement.ts        → тарифные гейты                │
│    - quietHours.ts         → тихие часы по МСК              │
│    - dispatcher.ts         → единая точка рассылки         │
│    - workers.ts            → cron-воркеры                  │
│    - digestContent.ts      → контент дайджеста               │
│    - weeklyReportContent.ts→ контент еженедельного отчёта  │
│    - formatters.ts         → форматы Telegram/Email/Push   │
│  services/telegram.ts, email.ts, push.ts, webPush.ts        │
└──────────────────────────┬─────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         Telegram      Email      Push (FCM + VAPID)
```

### Ключевые принципы

- `notification_subscriptions` — **единственный источник правды** о том, кто и куда получает уведомления.
- `notification_settings` — оставлена для тихих часов, `digest_email` и обратной совместимости.
- `user_channels` — активные Telegram chat_id и FCM токены.
- `push_subscriptions` — VAPID-подписки браузеров.
- Воркеры **не** фильтруют по `subscription_active` в SQL. Тарифная проверка делается диспетчером через `entitlement.ts`, и каждый отказ логируется с причиной.
- Тихие часы сравниваются с **московским временем** (UTC+3), не с локальным временем сервера.
- Push-уведомления рассылаются **fan-out** в обе системы: Firebase Cloud Messaging и VAPID Web Push.

---

## Продукты и каналы

| Продукт | Описание | Каналы | Тип | Расписание | Тариф |
|---------|------------|--------|-----|------------|-------|
| `digest` | Дайджест непрочитанных новостей по тегам | `telegram`, `email`, `push` | scheduled | каждый час в :00 МСК | все (лимит тегов из плана) |
| `weekly_report` | Еженедельный аналитический отчёт | `telegram`, `email`, `push` | scheduled | воскресенье 13:00 МСК | только платный |
| `fact_check` | Результат факт-чека новости | `telegram`, `email` | event-driven | по завершении проверки | все |
| `news_alert` | Мгновенный пуш о новой статье по тегу | `push` | event-driven | при выходе новости | все |
| `billing` | Подписка, оплата, истечение | `email`, `push` | event-driven | при событии | все (transactional) |
| `engagement` | Механики удержания: Sentiment Index, стрики | `push` | event-driven | при триггере | все |

### Дефолты при первом открытии матрицы

- `digest` — всё выключено, частота `1h`.
- `weekly_report` — Telegram и Email включены.
- `fact_check` — Telegram и Email включены.
- `news_alert` — выключен.
- `billing` — Email и Push включены.
- `engagement` — выключен.

---

## API Endpoints

Все требуют `Authorization: Bearer <JWT>`.

| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/user/notification-matrix` | Вся матрица + тихие часы + активные каналы |
| PUT | `/api/user/notification-matrix` | Обновить ячейку: `{ product, channel, enabled?, frequency? }` |
| POST | `/api/user/notification-matrix/quiet-hours` | `{ enabled?, start?, end? }` (формат `HH:MM`) |
| GET | `/api/user/notification-delivery-target` | Адрес доставки по каналу (`?channel=...&product=...`) |
| GET/PATCH | `/api/user/notifications` | **Legacy**: маппится на матрицу |
| GET | `/api/user/vapid-public-key` | VAPID public key для Web Push |
| POST | `/api/user/push-subscribe` | Подписать браузер: `{ endpoint, p256dh, auth }` |
| POST | `/api/user/push-unsubscribe` | Отписать: `{ endpoint }` |

---

## Тарифные гейты (Entitlement)

Реализованы в `services/notifications/entitlement.ts`.

1. **Доступ к продукту**
   - `weekly_report` — только активный платный план (`subscription_active` + не истёк + `price_monthly > 0`).
   - Все остальные продукты — доступны всем, включая free.

2. **Доступ к каналу**
   - `email` — неявный, доступен всегда.
   - `telegram` — требует фичу `telegram` в `subscription_plans.features`.
   - `push` — требует фичу `push` в `subscription_plans.features`.

3. **Лимит тегов**
   - Берётся из `subscription_plans.tag_limit` (`free=3`, `base=10`, `premium=25`, `-1=без лимита`).
   - Для `digest`/`weekly_report`/`news_alert` используется первые N тегов по `created_at ASC`.
   - Ручная отправка `/now` игнорирует лимит (`maxTags = null`).

---

## Диспетчер (Dispatcher)

`services/notifications/dispatcher.ts` — единая точка рассылки.

### Плановая рассылка `dispatchToUser(userId, product)`

1. Проверить `entitlement` на продукт.
2. Проверить тихие часы (кроме `billing`).
3. Отобрать включённые каналы, у которых `last_sent_at` позволяет по частоте.
4. Построить контент **один раз** (окно от самого раннего `last_sent_at` канала).
5. Для каждого канала проверить `entitlement` на канал и отправить через форматтер.
6. Обновить `last_sent_at` только для каналов, где отправка успешна.

### Ручная рассылка `dispatchToUserNow(userId, product, channel)`

Игнорирует частоту и тихие часы, использует все теги.

### Рассылка всем `broadcastProduct(product)`

Вызывается воркерами. Собирает `recipients` из `notification_subscriptions` и активных каналов.

---

## Cron-воркеры

`services/notifications/workers.ts` запускает `node-cron` с timezone `Europe/Moscow`.

| Задача | Расписание | Продукт |
|--------|------------|---------|
| Digest | `0 * * * *` | `digest` |
| Weekly Report | `0 13 * * 0` | `weekly_report` |

Каждый запуск пишет строку в `cron_log` (`task_name` = `digest` или `weekly_report`).

---

## Event-driven продукты

| Продукт | Триггер | Код |
|---------|---------|-----|
| `fact_check` | Завершение проверки | `services/factCheckNotifications.ts` |
| `news_alert` | Новая статья с `matched_tags` | `services/push.ts` → `sendNewArticlePush()` |
| `billing` | Истечение/оплата подписки | `services/subscription.ts` → `sendBillingPush()` |
| `engagement` | Sentiment-напоминание | `services/push.ts` → `sendSentimentVotePush()` |

Event-driven отправители сами читают `notification_subscriptions` и `getDeliveryTarget()`, не используют диспетчер.

---

## Push-канал

Push отправляется в две параллельные системы:

### Firebase Cloud Messaging (FCM)

- Android + нативные пуши.
- FCM-токен хранится в `user_channels` (`channel = 'push', is_active = TRUE`).
- Env: `FIREBASE_SERVICE_ACCOUNT_BASE64`.
- Invalid-токен деактивирует строку в `user_channels`.

### VAPID Web Push

- Браузерные пуши через Push API.
- Подписки в `push_subscriptions` (`endpoint, p256dh, auth`).
- Env: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`.
- Ошибки `410`/`404` деактивируют подписку.

### Fan-out

Для каждого push-уведомления backend пытается отправить и в FCM, и в VAPID; считается успешным, если хотя бы одна система доставила.

### Типы push-данных

| Тип | Поля `data` | Источник |
|-----|-------------|----------|
| `new_article` | `news_id`, `tag` | `sendNewArticlePush()` |
| `sentiment_vote` | `title`, `body` | `sendSentimentVotePush()` |
| `billing` | `subtype` | `sendBillingPush()` |
| `digest` | `type: 'digest'` | Dispatcher `formatDigestPush()` |
| `weekly_report` | `type: 'report'` | Dispatcher `formatWeeklyReportPush()` |

### Deduplication

- `push_notifications_sent` предотвращает повторную отправку одной новости одному пользователю (`news_alert`).
- `sentiment_vote_push_sent` предотвращает повторный sentiment-push в один день.

---

## Тихие часы

- Хранятся в `notification_settings` (`quiet_hours_enabled`, `quiet_hours_start`, `quiet_hours_end`).
- Дефолт: `22:00` – `08:00` по московскому времени.
- Расчёт в `services/notifications/quietHours.ts`: `isQuietHoursMsk()` использует UTC+3.
- Не применяются к `billing` (transactional).

---

## Legacy-совместимость

- Старые колонки `notification_settings.tg_digest_enabled`, `push_enabled`, `fact_check_email_enabled` и т.д. **больше не являются источником правды**.
- `PUT /api/user/notification-matrix` при изменении `push` синхронно обновляет `notification_settings.push_enabled`, чтобы старый код (`push.ts`) не потерял состояние.
- `GET /api/user/notifications` и `PATCH /api/user/notifications` маппятся на матрицу для старых компонентов (`NotificationSwitches`).

---

## Переменные окружения

| Переменная | Описание |
|------------|----------|
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота `@Insidepulse_bot` |
| `FIREBASE_SERVICE_ACCOUNT_BASE64` | Base64 JSON сервисного аккаунта Firebase |
| `VAPID_PUBLIC_KEY` | Публичный VAPID-ключ |
| `VAPID_PRIVATE_KEY` | Приватный VAPID-ключ |
| `VAPID_SUBJECT` | `mailto:` контакт (по умолчанию `mailto:admin@pulse.app`) |
| `EMAIL_PROVIDER` | `resend`, `yandex` или `none` |
| `EMAIL_FROM` | Адрес отправителя |
| `RESEND_API_KEY` / `YANDEX_USER` / `YANDEX_PASS` | Зависит от `EMAIL_PROVIDER` |

---

## Схема данных

```sql
CREATE TABLE notification_subscriptions (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product      VARCHAR(32) NOT NULL,  -- 'digest' | 'weekly_report' | 'fact_check' | 'news_alert' | 'billing' | 'engagement'
  channel      VARCHAR(16) NOT NULL,  -- 'telegram' | 'email' | 'push'
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  frequency    VARCHAR(8),             -- '1h'|'3h'|'6h'|'12h'|'24h' (только digest)
  last_sent_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, product, channel)
);
```

См. полную схему: `src/models/schema.sql` и миграцию `src/migrations/notification_matrix_v1.sql`.
