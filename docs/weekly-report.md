# Еженедельный отчёт как страница платформы (ТЗ-191)

> Бэкенд страницы недельного отчёта: снапшоты, magic-link доступ, live-режим,
> графики, календарь «впереди», дистрибуция «сводка + ссылка», AI-саммари, ретеншн.
> Генерация инфографики и агрегатов — в [docs/weekly-report-chart.md](weekly-report-chart.md) (ТЗ-184).

**Статус:** реализовано (2026-10-20)
**Контур:** `workers.ts` (cron) → `weeklyReportGenerate.generateWeeklySnapshots()` →
`weeklyReportSnapshot.saveWeeklyReportSnapshot()` → `workers.runBroadcast('weekly_report')` →
`dispatcher.dispatchToUser()` → `deliver()` → Telegram / Email / Push (сводка + ссылка на страницу).

---

## 1. Модель данных

Зеркало `src/migrations/weekly_reports_v1.sql` (SQLite-вариант — `initSQLiteSchema()` в `src/config/db-sqlite.ts`):

```sql
CREATE TABLE weekly_reports (
  id          UUID PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL,          -- понедельник недели отчёта, 'YYYY-MM-DD' (МСК)
  payload     JSONB NOT NULL,         -- WeeklyReportContent + stats (ТЗ-184) + ai (п.10)
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL,
  sent_at     TIMESTAMPTZ,            -- гейт идемпотентной отправки
  UNIQUE (user_id, week_start)        -- один снапшот на юзера на неделю
);
-- idx (user_id, week_start DESC) — архив свежими первыми
-- idx (week_start) WHERE sent_at IS NULL — фаза отправки 13:00

CREATE TABLE report_access_tokens (
  id           UUID PRIMARY KEY,
  report_id    UUID NOT NULL REFERENCES weekly_reports(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,  -- только SHA-256, plaintext в БД не хранится
  expires_at   TIMESTAMPTZ NOT NULL,  -- +7 дней от выпуска
  last_used_at TIMESTAMPTZ,           -- аудит, обновление throttled ≤1 раза в час
  created_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (report_id)                  -- один токен на отчёт, перевыпуск = upsert
);
-- idx (expires_at)
```

`payload` — сериализованный JSON: `WeeklyReportContent` (статистика, топ-статьи, события)
+ `ai` (`{overall, perTag[], meta}`, все поля `null` при недоступном LLM — см. п.10).

## 2. Кроны (Europe/Moscow)

| Расписание | Задача | Что делает |
|-----------|--------|-----------|
| `0 11 * * 0` (вс 11:00) | `weekly_report_generate` | Генерация снапшотов недели (LLM ≤6 вызовов на юзера), выпуск magic-токенов. Отдельный cron, чтобы LLM-латентность не растягивала рассылку. |
| `0 13 * * 0` (вс 13:00) | `weekly_report` | Рассылка: контент из снапшота, перевыпуск токена, «сводка + ссылка». `sent_at` — гейт идемпотентности. |
| `30 6 * * 1` (пн 06:30) | `weekly_report_cleanup` | Ретеншн: hard delete снапшотов старше 12 недель. |

Все три пишут в `cron_log` (админка показывает); ошибки cleanup — warning, джоба не падает.

## 3. Генерация и конкурентность

- `generateWeeklySnapshots()` обходит пользователей с тарифом, включающим `weekly_report`
  (entitlement, см. `services/notifications/entitlement.ts`), с **concurrency ≤ 5**.
- **Per-user изоляция:** ошибка контента/LLM/БД одного пользователя не прерывает фазу —
  ловится на уровне итерации, считается в `errors`, следующий пользователь обрабатывается.
- Результат фазы: `{generated, errors, llmCalls}` в `cron_log`.

## 4. Upsert и стабильный id

`saveWeeklyReportSnapshot(userId, content, ai)` — `INSERT ... ON CONFLICT (user_id, week_start) DO UPDATE`
(PG) / `INSERT OR REPLACE` с сохранением id (SQLite). Повторный прогон в ту же неделю:
`created=false`, **id снапшота стабилен**, токен не плодится. `sent_at` при апдейте не сбрасывается.

## 5. Magic-link

- URL страницы: `${FRONTEND_URL || 'https://pulse.inside-trade.ru'}/reports/weekly/:id?k=<token>&utm_source=<channel>&utm_medium=weekly_report`
  (единственное место сборки — `weeklyReportUrl()` в `dispatcher.ts`).
- Токен: 24 байта `crypto.randomBytes` → 48 hex; в БД **SHA-256 хэш**; TTL 7 дней;
  одна строка на отчёт (`UNIQUE(report_id)`), перевыпуск — upsert (старый мгновенно мёртв).
- Выпускается дважды: в фазе генерации (снапшот создан) и в фазе отправки
  (чтобы в письме/TG была свежая ссылка; оба раза — один и тот же plaintext-механизм).
- Проверка `?k=`: сначала существование отчёта (удалён → **404**), потом валидность токена
  (битый/чужой/протухший → **401**). Live-режим `?k=` не принимает — только сессия (401).
- Plaintext токена существует только в момент выпуска и в URL рассылки; в логи не пишется.

## 6. Live-режим (`/weekly/current`)

- Пока снапшота текущей недели нет — отдаётся **live**: агрегаты «на лету»
  (`computeLiveWeeklyStats` из свежих данных), флаг `live: true`, `elapsed_days` —
  только прошедшие будни (пн–пт, без выходных), `perDay` без будущих дней,
  `pace` будни-к-будням, **без % дельт**, **0 LLM-вызовов**.
- Кэш в памяти 5 мин (`X-Cache: hit|miss`). После появления снапшота отвечает
  `{snapshot_id}` — фронт редиректит в архив.

## 7. Read-paths и матрица доступа

Префикс `/api/reports` (`src/routes/reports.ts`), авторизация эндпоинтная:
JWT через `optionalAuth` + свежий `is_blocked` из `users` (конвенция ТЗ-120/183).

| Эндпоинт | Свой | Чужой | Админ | `is_blocked` | `?k=` валидный | `?k=` невалидный |
|----------|------|-------|-------|--------------|----------------|------------------|
| `GET /weekly` (архив, ≤12 строк, без payload) | 200 | 200 (свой список) | — | 403 | — | — |
| `GET /weekly/current` | 200 live / {snapshot_id} | 200 (свой live) | — | 403 | 401 (live — сессия only) | — |
| `GET /weekly/current/chart?tag_id=` | 200 | — | — | 403 | 401 | — |
| `GET /weekly/current/ahead` | 200 | — | — | 403 | 401 | — |
| `GET /weekly/:id` | 200 | **404** (не палим id) | 200 | 403 | 200 | 401 (удалён → 404) |
| `GET /weekly/:id/chart?tag_id=` | 200 | 404 | 200 | 403 | 200 | 401 |
| `GET /weekly/:id/ahead` | 200 | 404 | 200 | 403 | 200 | 401 |

Порядок проверок архива: `is_blocked` → владелец/админ → чужой 404 → magic-link.
Live-эндпоинты требуют платный тариф (entitlement) → иначе 403
`weekly_report requires paid plan`. `tag_id` вне payload → 404.

## 8. Графики (`:id/chart`, `/weekly/current/chart`)

- `tag_id` только **выбирает** тег внутри payload; символ инструмента (ticker/MIC) —
  строго из данных тега. Пользовательский ввод в маркет-запрос не попадает (SSRF-гард).
- Один вызов `marketRouter.getIntraday5minRange` за окно 7 дней, таймзона биржи.
- Деградация всегда 200: тег без инструмента → `{chart: null}`;
  рынок недоступен → `{chart: null, reason: 'market_unavailable'}` (страница цела).
- Кэши в памяти: live — 5 мин, архив (report_id, tag_id) — 24 ч. `X-Cache: hit|miss`.
- Маркеры новостей на графике — события из payload (url статей текущей недели).
- **ТЗ-194. Настроение новостей** — третий слой графика: накопительная ступенчатая
  кривая в поле `sentiment: [{ t, cum, news_id }]`. Модель — дельта без параметров:
  события в порядке `published_at`, позитив `+1`, негатив `−1`, нейтральные пропускаются
  (ступень без сдвига); `cum` — баланс ПОСЛЕ новости, старт периода = 0, конец кривой =
  баланс 🟢−🔴 тега за неделю (совпадает со сводкой). Источник — те же видимые события,
  что `news_markers`; live и архив — одним кодом (`src/services/weeklySentiment.ts`).
  `news_id` — для клика/якоря к ленте тега; у снапшотов до ТЗ-194 `null` (клик недоступен).
  Деградация: `<2` **ненейтральных** новостей за окно → `"sentiment": null` —
  фронт скрывает панель, цена и объём работают. Кэш/ключ не менялись (live 5 мин /
  архив 24 ч). LLM не вызывается — агрегация поля `news.sentiment` (ingest).
  Замещает бакеты 4 ч + окно 12 ч (ПРАВКА-2 v1 к ТЗ-191).

## 9. Календарь «впереди» (`:id/ahead`, `/weekly/current/ahead`)

- События canonical-слоя `calendar_events` на следующую неделю (пн–вс), фильтр —
  по активным тегам портфеля **владельца отчёта** (архив) / текущего юзера (live).
- Тег без новостей, но с событием — событие видно. Живые данные, не снапшот.
- Календарь пуст → 200 `{ahead: null}`.

## 10. AI-саммари

- До **6 LLM-вызовов на юзера** за фазу генерации: 1 общее + до 5 по тегам.
- Нет ключа / HTTP 500 от LLM → соответствующее поле `ai` = `null`, генерация не падает,
  снапшот создаётся; страница показывает статистику без AI-блока.
- В live-режиме и в дистрибуции без токена AI не запрашивается.

## 11. Дистрибуция (Задача 5): сводка + ссылка

Каналы получают **сводку**, а не полный отчёт; полный отчёт — по ссылке на страницу:

- **Telegram:** фото-инфографика + caption (статистика, общее AI-саммари целиком, топ-3 тега),
  **inline-кнопка «Открыть полный отчёт»** с magic-link. Если `sendPhoto` отвергнут —
  кнопка добавляется к последнему текстовому чанку. Все строки проходят `escapeHtml`.
- **Email:** KPI-карточки + первый абзац AI-саммари + топ-3 тега + кнопка
  «Открыть полный отчёт» (URL с UTM `utm_source=email`), PNG — inline-вложение `cid:weekly-chart`.
- **Push:** короткая сводка, `data.report_url` с magic-link (фронт открывает страницу).
- UTM: `utm_source=telegram|email|push`, `utm_medium=weekly_report`.
- Ошибка перевыпуска токена при отправке → warning, рассылка идёт без кнопки.
- **Безопасность ссылки:** plaintext токена в БД и логах не хранится; Caddyfile не
  включает access-логи, query `?k=` в логи веб-сервера не попадает (изменений не требуется).
  SPA-fallback `/reports/*` на фронтенд покрывается существующим `try_files`.

## 12. Ретеншн (Задача 6)

- `cleanupOldWeeklyReports()` — hard delete снапшотов старше **12 недель**
  (`WEEKLY_REPORT_RETENTION_WEEKS`), каскадно с `report_access_tokens` (`ON DELETE CASCADE`).
- Исключение: невысланный снапшот **текущей** недели не трогаем
  (`NOT (sent_at IS NULL AND week_start = текущая)`).
- Удалённые отчёты с мёртвым magic-link → read-path отвечает 404 (см. п.7).
- Новые миграции не требуются (таблицы из фазы «а», `weekly_reports_v1.sql`).

## 13. Ограничения и деградации

| Условие | Поведение |
|---------|-----------|
| LLM недоступен | `ai.* = null`, снапшот и рассылка без AI-блока |
| Рынок недоступен | график `{chart: null, reason: 'market_unavailable'}` |
| Тег без инструмента | `{chart: null}` |
| `sendPhoto` отвергнут | TG получает текст + кнопку со ссылкой |
| Ошибка перевыпуска токена | рассылка без кнопки (warning) |
| Ошибка одного юзера в фазе | изоляция, `errors++`, фаза продолжается |
| Календарь пуст | `ahead: null` |
| Отчёт удалён ретеншном | 404 на read-path (до проверки токена) |

## Тесты

```bash
# Основной чек-лист ТЗ-191 (13 секций)
USE_SQLITE=true npx ts-node --transpile-only src/tests/weeklyReportPage.test.ts
# Графики/рендер/доставка (ТЗ-184)
USE_SQLITE=true npx ts-node --transpile-only src/tests/weeklyReportChart.test.ts
```

Последний прогон: **107 ok, 0 fail, 4 skip** (page, ТЗ-194) / **30 ok, 0 fail** (chart).

Ожидаемые SKIP:
- п.12 FE-рендер страницы — фронтенд-скоп (pulse-frontend): рендер на моковом payload,
  live-бейдж, стирание `?k=` из адресной строки — проверяется React-тестами/ручным чек-листом;
- окно тихих часов — требует сдвига системных часов (покрыто логикой дайджеста);
- лимит конкурентности ≤5 — требует мок-таймеров;
- PG-варианты SQL — нужен живой PG; SQLite-ветки идентичны по логике.

## Связанные файлы

- `src/services/notifications/weeklyReportSnapshot.ts` — снапшоты, токены, ретеншн
- `src/services/notifications/weeklyReportGenerate.ts` — фаза генерации
- `src/services/notifications/weeklyReportContent.ts` — сборка контента (PG/SQLite)
- `src/services/notifications/weeklyStats.ts`, `weeklyChart.ts` — агрегаты, PNG (ТЗ-184)
- `src/services/notifications/weeklySummaryAI.ts` — LLM-саммари
- `src/services/notifications/formatters.ts` — сводка email/TG/push + ссылка
- `src/services/notifications/dispatcher.ts` — фан-аут, `weeklyReportUrl()`
- `src/services/notifications/workers.ts` — cron-расписание (п.2)
- `src/services/telegram.ts` — `sendTelegramPhoto(..., replyMarkup)` + inline-кнопки
- `src/routes/reports.ts` — все read-paths (п.7–9)
- `src/migrations/weekly_reports_v1.sql` — схема
