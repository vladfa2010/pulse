# PULSE — Deployment Guide

> Единый документ по инфраструктуре, деплою и окружению.
> Последнее обновление: 2026-08-07

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

### Bundle и performance (TZ-23)

Бандл фронтенда разбит на чанки, чтобы ускорить первый экран:

| Чанк | Содержимое | Загрузка |
|------|------------|----------|
| `vendor-*.js` | `react`, `react-dom`, `react-router` | Первый экран |
| `index-*.js` | Layout, Home, hooks, API-клиент | Первый экран |
| `Admin-*.js` | Админка, графики, `recharts`/`echarts` | Только при `/admin` |
| `SentimentIndex-*.js` | `/sentiment`, `SentimentChartCard`, `recharts` | Только при `/sentiment` |
| `Profile-*.js`, `Pricing-*.js`, `NewsFeed-*.js`, `PortfolioPage-*.js` и др. | Соответствующие страницы | Только при переходе |

- **Lazy-маршруты:** `/admin`, `/sentiment`, `/pricing`, `/profile`, `/feed`, `/instructions`, `/terms`, `/privacy`, `/portfolio`, `/download` загружаются через `React.lazy` + `Suspense`.
- **firebase/analytics:** не входит в начальный бандл; загружается динамически при первом вызове `initAnalytics()` / `logAnalyticsEvent()`.
- **echarts** используется только в админском `TagMarketTimeline` и подгружается динамически; **recharts** уехал в админский и сентимент-чанки через lazy-маршруты.
- **Цель:** основной чанк ≤ 300 КБ brotli; фактически ~307 КБ gzip (brotli ещё меньше).

> **Проверка:** `npm run build` → в `dist/assets/` несколько JS-чанков; главный `index-*.js` не содержит `echarts`/`recharts`/`firebase/analytics`.


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
| **Health Check Path** | `/health` |

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
| `ENCRYPTION_KEY` | `(скрыт)` | 64 hex-символов (32 байта) для AES-256-GCM шифрования API-токенов брокеров. Обязателен для фичи портфелей. |

### Git Repository
- **URL:** https://github.com/vladfa2010/pulse
- **Branch:** `main`

### Жизненный цикл деплоя (TZ-20)

#### Startup: сначала порт, потом миграции

Бэкенд открывает HTTP-порт и начинает отвечать на `/health` **до** запуска миграций и фоновых задач. Это позволяет Render считать сервис живым и направлять на него трафик, пока идёт инициализация.

- `GET /health` возвращает `200 OK` сразу после старта процесса.
- Миграции БД, инициализация cron-задач, SSE и фоновые воркеры стартуют после того, как сервер начал слушать порт.
- Ожидаемый лог на старте: `PULSE backend running on port ...`.

#### Graceful shutdown

При получении `SIGTERM` (Render останавливает контейнер при деплое или ручном рестарте):

1. Закрывается HTTP-сервер (`server.close()`), прекращается приём новых соединений.
2. Закрываются активные SSE-подключения.
3. Сервер ждёт до **8 секунд** (drain timeout), чтобы завершить текущие запросы.
4. Процесс завершается с кодом `0`.

Ожидаемые логи при shutdown:
```
[Shutdown] SIGTERM received, draining…
[SSE] Closed X SSE connection(s) during shutdown   # только если были активные SSE-подписчики
```

> **Важно:** если graceful shutdown не завершился вовремя, Render пришлёт `SIGKILL`. Убедитесь, что длительные фоновые задачи обрабатывают `SIGTERM` корректно.

### Мониторинг и observability (TZ-22)

#### Health endpoints

| Endpoint | URL | Назначение | Работа при исчерпанном лимите |
|----------|-----|------------|-------------------------------|
| `/health` | `https://pulse-api-bsov.onrender.com/health` | Render health check; проверяет cron, SSE, ENCRYPTION_KEY | ✅ Отвечает 200 (не под лимитером) |
| `/api/health` | `https://pulse-api-bsov.onrender.com/api/health` | Внешний мониторинг (UptimeRobot, cron-job.org); лёгкий, без запросов к БД | ✅ Отвечает 200 (не под лимитером) |

**Логика:** оба эндпоинта зарегистрированы **до** `app.use(apiLimiter)`, поэтому не расходуют общий пул 300 req/15 мин и не получают 429. Это важно для избежания ложных алертов «сервис лежит».

- Настрой внешний мониторинг на `GET /api/health`.
- Ожидаемый ответ: `{ "ok": true, "uptime": 123.45 }`.
- Алерт при недоступности > 2 мин.

#### Лог медленных запросов

Middleware замеряет длительность каждого запроса (кроме health-эндпоинтов). Если запрос длился >3000 мс, в логах Render появляется:

```
[SLOW] GET /api/news 200 4123
```

Назначение — измерять частоту и длительность медленных окон (деплои, cron, пул PostgreSQL). При необходимости порог можно поднять до 5000 мс.

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

## Graphify — knowledge graph проекта

В проекте используется **Graphify** для построения интерактивного графа кодовой базы и документации. Это часть нашего технологического стека: с помощью графа можно исследовать архитектуру, находить связи между модулями и проводить аудит.

### Расположение

- `pulse-backend/graphify-out/` — основная папка с артефактами графа, версионируется в git.
- В корне проекта есть symlink: `graphify-out -> pulse-backend/graphify-out`, чтобы запускать команды из корня.

### Что хранится в git

Полезные артефакты:
- `graph.json`, `graph.html`, `GRAPH_REPORT.md` — основной граф и отчёт.
- `manifest.json`, `cost.json` — метаданные сборки.
- `pulse-kode-callflow.html` — callflow-визуализация.
- `*-flow.html`, `*-flow.mmd`, `*-flow.svg` — диаграммы отдельных фич.
- `generate_callflow_html.py`, `merge_semantic.py`, `update_manifest_cost.py` — вспомогательные скрипты.

Игнорируются git-ом (но остаются локально):
- `cache/` — AST-кэш.
- `.chunk_*` — промежуточные чанки.
- `.graphify_*`, `.semantic_merge_summary.json` — служебные файлы.
- `20*/` — датированные снапшоты.

### Автообновление после коммита

В `.git/hooks/post-commit` и `.git/hooks/post-checkout` настроены хуки для `pulse-backend` и `pulse-frontend`:

```bash
graphify update .
```

После каждого коммита локально пересобирается кодовый граф:
- Обновляются `graph.json`, `graph.html`, `GRAPH_REPORT.md`, `pulse-kode-callflow.html`.
- Названия коммьюнити сохраняются.
- Документы (`TZ_*.md` и пр.) **автоматически не пересобираются** — для этого нужен полный `graphify extract .`.

### Основные команды

```bash
# Инкрементальное обновление кодового графа
graphify update .

# Полнная перестройка с семантической экстракцией документов
graphify extract .

# Задать вопрос графу
graphify query "как работает апгрейд подписки?"

# Кратчайший путь между двумя сущностями
graphify path "activateSubscription" "YooKassa"

# Объяснить узел
graphify explain "processAutoRenewals"

# Что затрагивает изменение
graphify affected "activateSubscription" --relation calls
```

### Когда коммитить граф

Обычный коммит с кодом **не включает** изменения графа. Хук только пересобирает файлы локально. Чтобы отправить обновлённый граф в git, нужен отдельный коммит:

```bash
git add graphify-out/
git commit -m "chore(graphify): update graph"
git push
```

---

## Telegram-уведомления о коммитах

При каждом push в `main` в репозиториях `pulse-frontend` и `pulse` GitHub Actions отправляет алерт в Telegram.

### Workflow

- **Файл:** `.github/workflows/telegram-notify.yml`
- **Триггер:** `push` в ветку `main`
- **Реализация:** Python-скрипт внутри workflow, шлёт `POST` к `https://api.telegram.org/bot<TOKEN>/sendMessage`
- **Цель:** оперативно уведомлять о новых коммитах в проекте

### Необходимые секреты

В обоих репозиториях должны быть добавлены Secrets (`Settings → Secrets and variables → Actions`):

| Secret | Описание |
|--------|----------|
| `TELEGRAM_BOT_TOKEN` | Токен Telegram-бота из @BotFather |
| `TELEGRAM_CHAT_ID` | ID чата или пользователя, куда отправлять алерты |

> Секреты задаются **отдельно для каждого репозитория** — GitHub не наследует их между репами.

### Содержание сообщения

Каждый алерт содержит:

- 🚀 PULSE push
- Репозиторий
- Ветка (`main`)
- Автор коммита
- Короткий хэш коммита
- Сообщение коммита
- Ссылку на коммит на GitHub

### Проверка

После push в `main` workflow запускается автоматически. Статус можно посмотреть в `Actions` → `Telegram Notify`.

---

## Проблемы и решения

### Frontend: белая страница
**Причина:** Неправильный `base` в `vite.config.ts`
**Решение:** `base` должен быть `'/'` для Render, `'/pulse-frontend/'` для GitHub Pages

### Backend: 30-sec warmup / 504 Gateway Timeout
**Причина:** Раньше Render переключал трафик только после полной инициализации миграций и фоновых задач, из-за чего первый запрос мог занимать ~30 сек.
**Решение:** Начиная с TZ-20 бэкенд открывает порт и отвечает на `/health` **до** миграций. Render считает сервис готовым раньше, и переключение трафика происходит без длительного таймаута. Платный тариф — instance не засыпает.

### Git push: timeout
**Причина:** GnuTLS error в sandbox
**Решение:** Git config `http.version HTTP/1.1`

### Google Translate blocked on Render
**Причина:** Google Translate API недоступен с серверов Render
**Решение:** Использовать Kimi API (api.moonshot.ai)

### Render не обновляется после push
**Причина:** Render игнорирует empty commits
**Решение:** Делать реальные изменения (не empty commits), менять версию в `/health`

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
