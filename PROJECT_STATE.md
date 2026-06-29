# PULSE — Project State (Session Resume)

> **Файл для быстрого входа в контекст после сброса.**
> **Дата:** 2026-06-18
> **Версия API:** 10.1
> **Актуальные коммиты:** backend `eb73d9f`, frontend `4184b19`
>
> ✅ Batch sentiment + batch tag impact + retry logic + job lock + tag protection + VoteToast confetti layering fix + Frost Appear animation for AllNewsCarousel

---

## 1. Что такое PULSE

Агрегатор инвестиционных новостей на русском языке. 3 карусели новостей на главной. RSS из 20+ источников → перевод EN→RU → sentiment analysis → smart tag matching → PostgreSQL → React frontend.

**URL:** https://pulse-frontend-jt53.onrender.com
**API:** https://pulse-api-bsov.onrender.com

---

## 2. Техстек

| Слой | Технологии |
|------|-----------|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS v3.4, shadcn/ui |
| Анимации | Framer Motion, CSS keyframes (newsSlideIn, fadeInSlide) |
| Кэш | React Query (@tanstack/react-query) — optimistic updates, background refetch |
| Backend | Node.js 20, Express, TypeScript |
| БД | PostgreSQL (Render production) / SQLite (local) |
| LLM API | Kimi API (moonshot-v1-32k, api.moonshot.ai, НЕ .cn) |
| RSS | 20+ источников (RU + EN), batch по 4, cron каждые 15 мин |
| Auth | JWT + bcryptjs, cookie-based sessions |

---

## 3. Архитектура — 3 карусели

| # | Название | Фильтр | Для кого | Компонент |
|---|----------|--------|----------|-----------|
| 1 | **"Это вы ещё не видели"** | matched_tags && user_tags, НЕ прочитанные | Только залогиненным | UnreadNewsCarousel.tsx |
| 2 | **"Вся лента"** | matched_tags && user_tags, прочитанные (DESC) | Только залогиненным | AllNewsCarousel.tsx |
| 3 | **"Общая лента"** | Без фильтра тегов, все новости | Всем (без логина) | GlobalNewsCarousel.tsx |

**API endpoints:**
- `GET /api/news` — карусель 1 (непрочитанные по тегам)
- `GET /api/news?history=true&page=N` — карусель 2 (прочитанные по тегам, DESC, infinite scroll)
- `GET /api/news/global?page=N` — карусель 3 (все новости, infinite scroll, публичный)
- `GET /api/news/stream` — SSE поток: backend рассылает `refresh` при появлении новых статей
- `GET /api/news?all=true` — страница /news (все новости по тегам пользователя)
- `GET /api/news/search?q=...&tag=...` — поиск по новостям в /news
- `GET /api/news/:id` — детали статьи для NewsDetailModal
- `GET /api/news/:id/tag-enrichments` — enriched данные по тегам статьи
- `POST /api/news/:id/read` — отметить статью прочитанной
- `GET /sentiment-stats?userId={uuid}&days={N}` — дельта сантимента по тегам
- `GET /sentiment-total?days={N}` — общая дельта всех новостей
- `GET /source-stats` — статистика по источникам RSS

---

## 3a. Sentiment Index (MVP) — страница `/sentiment`

Игровая механика: пользователь голосует за настроение рынка (`-1` / `0` / `+1`) каждые 30 минут и получает доступ к общему графику настроения сообщества.

**Сущность:** кумулятивная сумма голосов за текущий день по МСК.

**Таблицы:**
- `sentiment_votes` — голоса пользователей.
- `sentiment_user_windows` — персональные окна, статистика, streak.
- `sentiment_index_cache` — кэш 5-минутных свечей IMOEX (MOEX ISS API).

**API endpoints:**
- `GET /api/sentiment/index` — публичный индекс + история + свечи IMOEX.
- `GET /api/sentiment/status` — персональный статус и метрики (auth).
- `POST /api/sentiment/vote` — проголосовать (auth).
- `GET /api/sentiment/stream` — SSE `sentiment-update`.

**Логика:**
- Персональный 30-минутный кулдаун (`next_vote_at = last_vote_at + 30 мин`).
- Состояния страницы: `anonymous` / `active` / `voting` (blind vote).
- Индекс = `SUM(vote_value)` за день по МСК.
- Сброс `vote_count_today` и пересчёт `streak_days` — cron в 00:00 МСК.
- Обновление кэша IMOEX — cron каждые 5 минут в торговые часы.

**График:**
- Recharts `AreaChart`.
- Линия индекса (левая ось) + линия IMOEX (правая ось, жёлтая пунктир).
- Зона торговой сессии 10:00–19:00 МСК.
- SSE + fallback polling каждые 10 сек.

**Подробнее:** см. `Sentiment_Index.md` в корне проекта.

---

## 4. News Pipeline (RSS → БД) — v10.1

```
Phase 1: RSS Fetch (32 sources, batch×4, 1500ms) → Parse XML → URL Normalize
  - `summary_original` сохраняется полностью (TEXT); обрезка до 300 символов убрана
Phase 2: Translate EN→RU (Kimi API, moonshot-v1-32k)
Phase 3a: BATCH SENTIMENT (v7.13) — 10 статей/LLM-запрос, score -10..+10 + reasoning
Phase 3b: Smart Tag Matching (3-layer: keywords → LLM → related)
Phase 3c: BATCH TAG IMPACT (v7.14) — 10 статей/LLM-запрос, impact per tag
Phase 4: Save (INSERT ON CONFLICT content_hash) → SSE `refresh` broadcast
```

**Batch Processing (v7.13-7.14):**
| Фаза | Было (v7.12) | Стало (v7.14) | Ускорение |
|------|-------------|---------------|-----------|
| Sentiment | 10 × 500ms = 5s | 1 × 2s = 2s | **2.5×** |
| Tag Impact | 10 × 500ms = 5s | 1 × 2s = 2s | **2.5×** |
| **Итого LLM** | **~10s** | **~4s** | **2.5×** |

**Retry Logic (v7.14.1):** 3 попытки при 429/502/ECONNRESET/ETIMEDOUT. Backoff: 2s→4s→8s. Fallback: keyword-based neutral.

**JSON Guarantee (v7.14.2):** `response_format: { type: "json_object" }` — LLM всегда возвращает валидный JSON.

**Translation Retry (v10.1):** Если EN-статья осталась с `title_ru = title_original` (например, из-за parse-ошибки JSON-object от Kimi), News Processor повторно выбирает её и переводит заново (макс. 3 попытки). См. `translate.ts` и `newsProcessor.ts`.

**Job Lock (v7.15):** PostgreSQL `cron_locks` таблица. `acquireCronLock('rss-aggregator')` + `releaseCronLock(DELETE)`. TTL = 15 минут. Предотвращает parallel runs.

**Cron:** `*/15 * * * *` (15 минут). Первый запуск через 2 минуты после старта.

**Dedup:** `content_hash` MD5 на title+summary. `ON CONFLICT DO UPDATE` — добавляем источник в `all_sources[]`.

**Ограничение:** max 100 свежих статей за цикл.

**Скорость:** ~15-25 секунд на весь batch (v7.14+, batch mode)

---

## 4a. Real-time Updates (SSE)

Когда `NewsSourceManager` сохраняет новые статьи, backend рассылает `refresh` через SSE.

```
GET /api/news/stream
  ├── event: connected
  ├── event: ping          (heartbeat каждые 30s)
  └── event: refresh       (когда появились новые статьи)
```

Frontend (`useSseNews.ts`) слушает поток и вызывает `refetchQueries` для:
- `['globalNews']` — Общая лента
- `['unreadNews']` — Это вы ещё не видели
- `['historyNews']` — Вся лента

SSE включён для всех пользователей, в том числе незалогиненных (для «Общей ленты»).

---

## 5. Smart Tag Matching — 3 слоя

1. **Keyword matching** — effective keywords строятся из `enriched_data` (ticker + synonyms + key_products + base forms) и ищутся по `title` + `summary` с **Unicode word boundaries**. Это предотвращает false positives от коротких тикеров внутри слов (например, `si` в `Asian`).
2. **LLM matching** (Kimi API) — вызывается для статей, у которых Layer 1 нашёл хотя бы один тег (`forceLLM: true`). Кэш: `smart_tag_cache`.
3. **Related tags** — добавляем связанные (nvda→tech,ai).

**Single source of truth for keywords:**
- `user_defined_tags.enriched_data` JSONB является единственным источником matching-keywords.
- `user_defined_tags.keywords` — производный плоский массив, пересчитывается через `buildEnrichedKeywords` при создании тега и при любом admin-изменении enriched-полей.
- `related_entities` отображаются в UI, но **не** участвуют в matching (false-positive контроль).

---

## 6. Sentiment + Liquid Glass (v7.11)

### Sentiment Score — инвестиционная оценка (новое в v7.11)

LLM оценивает новость как опытный инвестиционный аналитик: **−10 до +10**

| Score | Значение | Цвет |
|-------|----------|------|
| −10 | Катастрофа (банкротство, скандал) | 🔴 Красный |
| −5 | Сильный негатив (убытки, санкции) | 🔴 Красный |
| −1 | Слабый негатив | 🔴 Красный |
| 0 | Нейтрально | ⚪ Серый |
| +1 | Слабый позитив | 🟢 Зелёный |
| +5 | Сильный позитив (сделка, рост) | 🟢 Зелёный |
| +10 | Максимум (поглощение, рекорд) | 🟢 Зелёный |

**В UI:** плашка `Позитив +5` или `Негатив -3` (иконка + текст + цифра)  
**В БД:** `news.sentiment_score INTEGER` (v7.11 миграция)  
**API:** все `/api/news/*` endpoint'ы возвращают `sentiment_score`

### 2 уровня определения
- **L1:** Keyword-based tag matching (быстро, без API) — ищет теги в тексте.
- **L2:** LLM smart tag matching через Kimi API — для статей с тегами вызывается всегда (`forceLLM: true`) начиная с v10.0.
- **L3:** Unified sentiment + tag impact через Kimi API — `sentiment_source='llm'`, score = −10..+10.
- **`no-tags`:** Keyword pre-filter не нашёл тегов — статья сохраняется в сыром виде, LLM не вызывается (`sentiment_source='no-tags'`, sentiment = NULL).

### Legacy sentiment (backward compatibility)

| Sentiment | Цвет | CSS glow |
|-----------|------|----------|
| positive | `#34D399` | `0 4px 20px -4px rgba(52,211,153,0.15)` |
| negative | `#F87171` | `0 4px 20px -4px rgba(248,113,113,0.15)` |
| neutral | `#9CA3AF` | `0 4px 20px -4px rgba(156,163,175,0.1)` |

**Tag Impact:** `tag_impact` JSONB в БД — `{ tag, impact, reasoning }[]`

---

## 7. Translation

- **Kimi API** (api.moonshot.ai, модель moonshot-v1-32k)
- Google Translate **заблокирован** на Render (не работает)
- Batch size: 5 текстов, задержка 500ms между batch
- Фильтр: `hasLatin && !hasCyrillic && length > 5`
- Кэш: `translation_cache` таблица

---

## 8. User-Defined Tags

Flow создания:
1. Пользователь вводит название в поиск → "Создать тег 'X'"
2. `POST /api/user/tags` или `POST /api/user/tags/custom` → backend:
   - `createUserTag()` проверяет существование тега в `user_defined_tags` по `tag_id` **или** `LOWER(tag_name)`.
   - Если тег уже есть — **не модифицирует** `user_defined_tags` и подписывает на существующий `tag_id` (защита от дублей + сохранение enriched_data/keywords/created_by).
   - Если тега нет — вызывает LLM `enrichTagViaLLM(tagName)`, строит keywords и делает `INSERT`.
   - INSERT/IGNORE в `portfolios` (подписка).
   - `POST /api/user/tags/custom` дополнительно делает **BACKFILL** по всем новостям.
3. `tagVersion++` → `invalidateQueries(['unreadNews', 'historyNews'])`
4. Карусели автоматически перезагружаются

**Инвариант защиты тегов:**
- Повторное добавление существующего тега в портфель никогда не обновляет `user_defined_tags`.
- Ручное изменение enriched-полей возможно только через `PUT /admin/tags/:tagId`.

**Таблица:** `user_defined_tags` (tag_id, tag_name, tag_type, keywords[], enriched_data JSONB, created_by, created_at)

**Keywords vs enriched_data:**
- `enriched_data` JSONB — единственный источник правды для matching keywords.
- `keywords[]` — производный плоский массив, который пересчитывается из `enriched_data`.
- `buildEnrichedKeywords(tagName, enrichment)` строит effective keywords из base keywords + ticker + synonyms + key_products.
- При создании тега и при любом admin-изменении `keywords` пересчитываются через `rebuildKeywordsFromEnrichment`.
- `getAllUserDefinedTags` предпочитает `buildEnrichedKeywords(enriched_data)`; если enriched_data отсутствует или не парсится — fallback на сохранённые `keywords[]` (или `[tag_id]`).
- `related_entities` используются только в UI, НЕ участвуют в matching (чтобы избежать false positives).

**Лимиты тегов:**
- Бесплатный пользователь: до 3 тегов (`maxTags = 3`).
- Premium: до 25 тегов (`maxTags = 25`).
- Проверка выполняется и на фронтенде (`Home.tsx`), и в `POST /api/user/tags`.

---

## 9. Optimistic Updates

Когда пользователь отмечает новость прочитанной:
1. **Мгновенно** (350ms fade-out) — карточка исчезает из карусели 1
2. **Мгновенно** — появляется в карусели 2 (fade-in)
3. **В фоне** — `POST /api/news/:id/read`
4. Реализация: `queryClient.setQueryData()` без ожидания API

---

## 10. "Прочитано" — только явное

Новость считается прочитанной ТОЛЬКО если:
- Клик на карточку (открытие URL + markAsRead)
- Кнопка ✓ на карточке
- 2 секунды в viewport при 80%+ видимости (IntersectionObserver)

Простой скролл **НЕ** считает прочитанным.

---

## 11. Таблицы БД (13 штук)

`users`, `portfolios`, `payments`, `news`, `user_sessions`, `user_channels`, `notification_settings`, `translation_cache`, `smart_tag_cache`, `user_defined_tags`, `sentiment_votes`, `sentiment_user_windows`, `sentiment_index_cache`

**Ключевые колонки в `news`:** id, title_ru, summary_ru, title_original, lang_original, source, url, published_at, sentiment, sentiment_source, matched_tags, tag_impact, content_hash, all_sources, source_count

---

## 12. Тестовый доступ

- **Email:** vladfa@ya.ru
- **Password:** !1234567890
- **URL:** https://pulse-frontend-jt53.onrender.com

---

## 13. Debug endpoints

| Endpoint | Что показывает |
|----------|---------------|
| `GET /health` | Версия API, статус |
| `GET /debug-env` | KIMI_API_KEY установлен? cron_secret? |
| `GET /debug-db` | Колонки, count, constraints, db_size |
| `GET /tag-stats` | Распределение тегов |
| `POST /trigger-rss?secret=` | Ручной запуск RSS (background) |
| `GET /trigger/process?secret=` | Ручной запуск News Processor |
| `GET /trigger/wake-no-tags?secret=` | Пробудить `no-tags` статьи для перепроверки |
| `GET /trigger/recalculate-keywords?secret=` | Пересчитать `keywords[]` всех тегов из `enriched_data` |
| `GET /trigger/reprocess-tag/:tagId?secret=` | Сбросить и пересчитать статьи с конкретным тегом |
| `GET /backfill-tags?secret=` | Ретегирование статей без тегов |
| `GET /backfill-translate?secret=` | Перевод EN заголовков (limit 50) |

**Secret:** `pulse-dev-key` (или `CRON_SECRET_KEY` из env)

---

## 14. Где что в коде

```
backend/src/
  services/
    cron.ts              — RSS pipeline (fetch → translate → tag → save)
    smartTagMatcher.ts   — 3-layer tag matching + sentiment + tag impact
    rssFetcher.ts        — RSS fetch + XML parse
    rssSources.ts        — 20+ RSS sources config
    translate.ts         — Kimi API translation (moonshot-v1-32k)
    tagManager.ts        — User-defined tags + keyword generation + backfill
    reports.ts           — Weekly email reports
    sentimentIndex.ts    — Индекс настроения: голоса, окна, метрики, кэш
    imoexAdapter.ts      — MOEX ISS адаптер для свечей IMOEX
    sse.ts               — SSE-рассылка (news + sentiment)
  routes/
    news.ts              — 3 режима ленты
    user.ts              — Tags CRUD + custom tag creation
    auth.ts              — Login/register
    sentiment.ts         — API индекса настроения
  index.ts               — Entry point, debug endpoints, migrations, cron

frontend/src/
  components/
    UnreadNewsCarousel.tsx   — Карусель 1 (optimistic updates)
    AllNewsCarousel.tsx      — Карусель 2 (fade-in animation)
    GlobalNewsCarousel.tsx   — Карусель 3 (все новости)
    NewsCard.tsx             — Liquid glass sentiment card
    NewsCarousel.tsx         — Universal carousel wrapper
  hooks/
    useNewsStream.ts         — Новые статьи → isNew → CSS анимация
  pages/
    Home.tsx                 — 3 карусели + tag search + create tag
    SentimentIndex.tsx       — Страница индекса настроения (Recharts + SSE)
```

---

## 15. Известные проблемы / TODO

| # | Проблема | Приоритет | Примечание |
|---|----------|-----------|------------|
| 1 | `summary_ru` не переводится (только title_ru) | medium | Нужно добавить перевод summary в translateBatch |
| 2 | Tag impact генерируется но не отображается в UI | medium | Данные в БД, нужен компонент отображения |
| 3 | Карусель 2 DESC сортировка — проверить на фронте | low | Backend отдаёт DESC, проверить что фронт не переворачивает |
| 4 | 300 статей без matched_tags | low | `/backfill-tags` для ретегирования |
| 5 | `content_hash` может быть NULL у старых записей | low | Не критично, UNIQUE constraint пропускает NULL |

---

## 16. Git репозитории

| Репо | URL | Путь локально |
|------|-----|---------------|
| Backend | https://github.com/vladfa2010/pulse | `pulse-backend/` |
| Frontend | https://github.com/vladfa2010/pulse-frontend | `pulse-frontend/` |

**Push:** `GIT_HTTP_LOW_SPEED_TIME=300 git push origin main`
**При ошибке GnuTLS:** повторить через 3 секунды

---

## 17. Ключевые договорённости (не нарушать)

1. **ТОЛЬКО реальные новости** из RSS — мок-данные ЗАПРЕЩЕНЫ
2. **Все EN новости переводятся** на русский — пользователь видит только RU
3. **Kimi API endpoint: api.moonshot.ai** — .cn возвращает 401
4. **Optimistic updates** — UI обновляется мгновенно, API в фоне
5. **Explicit read only** — скролл НЕ считает прочитанным
6. **Liquid glass UI** — все карточки с sentiment-цветами
7. **User-defined tags** — пользователь может создать ЛЮБОЙ тег
8. **Каждое изменение = git commit + push + deploy**

---

## 18. ⚠️ ИНЦИДЕНТ: TagEnrichment — перепутаны NewsFeed и Карусели (2026-05-30)

### Что произошло

При попытке добавить `TagEnrichment` (показ логики матчинга — почему новость попала в ленту) AI-ассистент перепутал **две независимые фичи**:

| Фича | NewsFeed (`/news`) | Карусели (Home.tsx) |
|------|-------------------|---------------------|
| Тип | Отдельная страница | Компоненты на главной |
| Навигация | `navigate('/news')` | Нет отдельного URL |
| API | Свой endpoint | `GET /api/news` и вариации |
| Компонент | `NewsFeed.tsx` | `UnreadNewsCarousel.tsx`, `AllNewsCarousel.tsx`, `GlobalNewsCarousel.tsx` |

**Ошибка:** AI начал менять карусели ради фичи, которая относилась к NewsFeed. В результате:
- `NewsFeed.tsx` — получил несвойственную ему логику
- `GET /api/news` — был модифицирован (tag filter, auth), что сломало карусели
- Auth requirements менялись public → auth → public — ломало всё
- Frontend не деплоился из-за каскадных TS ошибок

### Последствия

- Карусели перестали загружать новости
- NewsFeed показывал пустоту
- Auth токены сбрасывались на 401
- ~15 итераций фиксов, каждый ломал что-то новое
- Frontend не деплоился на Render

### Решение — ОТКАТ

| Репозиторий | Откат до коммита | Версия | Что содержит |
|-------------|-----------------|--------|--------------|
| Frontend | `6b707ce` | v7.11.1 | Рабочие карусели, NewsFeed, без TagEnrichment |
| Backend | `76c0f8a` | v7.9 | API до всех TagEnrichment изменений |

### Что было удалено при откате

- ❌ Компонент `TagEnrichment.tsx` (frontend)
- ❌ Endpoint `GET /tags/:tagName/enrichment` (backend)
- ❌ Tag filter в `GET /api/news` (backend)
- ❌ Optional auth в news API (backend)
- ❌ Time filter 90d→365d (backend)
- ❌ JWT import fixes, tagIds fixes (backend)
- ❌ Stats widget в Profile (frontend — часть отката)

### Правило на будущее

> **NewsFeed и Карусели — ИЗОЛИРОВАННЫЕ системы. Изменения в одной НЕ должны затрагивать другую.**
>
> Если нужен Tag Matching Logic:
> - Вариант А: Tooltip/Modal при наведении на тег в карточке карусели
> - Вариант Б: Отдельная страница `/tag/:tagName/explain` со своим API
> - Вариант В: Расширение ТОЛЬКО NewsFeed.tsx + ТОЛЬКО новый endpoint
>
> **Запрещено:** менять карусели ради NewsFeed и наоборот.

### Полная документация разграничения

См. `CAROUSELS.md` → раздел "⚠️ КРИТИЧЕСКОЕ РАЗГРАНИЧЕНИЕ: NewsFeed vs Карусели"

---

## 20. Telegram-Connect Banner (главная страница)

Промо-баннер под каруселью «Общая лента» предлагает залогиненным пользователям подключить Telegram.

**Компонент:** `pulse-frontend/src/components/TelegramConnectBanner.tsx`  
**Размещение:** `pulse-frontend/src/pages/Home.tsx` сразу после `<GlobalNewsCarousel />`

**Логика:**
- Показывается только залогиненным пользователям без подключённого Telegram.
- Бесплатным пользователям кнопка ведёт на `/pricing`.
- Premium-пользователям кнопка запрашивает `GET /api/telegram/link`, открывает deep link `@Insidepulse_bot`.
- После открытия Telegram запускается polling `GET /api/user/telegram-status` каждые 5 сек; баннер скрывается при `connected = true`.

**Backend endpoints (без изменений):**
- `GET /api/user/telegram-status`
- `GET /api/telegram/link`

---

## 19. Полная документация (ссылки)

| Файл | Где | Описание |
|------|-----|----------|
| `CAROUSELS.md` | `pulse-frontend/CAROUSELS.md` | Логика 3 каруселей, sentiment, optimistic updates, user tags, **NewsFeed vs Карусели** |
| `ARCHITECTURE.md` | `pulse-backend/ARCHITECTURE.md` | Pipeline, smart matching, translation, sentiment, API design |
| `DEPLOYMENT.md` | `pulse-backend/DEPLOYMENT.md` | Инфраструктура, env vars, тестовый логин, troubleshooting |
| `PRODUCT_CONTEXT.md` | `pulse-backend/PRODUCT_CONTEXT.md` | Критические правила, договорённости, тарифы, workflow |
