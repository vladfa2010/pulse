# AuthModal — Полная спецификация

> Этот документ — чертеж для 100% репликации логики. Можно передать новой команде/AI как ТЗ.
> Версия: 2026-10-02 (ТЗ-119 v3: стартовые теги, «К рынку», поле имени без иконки)

---

## 1. Общая концепция

AuthModal — единый модальный компонент для аутентификации. Объединяет **Вход** и **Регистрацию** в одном окне с таб-переключением. Регистрация — **3 шага** со степпером (ТЗ-119 от 2026-09-30, реализация 2026-10-02): 1) имя, 2) почта, 3) пароль + согласие; кнопка «Создать аккаунт» зажигается (`BorderGlow lit`) при пароле от 8 символов. После успешной регистрации показывает **Success-экран** с обращением по имени, стартовыми тегами (ТЗ-119 v3, задача 7 — только если бэк вернул `starterTags`, флаг `STARTER_TAGS_ENABLED`) и кнопкой «К рынку».

---

## 2. Визуальная структура

```
┌─────────────────────────────────┐
│  ┌─────┐                        │
│  │  X  │  ← кнопка закрытия    │
│  └─────┘                        │
│                                 │
│       ┌──────────┐              │
│       │  PULSE   │  ← логотип  │
│       │ (h-12)   │   48px      │
│       └──────────┘              │
│                                 │
│   ┌────────┬────────┐          │
│   │ Вход   │Регистр.│  ← табы  │
│   │(active)│        │  pill    │
│   └────────┴────────┘          │
│                                 │
│         Вход / Создать          │  ← заголовок (login: h3 «Вход»;
│                                 │     register: степпер «Шаг N из 3»)
│  Логин                          │
│  ┌──────────────────┐          │
│  │ 👤 investor_2025 │          │
│  └──────────────────┘          │
│                                 │
│  Email                          │
│  ┌──────────────────┐          │
│  │ ✉️ your@email.com│          │
│  └──────────────────┘          │
│                                 │
│  Пароль                         │
│  ┌──────────────────┐          │
│  │ 🔒 ••••••••  👁️ │          │
│  └──────────────────┘          │
│  ▓▓▓▓ (4 segments)            │  ← PasswordStrength (forgot only)
│                                 │
│  ☑ Запомнить меня             │  (только вход)
│                                 │
│  ☑ Условия + Политика         │  (только регистрация, шаг 3)
│                                 │
│  [Ошибка]                       │  ← красный текст
│                                 │
│  ┌──────────────────┐          │
│  │     Войти        │  ← CTA  │
│  └──────────────────┘          │
│                                 │
└─────────────────────────────────┘

РЕЖИМ REGISTER (ТЗ-119) — 3 шага со степпером (3 точки + линии):
┌─────────────────────────────────┐
│  ●━━━●━━━○   Шаг 1 из 3        │  ← степпер
│  Как к вам обращаться?          │
│  ┌──────────────────┐          │
│  │                  │          │  ← без плейсхолдера и БЕЗ иконки (v2)
│  └──────────────────┘          │
│  [Вперёд →]                     │
│  ─────────────────────────────  │
│  Шаг 2: «Ваша почта» + [← Назад][Вперёд →]
│  Шаг 3: «Придумайте пароль» + живой счётчик
│          «Ещё N символов — и кнопка зажгётся»,
│          согласие, [← Назад][✨ Создать аккаунт]
│          (кнопка в BorderGlow, lit при ≥8 символов)
└─────────────────────────────────┘
```

---

## 3. Состояния (State Machine)

```
                    ┌──────────────┐
         ┌─────────►│    closed    │◄────────────┐
         │          │  (не виден)  │             │
         │          └──────┬───────┘             │
         │                 │ open('login')       │ close()
         │                 │ open('register')    │
         │                 ▼                     │
         │          ┌──────────────┐             │
         │          │    form      │             │
         │          │  (таб-форма) │             │
         │          └──────┬───────┘             │
         │                 │                     │
         │    ┌────────────┼────────────┐        │
         │    │            │            │        │
         │    ▼            ▼            ▼        │
         │ success      switchTab    error       │
         │    │            │            │        │
         │    ▼            ▼            ▼        │
         │ ┌──────┐   ┌──────┐   (остаемся)    │
         │ │success│   │ form │   на форме      │
         │ │экран  │   │другой│                 │
         │ └──┬───┘   │таб   │                 │
         │    │        └──────┘                 │
         │    │ close()                         │
         └────┘─────────────────────────────────┘
```

### Полный список состояний

| State | Тип | Описание |
|-------|-----|----------|
| `isOpen` | boolean | Модал открыт/закрыт |
| `mode` | `'login' \| 'register'` | Активная вкладка |
| `step` | `'form' \| 'success'` | Форма или success-экран |
| `email` | string | Поле Email |
| `password` | string | Поле Пароль |
| `confirmPassword` | string | Поле Подтверждение пароля |
| `username` | string | Поле Логин |
| `agreed` | boolean | Галочка согласия |
| `rememberMe` | boolean | Запомнить меня |
| `error` | string | Текст ошибки |
| `loading` | boolean | Идёт запрос |
| `showPassword` | boolean | Показать пароль (глазок) |
| `showConfirm` | boolean | Показать подтверждение |
| `regStep` / `stepDir` / `stepHint` / `igniteCount` | number/string | ТЗ-119: шаги регистрации, направление анимации, подсказка, вспышка зажигания |
| `pwdSubmitError` / `pwdShakeTick` / `agreeError` / `agreeShakeTick` | boolean/number | ТЗ-119: ошибки сабмита шага 3 |
| `starterTags` | `Array<{ tag_name, tag_type }>` | ТЗ-119 v3: стартовые теги из ответа `register()` (пусто при выключенном флаге) |

---

## 4. Сценарии (User Stories)

### US-1: Открытие модала

**Триггеры:**
- Клик "Войти" в навбаре → `open('login')`
- Клик "Начать" в навбаре → `open('register')`
- Попытка добавить тег без авторизации → `open('login')` (через AuthModalContext)

**Поведение:**
1. `isOpen = true`
2. `mode = defaultMode` (login или register)
3. Анимация: `opacity 0→1` (backdrop), `scale 0.95→1` (modal)
4. Backdrop: `bg-black/70` + `backdrop-blur-sm`

### US-2: Переключение таба Вход ↔ Регистрация

**Триггер:** Клик на неактивный таб

**Поведение:**
1. `mode` меняется
2. **ВСЕ поля очищаются:**
   ```
   email = ''
   password = ''
   confirmPassword = ''
   username = ''
   agreed = false
   showPassword = false
   showConfirm = false
   ```
3. `error = ''`
4. `step = 'form'`

**Почему:** Пользователь не должен видеть остатки предыдущего режима.

### US-3: Показ/скрытие пароля

**Триггер:** Клик иконки глаза (Eye/EyeOff) справа от поля пароля

**Поведение:**
- `showPassword` toggles → `type` поля меняется `'password' ↔ 'text'`
- Иконка меняется: `EyeOff` (видно) ↔ `Eye` (скрыто)

**Два поля с глазками:**
- Основной пароль → `showPassword`
- Подтверждение → `showConfirm` (независимый toggle)

### US-4: Валидация пароля (PasswordStrength)

**Компонент:** `PasswordStrength.tsx`

**Отображается:** Только в режиме `register`, под полем пароля

**4 сегмента индикатора:**

| Сегменты | Цвет | Текст | Условия |
|----------|------|-------|---------|
| 1/4 | 🔴 `#EF4444` | Слабый | length ≥ 8 |
| 2/4 | 🟡 `#F59E0B` | Средний | + заглавная буква |
| 3/4 | 🟢 `#34D399` | Хороший | + цифра |
| 4/4 | 🔵 `#00D4FF` | Отличный | + спецсимвол |

**Алгоритм:**
```
score = 0
if password.length >= 8: score++
if /[A-Z]/.test(password): score++
if /[0-9]/.test(password): score++
if /[^A-Za-z0-9]/.test(password): score++
level = score (0..4)
```

**Анимация:** Цвет и ширина сегментов меняются с `transition: 300ms`

### US-5: Вход (Submit Login)

**Предусловия:**
- `mode === 'login'`
- Поля email и password заполнены

**Поток:**
1. `e.preventDefault()`
2. `error = ''`
3. `loading = true`
4. `POST /api/auth/login` → `{ email, password }`
5. **Успех:** `handleClose()` → модал закрывается, пользователь авторизован
6. **Ошибка:** `error = result.error` → отображается красным текстом под формой

### US-6: Регистрация в 3 шага (ТЗ-119)

**Шаги (`regStep: 1 | 2 | 3`):**
1. **«Как к вам обращаться?»** — поле `username` (без плейсхолдера). Сабмит: `trim().length >= 2`, иначе инлайн-hint «Напишите хотя бы пару букв — и вперёд» + фокус.
2. **«Ваша почта»** — поле `email`. Сабмит: regex `/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/`, иначе hint «Похоже, в адресе опечатка — проверьте». «← Назад» возвращает на шаг 1 с сохранением имени.
3. **«Придумайте пароль»** — поле `password` (глаз показать/скрыть), живой счётчик в подзаголовке: `0` → «Минимум 8 символов. Последний шаг — честно.»; `1..7` → «Ещё N симв. — и кнопка зажгётся»; `≥8` → «Пароль готов ✓» (cyan). Галочка согласия (кастомный чекбокс).

**Сабмит (только с шага 3, `handleSubmit`):**
- `username.trim().length < 2` → возврат на шаг 1 (guard)
- `password.length < 8` → красный счётчик + тряска подзаголовка + фокус в поле (не `error`)
- `!agreed` → красная рамка чекбокса + тряска + hint «Без согласия аккаунт не создать — отметьте галочку» (не `error`)
- Guard'ы сбрасываются при следующем вводе/переключении чекбокса

**Поток после валидации:**
1. `loading = true`
2. `POST /api/auth/register` → `{ username, email, password }`
3. **Успех:** `logAnalyticsEvent('sign_up')`, `step = 'success'` → Success-экран
4. **Ошибка:** `error = result.error` → красный текст над рядом кнопок шага 3

**Кнопка «Создать аккаунт» (зажигание, ТЗ-119):**
- Обёрнута в `BorderGlow` с `lit={password.length >= 8}` и `sweepSignal={igniteCount}`
- В момент первого достижения 8 символов `igniteCount++` → вспышка пробегом, далее постоянное свечение (вращающаяся рамка cyan/green/violet)
- Стерли ниже 8 → `lit=false`, флаг «уже зажигалась» сбрасывается → повторное достижение 8 повторяет вспышку
- Покой: текст `#6B7280`; зажжена: `#FFFFFF` (переход `color .35s`)

**Сброс:** `reset()`/`switchMode()` → `regStep=1`, hint'и и `igniteCount` в ноль.

### US-7: Success-экран (после регистрации)

**Триггер:** Успешный ответ от `/api/auth/register` (в `register()` сохраняется `result.starterTags`)

**Содержимое:**
- ✅ Иконка `CheckCircle` (64px, цвет `#00D4FF` — ТЗ-119)
- Заголовок: "Аккаунт создан!"
- Описание: "{Имя с заглавной}, добро пожаловать в PULSE.\nПисьмо с подтверждением уже летит на почту." (имя — из шага 1; пустое → «Добро пожаловать в PULSE. Письмо с подтверждением уже летит на почту.»)
- **Стартовые теги (ТЗ-119 v3, задача 7)** — только если `starterTags.length > 0` (бэк вернул фактически добавленные теги; при выключенном `STARTER_TAGS_ENABLED` блока нет):
  - Лейбл «Мы добавили два тега для старта — лента уже работает:» — 13px `#6B7280`, по центру, `mt-[18px]`
  - Чипы в ряд по центру, gap-2 — 1:1 как `DemoTagsRow`: пилюля `h-9 px-3.5 rounded-pill`, `bg #161616`, `border 1px {color}40`, точка `w-2 h-2 rounded-full` + имя `text-sm font-medium`. Цвет точки/бордера по `tag_type`: `company` → `#00D4FF`, `sector` → `#A78BFA` (остальное → `#00D4FF`)
  - Подпись «Поменяйте их на свои, чтобы получить персональные подборки» — 12px `#4B5563`
- Кнопка: **«К рынку»** (ТЗ-119 v3, раньше «Начать») — те же стили primary-градиента, `w-full`:
  - `returnUrl` есть → `handleAuthSuccess(returnUrl)` (как раньше)
  - `returnUrl` пуст → `reset()` + `onClose()` + `navigate('/feed', { replace: true })` (НЕ просто закрыть модал)

**Анимация:**
```
CheckCircle: scale 0→1, spring, delay 0.1s
Заголовок:   opacity 0→1, y 10→0, delay 0.2s
Описание:    opacity 0→1, y 10→0, delay 0.3s
Лейбл тегов: opacity+y, delay 0.45s
Чипы:        scale 0.6→1, spring, delay 0.5s + i*0.12s (поп-ин каскадом)
Подпись:     opacity+y, delay 0.5s + N*0.12s
Кнопка:      opacity+y, delay 0.9s
```

### US-8: Закрытие модала

**Триггеры:**
- Клик крестика (X)
- Клик вне модала (backdrop)
- Клик "К рынку" на Success-экране (ТЗ-119 v3, раньше «Начать»)
- Успешный login

**Поведение:**
1. `reset()` — **все поля очищаются**, `step = 'form'`, `mode = 'login'`
2. `onClose()` — `isOpen = false`
3. Анимация: `opacity 1→0` (200ms)

---

## 5. Динамические поля (ТЗ-119)

Регистрация больше не переключает поля через AnimatePresence — она рендерит **один шаг за раз** (свой `<form>` на шаг) внутри контейнера `min-h-[258px]` с slide-x переходом. В режиме login поля статичны.

| Поле | Видно при | Примечание |
|------|-----------|------------|
| **Логин** (шаг 1) | `register` | Без плейсхолдера, `autoComplete="nickname"`, **без иконки** — padding 16px с обеих сторон (ТЗ-119 v2) |
| **Email** (шаг 2) | `register`, login | — |
| **Пароль** (шаг 3) | `register`, login | Глаз показать/скрыть |
| **Согласие с условиями** (шаг 3) | `register` | Кастомный чекбокс 18×18, подсветка ошибкой |
| **Запомнить меня** | `login` | — (статично) |
| **PasswordStrength** | `forgot` (смена пароля) | Из register удалён (ТЗ-119) |
| **Забыли пароль?** | `login` | — (статично) |

**Удалено (ТЗ-119):** поле «Подтвердите пароль» и его state (`confirmPassword`, `showConfirm`), `PasswordStrength` в register, h3-заголовок «Создать аккаунт» (заменён степпером).

---

## 6. Ошибки

### Отображение
- Цвет: `#EF4444` (text-error)
- Позиция: Центрирован под формой, над кнопкой Submit
- Анимация: `opacity 0→1`, `height 0→auto` (AnimatePresence)

### Виды ошибок

| Текст | Когда |
|-------|-------|
| "Напишите хотя бы пару букв — и вперёд" | Шаг 1: `username.trim().length < 2` (инлайн под полем) |
| "Похоже, в адресе опечатка — проверьте" | Шаг 2: email не прошёл regex (инлайн под полем) |
| "Введите пароль — минимум 8 символов" / "Не хватает N символов" | Шаг 3: сабмит с `password.length < 8` (красный счётчик + тряска) |
| "Без согласия аккаунт не создать — отметьте галочку" | Шаг 3: сабмит с `!agreed` (под чекбоксом) |
| "Неправильный логин или пароль" | Backend вернул ошибку login |
| "Ошибка регистрации" | Backend вернул ошибку register (красный текст над кнопками шага 3) |
| "Сетевая ошибка" | Fetch throw (TypeError) |

**При переключении таба:** `error = ''` (очищается); степ регистрации сбрасывается на 1.

---

## 7. Анимации

### Backdrop
```css
background: rgba(0, 0, 0, 0.7);
backdrop-filter: blur(4px); /* tailwind: backdrop-blur-sm */
transition: opacity 200ms;
```

### Modal (enter/exit)
```
initial:  scale 0.95, opacity 0
animate:  scale 1, opacity 1
exit:     scale 0.95, opacity 0
spring:   stiffness 400, damping 35
```

### Смена шагов регистрации (ТЗ-119)
```
initial:  opacity 0, x: 48 * dir   (dir=+1 вперёд, −1 назад)
animate:  opacity 1, x: 0
exit:     opacity 0, x: −48 * dir
duration: 300ms, x ease [0.16, 1, 0.3, 1] (easeOutExpo)
mode: AnimatePresence "wait" — старый шаг уходит, новый входит
контейнер: min-h-[258px] (высота модалки не дёргается)
```

### Степпер (регистрация)
- Точка 30×30: покой `#1C1C1C`/`#2A2A2A`/`#6B7280`; текущая `#00D4FF` + тень `0 0 16px rgba(0,212,255,.35)`; пройдена — иконка Check cyan в полупрозрачном cyan-фоне
- Линия `flex-1 h-[2px]`, заполнение `width 0→100%`, `.35s cubic-bezier(.16,1,.3,1)`
- Подпись «Шаг N из 3», 12px `#6B7280`, letter-spacing .04em

### Тряска (ошибки сабмита шага 3)
```
x: [0, −3, 0, 3, 0], 300ms — счётчик пароля и чекбокс согласия
```

### BorderGlow lit (кнопка «Создать аккаунт»)
- `lit=true`: рамка видна всегда, edgeProximity фиксирован 0.9, угол вращается rAF (оборот 4 с, linear; hover/sweep перехватывают управление)
- Зажигание: `sweepSignal={igniteCount}` вспышка пробегом при первом достижении 8 символов

### Success screen
```
Container: opacity 0→1, scale 0.9→1, 400ms, easeOutExpo
CheckCircle: scale 0→1, spring, delay 100ms
Title:       opacity+y, delay 200ms
Description: opacity+y, delay 300ms
StarterTags: label opacity+y delay 450ms; chips scale 0.6→1 spring, 500ms + i*120ms; caption — после чипов (ТЗ-119 v3)
Button («К рынку»): opacity+y, delay 900ms
```

---

## 8. Визуальные константы

### Цвета
```
Modal bg:       #111111
Modal border:   #222222
Tab bg (inactive): transparent
Tab bg (active):   #222222
Tab text (inactive): #6B7280
Tab text (active):   #FFFFFF
Input bg:       #161616
Input border:   #222222
Input focus:    #00D4FF (opacity 50%)
Placeholder:    #6B7280
Accent (CTA):   linear-gradient(135deg, #00D4FF, #0099CC)
Error:          #EF4444
Success icon:   #00D4FF (ТЗ-119, раньше emerald #34D399)
```

### Размеры
```
Modal width:    400px max
Modal padding:  32px (p-8)
Logo height:    48px (h-12)
Input height:   44px (h-11)
Input radius:   8px  (rounded-lg)
CTA radius:     9999px (rounded-pill / rounded-full)
Font (input):   14px
Font (label):   14px
Font (error):   14px
Font (CTA):     14px, semibold
```

---

## 9. Зависимости

### Компоненты
- `PasswordStrength.tsx` — индикатор сложности пароля (4 сегмента)
- `AuthModalContext.tsx` — контекст управления состоянием

### Хуки
- `useAuth()` — `login(email, password)` и `register(username, email, password)`

### Иконки (Lucide)
```
X, Mail, Lock, Eye, EyeOff, CheckCircle, ArrowLeft, AlertTriangle, Check
```
(иконка `User` удалена в ТЗ-119 v2 — у поля имени на шаге 1 её нет)

### Библиотеки
- `framer-motion` — AnimatePresence, motion.div
- Tailwind CSS — utility classes

---

## 10. API Endpoints

### Login
```
POST /api/auth/login
Body: { email: string, password: string }
Response: { token: string, user: { id, username, email, ... } }
Error: { error: string }
```

### Register
```
POST /api/auth/register
Body: { username: string, email: string, password: string }
Response: { token: string, user: { id, username, email, ... },
            starterTags?: Array<{ tag_name: string, tag_type: string }> }
  — starterTags: фактически добавленные стартовые теги (ТЗ-119 v3, задача 11,
    флаг STARTER_TAGS_ENABLED на бэке: «Сбербанк» company + «Нефть» sector).
    Отсутствует/пуст, когда флаг выключен или теги не найдены в каталоге.
Error: { error: string }
```

### User mapping (frontend)
```
mapUser(u): { id, username, email, isVerified, isAdmin, subscription: { active, expiresAt, autoRenew } }
```

---

*Этот документ — единый источник правды для AuthModal. При любых изменениях обновлять этот файл.*
