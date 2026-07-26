# Подписки, автопродление и уведомления об истечении

## Схема данных

Подписка хранится прямо в таблице `users`:

| Поле | Тип | Описание |
|------|-----|----------|
| `subscription_active` | BOOLEAN | Активна ли подписка (true и в grace-периоде) |
| `subscription_plan` | VARCHAR(20) FK → subscription_plans | Текущий тариф |
| `subscription_expires_at` | TIMESTAMP | Дата окончания |
| `subscription_auto_renew` | BOOLEAN | Включено ли автопродление |
| `auto_renew_failures` | INTEGER | Счётчик неудач автопродления |
| `scheduled_plan_downgrade` | VARCHAR(20) | Запланированное понижение после истечения |
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
grace    → Telegram/Push: "Grace-период, день N/3"
downgrade→ `scheduled_plan_downgrade` → `processScheduledDowngrades()` → заморозка лишних тегов
```

## Cron

- `0 9 * * * UTC` — `processAutoRenewals()` (попытка списания).
- `0 9 * * * UTC` — `sendExpiryNotifications()` (email-напоминания, 12:00 МСК).
- Каждые 6 часов — `processTrialExpirations()`.
- Каждые 5 минут — `processScheduledDowngrades()`.

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

## Сброс `subscription_active` при истечении

`processScheduledDowngrades()` (каждые 5 минут) в начале работы деактивирует истёкшие paid-подписки, у которых нет запланированного даунгрейда:

```sql
UPDATE users
SET subscription_active = FALSE
WHERE subscription_active = TRUE
  AND subscription_expires_at < NOW()
  AND subscription_plan IN (SELECT id FROM subscription_plans WHERE plan_level >= 1)
  AND scheduled_plan_downgrade IS NULL
```

Это закрывает дыру, при которой `subscription_active` оставался `TRUE` навсегда, и позволяет корректно работать:
- архивированным тарифам (downgrade на Free);
- отчётам/дайджестам (`sendAllWeeklyReports`, `sendAllDigests`);
- `hasFeature`.

## Защита от race condition при scheduled downgrade

`processScheduledDowngrades()` обрабатывает каждого пользователя внутри `withUserLock`, а `UPDATE` дополнительно проверяет, что подписка всё ещё истекла:

```sql
UPDATE users
SET subscription_plan = $1,
    scheduled_plan_downgrade = NULL,
    subscription_active = $2
WHERE id = $3
  AND subscription_expires_at < NOW()
RETURNING id
```

Если между `SELECT` и `UPDATE` webhook/force-check продлил подписку, `UPDATE` не изменит строку (`RETURNING` вернёт 0 строк) и `freezeExcessTags` не вызовется. Это предотвращает случайную перезапись активной продлённой подписки.

## Запланированный downgrade

Пользователь может запросить понижение тарифа через `POST /api/user/downgrade`.

**Валидация `targetPlan` (TZ_DOWNGRADE_VALIDATE):**
- `targetPlan` должен быть непустой строкой.
- Тариф должен существовать (`getPlanById`).
- Тариф должен быть активным (`is_active = TRUE` и `deleted_at IS NULL`).
- `plan_level` целевого тарифа должен быть **строго меньше** текущего (downgrade — только на более дешёвый тариф).

При успешной валидации в `users.scheduled_plan_downgrade` записывается целевой тариф, а текущий тариф продолжает действовать до `subscription_expires_at`. После истечения срока `processScheduledDowngrades` выполняет переход и заморозку лишних тегов.

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

### `GET /api/user/tags`

Возвращает **активный** портфель (только теги с `is_frozen = FALSE`):

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
