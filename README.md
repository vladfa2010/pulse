# PULSE Backend

> PULSE — русскоязычный агрегатор инвестиционных новостей. Backend: Node.js + Express + TypeScript.

---

## Stack

| Компонент | Версия / Пакет |
|-----------|----------------|
| Runtime   | Node.js 20     |
| Framework | Express        |
| Language  | TypeScript     |
| SQLite    | sql.js (WASM)  |
| PostgreSQL| pg             |
| Auth      | bcryptjs, jsonwebtoken |
| Cron      | node-cron      |
| HTTP      | axios          |

---

## Быстрый старт

### SQLite — zero-config (по умолчанию)

```bash
cd pulse-backend
npm install
npm run build
cp .env.example .env   # USE_SQLITE=true уже проставлен
node dist/index.js
```

Сервер: `http://localhost:3001`

### Production — PostgreSQL + Redis + Docker

```bash
# 1. Инфраструктура
docker-compose up -d

# 2. Инициализация схемы БД
npm run db:init

# 3. Настроить .env: USE_SQLITE=false, DB_HOST=..., DB_PASSWORD=...

# 4. Запуск
npm run build
npm start
```

---

## Структура проекта

```
src/
├── index.ts              # Express сервер, роуты, cron-задачи
├── config/
│   ├── db.ts             # Dual-mode: PostgreSQL / SQLite
│   └── db-sqlite.ts      # sql.js адаптер (pure JS, zero-config)
├── middleware/
│   └── auth.ts           # JWT verification middleware
├── models/
│   └── schema.sql        # Схема 8 таблиц PostgreSQL
├── routes/
│   ├── auth.ts           # Регистрация, логин, профиль
│   ├── news.ts           # Лента новостей, фильтрация по тегам
│   ├── payment.ts        # YooKassa: создание, подтверждение, история
│   ├── user.ts           # Профиль, теги, уведомления, каналы
│   ├── translate.ts      # Перевод EN→RU
│   ├── webhook.ts        # Callback'и YooKassa
│   └── admin.ts          # Админ-панель (users, stats)
├── services/
│   ├── rssSources.ts     # 32 RSS источника (13 RU + 19 EN)
│   ├── rssFetcher.ts     # Batch fetch, XML parse, dedup
│   ├── translate.ts      # Cache → Kimi API → Google fallback
│   ├── cron.ts           # Cron-задачи (RSS, теги, сентимент, cleanup)
│   ├── telegram.ts       # Telegram Bot API, отчёты, алерты
│   ├── email.ts          # SendGrid email, HTML шаблоны
│   └── reports.ts        # Еженедельные отчёты
├── scripts/
│   └── initDb.ts         # Инициализация PostgreSQL схемы
└── types/
    └── sqljs.d.ts        # Типы для sql.js
```

**27 файлов исходного кода.**

---

## API Endpoints

Все endpoint'ы префикс: `/api/`

### Auth

| Method | Path       | Body | Описание |
|--------|------------|------|----------|
| `POST` | `/register`| `{email, username, password}` | Регистрация |
| `POST` | `/login`   | `{email, password}` | Вход, возвращает JWT |
| `GET`  | `/me`      | — | Bearer token, текущий пользователь |

### News

| Method | Path         | Query | Описание |
|--------|--------------|-------|----------|
| `GET`  | `/`          | `?page=1&limit=50&since=ISO` | Лента новостей |
| `GET`  | `/tags/:tagId`| — | Новости по тегу |

### Payment

| Method | Path      | Body | Описание |
|--------|-----------|------|----------|
| `POST` | `/create` | `{amount=490, discount=0, method='card'}` | Создание платежа |
| `POST` | `/confirm`| `{paymentId}` | Подтверждение платежа |
| `GET`  | `/history`| — | История платежей |

### User

| Method   | Path             | Body | Описание |
|----------|------------------|------|----------|
| `GET`    | `/profile`       | — | Профиль пользователя |
| `PATCH`  | `/profile`       | `{username}` | Обновление профиля |
| `GET`    | `/tags`          | — | Подписки на теги |
| `POST`   | `/tags`          | `{tagId, tagName, tagType}` | Добавить тег |
| `DELETE` | `/tags/:tagId`   | — | Удалить тег |
| `GET`    | `/notifications` | — | Настройки уведомлений |
| `PATCH`  | `/notifications` | `{tg_enabled, email_enabled, ...}` | Обновить настройки |
| `GET`    | `/channels`      | — | Каналы связи |
| `POST`   | `/channels`      | `{channel, target}` | Добавить канал |

### Translate

| Method | Path | Body | Описание |
|--------|------|------|----------|
| `POST` | `/`  | `{texts: [...]}` | Перевод EN→RU |

### Webhook

| Method | Path        | Body | Описание |
|--------|-------------|------|----------|
| `POST` | `/yookassa` | — (payload от YooKassa) | Callback YooKassa |

### Admin

| Method | Path    | Access | Описание |
|--------|---------|--------|----------|
| `GET`  | `/users`| `ADMIN_EMAILS` only | Список пользователей |
| `GET`  | `/stats`| `ADMIN_EMAILS` only | Статистика |

---

## База данных

### Dual-mode

**SQLite (default, zero-config):**

```bash
USE_SQLITE=true
SQLITE_FILE=./pulse.db
```

- База = файл на диске
- sql.js — pure JavaScript/WASM, не требует компиляции
- Авто-инициализация схемы при старте
- Сохранение на каждую запись + при `SIGINT`

**PostgreSQL (production):**

```bash
USE_SQLITE=false
DB_HOST=...
DB_PASSWORD=...
```

- Нативные массивы (`text[]`)
- UPSERT (`ON CONFLICT`)

### Таблицы

| Таблица | Описание |
|---------|----------|
| `users` | Пользователи (email, password_hash, role, created_at) |
| `portfolios` | Портфели пользователей |
| `payments` | История платежей YooKassa |
| `news` | Новости (title, description, url, source, lang, sentiment, tags[], pub_date) |
| `user_sessions` | JWT-сессии |
| `user_channels` | Каналы связи (Telegram, Email) |
| `notification_settings` | Настройки уведомлений |
| `translation_cache` | Кэш переводов |

---

## Cron задачи

### 1. RSS Агрегатор — каждые 15 минут

| Шаг | Описание |
|-----|----------|
| Fetch | 32 RSS источника, batch 5 параллельно, 50ms задержка, 5s timeout |
| Parse | XML → извлечение title, description, pubDate |
| Deduplication | Пропуск уже существующих по `url` |
| Translate | EN→RU: cache → Kimi API → Google Translate fallback |
| Tag matching | 16 тегов по ключевым словам |
| Sentiment | positive / negative / neutral |
| Save | Вставка новых новостей |
| Cleanup | Удаление новостей старше 14 дней |

### 2. Weekly Reports — воскресенье 13:00 MSK

| Шаг | Описание |
|-----|----------|
| Сбор | Новости по тегам пользователя за 7 дней |
| Анализ | Группировка по тегам, sentiment summary |
| Отправка | Telegram + Email с учётом настроек |
| Тихие часы | Пропуск по `quiet_hours_start/end` |

---

## RSS источники

**13 русскоязычных + 19 англоязычных = 32 источника.**

Источники конфигурируются в `services/rssSources.ts`. Поддерживаются все стандартные RSS/Atom форматы.

---

## Перевод EN→RU

Цепочка: **translation_cache → Kimi API → Google Translate**

| Этап | Условие |
|------|---------|
| Cache hit | Возврат из `translation_cache` |
| Kimi API | Основной переводчик |
| Google Translate | Fallback при ошибке Kimi |
| Cache miss + success | Сохранение в `translation_cache` |

---

## Docker

```bash
docker-compose up -d
```

Поднимает: PostgreSQL 16, Redis 7, Backend.

---

## Тестирование

### Регистрация

```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@pulse.app","username":"Demo","password":"demo12345"}'
```

### Добавить тег

```bash
curl -X POST http://localhost:3001/api/user/tags \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"tagId":"tsla","tagName":"Tesla","tagType":"company"}'
```

---

## Environment

Файл `.env.example` — полностью заполнен. Для SQLite ничего менять не нужно.

| Переменная | SQLite | PostgreSQL |
|------------|--------|------------|
| `USE_SQLITE` | `true` | `false` |
| `SQLITE_FILE` | `./pulse.db` | — |
| `DB_HOST` | — | `your_host` |
| `DB_PASSWORD` | — | `your_password` |

---

## Git

- **Ветка:** `stable`
- **Ключевые коммиты:**
  - `feat(backend): complete PULSE backend v1.0` — базовая структура
  - `feat(sqlite): zero-config SQLite mode` — dual-mode SQLite
