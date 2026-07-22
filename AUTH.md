# PULSE — Аутентификация и авторизация

> Дата актуализации: 2026-07-23  
> Файлы: `pulse-backend/src/routes/auth.ts`, `pulse-backend/src/index.ts`  
> Зависимости: `bcrypt`, `jsonwebtoken`

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

## 3. Endpoints

### 3.1 `POST /api/auth/register`

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

### 3.2 `POST /api/auth/login`

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
  }
}
```

**Ошибки:**

- `400` — нет email/пароля.
- `404` — пользователь не найден (маскировка под «Неправильный логин или пароль»).
- `401` — неверный пароль.
- `403` — аккаунт заблокирован.

---

### 3.3 `GET /api/auth/me`

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

### 3.4 `POST /api/auth/forgot-password`

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

### 3.5 `POST /api/auth/verify-code`

**Назначение:** проверка кода и выдача reset-токена.

**Body:** `{ "email": "ivan@example.com", "code": "123456" }`

**Поведение:**

- Проверяет последний неиспользованный код пользователя.
- Помечает код использованным.
- Выдаёт JWT reset-токен с `purpose: 'password_reset'` и TTL 15 минут.

**Ответ:** `{ "resetToken": "eyJhbG..." }`

**Ошибки:** `400` — неверный или просроченный код.

---

### 3.6 `POST /api/auth/reset-password`

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

### 3.7 `POST /api/auth/telegram`

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

### 3.8 `POST /admin/users/:id/reset-password` (admin)

**Назначение:** админский сброс пароля пользователя.

**Headers:** `Authorization: Bearer <admin-token>`

**Body:** `{ "password": "newpass" }` (минимум 6 символов)

**Ответ:** `{ "success": true }`

---

## 4. JWT

- **Секрет:** `process.env.JWT_SECRET` (fallback `'dev-secret'` только для локальной разработки).
- **Алгоритм:** HS256 (по умолчанию `jsonwebtoken`).
- **TTL:** 7 дней.
- **Payload:** `{ userId, email, is_admin }` (для reset-токена добавляется `purpose: 'password_reset'` и TTL 15 минут).

---

## 5. Case-insensitive email

PostgreSQL сравнивает `VARCHAR` с учётом регистра. Чтобы избежать дублей (`Vladfa@ya.ru` и `vladfa@ya.ru` — разные аккаунты), все auth-запросы используют `LOWER(email)`:

```sql
SELECT id FROM users WHERE LOWER(email) = LOWER($1);
```

Это касается регистрации, логина, forgot-password и verify-code.

---

## 6. Логирование активностей

Auth-события пишутся в `activity_log` через `services/activityLog`:

| Событие | Место | Описание |
|---------|-------|----------|
| `register` | `register` | Новый пользователь |
| `login` | `login` | Успешный вход |
| `email_connected` | `register` | Email сохранён при регистрации |
| `forgot_password` | `forgot-password` | Запрос кода восстановления |
| `password_reset` | `reset-password` | Установлен новый пароль |
| `telegram_connected` | `POST /api/auth/telegram` | Подключён Telegram |

---

## 7. Безопасность и замечания

- `is_admin` в payload JWT — convenience claim. Критичные admin-операции всё равно проверяют `is_admin` в БД (`requireAdmin`).
- `is_blocked` проверяется при логине, но **не при каждом запросе** через `authMiddleware`. Для полного блокирования нужен дополнительный middleware или проверка в БД.
- Пароли никогда не передаются в открытом виде в ответах.
- Welcome-письма и email с кодом отправляются fire-and-forget — не влияют на HTTP-ответ.

---

## 8. Тестовые запросы

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

## 9. Связанные документы

- `ARCHITECTURE.md` — высокоуровневая архитектура, раздел Auth Endpoints.
- `AUTH_MODAL_SPEC.md` (frontend) — спецификация модалки авторизации на фронтенде.
- `DESIGN_SPEC.md` — ранний product overview, список auth endpoints.
- `TELEGRAM_NOTIFICATIONS.md` — подключение Telegram и доставка уведомлений.
