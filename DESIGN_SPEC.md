# PULSE — Design & Logic Specification

> Единый файл спецификации. Читается ПЕРЕД любой доработкой.
> Обновлён: текущая сессия

---

## 1. АРХИТЕКТУРА

### 1.1 Стек
- React 19 + TypeScript + Vite
- Tailwind CSS v3.4 + shadcn/ui
- HashRouter (react-router)
- Framer Motion
- localStorage (client-side DB)
- Lucide React (иконки)

### 1.2 Структура файлов

**Локальная среда разработки (sandbox):**
```
/mnt/agents/projects/
├── backend/           ← git: vladfa2010/pulse (main branch)
│   ├── src/index.ts   ← Express server entry
│   ├── src/routes/    ← 7 API routes (auth, news, payment, user, translate, webhook, admin)
│   ├── src/services/  ← RSS, translate, telegram, email, cron
│   └── src/config/    ← DB (SQLite/PostgreSQL dual-mode)
└── frontend/          ← git: vladfa2010/pulse-frontend (main branch)
    ├── src/App.tsx    ← HashRouter entry
    ├── src/pages/     ← 8 pages (Home, NewsFeed, Pricing, Login, Profile, Admin, Terms, Privacy)
    ├── src/hooks/     ← useAuth (API-only, no localStorage DB)
    └── src/lib/       ← api.ts, copy.ts
```

```
src/
  pages/
    Home.tsx           — Главная (поиск, теги, таймлайн)
    NewsFeed.tsx       — Лента (/feed) — реальные теги из getPortfolio()
    Pricing.tsx        — Тарифы (/pricing) — standalone + modal
    Login.tsx          — Вход/регистрация
    Profile.tsx        — Профиль — back button, tag deletion sync
    Admin.tsx          — Админка (is_admin guard, API data)
    Terms.tsx          — Условия пользования
    Privacy.tsx        — Политика конфиденциальности
  components/
    Navbar.tsx         — Fixed top, z-50, pointer-events-auto
    Layout.tsx         — Navbar + main + Footer
    NewsCard.tsx       — Liquid glass карточка без картинки, sentiment colors, теги
    Tag.tsx            — Pill с цветной точкой, label, X
    PulseLine.tsx      — Декоративная линия + подпись "Изучаем новости для вас"
    Footer.tsx         — Футер
  hooks/
    useAuth.tsx        — Auth + portfolio (API-only, JWT token in localStorage)
    useSubscription.ts — Subscription state
  lib/
    mockData.ts        — Suggestions + getNewsForTag() + NewsArticle
    db.ts              — Client-side DB helpers (legacy, localStorage only for JWT)
    api.ts             — API client (all backend requests)
    copy.ts            — Все тексты UI (single source of truth)
    utils.ts           — Утилиты
  services/
    yookassa.ts        — ЮKassa demo API
  App.tsx              — Роутинг (HashRouter)
  main.tsx             — Entry point
```

### 1.3 Роуты
| Путь | Компонент |
|------|-----------|
| `/` | Home |
| `/feed` | NewsFeed |
| `/pricing` | Pricing |
| `/login` | Login |
| `/profile` | Profile |
| `/terms` | Terms |
| `/privacy` | Privacy |
| `/admin` | Admin |

---

## 2. ДИЗАЙН-СИСТЕМА

### 2.1 Цвета
```
--bg-primary:     #060606
--bg-surface:     #0E0E0E
--bg-hover:       #161616
--text-primary:   #FFFFFF
--text-secondary: #9CA3AF
--text-muted:     #6B7280
--accent-primary: #00D4FF
--text-success:   #34D399
--text-warning:   #F59E0B
--text-error:     #EF4444
--border-subtle:  #222222
--border-active:  #00D4FF
```

### 2.2 Типографика
- Hero: `clamp(48px, 8vw, 96px)`, weight 700, line-height 1.05
- Section: 20-24px, weight 600
- Card title: 15px, weight 600, line-clamp-2
- Body: 14-15px, weight 400
- Meta: 11-13px, weight 400-500
- Labels: 11-12px, weight 600, uppercase

### 2.3 Анимации
```javascript
const easeOutExpo = [0.16, 1, 0.3, 1];
// Card entrance: duration 0.4, delay: index * 0.1
// Tag: spring, stiffness 400, damping 25
```

---

## 3. КОМПОНЕНТЫ

### 3.1 Tag (`src/components/Tag.tsx`)

**Props:**
```typescript
interface TagProps {
  label: string;       // Отображаемый текст
  type: 'company' | 'sector' | 'person' | 'trend';
  onRemove: () => void; // Клик на крестик — удаление
  onClick?: () => void; // Клик на label — переход (опционально)
}
```

**Цвета типов:**
- company: #00D4FF
- sector: #A78BFA
- person: #FBBF24
- trend: #34D399

**Внешний вид:**
- h-9, rounded-pill, inline-flex, gap-2
- Фон: #161616, border: цвет типа с opacity 40%
- Цветная точка (w-2 h-2 rounded-full)
- Label: truncate max-w-[150px], cursor-pointer если onClick передан
- Крестик (X): w-5 h-5, hover → text-error + bg-hover

**Анимация (framer-motion):**
```javascript
layout: true
initial:  { scale: 0.8, opacity: 0, y: 10 }
animate:  { scale: 1, opacity: 1, y: 0 }
exit:     { scale: 0.8, opacity: 0, x: -20 }
transition: { type: 'spring', stiffness: 400, damping: 25 }
```

**Обёртка для glow:**
```html
<motion.div className="rounded-full tag-loading">  <!-- или tag-existing-glow -->
  <Tag />
</motion.div>
```
- Glow анимация (`box-shadow`) применяется к обёртке с `rounded-full`
- Никогда не квадратная — повторяет pill-форму тега

**Поведение:**
- Клик на label → `navigate('/feed')` (если onClick передан)
- Клик на X → удаление тега + синхронизация с БД

---

### 3.2a Login — Skip Verification

**Flow:**
1. Пользователь заполняет форму регистрации → нажимает "Создать аккаунт"
2. Показывается экран "Подтвердите email" с кодом верификации
3. **Кнопка "Пропустить верификацию →"** — вызывает `verifyEmail()` + `setView('success')`
4. Пользователь попадает в приложение без ожидания письма

**Правило:** Пропуск верификации — сознательный выбор пользователя. Email остаётся неподтверждённым (`isVerified: false`), функционал не ограничивается.

### 3.2 NewsCard (`src/components/NewsCard.tsx`)

**Props:**
```typescript
interface NewsArticle {
  id: string;
  title: string;
  source: string;
  timestamp: string;
  tags?: string[];
  sentiment?: 'positive' | 'negative' | 'neutral';
}

interface NewsCardProps {
  article: NewsArticle;
  index?: number;
  tagLabel?: string;
}
```

**Внешний вид (Liquid Glass + Sentiment):**
- Ширина: 280/300/340px, rounded-2xl
- **БЕЗ КАРТИНКИ**
- **Liquid glass:** `backdrop-filter: blur(16px) saturate(180%)`
- **Sentiment colors (subtle, barely visible):**

| Sentiment | Background | Border | Hover Border | Icon |
|-----------|-----------|--------|--------------|------|
| Positive | `rgba(52,211,153,0.03)` | `rgba(52,211,153,0.12)` | `rgba(52,211,153,0.25)` | TrendingUp |
| Negative | `rgba(239,68,68,0.03)` | `rgba(239,68,68,0.12)` | `rgba(239,68,68,0.25)` | TrendingDown |
| Neutral | `rgba(255,255,255,0.02)` | `rgba(255,255,255,0.08)` | `rgba(255,255,255,0.18)` | Minus |

- **Структура:** теги (top) + divider + title + meta
- **Sentiment indicator:** icon + label, top-right
- **Сортировка:** По времени (свежие слева), `sort((a, b) => a.minutes - b.minutes)`
- **Tag label badge:** top-left corner, голубой `#00D4FF`

**Анимация:**
```javascript
initial: { opacity: 0, x: 30 }
animate:  { opacity: 1, x: 0 }
transition: { duration: 0.4, delay: index * 0.1, ease: easeOutExpo }
```

### 3.3 Navbar (`src/components/Navbar.tsx`)

- Fixed top, z-50, h-16, backdrop-blur(20px)
- Logo → Nav links → Auth buttons
- **Все кнопки: pointer-events-auto**
- Logout: `logout()` + `window.location.href = '/#'`

### 3.4 Layout (`src/components/Layout.tsx`)
- Navbar → `<main pt-16>` → children → Footer

---

## 4. СТРАНИЦЫ

### 4.1 Home (`src/pages/Home.tsx`)

**Состояние:**
```typescript
searchValue: string
isFocused: boolean
selectedTags: Suggestion[]
showPaywall: boolean
showLogin: boolean
isSearching: boolean
searchComplete: boolean
lastAddedTagId: string | null
```

**Секции:**
**Hero — адаптивная высота:**
- Гость: `min-h-[100dvh]`, `pt-16` — immersive
- Залогинен: `min-h-[65dvh]`, `pt-4` — компактный

1. **Hero** — заголовок, поиск, selected tags, pulse line, subtitle
2. **News Timeline** — NewsTimeline компонент (если selectedTags.length > 0)
3. **Popular Tags** — 12 популярных тегов + "Добавить все"
4. **Subscribe Block** — Портфель инвестиционно.рф (VastData, Crusoe, SpaceX, Cashea) + "Добавить портфель"

**Selected Tags блок:**
- Расположение: под поиском, flex-wrap, justify-center
- Каждый тег: `<motion.div layout key={tag.id}>` + `<Tag onClick={navigate('/feed')} onRemove={handleRemoveTag} />`
- **Анимация удаления:** AnimatePresence popLayout — удалённый тег плавно исчезает, остальные занимают место
- **Glow:** `.tag-loading` класс при добавлении нового тега

**Загрузка тегов при входе:**
```
useEffect([isLoggedIn]):
  if !isLoggedIn → setSelectedTags([])        // Сброс при logout

useEffect([isLoggedIn, user]):
  if isLoggedIn && user:
    dbTags = getPortfolio(user.id)
    converted = dbTags.map(t => find in allSuggestions || custom)
    setSelectedTags(converted)                  // Всегда синхронизируем
```

**Добавление тега:**
```
handleSelectSuggestion(s):
  if !isLoggedIn → setShowLogin(true)
  if !canAddTag → setShowPaywall(true)
  setSelectedTags([...prev, s])                // UI
  addTagToPortfolio(user.id, { id, name: s.label, type, createdAt })  // БАЗА
  triggerSearch()                               // Авто-поиск
```

**Удаление тега:**
```
handleRemoveTag(id):
  setSelectedTags(filter)                       // UI
  removeTagFromPortfolio(user.id, id)           // БАЗА
```

### 4.2 NewsFeed (`src/pages/NewsFeed.tsx`)

**Ключевые особенности:**
- Обернут в `<Layout>` — Navbar виден
- Кнопка "← Назад" → `/`
- **Реальные теги:** читает `getPortfolio(user.id)` + ищет в `allSuggestions`
- **Реальные новости:** `getNewsForTag(tag.id)` для каждого тега
- **Фильтры времени:** Все / Час / Сутки / Неделя
- **Поиск:** фильтр по title и source
- **Группировка:** Последний час / Сегодня / Вчера / Ранее
- **Empty states:** "Войдите" / "Нет тегов" / "Новости не найдены"
- **Пагинация:** не реализована (frontend only)

### 4.3 Pricing (`src/pages/Pricing.tsx`)

- **Standalone:** X кнопка (top-right) + ← Назад (top-left) → `/`
- **Modal:** onClose callback
- Состояния: initial / processing / success / error
- Confetti анимация при success
- FAQ (5 вопросов)

### 4.4 Profile (`src/pages/Profile.tsx`)

- Кнопка "← Назад" → `/`
- Удаление тега: `removeTagFromPortfolio(user.id, id)` — синхронизировано
- Редактирование email/password
- История платежей

---

## 5. AUTH & DATA FLOW

### 5.0 User Key Field — Email (КРИТИЧЕСКОЕ ПРАВИЛО)

- **Email — ключевое поле в базе пользователей (PRIMARY KEY)**
- Email **НЕЛЬЗЯ менять** после регистрации
- Username (логин) — редактируемый, отображается в интерфейсе
- В профиле: email read-only с предупреждением "Для смены обратитесь в поддержку"
- При смене email требуется подтверждение поддержки (ручной процесс)
- **Все связи в БД** (portfolio, payments, sessions) — по `user.id`

### 5.0.1 User Stats

```typescript
interface DBUser {
  ...
  createdAt: string;     // дата регистрации → "С нами с <дата>"
  newsCount: number;     // сколько новостей изучено → "Изучено новостей: N"
}
```

- **`newsCount`** инкрементируется при каждой загрузке новостей по тегам пользователя
- Функция: `incrementNewsCount(userId)` — +1 к счётчику
- Отображается в профиле под "С нами с <дата>"

### 5.0.2 Renewal Discount (скользящая скидка на продление)

**Логика:** чем раньше продлеваешь — тем больше скидка.

| Осталось дней | Скидка | Название |
|---------------|--------|----------|
| 30+ | 25% | Ранняя пташка |
| 21–29 | 15% | Оптом дешевле |
| 14–20 | 10% | Последний шанс |
| 0–7 | 0% | Стандартная цена |

**Функции:**
```typescript
getDaysLeft(expiresAt: string): number       // дней до окончания
getRenewDiscount(daysLeft: number): number    // % скидки (0, 10, 15, 25)
```

**Отображение:**
- В профиле: "Осталось N дней" + badge Premium
- Кнопка "Продлить — `<цена>` ₽" с цветом скидки
- Модал инвойса: разбивка цены, скидка, итоговая сумма
- Цвета скидок: 25% зелёный, 15% голубой, 10% жёлтый, 0% серый

### 5.1 useAuth (`src/hooks/useAuth.tsx`)

**localStorage ключи:**
- `pulse_db_users` — массив DBUser
- `pulse_db_portfolios` — Record<userId, PortfolioTag[]>
- `pulse_db_payments` — массив платежей
- `pulse_auth_session` — текущая сессия

**Portfolio API:**
```typescript
getPortfolio(userId) → PortfolioTag[]
addTagToPortfolio(userId, tag) → boolean   // запись в localStorage
removeTagFromPortfolio(userId, tagId) → boolean  // удаление из localStorage
savePortfolio(userId, tags) → void         // полная перезапись
```

**Seed:** пользователь создаёт теги сам, Free тариф = 1 тег, Premium = 25 тегов

### 5.2 Tag Sync Flow (КРИТИЧЕСКИЙ)

```
Добавление:
  handleSelectSuggestion() → addTagToPortfolio() → localStorage ✓

Удаление:
  handleRemoveTag() → removeTagFromPortfolio() → localStorage ✓
  deleteTag() в Profile → removeTagFromPortfolio() → localStorage ✓

Logout:
  useEffect(isLoggedIn=false) → setSelectedTags([]) ✓

Login:
  useEffect(isLoggedIn=true, user) → getPortfolio() → setSelectedTags() ✓
```

**Правило:** selectedTags НИКОГДА не перезаписывается произвольно. Только:
- Пустой массив при logout
- Полная синхронизация из getPortfolio() при login
- Добавление/удаление по одному тегу

---

## 6. НОВОСТИ

### 6.1 Текущая реализация (frontend-only)

**Источник:** `getNewsForTag(tagId)` из `mockData.ts`
- Возвращает массив NewsArticle для тега
- Мок-данные (заглушка до backend)

**NewsArticle:**
```typescript
interface NewsArticle {
  id: string;
  title: string;
  source: string;
  timestamp: string;
  imageUrl?: string;
  tags?: string[];
}
```

### 6.2 Backend (план)

#### PostgreSQL Schema

**`users` таблица:**
```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) NOT NULL UNIQUE,  -- ключевое поле
  username        VARCHAR(30) NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  is_verified     BOOLEAN DEFAULT FALSE,
  subscription_active    BOOLEAN DEFAULT FALSE,
  subscription_expires_at TIMESTAMP,
  subscription_auto_renew BOOLEAN DEFAULT FALSE,
  news_count      INTEGER DEFAULT 0,
  created_at      TIMESTAMP DEFAULT NOW()
);
```

**`portfolios` таблица:**
```sql
CREATE TABLE portfolios (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  tag_id     VARCHAR(50) NOT NULL,
  tag_name   VARCHAR(100) NOT NULL,
  tag_type   VARCHAR(20) NOT NULL,  -- company, sector, person, trend
  created_at TIMESTAMP DEFAULT NOW()
);
```

**`payments` таблица (КРИТИЧНО):**
```sql
CREATE TABLE payments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  amount      DECIMAL(10,2) NOT NULL,      -- сумма в рублях (с учётом скидки)
  base_amount DECIMAL(10,2) NOT NULL,      -- базовая цена (490 ₽)
  discount    INTEGER DEFAULT 0,            -- % скидки (0, 10, 15, 25)
  method      VARCHAR(50) NOT NULL,         -- card, yookassa, etc.
  status      VARCHAR(20) DEFAULT 'pending', -- pending, completed, failed
  provider_ref VARCHAR(255),                -- ID платежа в ЮKassa
  paid_at     TIMESTAMP,
  created_at  TIMESTAMP DEFAULT NOW()
);
```
- **Каждый платёж сохраняется** — история, аналитика, чеки
- Скидка записывается в момент оплаты (не пересчитывается)
- Связь с `users` через `user_id`
- Индекс по `user_id` для быстрой выборки истории

**`news` таблица:**
```sql
CREATE TABLE news (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title_ru        TEXT NOT NULL,
  summary_ru      TEXT,
  title_original  TEXT,
  lang_original   VARCHAR(2),  -- 'ru' | 'en'
  source          VARCHAR(100),
  source_id       VARCHAR(50),
  url             TEXT,
  published_at    TIMESTAMP,
  fetched_at      TIMESTAMP,
  sentiment       VARCHAR(20),  -- positive | negative | neutral
  matched_tags    TEXT[],       -- ['sber', 'tech']
  created_at      TIMESTAMP DEFAULT NOW()
);
```

**`user_sessions` таблица:**
```sql
CREATE TABLE user_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  last_connected_at TIMESTAMP DEFAULT NOW()
);
```

- Хранение: 2 недели (news), остальное — навсегда
- RSS: 32 источника, опрос каждые 15-20 мин
- Перевод: EN → RU при парсинге (через мой API + fallback Google/DeepL)
- Matching: теги при парсинге, сохраняются в matched_tags
- Свежие новости: `published_at > last_connected_at`
- Пагинация: 50/страница

Полная спецификация backend — в разделе "Backend Architecture" (ниже).

---

## 7. КРИТИЧЕСКИЕ ПРАВИЛА

1. **Перевод:** Все EN новости → RU. Пользователь видит только русский.
2. **Хранение:** Backend 2 недели, не forever. Backend = БД, клиент = кэш.
3. **Tag label:** Отображаем `tag.label` (человекочитаемое), не ticker.
4. **Tag sync:** Запись в БД при каждом добавлении/удалении. Сброс при logout. Синхронизация при login.
5. **Только реальные новости:** Без мок-данных на backend.
6. **Pointer events:** Все кнопки pointer-events-auto, особенно во время загрузки.
7. **Спрашивать перед изменением настроек:** Не менять фильтры/лимиты без подтверждения.

---

## 8. Backend Architecture (план)

### 8.0 ЖЁСТКИЙ ЗАПРЕТ: мок-новости

**❌ МОКОВЫЕ НОВОСТИ КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ при работающем backend**

- `getNewsForTag()` из `mockData.ts` — удаляется целиком
- `NewsArticle` интерфейс переносится в types и берётся из API
- Все новости — только из RSS, через `fetchNewsForTag(tagId)` → API
- Если RSS-источник не отвечает — новости не показываются (пустой результат)
- Fallback на мок-данные — **ЗАПРЕЩЁН** под страхом потери доверия пользователя
- Это критическое правило для платного продукта — только реальные новости

### 8.1 RSS Aggregation
- Интервал: каждые 15-20 минут
- 32 источника, batch по 5, 50ms yield
- Перевод EN→RU при парсинге
- Sentiment detection (keyword-based)
- Tag matching → сохранение matched_tags

### 8.2 Хранение
- PostgreSQL, 2 недели retention
- Авто-удаление: >14 дней
- Недельный массив (Вс→Сб) для sentiment counters

### 8.3 API

```
GET  /api/news?user_id=&since=&page=&limit=50
POST /api/tags/search        — немедленный поиск нового тега
GET  /api/tags/sentiment     — counters по тегам
POST /api/translate          — перевод EN→RU через мой API
POST /api/auth/login
POST /api/auth/register
GET  /api/user/profile
PUT  /api/user/tags
POST /api/payment/yookassa
```

#### POST /api/translate — перевод через мой API (Kimi Translate)

**Flow:**
```
RSS парсер извлекает EN новость
  ↓
POST /api/translate
  Body: { texts: ["title", "summary"], from: "en", to: "ru" }
  ↓
Backend вызывает мой API (Kimi) для перевода
  ↓
Сохраняет в БД: title_ru, summary_ru, translation_cache
```

**Почему мой API:**
- Контекстно-зависимый перевод (финансовая терминология)
- До 50 строк за 1 запрос
- Кэш 30 дней — повторные тексты не переводятся
- Fallback: Google Translate API если недоступен

**Кэш переводов (Redis):**
```
Ключ: hash(title_en + summary_en)
TTL: 30 дней
Значение: { title_ru, summary_ru, translated_at }
```

### 8.4 Свежие новости (ключевая фича)
- Пользователь получает только `published_at > last_connected_at`
- При первом входе — последние 50
- `last_connected_at` обновляется при каждом запросе

## 9. Продуктовая концепция (Product Vision)

### Что делает PULSE

**Проблема пользователя:**
Инвестору нужно следить за своим портфелем (10–50 позиций). Новостей сотни, читать всё невозможно. Релевантные теряются в потоке.

**Решение PULSE:**
> Мы следим за тем, что есть в портфеле пользователя. Читаем ВСЕ новости. Отбираем только релевантные. Анализируем настроение. Отправляем итоговый репорт.

**Круг продукта (замкнутый):**
```
Пользователь задаёт теги (свой портфель)
  ↓
PULSE следит за этими компаниями 24/7 (32 источника)
  ↓
Отбираем ТОЛЬКО релевантные новости (по портфелю)
  ↓
Анализируем sentiment (позитив / нейтрально / негатив)
  ↓
Каждую неделю — репорт в Telegram + Email
  ↓
Пользователь читает 2 абзаца вместо 200 новостей
  ↓
Понедельник — новая неделя, новый цикл
```

### Ценность

| До PULSE | С PULSE |
|----------|---------|
| 200+ новостей в день | 10–20 релевантных |
| Читать всё самому | Итоговый репорт |
| Пропускаешь важное | Ничего не пропустишь |
| 2 часа на чтение | 5 минут на репорт |

### Репорты (только Premium)

**Бесплатный тариф:** лента на сайте (3 тега)
**Premium:** лента + еженедельный репорт в TG/Email (10 тегов)

**Формат репорта (еженедельный, воскресенье в обед ~13:00 МСК):**

Почему ВС обед: пользователь читает в спокойной обстановке перед новой неделей, готовится к открытию рынка в ПН.
```
📊 PULSE — Еженедельный репорт
📅 20–26 мая 2025

🔵 #Сбербанк (12 новостей)
• Рекордная прибыль за Q3 — акции +8%
• Запуск нового продукта для бизнеса
• Греф прокомментировал стратегию на 2025
Sentiment: 🟢 Позитив (9/12)

🟢 #Газпром (7 новостей)
• Увеличение поставок в Азию
Sentiment: 🟡 Нейтрально (5/7)

⚠️ #NVDA (4 новости)
• Прогноз снижения выручки на 15%
Sentiment: 🔴 Негатив (3/4)

💡 Итого: 23 новости → 5 минут чтения
🔗 Открыть ленту: https://pulse.app/#/feed
```

**Каналы доставки:**

| Канал | Приоритет | Почему |
|-------|-----------|--------|
| **Telegram бот** | #1 | РФ аудитория, 100% доставка, мгновенно |
| Email | #2 | Fallback, архив, может в спам |

**Таблица `user_channels`:**
```sql
CREATE TABLE user_channels (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  channel    VARCHAR(20) NOT NULL,  -- 'tg' | 'email'
  target     VARCHAR(255) NOT NULL, -- chat_id / email
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);
```

**Cron:**
```
Каждое воскресенье 13:00 МСК:
  Для каждого Premium user с активным channel:
    1. Получить user.tags
    2. Найти news за неделю (ВС прошлая 13:00 → ВС текущая 13:00)
    3. Сгруппировать по тегу
    4. Подсчитать sentiment
    5. Сформировать репорт
    6. Отправить TG + Email
```

### Настройки уведомлений (вкладка в профиле)

**Таблица `notification_settings`:**
```sql
CREATE TABLE notification_settings (
  user_id              UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- Каналы (вкл/выкл)
  tg_enabled           BOOLEAN DEFAULT TRUE,
  email_enabled        BOOLEAN DEFAULT TRUE,
  push_enabled         BOOLEAN DEFAULT FALSE,

  -- Частота репорта
  report_frequency     VARCHAR(20) DEFAULT 'weekly', -- 'hourly' | 'daily' | 'weekly'

  -- Тип репорта
  report_type          VARCHAR(20) DEFAULT 'all',    -- 'all' | 'important' | 'alerts_only'

  -- Sentiment-алерты (срабатывают мгновенно, не ждут репорта)
  alert_negative       BOOLEAN DEFAULT TRUE,  -- резкий negative по тегу
  alert_positive       BOOLEAN DEFAULT TRUE,  -- резкий positive по тегу
  alert_threshold      INTEGER DEFAULT 3,     -- мин. новостей для алерта

  -- Время доставки
  report_time          VARCHAR(5) DEFAULT '13:00', -- 'HH:MM' для weekly

  -- Тихие часы
  quiet_hours_start    VARCHAR(5) DEFAULT '22:00',
  quiet_hours_end      VARCHAR(5) DEFAULT '08:00',
  quiet_hours_enabled  BOOLEAN DEFAULT TRUE,

  -- Формат репорта
  report_format        VARCHAR(20) DEFAULT 'full',  -- 'short' (топ-3) | 'full' (все)

  -- Язык репорта
  report_language      VARCHAR(10) DEFAULT 'ru',    -- 'ru' | 'en' | 'both'

  updated_at           TIMESTAMP DEFAULT NOW()
);
```

**Все настройки (11 штук):**

| # | Настройка | Варианты | По умолчанию |
|---|-----------|----------|--------------|
| 1 | **Telegram бот** | вкл / выкл | вкл |
| 2 | **Email** | вкл / выкл | вкл |
| 3 | **Push (PWA)** | вкл / выкл | выкл |
| 4 | **Частота репорта** | hourly / daily / weekly | weekly |
| 5 | **Тип репорта** | все / только важные / только алерты | все |
| 6 | **Sentiment-алерты: Negative** | вкл / выкл | вкл |
| 7 | **Sentiment-алерты: Positive** | вкл / выкл | вкл |
| 8 | **Время доставки** | HH:MM | 13:00 (ВС) |
| 9 | **Тихие часы** | вкл / выкл + время | 22:00–08:00, вкл |
| 10 | **Формат репорта** | краткий (топ-3) / полный | полный |
| 11 | **Язык репорта** | русский / английский / оба | русский |

**Sentiment-алерты (мгновенные):**

Алерт отправляется сразу, не ждёт репорта, если:
- По тегу за последний час ≥ `alert_threshold` новостей
- И sentiment резко смещён (≥70% positive ИЛИ ≥70% negative)

Формат алерта:
```
🚨 PULSE — Алерт по #Сбербанк

За последний час: 4 новости
Sentiment: 🟢 Позитив (4/4)

📈 Возможный драйвер: акции могут вырасти
🔗 Открыть: https://pulse.app/#/feed
```

**Тихие часы:**
- Время: 22:00–08:00 по умолчанию
- В тихие часы: репорты не отправляются, алерты — с задержкой до 08:00

**Команды TG бота:**
- `/start` — подключение
- `/report` — получить репорт сейчас
- `/pause` — приостановить
- `/resume` — возобновить
- `/settings` — открыть настройки

### Платная фича

> Репорты — **только Premium**. Бесплатный пользователь видит ленту на сайте, но не получает репорты. Это ключевое отличие тарифов.

### 8.6 Технологии backend

| Компонент | Технология |
|-----------|-----------|
| API Server | Node.js + Express / Fastify |
| Database | PostgreSQL |
| Cache | Redis |
| RSS Fetcher | node-cron + node-fetch |
| Translation | Мой API (Kimi) + Google Translate fallback |
| Telegram | node-telegram-bot-api |
| Email | SendGrid / AWS SES |
| Deployment | Docker + VPS / Railway / Fly.io |

---

---

## Раздел 10: Backend Architecture

### 10.0 Dual-Mode Database

- **SQLite (default, zero-config)** — sql.js (pure JavaScript/WASM, no native compilation), файл на диске
- **PostgreSQL (production)** — через docker-compose (PostgreSQL 16 + Redis 7 + Backend)
- Переключение через `USE_SQLITE` в `.env`
- **8 таблиц:** `users`, `portfolios`, `payments`, `news`, `user_sessions`, `user_channels`, `notification_settings`, `translation_cache`

### 10.1 API Endpoints

| # | Роут | Эндпоинты | Описание |
|---|------|-----------|----------|
| 1 | **auth** | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` | Регистрация, вход, выход, текущий пользователь |
| 2 | **news** | `GET /api/news`, `GET /api/news/:id`, `GET /api/news/by-tag/:tag` | Лента новостей, детальная, по тегу |
| 3 | **payment** | `POST /api/payment/create`, `POST /api/payment/confirm`, `GET /api/payment/history` | Создание платежа, подтверждение, история |
| 4 | **user** | `GET /api/user/profile`, `PUT /api/user/profile`, `GET /api/user/portfolio`, `PUT /api/user/portfolio` | Профиль, портфель |
| 5 | **translate** | `POST /api/translate` | Перевод EN→RU (cache → Kimi API → Google Translate) |
| 6 | **webhook** | `POST /api/webhook/yookassa`, `POST /api/webhook/telegram` | Вебхуки ЮKassa и Telegram |
| 7 | **admin** | `GET /api/admin/stats`, `GET /api/admin/users`, `GET /api/admin/news` | Административная панель |

### 10.2 RSS Aggregator

- **32 источника:** 13 RU + 19 EN
- **Batch fetch:** 5 за раз, 15-минутный cron
- **EN→RU перевод:** 3-уровневая система
  1. Проверка `translation_cache` (SQLite/Redis)
  2. Kimi API (основной переводчик)
  3. Google Translate (fallback)
- **Tag matching:** 16 тегов, keyword-based matching
- **Sentiment detection:** keyword-based (positive / negative / neutral)
- **Хранение:** 14-дневное, авто-удаление старше 14 дней

### 10.3 Weekly Reports

- **Расписание:** Воскресенье 13:00 MSK
- **Содержание:** Группировка по тегам, sentiment-анализ, итоговая статистика
- **Каналы доставки:**
  - Telegram Bot (приоритет #1)
  - Email (SendGrid)
- **Настройки:** 11 параметров уведомлений (каналы, частота, тип, алерты, время, тихие часы, формат, язык)
- **Sentiment-алерты:** мгновенные при резком смещении (≥70% positive или ≥70% negative)

### 10.4 Authentication

- **JWT-токены**, срок жизни — 7 дней
- **Email = PRIMARY KEY** (read-only, нельзя изменить)
- **Username — редактируемый**, отображается в интерфейсе
- **Password:** bcrypt, 10 rounds
- Смена email — только через поддержку (ручной процесс)

### 10.5 Payments (YooKassa)

- **Стоимость:** 490 ₽/месяц
- **Демо-режим:** shopId 54401 (тестовые платежи)
- **Sliding renewal discount:**

| Осталось дней | Скидка | Название |
|---------------|--------|----------|
| 30+ | 25% | Ранняя пташка |
| 21–29 | 15% | Оптом дешевле |
| 14–20 | 10% | Последний шанс |
| 0–7 | 0% | Стандартная цена |

- Каждый платёж сохраняется в таблице `payments` (сумма, базовая цена, скидка %, метод, статус, provider_ref)

### 10.6 Docker

- **docker-compose.yml:** PostgreSQL 16 + Redis 7 + Backend
- **Dockerfile:** multi-stage Node 20 Alpine
- **Переменные окружения:** `USE_SQLITE`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `YOOKASSA_SHOP_ID`, `YOOKASSA_SECRET_KEY`, `SENDGRID_API_KEY`, `TELEGRAM_BOT_TOKEN`, `KIMI_API_KEY`
- SQLite-режим: zero-config, запуск без docker-compose (sql.js — pure JavaScript/WASM)

### 10.7 Admin Panel

- **Флаг `is_admin`** в таблице `users` (INTEGER DEFAULT 0)
- **Middleware `adminMiddleware`** — проверяет JWT + is_admin из БД (не из env)
- **Frontend защита** — redirect на `/` если `!user.isAdmin`
- **API endpoints:** `GET /api/admin/users`, `GET /api/admin/stats` — 403 для non-admin
- **Данные из SQLite** — никакого localStorage для админки
- **Отображение:** таблица пользователей, stats cards (users, premium, news, revenue)

### 10.8 Render Deploy (2026-05-25)

- **URL:** `https://pulse-api-bsov.onrender.com`
- **Dockerfile:** `npm install` + `npx tsc` (TypeScript — devDependency)
- **SQLite:** `USE_SQLITE=true` — файл на диске Render
- **Environment:** `JWT_SECRET`
- **CORS:** разрешены все origin
- **Root page:** PULSE API status page (HTML)
- **Free plan:** 15-min sleep, 30-sec warmup on first request

### Tag System (Теги) — 2026-05-26

#### Architecture
- **Frontend state:** `portfolio` в `useAuth` контексте (не локальный `useState`!)
- **API:** `GET /api/user/tags`, `POST /api/user/tags`, `DELETE /api/user/tags/:tagId`
- **DB:** таблица `portfolios` (user_id, tag_id, tag_name, tag_type)
- **Load on login:** `loadPortfolio()` вызывается после успешного входа

#### Flow
```
Добавление тега:
  User clicks suggestion → handleSelectSuggestion() → addTag({tagId, tagName, tagType})
  → POST /api/user/tags → DB INSERT → setPortfolio([...prev, newTag])

Удаление тега:
  User clicks X → handleRemoveTag(tagId) → removeTag(tagId)
  → DELETE /api/user/tags/:tagId → DB DELETE → setPortfolio(filtered)

Login:
  useAuth.login() → api.post('/auth/login') → loadPortfolio()
  → GET /api/user/tags → setPortfolio(tags)

Logout:
  useAuth.logout() → setPortfolio([])
```

#### Counter (1/3, 2/3...)
- Виден только авторизованным
- Цвет: голубой (`#00D4FF`) пока < limit, красный (`#EF4444`) при limit
- Позиция: справа от ряда тегов

#### Premium Prompt
- Появляется при попытке добавить 4-й тег на Free
- Backdrop blur + анимация
- CTA: "Оформить Premium" → /pricing

### 10.9 Auth Refactor (2026-05-25) — DONE ✅

- **localStorage = только JWT токен** — никаких пользователей, портфелей, платежей
- **useAuth = только API** — login/register/me через бэкенд (demo login удалён)
- **Пользователь создаёт первый тег сам** — нет forced suggestions
- **Единая база данных** — SQLite/PostgreSQL, единый источник правды

---

*Этот файл — единый источник правды. Перед любой доработкой читать целиком.*
