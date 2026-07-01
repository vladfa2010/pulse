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

## Локальная разработка

Без `FIREBASE_SERVICE_ACCOUNT_BASE64` push-функционал отключён, но сервер продолжает работать.
