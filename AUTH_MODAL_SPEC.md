# AuthModal — Полная спецификация

> Этот документ — чертеж для 100% репликации логики. Можно передать новой команде/AI как ТЗ.
> Версия: 2026-05-26

---

## 1. Общая концепция

AuthModal — единый модальный компонент для аутентификации. Объединяет **Вход** и **Регистрацию** в одном окне с таб-переключением. После успешной регистрации показывает **Success-экран**.

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
│         Вход / Создать          │  ← заголовок
│                                 │
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
│  ▓▓▓▓ (4 segments)            │  ← PasswordStrength
│                                 │
│  Подтвердите пароль             │  (только регистрация)
│  ┌──────────────────┐          │
│  │ 🔒 ••••••••  👁️ │          │
│  └──────────────────┘          │
│                                 │
│  ☑ Запомнить меня             │  (только вход)
│                                 │
│  ☑ Условия + Политика         │  (только регистрация)
│                                 │
│  [Ошибка]                       │  ← красный текст
│                                 │
│  ┌──────────────────┐          │
│  │     Войти        │  ← CTA  │
│  └──────────────────┘          │
│                                 │
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

### US-6: Регистрация (Submit Register)

**Предусловия:**
- `mode === 'register'`
- Все поля заполнены
- `agreed === true` (галочка согласия)

**Клиентская валидация (перед отправкой):**
1. `password === confirmPassword`? Нет → `error = 'Пароли не совпадают'`
2. `password.length >= 8`? Нет → `error = 'Пароль должен быть не менее 8 символов'`
3. `agreed === true`? Нет → `error = 'Необходимо согласиться с условиями'`

**Поток после валидации:**
1. `loading = true`
2. `POST /api/auth/register` → `{ username, email, password }`
3. **Успех:** `step = 'success'` → показ Success-экрана
4. **Ошибка:** `error = result.error` → отображается красным

### US-7: Success-экран (после регистрации)

**Триггер:** Успешный ответ от `/api/auth/register`

**Содержимое:**
- ✅ Иконка `CheckCircle` (64px, цвет `emerald-400`)
- Заголовок: "Аккаунт создан!"
- Описание: "Добро пожаловать в PULSE. Теперь вы можете добавлять теги и отслеживать новости."
- Кнопка: "Начать" → `handleClose()` (закрывает модал)

**Анимация:**
```
CheckCircle: scale 0→1, spring, delay 0.1s
Заголовок:   opacity 0→1, y 10→0, delay 0.2s
Описание:    opacity 0→1, y 10→0, delay 0.3s
Кнопка:      opacity 0→1, y 10→0, delay 0.4s
```

### US-8: Закрытие модала

**Триггеры:**
- Клик крестика (X)
- Клик вне модала (backdrop)
- Клик "Начать" на Success-экране
- Успешный login

**Поведение:**
1. `reset()` — **все поля очищаются**, `step = 'form'`, `mode = 'login'`
2. `onClose()` — `isOpen = false`
3. Анимация: `opacity 1→0` (200ms)

---

## 5. Динамические поля (AnimatePresence)

Поля, которые появляются/исчезают при переключении `login ↔ register`:

| Поле | Видно при | Анимация |
|------|-----------|----------|
| **Логин** | `register` | `height: 0→auto`, `opacity 0→1`, 250ms, ease `[0.16, 1, 0.3, 1]` |
| **Подтвердите пароль** | `register` | Та же анимация |
| **Запомнить меня** | `login` | — (статично) |
| **Согласие с условиями** | `register` | Та же анимация |
| **PasswordStrength** | `register` | — (условный рендер) |
| **Забыли пароль?** | `login` | — (статично) |

---

## 6. Ошибки

### Отображение
- Цвет: `#EF4444` (text-error)
- Позиция: Центрирован под формой, над кнопкой Submit
- Анимация: `opacity 0→1`, `height 0→auto` (AnimatePresence)

### Виды ошибок

| Текст | Когда |
|-------|-------|
| "Пароли не совпадают" | `password !== confirmPassword` при submit register |
| "Пароль должен быть не менее 8 символов" | `password.length < 8` при submit register |
| "Необходимо согласиться с условиями" | `!agreed` при submit register |
| "Неправильный логин или пароль" | Backend вернул ошибку login |
| "Ошибка регистрации" | Backend вернул ошибку register |
| "Сетевая ошибка" | Fetch throw (TypeError) |

**При переключении таба:** `error = ''` (очищается)

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

### Dynamic fields (username, confirm, agreement)
```
hidden:   opacity 0, height 0, marginTop 0
visible:  opacity 1, height auto, marginTop 16px
duration: 250ms
ease:     [0.16, 1, 0.3, 1] (easeOutExpo)
```

### Success screen
```
Container: opacity 0→1, scale 0.9→1, 400ms, easeOutExpo
CheckCircle: scale 0→1, spring, delay 100ms
Title:       opacity+y, delay 200ms
Description: opacity+y, delay 300ms
Button:      opacity+y, delay 400ms
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
Success icon:   #34D399
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
X, Mail, Lock, User, Eye, EyeOff, CheckCircle
```

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
Response: { token: string, user: { id, username, email, ... } }
Error: { error: string }
```

### User mapping (frontend)
```
mapUser(u): { id, username, email, isVerified, isAdmin, subscription: { active, expiresAt, autoRenew } }
```

---

*Этот документ — единый источник правды для AuthModal. При любых изменениях обновлять этот файл.*
