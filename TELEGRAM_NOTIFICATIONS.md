# Telegram Notifications — PULSE Bot (@Insidepulse_bot)

> Полная техническая документация логики уведомлений Telegram-бота проекта PULSE.
> Версия документа: **2.3** | Бот: `@Insidepulse_bot` | Обновлено: июль 2026
> Последние правки: ручной `/now` использует все теги пользователя; RSS fallback 24h; дайджест разбивается на 1-3 сообщения по бюджету 3900 символов; `sendDigestToUserNow` возвращает `sent | empty | error`; `last_digest_sent` обновляется только после успешной отправки всех частей.

---

## Статус реализации

| Компонент | Статус | Примечание |
|-----------|--------|------------|
| **Бот @Insidepulse_bot** | ✅ Работает | Отвечает на команды, webhook активен |
| **Webhook auto-setup** | ✅ Реализовано | Автоматическая регистрация при старте сервера |
| **HMAC-linking** | ✅ Реализовано | `/start <userId>:<token>` с verifyLinkToken |
| **Fallback: код восстановления пароля** | ✅ Реализовано | Если email не дошёл, код отправляется в Telegram для пользователей с активным `user_channels.channel='telegram'` |
| **OAuth Login Widget (banner)** | ✅ Реализовано | Кнопка «Подключить бота» на главной через `Telegram.Login.auth` |
| **Профиль → Уведомления** | ✅ Реализовано | UI подключения/отключения бота |
| **Desktop fallback** | ✅ Реализовано | Кнопка "Копировать" с `/start ...` для десктоп |
| **Premium-only проверка** | ✅ Реализовано | `subscription_active = TRUE` для **scheduled** digest; manual `/now` работает для любого подключённого пользователя |
| **Команды бота** | ✅ /start, /now, /stop | /settings — не реализована |
| **Debug endpoint** | ✅ Реализовано | `/debug-telegram` — проверка бота и webhook |
| **Digest (каждый час)** | ✅ Реализовано | Cron + фильтрация по тегам и тихим часам + hybrid fetched_at |
| **Weekly Report** | ✅ Реализовано | Воскресенье 13:00 MSK |
| **Sentiment Alerts** | ✅ Реализовано | Асинхронные алерты по тегам |
| **Fact-check Reports** | ✅ Реализовано | Telegram (MarkdownV2) + HTML email после завершения проверки |
| **Rate limiting** | ✅ Реализовано | 300ms/200ms задержки |
| **Admin Telegram Alerts** | ✅ Реализовано | Алерты админам о событиях пользователей (register, payment, page_view_plans, telegram_connected/disconnected, email_connected/disconnected и др.) |

---

## Содержание

1. [Общая архитектура](#1-общая-архитектура)
2. [Flow подключения пользователя](#2-flow-подключения-пользователя)
3. [Профиль → Уведомления (UI)](#3-профиль--уведомления-ui)
4. [Digest — детальная логика](#4-digest--детальная-логика)
5. [Weekly Report — детальная логика](#5-weekly-report--детальная-логика)
6. [Sentiment Alerts](#6-sentiment-alerts)
6.1. [Admin Telegram Alerts](#61-admin-telegram-alerts)
7. [Bot Commands](#7-bot-commands)
8. [Таблицы БД](#8-таблицы-бд)
9. [Настройки](#9-настройки)
10. [Rate limiting и защита](#10-rate-limiting-и-защита)
11. [API Endpoints](#11-api-endpoints)
12. [Env vars](#12-env-vars)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Общая архитектура

```
+------------------+        +-------------------+        +------------------+
|   PostgreSQL     |        |   PULSE Backend   |        |  Telegram API    |
|   (Supabase)     |<------>|   (Node.js)       |<------>|  (@Insidepulse_  |
|                  |        |                   |        |       bot)       |
+------------------+        +-------------------+        +------------------+
         |                           |                           |
         |                           |                           |
    +----+----+              +-------+-------+           +------+------+
    |  users  |              |  services/    |           |  Webhook    |
    |  news   |              |  - digest.ts  |           |  /webhook/  |
    |  user_  |              |  - reports.ts |           |  telegram   |
    |  channels              |  - telegram.ts|           +-------------+
    |  notif. |              +---------------+
    |  settings              |  Cron Jobs    |
    |  user_  |              |  - digest     |
    |  news_  |              |  - weekly     |
    |  reads  |              |  - alerts     |
    +---------+              +---------------+
```

### Компоненты системы

| Компонент | Файл | Назначение | Статус |
|-----------|------|------------|--------|
| **Digest Service** | `services/digest.ts` | Периодическая рассылка непрочитанных новостей | ✅ |
| **Reports Service** | `services/reports.ts` | Еженедельные аналитические отчёты | ✅ |
| **Fact-check Notifications** | `services/factCheckNotifications.ts` | Отчёт после завершения факт-чекинга | ✅ |
| **Telegram Service** | `services/telegram.ts` | Низкоуровневое взаимодействие с Telegram API (HTML + MarkdownV2) | ✅ |
| **Bot Commands** | `index.ts` (webhook) | Обработка команд пользователя | ✅ |
| **Cron Scheduler** | `node-cron` | Триггеры по расписанию (digest, weekly) | ✅ |

### Потоки данных

```
                    ┌─────────────────┐
                    │   node-cron     │
                    │  Cron Triggers  │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
           ▼                 ▼                 ▼
    ┌────────────┐   ┌────────────┐   ┌────────────┐
    │  Digest    │   │  Weekly    │   │  Sentiment │
    │  (1h)      │   │  (вс 13:00)│   │  (async)   │
    └─────┬──────┘   └─────┬──────┘   └─────┬──────┘
          │                │                │
          └────────────────┼────────────────┘
                           │
                           ▼
              ┌────────────────────┐
              │  Telegram Service  │
              │  sendDigest()      │
              │  sendReport()      │
              │  sendAlert()       │
              └─────────┬──────────┘
                        │
                        ▼
              ┌────────────────────┐
              │  Telegram API      │
              │  @Insidepulse_bot  │
              └────────────────────┘
```

> Дополнительно, после завершения факт-чекинга `services/factCheckNotifications.ts` инициирует отправку отчёта через `sendTelegramMessage(..., 'MarkdownV2')` и email-письмо через `services/email.ts`.

---

## 2. Flow подключения пользователя

### Требования
- **Premium подписка** — бот работает только для Premium пользователей ✅
- **HMAC-подпись** — ссылка содержит защитный токен, предотвращает подмену user_id ✅

### Telegram как fallback-канал для восстановления пароля
Если пользователь запросил восстановление пароля, но email с кодом не удалось отправить (например, провайдер недоступен или адрес не принимает письма), backend ищет активный Telegram-канал (`user_channels.channel='telegram'`, `is_active=true`) и отправляет туда тот же 6-значный код. Email остаётся основным каналом; Telegram — резервный.

### Последовательность шагов

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Пользователь │     │   PULSE      │     │   Telegram   │
│  (Premium)   │     │  Backend     │     │    Bot       │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │ (1) Заходит        │                    │
       │ в Профиль →        │                    │
       │ Уведомления →      │                    │
       │ Telegram           │                    │
       │───────────────────>│                    │
       │  Bearer <JWT>      │                    │
       │                    │ (2) Проверяет      │
       │                    │  subscription_     │
       │                    │  active = TRUE     │
       │                    │  + генерирует      │
       │                    │  HMAC токен        │
       │                    │                    │
       │ (3) Показывает     │                    │
       │ ссылку:            │                    │
       │ /start UID:TOKEN   │                    │
       │<───────────────────│                    │
       │                    │                    │
       │ (4) Нажимает       │                    │
       │ ссылку → открывает │                    │
       │ @Insidepulse_bot   │─────────────────────────────────────────>│
       │                    │                    │
       │                    │                    │ (5) /start UID:TOKEN
       │                    │                    │ → POST /webhook/telegram
       │                    │                    │
       │                    │                    │ (6) verifyLinkToken()
       │                    │                    │  HMAC-SHA256 проверка
       │                    │                    │
       │                    │                    │ (7) Проверка подписки
       │                    │                    │  subscription_active?
       │                    │                    │
       │                    │                    │ (8) INSERT user_channels
       │                    │                    │  UPDATE notification_settings
       │                    │                    │
       │ (9) ✅ Подключено! │                    │
       │    Дайджест активен│<───────────────────│
       │                    │                    │
       │                    │ (5) Регистрирует   │
       │                    │ chat_id в          │
       │                    │ user_channels      │
       │                    │ (tg_digest_enabled │
       │                    │  = TRUE)           │
       │                    │                    │
       │ (6) Приветственное │                    │
       │     сообщение      │                    │
       │<─────────────────────────────────────────│
       │                    │                    │
       │ ╔═══════════════════════════════════╗    │
       │ ║  DONE! Бот подключен              ║    │
       │ ║  Дайджесты начнут приходить      ║    │
       │ ║  по расписанию                   ║    │
       │ ╚═══════════════════════════════════╝    │
       │                    │                    │
```

### Альтернативный поток: баннер «Подключить бота» (OAuth Login Widget)

На главной странице (под каруселью «Общая лента») авторизованным Premium-пользователям без подключённого Telegram показывается баннер с кнопкой **«Подключить бота»**.

```
┌───────────────────────────────────────────────────────────┐
│  Главная страница → TelegramConnectBanner                 │
└──────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│  Frontend: GET /api/telegram/config                       │
│  Response: { botId, botUsername }                         │
└──────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│  Пользователь нажимает «Подключить бота»                  │
│                                                           │
│  Frontend: Telegram.Login.auth({                          │
│              bot_id: <botId>,                             │
│              request_access: 'write',                     │
│              lang: 'ru'                                   │
│            }, callback)                                   │
│            из https://telegram.org/js/telegram-widget.js  │
└──────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│  Popup oauth.telegram.org → пользователь авторизуется     │
│  Telegram возвращает данные через postMessage             │
│  callback(user) = { id, first_name, username,             │
│                     photo_url, auth_date, hash }          │
└──────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│  Frontend: POST /api/auth/telegram (Bearer JWT)           │
│  Backend: проверяет HMAC-SHA256 hash                      │
│           (secret_key = SHA256(bot_token))                │
│           INSERT/UPDATE user_channels                     │
│           SET tg_digest_enabled = TRUE                    │
└──────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│  Frontend запускает polling GET /api/user/telegram-status │
│  каждые 5 секунд; баннер скрывается при connected=true    │
└───────────────────────────────────────────────────────────┘
```

**Особенности:**
- Не требует ручного перехода в бота и ввода `/start`.
- Работает только если домен (`pulse.inside-trade.ru`) добавлен в `@BotFather` через `/setdomain`.
- Fallback: если библиотека не загрузилась — кнопка «Не работает? Нажмите здесь» открывает классический deep link.

### Шаги подключения (подробно)

| Шаг | Действие | Проверка | Результат в БД | Статус |
|-----|----------|----------|----------------|--------|
| **1** | Пользователь заходит в раздел Профиль → Уведомления → Telegram | `subscription_active = TRUE` | — | ✅ |
| **2** | Frontend вызывает `GET /api/telegram/link` (Bearer JWT) | JWT валиден + Premium | — | ✅ |
| **3** | Backend генерирует HMAC-токен | `crypto.createHmac('sha256', BOT_TOKEN).update(userId)` | — | ✅ |
| **4** | Frontend показывает deep link + desktop fallback | — | — | ✅ |
| **5** | Пользователь открывает бота (мобильный) или копирует команду (десктоп) | — | — | ✅ |
| **6** | Бот отправляет webhook `/start UID:TOKEN` | `verifyLinkToken()` — HMAC проверка | — | ✅ |
| **7** | Backend проверяет подписку | `subscription_active = TRUE` | — | ✅ |
| **8** | Backend создаёт/обновляет `user_channels` | — | `channel='telegram', target=chat_id, is_active=true` | ✅ |
| **8b** | Backend обновляет `notification_settings` | — | `tg_digest_enabled = TRUE` | ✅ |
| **9** | Бот отправляет подтверждение | — | — | ✅ |

### Безопасность: HMAC-подпись ✅

**Проблема:** Простой `/start <user_id>` позволяет любому подставить чужой ID и перехватить уведомления.

**Решение:** HMAC-SHA256 подпись, привязанная к TELEGRAM_BOT_TOKEN.

```typescript
// Генерация (Backend)
function generateLinkToken(userId: string): string {
  return crypto.createHmac('sha256', TELEGRAM_BOT_TOKEN)
    .update(userId).digest('hex').slice(0, 16);
}
// → "a3f7b2c9d1e8f5a4"

// Проверка (Bot)
function verifyLinkToken(userId: string, token: string): boolean {
  const expected = generateLinkToken(userId);
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'), 
    Buffer.from(token, 'hex')
  );
}
```

**Deep link формат:**
```
https://t.me/Insidepulse_bot?start=<user_id>:<hmac_token>

Пример:
https://t.me/Insidepulse_bot?start=uuid-123:a3f7b2c9d1e8f5a4
```

### Desktop Fallback ✅

**Проблема:** На MacBook/десктопе deep link (`?start=...`) не всегда передаёт параметр в Telegram Web. Пользователь нажимает ссылку, бот открывается, но команда `/start` приходит без параметров — подключение не происходит.

**Решение:** В профиле показывается двойной интерфейс:

```
┌──────────────────────────────────────────────────────┐
│  📱 Telegram-уведомления                             │
│                                                      │
│  [🟢 Подключено]  или  [⚪ Не подключено]           │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │  📱 Мобильный                               │    │
│  │  [ Открыть @Insidepulse_bot ]               │    │
│  │                                              │    │
│  │  💻 Десктоп (MacBook/PC)                    │    │
│  │  ┌──────────────────────────────┐            │    │
│  │  │ /start uuid-123:a3f7b2...    │ [Копировать]│    │
│  │  └──────────────────────────────┘            │    │
│  └──────────────────────────────────────────────┘    │
│                                                      │
│  ⚠️ Только Premium-подписчики                        │
└──────────────────────────────────────────────────────┘
```

**Инструкция для десктопа:**
1. Нажать **"Получить ссылку для подключения"** в профиле
2. Нажать **"Копировать"** рядом с командой `/start <userId>:<token>`
3. Нажать **"Открыть @Insidepulse_bot"**
4. Вставить скопированную команду в чат бота (`Cmd+V`)
5. Отправить сообщение — бот ответит ✅ **"PULSE подключен!"**

**Почему это работает:**
- Кнопка "Открыть @Insidepulse_bot" открывает `https://t.me/Insidepulse_bot`
- Параметр `?start=` НЕ передаётся через Web-версию Telegram на десктопе
- Пользователь вручную вставляет полную команду `/start UUID:TOKEN`
- Бот получает команду с параметром → вызывает `verifyLinkToken()` → подключение

### Тарифы: кто получает уведомления

| Тариф | Scheduled Digest | Manual `/now` | Weekly Report | Sentiment Alerts | Fact-check Reports |
|-------|------------------|---------------|---------------|------------------|--------------------|
| **Free** | ❌ Нет | ✅ Да (все теги) | ❌ Нет | ✅ Да | ❌ Нет |
| **Premium** | ✅ Каждый час | ✅ Да (все теги) | ✅ Воскресенье | ✅ Мгновенно | ✅ После проверки |

**Проверка подписки (только для scheduled digest):**
```sql
-- В запросе sendAllDigests() — только scheduled digest
SELECT DISTINCT u.id
FROM users u
JOIN notification_settings ns ON ns.user_id = u.id
JOIN user_channels uc ON uc.user_id = u.id
WHERE u.subscription_active = TRUE  ← ← ← ТОЛЬКО PREMIUM (scheduled)
  AND ns.tg_digest_enabled = TRUE
  AND uc.channel = 'telegram'
  AND uc.is_active = TRUE
```

> Manual `/now` не использует этот запрос и не проверяет `subscription_active`. Он ищет пользователя по `chat_id` в `user_channels` и вызывает `sendDigestToUserNow(userId)`.

### Пример данных после подключения

```sql
-- user_channels (после подключения через /start с HMAC)
INSERT INTO user_channels (user_id, channel, target, is_active)
VALUES ('uuid-user-123', 'telegram', '123456789', true);

-- notification_settings (обновлено)
UPDATE notification_settings
SET tg_digest_enabled = TRUE,
    digest_frequency = '1h',
    quiet_hours_enabled = TRUE,
    quiet_hours_start = '23:00',
    quiet_hours_end = '07:00'
    tg_enabled = TRUE
WHERE user_id = 'uuid-user-123';
```

---

## 3. Профиль → Уведомления (UI)

> Раздел профиля, где пользователь управляет подключением Telegram-бота. ✅ Реализовано.

### Структура UI

```
┌────────────────────────────────────────────────────────────┐
│  👤 Профиль                                                │
│  ├── 📊 Общая              (вкладка)                      │
│  ├── 💳 Подписка           (вкладка)                      │
│  ├── 🔔 Уведомления        (вкладка, icon: Bell)  ←──    │
│  └── ⚙️ Настройки          (владка)                      │
│                                                            │
│  Вкладка "Уведомления":                                    │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  📱 Telegram                                         │  │
│  │                                                      │  │
│  │  [🟢 Подключено]                                    │  │
│  │  или                                                 │  │
│  │  [⚪ Не подключено — Получить ссылку]               │  │
│  │                                                      │  │
│  │  Если НЕ Premium:                                    │  │
│  │  "Требуется Premium-подписка" [Обновить]            │  │
│  │                                                      │  │
│  │  ─────────────────────────────────────────────────  │  │
│  │                                                      │  │
│  │  Настройки:                                          │  │
│  │  • Частота дайджеста: [3ч ▼]                       │  │
│  │  • Тихие часы: [✅] 23:00 — 07:00                   │  │
│  │                                                      │  │
│  │  Действия:                                           │  │
│  │  [🔴 Отключить Telegram]                            │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

### Элементы управления Telegram

| Элемент | Условие отображения | Действие | Статус |
|---------|---------------------|----------|--------|
| **Баннер «Подключить бота»** | Главная страница, залогинен, Premium, Telegram не подключён | Открывает OAuth popup через `Telegram.Login.auth` | ✅ |
| **"Получить ссылку для подключения"** | Не подключено + Premium (Профиль → Уведомления) | Генерирует HMAC-ссылку | ✅ |
| **Статус "Подключено"** | `user_channels.is_active = TRUE` | Показывает chat_id (маскированный) | ✅ |
| **Кнопка "Отключить"** | Подключено | `POST /api/user/telegram-disconnect` | ✅ |
| **Частота дайджеста** | Всегда (если Premium) | `digest_frequency`: 1h, 3h, 6h, 12h, 24h | ✅ |
| **Тихие часы** | Всегда | `quiet_hours_enabled` + start/end | ✅ |
| **Desktop fallback** | Всегда при генерации ссылки | Копирование `/start UUID:TOKEN` | ✅ |

### API endpoints

#### `GET /api/user/telegram-status`

Возвращает текущий статус подключения Telegram для авторизованного пользователя.

**Request:**
```http
GET /api/user/telegram-status
Authorization: Bearer <JWT_TOKEN>
```

**Response (подключено):**
```json
{
  "connected": true,
  "chatId": "123456789",
  "botUsername": "Insidepulse_bot",
  "settings": {
    "tg_digest_enabled": true,
    "digest_frequency": "1h",
    "quiet_hours_enabled": true,
    "quiet_hours_start": 23,
    "quiet_hours_end": 7
  }
}
```

**Response (не подключено):**
```json
{
  "connected": false,
  "botUsername": "Insidepulse_bot"
}
```

**Response (нет Premium):**
```json
{ "error": "Premium subscription required" }
```

#### `POST /api/user/telegram-disconnect`

Отключает Telegram-бота для текущего пользователя.

**Request:**
```http
POST /api/user/telegram-disconnect
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json

{}
```

**Действия backend:**
```sql
-- 1. Деактивировать канал
UPDATE user_channels
SET is_active = FALSE
WHERE user_id = '<current_user_id>'
  AND channel = 'telegram';

-- 2. Отключить дайджест
UPDATE notification_settings
SET tg_digest_enabled = FALSE,
    tg_enabled = FALSE
WHERE user_id = '<current_user_id>';
```

**Response (успех):**
```json
{
  "success": true,
  "message": "Telegram-уведомления отключены"
}
```

**Response (не подключено):**
```json
{
  "success": false,
  "message": "Telegram не был подключен"
}
```

### Flow подключения из UI

```
┌───────────────────────────────────────────────────────────┐
│  Пользователь открывает Профиль → Уведомления             │
└──────────────────────┬────────────────────────────────────┘
                       │
                       ▼
┌───────────────────────────────────────────────────────────┐
│  Frontend: GET /api/user/telegram-status                  │
│  (Bearer JWT)                                             │
└──────────────────────┬────────────────────────────────────┘
                       │
          ┌────────────┴────────────┐
          │                         │
          ▼                         ▼
┌─────────────────────┐   ┌─────────────────────────────┐
│  connected = FALSE  │   │  connected = TRUE           │
│                     │   │                             │
│  Показать:          │   │  Показать:                  │
│  • Статус:          │   │  • Статус: "Подключено" 🟢  │
│    "Не подключено"  │   │  • Настройки дайджеста      │
│  • Кнопка:          │   │  • Кнопка "Отключить" 🔴    │
│    "Получить ссылку"│   │                             │
└──────────┬──────────┘   └─────────────────────────────┘
           │
           ▼
┌───────────────────────────────────────────────────────────┐
│  Пользователь нажимает "Получить ссылку"                  │
│                                                           │
│  Frontend: GET /api/telegram/link                         │
│  Response: { deepLink, botUsername, command, token }      │
│                                                           │
│  Показать:                                               │
│  • [📱 Открыть @Insidepulse_bot]                         │
│  • [💻 /start uuid:token] [Копировать]                   │
└───────────────────────────────────────────────────────────┘
```

---

## 4. Digest — детальная логика

### Обзор ✅

Digest — периодическая рассылка непрочитанных новостей по тегам пользователя. Основной и наиболее частый тип уведомления.

```
+----------------------------------------------------------+
|  CRON: каждый час в :00 MSK (setInterval + UTC+3)                       │
|  Запуск: каждый час в :00 минут                          │
|  Пример: 00:00, 01:00, 02:00, 03:00... 24/7              │
+----------------------------------------------------------+
                    │
                    ▼
+----------------------------------------------------------+
|  1. Загрузить всех пользователей с tg_digest_enabled=TRUE│
|  2. Фильтр: только пользователи с активным каналом      │
|  3. Для каждого пользователя:                           │
|     a. Получить теги из portfolios (с учётом тарифа / для /now — все теги)                      │
|     b. Проверить тихие часы                             │
|     c. Найти непрочитанные новости (hybrid filter)      │
|        — fetched_at за 24ч (API sources: Finnhub)       │
|        — published_at с last_digest_sent (RSS)          │
|        — fallback для /now: published_at за 24ч       │
|        — hard limit: published_at за 7 дней             │
|     d. COALESCE(title_ru, title_original) — EN fallback │
|     e. Отфильтровать по тегам пользователя              │
|     f. Отправить дайджест                               │
+----------------------------------------------------------+
```

### Алгоритм сбора новостей (TZ_TG_DIGEST_V3)

```
┌────────────────────┐
│  Запуск по cron    │
│  (каждый час :00)  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Hybrid Window     │
│  fetched_at > 24h  │
│  OR published_at   │
│  > last_digest_sent│
│  (scheduled)       │
│  OR > 24h (/now)   │
│  > 7 days (hard)   │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐      NO     ┌────────────────────┐
│  Пользователь в    │────────────▶│  Пропустить        │
│  тихих часах?      │             │  пользователя      │
└────────┬───────────┘             └────────────────────┘
         │ YES
         ▼
┌────────────────────┐
│  Получить теги     │
│  из portfolios     │
│  (учитывая тариф)  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Выбрать новости   │
│  из news:          │
│  - COALESCE(title_ │
│    ru, title_orig) │
│  - matched_tags && │
│    user_tags       │
│  - NOT IN user_    │
│    news_reads      │
│  ORDER BY GREATEST │
│  (fetched_at, pub) │
│  DESC LIMIT 20     │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐      0      ┌────────────────────┐
│  Новости найдены?  │────────────▶│  Ничего не         │
│                    │             │  отправлять        │
└────────┬───────────┘             └────────────────────┘
         │ > 0
         ▼
┌────────────────────┐
│  Форматировать     │
│  сообщение         │
│  (HTML)            │
│  escapeHtml null   │
│  guard → 'Без      │
│  названия'         │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Отправить через   │
│  sendDigest()      │
│  Rate limit: 300ms │
└────────────────────┘
```

### Фильтрация по тарифу

| Режим | Тариф | Тегов | Описание |
|-------|-------|-------|----------|
| **Scheduled digest** (cron) | Free | 1 тег | Первый тег по `created_at ASC` из `portfolios` |
| **Scheduled digest** (cron) | Premium | 25 тегов | Первые 25 тегов по `created_at ASC` |
| **Manual `/now`** | Любой | **все теги** | Поиск по всем тегам пользователя, как на сайте; не ограничен тарифом |

> Почему `/now` использует все теги: пользователь ожидает, что ручной запрос вернёт те же непрочитанные новости, что видны на сайте. Лента на сайте (`GET /api/news`) не ограничивает теги. Расхождение приводило к ситуации, когда на сайте были видны непрочитанные новости, а бот отвечал «нет свежих».

### Порядок выбора тегов

```sql
SELECT tag_id, tag_name
FROM portfolios
WHERE user_id = $1
ORDER BY created_at ASC
LIMIT $2;  -- для scheduled; для /now LIMIT не используется
```

`ORDER BY created_at ASC` гарантирует детерминированный порядок: при повторных запусках выбирается один и тот же набор тегов.

### Фильтр тихих часов

```typescript
function isQuietHours(settings: NotificationSettings): boolean {
  if (!settings.quiet_hours_enabled) return false;

  const now = new Date();
  const nowMsk = toMoscowTime(now);
  const currentHour = nowMsk.getHours();

  const start = settings.quiet_hours_start; // 0-23
  const end = settings.quiet_hours_end;     // 0-23

  if (start <= end) {
    // Простой интервал: например 23 - 07
    return currentHour >= start && currentHour < end;
  } else {
    // Интервал через полночь: например 22 - 06
    return currentHour >= start || currentHour < end;
  }
}
```

### Пример: тихие часы 23:00 — 07:00

| Время MSK | Действие |
|-----------|----------|
| 00:00 | Пропуск — тихие часы |
| 01:00 | Пропуск — тихие часы |
| 02:00 | Пропуск — тихие часы |
| 03:00 | Пропуск — тихие часы |
| 04:00 | Пропуск — тихие часы |
| 05:00 | Пропуск — тихие часы |
| 06:00 | Пропуск — тихие часы |
| 07:00 | ✅ Отправка дайджеста |
| 08:00 | ✅ Отправка дайджеста |
| ... | ✅ Каждый час |
| 22:00 | ✅ Отправка дайджеста |

### SQL-запрос для сбора новостей (TZ_TG_DIGEST_V3)

```sql
-- Hybrid filter: fetched_at (API sources) + published_at (RSS sources)
SELECT id,
       COALESCE(title_ru, title_original) as title,  -- EN fallback for Finnhub
       url, sentiment, source, matched_tags
FROM news
WHERE matched_tags && ARRAY['tag1', 'tag2']::text[]
  AND (fetched_at > NOW() - INTERVAL '24 hours'         -- API articles (Finnhub)
       OR published_at > NOW() - INTERVAL '24 hours')    -- RSS articles (/now fallback)
  AND published_at > NOW() - INTERVAL '7 days'          -- hard limit
  AND id NOT IN (
    SELECT news_id FROM user_news_reads
    WHERE user_id = 'uuid-user-123'
  )
ORDER BY GREATEST(fetched_at, published_at) DESC
LIMIT 20;
```

### Формат сообщения Digest

Дайджест форматируется в HTML и **разбивается на 1–3 сообщения** по бюджету **3900 символов** на сообщение (лимит Telegram 4096, оставлен запас на служебные символы). Если статьи не помещаются, в последнем сообщении добавляется хвост:

```
…и ещё K статей — <a href="https://pulse.inside-trade.ru">на сайте</a>
```

Правила разбиения:
- Заголовок (`🔔 PULSE — непрочитанные новости`) и footer (`Открыть PULSE →`, `Следующая подборка`) находятся в первом и последнем сообщениях соответственно.
- Нумерация статей сохраняется сквозь все сообщения.
- `last_digest_sent` обновляется **только после успешной отправки всех частей**. Если любая часть не дошла, вся рассылка считается ошибкой.

Пример при большом пуле (2 сообщения):

```
🔔 <b>PULSE — непрочитанные новости</b>
<i>12 новых</i>

1. 🟢 <b>Компания X запустила новый продукт</b>
   📎 <a href="https://example.com/news/1">Читать на сайте</a> · <i>TechCrunch</i>
   🏷 #startup

2. 🔴 <b>Рынок акций упал на 10%</b>
   📎 <a href="https://example.com/news/2">Читать на сайте</a> · <i>Bloomberg</i>
   🏷 #finance

3. ⚪ <b>Новый закон о цифровых активах</b>
   📎 <a href="https://example.com/news/3">Читать на сайте</a> · <i>РБК</i>
   🏷 #crypto

…(остальные статьи в следующем сообщении)…
```

```
4. ⚪ <b>ЦБ оставил ставку без изменений</b>
   📎 <a href="https://example.com/news/4">Читать на сайте</a> · <i>РБК</i>
   🏷 #finance

…и ещё 8 статей — <a href="https://pulse.inside-trade.ru">на сайте</a>

━━━
<a href="https://pulse.inside-trade.ru">Открыть PULSE →</a>
<i>⏰ Следующая подборка через 1 час</i>
```

### Emoji для sentiment

| Sentiment | Emoji | HTML |
|-----------|-------|------|
| **positive** | 🟢 | `&#128308;` (green circle) |
| **negative** | 🔴 | `&#128315;` (red circle) |
| **neutral** | ⚪ | `&#9898;` (white circle) |

### TZ_TG_DIGEST_V3 — Changelog

| Изменение | Описание |
|-----------|----------|
| **Manual `/now` — все теги** | Ручной дайджест больше не ограничен тарифом (`maxTags=null`) — ищет по всем тегам пользователя, как сайт. Исправляет «на сайте есть непрочитанные, а бот пишет нет свежих» |
| **Manual `/now` — RSS fallback 24h** | Было 3ч — слишком узко; теперь 24ч, чтобы совпадало с `fetched_at` окном |
| **ORDER BY created_at ASC** | `portfolios` сортируются перед `LIMIT` — детерминированный выбор тегов |
| **Логирование** | `buildDigest` логирует `userId`, premium/all-tags, tagIds, временные окна и количество кандидатов |
| **Частота** | 3ч → 1ч (`setInterval`, запуск в :00 MSK) |
| **Hybrid filter** | `fetched_at > 24h OR published_at > last_digest_sent` — RSS-новости не теряются между scheduled дайджестами |
| **cron_log** | `UPDATE` вместо `INSERT` → одна строка на задачу; cleanup старых дублей при запуске |
| **COALESCE title** | `COALESCE(title_ru, title_original)` — EN заголовок вместо null для Finnhub |
| **escapeHtml guard** | `escapeHtml(text: string \| null)` — защита от `null.replace()` TypeError |
| **fetched_at INSERT** | `finnhubAdapter.ts` + `rssFetcher.ts` — `fetched_at` в INSERT + `ON CONFLICT UPDATE` |
| **Разбиение дайджеста на 1–3 сообщения** | Бюджет 3900 символов на сообщение; хвост «…и ещё K статей — на сайте»; footer и ссылка на PULSE только в последнем сообщении |
| **Тип возвращаемого значения `sendDigestToUserNow`** | `boolean` → `'sent' \| 'empty' \| 'error'`; `handleDigestNow` различает пустой пул и ошибку отправки |
| **Обновление `last_digest_sent`** | Только после успешной отправки всех частей; при ошибке любой части дайджест не считается доставленным |
| **Лог Telegram API** | В `sendTelegramMessage` добавлены статус, `error_code`, `description` и тело ответа для диагностики `MESSAGE_TOO_LONG` и других ошибок |
### Cron log deduplication

`sendAllDigests()` ведёт аудит-лог в таблице `cron_log`. Чтобы избежать дублей строк при каждом запуске:

1. **Cleanup** на старте — удаляем старые дубли `digest`, оставляем одну свежую:
   ```sql
   SELECT id FROM cron_log WHERE task_name = 'digest' ORDER BY started_at DESC LIMIT 1;
   DELETE FROM cron_log WHERE task_name = 'digest' AND id <> $keep_id;
   ```
2. **UPDATE вместо INSERT**:
   ```sql
   UPDATE cron_log
   SET started_at = NOW(), status = 'running', finished_at = NULL,
       articles_fetched = NULL, articles_saved = NULL
   WHERE task_name = 'digest';
   ```
3. Если `rowCount === 0` — вставляем первую строку:
   ```sql
   INSERT INTO cron_log (task_name, started_at, status)
   VALUES ('digest', NOW(), 'running');
   ```
4. После рассылки — один `UPDATE` финального статуса:
   ```sql
   UPDATE cron_log
   SET finished_at = NOW(), status = 'completed',
       articles_fetched = $total, articles_saved = $sent
   WHERE task_name = 'digest';
   ```

> Результат: в `cron_log` всегда одна строка на задачу `digest`. `/debug-cron` показывает корректный `cron_alive`.

### Ручной запуск дайджеста

Пользователь может запросить дайджест в любой момент через команду `/now` или кнопку «Получить дайджест» (см. [раздел 7](#7-bot-commands)).

Отличия от scheduled digest:

| Параметр | Scheduled (cron) | Manual `/now` |
|----------|------------------|---------------|
| Триггер | Каждый час в :00 MSK | Команда / кнопка |
| Тихие часы | Учитываются | Игнорируются |
| Проверка частоты | Да (`last_digest_sent`) | Нет |
| Проверка `subscription_active` | Только Premium | Нет — любой подключённый |
| Количество тегов | 1 (free) / 25 (premium) | **Все теги** |
| RSS-окно | с `last_digest_sent` | fallback 24 часа |
| Лимит статей | 20 | 20 |
| Обновляет `last_digest_sent` | Да — только после успешной отправки **всех** частей | Да — только после успешной отправки **всех** частей |
| Максимальное число сообщений | 3 | 3 |
| Бюджет на одно сообщение | 3900 символов | 3900 символов |

## 5. Weekly Report — детальная логика

### Обзор ✅

Weekly Report — еженедельный аналитический отчёт, отправляемый только Premium-пользователям.

```
+----------------------------------------------------------+
|  CRON: 0 13 * * 0   (Europe/Moscow)                      │
|  Запуск: каждое воскресенье в 13:00 MSK                  │
+----------------------------------------------------------+
                    │
                    ▼
+----------------------------------------------------------+
|  1. Загрузить Premium-пользователей                       │
|     (subscription_active = TRUE)                          │
|  2. Для каждого:                                          │
|     a. Получить новости за последние 7 дней               │
|     b. Посчитать статистику по sentiment                  │
|     c. Сгруппировать по тегам (max 5 новостей/тег)      │
|     d. Отправить в Telegram + Email                       │
+----------------------------------------------------------+
```

### Алгоритм сбора данных

```
┌────────────────────┐
│  Cron: воскресенье │
│  13:00 MSK         │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐     NO      ┌────────────────────┐
│  Пользователь      │────────────▶│  Пропустить        │
│  Premium?          │             │  пользователя      │
└────────┬───────────┘             └────────────────────┘
         │ YES
         ▼
┌────────────────────┐
│  Window:           │
│  [пн 00:00 — вс   │
│   13:00]           │
│  (последние 7 дней)│
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Статистика:       │
│  - Всего новостей  │
│  - positive count  │
│  - negative count  │
│  - neutral count   │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Группировка:      │
│  по тегам из       │
│  portfolios        │
│  (max 5 news/tag)  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Форматировать     │
│  отчёт (HTML)      │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Отправить:        │
│  - Telegram        │
│  - Email           │
│  Rate limit: 200ms │
└────────────────────┘
```

### SQL-запрос для статистики

```sql
-- Статистика по sentiment за 7 дней
SELECT
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE sentiment = 'positive') as positive,
  COUNT(*) FILTER (WHERE sentiment = 'negative') as negative,
  COUNT(*) FILTER (WHERE sentiment = 'neutral') as neutral
FROM news
WHERE published_at >= NOW() - INTERVAL '7 days'
  AND matched_tags && ARRAY['tag1', 'tag2']::text[];

-- Новости по тегам (max 5 на тег)
SELECT n.*
FROM news n
WHERE n.published_at >= NOW() - INTERVAL '7 days'
  AND 'tag1' = ANY(n.matched_tags)
ORDER BY n.published_at DESC
LIMIT 5;
```

### Формат сообщения Weekly Report

```
📊 <b>PULSE — Еженедельный отчёт</b>
📅 13.01 — 19.01.2025

📈 Статистика:
   Всего новостей: 47
   🟢 Позитивных: 18
   🔴 Негативных: 8
   ⚪ Нейтральных: 21

━━━ <b>#startup</b> (12) ━━━

🟢 <a href="https://example.com/n1">Компания Y привлекла $50M</a>
   <i>TechCrunch</i> · 15 янв

🔴 <a href="https://example.com/n2">Стартап Z закрылся</a>
   <i>TheVerge</i> · 14 янв

━━━ <b>#finance</b> (8) ━━━

⚪ <a href="https://example.com/n3">ЦБ оставил ставку без изменений</a>
   <i>РБК</i> · 17 янв

━━━
<a href="https://pulse.inside-trade.ru">Открыть PULSE →</a>
```

### Период отчёта

| День | Время | Действие |
|------|-------|----------|
| Понедельник 00:00 MSK | — | Начало периода отчёта |
| Воскресенье 13:00 MSK | Cron trigger | Сбор данных и отправка |

---

## 6. Sentiment Alerts

### Обзор ✅

Sentiment Alerts — мгновенные уведомления при резком изменении sentiment по тегу пользователя. Отправляются асинхронно, не по расписанию.

```
┌────────────────────┐
│  Анализ новости    │
│  NLP pipeline      │
│  sentiment scored  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐     NO      ┌────────────────────┐
│  Существенное      │────────────▶│  Нет алерта        │
│  изменение         │             └────────────────────┘
│  sentiment?        │
└────────┬───────────┘
         │ YES
         ▼
┌────────────────────┐
│  Найти всех        │
│  пользователей с   │
│  этим тегом        │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐     NO      ┌────────────────────┐
│  Тихие часы?       │────────────▶│  Поставить в       │
│                    │             │  очередь /         │
│                    │             │  пропустить        │
└────────┬───────────┘             └────────────────────┘
         │ NO
         ▼
┌────────────────────┐
│  sendAlert()       │
│  HTML-формат       │
└────────────────────┘
```

### Триггер алерта

```typescript
// services/telegram.ts
async function sendAlert(
  userId: string,
  chatId: string,
  newsItem: News,
  tagName: string
): Promise<void> {
  // Проверка тихих часов
  const settings = await getNotificationSettings(userId);
  if (isQuietHours(settings)) {
    // Алерт откладывается или пропускается
    return;
  }

  const sentimentEmoji = getSentimentEmoji(newsItem.sentiment);
  const message = `
⚡ <b>Алерт: резкое изменение по тегу "${tagName}"</b>

${sentimentEmoji} <b>${newsItem.title_ru}</b>

📎 <a href="${newsItem.url}">Читать полностью</a>
<i>${newsItem.source}</i> · ${formatDate(newsItem.published_at)}
  `;

  await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
}
```

### Условия отправки алерта

| Условие | Требование |
|---------|------------|
| Тег новости | Должен совпадать с тегом пользователя |
| Sentiment | Должен быть существенно отличным от предыдущего |
| Тихие часы | Если включены — алерт не отправляется |
| Канал | `user_channels.is_active = TRUE` |

---

## 6.1 Admin Telegram Alerts

### Обзор ✅

Админские TG-алерты — мгновенные уведомления администраторам о ключевых событиях пользователей. Настраиваются во вкладке **Alerts** админ-панели (`/admin`).

### Flow алерта

```
Событие пользователя → logUserEvent() → notifyAdmins() → sendTelegramMessage()
```

### Файлы и зависимости

| Файл | Назначение |
|------|------------|
| `src/types/events.ts` | Единый источник типов событий (`UserEventType`, `USER_EVENT_TYPES`). Вынесен, чтобы разорвать циклическую зависимость между `activityLog.ts` и `adminAlerts.ts`. |
| `src/services/activityLog.ts` | Записывает событие в `user_events` и асинхронно вызывает `notifyAdmins()`. |
| `src/services/adminAlerts.ts` | Загружает настройки админов из `admin_tg_settings`, фильтрует по `event_types` и отправляет сообщения через `sendTelegramMessage()`. |
| `src/pages/admin/TgAlertsTab.tsx` | UI настройки алертов в админке. |
| `src/pages/admin/ActivityFeed.tsx` | Лента событий (polling). |

### Список событий

| Event Type | Label | Когда триггерится |
|------------|-------|------------------|
| `register` | Регистрация | Новый пользователь завершил регистрацию |
| `login` | Вход | Пользователь авторизовался |
| `forgot_password` | Забыли пароль | Запрос на восстановление пароля |
| `password_reset` | Сброс пароля | Пароль успешно сброшен |
| `tag_added` | Добавлен тег | Пользователь добавил тег в портфолио |
| `tag_removed` | Удалён тег | Пользователь удалил тег из портфолио |
| `payment_completed` | Оплата | Успешный платёж |
| `subscription_activated` | Подписка активирована | Подписка активирована/продлена |
| `subscription_cancelled` | Подписка отменена | Подписка отменена (вручную или админом) |
| `telegram_connected` | Telegram подключён | Пользователь подключил Telegram-бота |
| `telegram_disconnected` | Telegram отключён | Пользователь отключил Telegram-бота |
| `email_connected` | Email подключён | Пользователь зарегистрировался (email подтверждён) |
| `email_disconnected` | Email отключён | Пользователь отключил email-уведомления |
| `sentiment_vote` | Прогноз индекса (голос) | Пользователь проголосовал в Sentiment Index |
| `page_view_plans` | Просмотр тарифов | Пользователь открыл страницу тарифов |
| `factcheck_ordered` | Заказан фактчек | Пользователь заказал факт-чекинг |

> **Примечание:** типы `channel_connected` / `channel_disconnected` (универсальные) устарели; используются специфичные `telegram_connected` / `telegram_disconnected` / `email_connected` / `email_disconnected`.

### Тестовое сообщение не сбрасывает события

Кнопка **«Отправить тест»** (`POST /admin/tg-alerts/test`) отправляет тестовое сообщение и, при успехе, сохраняет настройки. Важно: она **не затирает** уже выбранные `event_types` — берёт их из текущей записи админа и сохраняет обратно. Раньше из-за бага в `sendTestAlert` вызов `saveAdminTgSettings(..., [], true)` сбрасывал события в пустой массив. После фикса тест безопасен.

### Просмотр тарифов (`page_view_plans`)

> ⚠️ Важно: frontend-клиент `api` уже включает `/api` prefix (`API_BASE = 'https://pulse-api-bsov.onrender.com/api'`). Поэтому запрос со страницы тарифов должен идти на ** `/events/page-view`**, а не на `/api/events/page-view`. Двойной `/api` приводит к 404 и алерт не приходит.

**Frontend:**
```typescript
// src/pages/Pricing.tsx
useEffect(() => {
  if (!isLoggedIn) return
  api.post('/events/page-view', { page: 'plans' }).catch(() => {})
}, [isLoggedIn])
```

**Backend:**
```typescript
// POST /api/events/page-view
app.post('/api/events/page-view', authMiddleware, async (req, res) => {
  const { page } = req.body;
  if (page === 'plans') {
    logPageViewPlans(req.user!.userId).catch(() => {});
  }
  res.json({ success: true });
});
```

Flow:
```
Пользователь открывает /pricing
  → Frontend POST /api/events/page-view { page: 'plans' }
  → Backend logPageViewPlans(userId)
  → logUserEvent('page_view_plans', { page: 'plans' })
  → notifyAdmins('page_view_plans', ...)
  → sendTelegramMessage(chat_id, formatted_alert)
```

### API Endpoints

#### `GET /admin/tg-alerts/settings`

Возвращает настройки алертов для текущего админа + полный список доступных событий.

```json
{
  "settings": {
    "id": "...",
    "tg_chat_id": "123456789",
    "event_types": ["register", "payment_completed", "page_view_plans", "telegram_connected", "telegram_disconnected", "email_connected", "email_disconnected"],
    "is_active": true
  },
  "event_types": [
    { "value": "register", "label": "Регистрация" },
    ...
  ]
}
```

#### `PUT /admin/tg-alerts/settings`

Сохраняет настройки алертов.

```json
{
  "tg_chat_id": "123456789",
  "event_types": ["register", "payment_completed", "page_view_plans", "telegram_connected", "telegram_disconnected", "email_connected", "email_disconnected"],
  "is_active": true
}
```

#### `POST /admin/tg-alerts/test`

Отправляет тестовое сообщение в указанный чат.

```json
{ "tg_chat_id": "123456789" }
```

### Формат сообщения

```
🔔 <b>Просмотр тарифов</b>

👤 <b>Пользователь:</b> user@example.com
   📧 user@example.com
   🆔 <code>uuid-123</code>

📄 Страница: тарифы
```

---

## 7. Bot Commands

### Обработчик команд ✅

```typescript
// index.ts → /webhook/telegram
app.post('/webhook/telegram', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text;

  switch (text) {
    case '/start':  await handleStart(chatId, message); break;
    case '/now':    await handleNow(chatId, message);   break;
    case '/stop':   await handleStop(chatId, message);  break;
    case '/settings': await handleSettings(chatId);     break;
  }

  res.sendStatus(200);
});
```

### Описание команд

#### `/start` — Приветствие и подключение ✅

```
Вход: /start или /start <user_id>:<token>

Действия:
1. Если передан user_id:token — связать chat_id с пользователем
   через verifyLinkToken() + проверка subscription_active = TRUE
2. Создать/обновить запись в user_channels
3. Установить tg_digest_enabled = TRUE
4. Отправить приветственное сообщение

Ответ (успешное подключение):
┌──────────────────────────────────────────┐
│ ✅ PULSE подключен!                      │
│                                          │
│ Вы подключены к уведомлениям.            │
│ Бот будет присылать дайджест новостей    │
│ по вашим тегам каждый час.               │
│                                          │
│ Команды:                                 │
│ /now — получить дайджест сейчас          │
│ /stop — отключить уведомления            │
└──────────────────────────────────────────┘

Ответ (простое приветствие, без подключения):
┌──────────────────────────────────────────┐
│ 👋 Добро пожаловать в PULSE!             │
│                                          │
│ Для подключения:                         │
│ 1. Откройте PULSE → Профиль              │
│ 2. Перейдите в раздел "Уведомления"      │
│ 3. Нажмите "Получить ссылку"             │
└──────────────────────────────────────────┘
```

#### `/now` — Мгновенный дайджест по всем тегам ✅

```
Вход: /now

Действия:
1. Получить chat_id пользователя
2. Найти user_id по chat_id в user_channels
3. Вызвать sendDigestToUserNow(userId)
4. Игнорировать тихие часы и проверку частоты
5. Использовать ВСЕ теги пользователя (не тарифный лимит)
6. RSS fallback: published_at за 24 часа (вместо 3)
7. Разбить дайджест на 1-3 сообщения по бюджету 3900 символов
8. Отправить все части последовательно с задержкой 200 мс

Возвращаемое значение:
- 'sent'   — все части дайджеста успешно отправлены, last_digest_sent обновлен
- 'empty'  — нет непрочитанных новостей или пользователь/канал не найден
- 'error'  — Telegram API вернул ошибку (например, MESSAGE_TOO_LONG) или упал sendAllDigestMessages

Ответ пользователю:
- 'sent':   дайджест приходит в чат (возможно, несколькими сообщениями)
- 'empty':  📭 Нет новых непрочитанных новостей по вашим тегам.
- 'error':  ❌ Ошибка отправки дайджеста. Попробуйте позже.
```

#### `/stop` — Отключение уведомлений ✅

```
Вход: /stop

Действия:
1. Найти пользователя по chat_id
2. Установить tg_digest_enabled = FALSE
3. Установить is_active = FALSE в user_channels
4. Отправить подтверждение

Ответ:
┌──────────────────────────────────────────┐
│ 🚫 Уведомления отключены.                │
│                                          │
│ Вы больше не будете получать дайджесты.  │
│ Чтобы включить снова — нажмите /start    │
│ или подключите в Профиле → Уведомления   │
└──────────────────────────────────────────┘
```

#### `/settings` — Настройки ⚠️ Не реализована

```
Статус: Команда описана в коде, но не реализована полностью.
Пользователь управляет настройками через UI профиля:
Профиль → Уведомления → Настройки Telegram
```

### Команды-шпаргалка

| Команда | Статус | Доступ | Описание |
|---------|--------|--------|----------|
| `/start` | ✅ Реализовано | Все | Подключение через HMAC, приветствие |
| `/start <uid>:<token>` | ✅ Реализовано | Premium | Подключение аккаунта (HMAC-linking) |
| `/now` | ✅ Реализовано | Любой подключённый | Мгновенный дайджест по всем тегам по всем тегам |
| `/stop` | ✅ Реализовано | Только подключённые | Отключение дайджестов |
| `/settings` | ⚠️ Не реализована | — | Управление настройками через UI профиля |

---

## 8. Таблицы БД

### Полная схема данных

```
+---------------------+     +---------------------+     +---------------------+
|       users         |     |    user_channels    |     | notification_       |
|                     |     |                     |     |    settings         |
+---------------------+     +---------------------+     +---------------------+
| id (uuid) PK        |<----| user_id (uuid) FK   |     | user_id (uuid) FK   |
| email (text)        |     | channel (text)      |     | tg_digest_enabled   |
| subscription_active |     | target (text)       |     |     (boolean)       |
|    (boolean)        |     |   └─ chat_id        |     | digest_frequency    |
| subscription_expires|     | is_active (boolean) |     |     (text)          |
|    _at (timestamptz)|     +---------------------+     | quiet_hours_enabled |
+---------------------+                                 |     (boolean)       |
                                                        | quiet_hours_start   |
+---------------------+                                 |     (integer)       |
|    portfolios       |                                 | quiet_hours_end     |
|                     |                                 |     (integer)       |
+---------------------+                                 | last_digest_sent    |
| user_id (uuid) FK   |                                 |     (timestamptz)   |
| tag_id (text)       |                                 | tg_enabled          |
| tag_name (text)     |                                 |     (boolean)       |
+---------------------+                                 | email_enabled       |
                                                        |     (boolean)       |
+---------------------+                                 | report_format       |
|  user_news_reads    |                                 |     (text)          |
|                     |                                 +---------------------+
+---------------------+
| user_id (uuid) FK   |
| news_id (uuid) FK   |
| read_at (timestamptz
+---------------------+

+---------------------+
|       news          |
+---------------------+
| id (uuid) PK        |
| title_ru (text)     |
| url (text)          |
| sentiment (text)    |
| source (text)       |
| matched_tags (text[]
| published_at        |
|    (timestamptz)    |
+---------------------+
```

### Детальное описание таблиц

#### `users`

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | `uuid` | PK, уникальный идентификатор |
| `email` | `text` | Email пользователя |
| `subscription_active` | `boolean` | Активна ли Premium-подписка (проверяется `= TRUE`) |
| `subscription_expires_at` | `timestamptz` | Дата окончания подписки |

#### `portfolios`

| Поле | Тип | Описание |
|------|-----|----------|
| `user_id` | `uuid` | FK → users.id |
| `tag_id` | `text` | Идентификатор тега |
| `tag_name` | `text` | Человекочитаемое имя тега |

#### `user_channels`

| Поле | Тип | Описание |
|------|-----|----------|
| `user_id` | `uuid` | FK → users.id |
| `channel` | `text` | Тип канала: `'telegram'` |
| `target` | `text` | Chat ID пользователя в Telegram |
| `is_active` | `boolean` | Активен ли канал |

#### `notification_settings`

| Поле | Тип | Описание |
|------|-----|----------|
| `user_id` | `uuid` | FK → users.id |
| `tg_digest_enabled` | `boolean` | Включён ли дайджест |
| `digest_frequency` | `text` | Частота: `1h`, `3h`, `6h`, `12h`, `24h` |
| `quiet_hours_enabled` | `boolean` | Включены ли тихие часы |
| `quiet_hours_start` | `integer` | Час начала тихих часов (0-23) |
| `quiet_hours_end` | `integer` | Час окончания тихих часов (0-23) |
| `last_digest_sent` | `timestamptz` | Время последней отправки дайджеста |
| `tg_enabled` | `boolean` | Telegram канал активен (общий флаг) |
| `email_enabled` | `boolean` | Email канал активен (общий флаг) |
| `report_format` | `text` | Формат отчёта |
| `fact_check_email_enabled` | `boolean` | Отправлять email-отчёт после факт-чекинга |
| `fact_check_tg_enabled` | `boolean` | Отправлять Telegram-отчёт после факт-чекинга |

#### `user_news_reads`

| Поле | Тип | Описание |
|------|-----|----------|
| `user_id` | `uuid` | FK → users.id |
| `news_id` | `uuid` | FK → news.id |
| `read_at` | `timestamptz` | Время прочтения |

#### `news`

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | `uuid` | PK |
| `title_ru` | `text` | Заголовок на русском |
| `url` | `text` | Ссылка на новость |
| `sentiment` | `text` | `'positive'`, `'negative'`, `'neutral'` или `NULL` |
| `source` | `text` | Источник новости |
| `matched_tags` | `text[]` | Массив тегов, которым соответствует новость |
| `published_at` | `timestamptz` | Время публикации |

---

## 9. Настройки

### Частота дайджеста (`digest_frequency`)

| Значение | Cron-выражение | Описание |
|----------|----------------|----------|
| `1h` | `0 * * * *` | Каждый час в :00 (по умолчанию) |
| `3h` | `0 */3 * * *` | Каждые 3 часа в :00 |
| `6h` | `0 */6 * * *` | Каждые 6 часов в :00 |
| `12h` | `0 */12 * * *` | Каждые 12 часов в :00 |
| `24h` | `0 9 * * *` | Раз в день в 09:00 MSK |

```
Частота 1h (default):
00:00 ████ дайджест
03:00 ████ дайджест
06:00 ████ дайджест
09:00 ████ дайджест
12:00 ████ дайджест
15:00 ████ дайджест
18:00 ████ дайджест
21:00 ████ дайджест
```

### Тихие часы (`quiet_hours`)

```
quiet_hours_enabled = TRUE
quiet_hours_start   = 23  (23:00)
quiet_hours_end     = 7   (07:00)

Timeline (24h):
00 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23
██  ██  ██  ██  ██  ██  ██  ░░  ░░  ░░  ░░  ░░  ░░  ░░  ░░  ░░  ░░  ░░  ██
^-- ТИХИЕ ЧАСЫ --^              ^------ АКТИВНЫЕ ЧАСЫ -------^

██ = тихие часы (digest НЕ отправляется)
░░ = активные часы (digest отправляется)
```

### Проверка тарифа в коде

```typescript
// services/digest.ts
async function isPremium(userId: string): Promise<boolean> {
  const result = await query(
    `SELECT subscription_active, subscription_expires_at
     FROM users WHERE id = $1`,
    [userId]
  );
  const row = result.rows[0];
  if (!row) return false;
  return row.subscription_active === true && new Date(row.subscription_expires_at) > new Date();
}

// Scheduled digest: тарифный лимит
const premium = await isPremium(userId);
const maxTags = premium ? 25 : 1;
const articles = await buildDigest(userId, maxTags, lastDigestSent, 'scheduled');

// Manual /now: все теги
const articles = await buildDigest(userId, null, null, 'manual');
```

> `isPremium` используется только для scheduled-рассылки. Manual `/now` не проверяет premium-статус и строит дайджест по всем тегам.

---

## 10. Rate Limiting и защита

### Ограничения

| Компонент | Задержка | Назначение |
|-----------|----------|------------|
| **Digest** | `300ms` между пользователями | Предотвращение flood Telegram API |
| **Weekly Report** | `200ms` между пользователями | Аналогично, меньше задержка т.к. реже |
| **Sentiment Alert** | Без задержки | Асинхронные, разнесены по времени |

### Реализация rate limit

```typescript
// services/digest.ts
async function sendDigestToAllUsers(): Promise<void> {
  const users = await getDigestEnabledUsers();

  for (const user of users) {
    const result = await sendDigestToUser(user.id);
    if (result === 'sent') sent++;
    else if (result === 'error') errors++;
    else skipped++;
    await sleep(300); // Rate limit: 300ms
  }
}

// services/reports.ts
async function sendWeeklyReports(): Promise<void> {
  const premiumUsers = await getPremiumUsers();

  for (const user of premiumUsers) {
    await sendReport(user.id, user.chatId);
    await sleep(200); // Rate limit: 200ms
  }
}

// Утилита
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

### Защита от повторной отправки

```typescript
// Проверка last_digest_sent
async function shouldSendDigest(userId: string, frequency: string): Promise<boolean> {
  const settings = await getNotificationSettings(userId);

  if (!settings.last_digest_sent) return true;

  const intervalMs = parseFrequencyToMs(frequency);
  const nextDigestTime = new Date(
    settings.last_digest_sent.getTime() + intervalMs
  );

  return new Date() >= nextDigestTime;
}
```

### Ограничения Telegram Bot API

| Лимит | Значение | Комментарий |
|-------|----------|-------------|
| Сообщения в группу | 20/мин | Не критично для нашей нагрузки |
| Сообщения пользователю | ~30/сек | Rate limit 300ms = ~3/сек — в пределах нормы |
| Длина сообщения | 4096 символов | Digest может быть обрезан |

---

## 11. API Endpoints

### `GET /api/telegram/config` — Конфигурация для OAuth-виджета ✅

Публичный endpoint. Возвращает `botId` и `botUsername`, необходимые frontend'у для инициализации официального Telegram Login Widget.

**Request:**
```http
GET /api/telegram/config
```

**Response (успех):**
```json
{
  "botId": 8226463754,
  "botUsername": "Insidepulse_bot"
}
```

**Response (бот не настроен):**
```json
{ "error": "Telegram bot not configured" }
```

### `POST /api/auth/telegram` — Подключение через OAuth-виджет ✅

Принимает данные пользователя, полученные от официального Telegram Login Widget после успешной авторизации в popup. Требует авторизацию (Bearer JWT).

**Request:**
```http
POST /api/auth/telegram
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json

{
  "id": 123456789,
  "first_name": "Vlad",
  "username": "vladfa",
  "photo_url": "https://t.me/i/userpic/...",
  "auth_date": 1751300000,
  "hash": "..."
}
```

**Проверка backend:**
- Пользователь существует и имеет `subscription_active = TRUE`.
- Проверка HMAC-SHA256 подписи (`secret_key = SHA256(TELEGRAM_BOT_TOKEN)`).
- Проверка свежести `auth_date` (не старше 24 часов).

**Действия backend:**
```sql
INSERT INTO user_channels (id, user_id, channel, target, is_active)
VALUES (gen_random_uuid(), '<current_user_id>', 'telegram', '<id>', TRUE)
ON CONFLICT (user_id, channel) DO UPDATE SET target = '<id>', is_active = TRUE;

INSERT INTO notification_settings (user_id, tg_digest_enabled)
VALUES ('<current_user_id>', TRUE)
ON CONFLICT (user_id) DO UPDATE SET tg_digest_enabled = TRUE;
```

**Response (успех):**
```json
{ "success": true, "chatId": "123456789" }
```

**Response (ошибка подписи):**
```json
{ "error": "Invalid Telegram auth signature" }
```

**Response (нет Premium):**
```json
{ "error": "Premium subscription required" }
```

### `GET /api/telegram/link` — Генерация ссылки подключения ✅

Требует авторизацию (Bearer JWT). Возвращает deep link с HMAC-подписью.

**Request:**
```http
GET /api/telegram/link
Authorization: Bearer <JWT_TOKEN>
```

**Response (Premium):**
```json
{
  "deepLink": "https://t.me/Insidepulse_bot?start=uuid-123:a3f7b2c9d1e8f5a4",
  "botUsername": "Insidepulse_bot",
  "command": "/start uuid-123:a3f7b2c9d1e8f5a4",
  "expiresIn": "24h"
}
```

**Response (Free / без подписки):**
```json
{ "error": "Premium subscription required" }
```

**Response (неавторизован):**
```json
{ "error": "Unauthorized" }
```

### `GET /api/user/telegram-status` — Статус подключения ✅

Возвращает текущий статус подключения Telegram. См. [раздел 3](#3-профиль--уведомления-ui).

### `POST /api/user/telegram-disconnect` — Отключение бота ✅

Отключает Telegram-бота для текущего пользователя. См. [раздел 3](#3-профиль--уведомления-ui).

### `GET /api/user/notifications` — Настройки уведомлений ✅

Возвращает все настройки `notification_settings`, включая флаги рассылки репортов факт-чекинга:

```json
{
  "settings": {
    "tg_enabled": true,
    "email_enabled": true,
    "push_enabled": false,
    "fact_check_email_enabled": true,
    "fact_check_tg_enabled": true
  }
}
```

### `PATCH /api/user/notifications` — Обновление настроек уведомлений ✅

Принимает только поля из белого списка. Для управления отчётами факт-чекинга используются:

```http
PATCH /api/user/notifications
Authorization: Bearer <JWT_TOKEN>
Content-Type: application/json

{
  "fact_check_email_enabled": true,
  "fact_check_tg_enabled": false
}
```

**Response:**
```json
{ "success": true }
```

### `POST /webhook/telegram` — Webhook бота ✅

Принимает обновления от Telegram API. Обрабатывает команды.

**Команды:**
| Команда | Описание | Требования | Статус |
|---------|----------|------------|--------|
| `/start` | Приветствие, статус подключения | — | ✅ |
| `/start <uid>:<token>` | Подключение аккаунта (HMAC) | Premium | ✅ |
| `/now` | Мгновенный дайджест по всем тегам | Подключен | ✅ |
| `/stop` | Отключить рассылку | Подключен | ✅ |
| `/settings` | Настройки | Подключен | ⚠️ Не реализована |

### `GET /debug-telegram` — Debug endpoint ✅

Проверяет состояние бота и webhook. Доступен без авторизации (или с базовой проверкой).

**Response (успех):**
```json
{
  "bot": {
    "username": "Insidepulse_bot",
    "connected": true
  },
  "webhook": {
    "url": "https://api.pulse.com/webhook/telegram",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "max_connections": 40
  },
  "timestamp": "2025-01-20T12:34:56.789Z"
}
```

**Response (ошибка webhook):**
```json
{
  "bot": { "username": "Insidepulse_bot", "connected": true },
  "webhook": { "error": "Webhook not set" },
  "fix": "Перезапустить сервер — webhook auto-setup сработает при старте"
}
```

### Конфигурация Webhook ✅

Webhook настраивается **автоматически** при старте сервера:

```typescript
// index.ts — инициализация при старте
async function setupWebhook(): Promise<void> {
  const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.warn('TELEGRAM_WEBHOOK_URL not set, skipping webhook setup');
    return;
  }

  try {
    await bot.setWebHook(webhookUrl);
    console.log('✅ Telegram webhook set:', webhookUrl);
  } catch (error) {
    console.error('❌ Failed to set webhook:', error);
  }
}

// Вызов при старте
setupWebhook();
```

### Структура входящего webhook

```json
{
  "update_id": 123456789,
  "message": {
    "message_id": 1,
    "from": {
      "id": 123456789,
      "is_bot": false,
      "first_name": "Иван",
      "username": "ivan"
    },
    "chat": {
      "id": 123456789,
      "type": "private"
    },
    "date": 1705689600,
    "text": "/start uuid-123:a3f7b2c9d1e8f5a4"
  }
}
```

### Поля для идентификации

| Поле | Описание | Использование |
|------|----------|---------------|
| `message.chat.id` | Chat ID пользователя | Сохраняется в `user_channels.target` |
| `message.from.id` | User ID Telegram | Логирование |
| `message.text` | Текст команды | Маршрутизация команд |

---

## 12. Env Vars

### Переменные окружения

| Переменная | Значение | Описание |
|------------|----------|----------|
| `TELEGRAM_BOT_TOKEN` | `8226463754:AAH...HeZo` | Токен бота @Insidepulse_bot |
| `TELEGRAM_WEBHOOK_URL` | `https://api.pulse.com/webhook/telegram` | URL для webhook |
| `DATABASE_URL` | `postgresql://...` | Строка подключения к Supabase |
| `TZ` | `Europe/Moscow` | Часовой пояс для cron (обязательно!) |

### Пример .env

```env
# Telegram
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_WEBHOOK_URL=https://api.pulse.com/webhook/telegram

# Database
DATABASE_URL=postgresql://user:pass@host.supabase.co:5432/postgres

# Timezone (критично для cron!)
TZ=Europe/Moscow
```

### Инициализация бота

```typescript
import TelegramBot from 'node-telegram-bot-api';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN!;

// Webhook mode (production)
const bot = new TelegramBot(TOKEN);

// Или polling mode (development)
// const bot = new TelegramBot(TOKEN, { polling: true });
```

---

## 13. Troubleshooting

### Частые проблемы

#### Таблица быстрого решения

| Проблема | Причина | Решение |
|----------|---------|---------|
| Бот не отвечает на `/start` | Webhook не настроен | Проверить `/debug-telegram`, перезапустить сервер |
| "Неверная ссылка" при подключении | Токен устарел (expiresIn: 24h) | Сгенерировать новую ссылку в профиле |
| На MacBook не копируется команда | Desktop fallback не используется | Использовать кнопку "Копировать" + вставить в чат |
| Нет Premium в профиле, подписка активна | `subscription_active = 1` (булев баг) | Исправлено на `= TRUE` в v5.2 |
| Дайджест не приходит | Тихие часы или нет новостей | Проверить настройки в профиле, убедиться что тегам есть новости |
| 403 Forbidden от Telegram | Пользователь заблокировал бота | Бот автоматически отключает `is_active = FALSE` |
| **Админские алерты не приходят** | `event_types` сброшен в пустой массив (старый баг теста) или событие не логируется | Проверить `admin_tg_settings.event_types`, повторно сохранить настройки; проверить логи `[ActivityLog]` и `[AdminAlerts]` |

#### Проблема: Админские TG-алерты не приходят

```
┌──────────────────────────────────────────────────────┐
│  🔍 Диагностика:                                     │
│                                                      │
│  1. Проверить настройки админа:                      │
│     SELECT * FROM admin_tg_settings                  │
│     WHERE admin_user_id = '<admin_uuid>';            │
│     → is_active = TRUE, tg_chat_id заполнен,        │
│       event_types содержит нужный тип события      │
│                                                      │
│  2. Если event_types = '{}':                         │
│     → Пересохранить настройки во вкладке Alerts.   │
│     → Старый баг: кнопка «Отправить тест» сбрасы-  │
│       вала события. Уже исправлен.                  │
│                                                      │
│  3. Проверить, что событие логируется:               │
│     SELECT * FROM user_events                       │
│     WHERE event_type = 'tag_added'                  │
│     ORDER BY created_at DESC LIMIT 5;                │
│                                                      │
│  4. Проверить логи backend:                          │
│     [ActivityLog] event logged: ...                │
│     [AdminAlerts] notifyAdmins called: ...           │
│     [AdminAlerts] message sent to ...                │
│                                                      │
│  5. Для page_view_plans:                             │
│     → Убедиться, что production frontend задеплоен.  │
│     → Frontend шлёт POST /api/events/page-view.    │
│     → Render Static Site требует ручного деплоя.     │
└──────────────────────────────────────────────────────┘
```

#### Проблема: Дайджест не приходит

```
┌──────────────────────────────────────────────────────┐
│  🔍 Диагностика:                                     │
│                                                      │
│  1. Проверить user_channels:                         │
│     SELECT * FROM user_channels                      │
│     WHERE target = '<chat_id>'                       │
│     AND channel = 'telegram';                        │
│     → is_active должен быть TRUE                     │
│                                                      │
│  2. Проверить notification_settings:                 │
│     SELECT tg_digest_enabled FROM notification_      │
│     settings WHERE user_id = '<user_id>';            │
│     → должен быть TRUE                               │
│                                                      │
│  3. Проверить тихие часы:                            │
│     SELECT quiet_hours_enabled,                      │
│            quiet_hours_start, quiet_hours_end        │
│     FROM notification_settings;                      │
│     → если TRUE — проверить, не попадает ли          │
│       текущее время в диапазон                       │
│                                                      │
│  4. Проверить наличие новостей:                      │
│     SELECT COUNT(*) FROM news                        │
│     WHERE published_at > NOW() - INTERVAL '3h'       │
│     AND matched_tags && ARRAY['<user_tag>'];         │
│     → должен быть > 0                                │
│                                                      │
│  5. Проверить, не прочитаны ли все:                  │
│     SELECT COUNT(*) FROM user_news_reads             │
│     WHERE user_id = '<user_id>';                     │
│     → если все прочитаны — дайджест пустой           │
│                                                      │
│  6. Быстрая проверка:                                │
│     GET /debug-telegram                              │
│     → webhook URL должен совпадать с текущим доменом │
└──────────────────────────────────────────────────────┘
```

#### Проблема: Weekly Report не приходит

| Причина | Проверка |
|---------|----------|
| Не Premium | `subscription_active = FALSE` |
| Нет новостей за неделю | `news` за 7 дней пуста по тегам |
| Канал неактивен | `user_channels.is_active = FALSE` |

#### Проблема: Ошибка отправки в Telegram

```
Коды ошибок Telegram API:
┌──────────────┬──────────────────────────────────────┐
│ 400 Bad      │ Невалидный chat_id, пользователь     │
│ Request      │ заблокировал бота                    │
├──────────────┼──────────────────────────────────────┤
│ 403          │ Пользователь удалил чат, бот         │
│ Forbidden    │ заблокирован                         │
├──────────────┼──────────────────────────────────────┤
│ 429 Too Many │ Rate limit превышен                  │
│ Requests     │ (снизить частоту в cron)             │
├──────────────┼──────────────────────────────────────┤
│ 409 Conflict │ Webhook уже установлен               │
├──────────────┼──────────────────────────────────────┤
│ 500 Internal │ Проблема на стороне Telegram         │
│ Server Error │ (повторить позже)                    │
└──────────────┴──────────────────────────────────────┘
```

#### Проблема: Дублирование дайджестов

| Причина | Решение |
|---------|---------|
| Два инстанса backend | Убедиться, что cron работает только на 1 ноде |
| Перезапуск контейнера | Проверить `last_digest_sent` перед отправкой |
| Часовой пояс | Установить `TZ=Europe/Moscow` |

### Полезные SQL-запросы для отладки

```sql
-- 1. Список всех подключённых Telegram-пользователей
SELECT
  u.email,
  uc.target AS chat_id,
  uc.is_active,
  ns.tg_digest_enabled,
  ns.digest_frequency,
  ns.quiet_hours_enabled
FROM users u
JOIN user_channels uc ON u.id = uc.user_id
JOIN notification_settings ns ON u.id = ns.user_id
WHERE uc.channel = 'telegram';

-- 2. Количество пользователей с включённым дайджестом
SELECT COUNT(*)
FROM notification_settings
WHERE tg_digest_enabled = TRUE;

-- 3. Статистика по последнему дайджесту
SELECT
  u.email,
  ns.last_digest_sent,
  ns.digest_frequency
FROM users u
JOIN notification_settings ns ON u.id = ns.user_id
WHERE ns.tg_digest_enabled = TRUE
ORDER BY ns.last_digest_sent DESC;

-- 4. Новости за последний window по тегу пользователя
SELECT
  n.title_ru,
  n.sentiment,
  n.source,
  n.published_at
FROM news n
WHERE n.matched_tags @> ARRAY['startup']
  AND n.published_at >= NOW() - INTERVAL '3 hours'
ORDER BY n.published_at DESC;

-- 5. Пользователи с непрочитанными новостями
SELECT
  u.id,
  u.email,
  COUNT(n.id) AS unread_count
FROM users u
JOIN portfolios p ON u.id = p.user_id
JOIN news n ON n.matched_tags @> ARRAY[p.tag_name]
LEFT JOIN user_news_reads unr
  ON unr.news_id = n.id AND unr.user_id = u.id
WHERE n.published_at >= NOW() - INTERVAL '3 hours'
  AND unr.news_id IS NULL
GROUP BY u.id, u.email
ORDER BY unread_count DESC;
```

### Логи и мониторинг

| Метрика | Источник | Действие при проблеме |
|---------|----------|----------------------|
| Кол-во отправленных digest | Лог `sendDigestToUser` | < 90% от целевого — проверить cron |
| Ошибки Telegram API | `catch` в sendMessage | > 5% — проверить rate limit |
| Длительность отправки | Тайминги в логах | > 5 мин — увеличить rate limit |
| Блокировки пользователей | 403 Forbidden от Telegram | Автоматически отключать `is_active` |

---

## Приложение A: Полный Flow отправки Digest

```
+====================================================================+
|  CRON TRIGGER: 0 * * * * (Europe/Moscow)                          |
|  Например: 2025-01-15 09:00:00 MSK                                |
+==============================+=======================================+
                               │
                               ▼
+====================================================================+
|  STEP 1: Загрузить пользователей                                   |
|                                                                    |
|  SELECT u.*, uc.target AS chat_id                                  |
|  FROM users u                                                      |
|  JOIN user_channels uc ON u.id = uc.user_id                        |
|  JOIN notification_settings ns ON u.id = ns.user_id                |
|  WHERE uc.channel = 'telegram'                                     |
|    AND uc.is_active = TRUE                                         |
|    AND ns.tg_digest_enabled = TRUE;                                |
|                                                                    |
|  Результат: список [{userId, chatId, settings}]                    |
+==============================+=======================================+
                               │
                               ▼
+====================================================================+
|  STEP 2: Итерация по пользователям (for...of)                      |
|                                                                    |
|  for (const user of users) {                                       |
|    await processUser(user);        // последовательно              |
|    await sleep(300);               // rate limit                   |
|  }                                                                 |
+==============================+=======================================+
                               │
                               ▼
+====================================================================+
|  STEP 3: Проверка тихих часов (per user)                           |
|                                                                    |
|  if (isQuietHours(user.settings)) {                                |
|    log('Skipping user: quiet hours');                              |
|    continue;                                                       |
|  }                                                                 |
+==============================+=======================================+
                               │
                               ▼
+====================================================================+
|  STEP 4: Получение тегов пользователя                              |
|                                                                    |
|  const maxTags = user.isPremium ? 10 : 1;                          |
|  const tags = await getUserTags(user.id, maxTags);                 |
|                                                                    |
|  SELECT tag_name FROM portfolios                                   |
|  WHERE user_id = $1                                                |
|  LIMIT $2;                                                         |
+==============================+=======================================+
                               │
                               ▼
+====================================================================+
|  STEP 5: Сбор непрочитанных новостей                               |
|                                                                    |
|  -- RSS window: from last_digest_sent (or 3h fallback)            |
|  -- API window: last 24h from fetched_at                           |
|  SELECT n.* FROM news n                                            |
|  WHERE (n.fetched_at > NOW() - INTERVAL '24 hours'                 |
|         OR n.published_at > COALESCE($last_digest_sent, NOW() - INTERVAL '3 hours')) |
|    AND n.published_at > NOW() - INTERVAL '7 days'                  |
|    AND n.matched_tags && $1::text[]    -- user tags                |
|    AND NOT EXISTS (                                                |
|      SELECT 1 FROM user_news_reads unr                             |
|      WHERE unr.news_id = n.id AND unr.user_id = $2                 |
|    )                                                               |
|  ORDER BY GREATEST(n.fetched_at, n.published_at) DESC              |
|  LIMIT 20;                                                         |
+==============================+=======================================+
                               │
                               ▼
+====================================================================+
|  STEP 6: Проверка результата                                       |
|                                                                    |
|  if (news.length === 0) {                                          |
|    log('No news for user');                                        |
|    continue;         // ничего не отправляем                       |
|  }                                                                 |
+==============================+=======================================+
                               │
                               ▼
+====================================================================+
|  STEP 7: Форматирование сообщения (HTML)                           |
|                                                                    |
|  const messages = formatDigestMessages(news, user.settings);       |
|                                                                    |
|  Пример вывода:                                                    |
|  [                                                                  |
|  |  "🔔 <b>PULSE — непрочитанные новости</b>\\n<i>12 новых</i>...", |
|  |  "...и ещё 8 статей — <a href=...>на сайте</a>..."              |
|  ]                                                                  |
|  Бюджет: 3900 символов на сообщение, максимум 3 сообщения.        |
+==============================+=======================================+
                               │
                               ▼
+====================================================================+
|  STEP 8: Отправка через Telegram API                               |
|                                                                    |
|  for (const msg of messages) {                                      |
|    await bot.sendMessage(user.chatId, msg, {                       |
|      parse_mode: 'HTML',                                           |
|      disable_web_page_preview: false                                 |
|    });                                                             |
|    await sleep(200); // pause between parts                        |
|  }                                                                  |
|                                                                    |
|  Обновить last_digest_sent в notification_settings                 |
|  ТОЛЬКО если все части отправлены успешно.                         |
+====================================================================+
```

---

## Приложение B: Словарь emoji

| Символ | Код | Назначение |
|--------|-----|------------|
| 🔔 | `U+1F514` | Заголовок Digest |
| 📊 | `U+1F4CA` | Заголовок Weekly Report |
| ⚡ | `U+26A1` | Заголовок Sentiment Alert |
| 🟢 | `U+1F7E2` | Positive sentiment |
| 🔴 | `U+1F534` | Negative sentiment |
| ⚪ | `U+26AA` | Neutral sentiment |
| 📎 | `U+1F4CE` | Ссылка "Читать" |
| 🏷 | `U+1F3F7` | Тег |
| 📅 | `U+1F4C5` | Дата/период |
| 📈 | `U+1F4C8` | Статистика |
| ━━━ | `U+2501` | Разделитель |
| ⏰ | `U+23F0` | Время следующего дайджеста |
| 👋 | `U+1F44B` | Приветствие |
| 🚫 | `U+1F6AB` | Отключение |
| ⚙️ | `U+2699` | Настройки |
| 🌙 | `U+1F319` | Тихие часы |
| 💎 | `U+1F48E` | Premium |
| 📭 | `U+1F4ED` | Нет новых новостей |

---

*Документ обновлен на основе фактического состояния системы.*
*Бот: @Insidepulse_bot | Версия документа: 2.0 | Все системы активны.*
