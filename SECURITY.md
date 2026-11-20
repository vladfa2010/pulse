# Политика безопасности backend PULSE

Этот документ описывает правила работы с секретами для backend-части PULSE.

---

## Что считается секретом

Никогда не коммитьте в git и не публикуйте в открытом доступе:

- `TELEGRAM_BOT_TOKEN`
- `JWT_SECRET`
- `DB_PASSWORD`
- `FIREBASE_SERVICE_ACCOUNT_BASE64`
- `YOOKASSA_SECRET_KEY`
- `RESEND_API_KEY`, `EMAIL_PROVIDER`, `EMAIL_FROM`
- `TRANSLATION_API_KEY`
- API-токены и приватные ключи
- `.env`-файлы

## Где хранить секреты

### Локально

В файле `pulse-backend/.env` (добавлен в `.gitignore`).

Используйте `.env.example` только как шаблон с плейсхолдерами (`your_...`), без реальных значений.

### Production / Render

Все секреты передаются через **Environment Variables** сервиса `pulse-api`:

```
TELEGRAM_BOT_TOKEN=
JWT_SECRET=
DB_PASSWORD=
FIREBASE_SERVICE_ACCOUNT_BASE64=
YOOKASSA_SECRET_KEY=
EMAIL_PROVIDER=
EMAIL_FROM=
RESEND_API_KEY=
```

### CI/CD

Если добавите GitHub Actions для backend, используйте **GitHub Repository Secrets** (`secrets.*`), а не plaintext в workflow.

---

## Firebase service account

- Локальный JSON-файл service account (`firebase-adminsdk-*.json`) не должен лежать в репозитории.
- На Render используется base64-кодированное содержимое JSON в переменной `FIREBASE_SERVICE_ACCOUNT_BASE64`.
- Если ключ мог быть скомпрометирован — удалите его в Firebase Console и создайте новый.

---

## Что делать при утечке

1. Отзовите скомпрометированный токен/ключ в сервисе-поставщике.
2. Сгенерируйте новый.
3. Обновите:
   - локальный `.env`;
   - Environment Variables на Render;
   - GitHub Secrets, если используются.
4. Перезапустите деплой backend.
5. Проверьте логи.

---

## Общая политика проекта

См. [`../pulse-frontend/SECURITY.md`](../pulse-frontend/SECURITY.md).

## Edge rate limiting (ТЗ-190)

**Решение (2026-10-21): вариант C — ничего не строить на edge, мониторить.** Backend-лимитеры `/mcp` (`mcpAuthLimiter` 20 неудач/15 мин на IP, `mcpLimiter` 120/15 мин на токен) рабочие, per-IP/per-token бакеты корректны (`trust proxy = 1`, XFF от Caddy проверены). Кастомная сборка Caddy с плагином rate-limit — операционный риск для единственного ingress-контура ради угрозы, которой сегодня нет.

**Критерий пересмотра** (наступления любого из):
- мусорные 401 > 10 % трафика `/mcp` в сутки;
- backend-контейнер под нагрузкой мусорных запросов (CPU/память);
- зафиксированный инцидент/перебор в логах.

При наступлении — вариант B (fail2ban по логам Caddy на 401/429 с `/mcp`), отдельным ТЗ на внедрение.

**Мониторинг до пересмотра:** ежедневный крон 06:40 МСК (`startMcpSecurityCron`) считает счётчики `mcp_security_daily` (записывает `src/mcp/securityStats.ts` на каждый запрос /mcp), сверяет вчерашний день со средним за 7 дней и при превышении порогов пишет в `mcp_security_alerts` + шлёт Telegram-алерт админу (`TELEGRAM_ADMIN_CHAT_ID`). Лента видна в админке: таба «МСП» → «Безопасность /mcp». Дни с трафиком < 50 запросов не оцениваются (защита от x10-от-нуля). Сырые цифры — таблица `mcp_security_daily` (+ `mcp_security_daily_ips` для уникальных IP).

## Безопасные заголовки (ТЗ-188)

**Фаза 1 — включено 20.11.2026** (report-only, коммит `fc31fb1`). В `(common)` Caddyfile
(`deploy/Caddyfile`): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/mic/
geolocation/payment отключены) + `Content-Security-Policy-Report-Only` — сбор нарушений
3–7 дней перед enforce (Задача 3, отдельным revert-able коммитом).

CSP report-only (инвентаризация 20.11 — `telegram.org`/`oauth.telegram.org` Login Widget,
`mc.yandex.ru` Metrika, плееры уроков youtube-nocookie/rutube/vkvideo/vimeo):

```
default-src 'self'; img-src 'self' data: https:; media-src 'self';
style-src 'self' 'unsafe-inline'; script-src 'self' https://telegram.org https://mc.yandex.ru;
connect-src 'self' wss: https://mc.yandex.ru; font-src 'self' data:;
frame-src https://www.youtube.com https://www.youtube-nocookie.com https://rutube.ru
  https://vkvideo.ru https://player.vimeo.com https://oauth.telegram.org;
frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

HSTS намеренно не включён (решение вне scope ТЗ — см. «Риски» ТЗ-188).

## Debug-эндпоинты: guard (ТЗ-186)

**Находка Medium ИБ-аудита 2026-10-19 — закрыта 21.11.2026** (коммит ТЗ-186).
Десятки `/debug*` без авторизации «прятались» за Caddy-SPA-фолбэком (маскировка,
не защита). Решение: единый middleware `src/middleware/debugGuard.ts` на префикс
`/debug` — allowlist из двух осознанно публичных путей (`/debug/mcp` — мониторинг
MCP, ИБ-9; `/debug/version` — хэш коммита), всё остальное — заголовок
`x-debug-secret` (`DEBUG_SECRET_KEY`, fallback `CRON_SECRET_KEY` на один релиз).
Отказ — 404 (не подсвечиваем существование), без секретов — fail-closed.
Caddyfile не менялся (эндпоинты остаются замаскированными фолбэком, но больше не
беззащитны при прямом доступе/будущем проксировании).
