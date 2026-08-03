# Подписки, автопродление и уведомления об истечении

## Схема данных

Подписка хранится прямо в таблице `users`:

| Поле | Тип | Описание |
|------|-----|----------|
| `subscription_active` | BOOLEAN | Сырое значение из БД. Для API/гейтинга используется `computeAccessState(subscription_expires_at)` |
| `subscription_plan` | VARCHAR(20) FK → subscription_plans | Текущий тариф в БД. После грейса API может сообщать `plan: 'free'`, пока крон не обновит БД |
| `subscription_expires_at` | TIMESTAMP | Дата окончания оплаченного периода. Источник для единой формулы доступа |
| `subscription_auto_renew` | BOOLEAN | Включено ли автопродление. Сбрасывается в FALSE при любом downgrade |
| `auto_renew_failures` | INTEGER | Счётчик неудач автопродления |
| `scheduled_plan_downgrade` | VARCHAR(20) | Запланированное понижение после истечения оплаченного периода (scheduled downgrade) |
| `expiry_notified` | JSONB / TEXT | Дедупликация email-напоминаний: `{"4d":true,"1d":true,"expired":true}` |

Дедупликация напоминаний в Telegram/Push/Web уже ведётся через `subscription_notifications_sent`, поэтому email-уведомления используют отдельное поле `expiry_notified`.

## Платные тарифы

- `plan_level = 0` — бесплатный тариф (`free`).
- `plan_level >= 1` — платные тарифы (`base`, `premium`, `club`, `pro`, а также любые новые).

Все cron-задачи, работающие с платными подписками, определяют их через подзапрос:

```sql
subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
```

Раньше в коде был хардкод `IN ('base','premium','club','pro')`, который игнорировал любой новый тариф.

## Жизненный цикл

```
T-4 дня  → email: "Подписка истекает через 4 дня" (auto ON / OFF)
T-1 день → email: "Завтра истекает / завтра списание" (auto ON / OFF)
T-0      → email: "Подписка истекла"
           auto ON  → "Проверьте карту" (3 дня на обновление)
           auto OFF → "Что вы потеряли + статистика"
grace    → 3 дня после expires_at. Внутри грейса API считает подписку активной,
           платные фичи работают, уведомления доставляются.
after grace → lazy `plan='free'` в API; крон каждые 5 мин переводит БД на free,
              сбрасывает auto_renew, замораживает лишние теги.
downgrade→ `POST /user/downgrade` { targetPlan } → { mode: 'immediate'|'scheduled' }
           immediate: применяется сразу, если подписка неактивна или в грейсе.
           scheduled: записывается в `scheduled_plan_downgrade`, применяется кроном
           по истечении (без грейса, т.к. пользователь сам инициировал).
```

### Единая формула доступа

`computeAccessState(expiresAt)` — единственная функция, решающая, активна ли подписка:

```typescript
if (now < expiresAt)        return { active: true, inGrace: false, daysLeft }
if (now < expiresAt + 3d)   return { active: true, inGrace: true,  daysLeft }
return { active: false, inGrace: false, daysLeft: 0 }
```

Все server-gated проверки (`hasFeature`, `requirePremium`, `getEntitlement`, `/user/channel-status`) используют эту функцию, а не поле `subscription_active`.

### Ответ API

`buildSubscriptionStatus()` (используется в `/auth/me`, `/auth/login`, `/user/profile`, `/user/tariff-status`):

```json
{
  "plan": "premium",
  "active": true,
  "inGracePeriod": false,
  "daysLeft": 12,
  "scheduledDowngrade": null,
  "expiresAt": "...",
  "autoRenew": true
}
```

После окончания грейса `plan` становится `'free'`, `active: false`, `scheduledDowngrade: null` (lazy).

## Cron

- `0 9 * * * UTC` — `processAutoRenewals()` (попытка списания).
  - Если у пользователя нет привязанной активной карты, попытка считается неудачей: `auto_renew_failures++`, уведомление "Привяжите карту" и, после 3 неудач, отключение `subscription_auto_renew`.
- `0 9 * * * UTC` — `sendExpiryNotifications()` (email-напоминания, 12:00 МСК).
- Каждые 6 часов — `processTrialExpirations()`.
- Каждые 5 минут — `processScheduledDowngrades()`.

## Настройки уведомлений (Notification Matrix)

Уведомления управляются матрицей `notification_subscriptions` — единственным источником правды. Каждая строка = пара **продукт × канал**.

### Схема

| Поле | Тип | Описание |
|------|-----|----------|
| `user_id` | UUID FK → users | Пользователь |
| `product` | VARCHAR(32) | `digest`, `weekly_report`, `fact_check`, `news_alert`, `billing`, `engagement` |
| `channel` | VARCHAR(16) | `telegram`, `email`, `push` |
| `enabled` | BOOLEAN | Включена ли подписка |
| `frequency` | VARCHAR(8) | Только для `digest`: `1h`, `3h`, `6h`, `12h`, `24h` |
| `last_sent_at` | TIMESTAMPTZ | Время последней отправки по этому продукту+каналу |
| `created_at` / `updated_at` | TIMESTAMPTZ | Служебные |

PRIMARY KEY: `(user_id, product, channel)`.

### Продукты и каналы

| Продукт | Каналы | Описание |
|---------|--------|----------|
| `digest` | `telegram`, `email`, `push` | Периодическая подборка непрочитанных |
| `weekly_report` | `telegram`, `email`, `push` | Еженедельный отчёт (воскресенье, 13:00 МСК) |
| `fact_check` | `telegram`, `email` | Результат on-demand факт-чека |
| `news_alert` | `push` | Мгновенный пуш при выходе новости по тегу |
| `billing` | `email`, `push` | Подписка, оплата, истечение, grace |
| `engagement` | `push` | Sentiment-напоминания, стрики и механики удержания |

### Дефолты и сидинг

При регистрации или первом вызове `GET /api/user/notification-matrix` вызывается `ensureDefaultSubscriptions(userId)`. Он **только** создаёт отсутствующие строки (`INSERT ... ON CONFLICT DO NOTHING`) и **никогда** не перезаписывает выбор пользователя:

- `digest` — все каналы выключены (`enabled = FALSE`), частота `1h`;
- `weekly_report` — `telegram` и `email` включены, `push` выключен;
- `fact_check` — `telegram` и `email` включены;
- `news_alert` — выключен;
- `billing` — `email` и `push` включены;
- `engagement` — выключен.

### Тихие часы

Тихие часы и отдельный адрес дайджеста (`digest_email`) пока остаются в `notification_settings` — это не подписка, а глобальные настройки доставки. Управляются через `POST /api/user/notification-matrix/quiet-hours`.

### API

- `GET /api/user/notification-matrix` — вся матрица, активные каналы и тихие часы.
- `PUT /api/user/notification-matrix` — обновить одну ячейку: `{ product, channel, enabled?, frequency? }`.
- `POST /api/user/notification-matrix/quiet-hours` — `{ enabled?, start?, end? }` (формат `HH:MM`).
- `GET /api/user/notification-delivery-target?channel=...&product=...` — адрес доставки (chat_id/email/endpoint).

### Legacy

Старые эндпоинты `/api/user/notifications` и `/api/user/notification-settings` сохранены для обратной совместимости и маппятся на матрицу, но `notification_subscriptions` — единственный источник правды для всех рассылок.

## Архивированные тарифы

Архивированный тариф — это запись в `subscription_plans` с `deleted_at IS NOT NULL`. Он исчезает из публичного каталога, но остаётся в БД.

### Автопродление по архивированному тарифу

- `processAutoRenewals()` больше не проверяет `plan.deleted_at`. Он сверяется только с `plan.is_active`.
- Если тариф архивирован, но `is_active = TRUE`, автопродление продолжается: успешная оплата продлевает подписку и накапливает дни.
- Если админ полностью деактивировал тариф (`is_active = FALSE`), автопродление у подписчиков принудительно отключается (`subscription_auto_renew = FALSE`).

### Истечение срока без оплаты

Если по архивированному тарифу не удалось списать деньги (3 неудачи / auto-renew OFF) и подписка стала неактивной:

- `processScheduledDowngrades()` дополнительно выбирает пользователей:
  ```sql
  subscription_plan IN (SELECT id FROM subscription_plans WHERE deleted_at IS NOT NULL)
  AND subscription_active = FALSE
  AND subscription_expires_at < NOW()
  ```
- Для них `targetPlan = 'free'`, `subscription_active = FALSE`.
- Вызывается `freezeExcessTags(userId, 'free')` — лишние теги замораживаются.

### Trial на архивированном тарифе

- `processTrialExpirations()` также убрал проверку `plan.deleted_at`.
- Если тариф архивирован, но активен, trial продлевается через регулярный платёж по `plan.billing_frequency`.
- Если `is_active = FALSE`, trial-юзер получает `scheduleDowngrade(..., 'free')`.

## Сброс `subscription_active` при истечении и auto-fallback после грейса

`processScheduledDowngrades()` (каждые 5 минут) делает две вещи:

1. **Деактивация истёкших paid-подписок без scheduled downgrade:**

```sql
UPDATE users
SET subscription_active = FALSE
WHERE subscription_active = TRUE
  AND subscription_expires_at < NOW()
  AND subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
  AND scheduled_plan_downgrade IS NULL
```

Это закрывает дыру, при которой `subscription_active` оставался `TRUE` навсегда.

2. **Auto-fallback на Free после окончания грейса (expires_at + 3 days):**

```sql
UPDATE users
SET subscription_plan = 'free',
    subscription_active = FALSE,
    subscription_auto_renew = FALSE,
    scheduled_plan_downgrade = NULL
WHERE subscription_plan != 'free'
  AND subscription_expires_at < NOW() - INTERVAL '3 days'
  AND scheduled_plan_downgrade IS NULL
```

Для каждого такого пользователя вызывается `applyDowngradeNow(userId, 'free')`, который замораживает теги сверх лимита Free и уведомляет пользователя.

Это позволяет корректно работать:
- архивированным тарифам (downgrade на Free);
- отчётам/дайджестам (`sendAllWeeklyReports`, `sendAllDigests`);
- `hasFeature` и `computeAccessState`.

## Защита от race condition при scheduled downgrade

`processScheduledDowngrades()` обрабатывает каждого пользователя внутри `withUserLock`, а `applyDowngradeNow` делает atomic UPDATE с проверкой, что подписка всё ещё истекла:

```sql
UPDATE users
SET subscription_plan = $1,
    scheduled_plan_downgrade = NULL,
    subscription_active = $2,
    subscription_auto_renew = FALSE
WHERE id = $3
  AND subscription_expires_at < NOW()
RETURNING id
```

Если между `SELECT` и `UPDATE` webhook/force-check продлил подписку, `UPDATE` не изменит строку (`RETURNING` вернёт 0 строк) и `freezeExcessTags` не вызовется. Это предотвращает случайную перезапись активной продлённой подписки.

`applyDowngradeNow(userId, targetPlanId)` используется единообразно:
- В кроне `processScheduledDowngrades` для scheduled downgrades и auto-fallback.
- В API `POST /user/downgrade` при `mode: 'immediate'`.

## Запланированный и немедленный downgrade

Пользователь запрашивает понижение через `POST /api/user/downgrade`.

**Валидация `targetPlan` (TZ_DOWNGRADE_VALIDATE):**
- `targetPlan` должен быть непустой строкой.
- Тариф должен существовать (`getPlanById`).
- Тариф должен быть активным (`is_active = TRUE` и `deleted_at IS NULL`).
- `plan_level` целевого тарифа должен быть **строго меньше** текущего.

**Ответ:**

```json
// scheduled — активная подписка, downgrade применится по истечении
{ "success": true, "mode": "scheduled", "scheduledPlan": "free" }

// immediate — подписка истекла или в грейсе, downgrade применён сразу
{ "success": true, "mode": "immediate", "subscription": { ... } }
```

- При `mode: 'immediate'` вызывается `applyDowngradeNow(userId, targetPlan)` — atomic UPDATE с проверкой `subscription_expires_at < NOW()`, сброс `auto_renew=FALSE`, `freezeExcessTags()`.
- При `mode: 'scheduled'` записывается `scheduled_plan_downgrade`, `auto_renew` сбрасывается в FALSE.
- `scheduled` downgrade применяется кроном по `expires_at` **без грейса** — пользователь сам инициировал переход.
- `auto-fallback` (без scheduled downgrade) применяется кроном после `expires_at + 3 days` **с грейсом** — пользователь не инициировал ничего.

## Заморозка тегов

При понижении до тарифа с меньшим `tag_limit`:

1. `freezeExcessTags(userId, planId)` — лишние теги помечаются `is_frozen = TRUE`.
2. Запись в `frozen_tags` для аудита.
3. Замороженные теги не участвуют в новостных рассылках и алертах.
4. При апгрейде `unfreezeTagsUpToLimit()` размораживает теги в пределах лимита.
5. При отмене запланированного downgrade (`cancelScheduledDowngrade`) теги размораживаются только до лимита **текущего** тарифа, чтобы пользователь не получил активных тегов больше лимита.

## Баннер "Лишние теги" (FreezeTagsBanner)

**Правило показа:** баннер виден **только если активных тегов больше, чем позволяет тариф**.

```
active_tags > tag_limit  → баннер виден ("Удалите N тегов")
active_tags <= tag_limit → баннер скрыт (в т.ч. при 0 тегов или только замороженных)
```

**API:**

- `GET /api/user/tag-status` — возвращает `active_tags`, `frozen_tags`, `tag_limit`, `to_remove`.
- `to_remove` считается как `max(0, active_tags - tag_limit)`. Замороженные теги не учитываются.
- `GET /api/user/tags` — возвращает только активные теги (`is_frozen = FALSE`). Замороженные теги не отображаются в портфеле на главной и не участвуют в ленте новостей.
- `POST /api/user/select-active-tags` — принимает список активных тегов. Переданные размораживаются, непереданные замораживаются.

**Логика кнопки "Сохранить":**

- Кнопка активна только когда `to_remove === 0` (все теги влезают в лимит).
- При нажатии передаются **все** теги из `tag-status` (включая замороженные), что приводит к их разморозке, если они влезают в лимит.

**Примеры:**

| Сценарий | active | frozen | limit | to_remove | Баннер |
|----------|--------|--------|-------|-----------|--------|
| Free, 5 тегов | 5 | 0 | 3 | 2 | **Да** |
| Free, 3 тега | 3 | 0 | 3 | 0 | **Нет** |
| Free, 0 тегов | 0 | 0 | 3 | 0 | **Нет** |
| Base, 15 тегов | 15 | 0 | 10 | 5 | **Да** |
| Base, 9 тегов | 9 | 0 | 10 | 0 | **Нет** |
| Base, 5 активных + 4 замор. | 5 | 4 | 10 | 0 | **Нет** |

**Файлы:**
- Frontend: `pulse-frontend/src/components/FreezeTagsBanner.tsx`
- Backend: `pulse-backend/src/routes/user.ts` (`GET /api/user/tag-status`, `GET /api/user/tags`)

## Email-шаблоны

Файл `src/services/email.ts`:

- `sendExpiry4DaysAuto`
- `sendExpiry4DaysManual`
- `sendExpiry1DayAuto`
- `sendExpiry1DayManual`
- `sendExpiredPaymentFailed`
- `sendExpiredToday`

Дизайн — фирменный inline dark/glass:
- фон `#0a0a0a`, карточка `#111111`, border `#222222`;
- акцент `#00D4FF`, градиент `#00D4FF → #0099CC`;
- шрифт `Arial, sans-serif`;
- без `backdrop-filter`, `flexbox` и CSS-переменных (для совместимости с Outlook/Gmail).

## API

### `POST /api/user/downgrade`

Запрос понижения тарифа.

**Body:**
```json
{ "targetPlan": "free" }
```

**Ответ:**
```json
{ "success": true, "mode": "scheduled", "scheduledPlan": "free" }
// или
{ "success": true, "mode": "immediate", "subscription": { "plan": "free", "active": false, ... } }
```

- `scheduled` — активная подписка, переход запланирован на конец периода.
- `immediate` — подписка истекла или в грейс-периоде, переход применён сразу.

### `GET /api/user/tariff-status`

Полный статус тарифа. Все поля `subscription.*` и `tagUsage.limit` вычисляются по effective плану (`buildSubscriptionStatus`), то есть после грейса лимит будет от `free`.

### `GET /api/user/tag-status`

Снапшот для `FreezeTagsBanner`. `tag_limit` берётся по effective плану (`buildSubscriptionStatus`).

Возвращает `current_plan`, `plan_name`, `tag_limit`, `total_tags`, `active_tags`, `frozen_tags`, `to_remove`, `tags`.

`to_remove` считается как `max(0, active_tags - tag_limit)`. Замороженные теги не учитываются.

### `GET /api/user/tags`

Возвращает **активный** портфель (только теги с `is_frozen = FALSE`). Замороженные теги не отображаются в портфеле на главной и не участвуют в ленте новостей.

```json
{
  "tags": [
    {
      "id": "uuid",
      "tag_id": "AAPL",
      "tag_name": "Apple",
      "tag_type": "company",
      "is_frozen": false,
      "enriched": true,
      "news_per_month": 42
    }
  ]
}
```

`news_per_month` — количество уникальных новостей за последние 30 дней, связанных с тегом через `news_tag_links`.

### `DELETE /api/user/tags/:tagId`

Hard delete тега из портфеля. Используется в баннере заморозки.

### Промокоды и округление цены

**Endpoint'ы:**

- `GET /api/promo/validate?code=START50&planId=premium` — публичная проверка кода.
- `POST /api/payment/create` — создание платежа с промокодом.

**Правило расчёта:** цены без копеек, округление в меньшую сторону (`Math.floor`), минимум — 1 ₽.

```typescript
// src/services/promo.ts
export function applyPercentDiscount(basePrice: number, discountValue: number): number {
  const discounted = basePrice * (1 - discountValue / 100);
  return Math.max(1, Math.floor(discounted));
}
```

Примеры:

| Базовая цена | Скидка | Итог |
|--------------|--------|------|
| 990 ₽ | 50 % | 495 ₽ |
| 990 ₽ | 33 % | 326 ₽ |
| 2990 ₽ | 15 % | 448 ₽ |
| 490 ₽ | 100 % | 1 ₽ (минимум) |

**Сохранение:** `user_promo_uses.discount_applied` хранится как целое число рублей (`INTEGER`), чтобы избежать ошибок PostgreSQL с дробными значениями.

**Trial-промокоды:** при `discount_type === 'trial'` сумма платежа = 1 ₽ (авторизация карты), а длительность подписки берётся из `discount_value` (дней).

### Формат дат в промокодах

- Backend (`CreatePromoCodeSchema` / `UpdatePromoCodeSchema`) ожидает даты в формате `YYYY-MM-DD`:
  ```typescript
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD).')
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date format (YYYY-MM-DD).')
  ```
- Frontend (`PromoCodesSubTab.tsx`) использует `type="date"` input, который уже возвращает `YYYY-MM-DD`.
- Даты отправляются на backend как есть, без `new Date().toISOString()`.
- PostgreSQL приводит строку `YYYY-MM-DD` к `TIMESTAMP` (`2026-07-25 00:00:00 UTC`).

**Пример body:**
```json
{
  "code": "START50",
  "discount_type": "percent",
  "discount_value": 50,
  "valid_from": "2026-07-25",
  "expires_at": "2026-08-25",
  "applicable_plans": ["premium"]
}
```

### Валидация формы создания промокода

- Code: `A-Z`, `0-9`, `_`, max 50, auto-uppercase.
- Description: max 255.
- Type: `percent` или `trial`.
- Value: `percent` 1–100, `trial` 1–365.
- Max Uses: ≥1 или пусто/не задано (`null` = безлимит). Это **единственный** лимит: одна и та же учётная запись может активировать промокод многократно, пока не исчерпан `uses_count`.
- Valid Until: строго позже Valid From.
- Applicable Plans: список тарифов или пустой массив (= все тарифы).

### Проверка промокода пользователем

`GET /api/promo/validate?code=START50&planId=premium`

**Ответ при ошибке:**
```json
{ "valid": false, "reason": "expired" }
```

Для `not_started` backend дополнительно возвращает `starts_at`:
```json
{ "valid": false, "reason": "not_started", "starts_at": "2026-08-01" }
```

**Reason-коды и сообщения на странице тарифов (`Pricing.tsx`):**

| Reason | Сообщение | Цвет |
|--------|-----------|------|
| `not_found` | "Промокод не найден. Проверьте правильность ввода." | Красный |
| `inactive` | "Промокод деактивирован." | Красный |
| `expired` | "Срок действия промокода истёк." | Красный |
| `exhausted` | "Лимит активаций исчерпан." | Красный |
| `not_applicable` | "Промокод не применим к выбранному тарифу." | Жёлтый |
| `not_started` | "Промокод ещё не действует. Начало: {date}." | Жёлтый |

**Успешное применение:**
- `percent` — зелёное сообщение "Скидка {value}% применена! Цена: {price} ₽".
- `trial` — зелёное сообщение "{value} дней бесплатно! Списание 1 ₽ для проверки карты — вернём сразу."

## Функции статистики

`src/services/subscription.ts`:

- `getLostFeatures(userId, planId)` — список фич, недоступных на Free, и количество тегов.
- `getUserMonthlyStats(userId)` — агрегация новостей/AI/алертов за месяц. Таблицы `ai_summaries` и `alerts` пока не используются, поэтому эти метрики возвращают 0 с fallback.

## Известные ограничения

- SQLite-версия не запускается через `ts-node` из-за отсутствия типов `sql.js` в dev-зависимостях; production-сборка (`npm run build`) компилируется успешно.
- Email-шаблоны используют inline-стили и table-раскладку для совместимости с почтовыми клиентами.
