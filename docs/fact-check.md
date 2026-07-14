# Факт-чекинг новостей (Fact-Check API)

## Обзор

On-demand факт-чекинг новостей через LLM + веб-поиск (Kimi API `$web_search` / `$fetch`).

- Доступно только для тарифов **Premium / Club / Pro**.
- Проверка запускается по требованию пользователя и выполняется асинхронно воркером.
- UI получает прогресс в реальном времени через **SSE** (`GET /api/news/:id/fact-check/stream`).
- Если SSE недоступен — fallback на polling `GET /api/news/:id/fact-check`.

## Pipeline v3 (видимый)

```
queued → in_progress → done
```

Внутри `in_progress` проходят 5 видимых этапов:

```
queries → search → fetch → claims → verdict
```

1. **queries** — модель выделяет проверяемые claims.
2. **search** — модель ищет независимые источники через `$web_search`.
3. **fetch** — при необходимости читает конкретные URL через `$fetch`.
4. **claims** — разбор вердиктов по каждому claim.
5. **verdict** — итоговый вердикт и confidence.

Каждый этап отправляется в SSE и сохраняется в `fact_check_sessions`.

Реализация: OpenAI SDK как HTTP-клиент для Kimi API (`baseURL = https://api.moonshot.ai/v1`). Запросы уходят к Kimi, не к OpenAI.

## API endpoints

Все endpoints требуют авторизации (`Authorization: Bearer <JWT>`).

### POST `/api/news/:id/fact-check`

Запуск или перезапуск проверки.

**Условия:**
- Пользователь должен быть на тарифе Premium+.
- Не более **10 проверок в час** для Premium, **30 в час** для Club/Pro.
- Если проверка уже идёт (`in_progress`) — возвращается `409`.

**Ответы:**

`201 Created` — проверка запущена впервые.
```json
{
  "job_id": "uuid",
  "status": "in_progress",
  "news_status": "in_progress"
}
```

`200 OK` — перепроверка ранее проверенной новости.
```json
{
  "job_id": "uuid",
  "status": "in_progress",
  "news_status": "in_progress"
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
  "error": "Превышен лимит проверок. Попробуйте позже."
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
{ "stage": "queries", "payload": { "status": "done", "claims": 5 }, "timestamp": 1234567890 }

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
    "verdict": "reliable",
    "claims": [...],
    "sources": [...],
    "confidence": 90,
    "checked_at": "2026-06-18T12:00:00.000Z",
    "model": "kimi-k2.6",
    "error": null
  }
}
```

`202 Accepted` — проверка в процессе.
```json
{
  "status": "in_progress",
  "job_status": "searching"
}
```

`404 Not Found` — новость не найдена или не проверялась.

## Формат результата

```typescript
interface FactCheckResult {
  verdict: 'reliable' | 'partly_reliable' | 'unreliable' | 'unverified' | null;
  claims: VerifiedClaim[];
  sources: FactCheckSource[];
  confidence: number;      // 0-100
  checked_at: string;      // ISO 8601
  model: string;           // например, "kimi-k2.6"
  error: string | null;    // ошибка воркера, если проверка не удалась
}

interface VerifiedClaim {
  id: number;
  text: string;
  category: string;
  search_query: string;
  verdict: 'confirmed' | 'partly_true' | 'unconfirmed' | 'false';
  explanation: string;
  source: string;
  confidence: number;
  sources?: { name: string; url: string }[];
}

interface FactCheckSource {
  name: string;
  url: string;
}
```

## Воркер

- Запускается в `startFactCheckCron()` при старте сервера.
- Опрос очереди `fact_check_jobs` каждые **10 секунд**.
- `MAX_CONCURRENT_JOBS = 1` — job'ы обрабатываются по одному.
- При неудаче job перезапускается до **3 раз** с задержками 1 / 5 / 15 минут.
- Используемая модель: `kimi-k2.6` (переопределяется через `FACT_CHECK_MODEL`).
- Pipeline: `runFactCheckPipeline()` — async generator, до 5 итераций tool_calls (`$web_search` / `$fetch`).
- SSE: каждый этап отправляется через `factCheckEmitters` в `GET /api/news/:id/fact-check/stream`.

## Ограничения и особенности Kimi API

- `$web_search` требует `tool_choice: 'auto'`.
- Для вызовов с tools передаётся `tool_choice: 'auto'` (SDK сам управляет остальными параметрами).
- Таймаут для end-to-end вызова — **300 секунд** (реальный поиск занимает 2-5 минут).
- Tool content передаётся обратно в Kimi **as-is** (`content: toolCall.function.arguments`), без `JSON.parse/stringify`.

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

## Переменные окружения

| Переменная | Описание | По умолчанию |
|---|---|---|
| `KIMI_API_KEY` | API-ключ Kimi | — |
| `FACT_CHECK_MODEL` | Модель для факт-чекинга | `kimi-k2.6` |
| `USE_SQLITE` | `true` — SQLite, иначе PostgreSQL | — |

## Логи

Воркер пишет ключевые шаги в консоль:

```
[FactCheckWorker] Processing job <id> for news <id>
[FactCheckWorker] Claims extracted: 4
[FactCheckWorker] Search result length: 4523 chars
[FactCheckWorker] Claim [1] verdict: confirmed, confidence: 95, sources: 2
[FactCheckWorker] Result computed: { verdict: 'reliable', claims: 4 }
[FactCheckWorker] News fact_check updated to checked
```
