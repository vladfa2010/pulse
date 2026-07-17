# PULSE — Диплинки новостей: итоговая конфигурация

> Frontend: `pulse-frontend` (commit `bf86357`)  
> Backend: `pulse` (commit `e69fdf4`)  
> Продакшен: `https://pulse.inside-trade.ru` → `https://pulse-api-bsov.onrender.com`  
> Дата актуализации: 2026-07-18

---

## 1. Целевая архитектура

```text
Пользователь открывает https://pulse.inside-trade.ru/news/{slug}
                │
                ▼
        Cloudflare → Render Static Site
        Dashboard rule /*  ──rewrite──►  /index.html (SPA fallback)
                │
                ▼
        Браузер загружает React SPA (BrowserRouter)
        NewsDetailModal открывается по /news/:slugOrId
                │
                ▼
        XHR: GET /api/news/by-slug/{slug}
                │
                ▼
        Backend возвращает JSON → модалка рендерит контент

Поисковый бот / Telegram открывает https://pulse.inside-trade.ru/n/{slug}
                │
                ▼
        Cloudflare → Render Static Site
        Dashboard rule /n/*  ──rewrite──►  backend /n/{slug}
                │
                ▼
        Backend отдаёт HTML с og:*, JSON-LD Article, canonical
                │
                ▼
        Бот / scraper видит контент без JS
```

---

## 2. Конфигурация Render Dashboard (Static Site)

Настройка: Render Dashboard → `pulse-frontend` → Settings → Redirects/Rewrites

| # | Source | Destination | Action | Описание |
|---|---|---|---|---|
| 1 | `/n/*` | `https://pulse-api-bsov.onrender.com/n/*` | Rewrite | OG-страницы новостей (HTML + meta + JSON-LD) |
| 2 | `/sitemap.xml` | `https://pulse-api-bsov.onrender.com/sitemap.xml` | Rewrite | Карта сайта (5000 новостей за 30 дней) |
| 3 | `/robots.txt` | `https://pulse-api-bsov.onrender.com/robots.txt` | Rewrite | Разрешение `/news/`, `/n/`; запрет API/admin/личных |
| 4 | `/*` | `/index.html` | Rewrite | SPA fallback для BrowserRouter |

**Порядок критичен:** `/n/*`, `/sitemap.xml`, `/robots.txt` должны быть **выше** `/*`.

---

## 3. Что реализовано

### 3.1 Backend

| Компонент | Где | Что делает |
|---|---|---|
| `slug` колонка | миграции / `index.ts` | `VARCHAR(250) UNIQUE` + индекс |
| `slugify.ts` | `src/utils/slugify.ts` | Транслитерация, cleanup, UUID-suffix (8 символов) |
| Генерация slug | `src/services/newsProcessor.ts` | `COALESCE(news.slug, $18)` — существующий slug не перезаписывается |
| Backfill | `index.ts` startup | `autoBackfillSlugs()` — заполняет пустые slug при старте (`LIMIT 5000`) |
| Ленты | `src/routes/news.ts` | `slug` добавлен во все SELECT: `/global`, `/`, `/tags/:tagId`, `/search` |
| Загрузка по slug | `GET /api/news/by-slug/:slugOrId` | Ищет по `slug`, fallback по UUID `id` (`::uuid`) |
| Tag enrichments | `GET /api/news/by-slug/:slugOrId/tag-enrichments` | То же + `matched_tags`/`tag_impact` |
| OG endpoint | `GET /n/:slug` | HTML без JS-редиректа, с `og:*`, `twitter:*`, JSON-LD Article, canonical |
| Sitemap | `GET /sitemap.xml` | XML с 5000 URL за 30 дней |
| Robots | `GET /robots.txt` | `Allow: /news/`, `/n/`; `Disallow:` API/admin/личные |

### 3.2 Frontend

| Компонент | Где | Что делает |
|---|---|---|
| Router | `src/main.tsx` | `BrowserRouter` — работает с реальными путями `/news/:slug` |
| Hash migration | `src/App.tsx` | Переадресует старые `/#/news/slug` → `/news/slug` |
| Dual Routes | `src/App.tsx` | Первый `<Routes>` на `state?.background \|\| location`, второй — модалка (без условия) |
| Close behavior | `src/App.tsx` | `handleClose` выбирает `navigate(-1)` для overlay или `navigate('/')` для standalone |
| Модалка | `src/components/NewsDetailModal.tsx` | Загружает по `slugOrId`, шарит `/news/{slug}` через `BASE_URL` |
| SEO title/canonical | `src/components/NewsDetailModal.tsx` | Меняет `document.title` и `<link rel="canonical">` при открытии |
| Нативный шеринг | `src/components/NewsDetailModal.tsx` + `@capacitor/share` | Android Sharesheet / iOS Share Sheet; web fallback на Telegram |
| Мобильные ссылки | `.env.production`/`.env.development` | `VITE_FRONTEND_URL` — в Capacitor ссылки с продового домена |
| Карусели / лента | `UnreadNewsCarousel`, `AllNewsCarousel`, `NewsFeed` | `navigate(/news/${slug}, { state: { background: location } })` |
| OG-изображение | `public/og-default.png` | 1200×630 px |
| Android intent-filter | `android/app/src/main/AndroidManifest.xml` | `com.pulse.app` + `pulse.inside-trade.ru/news/` |

---

## 4. История фиксов (что ломалось и как починили)

### 4.1 `render.yaml` с `$1` не работал

Render Static Site не подставляет `$1` в destination. Правильный синтаксис — wildcard `*`:

```yaml
/n/*  →  https://pulse-api-bsov.onrender.com/n/*
```

### 4.2 `render.yaml` в `public/` / `dist/` игнорировался

Render Static Site читает `render.yaml` только из корня репозитория при Blueprint deploy. В Publish Directory он не действует.

### 4.3 `_redirects` (Netlify-style) не поддерживался

Файл `public/_redirects` тоже не применялся Render Static Site — диплинки `/news/:slug` возвращали пустой экран.

### 4.4 Финальное решение — Dashboard Redirects/Rewrites

Единственный рабочий способ для Render Static Site — ручная настройка в Dashboard. См. таблицу в разделе 2.

### 4.5 `HashRouter` не понимал чистые URL

При открытии `/news/{slug}` `HashRouter` видел пустой hash и рендерил `<Home />`. Перешли на `BrowserRouter` + SPA fallback `/* → /index.html`.

### 4.6 Standalone `/news/{slug}` не рендерил модалку

В `App.tsx` второй `<Routes>` с `NewsDetailModalRoute` был обёрнут в `{state?.background && (...)}`. При прямом заходе `state` отсутствовал, модалка не рендерилась. Условие убрано.

### 4.7 `factCheckRoutes` блокировал публичные маршруты

`factCheckRoutes` использовал `router.use(authMiddleware)` на все `/api/news/*`. Поменяли порядок:

```ts
app.use('/api/news', newsRoutes);       // публичные маршруты первыми
app.use('/api/news', factCheckRoutes);  // защищённые fact-check
```

### 4.8 Fallback по UUID падал с 500

Исправлено явным приведением типа:

```ts
`WHERE slug = $1 ${isUuid ? 'OR id = $1::uuid' : ''}`
```

---

## 5. Проверка в проде

### 5.1 SPA fallback `/news/{slug}`

```bash
curl -s "https://pulse.inside-trade.ru/news/test-slug-12345678" | grep -c "doctype"
# 1
```

### 5.2 OG-страница `/n/{slug}`

```bash
curl -s "https://pulse.inside-trade.ru/n/wall-street-breakfast-podcast-starship-stall-weighs-on-spacex-12321e30" | grep -c "og:title"
# 1
```

HTML не должен содержать JS-редиректа `<script>window.location.href = ...</script>`.

### 5.3 Sitemap

```bash
curl -s "https://pulse.inside-trade.ru/sitemap.xml" | grep -c "urlset"
# 1
```

### 5.4 Robots

```bash
curl -s "https://pulse.inside-trade.ru/robots.txt" | grep -c "User-agent"
# 1
```

### 5.5 Fallback по старой UUID-ссылке

```bash
curl -s "https://pulse-api-bsov.onrender.com/api/news/by-slug/12321e30-0f43-4e2b-b7ab-73f88e3a9562" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('slug:', d.get('slug'))"
```

### 5.6 Публичные маршруты

```bash
curl -s "https://pulse-api-bsov.onrender.com/api/news/global?limit=1" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('articles:', len(d.get('articles',[])))"
# articles: 1
```

---

## 6. Управление правилами через Render API

```bash
TOKEN=$(cat .render-token)
SERVICE_ID="srv-d8ao626k1jcs73856fbg"  # pulse-frontend static site

# Посмотреть правила
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://api.render.com/v1/services/$SERVICE_ID/routes"

# /n/*
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$SERVICE_ID/routes" \
  -d '{"type":"rewrite","source":"/n/*","destination":"https://pulse-api-bsov.onrender.com/n/*","priority":1}'

# /sitemap.xml
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$SERVICE_ID/routes" \
  -d '{"type":"rewrite","source":"/sitemap.xml","destination":"https://pulse-api-bsov.onrender.com/sitemap.xml","priority":2}'

# /robots.txt
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$SERVICE_ID/routes" \
  -d '{"type":"rewrite","source":"/robots.txt","destination":"https://pulse-api-bsov.onrender.com/robots.txt","priority":3}'

# SPA fallback
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "https://api.render.com/v1/services/$SERVICE_ID/routes" \
  -d '{"type":"rewrite","source":"/*","destination":"/index.html","priority":5}'
```

---

## 7. Оставшиеся задачи

| # | Задача | Статус | Примечание |
|---|---|---|---|
| 1 | **Android APK** | ✅ | Собрано `8.6.20` (`versionCode 42`) с BrowserRouter и диплинками |
| 2 | **Standalone `/news/{slug}`** | ✅ | Условие `state?.background` убрано |
| 3 | **SEO `/n/:slug`, sitemap, robots** | ✅ | Задеплоено |
| 4 | **Backfill оставшихся null-slug** | ⏳ | Автобэкфилл ограничен `LIMIT 5000`. Добить через `POST /admin/backfill` (admin JWT) или поднять лимит |

---

## 8. Итог

- Диплинки `/news/{slug}` открывают модалку через BrowserRouter + SPA fallback.
- OG-ссылки `/n/{slug}` отдают HTML с meta-тегами и JSON-LD для поисковиков и мессенджеров.
- Sitemap и robots.txt доступны для индексации.
- Render Static Site настроен через Dashboard Redirects/Rewrites — единственный поддерживаемый способ.
- Конфигурационные файлы `render.yaml` и `_redirects` **не используются** и удалены из `public/`.
