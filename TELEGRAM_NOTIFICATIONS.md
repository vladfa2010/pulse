# Telegram Notifications — PULSE Bot (@Insidepulse_bot)

> Полная техническая документация логики уведомлений Telegram-бота проекта PULSE.
> Версия документа: 1.0 | Бот: `@Insidepulse_bot`

---

## Содержание

1. [Общая архитектура](#1-общая-архитектура)
2. [Flow подключения пользователя](#2-flow-подключения-пользователя)
3. [Digest — детальная логика](#3-digest--детальная-логика)
4. [Weekly Report — детальная логика](#4-weekly-report--детальная-логика)
5. [Sentiment Alerts](#5-sentiment-alerts)
6. [Bot Commands](#6-bot-commands)
7. [Таблицы БД](#7-таблицы-бд)
8. [Настройки](#8-настройки)
9. [Rate limiting и защита](#9-rate-limiting-и-защита)
10. [Webhook endpoint](#10-webhook-endpoint)
11. [Env vars](#11-env-vars)
12. [Troubleshooting](#12-troubleshooting)

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

| Компонент | Файл | Назначение |
|-----------|------|------------|
| **Digest Service** | `services/digest.ts` | Периодическая рассылка непрочитанных новостей |
| **Reports Service** | `services/reports.ts` | Еженедельные аналитические отчёты |
| **Telegram Service** | `services/telegram.ts` | Низкоуровневое взаимодействие с Telegram API |
| **Bot Commands** | `index.ts` (webhook) | Обработка команд пользователя |
| **Cron Scheduler** | node-cron | Триггеры по расписанию (digest, weekly) |

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
    │  (3h)      │   │  (вс 13:00)│   │  (async)   │
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

---

## 2. Flow подключения пользователя

### Последовательность шагов

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  Пользователь │     │   PULSE      │     │   Telegram   │
│              │     │  Frontend    │     │    Bot       │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │ (1) Заходит        │                    │
       │ в Профиль →        │                    │
       │ Telegram           │                    │
       │───────────────────>│                    │
       │                    │ (2) Генерирует     │
       │ (2) Показывает     │ ссылку с deep-     │
       │    ссылку /start   │ link               │
       │<───────────────────│                    │
       │                    │                    │
       │ (3) Нажимает       │                    │
       │ ссылку, открывает  │                    │
       │ @Insidepulse_bot   │                    │
       │─────────────────────────────────────────>│
       │                    │                    │
       │                    │                    │ (4) /start
       │                    │                    │ вызывает webhook
       │                    │<───────────────────│
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

### Шаги подключения (подробно)

| Шаг | Действие | Результат в БД |
|-----|----------|----------------|
| **1** | Пользователь заходит в раздел Профиль → Telegram на сайте PULSE | — |
| **2** | Frontend генерирует ссылку `https://t.me/Insidepulse_bot?start=<user_id>` | — |
| **3** | Пользователь открывает бота и нажимает `/start` | — |
| **4** | Бот отправляет webhook на `/webhook/telegram` с `message.chat.id` | — |
| **5** | Backend создаёт запись в `user_channels` | `channel='telegram', target=chat_id, is_active=true` |
| **5b** | Backend обновляет `notification_settings` | `tg_digest_enabled = TRUE` |
| **6** | Бот отправляет приветственное сообщение | — |

### Пример данных после подключения

```sql
-- user_channels
INSERT INTO user_channels (user_id, channel, target, is_active)
VALUES ('uuid-user-123', 'telegram', '123456789', true);

-- notification_settings (обновлено)
UPDATE notification_settings
SET tg_digest_enabled = TRUE,
    tg_enabled = TRUE
WHERE user_id = 'uuid-user-123';
```

---

## 3. Digest — детальная логика

### Обзор

Digest — периодическая рассылка непрочитанных новостей по тегам пользователя. Основной и наиболее частый тип уведомления.

```
+----------------------------------------------------------+
|  CRON: 0 */3 * * *   (Europe/Moscow)                     |
|  Запуск: каждые 3 часа в :00 минут                       |
|  Пример: 00:00, 03:00, 06:00, 09:00, 12:00, 15:00...    |
+----------------------------------------------------------+
                    │
                    ▼
+----------------------------------------------------------+
|  1. Загрузить всех пользователей с tg_digest_enabled=TRUE|
|  2. Фильтр: только пользователи с активным каналом      |
|  3. Для каждого пользователя:                           |
|     a. Получить теги из portfolios                      |
|     b. Проверить тихие часы                             |
|     c. Найти непрочитанные новости за последние 3ч      |
|     d. Отфильтровать по тегам пользователя              |
|     e. Отправить дайджест                               |
+----------------------------------------------------------+
```

### Алгоритм сбора новостей

```
┌────────────────────┐
│  Запуск по cron    │
│  (каждые 3ч в :00) │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Получить window   │
│  [now - 3h, now]   │
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
│  - published_at    │
│    внутри window   │
│  - matched_tags    │
│    ∩ user_tags     │
│  - sentiment != NULL
│  ORDER BY published│
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

| Тариф | Тегов | Описание |
|-------|-------|----------|
| **Free** | 1 тег | Только первый тег из portfolios |
| **Premium** | 10 тегов | До 10 тегов |

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
| 03:00 | Пропуск — тихие часы |
| 06:00 | Пропуск — тихие часы |
| 09:00 | Отправка дайджеста |
| 12:00 | Отправка дайджеста |
| 15:00 | Отправка дайджеста |
| 18:00 | Отправка дайджеста |
| 21:00 | Отправка дайджеста |

### SQL-запрос для сбора новостей

```sql
-- Получить непрочитанные новости за window по тегам пользователя
SELECT n.*
FROM news n
WHERE n.published_at >= NOW() - INTERVAL '3 hours'
  AND n.published_at <= NOW()
  AND n.sentiment IS NOT NULL
  AND n.matched_tags && ARRAY['tag1', 'tag2']::text[]  -- overlap с тегами пользователя
  AND NOT EXISTS (
    SELECT 1 FROM user_news_reads unr
    WHERE unr.news_id = n.id
      AND unr.user_id = 'uuid-user-123'
  )
ORDER BY n.published_at DESC
LIMIT 20;
```

### Формат сообщения Digest

```
🔔 <b>PULSE — непрочитанные новости</b>
<i>5 новых</i>

1. 🟢 <b>Компания X запустила новый продукт</b>
   📎 <a href="https://example.com/news/1">Читать на сайте</a> · <i>TechCrunch</i>
   🏷 #startup

2. 🔴 <b>Рынок акций упал на 10%</b>
   📎 <a href="https://example.com/news/2">Читать на сайте</a> · <i>Bloomberg</i>
   🏷 #finance

3. ⚪ <b>Новый закон о цифровых активах</b>
   📎 <a href="https://example.com/news/3">Читать на сайте</a> · <i>РБК</i>
   🏷 #crypto

━━━
<a href="https://pulse-frontend-jt53.onrender.com">Открыть PULSE →</a>
<i>⏰ Следующая подборка через 3 часа</i>
```

### Emoji для sentiment

| Sentiment | Emoji | HTML |
|-----------|-------|------|
| **positive** | 🟢 | `&#128308;` (green circle) |
| **negative** | 🔴 | `&#128315;` (red circle) |
| **neutral** | ⚪ | `&#9898;` (white circle) |

### Ручной запуск дайджеста

Пользователь может запросить дайджест в любой момент через команду `/now` (см. раздел 6).

---

## 4. Weekly Report — детальная логика

### Обзор

Weekly Report — еженедельный аналитический отчёт, отправляемый только Premium-пользователям.

```
+----------------------------------------------------------+
|  CRON: 0 13 * * 0   (Europe/Moscow)                      |
|  Запуск: каждое воскресенье в 13:00 MSK                  |
+----------------------------------------------------------+
                    │
                    ▼
+----------------------------------------------------------+
|  1. Загрузить Premium-пользователей                       |
|     (subscription_active = TRUE)                          |
|  2. Для каждого:                                          |
|     a. Получить новости за последние 7 дней               |
|     b. Посчитать статистику по sentiment                  |
|     c. Сгруппировать по тегам (max 5 новостей/тег)      |
|     d. Отправить в Telegram + Email                       |
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
<a href="https://pulse-frontend-jt53.onrender.com">Открыть PULSE →</a>
```

### Период отчёта

| День | Время | Действие |
|------|-------|----------|
| Понедельник 00:00 MSK | — | Начало периода отчёта |
| Воскресенье 13:00 MSK | Cron trigger | Сбор данных и отправка |

---

## 5. Sentiment Alerts

### Обзор

Sentiment Alerts — мгновенные уведомления при резком изменении sentiment по тегу пользователя. Отправляются асинхронно, не по расписанию.

```
┌────────────────────┐
│  Анализ новости    │
│  NLP pipeline      │
│  sentiment scored  │
└────────┬───────────┘
         │
         ▼
┌────────────────────┐
│  Существенное      │     NO      ┌────────────────────┐
│  изменение         │────────────▶│  Нет алерта        │
│  sentiment?        │             └────────────────────┘
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

## 6. Bot Commands

### Обработчик команд

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

#### `/start` — Приветствие и подключение

```
Вход: /start или /start <user_id>

Действия:
1. Если передан user_id — связать chat_id с пользователем
2. Создать/обновить запись в user_channels
3. Установить tg_digest_enabled = TRUE
4. Отправить приветственное сообщение

Ответ:
┌──────────────────────────────────────────┐
│ 👋 Добро пожаловать в PULSE!             │
│                                          │
│ Вы подключены к уведомлениям.            │
│ Бот будет присылать дайджест новостей    │
│ по вашим тегам каждые 3 часа.            │
│                                          │
│ Команды:                                 │
│ /now — получить дайджест сейчас          │
│ /settings — настройки                    │
│ /stop — отключить уведомления            │
└──────────────────────────────────────────┘
```

#### `/now` — Мгновенный дайджест

```
Вход: /now

Действия:
1. Получить chat_id пользователя
2. Найти user_id по chat_id в user_channels
3. Вызвать sendDigestToUser(userId, chatId)
4. Игнорировать тихие часы
5. Отправить дайджест

Ответ:
🔔 <b>PULSE — непрочитанные новости</b>
<i>N новых</i>
...
или
📭 <i>Нет новых непрочитанных новостей</i>
```

#### `/stop` — Отключение уведомлений

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
└──────────────────────────────────────────┘
```

#### `/settings` — Настройки

```
Вход: /settings

Действия:
1. Найти пользователя по chat_id
2. Получить текущие настройки
3. Отправить сводку настроек

Ответ:
┌──────────────────────────────────────────┐
│ ⚙️ <b>Настройки уведомлений</b>          │
│                                          │
│ 📊 Дайджест: вкл/выкл                    │
│ ⏰ Частота: 3 часа                       │
│ 🌙 Тихие часы: вкл (23:00 — 07:00)       │
│ 💎 Тариф: Free / Premium                 │
│                                          │
│ Теги: #startup, #finance, #crypto        │
└──────────────────────────────────────────┘
```

### Команды-шпаргалка

| Команда | Доступ | Описание |
|---------|--------|----------|
| `/start` | Все | Подключение, приветствие |
| `/now` | Только подключённые | Мгновенный дайджест |
| `/stop` | Только подключённые | Отключение дайджестов |
| `/settings` | Только подключённые | Просмотр настроек |

---

## 7. Таблицы БД

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
| `subscription_active` | `boolean` | Активна ли Premium-подписка |
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
| `tg_enabled` | `boolean` | Telegram канал активен |
| `email_enabled` | `boolean` | Email канал активен |
| `report_format` | `text` | Формат отчёта |

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

## 8. Настройки

### Частота дайджеста (`digest_frequency`)

| Значение | Cron-выражение | Описание |
|----------|----------------|----------|
| `1h` | `0 * * * *` | Каждый час в :00 |
| `3h` | `0 */3 * * *` | Каждые 3 часа в :00 (по умолчанию) |
| `6h` | `0 */6 * * *` | Каждые 6 часа в :00 |
| `12h` | `0 */12 * * *` | Каждые 12 часов в :00 |
| `24h` | `0 9 * * *` | Раз в день в 09:00 MSK |

```
Частота 3h (default):
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

### Тарифы

| Параметр | Free | Premium |
|----------|------|---------|
| **Тегов** | 1 | 10 |
| **Digest** | Да | Да |
| **Weekly Report** | Нет | Да |
| **Sentiment Alerts** | Да | Да |
| **Тихие часы** | Да | Да |
| **Частота** | 1h-24h | 1h-24h |

### Проверка тарифа

```typescript
function getMaxTags(isPremium: boolean): number {
  return isPremium ? 10 : 1;
}

function canSendWeeklyReport(user: User): boolean {
  return user.subscription_active === true;
}
```

---

## 9. Rate Limiting и защита

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
    await sendDigestToUser(user.id, user.chatId);
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

## 10. Webhook Endpoint

### Конфигурация

```typescript
// index.ts
import express from 'express';

const app = express();
app.use(express.json());

// Telegram Bot Webhook
app.post('/webhook/telegram', async (req, res) => {
  try {
    const update = req.body;

    // Обработка сообщений
    if (update.message) {
      await handleMessage(update.message);
    }

    // Обработка callback queries
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(500);
  }
});
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
    "text": "/start"
  }
}
```

### Поля для идентификации

| Поле | Описание | Использование |
|------|----------|---------------|
| `message.chat.id` | Chat ID пользователя | Сохраняется в `user_channels.target` |
| `message.from.id` | User ID Telegram | Логирование |
| `message.text` | Текст команды | Маршрутизация команд |

### Настройка webhook в Telegram

```bash
# Установка webhook URL
curl -X POST \
  "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.pulse.com/webhook/telegram"
  }'
```

---

## 11. Env Vars

### Переменные окружения

| Переменная | Значение | Описание |
|------------|----------|----------|
| `TELEGRAM_BOT_TOKEN` | `8226463754:AAHmgNwdTsiMZkbSNwlJjmSRlVZifZ6HeZo` | Токен бота @Insidepulse_bot |
| `TELEGRAM_WEBHOOK_URL` | `https://api.pulse.com/webhook/telegram` | URL для webhook |
| `DATABASE_URL` | `postgresql://...` | Строка подключения к Supabase |
| `TZ` | `Europe/Moscow` | Часовой пояс для cron (обязательно!) |

### Пример .env

```env
# Telegram
TELEGRAM_BOT_TOKEN=8226463754:AAHmgNwdTsiMZkbSNwlJjmSRlVZifZ6HeZo
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

## 12. Troubleshooting

### Частые проблемы

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
|  CRON TRIGGER: 0 */3 * * * (Europe/Moscow)                        |
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
|  SELECT n.* FROM news n                                            |
|  WHERE n.published_at >= NOW() - INTERVAL '3 hours'                |
|    AND n.published_at <= NOW()                                     |
|    AND n.sentiment IS NOT NULL                                     |
|    AND n.matched_tags && $1::text[]    -- user tags                |
|    AND NOT EXISTS (                                                |
|      SELECT 1 FROM user_news_reads unr                             |
|      WHERE unr.news_id = n.id AND unr.user_id = $2                 |
|    )                                                               |
|  ORDER BY n.published_at DESC                                      |
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
|  const message = formatDigest(news, user.settings);                |
|                                                                    |
|  Пример вывода:                                                    |
|  "🔔 <b>PULSE — непрочитанные новости</b>\n<i>5 новых</i>\n\n    |
|  1. 🟢 <b>Заголовок</b>..."                                       |
+==============================+=======================================+
                               │
                               ▼
+====================================================================+
|  STEP 8: Отправка через Telegram API                               |
|                                                                    |
|  await bot.sendMessage(user.chatId, message, {                     |
|    parse_mode: 'HTML',                                             |
|    disable_web_page_preview: false                                 |
|  });                                                               |
|                                                                    |
|  Обновить last_digest_sent в notification_settings                 |
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

*Документ создан автоматически на основе исходного кода проекта PULSE.*
*Бот: @Insidepulse_bot | Версия: 1.0*
