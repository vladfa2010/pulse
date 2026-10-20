# Push-уведомления PULSE — контент и доставка

**Статус:** действующий контракт (рефакторинг «содержание события вместо бренда», ТЗ push v3.0, 2026-09-04)

## Принцип

В `title` и `body` пуша — **только информация о событии**. Бренд «PULSE» не дублируется: он виден по иконке приложения и системной строке iOS («from Pulse» на iOS 16.4+ для PWA — системная, убрать её из payload невозможно, это ограничение платформы).

## Лимиты и обрезка

| Зона | Лимит | Где |
|------|-------|-----|
| title | 60 символов | `PUSH_TITLE_MAX` |
| body | 140 символов | `PUSH_BODY_MAX` |

Единый источник — константы в `src/services/notifications/formatters.ts`. Обрезка — только через `truncateTextSmart()`: по границе последнего пробела перед лимитом (если пробел не раньше половины лимита), иначе жёсткая обрезка + `…` (защита от длинного первого слова/URL).

## Содержимое по типам

| Тип | Title | Body | Data |
|-----|-------|------|------|
| `new_article` | `title_ru` ‖ `title_original` | `summary_ru` ‖ `summary_original` → fallback `source` → `'Новая новость'` | `type`, `news_id`, `tag`, `source` |
| `digest` (n>1) | заголовок первой статьи | `+ ещё N статей` (склонение `declineWord`) | `type`, `count` |
| `digest` (n=1) | заголовок статьи | `source · tag` → fallback `'1 новая статья'` | `type`, `count` |
| `digest` (n=0) | `Нет непрочитанных новостей` | `Новые статьи по вашим тегам появятся позже` | `type`, `count: '0'` |
| `weekly_report` | `📊 Еженедельный отчёт: {period}` | `N новостей за неделю · {topTag}` | `type`, `count`, `period` |

**weekly_report в Telegram/Email (ТЗ-184):** помимо push, в воскресенье юзер
получает PNG-инфографику (рендер `notifications/weeklyChart.ts`, sharp → SVG,
1200×~1000 @2x) и текстовый отчёт со счётчиками из агрегатов без лимита
(`notifications/weeklyStats.ts`). Telegram: `sendPhoto` (caption ≤1024) +
текст вторым сообщением (`sendTelegramPhoto` в `telegram.ts`). Email: то же
PNG inline-вложением `cid:weekly-chart` (`attachments[].content_id` в Resend).
Детали, SQL-агрегаты, палитра и поведение при деградации —
в `docs/weekly-report-chart.md`.
| `sentiment_vote` / engagement | **текст в `data.title`/`data.body`** (backend не меняется) | — | `type`, `title`, `body` |
| `billing` | `Подписка истекает` / `Оплата прошла` | детали тарифа | `type`, `subtype` |

## Цепочки кода (backend)

- Новая статья: `newsProcessor.ts` (`saveProcessedArticles` / `saveProcessedArticlesPerArticle`) → `push.ts sendNewArticlePush(newsId, title, summary, source, matchedTags)` → fan-out `sendPushNotification` (FCM) + `sendWebPushToUser` (VAPID). Сигнатуры fan-out не меняются.
- Digest / weekly: `dispatcher.ts deliver()` → `formatDigestPush()` / `formatWeeklyReportPush()` (`notifications/formatters.ts`).
- Summary доступен в памяти у обоих вызовов (`summary_ru` ставится при переводе, `summary_original` — поле типа `Article`), отдельного SELECT не требуется.
- Dedup: `push_notifications_sent` (INSERT … ON CONFLICT DO NOTHING); в колонку `title` пишется обрезанный `pushTitle`. Колонка `source` = канал `'push'`, не источник новости.
- Quiet hours (MSK) per-user для контентных пушей — в `sendNewArticlePush`; продуктовые (dispatcher) — свои.

## Service worker'ы (pulse-frontend/public)

- `service-worker.js` — VAPID web push: fallback-цепочка `payload.title → data.title → 'PULSE'`, аналогично body; guard `title === 'PULSE' && !body` → пуш не показывается; `requireInteraction: false`.
- `firebase-messaging-sw.js` — FCM web: fallback `payload.notification.* → data.*`; тот же guard.
- Навигация по тапу (сверено с роутингом `App.tsx`, BrowserRouter — hash-роутов нет):
  - `d.url` (если задан backend'ом) →
  - `new_article` → `/news/{news_id}` →
  - `digest` → `/feed` →
  - `weekly_report` / `sentiment_vote` → `/sentiment` →
  - дефолт `/profile/tariff`.

## Известные ограничения

- «from Pulse» на iOS PWA — системная строка, не убирается.
- Data-only FCM на iOS PWA может не будить SW в background; при подтверждении — отдельная задача на `notification`-блок в apns-конфиге.
- Прямой заход на `/news/{id}` рендерит модалку поверх пустого фона (`App.tsx`: роут с `element={null}` для основного рендера) — существующее поведение для всех прямых ссылок на новости.

## Дашборд «Пуши» (2026-10-17, ТЗ-178-пуш)

Таба «Пуши» в админке + `GET /api/admin/push/stats` (`adminMiddleware`,
PG-only — `interval`/`FILTER`). Один запрос через `Promise.all`:
- **totals** — отправлено за сутки / 7 / 30 дней (`push_notifications_sent`);
- **daily** — счётчики по дням за 30 дней (график 7/30 на фронте);
- **bySource** — разрез по типам (`source`) за 30 дней;
- **topUsers** — топ-10 получателей за 7 дней (JOIN users: email/username);
- **recent** — лента последних 50 отправок;
- **subscriptions** — здоровье подписок: total/active, разбивка FCM/Safari
  (Safari определяется по префиксу endpoint `web.push.apple.com`),
  прирост подписок по дням и по каналам.

Фронт: `PushPanel` — карточки тоталов, график, разрез по типам, топ, лента,
подписки; автообновление 60 с. Отправитель — VPS-бэкенд (`DEPLOYMENT.md`).
