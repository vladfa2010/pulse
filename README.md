# PULSE Backend

> Backend API для платформы PULSE — русскоязычный агрегатор инвестиционных новостей.

**🌐 Production:** https://pulse-api-bsov.onrender.com  
**🎨 Frontend:** https://pulse-frontend-jt53.onrender.com  
**📄 Docs:** [DEPLOYMENT.md](./DEPLOYMENT.md) | [DESIGN_SPEC.md](./DESIGN_SPEC.md) | [PRODUCT_CONTEXT.md](./PRODUCT_CONTEXT.md)

---

## Tech Stack

| Компонент | Технология |
|-----------|-----------|
| Runtime | Node.js 20 |
| Framework | Express |
| Language | TypeScript |
| Database | SQLite (sql.js/WASM) — dev / PostgreSQL — prod |
| Auth | bcryptjs + jsonwebtoken |
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
| POST | `/api/auth/register` | Регистрация |
| POST | `/api/auth/login` | Вход |
| POST | `/api/auth/logout` | Выход |
| GET | `/api/auth/me` | Текущий пользователь |


### News
| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/news` | Лента новостей |
| GET | `/api/news/:id` | Детальная новость |
| GET | `/api/news/by-tag/:tag` | Новости по тегу |

### User
| Method | Endpoint | Описание |
|--------|----------|----------|
| GET | `/api/user/profile` | Профиль |
| PUT | `/api/user/profile` | Обновление профиля |
| GET | `/api/user/portfolio` | Портфель |
| PUT | `/api/user/portfolio` | Обновление портфеля |

### Payment
| Method | Endpoint | Описание |
|--------|----------|----------|
| POST | `/api/payment/create` | Создание платежа |
| POST | `/api/payment/confirm` | Подтверждение |
| GET | `/api/payment/history` | История |

### Translate
| Method | Endpoint | Описание |
|--------|----------|----------|
| POST | `/api/translate` | Перевод EN→RU |

### Webhook
| Method | Endpoint | Описание |
|--------|----------|----------|
| POST | `/api/webhook/yookassa` | ЮKassa callback |
| POST | `/api/webhook/telegram` | Telegram callback |

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
| `YOOKASSA_SHOP_ID` | ЮKassa shop ID |
| `YOOKASSA_SECRET_KEY` | ЮKassa secret |
| `KIMI_API_KEY` | Kimi Translate API |
| `SENDGRID_API_KEY` | SendGrid API |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot token |

---

## Database Schema

8 таблиц: `users`, `portfolios`, `payments`, `news`, `user_sessions`, `user_channels`, `notification_settings`, `translation_cache`

См. `src/models/schema.sql`
