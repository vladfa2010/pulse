# Push-уведомления в PULSE (backend)

Backend отправляет push-уведомления через **Firebase Cloud Messaging (FCM)** с помощью `firebase-admin`.

---

## Конфигурация

Переменная окружения:

```bash
FIREBASE_SERVICE_ACCOUNT_BASE64=<base64-json-сервисного-аккаунта>
```

Как получить:

1. Firebase Console → Project settings → Service accounts.
2. Generate new private key.
3. Закодируйте JSON в base64:
   ```bash
   base64 -i service-account.json | pbcopy
   ```

При старте сервера `services/push.ts` инициализирует Firebase Admin из этой переменной.

---

## Архитектура

### `services/push.ts`

- `isPushConfigured()` — проверяет, инициализирован ли Firebase Admin.
- `sendPushNotification(userId, title, body, data)` — отправляет push одному пользователю:
  - проверяет `push_enabled` в `notification_settings`,
  - проверяет тихий режим (`isQuietHours`),
  - берёт активный FCM-токен из `user_channels` (`channel = 'push'`),
  - деактивирует токен, если FCM вернул ошибку протухшего/невалидного токена.
- `sendNewArticlePush(newsId, title, source, matchedTags)` — находит всех пользователей, подписанных на теги статьи, и отправляет им push.
- `sendSentimentVotePush(userId)` — отправляет **data-only** push с тремя кнопками голосования в Sentiment Index. Не содержит `notification`-блока: уведомление рисуется нативным Android-сервисом (`PulseMessagingService`).

### Таблица `push_notifications_sent`

Предотвращает повторную отправку push одному пользователю по одной и той же новости:

```sql
CREATE TABLE push_notifications_sent (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  news_id    UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE,
  sent_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, news_id)
);
```

Создаётся автоматически при старте сервера (см. `src/index.ts` → миграции и `src/models/schema.sql`).

---

## Триггеры отправки

| Событие | Файл | Заголовок push | Данные (`data`) |
|---------|------|----------------|-----------------|
| Новая статья в непрочитанном фиде | `services/newsProcessor.ts` | Название статьи | `{ type: 'new_article', news_id, tag }` |
| Дайджест непрочитанных новостей | `services/digest.ts` | `PULSE — непрочитанные новости` | `{ type: 'digest', count }` |
| Еженедельный отчёт | `services/reports.ts` | `PULSE — Еженедельный отчёт` | `{ type: 'report' }` |
| Напоминание голосовать за Sentiment Index | `src/index.ts` (cron) | `Оцените рынок` | `{ type: 'sentiment_vote', title, body }` (data-only) |

### Новая статья

Когда `newsProcessor` финализирует `matched_tags` для статьи, он вызывает `sendNewArticlePush`.

Условия для отправки:

- у пользователя `push_enabled = TRUE`,
- у пользователя есть активный FCM-токен,
- пользователь подписан на хотя бы один из `matched_tags` статьи,
- новость ещё не прочитана пользователем,
- push для этой пары `(user_id, news_id)` ещё не отправлялся.

### Дайджест и отчёт

Push отправляется после успешной отправки в Telegram. Если push не настроен или отключён, backend молча пропускает этот шаг.

### Sentiment Index (push с кнопками)

Запускается по cron каждые 5 минут (`src/index.ts`).

**Расписание (по московскому времени):**

- Выходные — не шлём.
- Чётный день месяца — 10:30 МСК.
- Нечётный день месяца — 15:00 МСК.

**Условия для отправки одному пользователю:**

- `push_enabled = TRUE`,
- есть активный FCM-токен,
- сегодня ещё не голосовал (`sentiment_votes`),
- сегодня ещё не получал этот push (`sentiment_vote_push_sent`).

**Формат FCM-сообщения:**

```json
{
  "token": "<fcm-token>",
  "data": {
    "type": "sentiment_vote",
    "title": "Оцените рынок",
    "body": "Ваш голос влияет на индекс сантимента. Как вы оцените рынок?"
  },
  "android": { "priority": "high" }
}
```

Уведомление без `notification`-блока — иначе Android сам обработает сообщение и кастомные кнопки не появятся.

### Таблица `sentiment_vote_push_sent`

Предотвращает повторную отправку push-напоминания одному пользователю в один день:

```sql
CREATE TABLE sentiment_vote_push_sent (
  id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sent_date  DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, sent_date)
);
```

Создаётся автоматически при старте сервера (см. `src/index.ts` → миграции).

---

## Хранение токенов

FCM-токены хранятся в `user_channels`:

```sql
channel = 'push'
target  = '<fcm-token>'
is_active = TRUE
```

Схема `UNIQUE(user_id, channel)` означает: один пользователь — одно устройство. Если пользователь войдёт с другого устройства, токен перезапишется.

---

## Тихий режим

Если у пользователя включён тихий режим и текущее время попадает в интервал `quiet_hours_start` → `quiet_hours_end`, push не отправляется.

---

## Надёжная доставка токена с устройства (cold start)

Frontend (`pulse-frontend/src/lib/push.ts`) подписывается на событие `registration` от `@capacitor/push-notifications` и отправляет полученный токен на `POST /api/user/channels` с `channel: 'push'`.

При cold start Android FCM может сгенерировать токен до инициализации Capacitor bridge. Чтобы токен не потерялся:

1. Нативный `PulseMessagingService` сохраняет токен в `SharedPreferences("CapacitorStorage", "fcm_token")`.
2. `TokenFlushPlugin` диспатчит сохранённый токен в JS сразу после старта bridge.
3. JS-листенер получает токен (событие `registration` с `retain = true`) и вызывает `POST /api/user/channels`.
4. Backend сохраняет/обновляет токен в `user_channels` через `INSERT ... ON CONFLICT`.

Подробнее о нативной части см. [`pulse-frontend/PUSH_SETUP.md`](../pulse-frontend/PUSH_SETUP.md).

---

## Локальная разработка

Без `FIREBASE_SERVICE_ACCOUNT_BASE64` push-функционал отключён, но сервер продолжает работать.
