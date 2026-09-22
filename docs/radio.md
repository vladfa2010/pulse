# Радио — персональное радио инвестора

Голосовой рендер поверх существующих данных Pulse: радио не производит контент,
а озвучивает то, что уже есть в тексте — непрочитанные новости юзера по его
тегам, инвест-пояснения (`tag_impact[].reasoning`), персональное/глобальное
саммари, календарь, котировки наблюдения.

Продуктовый контекст — `RADIO.md` (в пакете радио у владельца, v4).
ТЗ: **ТЗ-42 (backend)** ✅ · **ТЗ-43 (страница и данные)** ✅ ·
**ТЗ-44 (UI и голос)** ✅ · **ТЗ-45 (флаги в БД + админка)** ✅ ·
**ТЗ-46 (kill-switch сервиса)** ✅.
Ревью техлида: `REVIEW_RADIO_TZ42_V31_2026-09-21.md`
(блокеры Б1/Б2 закрыты в ТЗ-42).

## Статус

| Этап | Состояние | Дата |
|---|---|---|
| ТЗ-42 backend: TTS-прокси, флаги, SSE из News Processor | ✅ на проде | 2026-09-21 |
| ТЗ-43 frontend: страница `/radio`, адаптеры, хуки | ✅ на проде (коммит `b176c5f` pulse-frontend) | 2026-09-21 |
| ТЗ-44 frontend: перенос UI и голосового движка | ✅ на проде (коммит `3db7434` pulse-frontend) | 2026-09-21 |
| ТЗ-45 флаги в БД `_radio_settings` + таба «Радио» в админке | ✅ на проде (backend `bd879bf`, frontend `fe9841b`) | 2026-09-22 |
| ТЗ-46 kill-switch `service_enabled` вместо `auto_read_enabled` | ✅ на проде (backend `dcceb60`, frontend `14bf695`) | 2026-09-22 |

## Матрица переключателей (ТЗ-46)

| Переключатель | Владелец | Где живёт |
|---|---|---|
| Сервис радио целиком (kill-switch) | админ | `_radio_settings.service_enabled` → таба «Радио» |
| Авточтение новостей | юзер | `RadioLocalConfig.autoRead` (localStorage) → AdminPanel эфира |
| Провайдер, голоса, режим по умолчанию | админ | `_radio_settings` → таба «Радио» |
| Режим сессии, browser-голоса, темп | юзер | localStorage/сессия → SettingsPanel |

Эффективное авточтение = только `blocks.autoRead` (юзер). Серверного флага
авточтения больше нет: серверный `radio_service_enabled=false` → заглушка
«Радио временно отключено» для всех (см. TTS ниже и useSpeech).

## Концепция подачи (как будет выглядеть эфир)

Три режима подачи карточки (реализация — ТЗ-44, здесь — контракт):

| Режим | Структура | Источник «мысли» |
|---|---|---|
| **текст** | 1 сегмент: [перепечатка] + заголовок + саммари + «Оценка N из десяти» | — |
| **мысли** (`reflect`) | 2 сегмента: новость + инвест-пояснение | `tag_impact[].reasoning` по тегам юзера → остальные теги → абзац 2 `sentiment_reasoning` → шаблонный фолбэк |
| **подкаст** | 5 сегментов: ведущий открывает → гость читает → вопрос → гость поясняет → закрытие | та же цепочка |

- **Оценка** — только число из LLM-разбора (`tag_impact[].score`, шкала
  −10…+10): для голоса и чипа берётся `max |score|` по тегам юзера. Цвет числа:
  ≥8.5 красный, ≥7 жёлтый, иначе серый. Словесных категорий нет. Оценки нет
  (LLM-фолбэк пайплайна) — ни чипа, ни фразы: не выдумываем.
- **Перепечатки:** `source_count > 1` → чип «ПЕРЕПЕЧАТКА ×N», диктор
  предупреждает, в счётчике свежих и саммари не участвуют.
- **Прочитанность = озвучка.** Каждая начатая карточка помечается прочитанной
  (`POST /api/news/:id/read`), **включая скипнутые после старта — осознанное
  решение v1, без opt-out** (зафиксировано в RADIO.md §3.1).
- **Пилик:** обычный двухтональный при новой SSE-новости; при оценке ≥8.5 —
  тройной сигнал. Раньше триггером была severity (удалена), теперь граница
  совпадает с красным чипом.

## Архитектура (ТЗ-42, что уже в проде)

```
pulse-backend
├── src/routes/radio.ts            POST /api/radio/tts, GET /api/radio/config
├── src/services/radioSettings.ts  флаги в БД _radio_settings (ТЗ-45): кэш TTL 60с,
│                                  сид дефолтов, whitelist-валидация, upsert PG/SQLite
├── src/services/radioMetrics.ts   in-memory метрики TTS (см. «Эксплуатация»)
├── src/services/newsProcessor.ts  broadcastProcessedArticle() — SSE news ПОСЛЕ UPDATE
├── src/services/sse.ts            payload события news (расширен ТЗ-42)
├── src/middleware/rateLimit.ts    radioTtsLimiter 100/мин per-user
└── src/index.ts                   app.use('/api/radio', radioRoutes); runRadioMigrations()
```

Зависимости данных (существующие эндпоинты Pulse — НЕ части радио):
`GET /api/news` (непрочитанные по тегам), `POST /api/news/:id/read`,
`GET /api/user/tags`, `GET /api/user/summary`, `GET /api/user/summary-global`,
`GET /api/calendar`, `GET /api/news/stream` (SSE). Источники контента и их
смыслы — в `cascades.md`, `topics.md`, ARCHITECTURE.md §News.

## API радио

### `POST /api/radio/tts` — прокси Minimax TTS

Прямых вызовов Minimax из браузера нет: ключ живёт на сервере, фронт ходит
сюда. Minimax-ветка фронта (ТЗ-44) при 503 `tts_not_configured` уходит в
авто-фолбэк на браузерный SpeechSynthesis; при 502 на сегменте — сегмент
пропускается, очередь продолжается. При 503 `radio_service_disabled`
(ТЗ-46, kill-switch админа) — **стоп эфира без фолбэка**, фронт показывает
заглушку (иначе выключенное радио звучало бы браузерным голосом в обход).

- **Auth:** Bearer (401 без токена) → `radioTtsLimiter` (429 за пределами).
- **Body:** `{ text, voice_id?, speed?, pitch? }`
- **Ответ:** 200 `audio/mpeg` (mp3 бинарно); Minimax отдаёт hex в `data.audio`
  — декодируем сервером.
- **Ограничения:** `text` 1…2000 символов (иначе 400 `invalid_text`);
  `speed` 0.5–2.0 (400 `invalid_speed`); `pitch` −12…+12 (400 `invalid_pitch`);
  `voice_id` — только из белого списка (400 `invalid_voice_id` со списком
  `allowed`). Дефолт voice_id — `radio_minimax_host_voice` из конфига.
- **Апстрим:** `POST https://api.minimax.io/v1/t2a_v2`, модель `speech-02-hd`,
  таймаут 30 с (AbortController), `audio_setting`: mp3 / 32 kHz / 128 kbps.
  Разрыв соединения с клиентом гасит upstream-fetch сразу
  (`res.on('close')` + guard `writableEnded`).
- **Ошибки:** 502 `tts_upstream` (HTTP-статус, `base_resp.status_code != 0`,
  нет `data.audio`, таймаут, сетевой сбой); 503 `tts_not_configured`
  (нет `MINIMAX_API_KEY`); 503 `radio_service_disabled` (сервис выключен
  админом, ТЗ-46 — проверка `service_enabled` в начале handler, до валидации
  входа и проверки ключа; в TTS-метрики НЕ пишется — не ошибка upstream,
  учёт таких запросов — ТЗ-47).
- **Голоса (whitelist, 10 шт.):** `presenter_male`, `presenter_female`,
  `audiobook_male_1/2`, `audiobook_female_1/2`, `male-qn-qingse`,
  `female-shaonv`, `male-qn-jingying`, `female-yujie`. Одинаковый голос на обе
  роли подкаста → аналитик выше на +2 полутона (подача темпом/питчем, ТЗ-44).
- **Лимитер:** 100 запросов/минуту **per-user** (key по `userId`, монтируется
  ПОСЛЕ authMiddleware). Подкаст = 5 сегментов × 8 новостей = 40 запросов за
  сессию — проходит с запасом 2.5×. Устойчивый абуз упирается в 429.
- **Латентность:** базовая p95 ≈ 2.3 с на коротком тексте (замер 2026-09-21).

### `GET /api/radio/config` — серверные флаги радио

- **Auth:** Bearer (401 без токена). **Не** `adminMiddleware` — флаги нужны
  каждому юзеру страницы `/radio` (блокер Б2 ревью). Публичный
  `GET /api/features` не подходит — boolean-only registry, строковые флаги
  туда не ложатся.
- **Cache-Control:** `public, max-age=300` (= TTL useQuery 5 мин, ТЗ-43).
- **Ответ (ТЗ-45, значения из БД `_radio_settings` через сервис
  `src/services/radioSettings.ts`, формат контракта ТЗ-42 не менялся):**

```json
{
  "radio_service_enabled": true,
  "radio_voice_provider": "browser",
  "radio_minimax_host_voice": "presenter_male",
  "radio_minimax_guest_voice": "presenter_female",
  "radio_default_mode": "reflect",
  "minimax_configured": true
}
```

`minimax_configured` = `!!process.env.MINIMAX_API_KEY` — индикатор для админки
и фолбэка фронта (фронт v1 игнорирует неизвестное поле).
`radio_service_enabled` — kill-switch сервиса целиком (ТЗ-46; до ТЗ-46 поле
называлось `radio_auto_read_enabled` и ошибочно управляло авточтением —
авточтение переехало в чисто юзерскую настройку `blocks.autoRead`).
Ключ `auto_read_enabled` может физически остаться в `_radio_settings`
(вариант A без миграции) — код его игнорирует, в API не просачивается.

Управление значениями — таба «Радио» в админке Pulse (ТЗ-45, ниже). Голос
по умолчанию для TTS-запросов без `voice_id` — `radio_minimax_host_voice`
из этих же флагов.

## Управление флагами из админки (ТЗ-45)

Флаги живут в БД, меняются без деплоя. Паттерн — `calendar_settings`:
key/value-таблица + ensure-миграция из кода + upsert в двух диалектах.

- **Таблица `_radio_settings`** (PG и SQLite; конвенция — всё радио с префиксом
  `_radio_`). Ключи в БД — БЕЗ префикса `radio_`, префикс добавляет код ответа.
- **Сервис `src/services/radioSettings.ts`:**
  - `getRadioFlags()` — эффективные значения (БД + дефолты на недостающие
    ключи), кэш в памяти TTL 60 с. При первом обращении на пустую таблицу —
    идемпотентный сид 5 дефолтов (INSERT по PK + ON CONFLICT, конкурентные
    сиды безопасны).
  - `setRadioFlag(key, value, changedBy)` — whitelist ключей + валидация
    (`service_enabled`: boolean; `voice_provider`: browser|minimax;
    голоса: 10 id из whitelist; `default_mode`: text|reflect|podcast),
    upsert, инвалидация кэша, запись в activityLog.
  - `resetRadioFlags(changedBy)` — DELETE всех строк, дефолты применятся сами.
- **Admin endpoints** (`src/routes/admin.ts`, рядом с calendar/settings,
  все под `adminMiddleware`):
  - `GET /api/admin/radio-flags` → `{ flags, minimax_configured, allowed_voices }`
    (список голосов с бэка — админка whitelist не хардкодит).
  - `PUT /api/admin/radio-flags` body `{ key, value }` → 200 + `{ success, key,
    old_value, new_value, flags }`; 400 на невалидный ключ/значение;
    не-админ → 403.
  - `POST /api/admin/radio-flags/reset` → дефолты.
- **ActivityLog:** каждая смена/сброс пишет событие `admin_radio_flag_changed`
  в `user_events` с `key`, `old_value`, `new_value`, `changed_by` (+ TG-алерт
  админам штатно через notifyAdmins).
- **UI:** `pulse-frontend/src/pages/admin/RadioTab.tsx` (таба «Радио» в
  Admin.tsx рядом с «Календарь»). 5 контролов: тумблер «Сервис радио»
  (kill-switch, ТЗ-46) + жёлтая плашка «Сервис радио выключен. Все юзеры
  видят заглушку» при выключенном, селект
  провайдера, два селекта голосов (видны при провайдере minimax), селект
  режима, кнопка сброса. Красная плашка «MINIMAX_API_KEY не задан» — ровно
  при `voice_provider === 'minimax' && !minimax_configured`.
- **Раскатка изменений (двойной кэш):** сервисный TTL 60 с + фронт useQuery
  5 мин → худший случай ~6 минут до подхвата юзерами. Подсказка об этом есть
  в UI админки; «чинить» немедленным push не требуется (зафиксировано в ТЗ).
- **Диалекты:** upsert строго по паттерну calendar/settings — SQLite
  `INSERT OR REPLACE`, PG `ON CONFLICT (key) DO UPDATE`.

## SSE-пайплайн и событие `news`

До ТЗ-42 `broadcastNews` вызывался из `cron.ts` при сыром INSERT — событие
приходило с `sentiment: null, matched_tags: []` и без `tag_impact`: клиентская
фильтрация по тегам была мертва (для радио и потенциально для сайта).

Теперь событие формируется в **News Processor после UPDATE** обработанных
полей (`broadcastProcessedArticle`, оба пути записи: bulk и per-article
fallback). Payload:

```json
{
  "id": "uuid", "title_ru": "…", "summary_ru": "…", "source": "…",
  "published_at": "ISO", "sentiment": "neutral",
  "matched_tags": ["втб", "путин"],
  "tag_impact": [{"tag": "втб", "score": 0, "reasoning": ""}],
  "sentiment_reasoning": "…3 абзаца…",
  "source_count": 1,
  "url": "https://…"
}
```

- Новости без тегов (`markNoTags`) в broadcast не идут — радио их всё равно
  отфильтрует, сайт обновляется по `refresh`.
- Событие `refresh` (конец цикла коллектора) не тронуто — сайт по-прежнему
  перезапрашивает ленту по нему; `useSseNews` (pulse-frontend) карточку из
  `news`-события не рендерит (только бейдж+чип), поэтому перенос broadcast
  безопасен (проверено до мержа).
- Осознанное упрощение: событие `news` теперь приходит ПОЗЖЕ `refresh`
  (процессор с LLM-батчингом) — при одновременно висящем сайте возможен
  второй инкремент бейджа на статью с разрывом в минуты. Не исправлялось
  (front-задача, некритично); отслеживать при полировке ТЗ-43/44.
- SSE остаётся публичным (CORS `*`): payload — публичная LLM-аналитика новости
  без user_id. Авторизация SSE (токен в query, как у фактчека) — отдельная
  задача, не блокирует.

## Эксплуатация

- **`MINIMAX_API_KEY`** — env, только сервер. При установке: `.env` сервера И
  явный `environment:` backend-сервиса в `docker-compose.yml` (ключ в `.env` без
  правки compose контейнеру недоступен — см. DEPLOYMENT.md). Boot-лог:
  `[Radio] MINIMAX ready` / `[Radio] MINIMAX_API_KEY not set, /api/radio/tts
  returns 503`.
- **Метрики:** `GET /api/admin/metrics?section=radio` (adminMiddleware) —
  `total/ok/err_502/err_503`, `rate_502_pct`, `rate_503_pct`, `p95_latency_ms`,
  `avg_latency_ms`; окно латентности — последние 500 попыток, in-memory с
  момента старта процесса. Эксплуатационный summary каждый 100-й запрос:
  `[RadioTTS] stats: …` в docker logs.
- **Стоимость TTS:** дефолтный режим «мысли» = 2 сегмента на карточку;
  авто-поток глобально управляется юзерским `blocks.autoRead` (ТЗ-46);
  kill-switch всего сервиса — `service_enabled` админом (503 на TTS,
  заглушка на странице). Hardcap не делали —
  аномалию ловят метрики (`rate_502`, рост `total` вне эфира).
- **`validate.trustProxy: false`** в лимитере корректен для прямого VDS
  (Caddy → backend). При появлении CDN/Cloudflare перед Caddy — переключить на
  доверенный proxy-конфиг, иначе лимит станет считать по IP CDN.
- **Мёртвый ключ `auto_read_enabled`** — после ТЗ-46 остался в
  `_radio_settings` (вариант A без миграции), код его игнорирует. TODO:
  удалить руками при следующем удобном случае (`DELETE FROM _radio_settings
  WHERE key = 'auto_read_enabled'`).
- **Ключи в чате = скомпрометированы.** Ключ прототипа radio-app не использовался
  никогда; боевой ключ установлен 2026-09-21 (бэкап `.env.bak-minimax`),
  баланс кабинета Minimax держать под контролем, при ротации — правка одной
  строки в `.env` + `docker compose up -d backend`.

## Фронтенд (ТЗ-43, в проде)

Репо `pulse-frontend`. Всё радио-специфичное — под `src/lib/radio/`, `src/types/radio.ts`,
`src/hooks/useRadio*`, `src/pages/RadioPage.tsx`. Роут `/radio` (lazy-чанк) в App.tsx.
Пункты «Радио» в NavBar/Footer временно убраны (коммит `f6b3f21` pulse-frontend,
2026-09-22) — тестирование по прямой ссылке `/radio`; возврат в меню — отдельным решением.

### Адаптеры (`src/lib/radio/`)

Единственное место, где Pulse-DTO превращается в радио-модель; тесты —
`__tests__/radioAdapters.test.ts` (22 кейса).

- **`tagMap.ts`** — `fetchUserTags()` (`GET /api/user/tags`), `buildTagMap()`,
  `tagName()` (неизвестный id → сам id, ничего не ломаем).
- **`newsAdapter.ts` — `adaptPulseToNewsItem(article, userTagIds, tagMap)`.**
  Ключевое правило score (RADIO.md):
  1. Берём `tag_impact` **только по тегам юзера**, score = max |score|;
  2. если у юзера по этой новости нет impacts → `|sentiment_score| ?? 0`;
  3. **решающее правило:** если impacts по тегам юзера есть, но score = 0
     (LLM-фолбэк на бэке), оставляем 0 — sentiment НЕ подставляем (иначе фолбэк
     выглядел бы как реальная оценка).
  `reprint = source_count > 1`. `buildImpactLines()` — строки «<тег>: +N — reasoning»:
  пустые reasoning пропускаются, теги юзера идут первыми по |score|.
- **`calendarAdapter.ts`** — `adaptCalendarToday()`: события дня `date === server_date`
  из ответа `GET /api/calendar`, плоский список, время из заголовка regex
  `/(\d{1,2})[:.](\d{2})/` → `HH:MM`, без времени — в конец сортировки.
- **`buildReflectReasoning.ts`** — цепочка фразы «Что это значит»: ① reasoning по тегу
  юзера (с префиксом «По вашей теме <name>: ») → ② чужой тег с max |score| →
  ③ второй абзац `sentiment_reasoning` (сплит по `\n\n`) → ④ детерминированный
  дефолт (хэш от id, фразы из прототипа `scripts.ts`).

### Хуки (`src/hooks/`)

- **`useRadioConfig`** — `useQuery(['radio','config'])`, staleTime 5 мин
  (фронт не чаще раза в 5 минут, критерий приёмки); `DEFAULT_RADIO_CONFIG`
  идентичен серверному дефолту. Сейчас прогревает кэш, значения заберёт движок ТЗ-44.
- **`useRadioSse`** — `EventSource(API_BASE + '/news/stream')`; событие `news`
  пропускается только если `matched_tags ∩ userTagIds` непуст; `refresh` →
  `invalidateQueries(['radio','feed'])`; `ping`/`connected` игнор; reconnect 5 с.
  StrictMode-safe: колбэк в ref, cleanup `es.close()`.

### Страница (`src/pages/RadioPage.tsx`)

- **Гость** → CTA с `openAuthModal('login', { returnUrl: '/radio' })` (паттерн ActivityMap).
- **Авторизован без тегов** → заглушка «Радио молчит» + CTA в `/portfolio`
  (настройки тегов) + «послушать общее саммари» (`GET /api/user/summary-global`).
- **Лента:** baseFeed = `GET /api/news` (`useQuery(['radio','feed'])`, staleTime 2 мин)
  + liveItems из SSE. Склейка: live сверху, дедуп по id через `seenIdsRef`,
  лимит 40 (`MAX_FEED`). Свежая SSE-новость подсвечивается 4 с (`FRESH_HIGHLIGHT_MS`,
  периодическая чистка setInterval 1 с).
- **Карточка** (`RadioCard`): score-чип цветом — ≥8.5 красный, ≥7 жёлтый, иначе серый;
  при score = 0 чипа нет. Чип «ПЕРЕПЕЧАТКА ×N» при `source_count > 1`. Блок
  «Что это значит»: абзацы `sentiment_reasoning` + строки `buildImpactLines()`,
  пустые поля не рендерятся. Кнопка «▶ слушать» → `onEntryStart`.
- **Прочитанность:** `handleEntryStart(id)` — оптимистично в `readIds` +
  `POST /api/news/:id/read` (body `{}` — сигнатура `api.post(path, body)` требует
  body), при ошибке revert. Прочитанные выпадают из ленты мгновенно. Скип после
  старта тоже считается прочитанным — v1 без opt-out (RADIO.md §3.1).
- **`scorePhrase(score)`** (экспорт) — «Оценка N из десяти», `null` при 0;
  переиспользует голосовой движок ТЗ-44.

### Гейты и деплой фронта

`npx vitest run` (127 тестов, из них 22 радио) + `npm run build` (tsc + vite).
Прод-сборка строго по DEPLOYMENT.md: sed-патч 4 файлов на `pulse.inside-trade.ru` →
`VITE_TOPICS_ENABLED=true npm run build` → проверка `grep -c onrender = 0` и
инлайна флага (`isTopicsEnabled("true")` в чанке CascadesPage) →
`git checkout --` патча → `COPYFILE_DISABLE=1 tar` → scp → на сервере
`rm -rf /opt/pulse/frontend/dist/assets` + распаковка поверх.

## Голосовой движок и UI эфира (ТЗ-44, в проде)

Порт отлаженного прототипа `radio-app/` на тему Pulse. Ключевой код —
`src/hooks/useSpeech.ts` (genRef!), `src/lib/radio/scripts.ts`, 10 компонентов
`src/components/radio/`.

### useSpeech — очередь озвучки с поколениями (genRef)

Перенесён ЦЕЛИКОМ из прототипа: `genRef` бампится на любом stopAll/скипе;
все async-колбэки (fetch .then/.catch, audio.onended/onerror, utterance
onend/onerror) с устаревшей генерацией выходят молча. Ревью-правило: любое
«упрощение» колбэков — блокер (ТЗ-44 §5).

- **Minimax-ветка** — `POST /api/radio/tts` через `lib/radio/ttsApi.ts`
  (`serverTTS`), ключ в браузере не существует. Провайдер и голоса ролей —
  из серверного конфига. Пауза/резюме — `audioRef.pause/play`.
- **503 tts_not_configured** → авто-фолбэк на браузерный SpeechSynthesis в
  рамках того же сегмента, наружу — `minimaxDown` (пометка в настройках).
- **503 radio_service_disabled** (ТЗ-46, блокер ревью) → **стоп эфира БЕЗ
  фолбэка** (очередь чистится, genRef бампится) + колбэк `onServiceDisabled`:
  RadioPage инвалидирует `useRadioConfig` → перечитывание флагов → заглушка
  «Радио временно отключено». Без этого выключенное админом радио в течение
  5-минутного кэша фронта продолжало бы звучать браузерным голосом.
  Различие по телу ответа: `RadioTtsError.message` несёт серверный `error`-код.
- **502 tts_upstream** → сегмент пропускается, очередь продолжается.
- **skip = вся новость** (не сегмент) — зафиксировано поведение прототипа.
- `enqueue(item, label, mode)` дедупит по id карточки; `speakCustom(label,
  segments)` — саммари/приветствие; reasoning для режима «мысли» строится
  через `buildReflectReasoning()` (ТЗ-43) на момент постановки в очередь.
- Браузерная ветка: RU-голоса (auto = первый/второй русский), при общем
  голосе на обе роли аналитик тембром ниже (pitch 0.82); пауза/резюме —
  `speechSynthesis.pause/resume`.

### Режимы и тексты (`lib/radio/`)

- `scripts.ts` — `buildSegments(item, mode, reflectReasoning)`:
  text (1 сегмент) / reflect (новость + reasoning) / podcast (5 сегментов,
  host+guest; открывающая реплика по bucket-у score ≥8.5/≥7/иное; «Размышление. »
  срезается из реплики аналитика). `scorePhrase` — «Оценка N и N из десяти»
  (8.5 → «8 и 5»), score = 0 → фразы нет. Реплики ведущего 1:1 прототип.
- `greeting.ts`, `sound.ts`, `share.ts` — порты без правок (beepCritical
  вызывается при score ≥ 8.5; шеринг — navigator.share, фолбэк буфер).
- `summary.ts` — клиентский фолбэк, когда LLM-эндпоинты недоступны:
  buildPersonalSummary / buildMarketSummary / buildQuotesSegments. Сюжетность =
  `!reprint` (storyKey в Pulse нет). Заодно исправлена инверсия лидер/аутсайдер
  прототипа (лидер = max changePct).
- `config.ts` — локальный конфиг `pulse-radio-config-v1`: blocks (7),
  threshold, newsPace, broadcastLimit, summaryTopN. Удалено по ТЗ-44:
  minimaxKey, userTags, voiceProvider, minimax-голоса, дефолтные режимы.
- `calendarAdapter.ts` дополнен `buildCalendarSegments` / `nextEventLine`
  (голосовые строки календаря; в прототипе жили в lib/calendar.ts).

### Компоненты (`components/radio/`, 10 шт.)

Header, TickerBar, Watchlist, NewsFeed (score-чип ≥8.5 красный / ≥7 жёлтый /
серый, при 0 нет чипа; «Что это значит» из ТЗ-43), QueuePanel, CalendarPanel
(данные calendarAdapter, статус past/soon по сравнению с текущим времени),
SummaryBar (4 кнопки → эндпоинты; прогресс накопления свежих), PlayerBar
(транспорт ▶ Эфир·N / ⏸ / ⏭ / ■ / очередь / ↗ / ⚙), SettingsPanel (режим на
сессию, browser-голоса, темп, «пилик», пометка minimaxDown), AdminPanel
(блоки + параметры; «Авточтение» — юзерская настройка авто-потока, ТЗ-46).
CSS-переменные прототипа заменены на тему Pulse; keyframes эфира
(radio-ticker, radio-news-in, radio-onair-dot, radio-live-dot, radio-eq-bar)
— в `src/index.css`.

### Сценарии RadioPage (финальная сборка)

1. **Запуск:** приветствие (время суток, день, настроение, счётчик) →
   ближайшее событие календаря → непрочитанные по убыванию score (лимит
   5/8/12), label «эфир · N из M» — только визуальный.
2. **Фон:** SSE-новость → подсветка 4 с + пилик (≥8.5 тройной) → авточтение
   при `blocks.autoRead` (юзер); фильтра важности нет.
3. **Саммари:** «Моё» → `/api/user/summary?hours=12`; «Рынка» →
   `/api/user/summary-global` (накопление свежих non-reprint до threshold,
   повтор без refresh=1 — в логах бэка `cached: true`); при ошибке эндпоинтов
   — клиентский фолбэк summary.ts. «Что сегодня» — buildCalendarSegments;
   «Котировки» — buildQuotesSegments (watchlist).
4. **Плеер:** быстрые «стоп→эфир→стоп→эфир» = один голос (genRef-регрессия).
5. **Watchlist** — Binance-поллинг 5 с, TODO: уйти на `/api/market/*`.

### Гейты

`npx vitest run` — 153 теста (26 новых: scripts/summary/calendar-строки);
`npm run build` (tsc + vite). Деплой фронта — по регламенту DEPLOYMENT.md
(sed-патч → VITE_TOPICS_ENABLED=true → grep-проверки → tar/scp → распаковка
поверх /opt/pulse/frontend/dist).

## Настройки

### Серверные (этот документ: контракт `GET /api/radio/config` + раздел
«Управление флагами из админки», ТЗ-45)

Глобальные, одинаковые для всех юзеров, меняются из табы «Радио» админки
(без деплоя), хранятся в `_radio_settings`.

### Юзерские (план, реализация — ТЗ-43/44; localStorage `pulse-radio-config-v1`)

| Настройка | Значения | Дефолт |
|---|---|---|
| Блоки эфира (7): бегущая строка, наблюдение, календарь, панель эфира, панель саммари, «пилик», **авточтение** | вкл/выкл каждый | все вкл |
| Блок «Авточтение» | юзерская настройка авто-потока (ТЗ-46; серверного флага авточтения больше нет) | вкл |
| Порог саммари рынка | 25 / 50 / 100 свежих | 50 |
| Скорость ленты | быстро / норма / медленно | норма |
| Длина запуска эфира | 5 / 8 / 12 | 8 |
| Сюжетов в своём саммари | 3 / 4 / 5 | 4 |
| Режим воспроизведения | текст / мысли / подкаст | из server flag |
| Browser-голоса ведущего/аналитика | авто + системные | авто |
| Темп | 0.70–1.60× | 1.00 |
| «Пилик» | вкл/выкл | вкл |

Авточтение = только `blocks.autoRead` (юзер, ТЗ-46). Серверного флага
авточтения больше нет: серверный `service_enabled=false` выключает радио
целиком (заглушка + 503 на TTS). Фильтра важности при авточтении нет: все
новости по тегам или никаких (осознанное упрощение v1).

### Что удалено из прототипа намеренно

- Severity и словесные категории (только число `score`).
- `minimaxKey` в localStorage (ключ — только сервер).
- `handleSpike` в watchlist (алерты — вне ТЗ-42/43/44; watchlist на Binance
  временный, TODO в коде, уйдёт при подключении `/api/market/*`).
- Прямой вызов Minimax из фронта (`lib/minimax.ts` прототипа не переносится).

## Сценарии эфира (контракт для ТЗ-43/44)

1. **Запуск:** приветствие (время суток, день недели, счётчик непрочитанных) →
   ближайшее событие календаря → непрочитанные по убыванию score (лимит 5/8/12).
   Анонс «эфир · N из M» — только визуальный label плеера.
2. **Фон:** SSE-новость по тегам → подсветка 4 с + пилик (≥8.5 — тройной) →
   авточтение при юзерском `blocks.autoRead` (ТЗ-46).
3. **Саммари-кнопки:** «Моё саммари» → `/api/user/summary?hours=12`;
   «Саммари рынка» → `/api/user/summary-global` (кэш 6 ч, повтор без `refresh=1`);
   «Что сегодня» → `/api/calendar`; «Котировки» → watchlist (v1 — публичные
   крипто). Клиентский `summary.ts` — фолбэк, когда LLM-эндпоинты недоступны.
4. **Юзер без тегов:** заглушка «Радио молчит, потому что не знает ваших
   интересов» + CTA в настройки тегов Pulse + «послушать общее саммари»
   (`/api/user/summary-global`) — воронка лендинга.

## Роадмап

- **v1 (ТЗ-42+43+44):** страница `/radio` (прямая ссылка; пункт в NavBar/Footer
  убран временно — см. выше).
- **v2:** виджет на главной, алерты котировок/портфеля (когда появится общий
  поток алертов Pulse). ~~Управление серверными флагами из админки~~ — сделано в ТЗ-45.
- **v3:** пуши «новое в эфире», утренний ритуал в TG/email, авторизация SSE.
- **Далёкое:** крупные сделки и IPO, экспорт подкаста дня в файл.

## Дизайн-решения и почему

| Решение | Почему |
|---|---|
| Тонкий рендер, радио не производит контент | Весь контент уже существует и персонализован; радио быстрее обычного эфира — нет сетки вещания и повторов |
| Прочитанность = озвучка, включая скип после старта | Иначе «эфир на вечер» разрастался бы бесконечно; v1 без opt-out осознанно |
| Оценка только числом, без словесных категорий | Число уже есть в БД (`tag_impact[].score`), категории — выдумка поверх данных |
| `GET /api/radio/config` с authMiddleware, не admin | Флаги нужны каждому юзеру страницы; `/api/features` boolean-only |
| Broadcast `news` из News Processor, не из cron | Иначе payload пустой и фильтрация по тегам мертва (блокер Б1 ревью) |
| Флаги в БД `_radio_settings` + таба «Радио» в админке (ТЗ-45) | Изменение без деплоя, аудит смен в activityLog; цена — двойной кэш, раскатка ~6 мин |
| Minimax через серверный прокси | Ключ в браузере = скомпрометирован; плюс единая точка метрик/лимитов |

## Связи

- DEPLOYMENT.md — env-таблица (`MINIMAX_API_KEY`), правила установки ключей.
- ARCHITECTURE.md §Real-time Updates (SSE) — payload `news` и история фикса.
- RADIO.md (пакет радио) — продуктовый контекст и сценарии.
- ТЗ-42/43/44/45, REVIEW_RADIO_TZ42_V31 — исходные ТЗ и вердикт техлида.
- Прототип-донор `radio-app/` — песочница, в прод не переносится целиком
  (переносятся 10 компонентов, useSpeech с genRef, greeting/scripts/share/sound/
  summary/config — карта в ТЗ-44 задача 3).
