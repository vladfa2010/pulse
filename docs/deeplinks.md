# PULSE — Диплинки новостей: аудит, фиксы и проверка в проде

> Frontend: `pulse-frontend` (commit `3b5e67c` + ручные правки правил Render)  
> Backend: `pulse` (commits `27198d8`, `0675c18`)  
> Продакшен: `https://pulse.inside-trade.ru` → `https://pulse-api-bsov.onrender.com`  
> Дата актуализации: 2026-07-17

---

## 1. Целевая архитектура

```text
Пользователь открывает https://pulse.inside-trade.ru/n/{slug}
                │
                ▼
        Render Static Site
        /n/*  ──rewrite──►  backend /n/{slug}
                │
                ▼
        Express отдаёт HTML с og:* meta-тегами
        + <script>location.href='/news/{slug}'</script>
                │
                ▼
        Браузер / Telegram / WhatsApp scraper
        видит OG-карточку и редиректит на /news/{slug}
                │
                ▼
        Render Static Site
        /*  ──rewrite──►  /index.html (SPA fallback)
                │
                ▼
        React Router загружает NewsDetailModal по slugOrId
```

---

## 2. Что реализовано

### 2.1 Backend

| Компонент | Где | Что делает |
|---|---|---|
| `slug` колонка | `migrations/add_news_slug.sql`, `index.ts` миграции | `VARCHAR(250) UNIQUE` + индекс |
| `slugify.ts` | `src/utils/slugify.ts` | Транслитерация, cleanup, UUID-suffix (8 символов) |
| Генерация slug | `src/services/newsProcessor.ts` | `COALESCE(news.slug, $18)` — существующий slug не перезаписывается |
| RSS `<link>` | `src/services/rssFetcher.ts` | Self-closing `<link href="..."/>` fallback |
| Ленты | `src/routes/news.ts` | `slug` добавлен во все SELECT: `/global`, `/`, `/tags/:tagId`, `/search` |
| Загрузка по slug | `GET /api/news/by-slug/:slugOrId` | Ищет по `slug`, fallback по UUID `id` |
| Tag enrichments | `GET /api/news/by-slug/:slugOrId/tag-enrichments` | То же + `matched_tags`/`tag_impact` |
| OG endpoint | `GET /n/:slug` | HTML shell с `og:title`, `og:description`, `og:url`, `og:image`, `twitter:*` |
| Backfill | `index.ts` startup | `autoBackfillSlugs()` — заполняет пустые slug при старте (`LIMIT 5000`) |

### 2.2 Frontend

| Компонент | Где | Что делает |
|---|---|---|
| Dual Routes | `src/App.tsx` | Первый `<Routes>` на `state?.background \|\| location`, второй — overlay-модалка |
| Модалка | `src/components/NewsDetailModal.tsx` | Загружает по `slugOrId`, шарит `/news/{slug}` |
| Карусели / лента | `UnreadNewsCarousel`, `AllNewsCarousel`, `NewsFeed` | `navigate(/news/${slug}, { state: { background: location } })` |
| Типы | `src/types/news.ts` | `NewsArticle.slug: string` |
| OG-изображение | `public/og-default.png` | 1200×630 px |
| Android intent-filter | `android/app/src/main/AndroidManifest.xml` | `com.pulse.app` + `pulse.inside-trade.ru/news/` |

---

## 3. Баги, найденные при проверке, и применённые фиксы

### 3.1 Render rewrite: wildcard `$1` не подставляется

**Проблема:** в `pulse-frontend/render.yaml` было:

```yaml
routes:
  - type: rewrite
    source: /n/*
    destination: https://pulse-api-bsov.onrender.com/n/$1
```

Render Static Site не подставляет `$1`. Запрос `/n/foo` проксировался на `/n/$1`, и backend всегда отвечал 404.

**Правильный синтаксис Render** (см. `https://render.com/docs/redirects-rewrites.md`):

```yaml
routes:
  - type: rewrite
    source: /n/*
    destination: https://pulse-api-bsov.onrender.com/n/*
  - type: rewrite
    source: /*
    destination: /index.html
```

В wildcard-источнике `*` захватывает всё; в destination `*` вставляет захваченную строку.

**Применено:** через Render REST API (`POST /v1/services/{serviceId}/routes`) удалён старый `redirect`-правило, добавлены два `rewrite`-правила:

```text
/n/*  →  https://pulse-api-bsov.onrender.com/n/*   (rewrite, priority 1)
/*    →  /index.html                                (rewrite, priority 5)
```

> **Важно:** `render.yaml` в репозитории всё ещё содержит `$1`. Его нужно заменить на `*` и пересоздать/синхронизировать сервис, если когда-то будете пересоздавать Static Site.

---

### 3.2 `factCheckRoutes` блокировал публичные маршруты `/api/news/*`

**Проблема:** в `src/index.ts` роуты подключались так:

```ts
app.use('/api/news', factCheckRoutes); // router.use(authMiddleware) — на ВСЕ /api/news/*
app.use('/api/news', newsRoutes);
```

Поскольку `factCheckRoutes` использует `router.use(authMiddleware)`, любой запрос под `/api/news/*`, включая публичные `/global` и `/tags/:tagId`, возвращал 401.

**Фикс:** поменял порядок:

```ts
app.use('/api/news', newsRoutes);       // публичные маршруты первыми
app.use('/api/news', factCheckRoutes);  // fact-check остаётся защищённым
```

**Commit:** `27198d8`

---

### 3.3 Fallback по UUID в `by-slug` падал с 500

**Проблема:** запрос `/api/news/by-slug/{uuid}` падал с:

```json
{"error":"Failed to fetch news"}
```

Причина: один и тот же параметр `$1` использовался одновременно для сравнения с `slug` (text) и `id` (uuid):

```ts
`WHERE slug = $1 ${isUuid ? 'OR id = $1' : ''}`
```

PostgreSQL не может вывести один тип для `$1`, и `id = $1` ломается.

**Фикс:** явное приведение UUID:

```ts
`WHERE slug = $1 ${isUuid ? 'OR id = $1::uuid' : ''}`
```

То же самое сделано в `/by-slug/:slugOrId/tag-enrichments`.

**Commit:** `0675c18`

---

### 3.4 Standalone-рендеринг `/news/{slug}` (замечание)

В `src/App.tsx` второй `<Routes>` с `NewsDetailModalRoute` обёрнут в условие:

```tsx
{state?.background && (
  <Routes>
    <Route path="/news/:slugOrId" element={<NewsDetailModalRoute />} />
  </Routes>
)}
```

При прямом заходе на `/news/{slug}` (F5, Telegram) `location.state` отсутствует, поэтому модалка не рендерится, а первый `<Routes>` имеет `<Route path="/news/:slugOrId" element={null} />` — страница будет пустой.

**Рекомендуемый фикс:** убрать условие:

```tsx
<Routes>
  <Route path="/news/:slugOrId" element={<NewsDetailModalRoute />} />
</Routes>
```

> На момент написания документации в репозитории `pulse-frontend` (commit `3b5e67c`) это условие ещё на месте. Если вручную задеплоенная версия уже содержит фикс — нужно запушить изменения в `main`.

---

## 4. Проверка в проде

### 4.1 OG-ссылка `/n/{slug}`

```bash
curl -s "https://pulse.inside-trade.ru/n/wall-street-breakfast-podcast-starship-stall-weighs-on-spacex-12321e30" | head -20
```

Результат (HTTP 200):

```html
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Полдник на Уолл-стрит: Замедление Starship затрудняет работу SpaceX</title>
  <meta property="og:title" content="Полдник на Уолл-стрит: Замедление Starship затрудняет работу SpaceX">
  <meta property="og:description" content="Поodcast Утра Уолл-стрит: Замедление Starship затрудняет работу SpaceX">
  <meta property="og:url" content="https://pulse.inside-trade.ru/news/wall-street-breakfast-podcast-starship-stall-weighs-on-spacex-12321e30">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="PULSE">
  <meta property="og:image" content="https://pulse.inside-trade.ru/og-default.png">
  <meta property="og:locale" content="ru_RU">
  <script>window.location.href = '/news/wall-street-breakfast-podcast-starship-stall-weighs-on-spacex-12321e30'</script>
```

✅ OG-метатеги отдаются на кастомном домене.

---

### 4.2 SPA fallback `/news/{slug}`

```bash
curl -s -o /dev/null -w "%{http_code}" \
  "https://pulse.inside-trade.ru/news/wall-street-breakfast-podcast-starship-stall-weighs-on-spacex-12321e30"
# 200
```

✅ Возвращает `index.html`, React Router может подхватить маршрут.

---

### 4.3 Fallback по старой UUID-ссылке

```bash
curl -s "https://pulse-api-bsov.onrender.com/api/news/by-slug/12321e30-0f43-4e2b-b7ab-73f88e3a9562" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('slug:', d.get('slug'))"
```

Результат:

```text
slug: wall-street-breakfast-podcast-starship-stall-weighs-on-spacex-12321e30
```

✅ Старые ссылки `/news/{uuid}` продолжают открывать новость.

---

### 4.4 Публичные маршруты

```bash
curl -s "https://pulse-api-bsov.onrender.com/api/news/global?limit=1" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('articles:', len(d.get('articles',[])))"
# articles: 1

curl -s "https://pulse-api-bsov.onrender.com/api/news/tags/spacex" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('count:', len(d.get('articles',[])))"
# count: >0
```

✅ `global` и `tags/:tagId` больше не требуют токена.

---

## 5. Оставшиеся задачи

| # | Задача | Статус | Примечание |
|---|---|---|---|
| 1 | **Android APK** | ⏳ | Нужно пересобрать с обновлённым `AndroidManifest.xml` (intent-filter `com.pulse.app` + `pulse.inside-trade.ru/news/*`) |
| 2 | **Backfill оставшихся null-slug** | ⏳ | В `/api/news/global` встречаются `slug: null`. Автобэкфилл ограничен `LIMIT 5000`. Можно добить через `POST /admin/backfill` (admin JWT) или поднять лимит и перезапустить сервис. |
| 3 | **Обновить `pulse-frontend/render.yaml`** | ⏳ | Заменить `$1` на `*`. Если Static Site когда-то пересоздаётся из Blueprint — правила загрузятся корректно. |
| 4 | **Standalone `/news/{slug}` в frontend** | ⏳ | Убрать `state?.background &&` вокруг второго `<Routes>` в `App.tsx`, если ещё не сделано вручную. |

---

## 6. Как управлять правилами Render через API

```bash
TOKEN=$(cat .render-token)
SERVICE_ID="srv-d8ao626k1jcs73856fbg"  # pulse-frontend static site

# Посмотреть правила
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.render.com/v1/services/$SERVICE_ID/routes"

# Добавить rewrite /n/*
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$SERVICE_ID/routes" \
  -d '{"type":"rewrite","source":"/n/*","destination":"https://pulse-api-bsov.onrender.com/n/*","priority":1}'

# Добавить SPA fallback
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$SERVICE_ID/routes" \
  -d '{"type":"rewrite","source":"/*","destination":"/index.html","priority":5}'
```

Правила применяются сверху вниз по `priority`; первое совпавшее выигрывает. Поэтому `/n/*` должен идти раньше `/*`.

---

## 7. Итог

- Rewrite `/n/*` на OG-endpoint backend **работает**.
- SPA fallback `/* → /index.html` **работает**.
- Fallback старых UUID-ссылок **починен и задеплоен**.
- Публичные маршруты новостей **снова открыты**.
- До финального "prod ready" осталось: пересобрать Android APK, добить backfill slug, убедиться что standalone `/news/{slug}` в frontend рендерится.
