# Ad-hoc фактчекинг (Fact-Check Requests API)

## Обзор

Проверка произвольного ввода пользователя — **текст, ссылка, картинка или файл** —
через существующий LLM-pipeline v4 (поиск → анализ → источники → оценка).
Пайплайн по модели, промптам и формату результата (`FactCheckResultV4`) не меняется,
меняется только способ получения входного текста и хранение результата.

- Запуск проверки — только для тарифов **Premium / Club / Pro** (гейт `requirePremium`,
  как в новостном фактчеке). Лимитов на количество проверок нет.
- **Все пользовательские проверки частные** (v1): `is_public` принудительно `false`,
  публикация в общую ленту заблокирована до v2 вместе с модерацией.
- Проверка выполняется асинхронно воркером; прогресс — через **SSE**
  (`GET /api/fact-check/:id/stream`), fallback — polling `GET /api/fact-check/:id`.
- Общая лента (`GET /api/fact-check/feed`) — публичная, но в v1 содержит **только
  проверенные новости PULSE** (`news.fact_check_status = 'checked'`); автор проверки
  в выдаче не присутствует.
- Email/Telegram-уведомления для ad-hoc проверок в v1 **не отправляются**.

Реализация: `src/services/factCheckRequests.ts` (сервис + воркер),
`src/routes/factCheckRequests.ts` (роуты, mount — `/api/fact-check`).
ТЗ: `TZ_FACTCHECK_PAGE.md` (v1.3).

## API endpoints

### POST `/api/fact-check` — запуск проверки

Авторизация + Premium+. Тело:

```json
{ "input_type": "text|url|image|file",
  "text": "...",            // для text
  "url": "...",             // для url
  "file_base64": "...",     // для image/file
  "file_name": "...",       // для image/file
  "mime": "..."             // для image/file
}
```

Поле `is_public` из тела **игнорируется** — сервер всегда пишет `false`.

| Тип | Извлечение текста |
|---|---|
| `text` | Как есть, 20–8000 символов |
| `url` | `extractFromUrl()`: axios GET (timeout 20s, ≤ 3 МБ, браузерный UA) → заголовок (og:title → `<title>`) → абзацы `<p>` ≥ 40 символов, fallback — текст `<body>`. Минимум 100 символов |
| `image` | base64 → Kimi Files API (`purpose: file-extract`, OCR) → текст |
| `file` | base64 → Kimi Files API (`file-extract`) → текст |

Бинарное содержимое **не сохраняется** нигде: ни в БД, ни на диске —
только имя файла и извлечённый текст (до 8000 символов).

**Ответы:**
- `201` `{ id, status: "queued", reused: false, title, extracted_text (500), result: null }`
- `200` — дедуп: повтор той же ссылки/текста/содержимого файла → новая запись
  с user_id заказчика и скопированным результатом: `{ ..., status: "checked", reused: true, result }`. LLM не вызывается.
- `400` — валидация входа (слой 1: длина, ≥3 слов, не повтор символа, есть буквы, не эмодзи-спам)
- `403` — тариф (`upgrade_required`) или нет согласия на передачу файла оператору ИИ (`consent_required`, только image/file)
- `422` — ошибка извлечения (`extraction_failed: true`) или LLM-префильтр (`not_verifiable: true`, мнение/вопрос/бессвязный текст)

**Валидация входа — 3 слоя:**
1. Правила (в роуте, до очереди) — см. `400` выше.
2. LLM-префильтр (перед очередью): один дешёвый вызов (`max_tokens: 10`),
   классификация `FACT / OPINION / NONSENSE / QUESTION`. Отключается env
   `FACT_CHECK_PREFILTER` (default `true`). При ошибке или непарсимом ответе — **fail-open**
   (пропуск в очередь) + лог `[FactCheckPrefilter] unparsed`.
3. Поле `verifiable` в результате оценки (`assessment.verifiable`, default `true` для
   старых результатов): `verifiable: false` показывается владельцу, но не попадает
   в общую ленту.

### GET `/api/fact-check/feed?limit=30&offset=0` — общая лента

Публичный. В v1 — **только проверенные новости PULSE** (`kind: "news"`):
`{ kind, id, title, snippet (500), url, status, result, published_at, created_at }`.
Пользовательских проверок в ленте нет (даже закомментированной ветки `kind:"request"` нет),
`user_id` в выдаче отсутствует. Новости с `assessment.verifiable === false` исключаются.

### GET `/api/fact-check/my?limit=50&offset=0` — мои проверки

Авторизация. Ad-hoc проверки пользователя (все статусы, включая частные,
`kind: "request"`) + новости, по которым пользователь заказывал фактчек
(`fact_check_jobs.user_id`, `kind: "news"`, JOIN `news`). Единый список по дате создания.

### GET `/api/fact-check/:id` — статус/результат

Авторизация. Владелец — всё (включая полный `extracted_text`).
Чужая проверка — всегда `403` (публичных пользовательских проверок в v1 нет).

### GET `/api/fact-check/:id/stream` — SSE прогресс

Только владелец (авторизация — `?token=`). События:
`{ stage, payload, timestamp }`, `{ type: "complete" }`, `{ type: "error", message }`.
Уже завершённой проверке — сразу `complete`/`error`.
SSE-эмиттеры — общий реестр с новостным фактчеком (`services/factCheck.ts`),
ключ `requestId + userId`.

### PATCH `/api/fact-check/:id/visibility` — ⛔ отключён в v1

Всегда `403 { error: "visibility_locked", message: "Публикация в общую ленту будет доступна в следующих версиях" }`.
Endpoint оставлен, чтобы v2 свёлся к снятию заглушки.

### PUT `/api/user/ai-consent` — согласие на передачу файлов оператору ИИ

Авторизация. `{ granted: boolean }` → `users.ai_file_consent_at` (timestamp или NULL).
Без согласия `POST /api/fact-check` с `input_type: image|file` отвечает
`403 consent_required`. Флаг возвращается в `GET /api/auth/me` как `ai_file_consent: boolean`
(синхронизируется между устройствами). Отзыв не влияет на прошлые проверки.

## База данных

### `fact_check_requests`

| Колонка | Тип | Примечание |
|---|---|---|
| `id` | UUID PK | |
| `user_id` | UUID → users, ON DELETE CASCADE | владелец |
| `input_type` | TEXT CHECK | `text` / `url` / `image` / `file` |
| `input_raw` | TEXT | url / имя файла (для text — NULL) |
| `input_hash` | TEXT | `sha256(input_type + ':' + normalized)` — дедуп |
| `title` | TEXT | заголовок статьи / первые 120 символов / имя файла |
| `extracted_text` | TEXT | проверяемый текст (до 8000) |
| `status` | TEXT | `queued` / `in_progress` / `checked` / `failed` |
| `result` | JSONB (SQLite: TEXT) | `FactCheckResultV4` |
| `error_message` | TEXT | |
| `is_public` | BOOLEAN | **NOT NULL DEFAULT FALSE** (v1: всегда FALSE) |
| `attempts` | INTEGER | счётчик попыток воркера |
| `next_retry_at` | TIMESTAMPTZ | отложенный ретрай |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

Индексы: `(user_id, created_at DESC)`, `(status)`, `(input_hash)`,
`(is_public, status, created_at DESC)`.

### `users.ai_file_consent_at`

TIMESTAMPTZ NULL — согласие на передачу файлов оператору ИИ
(NULL — не давал/отозвал).

### Нормализация `input_hash` (дедуп)

- `text` — trim + схлопнуть повторные whitespace + Unicode NFC, **без** lower-case;
- `url` — `scheme://host(lower)/path` без query/fragment/utm-меток и trailing slash;
- `image`/`file` — хэш от `extracted_text` (дедуп по содержимому, а не имени файла).

## Воркер

`startFactCheckRequestCron()` (запускается из `index.ts`):
- опрос `status = 'queued'` каждые **5 сек**, до **3** проверок последовательно за тик;
- обработка: `runFactCheckPipelineV4(requestId, userId, extracted_text, title, null, null)` —
  `sessionId = null`, записи в `fact_check_sessions` не создаются;
- ретраи до 3 попыток: задержки **1 / 5 / 15 мин** через `next_retry_at`;
  после 3-й попытки — `status = 'failed'`, SSE `error`;
- `recoverStuckRequests()` на старте: зависшие `in_progress` → `queued`,
  `next_retry_at = NULL`, `attempts = attempts + 1` (защита от бесконечного crash-loop).

## Приватность (v1)

- Все проверки частные: `is_public = FALSE` принудительно (в т.ч. игнор поля в POST,
  бут-миграция `UPDATE fact_check_requests SET is_public = FALSE`);
- в общей ленте пользовательских проверок нет, `user_id` не отдаётся;
- чужая проверка по прямой ссылке → `403`; `PATCH visibility` → `403 visibility_locked`;
- бинарные файлы не хранятся — только имя файла и извлечённый текст;
- файлы для извлечения текста передаются оператору ИИ (Moonshot AI / Kimi) только после
  явного согласия пользователя (`PUT /api/user/ai-consent`), которое можно отозвать
  в профиле (вкладка «Ваши данные»).
