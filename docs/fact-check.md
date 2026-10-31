# Факт-чекинг новостей (Fact-Check API)

## Обзор

On-demand факт-чекинг новостей через LLM + веб-поиск (Kimi API `$web_search` + Yandex Search API).

- Доступно только для тарифов с включённым фича-флагом `factcheck` (ТЗ-208) — фактически **Premium / Club / Pro** (запуск и перепроверка). Гейт — `src/middleware/requirePremium.ts`, единый источник правды — `hasFeature(userId, 'factcheck')` (фича-флаги effective-плана, `subscription_plans.features` + `features_registry.is_active`), а не `plan_level`. Текст 403 динамический: перечисляет тарифы, где флаг включён.
- **Результат проверки виден всем пользователям**, не только Premium.
- Проверка запускается по требованию пользователя и выполняется асинхронно воркером.
- UI получает прогресс в реальном времени через **SSE** (`GET /api/news/:id/fact-check/stream`).
- Если SSE недоступен — fallback на polling `GET /api/news/:id/fact-check`.

## Pipeline v4 (видимый)

```
queued → in_progress → done
```

Внутри `in_progress` проходят 4 видимых этапа:

```
search (Kimi + Yandex RU + Yandex COM + Serper RU + Serper EN) → analysis → sources → assessment
```

1. **search** — параллельно выполняется поиск через Kimi `$web_search`, Yandex RU (`SEARCH_TYPE_RU`), Yandex COM (`SEARCH_TYPE_COM`), Serper RU (Google News) и Serper EN (Google News, только для англоязычных оригиналов). Результаты объединяются, дедуплицируются по URL и передаются дальше по цепочке сообщений.
2. **analysis** — модель генерирует развёрнутый анализ темы на русском языке в формате markdown.
3. **sources** — модель извлекает структурированный список источников из результатов поиска.
4. **assessment** — модель даёт итоговую оценку достоверности оригинального текста на основе анализа и источников.

Каждый этап отправляется в SSE и сохраняется в `fact_check_sessions`.

Реализация: OpenAI SDK используется **только как HTTP-клиент** для Kimi API (`baseURL = https://api.moonshot.ai/v1`). Запросы уходят к Kimi, не к OpenAI.

## Follow-up chain

Все 4 шага используют **один контекст `messages`**:

```
[system] + [user: текст новости]
  ├──→ assistant: $web_search tool_call  ┐
  ├──→ tool: search_result               ├──→ dedup по URL
  ├──→ Yandex RU Search API (XML/Base64)─┤
  ├──→ Yandex COM Search API (XML/Base64)┤
  ├──→ Serper RU (Google News)           ┤
  └──→ Serper EN (Google News)           ┘
  → [system: ANALYSIS]  → анализ (markdown)
  → [system: SOURCES]   → sources[] (JSON + engine badge)
  → [system: ASSESSMENT] + [user: текст + анализ + источники] → assessment (JSON)
```

Так модель на каждом шаге видит результаты поиска и может ссылаться на них.

## API endpoints

Все endpoints требуют авторизации (`Authorization: Bearer <JWT>`),
кроме явно помеченного публичного `GET /api/fact-check/shared/:token` (ТЗ-209).

### POST `/api/news/:id/fact-check`

Запуск или перезапуск проверки.

**Условия:**
- Пользователь должен быть на тарифе Premium+.
- Не более **100 проверок в час** для Premium, **300 в час** для Club/Pro.
- Если проверка уже идёт (`in_progress`) — возвращается `409`.

**Ответы:**

`201 Created` — проверка запущена впервые.
```json
{
  "job_id": "uuid",
  "status": "in_progress",
  "news_status": "in_progress",
  "limit_per_hour": 100
}
```

`200 OK` — перепроверка ранее проверенной новости.
```json
{
  "job_id": "uuid",
  "status": "in_progress",
  "news_status": "in_progress",
  "limit_per_hour": 100
}
```

`403 Forbidden` — недостаточный тариф.
```json
{
  "error": "Факт-чекинг доступен только на тарифе Premium и выше",
  "upgrade_required": true,
  "min_plan": "premium",
  "min_price": 990
}
```

`429 Too Many Requests` — превышен лимит.
```json
{
  "error": "Превышен лимит проверок. Попробуйте позже.",
  "retry_after": 3600
}
```

`409 Conflict` — проверка уже выполняется.
```json
{
  "error": "Проверка уже выполняется"
}
```

`404 Not Found` — новость не найдена.
```json
{
  "error": "Новость не найдена"
}
```

### POST `/api/news/:id/fact-check/share` (ТЗ-209)

Создать многоразовую шеринговую ссылку на результат проверки для гостей.
Любой авторизованный пользователь (результат внутри платформы виден всем,
включая Free). Реализация: `src/routes/factCheck.ts`.

**Условия и ответы:**

- Новость не найдена → `404`.
- `fact_check_status !== 'checked'` или результат с `error` → `409`
  («Результат проверки ещё не готов» / «Проверка завершилась ошибкой…»).
- У пользователя уже есть активная ссылка на эту новость → `200` с тем же
  URL (идемпотентность, квота не расходуется).
- У пользователя ≥ **20 активных** ссылок → `429` («Лимит активных ссылок
  (20). Дождитесь истечения старых.»).
- Иначе → `201`:
  ```json
  { "url": "https://pulse.inside-trade.ru/share/factcheck/<48 hex>" }
  ```

Ссылка **многоразовая** (в отличие от одноразовых `lesson_shares`, ТЗ-187),
**TTL 7 дней**. Токен — 48 hex-символов (`crypto.randomBytes(24)`).

При создании fire-and-forget пишется событие `factcheck_shared`
(`{ news_id, share_id }`) в `user_events` — метка видна в ленте активности
админки (`ActivityFeed`, иконка Share2).

### GET `/api/fact-check/shared/:token` (ТЗ-209, публичный)

Публичное чтение результата проверки по шеринговой ссылке — **без
авторизации**. Реализация: `src/routes/factCheckRequests.ts`, роут объявлен
**выше** `/:id`, иначе `shared` перехватится как id.

- Токен не 48 hex или не найден → `404` («Ссылка не найдена»).
- `expires_at` в прошлом → `410` («Срок действия ссылки истёк»); контент не
  отдаётся. Порог сравнивается на JS — шим SQLite криво транслирует `NOW()`
  (паттерн `lesson_shares`).
- Иначе `200`:
  ```json
  {
    "news": { "title": "...", "slug": "..." },
    "result": { /* FactCheckResultV4 */ }
  }
  ```

Гостевая страница (`pulse-frontend/src/pages/ShareFactCheckPage.tsx`,
роут `/share/factcheck/:token`) рендерит результат через готовый
`ResultTabs`, показывает дисклеймер «Анализ сгенерирован искусственным
интеллектом» и ставит meta `noindex`.

### GET `/api/news/:id/fact-check/stream`

SSE-стрим этапов проверки. Токен передаётся через query-параметр `?token=...`, потому что браузерный `EventSource` не поддерживает заголовки.

**События:**

```json
// этап
{ "stage": "search", "payload": { "status": "done", "sources": 5 }, "timestamp": 1234567890 }

// промежуточный результат поиска
{ "stage": "search", "payload": { "status": "sources_found", "sources": 5, "items": [...] }, "timestamp": 1234567890 }

// завершение
{ "type": "complete" }

// ошибка
{ "type": "error", "message": "..." }
```

### GET `/api/news/:id/fact-check`

Получить статус или результат проверки (fallback polling).

**Ответы:**

`200 OK` — проверка завершена.
```json
{
  "status": "checked",
  "result": {
    "version": 4,
    "analysis": "## Главное\n\nТекст новости подтверждается...",
    "sources": [
      { "site": "Reuters", "url": "https://reuters.com/...", "title": "...", "date": "2026-06-17" }
    ],
    "assessment": {
      "credibility_score": 85,
      "credibility_label": "Высокая",
      "tone": "нейтральная",
      "facts_verified": "да",
      "has_opinion_bias": false,
      "missing_context": "...",
      "manipulation_risks": "...",
      "verdict": "..."
    },
    "checked_at": "2026-06-18T12:00:00.000Z",
    "model": "kimi-k2.6",
    "error": null
  },
  "limit": {
    "per_hour": 100,
    "remaining": 87,
    "reset_in_minutes": 42
  }
}
```

`202 Accepted` — проверка в процессе.
```json
{
  "status": "in_progress",
  "job_status": "queued"
}
```

`404 Not Found` — новость не найдена или не проверялась.

## Формат результата

```typescript
interface FactCheckResultV4 {
  version: 4;
  analysis: string;           // markdown-анализ темы
  sources: FactCheckSourceV4[];
  assessment: AssessmentV4;
  checked_at: string;         // ISO 8601
  model: string;              // например, "kimi-k2.6"
  error: string | null;       // ошибка воркера, если проверка не удалась
}

interface FactCheckSourceV4 {
  site: string;
  url: string;
  title: string;
  date: string;               // YYYY-MM-DD или пустая строка
  engine?: 'kimi' | 'yandex_ru' | 'yandex_com' | 'serper_ru' | 'serper_en';
}

interface AssessmentV4 {
  credibility_score: number;  // 0-100
  credibility_label: 'Высокая' | 'Средняя' | 'Низкая' | 'Критическая';
  tone: 'нейтральная' | 'позитивная' | 'негативная' | 'манипулятивная';
  facts_verified: 'да' | 'частично' | 'нет';
  has_opinion_bias: boolean;
  missing_context: string;
  manipulation_risks: string;
  verdict: string;            // вердикт 2-3 предложения
}
```

## Frontend

- `pulse-frontend/src/components/factCheck/ProgressPanel.tsx` — 4 видимых этапа в реальном времени.
- `pulse-frontend/src/components/factCheck/ResultTabs.tsx` — табы: Анализ / Источники / Оценка. Фильтр источников по пяти поисковым движкам.
- `pulse-frontend/src/components/factCheck/SourceCard.tsx` — карточка источника.
- `pulse-frontend/src/components/factCheck/AssessmentPanel.tsx` — score, label, metrics, verdict.
- `pulse-frontend/src/components/FactCheckSection.tsx` — управление SSE, polling и отображением. Содержит кнопку шеринга (ТЗ-209): `POST /api/news/:id/fact-check/share`, показывает готовую ссылку из ответа.
- `pulse-frontend/src/hooks/useFactCheckSSE.ts` — POST + SSE + fallback polling.
- `pulse-frontend/src/pages/ShareFactCheckPage.tsx` — гостевая страница результата по ссылке `/share/factcheck/:token` (роут в `App.tsx`, lazy). Дисклеймер «Анализ сгенерирован искусственным интеллектом», meta noindex, результат через общий `ResultTabs`.

Результат отображается в `NewsDetailModal` для всех пользователей. Кнопка запуска/перепроверки — только Premium.

## Воркер

- Запускается в `startFactCheckCron()` при старте сервера.
- Опрос очереди `fact_check_jobs` каждые **5 секунд**.
- `MAX_CONCURRENT_JOBS = 3` — до 3 job'ов за тик обрабатываются последовательно; защита от двойной обработки одного job'а (в т.ч. мульти-инстанс) — атомарный захват через `locked_at` (`FOR UPDATE SKIP LOCKED` + фильтр `locked_at IS NULL`), зависшие захваты восстанавливает `recoverStuckJobs()` (locked_at старше 20 минут → job обратно в очередь).
- **Heartbeat (ТЗ-206):** `touchJob` обновляет `locked_at` между этапами pipeline и перед каждым LLM-вызовом — порог 20 минут измеряет «нет прогресса», а не общую длительность (честная проверка длится до 12,5 мин). `recoverStuckJobs` запускается при старте и по таймеру каждые 5 минут; job в ожидании ретрая (`queued`, `locked_at IS NULL`) считается живым и не трогается.
- При неудаче job перезапускается до **3 раз** с задержками 1 / 5 / 15 минут. Нефинальная ошибка эмитит в SSE `retry { attempt, delaySec }` — stream не закрывается, UI показывает статус ретрая; GET-статус отдаёт `attempts` + `next_retry_at` для polling-фолбэка. Финальная попытка эмитит `error` один раз.
- Длительность этапов и поисковых движков логируется `[FactCheckPerf] job=<id> stage=<search|analysis|sources|assessment|engine:…> durationMs=<n>` — по логам видно, где проверка проводит время.
- Повторная проверка той же новости (любым пользователем) использует закэшированный результат из `news.fact_check_result` вместо повторного вызова LLM.
- Ретраи Kimi API ограничены **2 попытками** (`KIMI_MAX_RETRIES = 2`) для снижения риска 429-шторма.
- Используемая модель: `kimi-k2.6` (переопределяется через `FACT_CHECK_MODEL`).
- Pipeline: `runFactCheckPipelineV4()` — 4 последовательных LLM-вызова с общим контекстом.
- SSE: каждый этап отправляется через `factCheckEmitters` в `GET /api/news/:id/fact-check/stream`.

## Ограничения и особенности Kimi API

- Используется **только `$web_search`**. `$fetch` не поддерживается Kimi API и удалён из pipeline.
- `$web_search` требует `tool_choice: 'auto'`.
- Для всех вызовов с tools передаётся `extra_body: { thinking: { type: 'disabled' } }`.
- Tool content передаётся обратно в Kimi через `role: 'tool'` с `content: JSON.stringify(args)`.
- OpenAI SDK используется только как HTTP-клиент; `baseURL` указывает на `https://api.moonshot.ai/v1`.

## База данных

### Таблица `news`

```sql
fact_check_status TEXT NOT NULL DEFAULT 'not_checked'
  -- not_checked | in_progress | checked
fact_check_result JSONB DEFAULT NULL
```

### Таблица `fact_check_jobs`

```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
news_id UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE
user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
status TEXT NOT NULL DEFAULT 'queued'
  -- queued | done | failed
attempts INTEGER NOT NULL DEFAULT 0
error_message TEXT
next_retry_at TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
updated_at TIMESTAMPTZ DEFAULT NOW()
UNIQUE(news_id, user_id)
```

### Таблица `fact_check_sessions`

Хранит промежуточные этапы текущей проверки.

```sql
status TEXT NOT NULL DEFAULT 'pending'
  -- pending | search | analysis | sources | assessment | completed | failed
sources_json TEXT
sources_count INTEGER DEFAULT 0
final_verdict TEXT
final_confidence INTEGER CHECK(final_confidence BETWEEN 0 AND 100)
final_reasoning TEXT
error_message TEXT
-- ТЗ-207: учёт токенов
tokens_input INTEGER          -- сумма prompt_tokens всех LLM-вызовов (ретраи суммируются)
tokens_output INTEGER         -- сумма completion_tokens
tokens_breakdown_json JSONB   -- {"search": {"in": n, "out": n}, "analysis": {...}, ...}
model TEXT                    -- фактически использованная модель
completed_at TIMESTAMPTZ      -- время закрытия сессии (success/failure/cached)
```

Сессия создаётся до проверки кэша: кэш-ветка и гвард пустого текста закрывают
её соответственно со `status='completed'` (токены 0, `tokens_breakdown_json`
= NULL) и `status='failed'`. У сессий, завершившихся до внедрения учёта,
токены равны 0 — это ожидаемо, не дефект.

### Таблица `fact_check_budget_alerts` (ТЗ-207)

```sql
alert_date TEXT PRIMARY KEY   -- UTC-дата
cost_usd REAL
checks_count INTEGER
sent_at TIMESTAMPTZ
```

Вставка идёт через `INSERT ... ON CONFLICT DO NOTHING`: алерт по дате шлётся
один раз. Порог — `DAILY_BUDGET_USD` в `src/config/factCheckPricing.ts`
(`0` = алерт выключен).

### Таблица `fact_check_shares` (ТЗ-209)

Многоразовые шеринговые ссылки на результат проверки для гостей.

```sql
id UUID PRIMARY KEY DEFAULT gen_random_uuid()
token VARCHAR(64) NOT NULL UNIQUE   -- 48 hex
news_id UUID NOT NULL REFERENCES news(id) ON DELETE CASCADE
owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
expires_at TIMESTAMPTZ NOT NULL     -- TTL 7 дней
created_at TIMESTAMPTZ DEFAULT NOW()
```

Индексы: `idx_fc_shares_owner_exp (owner_user_id, expires_at)` — под квоту
и идемпотентность, `idx_fc_shares_news (news_id)`. DDL продублирован в
`src/index.ts` (PG) и `src/config/db-sqlite.ts` (SQLite).

## Учёт токенов и админ-таб «Фактчекинг» (ТЗ-207)

`src/config/factCheckPricing.ts` фиксирует тарифы Kimi (in $0.95/M, out
$4/M, web-search $0.005/вызов) и `computeCostUsd()`. Метер
(`FactCheckTokenMeter`) проброшен через шаги pipeline v4 и суммирует
`completion.usage` по этапам; вызовы с тулколлом web-search считаются
отдельно. После закрытия сессии fire-and-forget вызывается
`checkDailyBudgetAlert()`: при превышении дневного бюджета админам уходит
алерт `factcheck_budget` (реестр — `src/services/adminAlerts.ts`).

Админ-эндпоинты (`src/routes/adminFactChecking.ts`, все за
`adminMiddleware`, mounted на `/api/admin`):

- `GET /api/admin/fact-checking/stats?days=N` — сводка (checks/completed/
  failed/cached/success_rate/cache_rate/tokens in+out/cost_llm+cost_total/
  avg/retried_share), средние токены по этапам `stage_avgs`, подневной ряд
  `daily`, `top_users`, разбивка `errors`, `pricing`.
- `GET /api/admin/fact-checking/list?from&to&status&user_query&page&page_size`
  — история сессий, `page_size` ≤ 200, ответ `{rows, total}`; `cost_usd` и
  `duration_sec` считаются на JS-стороне.
- `GET /api/admin/fact-checking/:sessionId` — детальная карточка:
  `tokens_breakdown` распарсен из JSON, `sources` — первые 20.

Фронт: таб «Фактчекинг» в админке после «МСП»
(`src/pages/admin/FactCheckingTab.tsx`) — KPI, графики токенов/стоимости,
фильтры, пагинация, CSV-экспорт, детальный просмотр.

## Переменные окружения

| Переменная | Описание | По умолчанию |
|---|---|---|
| `KIMI_API_KEY` | API-ключ Kimi | — |
| `YANDEX_SEARCH_API_KEY` | API-ключ Yandex Search API (приоритетное имя) | — |
| `YANDEX_API_KEY` | Fallback API-ключ Yandex Search API | — |
| `SERPER_API_KEY` | API-ключ Serper (Google News) | — |
| `FACT_CHECK_MODEL` | Модель для факт-чекинга | `kimi-k2.6` |
| `USE_SQLITE` | `true` — SQLite, иначе PostgreSQL | — |

## Логи

Воркер пишет ключевые шаги в консоль:

```
[FactCheckWorker] Processing job <id> for news <id>
[FactCheckLLM] Attempt 1/2 failed (status=429), retrying in 1000ms...
[FactCheckWorker] News fact_check updated to checked (v4)
```


## Уведомления о результате проверки

После завершения проверки (включая повторное использование закэшированного результата) воркер вызывает `sendFactCheckNotifications()` в режиме fire-and-forget:

- **Email** — HTML-письмо на основе шаблона `templates/fact-check-result.html`.
- **Telegram** — краткий отчёт в формате `MarkdownV2` со ссылками на источники и кнопкой "Открыть в приложении".

Отправка не блокирует pipeline и не влияет на статус job'а. Пользователь управляет каналами через матрицу уведомлений:

- Продукт: `fact_check`.
- Каналы: `telegram`, `email`.
- API: `GET /api/user/notification-matrix`, `PUT /api/user/notification-matrix`.

Если у пользователя не подключён соответствующий канал (Telegram-бот или email) или отключена ячейка `fact_check`/`канал`, отправка пропускается.

Telegram-отправка использует `sendTelegramMessage(..., 'MarkdownV2')`.
