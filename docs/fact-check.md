# Факт-чекинг новостей (Fact-Check API)

## Обзор

On-demand факт-чекинг новостей через LLM + веб-поиск (Kimi API `$web_search` + Yandex Search API).

- Доступно только для тарифов **Premium / Club / Pro** (запуск и перепроверка).
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

Все endpoints требуют авторизации (`Authorization: Bearer <JWT>`).

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
- `pulse-frontend/src/components/FactCheckSection.tsx` — управление SSE, polling и отображением.
- `pulse-frontend/src/hooks/useFactCheckSSE.ts` — POST + SSE + fallback polling.

Результат отображается в `NewsDetailModal` для всех пользователей. Кнопка запуска/перепроверки — только Premium.

## Воркер

- Запускается в `startFactCheckCron()` при старте сервера.
- Опрос очереди `fact_check_jobs` каждые **5 секунд**.
- `MAX_CONCURRENT_JOBS = 3` — до 3 job'ов обрабатываются параллельно.
- При неудаче job перезапускается до **3 раз** с задержками 1 / 5 / 15 минут.
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
```

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

Отправка не блокирует pipeline и не влияет на статус job'а. Пользователь управляет каналами через два переключателя:

- `notification_settings.fact_check_email_enabled` — email-отчёт.
- `notification_settings.fact_check_tg_enabled` — Telegram-отчёт.

API для управления: `GET /api/user/notifications` и `PATCH /api/user/notifications`.

Telegram-отправка использует `sendTelegramMessage(..., 'MarkdownV2')`. Если у пользователя не подключён Telegram-канал или отключён соответствующий флаг, отправка пропускается.
