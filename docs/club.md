# Клуб — закрытый Telegram-канал по тарифу

> ТЗ-197-club · бэкенд `781e82f`, фронтенд `c105b25` (8.6.54).
> Актуальность: 2026-10-27. Админ-рунбук: [docs/admin/club.md](admin/club.md).
> Код: `src/services/club.ts`, `src/routes/club.ts`, `src/services/telegram.ts`
> (функции клуба), фронт — `pulse-frontend/src/pages/account/ClubTab.tsx`.

---

## 1. Продуктовая механика

Закрытый Telegram-канал, куда пользователь входит по **одноразовой персональной
ссылке-приглашению**. Доступ определяется платформой, а не Telegram:

- **По тарифу** — план содержит фичу `club_access` (`features_registry`,
  grace-aware: +3 дня после окончания подписки, `GRACE_DAYS = 3`).
- **Вручную** — админ выдал доступ по email из админки (`is_manual = TRUE`,
  `manual_revoked_at IS NULL`). Не сносится аудитом без тарифа.

**Токенов нет.** Одноразовый хеш ссылки (`t.me/+XXXX`) генерирует Bot API
(`createChatInviteLink`, `member_limit = 1`, без `expire_date` — ссылка жива,
пока не использована или не отозвана). Платформа лишь запрашивает и отзывает
ссылки. Лимит на перевыпуск — 10 ссылок/час на пользователя (`clubInviteLimiter`).

## 2. Пользовательский флоу (ЛК → «Клуб»)

Вкладка видна **всем** пользователям без гейтинга — для неподписчиков это
витрина-апсейл. Пять состояний:

1. **Нет тарифа** — апсейл-карточка: описание клуба, цена из `/api/plans`
   (без хардкода), кнопка «Смотреть тариф» → `/pricing`.
2. **Тариф есть, Telegram не привязан** — инструкция + флоу привязки
   (`/api/telegram/link` + поллинг `/user/telegram-status` каждые 5 с,
   до 2 минут; 409 `telegram_not_connected` от invite расшифровывается сюда же).
3. **Привязан, не в канале** — кнопка «Получить ссылку» → `POST /api/club/invite`
   → одноразовая ссылка с копированием и кнопкой перехода. Предыдущая ссылка
   revoke'ится. После вступления статус «Вы в канале» появляется автоматически
   (webhook), вкладка рефетчит по фокусу.
4. **«Вы в канале»** — статус member, дата вступления, кнопка «Выйти из канала»
   (`POST /api/club/leave` — kick ban+unban + revoke ссылки, статус `left`).
5. **Скелетон** при загрузке; ошибки — через toast.

Контракт `GET /api/club/status`:
`{eligible, eligibleReason: 'tariff'|'manual'|'none', telegramConnected,
membership: 'none'|'invited'|'member'|'kicked', joinedAt, kickReason, channelUrl}`.
`left` бэкенд сворачивает в `kicked` (для UI различие неважно).

## 3. Жизненный цикл членства

`telegram_club_members` (PK `user_id → users.id ON DELETE CASCADE`):

| Статус | Переход |
|---|---|
| `invited` | invite выдан (ЛК или ручная выдача админа) |
| `member` | webhook `chat_member`: вступил по ссылке → `joined_at`, событие `club.joined` |
| `kicked` | аудит/админ/webhook-кик. Причина в `kick_reason` |
| `left` | вышел сам (ЛК) или вышел/забанен в TG → событие `club.left` |

Причины кика: `subscription_expired`, `invite_expired`, `manual_kick`,
`manual_leave`, `no_access_at_join` (попал в канал без доступа — мгновенный кик
вебхуком).

## 4. Автоматика

**Webhook** (`/api/webhook/telegram`): ветка `chat_member` обрабатывается **до**
`message`, фильтр по `TELEGRAM_CLUB_CHAT_ID` внутри хендлера. Без env — no-op.

**Ежедневный аудит** — крон 10:07 UTC (лок `club_access_audit`, лог в `cron_log`):
1. `member` без тарифа (включая grace) и без активной ручной выдачи → kick;
2. `invited` без доступа → revoke ссылки (`invite_expired`);
3. висячие приглашения → revoke.
Окно «тариф кончился вчера — до аудита остаётся в канале» — осознанное (ТЗ §5).

**Ленивая сверка**: `GET /status` для `member` сверяется с реальным членством
через `getChatMember` — расхождение правится на `left`.

## 5. Деградация без настройки

Без `TELEGRAM_CLUB_CHAT_ID` (не создан канал/не прописан env):
- `GET /api/club/status` — работает полностью;
- `POST /invite`, `POST /leave`, admin kick → `503 club_not_configured`;
- webhook-ветка и крон — no-op с логом.
Деплой кода без env безопасен. Полная настройка: [docs/admin/club.md](admin/club.md) §2.

## 6. События аналитики

`club.invite_issued`, `club.joined`, `club.left`, `club.kicked`,
`club.manual_grant`, `club.manual_revoke`, `club.admin_kick`
(`src/services/activityLog.ts`) — видны в ленте событий админки.

## 7. Проверено на проде (2026-10-26)

- `GET /status` (админ с тарифом): `eligible:true, reason:'tariff', telegramConnected:true, membership:'none'`;
- invite без env → `503 club_not_configured`;
- admin members → 200, счётчики `{0,0,0,0}`;
- аноним → 401, не-админ на admin club → 403;
- миграция `telegram_club_v1` + 2 индекса применены, крон зарегистрирован,
  webhook перевыставлен с `chat_member`.
