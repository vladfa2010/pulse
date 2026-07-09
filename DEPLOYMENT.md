# PULSE — Deployment Guide

> Единый документ по инфраструктуре, деплою и окружению.
> Последнее обновление: 2026-06-18

> **⚠️ ВАЖНО:** Все сервисы развёрнуты на **платном тарифе Render**. Instance не засыпает, крон работает 24/7. Никакого «free tier» — не использовать как аргумент при отладке.

---

## Архитектура

```
┌─────────────────────────────────────────────────────────────┐
│                         ПОЛЬЗОВАТЕЛЬ                        │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼                               ▼
┌──────────────────────────┐    ┌──────────────────────────────┐
│   FRONTEND               │    │   BACKEND                    │
│   pulse.inside-trade.ru  │    │   pulse-api-bsov             │
│   (custom domain)        │    │   .onrender.com              │
│                          │    │                              │
│   Render Static Site     │◄──►│   Render Web Service         │
│   - React SPA            │    │   - Node.js + Express        │
│   - Build: npm run build │    │   - PostgreSQL (Render) /    │
│   - Publish: dist/       │    │     SQLite (local)           │
│                          │    │   - JWT Auth                 │
│                          │    │   - RSS Aggregator           │
│                          │    │   - Kimi API (translation +  │
│                          │    │     sentiment + tag matching)│
└──────────────────────────┘    └──────────────────────────────┘

        Связь: Frontend → Backend: REST API + JWT
```

---

## Render API и доступ к логам

Для диагностики деплоев у ассистента есть локальный Render API токен.

| Параметр | Значение |
|----------|----------|
| **Render API Token** | `<REDACTED>` |
| **Файл с токеном** | `.render-token` в корне проекта (не коммитить) |
| **Owner ID** | `tea-d8a2e528qa3s73efm1g0` |

### Service IDs

| Сервис | Render ID | URL |
|--------|-----------|-----|
| pulse-frontend (Static Site) | `srv-d8ao626k1jcs73856fbg` | https://pulse-frontend-jt53.onrender.com (custom domain: https://pulse.inside-trade.ru) |
| pulse-api (Web Service) | `srv-d8a2fum7r5hc73e11pbg` | https://pulse-api-bsov.onrender.com |
| pulse-app (Static Site, legacy) | `srv-d8aafhrbc2fs73ak9790` | https://pulse-app-nfez.onrender.com |

### Чтение логов через API

```bash
TOKEN=$(cat .render-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.render.com/v1/logs?ownerId=tea-d8a2e528qa3s73efm1g0&resource=<SERVICE_ID>&direction=backward"
```

### Пагинация

Ответ содержит `hasMore`, `nextEndTime`, `nextStartTime`. Для получения более старых логов используй `nextEndTime`:

```bash
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.render.com/v1/logs?ownerId=tea-d8a2e528qa3s73efm1g0&resource=<SERVICE_ID>&direction=backward&endTime=<nextEndTime>"
```

> ⚠️ **Безопасность:** Токен хранится локально и не должен попадать в git. Если `.render-token` случайно закоммичен — отозвать токен в Render Dashboard и создать новый.

---

## Frontend (Render Static Site)

### URL
**Production:** https://pulse.inside-trade.ru  
**Render URL:** https://pulse-frontend-jt53.onrender.com

### Render Settings
| Поле | Значение |
|------|----------|
| **Type** | Static Site |
| **Build Command** | `npm install && npm run build` |
| **Publish Directory** | `dist` |
| **Branch** | `main` |

### Environment Variables
| Variable | Value | Описание |
|----------|-------|----------|
| `VITE_API_URL` | `https://pulse-api-bsov.onrender.com` | URL backend API |

### Git Repository
- **URL:** https://github.com/vladfa2010/pulse-frontend
- **Branch:** `main`
- **Автодеплой:** Включен (при каждом push в `main`)

### Локальный запуск
```bash
cd /mnt/agents/projects/frontend
npm install
npm run dev     # localhost:5173
```

### Production build
```bash
npm run build   # выход в dist/
```

---

## Backend (Render Web Service)

### URL
**https://pulse-api-bsov.onrender.com**

### Render Settings
| Поле | Значение |
|------|----------|
| **Type** | Web Service |
| **Runtime** | Docker |
| **Branch** | `main` |

### Environment Variables (Render Dashboard)
| Variable | Value | Описание |
|----------|-------|----------|
| `USE_SQLITE` | `false` | `false` = PostgreSQL (production), `true` = SQLite (local) |
| `DATABASE_URL` | `(скрыт)` | PostgreSQL Internal Database URL от Render |
| `JWT_SECRET` | `(скрыт)` | Секрет для JWT токенов |
| `FRONTEND_URL` | `https://pulse.inside-trade.ru` | URL фронтенда для редиректов и ссылок в письмах |
| `YOOKASSA_SHOP_ID` | `(скрыт)` | ЮKassa shop ID (demo: 54401) |
| `YOOKASSA_SECRET_KEY` | `(скрыт)` | ЮKassa secret key |
| `KIMI_API_KEY` | `(скрыт)` | Kimi API (api.moonshot.ai) для перевода EN→RU, sentiment analysis, tag matching |
| `CRON_SECRET_KEY` | `(скрыт)` | Секрет для manual triggers (/trigger-rss, /backfill-tags, /backfill-translate) |
| `EMAIL_PROVIDER` | `(скрыт)` | `resend` / `yandex` / `none` |
| `EMAIL_FROM` | `(скрыт)` | Адрес отправителя (`noreply@pulse.inside-trade.ru`) |
| `RESEND_API_KEY` | `(скрыт)` | Resend API ключ |
| `YANDEX_USER` | `(скрыт)` | Yandex SMTP логин |
| `YANDEX_PASS` | `(скрыт)` | Yandex SMTP app-пароль |
| `TELEGRAM_BOT_TOKEN` | `(скрыт)` | Telegram Bot токен |

### Git Repository
- **URL:** https://github.com/vladfa2010/pulse
- **Branch:** `main`

### Локальный запуск
```bash
cd /mnt/agents/projects/backend
npm install
npm run build
npm start       # localhost:3000
```

### Docker (локально)
```bash
docker-compose up   # PostgreSQL 16 + Redis 7 + Backend
```

---

## Тестовый логин

- **Email:** `vladfa@ya.ru`
- **Password:** `!1234567890`
- **URL:** https://pulse.inside-trade.ru

---

## Git Workflow

### Sandbox (локальная среда)
```
/mnt/agents/projects/
├── backend/     ← git: vladfa2010/pulse (main)
└── frontend/    ← git: vladfa2010/pulse-frontend (main)
```

### Push-доступ
- **Frontend:** `origin → https://TOKEN@github.com/vladfa2010/pulse-frontend.git`
- **Backend:** `origin → https://TOKEN@github.com/vladfa2010/pulse.git`

### Push workaround (sandbox)
```bash
cd /mnt/agents/projects/backend
GIT_HTTP_LOW_SPEED_TIME=300 git push origin main
```
При ошибке GnuTLS — повторить через 3 секунды (`rm -f .git/index.lock` если нужно)

### Правило синхронного обновления
- Backend и frontend — один проект
- Commit'ы должны идти парами (если изменения касаются обоих)
- Указывать hash обоих commit'ей после push
- ❌ ЗАПРЕЩЕНО push'ить только один репозиторий

### Команды
```bash
# Frontend
cd /mnt/agents/projects/frontend
git add -A
git commit -m "type: description"
git push origin main

# Backend
cd /mnt/agents/projects/backend
git add -A
git commit -m "type: description"
git push origin main
```

---

## Проблемы и решения

### Frontend: белая страница
**Причина:** Неправильный `base` в `vite.config.ts`
**Решение:** `base` должен быть `'/'` для Render, `'/pulse-frontend/'` для GitHub Pages

### Backend: 30-sec warmup
**Причина:** Render instance cold start после деплоя или рестарта
**Решение:** Первый запрос медленный (~30 сек), последующие — быстрые. Платный тариф — instance не засыпает.

### Git push: timeout
**Причина:** GnuTLS error в sandbox
**Решение:** Git config `http.version HTTP/1.1`

### Google Translate blocked on Render
**Причина:** Google Translate API недоступен с серверов Render
**Решение:** Использовать Kimi API (api.moonshot.ai)

### Render не обновляется после push
**Причина:** Render игнорирует empty commits
**Решение:** Делать реальные изменения (не empty commits), менять версию в `/health`

### 504 Gateway Timeout
**Причина:** Render instance cold start после деплоя или рестарта
**Решение:** Первый запрос ~30 сек (warmup), последующие — быстрые. Платный тариф — instance не засыпает.

---

## Переменные окружения (.env.example)

### Frontend
```env
VITE_API_URL=https://pulse-api-bsov.onrender.com
```

### Backend
```env
PORT=3000
USE_SQLITE=true
DATABASE_URL=postgresql://postgres:password@localhost:5432/pulse
JWT_SECRET=your-secret-key
FRONTEND_URL=https://pulse.inside-trade.ru
YOOKASSA_SHOP_ID=54401
YOOKASSA_SECRET_KEY=test_secret_key
KIMI_API_KEY=your-kimi-api-key
CRON_SECRET_KEY=your-cron-secret
SENDGRID_API_KEY=your-sendgrid-key
TELEGRAM_BOT_TOKEN=your-bot-token

# Email
EMAIL_PROVIDER=resend
EMAIL_FROM=noreply@pulse.inside-trade.ru
RESEND_API_KEY=re_xxxxxxxx
```
