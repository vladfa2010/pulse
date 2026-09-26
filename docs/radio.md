# Радио — персональное радио инвестора

Голосовой рендер поверх существующих данных Pulse: радио не производит контент,
а озвучивает то, что уже есть в тексте — непрочитанные новости юзера по его
тегам, инвест-пояснения (`tag_impact[].reasoning`), персональное/глобальное
саммари, календарь, котировки наблюдения.

Продуктовый контекст — `RADIO.md` (в пакете радио у владельца, v4).
ТЗ: **ТЗ-42 (backend)** ✅ · **ТЗ-43 (страница и данные)** ✅ ·
**ТЗ-44 (UI и голос)** ✅ · **ТЗ-45 (флаги в БД + админка)** ✅ ·
**ТЗ-46 (kill-switch сервиса)** ✅ · **ТЗ-47 (защита от потока «много голосов»)** ✅ ·
**ТЗ-49 (автоплей → SettingsPanel)** ✅ · **ТЗ-50 (синхронизация счётчика
непрочитанных)** ✅ · **ТЗ-53 (порядок блоков в автоэфире)** ✅ · **ТЗ-54
(гарантия порядка саммари + защита от race)** ✅ · **ТЗ-55 (кэш крона
бесплатно + свежий обзор отдельной кнопкой)** ✅ · **ТЗ-56 (watchlist через
Finam: тикеры из активных тегов портфеля)** ✅.
Ревью техлида: `REVIEW_RADIO_TZ42_V31_2026-09-21.md`
(блокеры Б1/Б2 закрыты в ТЗ-42). Аудит ТЗ-56 перед реализацией: 2 критичных
бага в исходном ТЗ (`req.user.id` вместо `userId`, прямой fetch с кукой
вместо api-клиента) — исправлены при реализации.

## Статус

| Этап | Состояние | Дата |
|---|---|---|
| ТЗ-42 backend: TTS-прокси, флаги, SSE из News Processor | ✅ на проде | 2026-09-21 |
| ТЗ-43 frontend: страница `/radio`, адаптеры, хуки | ✅ на проде (коммит `b176c5f` pulse-frontend) | 2026-09-21 |
| ТЗ-44 frontend: перенос UI и голосового движка | ✅ на проде (коммит `3db7434` pulse-frontend) | 2026-09-21 |
| ТЗ-45 флаги в БД `_radio_settings` + таба «Радио» в админке | ✅ на проде (backend `bd879bf`, frontend `fe9841b`) | 2026-09-22 |
| ТЗ-46 kill-switch `service_enabled` вместо `auto_read_enabled` | ✅ на проде (backend `dcceb60`, frontend `14bf695`) | 2026-09-22 |
| ТЗ-47 защита от потока «много голосов»: AUTO-бейдж + лимит очереди + кулдаун (дефолт autoRead был выкл) | ✅ на проде (frontend `08bd1f9`) | 2026-09-23 |
| 2026-09-23: дефолт автоплея снова **вкл** (`autoRead: true`, frontend `9294894`) — решение владельца; защита ТЗ-47 (кулдаун 30 с, лимит 30) сохранена | ✅ на проде | 2026-09-23 |
| ТЗ-49 автоплей перенесён из AdminPanel в SettingsPanel | ✅ на проде (frontend `05fbadb`) | 2026-09-23 |
| ТЗ-50 синхронизация счётчика непрочитанных (invalidate+debounce, focus, staleTime 30 с) | ✅ на проде (frontend `6d44727`) | 2026-09-23 |
| ТЗ-53 порядок автоэфира: приветствие → общее саммари → персональное → топ новостей → календарь | ✅ на проде (frontend `bfed6b5`) | 2026-09-23 |
| ТЗ-54 review-фиксы ТЗ-53: await саммари рынка (Promise из readMarketSummary), guard от двойного ▶ эфир, тест pickedIds | ✅ на проде (frontend `abc665b`) | 2026-09-23 |
| ТЗ-55 саммари рынка из кэша крона (0 LLM, `/summary-global/cached`) + «свежий обзор» отдельной кнопкой | ✅ на проде (backend `c7ecf7a`, frontend `ad614ed`) | 2026-09-23 |
| ТЗ-55 fix: спиннер кэша крона — fetchMarketCached переведён на api-клиент (Bearer; куку authMiddleware не читает) | ✅ на проде (frontend `24ded8f`) | 2026-09-23 |
| ТЗ-56 watchlist котировок через Finam: тикеры активных тегов портфеля, поллинг 60 с, удалён Binance-хук и фейк-sparkline | ✅ на проде (backend `be3c66a`, frontend `6893233`) | 2026-09-24 |
| ТЗ-57 v2 общая сводка как диалог host+guest через Minimax chat (`/api/market/market-dialog`, 6ч кэш, in-flight lock) | ✅ на проде (backend `5ae069d`, frontend `02a90c4`) | 2026-09-24 |
| ТЗ-58 персонажи Михаил/Татьяна, прощание «Продолжаем следить для вас за рынком», max_tokens 4000 | ✅ на проде (backend `640b276`) | 2026-09-24 |
| Hotfix `3fe6938`: парсер снимает `<think>/<answer>` (MiniMax-M2.5 — reasoning-модель) | ✅ на проде | 2026-09-24 |
| ТЗ-59 префетч mp3 диалога + конвейер с единым кешем (0 мс между репликами) | ✅ на проде (frontend `0c80ce4`) | 2026-09-25 |
| ТЗ-61 TTS `speech-02-hd` → `speech-2.8-hd` через env `MINIMAX_TTS_MODEL` | ✅ на проде (backend `77bc128`) | 2026-09-25 |
| ТЗ-61.5 (опц.) sound tags `<#N#>` паузы в диалоге | ⬜ бэклог | — |

## Матрица переключателей (ТЗ-46)

| Переключатель | Владелец | Где живёт |
|---|---|---|
| Сервис радио целиком (kill-switch) | админ | `_radio_settings.service_enabled` → таба «Радио» |
| Авточтение новостей | юзер | `RadioLocalConfig.autoRead` (localStorage) → SettingsPanel (тумблер «Автоплей новых», ТЗ-49) |
| Провайдер, голоса, режим по умолчанию | админ | `_radio_settings` → таба «Радио» |
| Режим сессии, browser-голоса, темп | юзер | localStorage/сессия → SettingsPanel |

Эффективное авточтение = только `blocks.autoRead` (юзер, **дефолт
вкл с 2026-09-23**, до этого выкл с ТЗ-47). Серверного флага
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
`GET /api/user/tags`, `GET /api/user/summary`, `GET /api/user/summary-global` (LLM, refresh), `GET /api/user/summary-global/cached` (read-only кэш крона, 204 если нет — ТЗ-55),
`GET /api/market/watchlist-quotes` (котировки наблюдения, auth, ТЗ-56),
`GET /api/calendar`, `GET /api/news/stream` (SSE). Источники контента и их
смыслы — в `cascades.md`, `topics.md`, ARCHITECTURE.md §News. Рынок —
`docs/market-data.md` (единый провайдер Finam, кэши TTL).

## Сквозная логика эфира (2026-09-26, актуальная)

Как данные превращаются в звук — полный путь от крона до колонок:

```
[крон 00/06/12/18 МСК] globalSummary.ts (Kimi, ~50 мин на 200 статей)
   → in-memory кэш сводки { summary: string, TTL 6ч10м }
        │  warm-up через 3 мин после boot; recreate контейнера = пустой кэш
        │  до следующей генерации (эфир в это время играет plain)
        ▼
[HTTP] GET /api/market/market-dialog (auth, Bearer)
   services/radioPodcast.ts:
   1. getCachedGlobalSummary() — нет кэша → null → 204 → фронт fallback plain
   2. in-memory кэш диалога 6ч, ключ = первые 200 символов сводки
   3. in-flight lock — конкурентные юзеры = один вызов LLM
   4. Minimax chat (MINIMAX_CHAT_MODEL=MiniMax-M2.5, env):
      SYSTEM_PROMPT (ТЗ-58: Михаил+Татьяна, 6-8 реплик)
      → max_tokens 4000 (reasoning-модель тратит лимит на <think>)
      → parseDialogResponse: снимает <think>/<answer>/```json,
        строгий whitelist ролей host|guest
   5. Ошибка/нет env → null → 204 (сервис никогда не бросает)
        ▼
[фронт] RadioPage
   1. marketCached появился → fetchMarketDialog() → стейт marketDialog
   2. через 5 сек: префетч (C) — Promise.all всех реплик в mp3Cache
      (голоса из /api/radio/config, темп = speech.rate, pitch при
      одинаковых голосах +2 — ключи совпадают с плеером)
   3. ▶ Эфир → шаг 2 speakCustom('Саммари: диалог', segments)
        ▼
[озвучка] useSpeech.speakSegment() по каждому сегменту
   1. конвейер (B): следующий сегмент догружается в mp3Cache,
      пока играет текущий
   2. loadMp3(text, voice, speed, pitch) — cache hit → 0 мс,
      miss → POST /api/radio/tts
   3. POST /api/radio/tts (auth, лимит 100/мин/юзер) → Minimax T2A
      (MINIMAX_TTS_MODEL, дефолт speech-2.8-hd, env — ТЗ-61)
   4. Blob mp3 → Audio.play(); guest = presenter_female (+2 полутона
      если голоса совпадают), host = presenter_male
   5. Ошибки: 503 radio_service_disabled → стоп эфира + заглушка;
      503 tts_not_configured → фолбэк на браузерный синтез;
      502 → сегмент пропускается, очередь идёт
```

Ключевые кеши и их границы:

| Кеш | Где | TTL | Инвалидция |
|---|---|---|---|
| Сводка рынка | бэк in-memory | 6ч10м | recreate контейнера (до warm-up 3 мин + ~50 мин генерации) |
| Диалог (JSON сегментов) | бэк in-memory | 6ч | recreate; смена сводки → новый ключ |
| mp3 сегментов | фронт in-memory (Map) | сессия | LRU 32; непереживает reload |

Отказоустойчивость (каждый шаг деградирует, ничего не падает):
204/ошибка диалога → plain-монолог кэша крона → нет кэша крона → шаг 2 молчит,
остальные шаги эфира идут. Minimax TTS недоступен → браузерный синтез →
голосовой движок недоступен → текст на экране.

## API радио

### `POST /api/radio/tts` — прокси Minimax TTS

Прямых вызовов Minimax из браузера нет: ключ живёт на сервере, фронт ходит
сюда. Minimax-ветка фронта (ТЗ-44) при 503 `tts_not_configured` уходит в
авто-фолбэк на браузерный SpeechSynthesis; при 502 на сегменте — сегмент
пропускается, очередь продолжается. При 503 `radio_service_disabled`
(ТЗ-46, kill-switch админа) — **стоп эфира без фолбэка**, фронт показывает
заглушку (иначе выключенное радио звучало бы браузерным голосом в обход).

- **Auth:** Bearer (401 без токена). Лимитер — внутри handler при cache miss
  (см. «Лимитер» ниже).
- **Body:** `{ text, voice_id?, speed?, pitch? }`
- **Ответ:** 200 `audio/mpeg` (mp3 бинарно); Minimax отдаёт hex в `data.audio`
  — декодируем сервером.
- **Ограничения:** `text` 1…2000 символов (иначе 400 `invalid_text`);
  `speed` 0.5–2.0 (400 `invalid_speed`); `pitch` −12…+12 (400 `invalid_pitch`);
  `voice_id` — только из белого списка (400 `invalid_voice_id` со списком
  `allowed`). Дефолт voice_id — `radio_minimax_host_voice` из конфига.
- **Апстрим:** `POST https://api.minimax.io/v1/t2a_v2`, модель по умолчанию
  `speech-2.8-hd` (ТЗ-61; выбор через env `MINIMAX_TTS_MODEL`),
  таймаут 30 с (AbortController внутри fetcher'а). Разрыв соединения с клиентом
  upstream **не** гасит (ТЗ-63 аудит замечание 2): single-flight fetch общий,
  abort одного ждущего завалил бы всех; результат дописывается в кэш.
  `audio_setting`: mp3 / 32 kHz / 128 kbps.
- **Модели TTS** (проверены боевым ключом, обе отвечают 200 на `t2a_v2`):

  | Модель | Статус | Языки | Эмоции | Sound tags |
  |---|---|---|---|---|
  | `speech-2.8-hd` (дефолт) | current | 40 | 10 | ✅ |
  | `speech-02-hd` | legacy | 24 | 7 | ❌ |

  Откат: `MINIMAX_TTS_MODEL=speech-02-hd` в env → recreate, без деплоя.
  Boot-лог: `[Radio] MINIMAX ready (model=…, voices=10)`.
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
- **Лимитер:** 100 запросов/минуту **per-user** (key по `userId`). ТЗ-63:
  лимитер больше не middleware — handler вызывает его через `checkRateLimit()`
  **только при cache miss** (cache hit бесплатен). Подкаст = 5 сегментов × 8
  новостей = 40 запросов за сессию — проходит с запасом 2.5×. Устойчивый абуз
  упирается в 429.
- **Кеш:** `X-Radio-Cache: HIT | MISS` в ответе (диагностика, фронт игнорирует).
  Детали — раздел «Backend mp3-кеш» ниже.
- **Латентность:** базовая p95 ≈ 2.3 с на коротком тексте (замер 2026-09-21);
  cache hit — миллисекунды.

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

## Dashboard MP3-кеша в админке (ТЗ-65)

Расширение таба «Радио»: dashboard поверх backend-кеша (ТЗ-63). In-memory,
без миграций БД. Компонент `pulse-frontend/src/components/admin/Mp3CacheDashboard.tsx`,
вставлен в `RadioTab.tsx`; роут `src/routes/adminRadioCache.ts`, монтируется
в `index.ts` сразу после adminMetricsRoutes (все endpoint'ы под `adminMiddleware`).

**Endpoint'ы** (`/api/admin/radio/mp3-cache/*`):
- `GET /stats` — live: `getRadioMp3CacheStats()` + `getRadioTtsMetrics()` +
  cumulative hitRate. Polling фронтом каждые 5 сек.
- `GET /history` — ring buffer snapshot'ов за 24ч (`getHistory()`).
- `GET /top-keys?limit=N` — top-N ключей по hit count (`getTopKeys()`).
- `POST /clear` — `clearRadioMp3Cache()` (сбрасывает и topKeys) + лог с userId
  админа. Poison recovery за 1 клик.
- `POST /prewarm` — прогрев (`prewarmCommonSegments()`): стандартные сегменты
  + **текущий диалог сводки** (getMarketDialog, 9 реплик × host/guest голоса —
  реально горячие ключи). Темп 1.05 = дефолт плеера юзера. Параллелизм 3,
  upstream — тот же `fetchAndDecodeMinimax` (radio.ts), счётчики hit/miss не
  засоряются.

**Сервисы:**
- `radioMp3CacheHistory.ts` — ring buffer 1440 точек (24ч × 60 мин),
  snapshot каждую минуту (setInterval, не node-cron — per-process, локи
  не нужны). hitRate в точке — delta-based за минуту.
- `radioCacheAlerts.ts` — каждые 5 мин проверка порогов → TG через
  `notifyAdminsSystemAlert`, debounce 1ч на тип. Env:
  `RADIO_CACHE_ALERT_ENABLED` (def true), `_HIT_RATE_MIN` (50, алерт только
  при total > 100 — иначе холодный старт после recreate дал бы ложные),
  `_BYTES_MAX_PCT` (90), `_INFLIGHT_MAX` (50).
- `radioMp3CacheMaintenance.ts` — `startRadioCacheMaintenance({isShuttingDown})`,
  регистрируется в index.ts рядом с остальными кронами.
- Правка `radioMp3Cache.ts` — `topKeys: Map<key, hitCount>`, инкремент в
  `cacheGet` на hit, сброс в `clearRadioMp3Cache()`.

**UI:** live-карточки (записи/размер/inflight + прогресс-бары cyan/amber/red),
lifetime-статистика (hit/miss/total/p95), график recharts 24ч (hit rate слева
0–100%, entries/inflight справа), таблица top-10 текстов (в ключе берётся
только `parts[1]` — текст без MODEL/voice/speed/pitch), кнопки «Прогреть
кэш» / «Обновить всё» / «Очистить кэш» с confirm-диалогами.

**Долги (вне ТЗ-65):** история > 24ч и persist в БД (Д1/Д2), кастомные пороги
алертов через UI (Д3), prewarm кастомных текстов (Д4), графики per-key (Д5),
периодический reset topKeys (Р2 — Map растёт ~500-2000 ключей/день, при
recreate очищается). Verify: `npm run verify:radioCacheDashboard` (11 проверок).
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

## Watchlist котировок через Finam (ТЗ-56, backend `be3c66a`, frontend `6893233`)

До ТЗ-56 наблюдение в `/radio` было хардкодом 4 крипт (BTC/ETH/SOL/BNB) с
прямым поллингом Binance раз в 5 с и фейковым sparkline (`Math.sin`) — техдолг
с TODO в коде. Теперь watchlist строится на **тикерах активных тегов портфеля**
юзера и идёт через единый market-провайдер.

### Бэкенд

- **Роут `GET /api/market/watchlist-quotes`** (`src/routes/marketPublic.ts`,
  authMiddleware):
  1. Активные теги юзера: `portfolios JOIN user_defined_tags`,
     `is_frozen = FALSE`, порядок — алфавит по `tag_name`
     (индекс `idx_portfolios_user_frozen`, UNIQUE(user_id, tag_id) — дублей нет).
  2. Резолв инструмента из `enriched_data` — тот же паттерн, что
     `buildInstrumentsForTags` (news-chart): `symbol` («TICKER@MIC») или пара
     `ticker + mic`; повреждённый JSON → тег пропускается.
  3. Цены батчем `marketRouter.getCurrentPricesBatch` (Finam, concurrency 10,
     дедуп по `TICKER@MIC`), кэш ответа **2 мин по user_id** (in-memory Map).
  4. `currency` по MIC для озвучки: `MISX → RUB`, `XNGS/XNYS → USD`, иначе null.
  - **Pre-check до батча:** нет ключа Finam или окно обслуживания
    (05:00–06:15 МСК) → сразу **503 `market_unavailable`** (иначе batch глотал
    бы ошибки и maintenance выглядел бы как «пустой список»).
  - Тикер без цены от Finam — пропускается (частичный ответ, 200).
  - Без активных тегов / без тикеров → 200 `{ quotes: [] }` (фронт показывает
    подсказку «Добавьте теги в портфеле»).
- **`getCurrentPrice` теперь возвращает `{ price, changePct }`**
  (`finamMarketAdapter.QuoteWithChange`): `change_pct` из Finam
  `/quotes/latest`, фолбэк `change / prev_close * 100`, иначе 0.
  Кэш цен `TTL_PRICE_MS` 1 мин → **2 мин** (по запросу владельца; синхрон с
  кэшем роута). Потребители обновлены: `marketRouter` (single + batch),
  `brokerPortfolioService` (`PositionWithPrice.changePct` — для будущего UI
  портфеля). MOEX ISS adapter не зарегистрирован в роутере — его сигнатура
  старая, TODO при возврате (Д3 ТЗ-56). Admin healthcheck `/providers/status`
  не затронут (probe игнорирует возврат).

### Фронтенд

- **`useFinamWatchlist(isLoggedIn)`** (`src/hooks/useFinamWatchlist.ts`) —
  опрос раз в **60 с через единый api-клиент** (`api.get` — Bearer-заголовок).
  ⚠️ Прямой `fetch` с `credentials: 'include'` НЕ работает: authMiddleware
  читает токен только из заголовка (тот же баг, что был в fetchMarketCached
  ТЗ-55). Гейт по `isLoggedIn` — гостю запросы не нужны.
  Состояния: `quotes / offline / empty / lastUpdate / error`. Ошибка
  (network, 5xx, 503) → последний успешный ответ + плашка «офлайн с HH:MM».
  Пустой список → `empty` (подсказка про теги портфеля). Опрос не паузится на
  скрытой вкладке (Chrome может дросселировать setInterval до 1/мин — с
  периодом 60 с незаметно).
- **`Watchlist.tsx`** принимает `state: WatchlistState`: без sparkline и без
  подписи про источник. `live` в Header = `!offline && lastUpdate !== null`
  («котировки live» / «котировки офлайн»).
- **Озвучка (`buildQuotesSegments`, `lib/radio/summary.ts`):** все тикеры
  подряд (порядок — алфавит tag_name из API) + финальная фраза «лидер дня /
  слабее всех». Валюта из `RadioQuote.currency` («рублей/долларов» — раньше
  было захардкожено «долларов»). Если у всех `changePct === 0` — фраза
  «заметных колебаний нет» вместо случайных лидеров (edge 17 ТЗ-56).
- **`useMarket.ts` удалён** (Binance-поллинг + симуляция), `formatPrice`
  переехал в существующий `src/lib/format.ts`. Тесты:
  `useFinamWatchlist.test.ts` (5, jsdom + @testing-library/react — devDeps),
  currency/all-flat в `radioScripts.test.ts`.

### Эксплуатационные риски

- Лимит Finam 200 req/min: кэш 2 мин на символ = 0.5 req/мин/символ;
  30 уникальных тикеров = ~15 req/min суммарно по всем юзерам — запас большой.
- Эфир «Котировки наблюдения» при ~30 тикерах — 5–7 мин озвучки; решение
  владельца (топ-N — отдельная задача, если станет тяжело).
- `watchlistCache` in-memory: после ребута VDS первый запрос юзера = miss
  (SQL + Finam), дальше штатно.

## Эксплуатация

- **`MINIMAX_API_KEY`** — env, только сервер. При установке: `.env` сервера И
  явный `environment:` backend-сервиса в `docker-compose.yml` (ключ в `.env` без
  правки compose контейнеру недоступен — см. DEPLOYMENT.md). Boot-лог:
  `[Radio] MINIMAX ready (model=…, voices=10)` / `[Radio] MINIMAX_API_KEY not
  set, /api/radio/tts returns 503`.
- **`MINIMAX_TTS_MODEL`** — env (ТЗ-61), дефолт `speech-2.8-hd`. Модель Minimax
  TTS. Откат на legacy: `speech-02-hd`. Проверено ключом: обе 200 на `t2a_v2`.
  В `docker-compose.yml` проброшен как `MINIMAX_TTS_MODEL: ${MINIMAX_TTS_MODEL:-}`.
- **`MINIMAX_CHAT_MODEL`** — env (ТЗ-57 v2), без дефолта: chat-модель для диалога
  сводки (`/api/market/market-dialog`). Не задана → 204 → plain fallback.
- **Метрики:** `GET /api/admin/metrics?section=radio` (adminMiddleware) —
  `total/ok/err_502/err_503`, `rate_502_pct`, `rate_503_pct`, `p95_latency_ms`,
  `avg_latency_ms`; окно латентности — последние 500 попыток, in-memory с
  момента старта процесса. Эксплуатационный summary каждый 100-й запрос:
  `[RadioTTS] stats: …` в docker logs.
- **Стоимость TTS:** дефолтный режим «мысли» = 2 сегмента на карточку;
  авто-поток глобально управляется юзерским `blocks.autoRead` (ТЗ-46; дефолт
  вкл с 2026-09-23 — решение владельца; расход Minimax растёт, ловим аномалии
  метриками);
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
- **`useFinamWatchlist`** — котировки наблюдения (ТЗ-56, см. отдельный раздел
  ниже): `/api/market/watchlist-quotes` раз в 60 с через api-клиент,
  offline-fallback на последний успешный ответ. Заменил удалённый
  `useMarket` (Binance).

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
  body), при ошибке revert. После успешного POST — дебаунс-инвалидация
  `['radio','feed']` (1 с, ТЗ-50), плюс рефетч ленты по focus окна и
  `staleTime` 30 с — счётчик «непрочитано» в плеере не залипает на старом
  значении. Прочитанные выпадают из ленты мгновенно. Скип после
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
- `enqueue(item, label, mode)` дедупит по id карточки; hard cap очереди
  `MAX_QUEUE = 30` (ТЗ-47: warn + drop при переполнении — новости не встают
  быстрее, чем юзер слушает); `speakCustom(label,
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

Header, TickerBar, Watchlist (ТЗ-56: state от useFinamWatchlist, плашка
«офлайн», без sparkline), NewsFeed (score-чип ≥8.5 красный / ≥7 жёлтый /
серый, при 0 нет чипа; «Что это значит» из ТЗ-43), QueuePanel, CalendarPanel
(данные calendarAdapter, статус past/soon по сравнению с текущим времени),
SummaryBar (4 кнопки → эндпоинты; прогресс накопления свежих), PlayerBar
(транспорт ▶ Эфир·N / ⏸ / ⏭ / ■ / очередь / ↗ / ⚙; ТЗ-47: бейдж AUTO рядом
с ON AIR при включённом авто-потоке), SettingsPanel (тумблер «Автоплей
новых» — ТЗ-49, режим на
сессию, browser-голоса, темп, «пилик», пометка minimaxDown; browser-голоса
заблокированы и приглушены, пока жив серверный Minimax — это фолбэк, а не
дубль серверных голосов из `_radio_settings`), AdminPanel
(блоки + параметры; тумблер авто-потока убран в ТЗ-49 — он теперь в
SettingsPanel; дефолт вкл с 2026-09-23).
CSS-переменные прототипа заменены на тему Pulse; keyframes эфира
(radio-ticker, radio-news-in, radio-onair-dot, radio-live-dot, radio-eq-bar)
— в `src/index.css`.

### Сценарии RadioPage (финальная сборка)

1. **Запуск (ТЗ-53):** ▶ Эфир за один клик — приветствие (время суток, день,
   счётчик) → общее саммари рынка (только кэш крона `marketCached`, 0 LLM;
   нет кэша — шаг молчит) →
   персональное саммари (API → фолбэк; без интересов шаг пропускается) →
   топ непрочитанных по убыванию score (лимит 5/8/12, новости из саммари
   исключены — `pickedIds`), label «эфир · N из M» — только визуальный →
   полный календарь («Повестка дня», если `blocks.calendar`). Кнопки
   саммари/календаря/котировок остаются для ручного запроса.
2. **Фон:** SSE-новость → подсветка 4 с + пилик (≥8.5 тройной) → авточтение
   при `blocks.autoRead` (юзер, дефолт вкл с 2026-09-23) + кулдаун 30 с после ▶
   Эфир (приветствие не перебивается; визуал SSE не затрагивается);
   фильтра важности нет.
3. **Саммари (ТЗ-55):** «Моё» → `/api/user/summary?hours=12`; «Саммари рынка»
   (жёлтая) → read-only кэш крона `/api/user/summary-global/cached` (0 LLM,
   обновляется раз в 6ч, спиннер + ретрай 30с до 30 мин пока кэш греется);
   «Свежий обзор» (циан) → `/api/user/summary-global` (накопление свежих
   non-reprint до threshold, LLM; повтор без refresh=1 — в логах бэка
   `cached: true`); при ошибке эндпоинтов — клиентский фолбэк summary.ts.
   «Что сегодня» — buildCalendarSegments; «Котировки» — buildQuotesSegments
   (watchlist). В эфире звучит только кэш крона — LLM-триггера нет.
4. **Плеер:** быстрые «стоп→эфир→стоп→эфир» = один голос (genRef-регрессия).
5. **Watchlist** — Finam через `useFinamWatchlist` (ТЗ-56): тикеры активных
   тегов портфеля, поллинг 60 с, offline-плашка; Binance-хук удалён.

### Гейты

`npx vitest run` — 167 тестов (радио: adapters 22, scripts/summary 29,
useFinamWatchlist 5, cascadeChart 7, factCheckInput 20);
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
| Блоки эфира (6): бегущая строка, наблюдение, календарь, панель эфира, панель саммари, «пилик» | вкл/выкл каждый | все вкл |
| Автоплей новых (ТЗ-49, живёт в SettingsPanel; из блоков эфира убран) | юзерская настройка авто-потока; **дефолт вкл** (с 2026-09-23) — каждая новая новость сама встаёт в очередь озвучки; выкл — только ручной запуск ▶ Эфир / ▶ на карточке | **вкл** |
| Порог саммари рынка | 25 / 50 / 100 свежих | 50 |
| Скорость ленты | быстро / норма / медленно | норма |
| Длина запуска эфира | 5 / 8 / 12 | 8 |
| Сюжетов в своём саммари | 3 / 4 / 5 | 4 |
| Режим воспроизведения | текст / мысли / подкаст | из server flag |
| Browser-голоса ведущего/аналитика (фолбэк при недоступности серверного TTS; заблокированы в UI, пока жив Minimax) | авто + системные | авто |
| Темп | 0.70–1.60× | 1.00 |
| «Пилик» | вкл/выкл | вкл |

Авточтение = только `blocks.autoRead` (юзер, тумблер «Автоплей новых» в
SettingsPanel, ТЗ-49; **дефолт вкл с 2026-09-23** — решение владельца,
до этого выкл с ТЗ-47).
Серверного флага авточтения больше нет: серверный `service_enabled=false`
выключает радио целиком (заглушка + 503 на TTS). Фильтра важности при
авточтении нет: все новости по тегам или никаких (осознанное упрощение v1).

### Что удалено из прототипа намеренно

- Severity и словесные категории (только число `score`).
- `minimaxKey` в localStorage (ключ — только сервер).
- `handleSpike` в watchlist (алерты — вне ТЗ-42/43/44; watchlist был временным
  на Binance — удалён целиком в ТЗ-56, заменён Finam-версией через
  `/api/market/watchlist-quotes`).
- Прямой вызов Minimax из фронта (`lib/minimax.ts` прототипа не переносится).

## Сценарии эфира (контракт для ТЗ-43/44)

1. **Запуск (ТЗ-53):** приветствие → общее саммари рынка (**ТЗ-57:** диалог
   host+guest через Minimax chat, fallback на plain text) → персональное саммари
   (без интересов — пропуск) → топ непрочитанных по убыванию score (лимит
   5/8/12, без новостей из саммари) → полный календарь. Анонс «эфир · N из M» —
   только визуальный label плеера.
2. **Фон:** SSE-новость по тегам → подсветка 4 с + пилик (≥8.5 — тройной) →
   авточтение при юзерском `blocks.autoRead` (ТЗ-46; дефолт вкл с 2026-09-23;
   кулдаун 30 с после запуска эфира).
3. **Саммари-кнопки:** «Моё саммари» → `/api/user/summary?hours=12`;
   «Саммари рынка» → `/api/user/summary-global/cached` (кэш крона, 0 LLM);
  «Свежий обзор» → `/api/user/summary-global` (LLM, кэш 6 ч, повтор без `refresh=1`);
   «Что сегодня» → `/api/calendar`; «Котировки» → watchlist (ТЗ-56: тикеры
   активных тегов портфеля через Finam). Клиентский `summary.ts` — фолбэк,
   когда LLM-эндпоинты недоступны.
4. **Юзер без тегов:** заглушка «Радио молчит, потому что не знает ваших
   интересов» + CTA в настройки тегов Pulse + «послушать общее саммари»
   (`/api/user/summary-global`) — воронка лендинга.

## Диалог общей сводки рынка (ТЗ-57, в проде)

Шаг 2 эфира озвучивает общую сводку не plain text одним голосом, а **диалогом**
ведущий+аналитик (6-8 реплик, голоса по `role` через существующий T2A).

**Пайплайн:** кэш крона (`globalSummary.ts`, Kimi, бесплатно) → `services/radioPodcast.ts`
 берёт `cached.summary` (строка), дёргает **Minimax chat**
(`POST https://api.minimax.io/v1/chat/completions`, нативный fetch, как в `routes/radio.ts`),
промпт требует вернуть `{"dialog":[{role,text}]}` → парсится строгим `parseDialogResponse`
(whitelist ролей host/guest, снимается ```json-обёртка) → кэш 6ч в in-memory Map,
ключ — первые 200 символов сводки → фронт озвучивает `speakCustom('Саммари: диалог', segments)`.

- **Endpoint:** `GET /api/market/market-dialog` (auth, Bearer). 204 если: кэша
  крона нет / не задан `MINIMAX_API_KEY` или `MINIMAX_CHAT_MODEL` / Minimax
  ошибся. Сервис никогда не бросает — fallback на plain text во фронте.
- **Env:** `MINIMAX_CHAT_MODEL` (новая) — имя chat-модели, **не хардкодится**
  (список моделей Minimax меняется; проверить `GET /api.minimax.io/v1/models`
  с тем же ключом). Boot-лог: `logRadioPodcastConfig()` из `index.ts`.
- **In-flight lock:** конкурентные запросы = один вызов LLM (паттерн globalSummary).
- **Фронт:** `lib/radio/fetchMarketDialog.ts` — через api-клиент (Bearer) +
  гость-чек `safeStorage` (гость запрос не делает; у него шаг 2 молчит, как раньше).
  Префетч в стейт `marketDialog` при появлении `marketCached` — к запуску эфира
  диалог уже готов. В `startBroadcast` страховочный `await fetchMarketDialog()`.
- **Гейты:** бэк `npm run verify:radioPodcast` (11 проверок чистых функций,
  включая съём `<think>` и `<answer>`);
  фронт `fetchMarketDialog.test.ts` (5 тестов, мок api-клиента).
- Исправленная спека: `TZ-57_RADIO_MARKET_DIALOG_v2.md` (аудит v1 нашёл: fetch
  с `credentials:'include'` → вечный 401; неверный путь импорта типа; непроверенная
  модель `M2-her`; тесты на отсутствующем vitest-бэке).

### Персонажи (ТЗ-58)

С 2026-09-24 в эфире постоянные ведущие: **Михаил** (host) и **Татьяна** (guest).

- Михаил открывает эфир: «Здравствуйте. Сегодня у нас в студии Татьяна — наш аналитик…».
- Татьяна отвечает на приветствие и анализирует: «Привет, Михаил. Начнём с…».
- 6-8 реплик, естественный разговорный ритм. Имена — только при обращении друг к другу.
- Финальная реплика Михаила: «Продолжаем следить для вас за рынком.»
- `max_tokens: 4000` (reasoning-модель M2.x тратит лимит на `<think>`; обрезка
  JSON → молчаливый fallback). Парсер снимает `<think>`, `<answer>`, ```json.

Изменить имена/прощание — одна строка в `SYSTEM_PROMPT` (`services/radioPodcast.ts`).
Важно: при деплое правок промпта — `recreate` контейнера (не `restart`), иначе
in-memory кэш 6ч отдаст старые диалоги. Голоса host/guest — прежние
(presenter_male/female, ТЗ-44), имена звучат только в тексте.

### Кеш mp3: префетч (C) + конвейер (B) — ТЗ-59

Проблема: каждый сегмент ждал TTFB Minimax (1-3 сек) прямо во время эфира —
9-27 сек тишины на диалоге. Решение — единый кеш mp3 с двумя путями наполнения:

- **`lib/radio/mp3Cache.ts`** — `Map<key, Promise<Blob>>`, ключ =
  `text + voice_id + speed + pitch` (pitch в ключе, иначе фолбэк тембром +2
  ломал дедупликацию). LRU 32 записи (~10 МБ), failed-промисы вытесняются
  для retry, параллельные `load()` с одним ключом = один сетевой запрос.
  Abort-signal намеренно не поддерживается: общий промис нельзя оборвать
  одному потребителю — стоп/скиp отбрасывает результат через gen-check.
- **Префетч (C), `RadioPage`** — через 5 сек после появления `marketDialog`
  все сегменты грузятся параллельно (`Promise.all`). Голоса берутся из
  серверного конфига (`/api/radio/config`), темп — текущий `speech.rate` —
  ключи совпадают с плеером, кеш общий.
- **Конвейер (B), `useSpeech.speakSegment`** — пока играет текущий сегмент,
  догружается следующий (включая первый сегмент следующей карточки очереди).
  Playback идёт через `loadMp3` — cache hit = 0 мс между репликами.

Итог: залогиненный юзер жмёт ▶ Эфир через 5+ сек после входа — диалог играет
вплотную. Сразу после входа — первый сегмент ждёт TTFB, остальное подхватывает
конвейер. Тесты: `mp3Cache.test.ts` (6 тестов: дедуп, eviction, retry, pitch).

### Модель TTS — ТЗ-61

Модель озвучки выбирается env `MINIMAX_TTS_MODEL`, дефолт `speech-2.8-hd`
(проверено ключом: обе модели 200 на `t2a_v2`). Откат на `speech-02-hd` —
одна строка в `/opt/pulse/.env` + recreate, без деплоя. Boot-лог:
`[Radio] MINIMAX ready (model=…, voices=10)`. Фронт модель не знает —
выбирает бэк. Тембр Михаила/Татьяны может отличаться от 02-hd (риск Р1 ТЗ-61).

### Backend mp3-кеш — ТЗ-63

Зачем: `POST /api/radio/tts` дёргал Minimax на каждый запрос (TTFB 1–3 с + деньги).
При масштабировании радио на гостей (ТЗ-64) это $-критично. Решение —
per-process in-memory кеш (`src/services/radioMp3Cache.ts`), один сегмент для
всех юзеров генерируется 1 раз за TTL. Только радио: ни таблиц БД, ни миграций.

- **Ключ:** `MODEL \x00 text.trim() \x00 voice_id \x00 speed \x00 pitch`.
  MODEL в ключе (аудит зам. 3) — защита от hot-swap модели: mp3 старой модели
  не отдаются под новой. `MINIMAX_TTS_MODEL` — единый источник в
  `radioMp3Cache.ts`, radio.ts импортирует (дефолт не дублируется).
- **TTL 6ч** — синхронизирован с кэшами диалога (`radioPodcast`) и `globalSummary`;
  протухшие вытесняются лениво при `cacheGet`. **Лимиты:** 256 записей / 80 МБ
  (≈14 диалогов: 9 сегм × 2 голоса × ~300 КБ), FIFO eviction с LRU-touch.
- **Single-flight:** `inflight Map` — N параллельных miss с одним ключом = 1
  upstream-вызов; на error кэш **не** пишется (инвариант «не отравить»).
- **Цепочка handler:** kill-switch → валидация → apiKey → cache hit? (отдать,
  `recordTtsResult('ok', lat, 'hit')`, лимитер не трогаем) → `checkRateLimit`
  (ТОЛЬКО на miss) → `getOrFetchMp3` → `fetchAndDecodeMinimax` (бросает при
  ошибке → 502, кэш не пишется). Ответ маркируется `X-Radio-Cache: HIT|MISS`.
- **Лимитер** (`checkRateLimit` в `rateLimit.ts`): обёртка над лимитером с
  промисом; false резолвится только при `res.headersSent` (лимитер реально
  отправил 429), иначе ждём второй тик (аудит зам. 1 — защита от тайминга
  express-rate-limit). Худший кейс — лишний 429, а не пропущенный miss.
- **AbortController** создаётся внутри fetcher'а (аудит зам. 2): shared
  single-flight fetch не отменяется по disconnect отдельных ждущих; отключение
  клиента во время T2A (1–3 с) upstream не рубит — результат дописывается в
  кэш. Предохранитель — таймаут 30 с.
- **Метрики:** `recordTtsResult` принимает `source: 'hit'|'miss'|'unknown'`
  (дефолт 'unknown' — старые call-sites валидны); в админке
  `/api/admin/metrics?section=radio` появились `cache_hit`, `cache_miss`;
  эксплуатационный лог каждые 100 запросов печатает `cache(hit/miss)=N/M`.
- **Клиентский кеш ТЗ-59 не тронут** — он убирает сетевой RTT, серверный —
  деньги/TTFB на shared-сегментах; дублирование оправдано.
- **Долги ТЗ-63 (вне его скоупа):** pre-warm при boot (Д3, кеш пуст после
  recreate ~до первого эфира). ~~admin-endpoint для `clearRadioMp3Cache()` (Д2)~~
  и ~~stats кеша в админке (Д4)~~ — **сделано в ТЗ-65** (dashboard MP3-кеша,
  см. ниже).
- **Воспроизводимость:** при recreate контейнера кеш пуст (in-memory) — первый
  эфир после рестарта снова платный, дальше hit. Verify:
  `npm run verify:radioMp3Cache` (17 проверок: miss/hit, single-flight,
  различие ключей, eviction 80 МБ, error-инвариант).

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
| Дефолт авточтения выкл + AUTO-бейдж + лимит очереди 30 + кулдаун 30 с (ТЗ-47) | Баг «нажал плей — прилетело прямо много»: каждая SSE-новость вставала в очередь поверх эфира. RADIO.md §4.1 (дефолт «важные») противоречил коду («все») — действует дефолт «выкл», юзер включает сам; существующие localStorage не мигрируем |
| Автоплей — в SettingsPanel, не в AdminPanel (ТЗ-49) | Юзерская настройка в конструкторе эфира — путаница: у обычного юзера нет доступа в админку, это его персональное радио. Тумблер «Автоплей новых» — первой секцией в настройках эфира; из BLOCK_META убран, хранение то же (`blocks.autoRead`) |
| Browser-голоса заблокированы, пока жив Minimax (frontend `3e7a9cd`) | Селекты «Голос ведущего/аналитика» — фолбэк на speechSynthesis при 503 tts_not_configured, а не дубль серверных голосов из `_radio_settings`. При живом провайдере выглядели дублем админки и сбивали юзера — теперь приглушены (opacity-40, disabled) с подписью, при фолбэке разблокируются автоматически |
| Порядок автоэфира: приветствие → общее → персональное → новости → календарь (ТЗ-53, frontend `bfed6b5`) | Один клик ▶ Эфир = полный сценарий «контекст → личная выжимка → детали → что смотреть дальше»; `market` не формируется заново (кэш, иначе fire-and-forget); новости из персонального саммари исключены из топа (`pickedIds`), чтобы не озвучивать дважды; calLine убрана из приветствия — календарь звучит целиком в конце |
| Шаг 2 эфира — `await readMarketSummary()`, guard `speech.isSpeaking` (ТЗ-54, frontend `abc665b`) | Ревью ТЗ-53: fire-and-forget вклинивал саммари рынка в конец эфира (IIFE не возвращался наружу — await ждал undefined); двойное ▶ эфир гоняло два эфира параллельно. Guard readMarketSummary по `segments?.length` — market с пустыми сегментами рефетчится, а не молчит. ⚠️ Частично отменено ТЗ-55: await больше не нужен — шаг 2 перешёл на кэш крона, LLM из эфира исключён; guard `isSpeaking` оставлен |
| Два источника саммари рынка: `marketCached` (кэш крона, 0 LLM) и `marketFresh` (LLM, порог свежих) — ТЗ-55, backend `c7ecf7a`, frontend `ad614ed` | Одна кнопка серая до 50 свежих = юзер без контекста + платный LLM на каждый клик. Разделение: жёлтая кнопка живёт с первого крона (~3 мин после boot), эфир использует только её (0 списаний Kimi); циановая «свежий обзор» — LLM. Read-only эндпоинт без лимитера (O(1) in-memory), 204 → фронт ретраит 30с × 60 попыток |
| Watchlist котировок — Finam по активным тегам портфеля, не Binance-хардкод (ТЗ-56) | Крипто-хардкод с симуляцией цен — техдолг с TODO. Единый провайдер Finam уже обслуживает графики новостей и портфели — watchlist встаёт в ту же инфраструктуру (кэш 2 мин, лимит 200 req/min держится кэшем). Персонализация бесплатно: тикеры уже резолвятся в `enriched_data` тегов. Прямой fetch с кукой отвергнут — authMiddleware читает только Bearer, опрос строго через api-клиент |
| Счётчик непрочитанных: optimistic readIds + invalidate ['radio','feed'] с дебаунсом 1 с + focus-рефетч, staleTime 30 с (ТЗ-50) | Баг «прослушал всё — плеер показывает непрочитано 40»: POST /read уходил на сервер, но кэш ленты (2 мин staleTime) не инвалидировался. Дебаунс — один рефетч после эфира вместо N; focus — актуальный счётчик при возврате на вкладку |
| Minimax через серверный прокси | Ключ в браузере = скомпрометирован; плюс единая точка метрик/лимитов |

## Связи

- DEPLOYMENT.md — env-таблица (`MINIMAX_API_KEY`), правила установки ключей.
- ARCHITECTURE.md §Real-time Updates (SSE) — payload `news` и история фикса.
- RADIO.md (пакет радио) — продуктовый контекст и сценарии.
- `docs/market-data.md` — единый market-провайдер Finam (TTL-кэши, алиасы
  MOEX→MISX/NASDAQ→XNGS/NYSE→XNYS); watchlist ТЗ-56 стоит на нём.
- ТЗ-42/43/44/45/46/47/49/50/53/54/55/56, REVIEW_RADIO_TZ42_V31 — исходные
  ТЗ и вердикт техлида; `TZ-56_RADIO_WATCHLIST_FINAM_2026-09-23.md` — ТЗ и аудит.
- Прототип-донор `radio-app/` — песочница, в прод не переносится целиком
  (переносятся 10 компонентов, useSpeech с genRef, greeting/scripts/share/sound/
  summary/config — карта в ТЗ-44 задача 3).
