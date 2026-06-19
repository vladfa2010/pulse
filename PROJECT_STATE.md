# PULSE — Project State (Session Resume)

> **Файл для быстрого входа в контекст после сброса.**
> **Дата:** 2026-05-30
> **Версия API:** 7.15
> **Актуальные коммиты:** backend `45d1629`, frontend `775d546`
>
> ✅ Batch sentiment + batch tag impact + retry logic + job lock

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
- `GET /api/news?global=true&page=N` — карусель 3 (все новости, infinite scroll)
- `GET /sentiment-stats?userId={uuid}&days={N}` — дельта сантимента по тегам
- `GET /sentiment-total?days={N}` — общая дельта всех новостей
- `GET /source-stats` — статистика по источникам RSS

---

## 4. News Pipeline (RSS → БД) — v7.15

```
Phase 1: RSS Fetch (32 sources, batch×4, 1500ms) → Parse XML → URL Normalize
Phase 2: Translate EN→RU (Kimi API, moonshot-v1-32k)
Phase 3a: BATCH SENTIMENT (v7.13) — 10 статей/LLM-запрос, score -10..+10 + reasoning
Phase 3b: Smart Tag Matching (3-layer: keywords → LLM → related)
Phase 3c: BATCH TAG IMPACT (v7.14) — 10 статей/LLM-запрос, impact per tag
Phase 4: Save (INSERT ON CONFLICT content_hash) → SSE broadcast
```

**Batch Processing (v7.13-7.14):**
| Фаза | Было (v7.12) | Стало (v7.14) | Ускорение |
|------|-------------|---------------|-----------|
| Sentiment | 10 × 500ms = 5s | 1 × 2s = 2s | **2.5×** |
| Tag Impact | 10 × 500ms = 5s | 1 × 2s = 2s | **2.5×** |
| **Итого LLM** | **~10s** | **~4s** | **2.5×** |

**Retry Logic (v7.14.1):** 3 попытки при 429/502/ECONNRESET/ETIMEDOUT. Backoff: 2s→4s→8s. Fallback: keyword-based neutral.

**JSON Guarantee (v7.14.2):** `response_format: { type: "json_object" }` — LLM всегда возвращает валидный JSON.

**Job Lock (v7.15):** PostgreSQL `cron_locks` таблица. `acquireCronLock('rss-aggregator')` + `releaseCronLock(DELETE)`. TTL = 15 минут. Предотвращает parallel runs.

**Cron:** `*/15 * * * *` (15 минут). Первый запуск через 2 минуты после старта.

**Dedup:** `content_hash` MD5 на title+summary. `ON CONFLICT DO UPDATE` — добавляем источник в `all_sources[]`.

**Ограничение:** max 100 свежих статей за цикл.

**Скорость:** ~15-25 секунд на весь batch (v7.14+, batch mode)

---

## 5. Smart Tag Matching — 3 слоя

1. **Keyword matching** — стандартные теги (18 шт) + пользовательские (из `user_defined_tags`), ищет по title + summary
2. **LLM matching** (Kimi API) — если keywords ничего не нашли, спрашиваем LLM. Кэш: `smart_tag_cache`
3. **Related tags** — добавляем связанные (nvda→tech,ai)

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
2. `POST /api/user/tags/custom` → backend:
   - `generateTagKeywords(tagName)` → keywords + транслит + склонения
   - INSERT в `user_defined_tags`
   - INSERT в `portfolios`
   - **BACKFILL:** сканирует ВСЕ новости, обновляет `matched_tags`
3. `tagVersion++` → `invalidateQueries(['unreadNews', 'historyNews'])`
4. Карусели автоматически перезагружаются

**Таблица:** `user_defined_tags` (tag_id, tag_name, tag_type, keywords[], created_by, created_at)

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

## 11. Таблицы БД (10 штук)

`users`, `portfolios`, `payments`, `news`, `user_sessions`, `user_channels`, `notification_settings`, `translation_cache`, `smart_tag_cache`, `user_defined_tags`

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
  routes/
    news.ts              — 3 режима ленты
    user.ts              — Tags CRUD + custom tag creation
    auth.ts              — Login/register
  index.ts               — Entry point, debug endpoints, migrations

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
| Backend | https://github.com/vladfa2010/pulse | `/mnt/agents/projects/backend` |
| Frontend | https://github.com/vladfa2010/pulse-frontend | `/mnt/agents/projects/frontend` |

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

## 19. Полная документация (ссылки)

| Файл | Где | Описание |
|------|-----|----------|
| `CAROUSELS.md` | `/mnt/agents/projects/frontend/CAROUSELS.md` | Логика 3 каруселей, sentiment, optimistic updates, user tags, **NewsFeed vs Карусели** |
| `ARCHITECTURE.md` | `/mnt/agents/projects/backend/ARCHITECTURE.md` | Pipeline, smart matching, translation, sentiment, API design |
| `DEPLOYMENT.md` | `/mnt/agents/projects/backend/DEPLOYMENT.md` | Инфраструктура, env vars, тестовый логин, troubleshooting |
| `PRODUCT_CONTEXT.md` | `/mnt/agents/projects/backend/PRODUCT_CONTEXT.md` | Критические правила, договорённости, тарифы, workflow |
