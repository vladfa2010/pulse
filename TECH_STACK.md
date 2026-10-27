# PULSE — Tech Stack

> Единый паспорт технологического стека платформы. Дата сверки: 2026-10-27.
> Источники факта: `package.json` бэкенда и фронтенда, `DEPLOYMENT.md`, `docs/market-data.md`.
> Правило: версии здесь — факт из package.json; при обновлении зависимостей обновлять этот файл в том же коммите.

---

## 1. Бэкенд (`pulse-backend`)

### Рантайм и каркас

| Компонент | Технология | Где |
|-----------|-----------|-----|
| Runtime | Node.js 20 | `DEPLOYMENT.md` §Архитектура |
| Язык | TypeScript 5.9 | `tsconfig`, devDeps |
| Фреймворк | Express 4 | `src/index.ts` |
| Процессы | один Node-процесс, `node-cron` внутри | `workers.ts`, `globalSummary.ts` |

### Данные

| Компонент | Технология | Примечание |
|-----------|-----------|------------|
| Основная БД (prod) | PostgreSQL 18 + **pgvector** | VPS docker, `PGDATA=/var/lib/postgresql/18/docker`; standby — managed PG на Render |
| Dev-БД | SQLite через `sql.js` (WASM) | `USE_SQLITE=true`, dual-mode в `src/config/db.ts` |
| Драйвер | `pg` 8 | |
| Миграции | SQL-файлы `src/migrations/`, регистрация в db-init | конвенция `nowSql()` для PG/SQLite-совместимости |
| Redis | `redis` 4 в зависимостях | **в `src/` не используется** (grep 2026-10-27) — остаток compose-окружения, кандидат на вычистку |
| Файлы | LMS-ассеты/MP3 на VPS volume | `DEPLOYMENT.md`; S3 — не внедрено |

### Ключевые зависимости по доменам

| Домен | Пакеты | Комментарий |
|-------|--------|-------------|
| Auth | `bcrypt` 5, `jsonwebtoken` 9 | JWT + свежий `is_blocked` (конвенция ТЗ-120) |
| Защита | `express-rate-limit` 7 (`apiLimiter` и бакеты), `sanitize-html` 2, `zod` 3 + `zod4` | две мажорные линии zod — легаси/новое |
| HTTP | `axios` 1, `form-data` 4, нативный `http2` | http2 — только `GET /v1/assets` Finam (детерминированный 500 по HTTP/1.1) |
| LLM | `openai` 6 (HTTP-клиент к Kimi API), прямые `axios`-вызовы `api.moonshot.ai` | конвенция: клиент не создаётся без `KIMI_API_KEY` (`factCheck.ts`) |
| MCP | `@modelcontextprotocol/server` 2.3, `/express` 2.0, `/node` 2.1 | ТЗ-183, эндпоинт `/mcp` |
| Уведомления | `firebase-admin` 14 (FCM), `web-push` 3 (VAPID), Telegram Bot API (axios) | `PUSH_NOTIFICATIONS.md`, `TELEGRAM_NOTIFICATIONS.md` |
| Email | Resend API (axios) | `EMAIL_PROVIDER=resend`, `docs/` см. `email.ts` |
| Платежи | ЮKassa (HTTP API) | `PAYMENTS.md` |
| Маркет-данные | собственный адаптер Finam Trade API | `docs/market-data.md`, ТЗ-3.x, ТЗ-197 |
| Рендер PNG | `sharp` 0.35 | SVG→PNG для weekly-инфографики (ТЗ-184) |
| RSS/разбор | `fast-xml-parser` 5, `yaml` 2, `markdown-it` 14, `turndown` 7 (+gfm) | ingest и LMS-контент |
| Крон | `node-cron` 3 | распределённые локи через `cron_locks` (ТЗ-50) |
| Uploads | `multer` 1 | LMS-файлы |
| Типы файлов | `file-type` 16 | валидация uploads |

### Тестирование бэкенда

| Что | Инструмент |
|-----|-----------|
| Unit/интеграционные | **отсутствуют** — покрытие скриптами smoke: `src/scripts/testFinamMarket.ts`, boot-логи, `cron_log` |
| Типизация | `tsc` (build-этап), `@types/*` |

---

## 2. Фронтенд (`pulse-frontend`)

| Слой | Технология | Примечание |
|------|-----------|------------|
| Фреймворк | React 19 + TypeScript 5.7 | |
| Сборка | Vite 6 | `@vitejs/plugin-react` 4 |
| Стили | Tailwind CSS 3.4 + shadcn/ui-паттерны | `tailwind-merge`, `clsx`, `class-variance-authority`; токены в `index.css` |
| Роутинг | `react-router` 7 (HashRouter) | `App.tsx` |
| Анимации | Framer Motion 12 | easeOutExpo-конвенция DESIGN_SPEC §2.3 |
| Иконки | Lucide React 0.468 | |
| Графики | **ECharts 6** (свечи/каскады/отчёты), Recharts 2 | ECharts — основной; Recharts — вторичный |
| Серверное состояние | `@tanstack/react-query` 5 | |
| Push | Firebase 11 (web SDK) + Capacitor push | |
| SEO | `react-helmet-async` 3 | |
| LMS-редактор | TipTap 3 (starter-kit, table, image, prosemirror) | уроки/курсы |
| 3D | `@react-three/fiber` 9 + `three` 0.186 | точечно (анимации главной) |
| Мелочи | `canvas-confetti` | геймификация |

### Тестирование фронтенда

| Что | Инструмент |
|-----|-----------|
| Unit | Vitest 2 + jsdom 30 + Testing Library 16 |
| E2E | Playwright 1.62 (`@playwright/test`) |
| Скрипты | `tsx` 4 | |

---

## 3. Мобильное приложение

| Компонент | Технология |
|-----------|-----------|
| Подход | Capacitor 8 (обёртка над веб-фронтендом) | 
| Платформа | Android (`android/`, Gradle-сборка) |
| Плагины | `@capacitor/core`, `app`, `browser`, `preferences`, `push-notifications`, `share`; assets/cli |
| Дистрибуция | `/download` страница (APK) | `DEPLOYMENT.md`, `DownloadPage.tsx` |

---

## 4. ML / семантический контур

| Компонент | Технология | Где |
|-----------|-----------|-----|
| Эмбеддер | **TEI** (Text Embeddings Inference) + **Qwen3-Embedding-0.6B** (dim 1024) | VPS docker, порт наружу не опубликован; `http://embeddings:80` |
| Векторный индекс | pgvector (HNSW, `news_embedding_hnsw` ~514 МБ) | `docs/embeddings.md`, миграция `news_embedding_hnsw.sql` |
| Семантический поиск | свой слой поверх TEI + pgvector, таймаут 15 с env-overridable | `SEMANTIC_SEARCH_TIMEOUT_MS` |
| Сантимент новостей | классификация на ingest (поле `news.sentiment`) | без LLM в рантайме отчётов |
| Каскады/сюжеты/темы | кластеризация эмбеддингов (realtime + ночной HDBSCAN) | ТЗ-92/97/115, `DEPLOYMENT.md` |

---

## 5. Внешние сервисы

| Сервис | Назначение | Ключ в env |
|--------|-----------|------------|
| Finam Trade API | свечи D/M5, quotes, справочники | `FINAM_MARKET_SECRET` (сервисный) |
| Moonshot AI (Kimi) | LLM: сентимент-фолбэк, фактчек, саммари, MCP-ассист | `KIMI_API_KEY`, `KIMI_MODEL` |
| Telegram Bot API | дайджесты, отчёты, алерты | bot token |
| Resend | email | `RESEND_API_KEY`, `EMAIL_FROM` |
| Firebase | FCM push (admin SDK), web push | `FIREBASE_SERVICE_ACCOUNT_*` |
| ЮKassa | платежи | `YOOKASSA_*` |
| tgparser (Render) | RSS-фиды телеграм-каналов | отдельный сервис `tgparser-web.onrender.com` |

---

## 6. Инфраструктура

| Слой | Технология |
|------|-----------|
| Primary | VPS 155.212.216.142: Docker Compose — Caddy (HTTPS, статика, прокси), pulse-backend, PostgreSQL 18, TEI |
| Второй контур | Render: `pulse-api` (Web Service, Docker, автодеплой из main), `pulse-frontend` (Static Site), managed PG (standby) |
| Бэкапы | `scripts/maintenance/backup-nightly.sh` (VPS-primary) |
| Прод-домен | `pulse.inside-trade.ru` → VPS; tgparser и MCP — см. `DEPLOYMENT.md` |

---

## 7. Расхождения (известные устаревшие места)

| Файл | Что устарело |
|------|-------------|
| `README.md` §Tech Stack | нет: sharp, pgvector, TEI, MCP, Resend/FCM/web-push, http2; указан Redis без пояснения |
| `DESIGN_SPEC.md` §1.1 | нет: ECharts, React Query, Capacitor, TipTap, R3F; «localStorage как client-side DB» — легаси-формулировка |
| `package.json` | `redis` — не используется в `src/`, кандидат на удаление |

Правило обновления: меняешь зависимость → правишь этот файл тем же коммитом.

## Связанные доки

`DEPLOYMENT.md` (инфра, операции) · `docs/market-data.md` (Finam) · `docs/embeddings.md` (TEI/pgvector) · `PUSH_NOTIFICATIONS.md` / `TELEGRAM_NOTIFICATIONS.md` · `PAYMENTS.md` · `DESIGN_SPEC.md` §2 (дизайн-токены) · `PROJECT_CONTEXT.md` (продукт).
