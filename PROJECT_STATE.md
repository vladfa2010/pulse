# PULSE — Project State (Session Resume)

> **Файл для быстрого входа в контекст после сброса.**
> **Дата обновления:** 2026-05-29
> **Версия API:** 7.9
> **Актуальные коммиты:** backend `e74f0a5`, frontend `c384967` (v7.9.1)
> **Finam RSS:** 7 лент активны
> **Transaq Connector:** v1.0.0 — отдельный сервис (нужен VPS)
> **Transaq Connector:** v1.0.0 — отдельный сервис реал-тайм новостей Finam (нужен VPS)

---

## 1. Что такое PULSE

Агрегатор инвестиционных новостей на русском языке. 3 карусели новостей на главной. RSS из 36 источников (включая 7 лент Финам) → перевод EN→RU → sentiment analysis → smart tag matching → PostgreSQL → React frontend.

**URL:** https://pulse-frontend-jt53.onrender.com
**API:** https://pulse-api-bsov.onrender.com

---

## 2. Техстек

| Слой | Технологии |
|------|-----------|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v3.4 |
| Анимации | Framer Motion, CSS keyframes |
| Кэш | React Query (@tanstack/react-query) — optimistic updates |
| Backend | Node.js 20, Express, TypeScript |
| БД | PostgreSQL (Render production) / SQLite (local) |
| LLM API | Kimi API (api.moonshot.ai) — перевод, sentiment, tags, summary |
| RSS | 36 источников (17 RU + 19 EN), batch по 4, cron каждые 5 мин |
| Auth | JWT + bcryptjs, cookie-based sessions |
| Telegram Bot | @Insidepulse_bot — webhook, HMAC-secured linking |
| Payments | YooKassa (REAL + DEMO), triple activation |

---

## 3. Архитектура — 3 карусели

| # | Название | Фильтр | Для кого | Компонент |
|---|----------|--------|----------|-----------|
| 1 | **"Это вы ещё не видели"** | matched_tags && user_tags, НЕ прочитанные | Залогиненным | UnreadNewsCarousel.tsx |
| 2 | **"Вся лента"** | matched_tags && user_tags, прочитанные (DESC) | Залогиненным | AllNewsCarousel.tsx |
| 3 | **"Общая лента"** | Без фильтра тегов, все новости | Всем | GlobalNewsCarousel.tsx |

### Доставка новостей

**Раньше:** Только polling (React Query refetch interval) → новости видны после F5 или таймаута  
**Сейчас:** SSE (Server-Sent Events) + React Query → новости **мгновенно** после парсинга cron

```
Cron (каждые 5 мин) → RSS fetch → translate → sentiment → save to DB
                                                              ↓
                                                    broadcastNews() — SSE
                                                              ↓
                                                    Browser (EventSource)
                                                              ↓
                                                    React Query cache обновляется
                                                              ↓
                                                    Новость появляется на экране
```

**Почему "новости час назад":** `published_at` = время публикации на источнике, не время парсинга. Источники сами публикуют с задержкой. SSE доставляет мгновенно, но время события — от источника.

---

## 4. Главные архитектурные решения (ВАЖНО)

| # | Решение | Почему |
|---|---------|--------|
| 1 | **Нет хардкод тегов** (удалены TAG_KEYWORDS + RELATED_TAGS) | Каждый пользователь создаёт теги сам |
| 2 | **Related tags через LLM** (динамические связи) | Нет хардкода, адаптируется под набор тегов |
| 3 | **Free = 1 тег** | Бизнес-правило |
| 4 | **Пользователь создаёт первый тег сам** | Нет forced suggestions, нет демо-портфеля |
| 5 | **LLM определяет тип тега** (auto-detect) | 8 типов: company, ticker, sector, trend, person, commodity, index, currency |
| 6 | **Tag Enrichment через LLM** | Один запрос при создании → synonyms + ticker + products + related entities |
| 7 | **Метод 2 (LLM) ТОЛЬКО если Layer 1 пустой** | ~60% экономия токенов (оптимизация B) |
| 8 | **SSE Real-Time News** | Мгновенная доставка новостей в браузер |
| 9 | **Demo-режим удалён** | Нет демо-логина, нет демо-портфеля |

---

## 5. Smart Tag Matching — 3 слоя

### Flow:
```
Новость (title + summary)
  ├──> Layer 1: Keyword matching (enriched keywords, ~50+ на тег)
  │     └── Быстро, локально, < 1 мс, покрывает ~85-90%
  ├──> Layer 2: LLM Smart Matching (ТОЛЬКО если Layer 1 пустой)
  │     └── Fallback: семантический анализ, ~10-15% случаев
  └──> Layer 3: LLM Related Tags (динамические связи через LLM)
        └── Кэш 5 минут
```

### Tag Enrichment (v7.5) — ОДИН запрос при создании тега:

При создании тега `enrichTagViaLLM()` делает **один** LLM-запрос и получает:

| Поле | Пример | Зачем |
|------|--------|-------|
| `tag_type` | `company` | Тип тега |
| `ticker` | `NVDA` | Биржевой тикер |
| `related_entities` | `["AMD", "Intel", "TSMC"]` | Связанные компании |
| `synonyms_en` | `["nvidia corp", "gpu maker"]` | Английские синонимы |
| `synonyms_ru` | `["нвидиа", "енвидиа"]` | Русские синонимы |
| `key_products` | `["geforce", "rtx", "cuda"]` | Ключевые продукты |

**Результат:** `buildEnrichedKeywords()` объединяет base keywords + LLM synonyms → **~50+ keywords на тег** (было ~8).

**Сохранение:** `user_defined_tags.enriched_data` (JSONB).

**Экономия:** Layer 1 теперь ловит 85-90% новостей → Layer 2 редко нужен.

### Tag Types (Auto-Detection via LLM):
| Тип | Примеры |
|-----|---------|
| `company` | Apple, Tesla, Сбербанк |
| `ticker` | AAPL, TSLA, SBER |
| `sector` | Технологии, Фарма, Энергетика |
| `trend` | AI, Крипто, ESG |
| `person` | Илон Маск, Пауэлл |
| `commodity` | Золото, Нефть, Медь |
| `index` | S&P 500, NASDAQ, MOEX |
| `currency` | USD, EUR, BTC |

**Endpoint:** `GET /api/user/tags/detect-type?tagName=X`
**Fallback:** heuristicTagType() (регулярки) если LLM недоступен

### SSE Real-Time News (v7.7) — Мгновенная доставка

```
Cron парсит RSS → сохраняет в БД → broadcastNews() → SSE → Browser
                                                              ↓
                                                    React Query cache обновляется
                                                              ↓
                                                    Новость появляется на экране БЕЗ F5
```

| Компонент | Файл |
|-----------|------|
| **SSE Service** | `backend/src/services/sse.ts` — subscribers Set + broadcast |
| **SSE Endpoint** | `GET /api/news/stream` — EventSource connection |
| **Broadcast trigger** | `cron.ts` — после каждого INSERT новой новости |
| **Frontend hook** | `frontend/src/hooks/useSseNews.ts` — EventSource + React Query |
| **Integration** | `Home.tsx` — `useSseNews(isLoggedIn)` |

**Heartbeat:** каждые 30 секунд (сервер → клиент `event: ping`)  
**Auto-reconnect:** 5 секунд после disconnect  
**Фильтр дубликатов:** на клиенте (проверка `id` перед добавлением в cache)  
**Подписчиков:** `sse_subscribers` в `/health`

---

## 6. Тег — это не категория

| У вас тег | Новость | Попадет? |
|-----------|---------|----------|
| `sber` | "Сбербанк повысил ставки" | ✅ ДА |
| `sber` | "ВТБ запустил новый продукт" | ❌ НЕТ |
| `bank` | "ВТБ повысил ставки" | ✅ ДА |
| `bank` | "Сбербанк отчитался" | ✅ ДА |

**Правило:** Тег — точечный поисковый запрос. `sber` ≠ `bank` ≠ `finance`. Пользователь сам выбирает гранулярность.

---

## 7. Общая база vs Персональная лента

**Матчинг:** новость проверяется против ВСЕХ тегов всех пользователей
**Карусели 1+2:** только новости по ВАШИМ тегам
**Карусель 3 (общая):** все новости со всеми тегами

---

## 8. AI Daily Summary (v7.4)

**Endpoint:** `GET /api/user/summary` (auth required)
**Query params:** `?hours=12` (default), `?refresh=1` (ignore cache)

**Flow:**
1. Берёт теги пользователя из `portfolios`
2. Ищет новости: `published_at > NOW() - 12 hours`, `matched_tags && user_tags`
3. Отправляет в LLM — стиль инвестиционного аналитика, 80-150 слов, русский
4. Кэш: 10 минут на пользователя (in-memory)

**Frontend:** `DailySummary.tsx` — liquid glass карточка под "Вся лента"
**Кнопка:** "Обновить" с `?refresh=1` — игнорирует кэш, идёт в LLM

---

## 9. Страница "Инструкция" (/instructions)

**Компонент:** `frontend/src/pages/Instructions.tsx`
**URL:** `/#/instructions`
**Содержит:**
1. Тег — это не категория
2. Гранулярность: узко/средне/широко
3. Как система находит новости (Keyword + LLM)
4. Общая база vs Персональная лента
5. Практические советы

---

## 10. Sentiment + Liquid Glass ✅

| Sentiment | Цвет |
|-----------|------|
| positive | `#34D399` зелёный |
| negative | `#F87171` красный |
| neutral | `#9CA3AF` серый |

---

## 11. Дизайн профиля (Liquid Glass) ✅

Страница `/profile` полностью переписана в стиле главной страницы.

### Компоненты:

| Компонент | Описание |
|-----------|----------|
| `GlassCard` | Reusable liquid glass карточка: `backdrop-filter: blur(12px) saturate(180%)` + опциональный accent glow |
| `Toggle` | Переключатель с customizable active color (`#00D4FF`, `#F59E0B`, etc.) |

### Дизайн-элементы:

| Элемент | Реализация |
|---------|-----------|
| **Hero header** | Радиальный градиент glow + большой аватар (60×60) с градиентной рамкой |
| **Карточки** | Liquid glass: `rgba(255,255,255,0.02)` + `backdropFilter: blur(12px)` + accent color glow |
| **Табы** | Подсветка `#00D4FF` при активации, плавные переходы |
| **Переключение** | Framer Motion `AnimatePresence` — fade + slide анимация |
| **Теги** | Pills с `#00D4FF` акцентом, `Trash2` иконка для удаления |
| **Платежи** | Карточки вместо таблицы, цветные статус-бейджи |
| **Премиум бейдж** | Градиентный фон + иконка Zap рядом с именем |

### Табы:

| # | Название | Содержимое |
|---|----------|-----------|
| 1 | **Профиль** | Аватар, имя, email, Premium badge, теги (pills), выход |
| 2 | **Уведомления** | Telegram (подключение, частота, тихие часы), Email digest |
| 3 | **Тариф** | Free/Premium статус, прогресс-бар дней, список фич |
| 4 | **Платежи** | История платежей в виде карточек |

---

## 12. Telegram Bot @Insidepulse_bot ✅

| Фича | Статус |
|------|--------|
| Webhook auto-setup | ✅ |
| HMAC-secured linking | ✅ |
| Desktop fallback | ✅ |
| Premium-only access | ✅ |
| Команды: /start, /now, /stop | ✅ |

---

## 13. Платежи (YooKassa) ✅

| Фича | Статус |
|------|--------|
| DEMO режим | ✅ |
| YooKassa REAL | ✅ |
| Triple activation | ✅ |
| `refreshUser` после оплаты | ✅ |
| `subscription_active = TRUE` | ✅ |

### Баг: Premium пропадал после перезахода (v7.6.2) 🐛

**Причина:** `POST /auth/login` не возвращал `subscription_active` и `subscription_expires_at`.

**Цепочка бага:**

| Шаг | Действие | subscription.active |
|-----|----------|---------------------|
| 1 | Пользователь оплачивает | ✅ TRUE в БД |
| 2 | `refreshUser()` → `/auth/me` | ✅ true (видно) |
| 3 | Перезаход → `login()` | ❌ undefined → false |

**Исправления:**

| Файл | Что сделано |
|------|-------------|
| `auth.ts` login | SELECT добавлены `subscription_active`, `subscription_expires_at` |
| `auth.ts` login | Response включает оба subscription поля |
| `PaymentReturn.tsx` | `refreshUser()` вызывается после force-check подтверждения |

---

## 14. Mobile Layout Optimization ✅

### Проблемы

| # | Проблема | Причина |
|---|----------|---------|
| 1 | **Страница шире экрана iPhone** — можно сдвинуть влево/вправо | `NewsCard` использовал `w-[425px]` — шире iPhone (375px) |
| 2 | **Подёргивание при скролле** | Тяжёлый `backdrop-filter: blur(20px)` на каждой карточке |
| 3 | **Нет ощущения премиального сайта** | 300ms tap delay, нет GPU acceleration |

### Исправления

| Файл | Что сделано |
|------|-------------|
| `index.html` | `viewport-fit=cover`, `maximum-scale=1.0`, `user-scalable=no` для iPhone X+ |
| `index.css` | `overflow-x: hidden` на html/body, `max-width: 100vw`, `touch-action: manipulation` |
| `index.css` | `-webkit-tap-highlight-color: transparent`, `-webkit-overflow-scrolling: touch` |
| `index.css` | `@media (max-width: 768px)` — уменьшенный `backdrop-filter` blur (16px→8px, 6px→4px) |
| `index.css` | `.gpu-layer` — `will-change: transform`, `translateZ(0)`, `backface-visibility: hidden` |
| `index.css` | `.scroll-container` — `-webkit-overflow-scrolling: touch`, `overscroll-behavior-y: contain` |
| `index.css` | `@media (prefers-reduced-motion)` — отключение анимаций для accessibility |
| `Layout.tsx` | `overflow-x-hidden`, `max-w-[100vw]` на контейнере |
| `NewsCarousel.tsx` | `scroll-container` + `gpu-layer`, fade overlays скрыты на мобильных |
| `NewsCard.tsx` | **Responsive width**: `w-[85vw] sm:w-[425px]` и `w-[75vw] sm:w-[275px]` |
| `NewsCard.tsx` | `gpu-layer` для GPU acceleration анимаций |
| `Navbar.tsx` | `gpu-layer`, `env(safe-area-inset-top)` для iPhone notch |

### Результат

| До | После |
|----|-------|
| `w-[425px]` фиксировано | `w-[85vw]` на мобильном, `sm:w-[425px]` на десктопе |
| `backdrop-filter: blur(20px)` всегда | `blur(8px)` на мобильных |
| Нет GPU acceleration | `will-change: transform` + `translateZ(0)` |
| 300ms tap delay | `touch-action: manipulation` — мгновенный отклик |

---

## 15. UI: Hero padding (для залогиненных)

| Параметр | Залогинен | Без логина |
|----------|-----------|------------|
| Top padding | pt-8 (32px) | pt-24 (96px) |
| Bottom padding | pb-5 (20px) | pb-12 (48px) |
| Subtitle | ❌ скрыт | ✅ виден |

---

## 16. Крон

| Параметр | Значение |
|----------|----------|
| Интервал | Каждые 5 минут (`*/5 * * * *`) |
| Мониторинг | `cron_log` таблица + `/debug-cron` endpoint |

---

## 17. Debug endpoints

| Endpoint | Описание |
|----------|----------|
| `GET /health` | Версия API, статус, cron health |
| `GET /debug-cron` | Статус cron (last_run, articles_fetched) |
| `GET /debug-env` | Проверка env vars |
| `GET /debug-db` | Состояние БД |
| `POST /trigger-rss?secret=` | Ручной запуск RSS |
| `GET /backfill-tags?secret=` | Ретегирование статей |

**Secret:** `pulse-dev-key`

---

## 18. Где что в коде

```
backend/src/services/
  smartTagMatcher.ts   — 3-layer matching (keywords + LLM + related)
  tagManager.ts        — Tag types (8), auto-detect via LLM, keyword generation
  rssFetcher.ts        — RSS fetch (native fetch), batch processing, 25s timeout
  cron.ts              — RSS pipeline, cron monitoring, SSE broadcast
  sse.ts               — SSE subscribers + broadcastNews()
backend/src/routes/
  user.ts              — Tags CRUD, /summary, /stats, /tags/detect-type, /tags/related
  auth.ts              — Login/register (demo login УДАЛЕН)
frontend/src/components/
  DailySummary.tsx     — AI дайджест под "Вся лента"
frontend/src/hooks/
  useSseNews.ts        — EventSource connection + React Query integration
frontend/src/pages/
  Instructions.tsx     — /instructions — как работают теги
  Profile.tsx          — /profile — liquid glass дизайн, 4 таба
  Home.tsx             — Hero padding conditional (isLoggedIn), useSseNews()
transaq-connector/src/
  index.ts             — Entry point, wiring компонентов
  connector.ts         — DLL wrapper (ffi-napi) + XML коммуникация
  connectionManager.ts — State machine + авто-реконнект
  newsProcessor.ts     — Парсинг news_header/body + нормализация
  pulseClient.ts       — HTTP push в PULSE (batch + circuit breaker)
```

---

## 19. Git репозитории

| Репо | URL | Локально |
|------|-----|----------|
| Backend | https://github.com/vladfa2010/pulse | `/mnt/agents/projects/backend` |
| Frontend | https://github.com/vladfa2010/pulse-frontend | `/mnt/agents/projects/frontend` |
| Transaq Connector | (входит в backend репо) | `/mnt/agents/projects/transaq-connector` |

**Push:** `GIT_HTTP_LOW_SPEED_TIME=300 git push origin main`
**При GnuTLS error:** повторить через 3 секунды

---

## 20. Ключевые договорённости

1. **ТОЛЬКО реальные новости** из RSS — мок-данные ЗАПРЕЩЕНЫ
2. **Kimi API endpoint:** `api.moonshot.ai` — .cn возвращает 401
3. **Optimistic updates** — UI мгновенно, API в фоне
4. **Explicit read only** — скролл НЕ считает прочитанным
5. **Liquid glass UI** — все карточки с sentiment-цветами
6. **Нет хардкод тегов** — только пользовательские
7. **Free = 1 тег** — Premium = 10 тегов
8. **Demo login УДАЛЕН** — нет демо-режима
9. **Tag Enrichment через LLM** — один запрос при создании → synonyms + products + entities
10. **Layer 2 (LLM) ТОЛЬКО если Layer 1 пустой** — ~60% экономия токенов
11. **Tag type auto-detect** — 8 типов через LLM
12. **SSE Real-Time News** — новости мгновенно в браузер после парсинга
13. **Transaq News Connector** — отдельный Docker-сервис для реал-тайм новостей Finam (нужен VPS)
14. **Finam RSS — 7 лент** добавлены в общий поток (v7.8) — работает на Render
15. **Stats widget в Profile** — показывает объём информации (v7.9)
16. **Transaq Connector Service v1.0.0** — отдельный сервис реал-тайм новостей
17. **Каждое изменение = git commit + push + deploy**

---

## 21. Stats Widget в Profile (v7.9) ✅

**Endpoint:** `GET /api/user/stats` (auth required)

**Показывает в личном кабинете:**

| Метрика | Описание |
|---------|----------|
| **Всего новостей** | Общее количество в базе (например, 5,560) |
| **По вашим тегам** | Сколько новостей подходят под теги пользователя |
| **+ за 24ч** | Сколько новых за сутки всего |
| **+ по тегам за 24ч** | Сколько новых по тегам за сутки |

**Дизайн:** Liquid Glass карточка с зелёным акцентом (`#10B981`), 4 цифры в сетке 2×2.

**Файлы:**
- Backend: `backend/src/routes/user.ts` — `/stats` endpoint
- Frontend: `frontend/src/pages/Profile.tsx` — StatsCard в табе Profile

---

## 22. Finam RSS Feeds (v7.8) ✅

**Проблема:** Transaq Connector требует DLL + Wine → не работает на Render.
**Решение:** Использовать открытые RSS-ленты Финам (7 штук), которые парсятся существующим cron.

| # | Название | URL | Категория |
|---|----------|-----|-----------|
| 1 | **Новости компаний** | `finam.ru/analysis/conews/rsspoint/` | finance |
| 2 | **Новости и комментарии** | `finam.ru/analysis/nslent/rsspoint/` | finance |
| 3 | **Сценарии и прогнозы** | `finam.ru/analysis/forecasts/rsspoint/` | finance |
| 4 | **Мировые рынки** | `finam.ru/international/advanced/rsspoint/` | finance |
| 5 | **Обзор и идеи** | `finam.ru/analytics/rsspoint/` | finance |
| 6 | **Облигации — Новости** | `finam.ru/bonds-news/rsspoint/` | finance |
| 7 | **Облигации — Комментарии** | `finam.ru/bonds-comments/rsspoint/` | finance |

**Преимущества:**
- Работает на Render прямо сейчас (обычный HTTP RSS)
- Русский язык — не нужен перевод
- Инвестиционная аналитика высокого качества
- Тикеры в заголовках (легкий tag matching)
- Полный текст через `<description>` + ссылка на полную статью

**Файл:** `backend/src/services/rssSources.ts` — добавлены 7 источников в `RSS_SOURCES[]`

---

## 23. SSE Real-Time News (v7.7) ✅

### Архитектура

```
Cron (каждые 5 мин) → RSS fetch → translate → sentiment → save to DB
                                                              ↓
                                                    broadcastNews() — SSE
                                                              ↓
                                                    Browser (EventSource)
                                                              ↓
                                                    React Query cache обновляется
                                                              ↓
                                                    Новость появляется на экране БЕЗ F5
```

### Почему SSE (не WebSocket)

| SSE | WebSocket |
|-----|-----------|
| Однонаправленный (server → browser) | Двунаправленный |
| Работает через HTTP | Нужен upgrade протокола |
| Auto-reconnect встроен в браузер | Ручная реализация |
| Проще в реализации | Сложнее |

### Компоненты

| Компонент | Файл | Роль |
|-----------|------|------|
| **SSE Service** | `backend/src/services/sse.ts` | Subscribers Set + broadcastNews() |
| **SSE Endpoint** | `GET /api/news/stream` | EventSource connection, heartbeat 30s |
| **Broadcast trigger** | `cron.ts` — после каждого INSERT новой новости | Отправляет новость всем подписчикам |
| **Frontend hook** | `frontend/src/hooks/useSseNews.ts` | EventSource + React Query integration |
| **Integration** | `Home.tsx` — `useSseNews(isLoggedIn)` | Подключение при логине |

### Параметры

| Параметр | Значение |
|----------|----------|
| Heartbeat | 30 секунд (`event: ping`) |
| Auto-reconnect | 5 секунд после disconnect |
| Дедупликация клиента | Проверка `id` перед добавлением в cache |
| Мониторинг | `sse_subscribers` в `/health` |

### Почему "новости час назад"

`published_at` = время публикации на **источнике**, не время парсинга:

| Время | Событие |
|-------|---------|
| 14:00 | Apple отчиталась |
| 14:15 | CNN написал статью |
| 14:30 | CNN опубликовал в RSS |
| 14:31 | Наш крон спарсил |
| 14:31 | SSE доставил в браузер |

SSE доставляет **мгновенно**, но `published_at` показывает время CNN.

---

## 24. Transaq News Connector Service (v1.0.0) — Новый сервис

**Отдельная сущность** — Docker-контейнер, который подключается к Finam через `txmlconnector.dll`, получает реал-тайм новости и пушит их в бэкенд PULSE.

### Архитектура

```
Finam Servers (tr1.finam.ru:3900)
  ↓ XML over TCP (TXmlConnector DLL)
Transaq News Connector Service (Docker)
  ├─ ffi-napi → загружает txmlconnector.dll (через Wine на Linux)
  ├─ Connection Manager → авто-реконнект, health checks
  ├─ News Processor → парсинг news_header + запрос news_body
  ├─ PULSE Client → HTTP POST в бэкенд (batch + circuit breaker)
  └─ Health endpoint → GET /health (port 8080)
  ↓ HTTP POST
PULSE Backend
  ├─ Сохранение в БД (таблица news)
  ├─ Перевод EN→RU (если нужно)
  ├─ Sentiment analysis
  ├─ Smart tag matching (3 слоя)
  └─ SSE broadcast → мгновенная доставка в браузер
```

### Структура проекта

```
transaq-connector/
├── src/
│   ├── index.ts              # Entry point, wiring всех компонентов
│   ├── config.ts             # Env vars + валидация
│   ├── logger.ts             # Winston structured logging
│   ├── types.ts              # TypeScript интерфейсы
│   ├── connector.ts          # DLL wrapper (ffi-napi) + XML коммуникация
│   ├── connectionManager.ts  # Connection state machine + авто-реконнект
│   ├── newsProcessor.ts      # Парсинг + нормализация новостей
│   └── pulseClient.ts        # HTTP client → PULSE backend
├── Dockerfile                # Multi-stage build с Wine
├── docker-compose.yml        # Деплой
├── .env.example              # Шаблон конфигурации
├── package.json
└── tsconfig.json
```

### DLL API (из документации TXmlConnector 6.47.2.26.4)

| Функция | Назначение |
|---------|------------|
| `Initialize(logPath, logLevel)` | Инициализация библиотеки |
| `UnInitialize()` | Очистка перед выгрузкой |
| `SetCallback(callback)` | Callback для асинхронных сообщений от сервера |
| `SendCommand(XML)` | Отправка XML-команды |
| `FreeMemory(ptr)` | Освобождение памяти, выделенной DLL |
| `SetLogLevel(level)` | Уровень логирования |

### Поток новостей (из документации)

```
1. Connect → сервер авто-отправляет news_header (id, source, title, time_stamp)
2. Запрашиваем get_news_body по news_id
3. Сервер возвращает полный текст новости
4. Нормализуем и пушим в PULSE через HTTP POST
```

### Connection Manager — State Machine

| Состояние | Описание |
|-----------|----------|
| `disconnected` | Начальное состояние |
| `connecting` | Загрузка DLL + initialize + callback + connect |
| `connected` | Активное соединение, получаем новости |
| `reconnecting` | Потеря связи, планируем reconnect |
| `error` | Max reconnect attempts reached |

**Авто-реконнект:** configurable interval (default 10s), max attempts (0 = бесконечно)
**Health check:** каждые 30s, если нет активности → force reconnect

### PULSE Client — Circuit Breaker

| Компонент | Описание |
|-----------|----------|
| **Batch** | Накапливает до `PULSE_BATCH_SIZE` (default 10) или `PULSE_PUSH_INTERVAL_MS` (5s) |
| **Retry** | До 3 попыток с экспоненциальным backoff |
| **Circuit Breaker** | 5 failures подряд → OPEN (30s cooldown) → HALF-OPEN → CLOSED |

### Health Endpoint

```bash
curl http://localhost:8080/health
```

Возвращает JSON: status, connection state, news metrics, pulse metrics.

### DLL — 3 способа загрузки

| Способ | Когда использовать | Как |
|--------|-------------------|-----|
| **Volume mount** | Локальный Docker | `docker run -v ./dll:/app/dll` |
| **Яндекс.Диск** | Render, облако | `TRANSAQ_DLL_URL=https://disk.yandex.ru/d/WG7ysyuV9WQkrw` |
| **Прямая ссылка** | Любое хранилище | `TRANSAQ_DLL_URL=https://example.com/file.dll` |

**Яндекс.Диск** — лучший вариант для России. Скрипт `download-dll.sh` при старте:
1. Распознаёт ссылку Яндекс.Диска (по домену `disk.yandex.ru` или `yadi.sk`)
2. Вызывает API `cloud-api.yandex.net/v1/disk/public/resources/download` с `public_key`
3. Получает временную прямую ссылку (автоматически, при каждом старте — не протухает)
4. Скачивает файл, валидирует размер (>1KB) и заголовок PE (Windows DLL)

### Конфигурация (environment variables)

| Переменная | Описание | Default |
|------------|----------|---------|
| `TRANSAQ_LOGIN` | Логин Finam | — |
| `TRANSAQ_PASSWORD` | Пароль Finam | — |
| `TRANSAQ_HOST` | Сервер | `tr1.finam.ru` |
| `TRANSAQ_PORT` | Порт | `3900` |
| `TRANSAQ_DLL_PATH` | Путь к DLL внутри контейнера | `/app/dll/txmlconnector.dll` |
| `TRANSAQ_DLL_URL` | URL для скачивания DLL (Yandex Disk или прямая) | — |
| `PULSE_API_URL` | URL бэкенда | — |
| `PULSE_API_KEY` | API ключ | — |
| `PULSE_BATCH_SIZE` | Размер батча | `10` |
| `RECONNECT_INTERVAL_MS` | Интервал реконнекта | `10000` |
| `MAX_RECONNECT_ATTEMPTS` | Макс. попыток (0=∞) | `0` |

### Деплой

#### Render (Production) — Blueprint

```bash
# 1. Запушь репо на GitHub
git add .
git commit -m "Add Transaq Connector v1.0.0"
git push origin main

# 2. Render Dashboard → New → Blueprint → Paste repo URL

# 3. Заполни Secrets (Environment Variables):
#    TRANSAQ_LOGIN=FZTC33538A
#    TRANSAQ_PASSWORD=NyCy5j8D
#    PULSE_API_KEY=твой_ключ

# 4. Deploy — Render сам скачает DLL с Яндекс.Диска
```

#### Локально (Docker Compose)

```bash
cd transaq-connector
cp .env.example .env  # заполнить
mkdir -p dll && cp txmlconnector.dll dll/  # или TRANSAQ_DLL_URL
docker-compose up -d
```

### Зачем отдельный сервис

1. **DLL это Windows-библиотека** — нужен Wine, тяжёлый runtime
2. **Изоляция** — падение DLL не ломает основной backend
3. **Масштабируемость** — можно запустить несколько инстансов
4. **Независимый деплой** — обновления connector без трогания backend

---

## 25. Будущие задачи (TODO)

| # | Задача | Приоритет | Зависимости |
|---|--------|-----------|-------------|
| 1 | **VPS: Купить Hetzner/DigitalOcean** | 🔴 Высокий | €3.79/мес |
| 2 | **VPS: Задеплоить transaq-connector с DLL** | 🔴 Высокий | Шаг 1 |
| 3 | **VPS: Загрузить txmlconnector64.dll** | 🔴 Высокий | Шаг 2 |
| 4 | **VPS: Настроить .env (креды Finam)** | 🟡 Средний | Шаг 3 |
| 5 | **VPS: Протестировать end-to-end** | 🟡 Средний | Шаг 4 |
| | | | |
| | **Результат:** Реал-тайм новости из Transaq → PULSE → браузер | | |

**Почему VPS, а не Render:**
- Wine требует `SYS_ADMIN` capabilities → managed containers (Render) не подходят
- DLL — Windows PE executable → нужна Wine эмуляция
- RSS Финам (7 лент) работает на Render как временное решение

**Когда запускать:** Когда решишь купить VPS. Hetzner CX11 — €3.79/мес, 2GB RAM.

### Оптимизация: RSS dedup по времени источника (idea)

**Проблема:** Каждые 5 мин крон парсит 36×20=720 статей, берёт 100 свежих, делает LLM для всех 100. При этом 87-99 — дубликаты (уже в базе). Тратим LLM-токены впустую.

**Предложение:** Для каждого RSS-источника хранить `last_fetched_at`. При парсинге — пропускать `<item>` с `pubDate < source.last_fetched_at`. Обрабатывать только реально новые (10-30 за запуск).

**Реализация:**
- Таблица `rss_source_meta` (source_id, last_fetched_at TIMESTAMP)
- Обновлять после успешного парсинга каждого источника
- Без запроса к БД внутри processArticles — обновление вне процесса

**Экономия:** ~70-90% меньше LLM-вызовов, быстрее крон, дешевле.

**Статус:** Отложено — первый подход (запрос к cron_log) создал deadlock. Нужен правильный подход.

---

## 26. Полная документация

| Файл | Где |
|------|-----|
| `CAROUSELS.md` | `/mnt/agents/projects/frontend/CAROUSELS.md` |
| `TAGS.md` | `/mnt/agents/projects/backend/TAGS.md` — полная методология тегов |
| `ARCHITECTURE.md` | `/mnt/agents/projects/backend/ARCHITECTURE.md` |
| `DEPLOYMENT.md` | `/mnt/agents/pro