# PULSE — Deployment Guide

> Единый документ по инфраструктуре, деплою и окружению.
> Последнее обновление: 2026-09-10 (процедура обновления VPS переписана по итогам
> выкатки ТЗ-85…90 — раздел «Обновление версии (процедура v2)»).
>
> **⚡ СТАТУС:** работают **две идентичные параллельные среды** — это осознанное
> текущее состояние, а не переходный этап миграции:
> - **Render — основной пайплайн деплоя (по старой логике).** Push в `main` → автодеплой
>   frontend + backend, настройки/логи/мониторинг Render используются как раньше
>   (Render API — в разделе «Render API и доступ к логам»). Там же живёт **tgparser-web** —
>   критичный источник телеграм-новостей для обеих сред. Отключение Render не планируется.
> - **VPS** `155.212.216.142` — русский сервер, доступен **без VPN**, на нём обслуживается
>   **оплата**. Домен `pulse.inside-trade.ru` смотрит на него. Обновляется вручную
>   по процедуре из раздела «VPS».

> **⚠️ ВАЖНО:** Все сервисы развёрнуты на **платном тарифе Render**. Instance не засыпает, крон работает 24/7. Никакого «free tier» — не использовать как аргумент при отладке.

---

## Архитектура

### VPS: схема (с 2026-09-03)

```
┌──────────────────────────┐
│        ПОЛЬЗОВАТЕЛЬ      │
└────────────┬─────────────┘
             │ https://pulse.inside-trade.ru
             ▼
┌─────────────────────────────────────────────────────┐
│  VPS 155.212.216.142 (Ubuntu 26.04, 1vCPU/1GB+swap) │
│  Docker Compose (/opt/pulse):                       │
│                                                     │
│   pulse-caddy    :80/:443 — HTTPS (Let's Encrypt,   │
│                  авто-продление), статика фронта,   │
│                  прокси /api/* → backend            │
│   pulse-backend  Node.js 20 + Express               │
│                  node-cron ВНУТРИ процесса:         │
│                  RSS-парсер (15 мин), авто-продл.,  │
│                  уведомления, factcheck-воркер      │
│   pulse-postgres PostgreSQL 18, volume              │
│                  /var/lib/postgresql (НЕ /data!)    │
│                                                     │
│  Порты наружу: 22/80/443 (ufw). PG закрыт снаружи.  │
└─────────────────────────────────────────────────────┘
             │ RSS-ленты (https://tgparser-web.onrender.com/rss и др.)
             │ Kimi API / Firebase / YooKassa / Telegram — по ключам из /opt/pulse/.env
             ▼
        внешние сервисы

⚠️ tgparser — ОТДЕЛЬНЫЙ сервис на Render (tgparser-web.onrender.com).
   Пока он там — VPS-прод зависит от Render для телеграм-новостей.
   При полном отказе от Render его нужно перенести и обновить
   news_sources.config.url.
```

### Render — вторая параллельная среда (основной пайплайн деплоя)

```
pulse-frontend-jt53.onrender.com  (Static Site, автодеплой из main)
pulse-api-bsov.onrender.com       (Web Service, Docker, автодеплой из main)
Managed PostgreSQL 18             (данные — снапшот на 2026-09-02, дрейфует)
```

Две копии идентичны по коду — различаются только IP/хостом и окружением.
Сервисы полноценны: при каждом push в `main` Render пересобирает и выкатывает
их автоматически (настройки Render всё делают сами). Домен на них не смотрит,
но они доступны по onrender-адресам. Остановка/удаление Render **не планируется**:
на нём держится tgparser-web, от которого зависит сбор телеграм-новостей.

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
| pulse-frontend (Static Site) | `srv-d8ao626k1jcs73856fbg` | https://pulse-frontend-jt53.onrender.com (custom domain pulse.inside-trade.ru зарегистрирован в Render, но DNS домена смотрит на VPS — фактически не используется) |
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

> Основной деплой-контур: push в `main` → Render автоматически пересобирает и выкатывает.
> Доменный трафик обслуживает VPS, но сервис активен и доступен по onrender-адресу;
> настройки и логи Render используются как раньше.

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

> Основной деплой-контур: push в `main` → Render автоматически пересобирает и выкатывает.
> Домен обслуживает VPS-бэкенд, но Render-экземпляр полноценен и обновляется из main.
> Раздел также служит справкой: описание health-эндпоинтов, graceful shutdown и
> env-переменных актуально и для VPS.

### URL
**https://pulse-api-bsov.onrender.com**

### Render Settings
| Поле | Значение |
|------|----------|
| **Type** | Web Service |
| **Runtime** | Docker |
| **Branch** | `main` |
| **Health Check Path** | `/api/health` | Лёгкий endpoint без запросов к БД, используется Render для проверки живости сервиса |
| **Health Check Path (legacy)** | `/health` | Подробный endpoint с проверкой cron, SSE, ENCRYPTION_KEY — для мониторинга, но не для Render health check |

> **Важно:** Render health check настроен на `/api/health`, а не на `/health`. `/health` делает запрос к PostgreSQL (cron-лог), и при всплесках нагрузки на БД может отвечать медленно — это провоцировало автоматические рестарты инстанса Render. `/api/health` лёгкий `{ ok: true, uptime }` и не зависит от базы.

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

1. Вызывается `markProcessorShutdown()` — news processor получает сигнал остановки: новые запуски блокируются, активный `AbortController` отменяет текущие LLM-запросы (перевод, теги, sentiment).
2. Закрывается HTTP-сервер (`server.close()`), прекращается приём новых соединений.
3. Закрываются активные SSE-подключения.
4. Сервер ждёт до **8 секунд** (drain timeout), чтобы завершить текущие запросы и корректно завершить или откатить чанк новостей.
5. Процесс завершается с кодом `0`.

Ожидаемые логи при shutdown:
```
[Shutdown] SIGTERM received, draining…
[Processor] shutdown in progress, run skipped   # если тик пришёл во время drain
[Processor] Run aborted (shutdown)              # если прогон был активен и отменён
[SSE] Closed X SSE connection(s) during shutdown   # только если были активные SSE-подписчики
```

> **Важно:** если graceful shutdown не завершился вовремя, Render пришлёт `SIGKILL`. News processor теперь обрабатывает SIGTERM корректно через `AbortController`: активный LLM-вызов прерывается, текущий чанк не сохраняется, следующий тик не стартует.

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

## VPS (русская параллельная среда)

### Доступ

| Параметр | Значение |
|----------|----------|
| **URL** | https://pulse.inside-trade.ru (прод); fallback https://155.212.216.142.sslip.io |
| **IP** | 155.212.216.142 |
| **SSH** | `root@155.212.216.142` |
| **Доступы** | Локально в `.vps-credentials` (корень рабочей директории, `chmod 600`, в `.gitignore` обоих репозиториев) |
| **ОС** | Ubuntu 26.04 LTS, 2 vCPU / 4 ГБ RAM + 4 ГБ swap (апгрейд 2026-09-10, было 1/1+2G) |
| **Расположение** | Россия — сервер доступен **без VPN** для русских пользователей |
| **Назначение** | Параллельная копия прода; здесь обслуживается **оплата** (подписки) |

### Структура на сервере

```
/opt/pulse/
├── docker-compose.yml   # стек: caddy + backend + postgres:18 (pgvector) + embeddings (TEI)
├── .env                 # секреты (НЕ в git, chmod 600)
├── Caddyfile            # два домена (прод + sslip), прокси /api
├── frontend/dist/       # собранный фронт (API_BASE захардкожен → pulse.inside-trade.ru)
├── pulse/               # git-клон этого репозитория (источник сборки backend)
├── logs/                # логи бэкенда (volume)
└── dump.sql.gz          # дамп БД от миграции с Render (2026-09-02, 56 МБ)
```

### Ключевые особенности

- **Redis отсутствует** — в коде не используется (только в package.json).
- **Секреты свои**: `DB_PASSWORD`, `JWT_SECRET`, `CRON_SECRET_KEY`, `ENCRYPTION_KEY`
  сгенерированы отдельно от Render. ⚠️ Перегенерация JWT_SECRET инвалидирует все
  сессии, ENCRYPTION_KEY делает нечитаемыми сохранённые broker-ключи. Не менять.
- **Остальные ключи сервисов** (KIMI, YooKassa, Telegram, Finnhub, Finam, Firebase,
  VAPID, Resend, Serper, Yandex Search) — те же значения, что у pulse-api на Render
  (источник — Render API). Доставлены на VPS 2026-09-09 (бэкапы: `.env.bak-20260909`,
  `docker-compose.yml.bak-20260909`).
- ⚠️ **Ключ в .env ≠ ключ в контейнере**: docker-compose.yml передаёт переменные
  явным списком в `environment:`. Новый ключ в .env без правки compose контейнеру
  не виден. Проверено 2026-09-09: имена синхронизированы с кодом (Firebase —
  `FIREBASE_SERVICE_ACCOUNT_BASE64`, НЕ `..._BASE`).
- ⚠️ **YuKassa webhook**: автопостановка требует OAuth-токена (его нет) — webhook
  добавляется вручную в кабинете ЮKassa: `https://pulse.inside-trade.ru/api/webhook/yookassa`.
  Проверить, что старая точка на Render отключена — иначе уведомления об оплатах
  продолжат уходить на Render-бэкенд.
- **Сессии Render↔VPS несовместимы** (разные JWT_SECRET + разные домены) —
  пользователь логинится заново, пароль тот же (хэши мигрированы).
- **YooKassa**: при пустых `YOOKASSA_SHOP_ID`/`YOOKASSA_SECRET_KEY` код работает
  в ДЕМО-режиме (`demo: true`, фейковый /payment/return?demo=1). Реальные платежи
  включаются постановкой ключей. Боевые ключи доставлены на VPS 2026-09-09 —
  см. замечание про webhook выше. На Render ключи остаются (там своя копия).
- **Крон в процессе бэкенда → всегда ровно 1 инстанс backend.**
- **БД — снапшот Render на 2026-09-02.** Новые регистрации/действия пользователей
  на Render после этой даты на VPS не попали. Репликации нет (Render managed PG
  не даёт прав на logical replication) — только повторные дампы.
- **Бэкапы ручные** (на Render делала платформа):
  `docker exec pulse-postgres pg_dump -U pulse_user pulse | gzip > backup-$(date +%F).sql.gz`
- **root по паролю** — перевести на SSH-ключи, отключить password auth (задача открыта).

### ТЗ-91 (2026-09-10): семантические эмбеддинги новостей — фактическое состояние

- ⚠️ **Боевой compose — `/opt/pulse/docker-compose.yml`, НЕ клон в `/opt/pulse/pulse`.**
  Compose в git-клоне — упрощённый вариант (с redis, без caddy, без полного списка
  секретов). Оба файла дают проекту имя `pulse` (имя каталога), поэтому команды
  из клона управляют теми же контейнерами, но с ДРУГИМ конфигом (mount БД, env,
  лимиты). Любые операции на проде — только `cd /opt/pulse && docker compose ...`.
  Бэкап боевого compose: `/opt/pulse/docker-compose.yml.bak-tz91`.
- **Postgres: `pgvector/pgvector:pg18`** (ТЗ-91, задача 2; в ТЗ было pg16 — фактический
  кластер 18.6, мажорная версия образа обязана совпадать с кластером).
  ⚠️ **`PGDATA: /var/lib/postgresql/18/docker` задан явно** — кластер лежит в подкаталоге
  volume `pulse_postgres_data` (mount у боевого compose: `/var/lib/postgresql`,
  у клона был `/var/lib/postgresql/data` — путаница mount'ов чуть не привела к
  инициализации пустого кластера). Без явного PGDATA контейнер падает с
  «initdb: directory exists but is not empty» или молча поднимает пустую БД.
  Миграция `src/migrations/news_embeddings_v1.sql` применена (vector, embedding,
  clusters, cluster_items). Бэкап до: `/opt/pulse/pulse/backup_pre_tz91.sql` (228 МБ).
- **Сервис `embeddings`** (TEI + Qwen3-Embedding-0.6B, dim 1024): образ закреплён
  по digest (`cpu-1.9@sha256:ad950d30…`), лимиты 3G RAM / 1 CPU, порт наружу не
  опубликован, бекенд ходит по `http://embeddings:80`.
  ⚠️ **Отклонение от ТЗ:** `--max-batch-tokens 4096` вместо 16384 — значение из ТЗ
  требует ~16 ГБ RAM при warmup-аллокации и на 4 ГБ контейнер падает
  («memory allocation of 17179869184 bytes failed»). 4096 проверено, RSS ~2,4 ГБ.
  Бэкфилл (`src/scripts/backfillEmbeddings.ts`) шлёт батчи по 16 текстов
  (~≤4k токенов), а не 32.
- ⚠️ **Прогрев TEI на этом VDS занимает 15–20 мин** (машина впритык по RAM,
  ~3 ГБ уходят в swap — по ТЗ v1.3 это осознанный trade-off). Healthcheck становится
  healthy только после прогрева; первый /embed после старта медленный. При рестарте
  контейнера закладывать это время.
- **factCheck:** OpenAI/Kimi-клиент создаётся лениво — без `KIMI_API_KEY` бекенд
  не падает при старте (fix 2026-09-10, c44c5df). Раньше модуль валил весь бекенд
  на VPS при пересборке.
- **Ночной бэкфилл (задача 5 ТЗ-91) намеренно НЕ запущен.** Команда (в часы
  минимальной нагрузки, МСК): `docker exec pulse-backend npx ts-node --transpile-only
  src/scripts/backfillEmbeddings.ts` — скрипт резюмируемый, прогресс каждые 500.
  После бэкфилла: HNSW-индекс (задача 6), импорт каскадов
  (`importCascadeSnapshot.ts`, ждём `cascade_import.json` от владельца), выгрузка
  `dumpCalibrationPairs.ts` → `calibration_pairs.csv`.
- Swap: `/swapfile` 2G + `/swapfile2` 2G (fstab, pri=-2), итого 4G.

### Операции

```bash
ssh root@155.212.216.142 && cd /opt/pulse

docker compose ps                              # статус
docker logs pulse-backend --tail 100 -f        # логи
docker compose restart backend                 # рестарт
```

### Обновление версии (процедура v2, проверена 2026-09-10)

> ⚠️ В отличие от Render, push в `main` **сам VPS не обновляет** — выкатка только вручную
> по этой процедуре. Push обновляет лишь Render-контур (и git-клон на VPS при `git pull`).
>
> Локальные грабли, которые эта версия процедуры закрывает (все пойманы на практике):
> - на macOS нет `sshpass` → доступ только через expect-хелперы (ниже);
> - в `.vps-credentials` значение `VPS_PASSWORD` в кавычках — хелперы их снимают,
>   ручной парсинг «как есть» даёт Permission denied;
> - `scp` сохраняет **basename** локального файла — имя архива на сервере = локальному,
>   поэтому имя фиксируем `dist.tar.gz` и никуда его не «переименовываем»;
> - `tar` из macOS пишет xattr-заголовки (`LIBARCHIVE.xattr…` warnings на сервере) —
>   безвредно, но лечится `COPYFILE_DISABLE=1`;
> - backend мог уже быть актуален — сначала проверка `git log HEAD..origin/main`,
>   пустая = пересборка НЕ нужна (экономия 5–10 мин на 1 vCPU).

#### 0. Доступ с локальной машины (macOS)

В корне рабочей директории лежат хелперы (локально, НЕ в git):

```bash
.kimi/vps-ssh.exp "<одна shell-команда для сервера>"   # пароль берёт из .vps-credentials
.kimi/vps-scp.exp <local-file> <remote-path>           # то же для копирования
```

Оба парсят `VPS_HOST` / `VPS_USER` / `VPS_PASSWORD` из `.vps-credentials`
(обрамляющие кавычки снимаются), пароль в вывод и history не попадает.
Проверка доступа: `.kimi/vps-ssh.exp "hostname && docker compose -f /opt/pulse/docker-compose.yml ps"`.

#### 1. Бэкап БД — обязательно перед любыми изменениями

```bash
.kimi/vps-ssh.exp "docker exec pulse-postgres pg_dump -U pulse_user pulse | gzip > /opt/pulse/backup-\$(date +%F).sql.gz && ls -la /opt/pulse/backup-*.sql.gz | tail -1"
```

#### 2. Backend — только если есть новые коммиты

```bash
# Проверка отставания (fetch + сколько коммитов позади):
.kimi/vps-ssh.exp "cd /opt/pulse/pulse && git fetch origin && git status -sb && git log --oneline HEAD..origin/main | head -20"

# Если список пуст — backend актуален, ШАГИ 3–4 ПРОПУСТИТЬ.
# Иначе (~5-10 мин на 1 vCPU):
.kimi/vps-ssh.exp "cd /opt/pulse/pulse && git pull"
.kimi/vps-ssh.exp "cd /opt/pulse && docker compose up -d --build backend"
.kimi/vps-ssh.exp "docker logs pulse-backend --tail 30"   # старт и миграции без ошибок
```

#### 3. Frontend — собирается НЕ на сервере (1 ГБ RAM не тянет сборку)

```bash
cd pulse-frontend
# 3.1. Пропатчить API URL на VPS-домен в 4 файлах (одной командой):
sed -i '' 's/pulse-api-bsov\.onrender\.com/pulse.inside-trade.ru/g' \
  src/lib/api.ts src/pages/DownloadPage.tsx src/hooks/useSseNews.ts src/components/SentimentChartCard.tsx
# (.env.production уже содержит VITE_FRONTEND_URL=https://pulse.inside-trade.ru — проверить)

# 3.2. Собрать и упаковать (COPYFILE_DISABLE убирает macOS-xattr из tar):
npm run build && COPYFILE_DISABLE=1 tar czf dist.tar.gz -C dist .

# 3.3. ОТКАТИТЬ ПАТЧ ЛОКАЛЬНО — иначе Render-контур соберётся с VPS-доменом:
git checkout -- src/lib/api.ts src/pages/DownloadPage.tsx src/hooks/useSseNews.ts src/components/SentimentChartCard.tsx
git status --short   # должно быть пусто

# 3.4. Залить (scp сохранит имя dist.tar.gz):
.kimi/vps-scp.exp dist.tar.gz /opt/pulse/
rm dist.tar.gz

# 3.5. Распаковать на сервере (именно /* — НЕ удалять сам каталог, bind-mount caddy):
.kimi/vps-ssh.exp "rm -rf /opt/pulse/frontend/dist/* && tar xzf /opt/pulse/dist.tar.gz -C /opt/pulse/frontend/dist && rm /opt/pulse/dist.tar.gz && du -sh /opt/pulse/frontend/dist"
# (если каталог dist всё же пересоздавался — bind-mount теряет inode,
#  лечится: docker compose up -d --force-recreate caddy)
```

#### 4. Проверка после выкатки (с локальной машины)

```bash
# 4.1. Прод отдаёт свежий билд — хэш главного чанка совпал с локальным dist:
LOCAL=$(grep -o 'assets/index-[^"]*\.js' dist/index.html | head -1)
REMOTE=$(curl -s https://pulse.inside-trade.ru/ | grep -o 'assets/index-[^"]*\.js' | head -1)
[ "$LOCAL" = "$REMOTE" ] && echo OK || echo "MISMATCH — на проде старый билд"

# 4.2. В JS зашит VPS-домен, onrender отсутствует:
curl -s "https://pulse.inside-trade.ru/$REMOTE" | grep -c "pulse.inside-trade.ru/api"   # > 0
curl -s "https://pulse.inside-trade.ru/$REMOTE" | grep -c "pulse-api-bsov.onrender.com" # 0

# 4.3. Backend жив через caddy:
curl -s https://pulse.inside-trade.ru/api/health   # {"ok":true,...}
```

### Восстановление БД из бэкапа

Бэкапы — plain-SQL дампы: `/opt/pulse/backup-*.sql.gz`. Восстановление = 2-3 минуты простоя.

```bash
cd /opt/pulse

# 1. Остановить бэкенд (чтобы не писал в базу во время восстановления)
docker compose stop backend

# 2. Пересоздать базу (чистая, пустая)
docker exec pulse-postgres psql -U pulse_user -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='pulse' AND pid <> pg_backend_pid();"
docker exec pulse-postgres dropdb -U pulse_user pulse
docker exec pulse-postgres createdb -U pulse_user -O pulse_user pulse

# 3. Залить дамп (укажите нужный файл)
zcat backup-2026-09-05.sql.gz | docker exec -i pulse-postgres psql -U pulse_user -d pulse -q

# 4. Контроль: таблицы и счётчики на месте?
docker exec pulse-postgres psql -U pulse_user -d pulse \
  -tc "select count(*) from information_schema.tables where table_schema='public';
       select count(*) from news; select count(*) from users;"

# 5. Запустить бэкенд (схема применится идемпотентно поверх дампа)
docker compose start backend
docker logs pulse-backend --tail 20
```

⚠️ Восстанавливать только в пересозданную (пустую) базу — заливка дампа
поверх живой базы даст конфликты `duplicate key` / `already exists`.

### Откат версии

Если обновление сломало прод:

```bash
# 1. Найти последний рабочий коммит
cd /opt/pulse/pulse && git log --oneline -10

# 2. Откатить код (пример: на один коммит назад)
git reset --hard origin/main~1        # или конкретный sha: git reset --hard 9f2aead

# 3. Пересобрать и перезапустить (~5-10 мин)
cd /opt/pulse && docker compose up -d --build backend

# 4. Frontend при необходимости: в клоне pulse-frontend сделать
#    git reset --hard <тот же/совместимый sha>, пропатчить API URL,
#    собрать и залить dist (см. «Обновление версии», шаг 2)

# 5. Когда разобрались с причиной — вернуться на актуальную main:
cd /opt/pulse/pulse && git reset --hard origin/main
```

⚠️ Если сломанное обновление успело поменять схему/данные в БД —
сначала восстановите предобновочный бэкап (раздел выше), потом откатывайте код.
Именно поэтому шаг 0 «Бэкап перед обновлением» обязателен.

### Если кончилось место на диске (ENOSPC при сборке)

Диск 8,6 ГБ — впритык. Симптом: сборка падает на `npm install` с ENOSPC.
Чистка (безопасно, освобождает ~1 ГБ):

```bash
docker image prune -af      # неиспользуемые образы (старые postgres и пр.)
docker builder prune -af    # кэш сборок
rm -f /opt/pulse/dump.sql.gz /opt/pulse/*.log   # старые дампы/логи (бэкап БД не трогать!)
df -h /                     # проверить
```

При регулярных обновлениях — расширить диск у хостера до 20+ ГБ.

### Ограничения среды

- 1 vCPU / 1 ГБ RAM: для прода под нагрузкой апгрейдить до 2+ ГБ.
- Диск 8,6 ГБ — впритык: БД ~300 МБ + образы Docker ~1 ГБ + бэкапы.
  При ENOSPC — см. «Если кончилось место на диске». Рекомендуется 20+ ГБ.
- API_BASE фронта захардкожен в 4 файлах (`src/lib/api.ts`, `DownloadPage.tsx`,
  `useSseNews.ts`, `SentimentChartCard.tsx`) — смена домена = правка + пересборка.
- Без боевых ключей молча отключены: LLM (перевод/сентимент/фактчек), Telegram,
  платежи (демо), пуши.

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
