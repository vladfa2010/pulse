# PULSE — Project State (Session Resume)

> **Файл для быстрого входа в контекст после сброса.**
> **Дата обновления:** 2026-05-29
> **Версия API:** 7.6
> **Актуальные коммиты:** backend `41998c5`, frontend `7aaca39` (Profile liquid glass redesign)

---

## 1. Что такое PULSE

Агрегатор инвестиционных новостей на русском языке. 3 карусели новостей на главной. RSS из 20+ источников → перевод EN→RU → sentiment analysis → smart tag matching → PostgreSQL → React frontend.

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
| RSS | 20+ источников (RU + EN), batch по 4, cron каждые 5 мин |
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
| 8 | **Demo-режим удалён** | Нет демо-логина, нет демо-портфеля |

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

---

## 14. UI: Hero padding (для залогиненных)

| Параметр | Залогинен | Без логина |
|----------|-----------|------------|
| Top padding | pt-8 (32px) | pt-24 (96px) |
| Bottom padding | pb-5 (20px) | pb-12 (48px) |
| Subtitle | ❌ скрыт | ✅ виден |

---

## 15. Крон

| Параметр | Значение |
|----------|----------|
| Интервал | Каждые 5 минут (`*/5 * * * *`) |
| Мониторинг | `cron_log` таблица + `/debug-cron` endpoint |

---

## 16. Debug endpoints

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

## 17. Где что в коде

```
backend/src/services/
  smartTagMatcher.ts   — 3-layer matching (keywords + LLM + related)
  tagManager.ts        — Tag types (8), auto-detect via LLM, keyword generation
  cron.ts              — RSS pipeline, cron monitoring
backend/src/routes/
  user.ts              — Tags CRUD, /summary, /tags/detect-type, /tags/related
  auth.ts              — Login/register (demo login УДАЛЕН)
frontend/src/components/
  DailySummary.tsx     — AI дайджест под "Вся лента"
frontend/src/pages/
  Instructions.tsx     — /instructions — как работают теги
  Profile.tsx          — /profile — liquid glass дизайн, 4 таба
  Home.tsx             — Hero padding conditional (isLoggedIn)
```

---

## 18. Git репозитории

| Репо | URL | Локально |
|------|-----|----------|
| Backend | https://github.com/vladfa2010/pulse | `/mnt/agents/projects/backend` |
| Frontend | https://github.com/vladfa2010/pulse-frontend | `/mnt/agents/projects/frontend` |

**Push:** `GIT_HTTP_LOW_SPEED_TIME=300 git push origin main`
**При GnuTLS error:** повторить через 3 секунды

---

## 19. Ключевые договорённости

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
12. **Каждое изменение = git commit + push + deploy**

---

## 20. Полная документация

| Файл | Где |
|------|-----|
| `CAROUSELS.md` | `/mnt/agents/projects/frontend/CAROUSELS.md` |
| `TAGS.md` | `/mnt/agents/projects/backend/TAGS.md` — полная методология тегов |
| `ARCHITECTURE.md` | `/mnt/agents/projects/backend/ARCHITECTURE.md` |
| `DEPLOYMENT.md` | `/mnt/agents/projects/backend/DEPLOYMENT.md` |
| `TELEGRAM_NOTIFICATIONS.md` | `/mnt/agents/projects/backend/TELEGRAM_NOTIFICATIONS.md` |
