# Еженедельный отчёт: инфографика и агрегаты (ТЗ-184)

**Статус:** реализовано (2026-10-20)
**Контур:** `workers.ts` (cron вс 13:00 МСК) → `dispatcher.dispatchToUser()` →
`weeklyReportContent.buildWeeklyReportContent()` → `weeklyStats` + `weeklyChart` →
`deliver()` → Telegram (`sendTelegramPhoto` + текст) / Email (inline `cid:`-вложение) / Push (без изменений).

## Принцип

Статистика считается **агрегирующими запросами без лимита** — точные числа при
любом объёме новостей. Существующий `LIMIT 200` в списке статей не тронут:
он по-прежнему ограничивает только показываемые списки (5 статей на тег),
а счётчики («Всего новостей», тональность, «(N)» у тега) в тексте и на графике
берутся из агрегатов (`content.stats`). PNG рендерится **один раз на юзера,
до фан-аута по каналам**. Картинка опциональна: любой сбой рендера/отправки
фото → `null` → каналы шлют текст (прежнее поведение).

## Структура `WeeklyStats` (`notifications/weeklyStats.ts`)

```ts
interface WeeklyStats {
  perTag: Array<{ tagId: string; tagName: string;
                  current: number; prevWeek: number; monthAvg: number }>;
  perDay: Array<{ date: string; count: number }>;   // ровно 7 дней, пустые = 0
  sentiment: { positive: number; negative: number; neutral: number;      // текущая неделя
               prevPositive: number; prevNegative: number; prevNeutral: number };
  kpis: { totalDeltaWeekPct: number | null;   // null если прошлая неделя = 0 («—», не «▲∞%»)
          totalDeltaMonthPct: number | null;  // null если месячное среднее = 0
          topTagId: string | null;            // max current (tie → max prevWeek)
          peakDay: string | null };           // день с максимумом новостей
}
```

- `content.stats: WeeklyStats | null` — `null` при сбое агрегатов: контент
  строится, счётчики в тексте fallback'ятся на старые значения из списка
  статей, картинка не рендерится.
- Теги только из портфеля юзера. Тег с новостями только в прошлой неделе/
  месяце включается с `current=0` («у тебя пропал поток по X»).
- «Всего новостей» = сумма текущей тональности (уникальные новости по всем
  тегам юзера; новость с несколькими тегами в perTag считается по каждому
  тегу, но один раз в тоталах).

## Окна расчёта

Время новости — по конвенции `GREATEST(fetched_at, published_at)` (как в
сортировке отчёта). Окна — полуинтервалы «строго больше порога»:

| Окно | Условие |
|---|---|
| текущая неделя | `t > now - 7 дней` |
| прошлая неделя | `now - 14 дней < t <= now - 7 дней` |
| месяц | `t > now - 30 дней`, `monthAvg = month_total / 30 * 7` |

Граница строгая: новость ровно на отметке 7 дней попадает в «прошлую», ровно
на 14 дней — только в месяц.

## SQL-агрегаты

Postgres (прод, приоритет) — три окна одним проходом, `unnest(matched_tags)`:

```sql
SELECT u.tag,
       COUNT(*) FILTER (WHERE GREATEST(n.fetched_at, n.published_at) > $2) AS current,
       COUNT(*) FILTER (WHERE GREATEST(n.fetched_at, n.published_at) > $3
                        AND GREATEST(n.fetched_at, n.published_at) <= $2) AS prev_week,
       COUNT(*) AS month_total
FROM news n
CROSS JOIN LATERAL unnest(n.matched_tags) AS u(tag)
WHERE u.tag = ANY($1::text[])
  AND GREATEST(n.fetched_at, n.published_at) > $4   -- $4 = now - 30 дней
GROUP BY u.tag;
```

`perDay` и `sentiment` — те же окна с группировкой по
`date_trunc('day', GREATEST(fetched_at, published_at))` и `sentiment`
(тональность — только текущая + прошлая неделя, месячная не нужна).

SQLite (локальная разработка) — по аналогии: `json_each(matched_tags)`
вместо `unnest`, скалярный `max(a, b)` вместо `GREATEST`, пороги дат в
формате `YYYY-MM-DD HH:MM:SS` (как хранит `datetime('now')`). Запросы — в
`weeklyStats.ts`, функции принимают инжектируемый QueryFn (как `seoRebuild.ts`),
production передаёт `query` из `config/db`, тесты — `sqlite.query`.

## Формат PNG (`notifications/weeklyChart.ts`)

- Вход: `WeeklyReportContent` (с `stats`) → `Promise<Buffer | null>`.
  `null` при отсутствии stats или любой ошибке (catch → log → null).
- SVG вручную (без chart-библиотеки) → `sharp(svg, { density: 144 }).png()`.
  Логический канвас 1200×~1000, retina 2x → 2400×~2000 px
  (Telegram/email отображают по метаданным нормально). Файл ~100–300 КБ.
- Четыре блока: гистограмма топ-10 тегов (пары столбцов текущая #00D4FF /
  прошлая #164E63, остальные — «…и ещё N тегов»), динамика по дням пн–вс
  (DD.MM), тональность (stacked 🟢#34D399/🔴#EF4444/⚪#6B7280 + маркер дельты
  ▲/▼ к прошлой), KPI-строка «Всего: N (▲% к пр. неделе · ▼% к мес. среднему)»
  + «Самый обсуждаемый: XXX».
- Безопасность: все текстовые вставки XML-escape; внешних ресурсов в SVG нет
  (`<image href>`, `@import` запрещены — sharp/librsvg не ходит в сеть).
  Эмодзи в SVG не используем (в alpine-контейнере нет emoji-глифов) — только
  векторные фигуры и текст.

### Палитра (из `pulse-frontend/DESIGN_SPEC.md`, тёмная тема)

| Роль | Цвет |
|---|---|
| фон | `#060606` |
| акцент (текущая неделя) | `#00D4FF` |
| прошлая неделя (приглушённый) | `#164E63` |
| позитив | `#34D399` |
| негатив | `#EF4444` |
| нейтральный / muted | `#6B7280` |
| текст вторичный | `#9CA3AF` |
| разделители | `#222222` |

## Шрифты в контейнере (обязательно)

`node:20-alpine` не содержит fontconfig и шрифтов — кириллица рендерится
квадратиками (подтверждено тестовым рендером на проде 2026-10-20). В Dockerfile:

```dockerfile
RUN apk add --no-cache fontconfig ttf-dejavu
```

DejaVu содержит кириллицу. В SVG указан стек `DejaVu Sans, sans-serif`.
WOFF2-вариант не используем. После деплоя — контрольный рендер текста с
кириллицей в контейнере.

## Доставка картинки

- **Telegram** (`telegram.ts sendTelegramPhoto`): `sendPhoto`,
  multipart/form-data (form-data + axios), caption ≤1024 символов
  (заголовок + KPI, HTML). В `dispatcher.ts` ветка `weekly_report → telegram`:
  сначала фото, затем текстовый отчёт; падение фото → warning, текст уходит.
  Оба вызова — в общем паузном контуре (sleep 500 мс).
- **Email** (`email.ts` + `formatters.ts`): PNG — вложение
  `{ filename: 'weekly-chart.png', content: base64, content_id: 'weekly-chart' }`
  в raw axios POST Resend + `<img src="cid:weekly-chart">` в начале HTML.
  Resend API официально поддерживает inline-вложения.
- **Push**: без изменений (текстовая сводка, лимиты PUSH_TITLE_MAX/PUSH_BODY_MAX).

## Деградация

| Сбой | Поведение |
|---|---|
| агрегаты упали | контент со `stats=null`, текст со старыми счётчиками, без картинки |
| рендер PNG упал | `renderWeeklyChart` → `null`, оба канала шлют текст |
| `sendPhoto` отвергнут | warning в логе, текстовый отчёт доставлен |
| вложение email не принято | `sendEmail` → false, канал считается ошибочным (как и раньше) |

## Тесты

`src/tests/weeklyReportChart.test.ts` (стиль соседей — ts-node standalone):

```
USE_SQLITE=true npx ts-node src/tests/weeklyReportChart.test.ts
```

Покрыто: агрегаты на сидированных данных (3 окна, тег с `current=0`, границы
7/14/30 дней), отсутствие лимита (500 новостей = 500), рендер (PNG-сигнатура,
retina-размер, все-нули, `stats=null`), деградация (`sendPhoto` отвергнут →
false + warning, текстовый fallback). Postgres-вариант SQL на живом PG на
локальной машине не прогонялся — прогнать на VPS (запросы идентичны по логике
SQLite-веткам).
