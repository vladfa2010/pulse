# MCP (Model Context Protocol) — доступ ИИ-агентов к данным Пульса

> ТЗ-183 (read-only контур + токены в ЛК) + ТЗ-185 (админ-таба «МСП»).
> Дата: 2026-10-19. Транспорт: Streamable HTTP, эндпоинт `/mcp` внутри `pulse-backend`.

## Как подключиться (для пользователя)

1. Личный кабинет → раздел **«API / MCP»** → «Создать токен» (максимум 5 активных,
   срок жизни 180 дней; полный токен показывается **один раз**).
2. Конфиг MCP-клиента (Claude Desktop / Cursor / VS Code):

```json
{
  "mcpServers": {
    "pulse": {
      "url": "https://pulse.inside-trade.ru/mcp",
      "headers": { "Authorization": "Bearer pulse_mcp_<ваш_токен>" }
    }
  }
}
```

3. Токен — только в заголовке `Authorization: Bearer` (ИБ-2). Не коммитьте токен
   в репозитории и не пересылайте его (ИБ-6). Отзыв — в ЛК, мгновенно.

## Архитектура

- **Caddy-прокси** (`deploy/Caddyfile`): `@mcp path /mcp /mcp/*` + `handle @mcp`
  → backend (ТЗ-183; точный матч — ТЗ-187: wildcard `/mcp*` перехватывал бы
  будущие SPA-маршруты вида `/mcp-…`, а `handle` не принимает список путей
  даже в Caddy 2.11.4 — матчинг через named matcher). Без этого правила
  Caddy отдавал SPA-шелл (200 с index.html) — MCP-клиент получал мусор
  вместо JSON-RPC. Живость контура снаружи — `GET /debug/mcp` (тоже прокси).
- **Транспорт**: `POST/GET/DELETE /mcp` — `@modelcontextprotocol/server`
  (`createMcpHandler`, фабрика на запрос) + `@modelcontextprotocol/node`
  (`toWebRequest`). Обе эры протокола (2025-11-25 и 2026-07-28) обслуживаются
  одной фабрикой; отдельно ничего не выключаем.
- **Фабрика** (`src/mcp/server.ts`): `buildServer(ctx)` создаёт `McpServer`
  с инструментами по роли контекста. Один инстанс на все запросы падает со
  второго (требование SDK v2) — поэтому фабрика на запрос. Контекст запроса
  (`{ tokenId, userId, isAdmin, scopes, ip, userAgent }`) течёт в фабрику
  через `AsyncLocalStorage` (`mcpContextStorage`) — `McpRequestContext.requestInfo`
  исходный Request не гарантирует.
- **Цепочка `/mcp`** (`src/mcp/index.ts`): парсер тела `express.json({ limit: '1mb' })`
  (ТЗ-189 — первая ступень, до auth; глобальный 15-МБ парсер исключён из `/mcp`
  через type-callback, у body-parser нет `skip`) → Origin-валидация →
  аутентификация токена → `mcpLimiter` (120/15 мин на токен) → счётчики →
  `handler.fetch`. Общий `apiLimiter` для `/mcp` отключён skip-функцией
  (иначе двойной учёт).
- **Аутентификация** (`src/mcp/context.ts`): только заголовок Bearer →
  SHA-256 → `mcp_tokens` (не отозван, не истёк) → свежий
  `SELECT is_admin, is_blocked FROM users` (конвенция ТЗ-120: блок/снятие
  админа действуют мгновенно). Единый 401 «Invalid token» без различения
  причины (ИБ-6); `is_blocked` → 403.

## Инструменты (read-only, писалок нет)

Аннотации у всего релиза: `readOnlyHint: true`, `destructiveHint: false`,
`openWorldHint: false`. Схемы аргументов — zod `.strict()` (ИБ-7).

Базовые (любой валидный токен): `news_search`, `news_get`,
`calendar_events`, `sentiment_index`, `radio_config`,
`education_my_progress`, `education_my_attempts`.

Админские (дополнительно, регистрируются только при свежем `is_admin`):
`admin_metrics` (секции из `GET /api/admin/metrics`), `admin_radio_cache`
(ТЗ-65). Не-админ их не видит в `tools/list`; вызов → JSON-RPC `-32602`
(инструмент не зарегистрирован — не раскрываем наличие админ-контура).

`admin_education_stats` / `admin_course_stats` (ТЗ-180/181) — минорным
релизом, когда стабилизируются зависимости (план, Этап 6).

Ответы инструментов: ограничение числа записей + обрезка длинных текстов
(~2000 символов с пометкой обрезки) — защита от раздувания контекста клиента.

## Аудит (`mcp_audit_log`)

Запись на каждый вызов инструмента (даже упавший) и на админские действия
над токенами (`tool = 'admin.revoke_token'` — ТЗ-185). Поля: `token_id`
(сам токен НИКОГДА не пишется), `user_id`, `tool`, `args` (JSON, обрезка 4 КБ),
`status` (ok/error), `duration_ms`, `ip` (≤45), `user_agent` (≤256),
`created_at`. Срок хранения — 90 дней, автоочистка кроном 06:20 МСК
(`startMcpCron`, ИБ-5).

## Токены (`mcp_tokens`)

| колонка | назначение |
|---|---|
| `id`, `user_id`, `name` | идентификация |
| `token_hash` | SHA-256(hex) токена, unique; значение недоступно никому, включая админов |
| `prefix` | первые 22 символа + «…» для отображения |
| `scopes` | пока всегда `'read'` (конвенция под писалки, ИБ-3) |
| `created_at`, `expires_at` | срок жизни 180 дней (ИБ-1) |
| `last_used_at` | throttled, не чаще раза в час на токен |
| `revoked_at`, `revoked_by` | soft revoke; `revoked_by` — admin id (NULL — владелец в ЛК) |
| `requests_count` | in-memory счётчик + flush раз в минуту (`src/mcp/counters.ts`) |

Эндпоинты ЛК: `GET/POST/DELETE /api/user/mcp-tokens` (макс 5 активных → 409).
Email-уведомления (`src/services/mcpEmails.ts`): создание (название, время,
IP), первое использование (детектор компрометации), ротация за 7 дней
(крон), принудительный отзыв админом. Quiet hours юзера учитываются.

## Админ-таба «МСП» (ТЗ-185)

- `GET /api/admin/mcp/tokens?q=&status=active|revoked|expired&sort=created_at|last_used_at|requests_count&dir=asc|desc`
  — реестр (JOIN users; LIMIT 500; `token_hash` не отдаётся никогда).
- `POST /api/admin/mcp/tokens/:id/revoke` — идемпотентно; `revoked_by` +
  email владельцу + аудит `admin.revoke_token`.
- Фронт: `pulse-frontend/src/pages/admin/McpTab.tsx`, таба «МСП» в `Admin.tsx`.

## Лимиты и обслуживание

- `mcpLimiter`: 120 запросов / 15 мин на токен (ключ — `mcpTokenId`).
- `mcpAuthLimiter`: 20 неудачных auth / 15 мин на IP — применяется вручную
  только на неудачу (`checkRateLimit` в цепочке `/mcp`), иначе легитимные
  401-штормы съели бы лимит у честных IP.
- Крон 06:20 МСК (`startMcpCron`): аудит старше 90 дней; токены
  (отозванные/истёкшие старше 90 дней); напоминания о ротации (окно 7 дней).
- `GET /debug/mcp` без токена — только `{ status: 'ok' }` (ИБ-9).
- Миграция: `POST /migrate-mcp?secret=<CRON_SECRET>` → `src/migrations/mcp_v1.sql`
  (SQLite-вариант — в `initSQLiteSchema()`).

## Безопасность (нормативные требования ТЗ-183)

- **ИБ-1** `expires_at` = 180 дней; истёкший → 401; напоминание за 7 дней; срок виден в ЛК.
- **ИБ-2** токен только из заголовка Bearer; `?token=` → 401; токен не в логах/аудите/URL.
- **ИБ-3** допуск = пересечение scope инструмента и scopes токена из строки БД.
- **ИБ-4** `userId` только из контекста токена; `user_id` аргументом не принимается; zod `.strict()`.
- **ИБ-5** аудит 90 дней с автоочисткой; значения токенов админке недоступны (только метаданные + отзыв).
- **ИБ-6** `mcpAuthLimiter` 20 неудач / 15 мин на IP; единый неинформативный 401.
- **ИБ-7** zod `.strict()` + ограничения длин/окон на всех инструментах.
- **ИБ-8** ip (≤45) и user_agent (≤256) в аудите.
- **ИБ-9** `/debug/mcp` — только `{status:'ok'}`.
- **ИБ-10** email при создании и первом использовании; ротационные напоминания.
- **ИБ-11** минорные версии `@modelcontextprotocol/*` зафиксированы (`~2.3.1`,
  `~2.0.2`, `~2.1.1`); `npm run audit` (`npm audit --audit-level=high`) —
  перед деплоем; advisories — подписка ответственного.

Не-цель релиза: OAuth 2.1 + PKCE (отдельное ТЗ при открытии сторонним
клиентам); писалки (отдельное ТЗ после догфудинга).

## Тестирование

```bash
# live-API против окружения (только чтение + свои токены; самоочистка):
API_URL=https://pulse.inside-trade.ru/api ADMIN_EMAIL=<email> ADMIN_PASSWORD=<pwd> \
  npx ts-node src/tests/mcpReadonly.test.ts
API_URL=https://pulse.inside-trade.ru/api ADMIN_EMAIL=<email> ADMIN_PASSWORD=<pwd> \
  npx ts-node src/tests/adminMcpTokens.test.ts

# mcpAuthLimiter (20 неудач → 429): ВНИМАНИЕ — блокирует IP на 15 мин, локально:
RUN_AUTH_FLOOD=1 npx ts-node src/tests/mcpReadonly.test.ts
```

Ручная проверка через MCP Inspector:
`npx @modelcontextprotocol/inspector` → Streamable HTTP →
`http://localhost:3001/mcp` → Headers: `Authorization: Bearer pulse_mcp_…`.
