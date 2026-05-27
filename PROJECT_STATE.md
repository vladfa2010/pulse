# PULSE — Project State (Session Resume)

> **Файл для быстрого входа в контекст после сброса.**
> **Дата:** 2026-05-28
> **Версия API:** 4.5
> **Актуальные коммиты:** backend `2f11a94`, frontend `d94669a`

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
| LLM API | Kimi API (api.moonshot.ai, НЕ .cn) — перевод, sentiment, tag matching |
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
- `GET /api/news?history=true` — карусель 2 (прочитанные по тегам, DESC)
- `GET /api/news?global=true` — карусель 3 (все новости)

---

## 4. News Pipeline (RSS → БД)

```
RSS Fetch (20+ sources) → Parse XML → URL Normalize → Translate EN→RU (Kimi API)
→ Sentiment Analysis (keyword + LLM) → Smart Tag Matching (3-layer)
→ Tag Impact Analysis (LLM per tag) → Deduplicate (content_hash)
→ Save to PostgreSQL
```

**Скорость:** ~38-48 секунд на весь batch

---

## 5. Smart Tag Matching — 3 слоя

1. **Keyword matching** — стандартные теги (18 шт) + пользовательские (из `user_defined_tags`), ищет по title + summary
2. **LLM matching** (Kimi API) — если keywords ничего не нашли, спрашиваем LLM. Кэш: `smart_tag_cache`
3. **Related tags** — добавляем связанные (nvda→tech,ai)

---

## 6. Sentiment + Liquid Glass

| Sentiment | Цвет | CSS glow |
|-----------|------|----------|
| positive | `#34D399` зелёный | `0 4px 20px -4px rgba(52,211,153,0.15)` |
| negative | `#F87171` красный | `0 4px 20px -4px rgba(248,113,113,0.15)` |
| neutral | `#9CA3AF` серый | `0 4px 20px -4px rgba(156,163,175,0.1)` |

**2 уровня определения:**
- L1: Keyword-based (быстро, без API) — sentiment_source='keyword'
- L2: LLM через Kimi API — sentiment_source='llm'

**Tag Impact:** `tag_impact` JSONB в БД — `{ tag, impact, reasoning }[]`

---

## 7. Translation

- **Kimi API** (api.moonshot.ai, модель moonshot-v1-8k)
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
    translate.ts         — Kimi API translation (api.moonshot.ai)
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

## 18. Полная документация (ссылки)

| Файл | Где | Описание |
|------|-----|----------|
| `CAROUSELS.md` | `/mnt/agents/projects/frontend/CAROUSELS.md` | Логика 3 каруселей, sentiment, optimistic updates, user tags |
| `ARCHITECTURE.md` | `/mnt/agents/projects/backend/ARCHITECTURE.md` | Pipeline, smart matching, translation, sentiment, API design |
| `DEPLOYMENT.md` | `/mnt/agents/projects/backend/DEPLOYMENT.md` | Инфраструктура, env vars, тестовый логин, troubleshooting |
| `PRODUCT_CONTEXT.md` | `/mnt/agents/projects/backend/PRODUCT_CONTEXT.md` | Критические правила, договорённости, тарифы, workflow |
