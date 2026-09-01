# PULSE Backend

> Backend API для платформы PULSE — русскоязычный агрегатор инвестиционных новостей.

**🌐 Production:** https://pulse-api-bsov.onrender.com  
**🎨 Frontend:** https://pulse.inside-trade.ru  
**📄 Docs:** [DEPLOYMENT.md](./DEPLOYMENT.md) | [DESIGN_SPEC.md](./DESIGN_SPEC.md) | [PRODUCT_CONTEXT.md](./PRODUCT_CONTEXT.md) | [ARCHITECTURE.md](./ARCHITECTURE.md) | [PUSH_NOTIFICATIONS.md](./PUSH_NOTIFICATIONS.md) | [SECURITY.md](./SECURITY.md)

---

## Tech Stack

| Компонент | Технология |
|-----------|-----------|
| Runtime | Node.js 20 |
| Framework | Express |
| Language | TypeScript |
| Database | SQLite (sql.js/WASM) — dev / PostgreSQL — prod |
| Auth | bcrypt + jsonwebtoken |
| Cron | node-cron |
| HTTP | axios |

---

## Быстрый старт

### SQLite — zero-config (по умолчанию)

```bash
npm install
npm run build
npm start       # localhost:3000
```

### Docker (PostgreSQL + Redis)

```bash
docker-compose up
```

---

## API Endpoints

### Auth
| Method | Endpoint | Описание |
|--------|----------|----------|
| POST | `/api/auth/register` | Регистрация (welcome-письмо) |
| POST | `/api/auth/login` | Вход |
| POST | `/api/auth/forgot-password` | Запрос кода восстановления пароля |
| POST | `/api/auth/verify-code` | Проверка кода и выдача reset-токена |
| POST | `/api/auth/reset-password` | Установка нового пароля |
| POST | `/api/auth/logout` | Выход |
| GET | `/api/auth/me` | Текущий пользователь |


### News
| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/news` | Лента новостей |
| GET | `/api/news/:id` | Детальная новость |
| GET | `/api/news/by-tag/:tag` | Новости по тегу |
| GET | `/api/news/tags/popular` | Популярные теги сообщества (24h/7d/30d) |
| GET | `/api/news_heatmap` | Тепловая карта активности (year/day/day_hours) |
| GET | `/api/news_heatmap/candles` | Недельные свечи IMOEX/SPY/инструмента тега |
| GET | `/api/news_heatmap/mini-grids` | Мини-сетки по списку тегов |

Подробнее:
- [`docs/news/popular-tags.md`](./docs/news/popular-tags.md)
- [`docs/news/heatmap.md`](./docs/news/heatmap.md)

### User
| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/user/profile` | Профиль |
| PUT | `/api/user/profile` | Обновление профиля |
| GET | `/api/user/portfolio` | Портфель |
| PUT | `/api/user/portfolio` | Обновление портфеля |
| GET | `/api/user/notification-matrix` | Матрица уведомлений (продукт × канал) |
| PUT | `/api/user/notification-matrix` | Обновить ячейку матрицы |
| POST | `/api/user/notification-matrix/quiet-hours` | Тихие часы |
| GET | `/api/user/notification-delivery-target` | Адрес доставки по каналу |
| GET | `/api/user/notifications` | **Legacy:** маппится на матрицу |
| PATCH | `/api/user/notifications` | **Legacy:** маппится на матрицу |

### Payment
| Method | Endpoint | Описание |
|--------|----------|----------|
| POST | `/api/payment/create` | Создание платежа |
| POST | `/api/payment/confirm` | Подтверждение (demo) |
| GET | `/api/payment/history` | История |
| POST | `/api/webhook/yookassa` | Webhook от YuKassa (вручную настроен в ЛК) |

> Подробнее о платежах: [`PAYMENTS.md`](./PAYMENTS.md). Webhook URL в ЛК YuKassa: `https://pulse-api-bsov.onrender.com/api/webhook/yookassa`.

### Translate
| Method | Endpoint | Описание |
|--------|----------|----------|
| POST | `/api/translate` | Перевод EN→RU |

### Fact-check

On-demand факт-чекинг новостей через LLM + веб-поиск (5 поисковиков). Результат проверки отправляется в Telegram (MarkdownV2) и/или на email в зависимости от каналов, включённых в матрице уведомлений (`fact_check` → `telegram` / `email`).

| Method | Endpoint | Описание |
|--------|----------|----------|
| POST | `/api/news/:id/fact-check` | Запуск/перезапуск проверки |
| GET | `/api/news/:id/fact-check` | Статус и результат проверки |
| GET | `/api/news/:id/fact-check/stream` | SSE-прогресс проверки |

Подробная документация: [`docs/fact-check.md`](./docs/fact-check.md)

### Telegram (бот и уведомления)

Подробная документация: [`TELEGRAM_NOTIFICATIONS.md`](./TELEGRAM_NOTIFICATIONS.md)

### Push-уведомления

Push-канал реализован через Firebase Cloud Messaging (FCM) и VAPID Web Push. Включение и управление каналами происходит через матрицу уведомлений (`/api/user/notification-matrix`).  
Подробная документация: [`PUSH_NOTIFICATIONS.md`](./PUSH_NOTIFICATIONS.md)

| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/telegram/config` | Конфиг OAuth-виджета (`botId`, `botUsername`) |
| POST | `/api/auth/telegram` | Подключение через Telegram Login Widget |
| GET | `/api/telegram/link` | Генерация HMAC-deep-link для fallback |
| GET | `/api/user/telegram-status` | Статус подключения Telegram |
| POST | `/api/user/telegram-disconnect` | Отключить Telegram-уведомления |
| POST | `/api/webhook/telegram` | Webhook от Telegram API |

### Portfolio / Broker keys

Подключение брокерских счетов (Финам, БКС, Инсайд), автосинхронизация позиций, сводка портфеля и облако рекомендуемых тегов.

| Method | Endpoint | Описание |
|--------|----------|----------|
| GET / POST / PATCH / DELETE | `/api/broker-keys` | Управление ключами брокеров |
| GET / POST / PATCH / DELETE | `/api/portfolio` | Управление портфелями |
| POST | `/api/portfolio/:id/sync` | Ручная синхронизация |
| GET | `/api/portfolio/summary` | Сводка с ценами и PnL |
| GET | `/api/portfolio/recommended-tags` | Облако рекомендуемых тегов |

Подробнее: [`docs/portfolio.md`](./docs/portfolio.md)

### Admin
| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/admin/stats` | Статистика |
| GET | `/api/admin/users` | Список пользователей |

---

## Деплой

### Render (текущий)
- **Type:** Web Service
- **Runtime:** Docker
- **Branch:** `main`
- **Автодеплой:** При push в `main`

### Environment Variables
| Variable | Описание |
|----------|----------|
| `USE_SQLITE` | `true` — SQLite, иначе PostgreSQL |
| `JWT_SECRET` | Секрет для JWT |
| `DATABASE_URL` | PostgreSQL connection string |
| `FRONTEND_URL` | URL фронтенда (`https://pulse.inside-trade.ru`) |
| `YOOKASSA_SHOP_ID` | ЮKassa shop ID |
| `YOOKASSA_SECRET_KEY` | ЮKassa secret |
| `KIMI_API_KEY` | Kimi Translate API |
| `ENCRYPTION_KEY` | 64 hex-символов (32 байта) для AES-256-GCM шифрования API-токенов брокеров |
| `EMAIL_PROVIDER` | Email-провайдер: `resend`, `yandex` или `none` |
| `EMAIL_FROM` | Адрес отправителя (например `noreply@pulse.inside-trade.ru`) |
| `RESEND_API_KEY` | Resend API ключ |
| `YANDEX_USER` | Yandex SMTP логин |
| `YANDEX_PASS` | Yandex SMTP app-пароль |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot token |

---

## Database Schema

Ключевые таблицы: `users`, `portfolios`, `payments`, `news`, `user_sessions`, `user_channels`, `notification_subscriptions`, `notification_settings`, `push_subscriptions`, `translation_cache`.

`notification_subscriptions` — единственный источник правды о подписках (матрица продукт × канал). `notification_settings` сохранена для тихих часов, `digest_email` и обратной совместимости.

См. `src/models/schema.sql` и `src/migrations/notification_matrix_v1.sql`.
# force redeploy Mon Jun  1 18:43:06 CST 2026
# force redeploy 1780317442
# unstuck 1780318331
