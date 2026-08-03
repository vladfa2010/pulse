# PULSE — Аутентификация и авторизация

> Дата актуализации: 2026-08-03  
> Файлы: `pulse-backend/src/routes/auth.ts`, `pulse-backend/src/services/tagManager.ts`, `pulse-backend/src/index.ts`, `pulse-frontend/src/hooks/useAuth.tsx`  
> Зависимости: `bcrypt`, `jsonwebtoken`, `pg`

---

## 1. Обзор

Аутентификация в PULSE построена на **JWT** и **bcrypt**:

- Пароли хранятся как bcrypt-хэши (`$2b$10$...`, 10 раундов).
- Хэширование и сравнение выполняются **нативным модулем `bcrypt`** — операции уходят в thread pool libuv и не блокируют event loop Node.js.
- После успешного login/register/reset выдаётся JWT-токен, действительный **7 дней**.
- Токен передаётся в заголовке `Authorization: Bearer <token>`.
- Email нечувствителен к регистру (`LOWER(email)` в SQL).

> **Примечание:** ранее использовался `bcryptjs` (чистый JS). Он был заменён на `bcrypt` в коммите `5fe0b70`. Хэши в БД остались совместимы — формат `$2b$10$...` одинаков.

---

## 2. Пароли и `bcrypt`

### 2.1 Почему `bcrypt`

| `bcryptjs` | `bcrypt` |
|------------|----------|
| Чистый JavaScript | C++-биндинги к алгоритму bcrypt |
| `await bcrypt.hash()` всё равно выполняется в главном потоке | Работа уходит в thread pool libuv |
| Блокирует event loop на 50–100 мс при логине | Event loop остаётся свободным |

При одновременных логинах это существенно снижает задержки очереди запросов.

### 2.4 Неблокирующий UI логина

Фронтенд (`pulse-frontend/src/hooks/useAuth.tsx`) после получения ответа `/auth/login` сразу обновляет состояние и закрывает модалку. Фоновые операции (push-уведомления, нативное хранилище токена) выполняются без блокировки интерфейса.

Backend, в свою очередь, не выполняет тяжёлых запросов после `bcrypt.compare` до момента `res.json`: JWT генерируется мгновенно, теги возвращаются через оптимизированный запрос (см. §3), а статистика логина (`UPDATE users`, `INSERT INTO user_logins`) пишется **после** ответа (TZ-03).

### 2.2 Где используется

| Endpoint / место | Операция |
|------------------|----------|
| `POST /api/auth/register` | `bcrypt.hash(password, 10)` — хэширование нового пароля |
| `POST /api/auth/login` | `bcrypt.compare(password, user.password_hash)` — проверка |
| `POST /api/auth/reset-password` | `bcrypt.hash(password, 10)` — хэширование нового пароля |
| `POST /admin/users/:id/reset-password` | `bcrypt.hash(password, 10)` — сброс пароля админом |

### 2.3 Совместимость хэшей

bcrypt и bcryptjs генерируют хэши в одном формате. Все существующие пароли в БД продолжают работать без миграции.

---

## 3. Оптимизация логина

За последние итерации обработчик логина прошёл несколько доработок, направленных на скорость отклика и снижение числа roundtrip'ов:

| TZ | Что изменилось | Где |
|---|---|---|
| TZ-02 | Frontend не блокирует UI при логине: `setUser`, `setIsLoggedIn` и закрытие модалки происходят до фоновых задач. | `pulse-frontend/src/hooks/useAuth.tsx` |
| TZ-03 | Статистика логина (`UPDATE users`, `INSERT INTO user_logins`) вынесена за пределы `res.json` — после отправки ответа. | `pulse-backend/src/routes/auth.ts` |
| TZ-04 | Добавлен функциональный индекс `idx_users_lower_email ON users (LOWER(email))` для case-insensitive поиска. | `pulse-backend/src/index.ts`, `schema.sql` |
| TZ-05 | Теги пользователя (`tags`) возвращаются прямо в ответе логина; frontend сразу делает `setPortfolio(data.tags)`. | `pulse-backend/src/services/tagManager.ts`, `auth.ts`; `pulse-frontend/src/hooks/useAuth.tsx` |
| TZ-07 | Запрос `getUserTagsFull` переписан на подзапрос-агрегат, ограниченный тегами пользователя; добавлен индекс `idx_news_tag_links_tag_news ON news_tag_links(tag_id, news_id)`. | `pulse-backend/src/services/tagManager.ts`, `index.ts`, `schema.sql` |

Результат: логин — один roundtrip клиент ↔ backend, после которого интерфейс сразу показывает пользователя и его портфель. Тяжёлый запрос тегов не размножается по всей истории новостей, а работает только с новостями за последний месяц по тегам конкретного пользователя.

## 4. Endpoints

### 4.1 `POST /api/auth/register`

**Назначение:** регистрация нового пользователя.

**Body:**

```json
{
  "username": "ivan",
  "email": "ivan@example.com",
  "password": "MyStrongPass123",
  "source": "web",
  "timezone": "Europe/Moscow",
  "locale": "ru"
}
```

**Валидация:**

- `email`, `username`, `password` обязательны.
- Пароль минимум 8 символов.
- Email проверяется на уникальность case-insensitive (`LOWER(email)`).

**Ответ (201):**

```json
{
  "token": "eyJhbG...",
  "user": {
    "id": "...",
    "email": "ivan@example.com",
    "username": "ivan",
    "is_admin": false
  }
}
```

**Side effects:**

- Создаётся запись в `users`.
- Создаются настройки уведомлений (`notification_settings`).
- Отправляется welcome-письмо (не блокирует ответ).
- Логируются события `register` и `email_connected`.

---

### 4.2 `POST /api/auth/login`

**Назначение:** вход по email и паролю.

**Body:**

```json
{
  "email": "ivan@example.com",
  "password": "MyStrongPass123",
  "source": "web"
}
```

**Поведение:**

1. Поиск пользователя по `LOWER(email)`.
2. Проверка флага `is_blocked` — заблокированным вход запрещён (`403`).
3. `bcrypt.compare(password, password_hash)`.
4. При успехе обновляется `last_login_at`, `login_count`, пишется запись в `user_logins`.
5. Логируется событие `login`.
6. Генерируется JWT и возвращается пользователь с `subscription`.

**Ответ (200):**

```json
{
  "token": "eyJhbG...",
  "user": {
    "id": "...",
    "email": "ivan@example.com",
    "username": "ivan",
    "is_admin": false,
    "subscription": {
      "plan": "free",
      "active": false,
      "expiresAt": null,
      "autoRenew": true,
      "scheduledDowngrade": null,
      "daysRemaining": null,
      "isExpired": false
    }
  },
  "tags": [
    {
      "id": "...",
      "tag_id": "sber",
      "tag_name": "Сбербанк",
      "tag_type": "company",
      "is_frozen": false,
      "enriched": true,
      "news_per_month": 12
    }
  ]
}
```

> Поле `tags` добавлено в рамках оптимизации логина (TZ-05). Фронтенд сразу отрисовывает портфель, не делая второй запрос `GET /api/user/tags`. Ошибка запроса тегов не ломает вход — возвращается `tags: []`.

**Ошибки:**

- `400` — нет email/пароля.
- `404` — пользователь не найден (маскировка под «Неправильный логин или пароль»).
- `401` — неверный пароль.
- `403` — аккаунт заблокирован.

---

### 4.3 `GET /api/auth/me`

**Назначение:** проверка токена и получение текущего пользователя.

**Headers:** `Authorization: Bearer <token>`

**Ответ (200):**

```json
{
  "user": {
    "id": "...",
    "email": "ivan@example.com",
    "username": "ivan",
    "is_admin": false,
    "subscription": { ... }
  }
}
```

**Ошибки:**

- `401` — нет токена или токен невалиден/просрочен.
- `404` — пользователь удалён.

---

### 4.4 `POST /api/auth/forgot-password`

**Назначение:** запрос кода восстановления пароля.

**Body:** `{ "email": "ivan@example.com" }`

**Поведение:**

- Не раскрывает, существует ли email. Всегда возвращает `{ success: true }`.
- Генерирует 6-значный код, действительный 15 минут.
- Сохраняет код в `password_reset_codes`.
- Отправляет код на email. Если email не удался — fallback в Telegram, если у пользователя подключён канал.
- Логирует событие `forgot_password`.

**Ответ:** `{ "success": true }`

---

### 4.5 `POST /api/auth/verify-code`

**Назначение:** проверка кода и выдача reset-токена.

**Body:** `{ "email": "ivan@example.com", "code": "123456" }`

**Поведение:**

- Проверяет последний неиспользованный код пользователя.
- Помечает код использованным.
- Выдаёт JWT reset-токен с `purpose: 'password_reset'` и TTL 15 минут.

**Ответ:** `{ "resetToken": "eyJhbG..." }`

**Ошибки:** `400` — неверный или просроченный код.

---

### 4.6 `POST /api/auth/reset-password`

**Назначение:** установка нового пароля по reset-токену.

**Body:** `{ "resetToken": "eyJhbG...", "password": "NewPass123" }`

**Поведение:**

- Верифицирует reset-токен и `purpose`.
- Проверяет длину пароля (минимум 8 символов).
- Хэширует новый пароль через `bcrypt.hash(password, 10)`.
- Обновляет `password_hash`.
- Логирует событие `password_reset`.
- Выдаёт новый JWT-токен на 7 дней и возвращает пользователя.

**Ответ:** аналогичен `POST /api/auth/login`.

---

### 4.7 `POST /api/auth/telegram`

**Назначение:** подключение Telegram-аккаунта через Login Widget (OAuth popup).

**Headers:** `Authorization: Bearer <token>` (пользователь должен быть залогинен).

**Body:** данные от Telegram Login Widget:

```json
{
  "id": 123456789,
  "first_name": "Ivan",
  "username": "ivan",
  "photo_url": "https://...",
  "auth_date": 1751300000,
  "hash": "..."
}
```

**Поведение:**

- Проверяет подпись Telegram по `TELEGRAM_BOT_TOKEN`.
- Проверяет свежесть `auth_date` (не старше 24 часов).
- Сохраняет/обновляет запись в `user_channels` для уведомлений.
- Логирует событие `telegram_connected`.

**Ошибки:**

- `400` — отсутствуют данные.
- `403` — неверная подпись Telegram.
- `401` — нет JWT-токена.

> **Примечание:** Telegram-авторизация — это **подключение канала уведомлений**, а не способ входа вместо пароля.

---

### 4.8 `POST /admin/users/:id/reset-password` (admin)

**Назначение:** админский сброс пароля пользователя.

**Headers:** `Authorization: Bearer <admin-token>`

**Body:** `{ "password": "newpass" }` (минимум 6 символов)

**Ответ:** `{ "success": true }`

---

## 5. JWT

- **Секрет:** `process.env.JWT_SECRET` (fallback `'dev-secret'` только для локальной разработки).
- **Алгоритм:** HS256 (по умолчанию `jsonwebtoken`).
- **TTL:** 7 дней.
- **Payload:** `{ userId, email, is_admin }` (для reset-токена добавляется `purpose: 'password_reset'` и TTL 15 минут).

---

## 6. Case-insensitive email

PostgreSQL сравнивает `VARCHAR` с учётом регистра. Чтобы избежать дублей (`Vladfa@ya.ru` и `vladfa@ya.ru` — разные аккаунты), все auth-запросы используют `LOWER(email)`:

```sql
SELECT id FROM users WHERE LOWER(email) = LOWER($1);
```

Это касается регистрации, логина, forgot-password и verify-code.

Существующий UNIQUE-индекс по колонке `email` case-sensitive и не подходит для `LOWER(email)`. Поэтому добавлен функциональный индекс:

```sql
CREATE INDEX IF NOT EXISTS idx_users_lower_email ON users (LOWER(email));
```

Индекс добавлен в boot-миграции (`src/index.ts`) и в `schema.sql` (TZ-04).

---

## 7. Логирование активностей

Пользовательские события пишутся в `user_events` через `services/activityLog.ts`. Все вызовы обёрнуты в `try/catch` — логирование не ломает основной flow.

| Событие | Место | Описание |
|---------|-------|----------|
| `register` | `POST /api/auth/register` | Новый пользователь |
| `login` | `POST /api/auth/login` | Успешный вход |
| `forgot_password` | `POST /api/auth/forgot-password` | Запрос кода восстановления |
| `password_reset` | `POST /api/auth/reset-password` | Установлен новый пароль |
| `tag_added` | `POST /api/user/tags` | Добавлен тег |
| `tag_removed` | `DELETE /api/user/tags/:id` | Удалён тег |
| `payment_completed` | `POST /api/payments/...` | Успешная оплата |
| `subscription_activated` | — | Подписка активирована |
| `subscription_cancelled` | — | Подписка отменена |
| `telegram_connected` | `POST /api/auth/telegram` | Подключён Telegram |
| `telegram_disconnected` | — | Telegram отключён |
| `email_connected` | `register` | Email подключён |
| `email_disconnected` | — | Email отключён |
| `sentiment_vote` | `POST /api/sentiment/vote` | Голос в Sentiment Index |
| `factcheck_ordered` | — | Заказан фактчек |
| `page_view_plans` | `POST /api/events/page-view` | Просмотр страницы тарифов |
| `page_view_portfolio` | `POST /api/events/page-view` | Просмотр страницы /portfolio |
| `portfolio_add_clicked` | `POST /api/events/click` | Нажатие «+ Портфель» |
| `portfolio_created` | `POST /api/portfolio` | Портфель создан |
| `admin_changed_plan` | admin | Ручная смена тарифа |
| `admin_extended_subscription` | admin | Ручное продление подписки |

События просмотра страниц (`page_view_*`) и кликов (`portfolio_add_clicked`) логируются с фронтенда через dedicated endpoints. Ошибки запросов игнорируются — не влияют на UX.

---

## 8. Безопасность и замечания

- `is_admin` в payload JWT — convenience claim. Критичные admin-операции всё равно проверяют `is_admin` в БД (`requireAdmin`).
- `is_blocked` проверяется при логине, но **не при каждом запросе** через `authMiddleware`. Для полного блокирования нужен дополнительный middleware или проверка в БД.
- Пароли никогда не передаются в открытом виде в ответах.
- Welcome-письма и email с кодом отправляются fire-and-forget — не влияют на HTTP-ответ.

---

## 9. Тестовые запросы

```bash
# Регистрация
curl -X POST https://pulse-api-bsov.onrender.com/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"test","email":"test@example.com","password":"TestPass123!"}'

# Логин
curl -X POST https://pulse-api-bsov.onrender.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"TestPass123!"}'

# Me
curl -X GET https://pulse-api-bsov.onrender.com/api/auth/me \
  -H "Authorization: Bearer <token>"
```

---

## 10. Связанные документы

- `ARCHITECTURE.md` — высокоуровневая архитектура, раздел Auth Endpoints.
- `AUTH_MODAL_SPEC.md` (frontend) — спецификация модалки авторизации на фронтенде.
- `DESIGN_SPEC.md` — ранний product overview, список auth endpoints.
- `TELEGRAM_NOTIFICATIONS.md` — подключение Telegram и доставка уведомлений.
