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

## Заморозка тегов

При понижении до тарифа с меньшим `tag_limit`:

1. `freezeExcessTags(userId, planId)` — лишние теги помечаются `is_frozen = TRUE`.
2. Запись в `frozen_tags` для аудита.
3. Замороженные теги не участвуют в новостных рассылках и алертах.
4. При апгрейде `unfreezeTagsUpToLimit()` размораживает теги в пределах лимита.

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

Возвращает портфель с полями:

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
- Max Uses: ≥1 или пусто/не задано.
- Valid Until: строго позже Valid From.
- Applicable Plans: список тарифов или пустой массив (= все тарифы).

## Функции статистики

`src/services/subscription.ts`:

- `getLostFeatures(userId, planId)` — список фич, недоступных на Free, и количество тегов.
- `getUserMonthlyStats(userId)` — агрегация новостей/AI/алертов за месяц. Таблицы `ai_summaries` и `alerts` пока не используются, поэтому эти метрики возвращают 0 с fallback.

## Известные ограничения

- SQLite-версия не запускается через `ts-node` из-за отсутствия типов `sql.js` в dev-зависимостях; production-сборка (`npm run build`) компилируется успешно.
- Email-шаблоны используют inline-стили и table-раскладку для совместимости с почтовыми клиентами.
