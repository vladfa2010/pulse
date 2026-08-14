# ТЗ-36 — /api/news/tags/popular: news-driven запрос, дедупликация, stale-while-revalidate

**Дата:** 2026-08-13  
**Статус:** реализовано (коммит `5c2287b`)  
**Затрагивает:** `src/routes/news.ts` (эндпоинт `/tags/popular`), `src/utils/tagCache.ts` (переработка), фронт — без изменений  
**Предпосылки:** ТЗ-33 (тот же патч-паттерн доказан на проде: 3.2 с холодного вместо >20 с), ТЗ-32 (паттерн in-flight дедупликации из adminCache)

---

## 1. Проблема

Блок «Популярные теги сообщества» на главной обслуживается публичным эндпоинтом `GET /api/news/tags/popular` (news.ts:345). Кеш есть (in-memory, TTL 5 мин), но:

1. **Холодный путь — старая tag-driven форма запроса** (`FROM user_defined_tags LEFT JOIN news ON tag_id = ANY(matched_tags)` + GROUP BY): 94 per-tag GIN-пробы по 486 MB таблице. На проде этой формой измерено >20 с (шаг 1 ТЗ-33) — именно она давала `Popular tags statement timeout` в логах инцидента. Каждые 5 минут кеш протухает → первый посетитель ждёт 20+ с или ловит 500. Эндпоинт публичный — ходит и лендинг.
2. **Нет дедупликации параллельных запросов:** N посетителей на холодный кеш = N тяжёлых запросов в базу (эффект стада).
3. **Нет stale-while-revalidate:** после истечения TTL посетитель ждёт полный пересчёт синхронно.
4. **Логический баг:** `HAVING articles_24h > 0` захардкожен для всех периодов — во вкладках «7д»/«30д» отсутствуют теги с новостями за неделю/месяц, но без новостей за сутки.

Что уже работает и сохраняем: TTL 5 мин, ключ `period:limit`, прогрев кеша из `/admin/tags` (`setCachedPopularTags` ×3 периода).

---

## 2. Изменения

### 2.1. `src/utils/tagCache.ts` — переработка

Добавить SWR и in-flight дедупликацию, сохранив существующий API (`getCachedPopularTags`, `setCachedPopularTags`, `invalidatePopularTagsCache` — используется `/admin/tags`):

```ts
interface CachedTags { tags: any[]; ts: number }

const cache = new Map<string, CachedTags>()
const inflight = new Map<string, Promise<any[]>>()
const CACHE_TTL = 5 * 60 * 1000        // свежесть 5 мин — как сейчас
const STALE_TTL = 60 * 60 * 1000       // протухшее отдаём до часа, фоном обновляя

// getCacheKey / getCachedPopularTags / setCachedPopularTags / invalidatePopularTagsCache — без изменений

export async function popularTagsCached(
  period: string,
  limit: number,
  compute: () => Promise<any[]>
): Promise<any[]> {
  const key = `${period}:${limit}`
  const entry = cache.get(key)

  // свежее — мгновенно
  if (entry && Date.now() - entry.ts <= CACHE_TTL) return entry.tags

  // протухшее — отдать stale и фоном обновить (один пересчёт на всех)
  if (entry && Date.now() - entry.ts <= STALE_TTL) {
    if (!inflight.has(key)) {
      const p = compute()
        .then(tags => { cache.set(key, { tags, ts: Date.now() }); return tags })
        .catch(err => { console.error('[PopularTags] bg refresh error:', err?.message); return entry.tags })
        .finally(() => inflight.delete(key))
      inflight.set(key, p)
    }
    return entry.tags
  }

  // пусто (после деплоя/рестарта) — синхронный пересчёт, но один на всех
  if (!inflight.has(key)) {
    const p = compute()
      .then(tags => { cache.set(key, { tags, ts: Date.now() }); return tags })
      .finally(() => inflight.delete(key))
    inflight.set(key, p)
  }
  return inflight.get(key)!
}
```

Примечания:
- Ошибка на холодном пути → все ожидающие получают reject → catch эндпоинта → 500 (как сейчас). Ошибка фонового обновления → молча отдаём stale, лог в консоль.
- `invalidatePopularTagsCache()` остаётся для принудительного сброса; inflight не трогает (завершится и перезапишет — приемлемо).

### 2.2. `src/routes/news.ts`, `GET /tags/popular` — итоговая архитектура запроса

Финальный код в `src/routes/news.ts:348` строит SQL период-специфично через `buildPopularTagsSql(period, limit)`.

**Шаг 1 — `window_tags`.** Сканируется **только запрошенное окно** (`24h`/`7d`/`30d`), считаются топ-N×3 тегов. Для `24h` и `7d` это дешёвый scan малого окна.

**Шаг 2 — `top_tags`.** Из топ-N×3 оставляем ровно `LIMIT $1` тегов.

**Шаг 3 — `full_counts`.** Для каждого топ-тега отдельный GIN-lookup по `idx_news_matched_tags`:

```sql
JOIN news n ON n.published_at > NOW() - INTERVAL '...'
            AND n.matched_tags && ARRAY[tt.tag_id]
```

Это ключевой фикс по сравнению с промежуточными версиями: теги считаются **независимо**, поэтому co-occurring теги не засчитываются чужими счётчиками. Внутри каждого тега используется `FILTER` для получения `articles_24h`/`articles_7d`/`articles_30d`.

- Для `24h`/`7d` `full_counts` сканирует 30 дней (нужен `articles_30d`).
- Для `30d` `full_counts` сканирует только 7 дней (нужны только `24h`/`7d`; `30d` берётся из `window_tags`).

**Шаг 4 — фильтр и сортировка.** `WHERE fc.${orderCol} > 0` (фикс захардкоженного `articles_24h > 0`) и `ORDER BY` по колонке периода.

Ключевые точки:
- **Co-occurring tag pollution устранён:** каждый топ-тег считается через собственный GIN-lookup, а не через общий `unnest` всех тегов отобранных новостей.
- **Фикс периода:** `WHERE fc.${orderCol} > 0` — вкладки 7д/30д показывают теги без суточной активности.
- `orderCol` и `interval` — только из whitelist-мапы, инъекция исключена.
- Формат ответа неизменен (`{ tags: [...] }`) — фронт не трогаем.
- Эндпоинт PG-only, SQLite-ветка не добавляется.
- `Cache-Control: public, max-age=60` — браузерный кеш; для edge-кеширования нужно Cloudflare-правило (см. §3.4).

### 2.3. Прогрев из `/admin/tags`

Не меняется: `setCachedPopularTags` продолжает писать в тот же cache Map. После выкатки холодные пересчёты будут редкостью (SWR + админский прогрев).

---

## 3. Результаты на проде (итоговый коммит `5c2287b`)

Деплой: `dep-d9ve4lu7bikc73c16rm0` (`pulse-api`, Render Oregon, 1 инстанс).

1. **Холодный путь (первый запрос после деплоя):**
   - `24h`: `route total=1645 ms`
   - `7d`: `route total=2235 ms`
   - `30d`: `route total=2740 ms`
   Все укладываются в `statement_timeout=30s` без риска; `30d` при `limit=10` даже ниже порога `[SLOW]` (3000 мс).
2. **Тёплый путь:** повторные запросы — `route total=0–1 ms`, кеш бьётся (логи `[PopularTagsCache] HIT key=...`).
3. **SWR + дедупликация:** реализованы через `inflight Map<string, Promise>`; параллельные холодные запросы ждут один compute.
4. **Корректность:** счётчики стабильны между периодами. Пример: `россия` — `24h=86`, `7d=429`, `30d=3851`; `bitcoin` — `24h=10`, `7d=76`, `30d=482`. Вкладки 7д/30д показывают теги без суточной активности (например, `минэкономразвития` и `spacex` в 30д).
5. **End-to-end vs server-side:** curl до `pulse-api-bsov.onrender.com` показывает TTFB ~0.65–0.73 с даже на тёплом кеше. Разбор:
   - server-side processing: **0–1 ms**;
   - TLS handshake (client → Cloudflare): ~0.38 с;
   - Cloudflare → Render origin: ~0.35 с;
   - итог: ~0.73 с на отдельном TCP-соединении.
   С HTTP/2 keep-alive второй запрос на том же коннекте падает до ~0.27 с, но остаётся сетевое/Cloudflare, а не сервер.

### 3.4. Чтобы достичь end-to-end < 50 мс

Сервер уже отвечает за 0–1 ms. Оставшиеся ~0.35 с — проход Cloudflare → Render origin. Нужно кешировать JSON на edge Cloudflare:

- В Cloudflare Dashboard создать **Cache Rule** (или Page Rule) для `pulse-api-bsov.onrender.com/api/news/tags/popular*`:
  - **When matching:** URI Path contains `/api/news/tags/popular`
  - **Then:** Eligibility → Cache; Edge TTL → 1 hour; Browser TTL → 60 s (как сейчас в `Cache-Control`).
  - Или Page Rule: `pulse-api-bsov.onrender.com/api/news/tags/popular*` → Cache Level: Cache Everything, Edge Cache TTL: 1 hour.

После этого тёплые запросы пойдут с ближайшего PoP Cloudflare за <50 мс. Серверный SWR-кеш остаётся защитой от cache miss и refresh.

---

## 4. Приёмка

1. Серверный холодный ответ ≤ 3 с (подтверждено: 24h≈1.6 с, 7d≈2.2 с, 30d≈2.7 с), серверный тёплый < 50 мс (0–1 мс по логам), stale — мгновенно.
2. В логах Render за сутки нет `[SLOW] GET /api/news/tags/popular` и statement timeout по этому запросу.
3. Параллельные запросы на холодный кеш не плодят запросы к PG (in-flight dedup).
4. Co-occurring теги не засчитываются чужими счётчиками (проверено: счётчики стабильны между периодами).
5. Вкладка «7д» показывает теги с активностью за неделю даже без новостей за сутки; «30д» — теги с активностью за месяц.
6. Для end-to-end < 50 мс на стороне клиента — настроить Cloudflare Cache Rule (см. §3.4).

---

## 5. Риски и откат

- **Откат:** revert коммита — вернутся старый запрос и 5-минутный кеш без SWR (известная боль, не катастрофа).
- **Stale-данные до 1 ч при падении фонового пересчёта** — счётчики популярных тегов, критичности нет.
- **Холодный пересчёт после каждого деплоя** (in-memory кеш пуст) — один 3-секундный запрос, дедуплицированный; приемлемо. Если захотим ноль — отдельной задачей прогрев из cron (сейчас не делаем).
- Рост данных: форма линейна от окна 30 дней (как ТЗ-33), предел — пре-агрегация, не сейчас.

---

## 6. Оценка трудозатрат

~1 час: переработка tagCache.ts (20 мин) + эндпоинт (15 мин) + сборка + проверки на проде (20 мин).
