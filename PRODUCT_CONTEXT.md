# PULSE -- Product Context & Agreements

> Файл обновляется при КАЖДОЙ новой договорённости.

---

## КРИТИЧЕСКИЕ ПРАВИЛА

### Правило: Email -- ключевое поле в базе пользователей
- **Email = PRIMARY KEY в таблице users**
- Email **НЕЛЬЗЯ менять** после регистрации
- Username (логин) -- редактируемый, отображается в интерфейсе
- В профиле: email read-only, username -- editable
- ❌ ЗАПРЕЩЕНО давать пользователю менять email самостоятельно
- Смена email только через поддержку (ручной процесс)
- Все связи в БД (portfolio, payments, sessions) -- по `user.id`

### Правило: перевод англоязычных новостей
- **Все английские новости обязательно переводятся на русский**
- Пользователь видит **только русский текст** -- заголовки и описания
- Русские источники (13) -- без изменений
- Английские источники (19) -- перевод через Kimi API (moonshot-v1-32k)
- **Перевод не делается на клиенте** -- требуется backend + API-ключ
- ❌ ЗАПРЕЩЕНО показывать английские заголовки без перевода
- ❌ ЗАПРЕЩЕНО смешивать русские и английские новости в одной ленте без перевода

### Правило: хранение новостей
- **Backend хранит новости в БД (PostgreSQL) -- 2 недели**
- После 2 недель -- автоматически удаляются
- Backend -- источник правды, клиентский кэш -- только для скорости
- ❌ НЕ хранить новости только в кэше клиента

### Правило: при backend -- мок-новости КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ
- `getNewsForTag()` из `mockData.ts` -- удаляется целиком
- Все новости -- только из RSS через API
- Fallback на мок-данные -- **ЗАПРЕЩЁН**
- Это платный продукт -- только реальные новости

### Правило: хранение платежей (КРИТИЧЕСКО)
- **ВСЕ платежи сохраняются в БД (таблица `payments`)**
- Сумма, базовая цена, скидка %, метод, статус, provider_ref
- Каждый платёж = запись для истории, аналитики, чеков
- ❌ НЕ терять информацию о платежах
- Связь: `payments.user_id → users.id`

### Правило: 3 карусели новостей
- **Карусель 1 "Это вы ещё не видели"**: непрочитанные по тегам, DESC сортировка
- **Карусель 2 "Вся лента"**: прочитанные по тегам, DESC сортировка
- **Карусель 3 "Общая лента"**: все новости без фильтра тегов, видна без логина
- Новость считается прочитанной **ТОЛЬКО явно**: клик / кнопка ✓ / 2 сек в viewport при 80%+ видимости

### Правило: перевод через Kimi API
- Google Translate **ЗАБЛОКИРОВАН** на Render → используем Kimi API (api.moonshot.ai)
- **Endpoint**: `api.moonshot.ai` (НЕ `.cn` -- возвращает 401)
- **Модель**: `moonshot-v1-32k` (kimi-k2/k2.5 недоступны на текущем плане)
- **Batch size**: 5 текстов за запрос
- ❌ ЗАПРЕЩЕНО использовать Google Translate на Render
- ❌ ЗАПРЕЩЕНО использовать api.moonshot.cn -- 401 Unauthorized

### Правило: пользовательские теги
- Пользователь может создать **ЛЮБОЙ тег** через поиск
- Система автоматически генерирует keywords + транслит + склонения
- Автоматический **BACKFILL** всех существующих новостей
- Карусели автоматически обновляются (`tagVersion → invalidateQueries`)
- ❌ ЗАПРЕЩЕНО ограничивать список тегов предопределённым набором

### Правило: sentiment + liquid glass
- Все карточки новостей -- **liquid glass эффект** (`backdrop-filter: blur`)
- Цвет рамки/свечения зависит от sentiment:
  * 🟢 Зелёный (`#34D399`) = positive
  * 🔴 Красный (`#F87171`) = negative
  * ⚪ Серый (`#9CA3AF`) = neutral
- Sentiment определяется **keyword-based** (быстро) или **LLM через Kimi API** (точнее)
- **Tag Impact**: как новость влияет на КАЖДЫЙ тег (positive/negative/neutral + reasoning)

---

## Тарифы
- Free: 3 тега, лента на сайте
- Premium: 10 тегов, 490 ₽/мес, репорты + алерты

## Источники новостей (20+)
- RU + EN (см. DESIGN_SPEC.md)

## Технический стек
- React 19 + TypeScript + Vite + Tailwind CSS v3.4 + shadcn/ui
- HashRouter (SPA), localStorage (client-side DB), Framer Motion
- React Query (@tanstack/react-query) — кэширование, optimistic updates, background refetch
- IntersectionObserver — auto-mark-read после 2 секунд при 80%+ видимости
- Kimi API — перевод, sentiment, tag matching

## Workflow (ПОСЛЕ каждой доработки) — КРИТИЧЕСКОЕ ПРАВИЛО
1. Собрать: `npm run build`
2. Задеплоить
3. **Git commit + push: `git add -A && git commit -m "type: description" && git push origin main`**
4. **Проверить на production (Render) — регистрация, логин, основные сценарии**
5. **Указать пользователю: что обновлено + git commit hash + статус проверки**
6. **Обновить DESIGN_SPEC.md если логика изменилась**
7. **Обновить PRODUCT_CONTEXT.md если договорённости изменились**
8. **Обновить CAROUSELS.md если логика каруселей изменилась**
9. **Обновить ARCHITECTURE.md если pipeline/модели изменились**

**❌ ЗАПРЕЩЕНО: делать изменения без git commit + push**
**❌ ЗАПРЕЩЕНО: молча обновлять файлы без записи в документацию**

### Новые критические правила (2026-05-26)
- ✅ **Каждое изменение = git commit + push** — никаких накоплений
- ✅ **Обновлять PRODUCT_CONTEXT.md после каждой сессии** — фиксировать договорённости
- ✅ **Проверять регистрацию/логин после изменений auth** — "works on my machine" не считается
- ✅ **Жёстко прописывать API URL** — `import.meta.env` ненадёжен в продакшене
- ✅ **Минимум 8 символов пароль** — совпадение фронтенд-валидации с бэкендом

### Новое правило: Glow анимация = pill shape (rounded-full)
- Тег имеет форму pill (rounded-full, h-9)
- Glow анимация применяется к обёртке с `rounded-full`
- Никогда не квадратная — всегда повторяет форму тега

---

## Sandbox & Git Setup (настроено 2026-05-26)

### Структура рабочей среды
```
/mnt/agents/
├── projects/
│   ├── backend/     ← git clone https://github.com/vladfa2010/pulse.git
│   └── frontend/    ← git clone https://github.com/vladfa2010/pulse-frontend.git
└── upload/
    ├── DESIGN_SPEC.md      ← спецификация (ручное обновление)
    └── PRODUCT_CONTEXT.md  ← правила (ручное обновление)
```

### Git push-доступ настроен
- **Backend:** `origin → https://TOKEN@github.com/vladfa2010/pulse.git`
- **Frontend:** `origin → https://TOKEN@github.com/vladfa2010/pulse-frontend.git`
- **Git user:** `PULSE Dev <dev@pulse.app>`
- Токен хранится в remote URL (не в credential helper)
- Git config: `http.version HTTP/1.1`, `http.postBuffer 524288000`

### Workflow push (после git commit)
```bash
cd /mnt/agents/projects/backend  && git push origin main
cd /mnt/agents/projects/frontend && git push origin main
```

### Правило: обновлять оба репозитория синхронно
- Backend и frontend — один проект, commit'ы должны идти парами
- Указывать hash обоих commit'ей пользователю
- ❌ ЗАПРЕЩЕНО push'ить только один репозиторий, если изменения касаются обоих

---

## Файлы документации проекта (5 файлов)

| # | Файл | Строк | Назначение |
|---|------|-------|-----------|
| 1 | `DESIGN_SPEC.md` | 410+ | Полная спецификация (архитектура, компоненты, flow, backend) |
| 2 | `PRODUCT_CONTEXT.md` | 60+ | Критические правила + история договорённостей |
| 3 | `src/lib/copy.ts` | 167 | Все тексты UI (single source of truth) |
| 4 | `README.md` | 73 | Шаблон Vite (не используем) |
| 5 | `info.md` | 30 | Шаблон Vite (не используем) |

**Рабочие файлы: 1, 2, 3** — DESIGN_SPEC, PRODUCT_CONTEXT, copy.ts

---

## История договорённостей
- ✅ **FIXED: Теги синхронизируются при login/logout** — сброс на logout, загрузка из БД на login
- ✅ **FIXED: seed() не перезаписывает portfolio** — guard на существующее портфолио
- ✅ **FIXED: убран дублирующий seedDB() из db.ts** — единственный seed в useAuth.tsx
- ✅ **Sandbox + Git push настроены** — оба репозитория клонированы в `/mnt/agents/projects/`, push через GitHub PAT
- Перевод английских новостей на русский (все EN → RU)
- Теги: label для отображения (не ticker)
- Теги: клик на label → /feed
- Теги: анимация удаления (AnimatePresence popLayout)
- Только реальные новости (без мок-данных)
- NewsFeed: реальные теги из getPortfolio() + Layout обёртка
- Profile: синхронизация удаления тегов с portfolio DB
- Navbar: window.location.href = '/#' после logout
- ✅ **NewsCard: liquid glass + sentiment colors + без картинки + left-aligned**
- ✅ **Сортировка новостей: по времени, свежие слева**
- ✅ **Tag existing glow:** мягкое подсвечивание жёлтым при попытке добавить дубликат
- ✅ **User stats:** `createdAt` ("С нами с") + `newsCount` ("Изучено новостей") в профиле
- ✅ **Renewal discount:** скользящая скидка (25%/15%/10%/0%) — чем раньше продлеваешь, тем дешевле
- ✅ **Reports via Telegram bot:** автоматические дайджесты по тегам, TG приоритет #1
- ✅ **Product vision:** слежу за портфелем → читаю все → отбираю релевантное → анализирую → еженедельный репорт → 5 минут вместо 2 часов
- ✅ **Репорт: воскресенье 13:00 МСК** — перед новой недель
- ✅ **Sentiment-алерты:** мгновенные уведомления на positive + negative
- ✅ **11 настроек уведомлений:** каналы, частота, тип, алерты, время, тихие часы, формат, язык
- ✅ **SubscribeBlock:** портфель инвестиционно.рф (VastData, Crusoe, SpaceX, Cashea) + "Добавить портфель"
- ✅ **Условия пользования (/terms):** без инвестрекомендаций, AI обработка, данные не передаются
- ✅ **Политика конфиденциальности (/privacy):** 152-ФЗ, данные в РФ, нет третьим лицам
- ✅ **Галочка согласия:** корректно ссылается на /terms и /privacy, блокирует отправку
- ✅ **Pricing: кнопки X (закрыть) и ← Назад**
- ✅ **Регистрация: кнопка "Пропустить верификацию"** — вход без ожидания письма
- ✅ **Все тексты UI в src/lib/copy.ts** — single source of truth
- ✅ **Текст: "Изучаем новости для вас"** вместо "Проверяем 10 источников каждый час"
- ✅ **3 карусели:** Карусель 1 (непрочитанные по тегам), Карусель 2 (прочитанные по тегам), Карусель 3 (все новости, без логина)
- ✅ **Optimistic updates:** новость мгновенно перемещается между каруселями через `setQueryData()`
- ✅ **Tag reactivity:** `tagVersion++` → `invalidateQueries` → автоперезагрузка лент
- ✅ **Explicit read only:** новость прочитана только по клику/кнопке/2сек viewport
- ✅ **Liquid glass UI:** sentiment-цветные карточки с `backdrop-filter: blur`
- ✅ **User-defined tags:** поиск → создание → авто-keywords → backfill → автопоказ в ленте
- ✅ **Translation fix:** Google Translate blocked → Kimi API (moonshot-v1-32k)
- ✅ **Smart tag matching:** keyword + LLM + related tags, ищет по title + summary
- ✅ **Tag impact analysis:** LLM определяет влияние новости на каждый тег
- ✅ **RSS: 20+ источников**, batch processing каждые 15 минут
- ✅ **Anti-duplicate:** `content_hash` UNIQUE + `ON CONFLICT DO UPDATE` + all_sources tracking

*Последнее обновление: 2026-05-26 (текущая сессия)*
*Подтверждено: синхронизация тегов работает корректно*

---

### Auth Refactor (2026-05-25) — DONE ✅

**Проблема:** две параллельные системы авторизации — localStorage (client-side DB) и Backend API (SQLite). Демо-пользователь demo@pulse.ru живёт в localStorage, не в базе.

**Правила рефактора:**
- ❌ **localStorage НЕ используется как база данных** — убрать setUsers, getUsers, findById, portfolios в localStorage
- ✅ **localStorage — ТОЛЬКО для JWT токена**
- ✅ **useAuth — ТОЛЬКО через API** (POST /api/auth/login, GET /api/auth/me)
- ✅ **Демо-пользователь — через бэкенд** (POST /api/auth/demo) — создаётся в SQLite
- ✅ **Одна база данных** — SQLite/PostgreSQL, единый источник правды
- ❌ **Никакого hardcoded demo в фронтенде**
- ✅ **is_admin в таблице users** — флаг администратора в БД
- ✅ **Админка защищена** — middleware проверяет is_admin, неавторизованных редиректит
- ✅ **Админка через API** — данные из /api/admin/*, не из localStorage
- ✅ **Admin endpoint защищён** — 403 для non-admin, JWT проверка
- ✅ **Ошибки авторизации на русском** — "Неправильный логин или пароль", "На эту почту уже зарегистрирован аккаунт"
- ✅ **Проверка email при регистрации** — бэкенд проверяет уникальность, фронтенд показывает ошибку под полем
- ✅ **login/register возвращают { success, error? }** — ошибка передаётся на фронтенд и отображается пользователю
- ✅ **Сетевые ошибки перехватываются** — ApiError с кодом NETWORK_ERROR, понятное сообщение пользователю
- ✅ **Бэкенд должен быть доступен из интернета** — localhost не работает из деплоенного фронтенда
- ✅ **Бэкенд задеплоен на Render** — https://pulse-api-bsov.onrender.com
- ✅ **Dockerfile: npm install + npx tsc** — TypeScript ставится как devDependency
- ✅ **Environment: USE_SQLITE=true + JWT_SECRET** — Render настройки

---

### Backend agreements (added 2026-05-25)

- ✅ **SQLite zero-config mode** — `USE_SQLITE=true` by default, sql.js (pure JavaScript/WASM, no native compilation)
- ✅ **Dual-mode database** — работает с SQLite (development) и PostgreSQL (production) через единый интерфейс
- ✅ **10 таблиц:** `users`, `portfolios`, `payments`, `news`, `user_sessions`, `user_channels`, `notification_settings`, `translation_cache`, `user_defined_tags`, `smart_tag_cache`
- ✅ **7 API routes:** `auth`, `news`, `payment`, `user`, `translate`, `webhook`, `admin`
- ✅ **RSS aggregator:** 20+ источников (RU + EN), batch по 5, cron каждые 15 минут
- ✅ **Translation:** Kimi API (moonshot-v1-32k) + `translation_cache` таблица
- ✅ **Weekly reports:** Воскресенье 13:00 MSK, Telegram Bot + Email (SendGrid)
- ✅ **Docker:** `docker-compose.yml` (PostgreSQL 16 + Redis 7 + Backend), Dockerfile multi-stage Node 20 Alpine
- ✅ **Git branch:** `stable`
- ✅ **User-defined tags:** авто-генерация keywords + backfill существующих новостей
- ✅ **Sentiment analysis:** keyword-based fallback + LLM через Kimi API
- ✅ **Tag impact analysis:** LLM определяет влияние новости на каждый тег
- ✅ **Smart tag matching:** keyword + LLM + related tags, ищет по title + summary
