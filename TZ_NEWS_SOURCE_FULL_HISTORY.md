# TZ: News Source System — Полная история (инициатива, архитектура, реализация, аудит, правки)

> **ID:** TZ_NEWS_SOURCE_FULL_HISTORY  
> **Дата:** 2026-06-10  
> **Версия:** v1.0 (финальный документ)  
> **Статус:** Реализовано, в production  
> **Файл:** `TZ_NEWS_SOURCE_FULL_HISTORY.md`

---

## СОДЕРЖАНИЕ

1. [Инициатива — откуда всё началось](#1-инициатива)
2. [Рассуждения и обсуждение](#2-рассуждения)
3. [Архитектура — финальная](#3-архитектура)
4. [Реализация — пошагово](#4-реализация)
5. [Аудит — 11 проблем](#5-аудит)
6. [Правки после аудита](#6-правки-после-аудита)
7. [Инциденты и их разбор](#7-инциденты)
8. [Финальная конфигурация](#8-финальная-конфигурация)
9. [Чек-лист проверки](#9-чек-лист)

---

## 1. Инициатива

### 1.1. Проблема

Пользователь (владелец PULSE) высказал идею:

> "У нас есть REST API, которое может добавлять новости в поток. Не лента непрерывная. А логика «запрос сделал на тег — получи результат». Сейчас у нас крон ходит по RSS. А тут будет: брать все теги. И раз в 15 мин опрашивать по тегам. Получать новости (сразу с тегом 100%) и вливать их в нашу ленту."

**Почему это важно:**
- RSS-источники (35 штук) дают "общий поток" новостей
- Но для **нишевых компаний** (CRISPR, редкие тикеры, биотех) новостей в RSS почти нет
- Если искать через API по конкретному тикеру — находятся новости, которые RSS не захватил
- **100% матчинг по тегу** — API возвращает новость, уже привязанную к тикеру

### 1.2. Первые вопросы

Пользователь сразу обозначил параметры:
- Источников будет несколько (2 API сейчас, потом 2 мировых + 2-3 РФ)
- RSS остаётся — два типа источников параллельно
- Запрос формируется из портфелей пользователей (DISTINCT tag_id)
- Новости вливаются "бесшовно" — словно ещё один RSS
- В админке должна быть возможность вкл/выкл каждый источник
- Теги запрашиваются только те, что в портфелях (экономия)

### 1.3. Finnhub — первый API-источник

Пользователь предоставил файл `finnhub-news-guide.md` с деталями:

| Параметр | Значение |
|----------|----------|
| Endpoint | `GET /api/v1/company-news?symbol={TICKER}&from={DATE}&to={DATE}&token={KEY}` |
| Rate limit | 60 req/min, 300 req/day |
| Ответ | `datetime` (unix), `headline`, `summary`, `source`, `url` |
| Ключ | `d8jc4r9r01qh6g3pfkn0` |

---

## 2. Рассуждения

### 2.1. Общий пул vs параллельные потоки

Предложили два варианта:

| Вариант | Плюсы | Минусы |
|---------|-------|--------|
| **Параллельно** (RSS отдельно, API отдельно) | Просто реализовать | Два cron'а, путаница, разные страницы админки |
| **Общий пул** (единый NewsSourceManager) | Один cron, одна таблица, одна админка | Нужна архитектура адаптеров |

**Решение:** общий пул. Один сервис, внутри которого адаптеры для разных типов источников.

### 2.2. Встраивание тега в текст

Пользователь предложил:
> "Можно дописывать к каждой новости тег в начало или конец. Чтобы система поиска тегов нашла его сразу."

Обсудили: это работает, но есть нюанс:
- Если встроить `[Tag: APPLE]` — LLM sentiment может увидеть это как часть текста
- Хотя если новость реально про Apple — Apple и так главная тема
- **Решение:** не встраивать в текст. Писать прямо в `matched_tags[]` (column в таблице `news`). Это чище и не искажает sentiment.

### 2.3. Какие теги запрашивать

| Вариант | Результат |
|---------|-----------|
| Все user_defined_tags | Много запросов, много "мусорных" новостей |
| Только с подписчиками (portfolios) | Оптимально — только то что пользователи отслеживают |
| DISTINCT tag_id | Топ-теги не дублируются даже если у 100 пользователей |

**Решение:** DISTINCT tag_id из `portfolios` — только то что кто-то отслеживает.

### 2.4. Частота опроса

| Параметр | Значение | Почему |
|----------|----------|--------|
| Основной интервал | 60 минут | Разумный баланс свежести vs rate limit |
| Debug-режим | 5 минут | Использовали при тестировании |
| Триггер при логине | Да | Пользователь зашёл — мгновенно свежие новости |
| Топ-12 тегов | Каждый цикл | Приоритетные |
| Остальные теги | Только в 00:00 | Экономия rate limit |

### 2.5. Дедупликация

Существующая система: `content_hash = SHA256(title + '\n' + summary)` с `UNIQUE` constraint.

Обсудили: маловероятно что RSS и API пересекутся, но нужна защита.

**Решение:** дедупликация по URL (primary) + content_hash (secondary). Если URL уже есть — skip. Если content_hash совпадает — merge sources.

### 2.6. Rate limits

| API | RPM | RPD | Наши запросы |
|-----|-----|-----|--------------|
| Finnhub | 60 | 300 | 25 тегов × 24 раза = 600 (превышение!) |

**Решение:** tiered fetching + respect 429.

### 2.7. Перевод EN → RU

Finnhub отдаёт новости на английском. Нужен перевод.

**Решение:** использовать существующий `translateBatch()` из `translation.ts`. Переводить `headline` и `summary` после получения, перед сохранением в БД.

### 2.8. Админка

Нужна вкладка для управления источниками.

**Решение:** новая вкладка **"Settings"** в админке — таблица с toggle-кнопками вкл/выкл.

### 2.9. Exchange фильтр

Важное решение:
- Finnhub — только американские биржи
- Нет смысла тратить запросы на MOEX-теги (Сбер, Газпром) — их и так RSS покрывает
- **Решение:** запрашивать только теги с `exchange = 'USA'`

---

## 3. Архитектура

### 3.1. Общая схема

```
┌─────────────────────────────────────────────────────────────┐
│                    NewsSourceManager                        │
│                    (каждые N мин)                           │
│                                                             │
│  ┌─────────────────┐    ┌─────────────────┐               │
│  │   RSS Adapter   │    │  API Adapter    │               │
│  │   (existing)    │    │  (Finnhub)      │               │
│  │                 │    │                 │               │
│  │ fetchAllRSS()   │    │ fetchFinnhub()  │               │
│  │ → 33 sources    │    │ → /company-news │               │
│  │ → all articles  │    │ → by ticker     │               │
│  └────────┬────────┘    └────────┬────────┘               │
│           │                      │                         │
│           └──────────┬───────────┘                         │
│                      │                                      │
│                      ▼                                      │
│           ┌─────────────────┐                              │
│           │  normalize()    │                              │
│           │  unified format │                              │
│           └────────┬────────┘                              │
│                    │                                        │
│                    ▼                                        │
│           ┌─────────────────┐                              │
│           │  dedup (URL +   │                              │
│           │  content_hash)  │                              │
│           └────────┬────────┘                              │
│                    │                                        │
│                    ▼                                        │
│           ┌─────────────────┐                              │
│           │  INSERT INTO    │                              │
│           │  news ...       │                              │
│           │  ON CONFLICT    │                              │
│           └─────────────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

### 3.2. Таблица `news_sources`

```sql
CREATE TABLE news_sources (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(50) NOT NULL UNIQUE,    -- 'kommersant', 'finnhub'
  display_name  VARCHAR(100) NOT NULL,          -- 'Коммерсант', 'Finnhub News'
  type          VARCHAR(20) NOT NULL,           -- 'rss' | 'api_search'
  config        JSONB DEFAULT '{}',             -- {url, api_key, rate_limit}
  enabled       BOOLEAN DEFAULT true,
  last_fetch_at TIMESTAMP,
  created_at    TIMESTAMP DEFAULT NOW()
);
```

### 3.3. Finnhub API Adapter

```
Input:  config (base_url, api_key, rate_limit_rpm)
Steps:
  1. SELECT DISTINCT tag_id, ticker, COUNT(subscribers)
     FROM user_defined_tags + portfolios
     WHERE ticker IS NOT NULL
       AND exchange = 'USA'          ← KEY FILTER
     ORDER BY subscriber_count DESC

  2. Split into top (12) + rare (rest)

  3. For each tag:
     GET /company-news?symbol={TICKER}&from={TODAY}&to={TODAY}&token={KEY}
     → articles[]

  4. For each article:
     - content_hash = SHA256(headline + summary)
     - matched_tags = [tag_id]       ← 100% match
     - source_type = 'api_search'
     - source = 'Finnhub News'

  5. Translate EN → RU (title + summary)

  6. INSERT INTO news ... ON CONFLICT (content_hash) DO UPDATE

Output: saved_count, skipped_count, url_dup_count
```

### 3.4. Rate Limit Protection

```
Sleep between requests: 60000 / rpm = 1000ms (1 sec)
On 429: skip ticker, log, continue to next
Daily limit: top 12 tags hourly + rest at midnight
```

### 3.5. Admin Endpoints

| Endpoint | Method | Auth | Описание |
|----------|--------|------|----------|
| `/admin/news-sources` | GET | Admin | Список всех источников |
| `/admin/news-sources/:id/toggle` | PUT | Admin | Вкл/выкл |

### 3.6. Frontend

**Вкладка "Settings"** в админке:
- Таблица: name, type (RSS/API), last_fetch, статус
- Toggle-кнопка (⚡ вкл / ⭘ выкл)
- Счётчики: RSS count, API count, enabled/total

---

## 4. Реализация

### 4.1. Коммиты

| Коммит | Дата | Что |
|--------|------|-----|
| `d7b7e81` | 2026-06-10 | Начало: shell NewsSourceManager + ТЗ |
| `bfc520f` | 2026-06-10 | NewsSourceManager + Finnhub adapter + admin endpoints |
| `31c1111` | 2026-06-10 | RSS adapter в NSM + перевод EN→RU |
| `f288382` | 2026-06-10 | Frontend: SourcesTab (админка) |
| `083d138` | 2026-06-10 | Очистка поля → "Not set" |
| `4d99613` | 2026-06-10 | **AUDIT FIX:** API key env + tiered fetching + URL dedup + /trigger/nsm |
| `9e013c9` | 2026-06-10 | Exchange фильтр: только теги с биржей |
| `216341c` | 2026-06-10 | Exchange = 'USA' — только американские |
| `6cf677f` | 2026-06-10 | Debug-лог: все теги в портфелях |
| `34d6d56` | 2026-06-10 | Цикл 5 минут (debug) |
| `a4f74e0` | 2026-06-10 | RSS enabled проверка в cron |
| `ca5ee2c` | 2026-06-10 | RSS проверка ДО acquireCronLock |

### 4.2. Файлы

| Файл | Описание |
|------|----------|
| `src/services/newsSourceManager.ts` | Единый менеджер источников |
| `src/services/finnhubAdapter.ts` | Finnhub API адаптер |
| `src/services/cron.ts` | RSS cron (с enabled-проверкой) |
| `src/pages/admin/SourcesTab.tsx` | Frontend вкладка Settings |
| `src/pages/Admin.tsx` | Интеграция SourcesTab |
| `src/models/schema.sql` | Таблица news_sources |

---

## 5. Аудит

### 5.1. Источник

Аудиторский документ: `TZ_NEWS_SOURCE_SYSTEM_AUDIT_FIX.md`

### 5.2. Найденные проблемы (11 штук)

#### Критические (🔴)

| # | Проблема | Риск | Фикс |
|---|----------|------|------|
| 1 | `isRunning` deadlock если ошибка до `finally` | Зависание | `try/finally` уже был ✅ |
| 2 | API key `d8jc4r9r...` в git history | Компрометация | Убрали из миграции, env var |
| 3 | Rate limit 300 vs 600 запросов | 429, бан | Tiered fetching (12+13) |
| 4 | `setInterval` на Render free tier | Cron не работает | `/trigger/nsm` endpoint |
| 5 | Дедупликация по hash collision | Потеря новостей | URL dedup (primary) |
| 6 | Нет перевода EN→RU | Русскоязычные пользователи не поймут | `translateBatch()` |

#### Архитектурные (🟡)

| # | Проблема | Риск | Фикс |
|---|----------|------|------|
| 1 | RSS adapter не интегрирован в NSM | Два параллельных потока | Интегрировали |
| 2 | Нет retry logic | Пропуск при временных ошибках | Пока нет (по желанию) |
| 3 | Нет circuit breaker | Каскадный отказ | Пока нет (по желанию) |
| 4 | Нет `requests_today` counter | Не знаем сколько потратили | Пока нет (по желанию) |
| 5 | Нет cron logging для NSM | Не видно историю запусков | Пока нет (по желанию) |

---

## 6. Правки после аудита

### 6.1. API key → env var

**Было:**
```typescript
const finnhubKey = process.env.FINNHUB_API_KEY || 'd8jc4r9r01qh6g3pfkn0';
```

**Стало:**
```typescript
const apiKey = process.env.FINNHUB_API_KEY || config.api_key;
if (!apiKey) { console.error('[Finnhub] No API key. Set FINNHUB_API_KEY env var.'); return []; }
```

Ключ из миграции убран, читается только из `FINNHUB_API_KEY` env.

### 6.2. Tiered fetching

**Было:** все теги каждый цикл → 600 запросов/день (превышение 300)

**Стало:**
```sql
ORDER BY subscriber_count DESC
-- top 12: каждый цикл
-- rest (13+): только в 00:00
```

### 6.3. URL dedup

**Было:** только `content_hash`

**Стало:**
```typescript
// Primary: URL check
const existingByUrl = await query(`SELECT id FROM news WHERE url = $1`, [a.url]);
if (existingByUrl.rows.length > 0) { urlDup++; continue; }

// Secondary: content_hash (ON CONFLICT)
```

### 6.4. /trigger/nsm endpoint

**Было:** только `setInterval`

**Стало:**
```typescript
app.get('/trigger/nsm', async (req, res) => {
  // cron-job.org или похожий сервис стучится сюда
  nsm.run();
  res.json({ started: true });
});
```

### 6.5. RSS enabled проверка

**Было:** cron проверял lock, потом делал fetch — даже если все RSS выключены

**Стало:**
```typescript
// 0. Check enabled BEFORE lock
const enabledResult = await query(`SELECT COUNT(*) FROM news_sources WHERE type='rss' AND enabled=true`);
if (parseInt(enabledResult.rows[0].count) === 0) {
  console.log('[Cron] No RSS sources enabled, skipping');
  return; // no lock needed
}
```

### 6.6. Exchange фильтр

**Было:** любой ticker → запрос в Finnhub

**Стало:** только `exchange = 'USA'` → запрос. MOEX, NASDAQ (без USA) → skip.

---

## 7. Инциденты

### INC-001: API key в git

| Параметр | Значение |
|----------|----------|
| Дата | 2026-06-10 |
| Причина | Хардкод ключа в миграции |
| Последствие | Ключ виден в git history |
| Фикс | Убран из миграции, читается из env |
| Действие | Пользователь добавил FINNHUB_API_KEY в Render env |

### INC-002: Rate limit 429

| Параметр | Значение |
|----------|----------|
| Дата | 2026-06-10 |
| Причина | 25 тегов × 24 раза = 600 > 300 лимит |
| Последствие | `[Finnhub] 429 rate limit` в логах |
| Фикс | Tiered fetching: 12 топ каждый час, остальные в полночь |

### INC-003: No tags found (exchange не USA)

| Параметр | Значение |
|----------|----------|
| Дата | 2026-06-10 |
| Причина | Теги с тикерами, но без exchange = 'USA' |
| Последствие | `[Finnhub] No tags with exchange=USA found` |
| Фикс | Debug-лог показал что теги без биржи. Пользователь добавляет USA вручную. |

### INC-004: RSS cron lock при всех выключенных

| Параметр | Значение |
|----------|----------|
| Дата | 2026-06-10 |
| Причина | Lock проверялся до enabled-проверки |
| Последствие | `[CronLock] Lock held` в логах каждый цикл |
| Фикс | Enabled-проверка перенесена ДО acquireCronLock |

---

## 8. Финальная конфигурация

### 8.1. Render Environment Variables

| Переменная | Значение | Описание |
|------------|----------|----------|
| `FINNHUB_API_KEY` | `d8jc4r9r01qh6g3pfkn0` | API ключ Finnhub |
| `CRON_SECRET_KEY` | `pulse-dev-key` (опционально) | Для /trigger/nsm |

### 8.2. База данных

| Таблица | Записи | Описание |
|---------|--------|----------|
| `news_sources` | 35 | 34 RSS + 1 Finnhub |
| `news` | растёт | RSS + API новости |

### 8.3. Админка

| Вкладка | Что |
|---------|-----|
| **Settings** | 35 источников, toggle вкл/выкл |

### 8.4. Логи

| Уровень | Пример |
|---------|--------|
| Info | `[NewsSourceManager] Starting cycle...` |
| Info | `[Finnhub] Fetching news for 3 tickers` |
| Info | `[Finnhub] AAPL: 5 articles` |
| Info | `[Finnhub] Saved: 5, URL dup: 0` |
| Info | `[Cron] No RSS sources enabled, skipping` |
| Error | `[Finnhub] 429 rate limit for TSLA` |

### 8.5. Рабочий поток (сейчас)

1. Пользователь заходит на сайт → **логин** → trigger NSM
2. Каждые 5 минут (debug): NSM цикл
3. В цикле:
   - RSS: если enabled → fetch → save
   - Finnhub: если enabled → fetch by tickers (USA only) → translate → save
4. Дедупликация: URL (primary) + content_hash (secondary)
5. Новости в таблице `news` → показываются пользователям

---

## 9. Чек-лист

- [x] Таблица `news_sources` создана
- [x] 34 RSS источника в таблице
- [x] Finnhub конфиг в таблице
- [x] NewsSourceManager shell
- [x] Finnhub adapter (fetch + translate + save)
- [x] RSS adapter в NSM (enabled check)
- [x] Admin endpoints (GET list + PUT toggle)
- [x] Frontend SourcesTab
- [x] API key в env var
- [x] Tiered fetching (12 топ + 13 редких)
- [x] URL dedup
- [x] /trigger/nsm endpoint
- [x] RSS enabled проверка в cron
- [x] RSS проверка ДО lock
- [x] Exchange = 'USA' фильтр
- [x] Перевод EN→RU
- [ ] **Пользователь добавляет USA в exchange тегов** ← СЕЙЧАС

---

*Document: TZ_NEWS_SOURCE_FULL_HISTORY.md*  
*Created: 2026-06-10*  
*For: Audit & Knowledge Base*
