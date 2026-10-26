# Админ-контроль закрытого Telegram-канала «Клуб»

> ТЗ-197-club · коммит бэкенда `781e82f`, фронтенда `c105b25` (8.6.54).
> Актуальность: 2026-10-27. Продуктовая механика и пользовательский флоу: [docs/club.md](../club.md).
> Код: `pulse-backend/src/services/club.ts`,
> `src/routes/club.ts`, `src/routes/admin.ts` (раздел TZ-197-club),
> `src/services/telegram.ts` (Bot API-обёртки), фронт — `pulse-frontend/src/pages/admin/ClubTab.tsx`.

---

## 1. Что это

Закрытый Telegram-канал, куда пользователь попадает по **одноразовой персональной
ссылке**, если у него есть доступ:

- **по тарифу** — план содержит фичу `club_access` в `features_registry`;
- **вручную** — админ выдал доступ из админки (без тарифа).

Доступ снимается автоматически (ежедневный аудит) при окончании тарифа без grace
и при отзыве ручной выдачи. Код канала сам ничего не решает — источник истины
доступа всегда БД платформы.

## 2. Первичная настройка (разовая, на VPS)

1. Создать закрытый канал в Telegram.
2. Назначить `@Insidepulse_bot` **админом канала** с правами:
   - «Приглашать пользователей» (нужно для createChatInviteLink);
   - «Блокировать пользователей» (нужно для kick = ban+unban).
3. Узнать chat id канала (минус и число, напр. `-1001234567890`).
4. Прописать в `/opt/pulse/.env` и пересоздать контейнер:

```bash
TELEGRAM_CLUB_CHAT_ID=-1001234567890
docker compose up -d --force-recreate backend
```

5. Тарифу, открывающему доступ, добавить фичу `club_access` (админка → Тарифы).
6. В реестре фичей перевести `club_access` из `pending` в `integrated`
   (до этого вкладка «Клуб» в ЛК показывает режим «скоро»).

**Мягкая деградация:** без env `GET /status` работает, `invite/leave` и admin kick
возвращают `503 club_not_configured`, webhook-ветка и крон — no-op с логом.
Деплоить код без env безопасно.

## 3. Таба «Клуб» в админке

Админка → вкладка **«Клуб»** (сразу после «Тарифы», иконка Star).

Что показывает:

- **Счётчики в шапке**: участники / приглашённые / исключённые / ручные выдачи.
- **Таблица членов**: email, username, тариф и его окончание, статус, tg_user_id,
  ссылки (одноразовая invite), даты invited/joined/kicked, причина кика,
  флаг ручной выдачи.
- **Чипы-фильтры**: Все / Участники / Приглашённые / Исключённые / Ручные.
- **Поле «Выдать доступ по email»** — ручная выдача без тарифа.

Действия по строке (с danger-confirm):

| Действие | Что делает |
|---|---|
| **Исключить (kick)** | БД: `status='kicked'` (или `left`), причина `manual_kick`, отзыв ручной выдачи, revoke ссылки. TG: ban+unban — юзер выходит из канала, может вернуться только по новой ссылке. Идемпотентен. Без env → 503. |
| **Отозвать ручную выдачу** | Только БД: `manual_revoked_at = now`. Кик из канала НЕ выполняется — если юзер `member` без тарифа, его снимет следующий ежедневный аудит. Если у него есть тариф — ничего не изменится. |

Каждое действие пишется в ленту событий (`club.manual_grant`, `club.manual_revoke`,
`club.admin_kick` — см. `activityLog`).

## 4. Эндпоинты (все под `adminMiddleware` + `adminLimiter`)

| Метод / путь | Назначение | Ошибки |
|---|---|---|
| `GET /api/admin/club/members` | Список + `counters {members, invited, kicked, manual}` | 500 |
| `POST /api/admin/club/grant` `{email}` | Ручная выдача. UPSERT: `is_manual=TRUE`, статус `invited` (если не `member`) | 400 нет email · 404 `user_not_found` |
| `POST /api/admin/club/members/:userId/kick` | Кик (ban+unban) + отзыв выдачи + revoke ссылки | 404 `user_not_found` · 503 `club_not_configured` |
| `POST /api/admin/club/members/:userId/revoke-manual` | Отзыв ручной выдачи без кика | 404 `not_found` |

Аноним → 401, не-админ → 403 (проверено на проде 2026-10-26).

## 5. Статусная модель (`telegram_club_members.status`)

| Статус | Смысл |
|---|---|
| `invited` | Ссылка выдана, в канал не вступил. Одноразовая ссылка (member_limit=1). |
| `member` | Вступил по ссылке (webhook `chat_member` зафиксировал). |
| `kicked` | Исключён системой или админом. Причина в `kick_reason`. |
| `left` | Вышел сам (кнопка «Выйти из канала» в ЛК) — для UI сворачивается в `kicked`. |

Причины кика (`kick_reason`): `subscription_expired`, `invite_expired`,
`manual_kick`, `manual_leave`, `no_access_at_join`.

## 6. Автоматика

**Webhook** (`/api/webhook/telegram`, `allowed_updates += chat_member`):
- вступление по ссылке → `status='member'`, `joined_at`, событие `club.joined`;
- юзер без доступа попал в канал → мгновенный кик `no_access_at_join`;
- выход/бан из канала → `status='left'`.

**Ежедневный аудит** — крон `'7 10 * * *'` (10:07 UTC, после жизненного цикла
подписок 10:00 UTC; лок `club_access_audit`, лог в `cron_log`):
1. `member` без тарифа и без активной ручной выдачи → kick (`subscription_expired`);
2. `invited` без доступа → kick вебхууком при попытке вступить, плюс здесь
   revoke ссылки (`invite_expired`);
3. висячие приглашения без доступа → revoke.
Статистика `{checked, kicked, invitesRevoked, errors}` в `cron_log`.

**Пользовательский флоу** (ЛК → «Клуб»): `GET /status` (поллинг TG-статуса
5 с до 2 мин, рефетч по фокусу) → `POST /invite` (лимит 10/час, revoke старой
ссылки, новая одноразовая) → `POST /leave` (видимый выход обязателен).

## 7. Диагностика на VPS

```bash
# всё ли настроено и работает ли конвейер
docker logs --since 24h pulse-backend 2>&1 | grep -E "\[Club\]|\[WebPush\]" | tail -30

# типичные сигнатуры
# "[Club] TELEGRAM_CLUB_CHAT_ID not set — access audit skipped"   → нет env
# "revokeClubInviteLink failed: 400 Bad Request: chat_id is empty" → env пустой/кривой
# "not enough rights"                                             → у бота нет прав админа канала

# кто сейчас в клубе и что с ними будет
docker exec pulse-postgres psql -U pulse_user -d pulse -c \
  "SELECT status, kick_reason, count(*) FROM telegram_club_members GROUP BY 1,2"

# отработал ли аудит сегодня
docker exec pulse-postgres psql -U pulse_user -d pulse -c \
  "SELECT started_at, finished_at, details FROM cron_log WHERE cron_name='club_access_audit' ORDER BY id DESC LIMIT 3"
```

## 8. Известные ограничения

- Аудит снимает доступ **раз в сутки** (10:07 UTC) + мгновенно при попытке
  вступить без доступа. Окно «тариф кончился вчера — до сегодняшнего аудита
  остаётся в канале» — осознанное решение ТЗ (§5).
- Одноразовость ссылки — на стороне Bot API (`member_limit=1`), но ссылку
  можно пересылать до первого вступления; платформа revoke'ит ссылку при
  перевыпуске и при выдаче следующей.
- `withUserLock` в SQLite-режиме (локальная разработка) работает без лока —
  таблицы `cron_locks` в SQLite-схеме нет (предсуществующее, см. бэклог).
  На проде (PG) лок работает.
