# PULSE — Методология тегов

> Дата: 2026-05-29
> Файлы: `smartTagMatcher.ts`, `tagManager.ts`
> Статус: ✅ Только пользовательские теги + LLM

---

## Архитектурные решения

| # | Решение | Статус |
|---|---------|--------|
| 1 | **Нет хардкод тегов** — только пользовательские | ✅ Удалены TAG_KEYWORDS + RELATED_TAGS |
| 2 | **Related tags через LLM** — динамические связи | ✅ Реализовано |
| 3 | **Free = 1 тег** — бизнес-правило | ✅ |
| 4 | **Пользователь создаёт первый тег сам** — нет forced suggestions | ✅ |

---

## 1. Общая архитектура (3 метода поиска)

```
Новость (title + summary)
  │
  ├──> Метод 1: Поиск по словам (быстрый, локальный)
  │     └── Только пользовательские теги (из БД: user_defined_tags)
  │
  ├──> Метод 2: Умный поиск через AI (Kimi API, медленный)
  │     └── ВСЕГДА после метода 1 → union keyword + LLM результаты
  │
  └──> Метод 3: Связанные теги через LLM (динамические)
        └── "nvda" → LLM предлагает "tech", "ai" (нет хардкода)
```

**Ключевое изменение:** нет стандартных хардкод тегов. Все теги создаются пользователями и хранятся в `user_defined_tags`. Система работает только с теми тегами, которые есть в базе.

---

## 2. Пользовательские теги (единственный источник)

### 2.1 Создание

```
Пользователь вводит "Лукойл"
  → generateTagKeywords("Лукойл")
    → ["лукойл", "lukoil", "лукойла", "лукойлу", "лукойле", "лукойлом", "лукойлов", ...]
  → INSERT INTO user_defined_tags
  → INSERT INTO portfolios
  → BACKFILL: scanAllNewsForTag(keywords) — по всей базе новостей
```

### 2.2 Генерация keywords

```typescript
function generateTagKeywords(tagName: string): string[]
```

1. Само название (lowercase)
2. Транслитерация (кириллица → латиница)
3. Обратная транслитерация (латиница → кириллица)
4. Склонения: а, у, е, ом, ов, ам, ах

### 2.3 Хранение

- **Таблица:** `user_defined_tags` (tag_id, tag_name, tag_type, keywords[], created_by)
- **Портфель:** `portfolios` (user_id, tag_id, tag_name, tag_type)
- **Кэш:** in-memory, TTL 1 минута

### 2.4 Почему нет хардкод тегов

| Было (хардкод) | Стало (пользовательские) |
|----------------|--------------------------|
| 18 фиксированных тегов | ∞ тегов — каждый создаёт свои |
| ~200 keywords в коде | Keywords генерируются автоматически |
| 17 связей в RELATED_TAGS | LLM определяет связи динамически |
| Деплой для добавления тега | UI — создал, сразу работает |
| Не все теги нужны всем | Только те, что интересны пользователю |

---

## 3. Типы тегов (Auto-Detection)

### 3.1 Доступные типы

| Тип | Описание | Примеры |
|-----|----------|---------|
| `company` | Компания / эмитент | Apple, Tesla, Сбербанк, Яндекс |
| `ticker` | Биржевой тикер | AAPL, TSLA, SBER, NVDA |
| `sector` | Сектор экономики | Технологии, Фарма, Энергетика, Финансы |
| `trend` | Тренд / тема | AI, Крипто, ESG, Космос, Метавселенная |
| `person` | Ключевая персона | Илон Маск, Пауэлл, Цукерберг |
| `commodity` | Сырьё / товар | Золото, Нефть, Медь, Пшеница |
| `index` | Фондовый индекс | S&P 500, NASDAQ, MOEX, Dow Jones |
| `currency` | Валюта (фиат или крипто) | USD, EUR, BTC, ETH, Юань |

### 3.2 Автоопределение через LLM

```typescript
async function detectTagTypeViaLLM(tagName: string): Promise<TagType>
```

При создании тега с `tagType: 'auto'` (по умолчанию):
1. Отправляем название тега в Kimi API
2. LLM анализирует и возвращает один из 8 типов
3. Fallback: `heuristicTagType()` если LLM недоступен

**Примеры определения:**
```
"Apple"     → company
"AAPL"      → ticker
"Илон Маск"  → person
"AI"        → trend
"Gold"      → commodity
"USD"       → currency
"S&P 500"   → index
"Технологии" → sector
```

### 3.3 Heuristic Fallback (без LLM)

```typescript
function heuristicTagType(tagName: string): TagType
```

Быстрая локальная проверка (регулярные выражения):
- 1-5 латинских букв → `ticker`
- Имя фамилии (Маск, Пауэлл) → `person`
- Валютные коды (USD, BTC) → `currency`
- Названия индексов → `index`
- Сырьё (Gold, Oil) → `commodity`
- Остальное → `company`

### 3.4 Endpoint

```
GET /api/user/tags/detect-type?tagName=Apple
→ { "tag_name": "Apple", "tag_type": "company", "tag_type_label": "Компания" }
```

---

## 4. Алгоритм матчинга (3 метода)

### Метод 1: Поиск по словам (Keyword Search)

```typescript
function matchTagsByKeywords(text: string): string[]
```

- **Вход:** title + summary (конкатенация в нижний регистр)
- **Источник тегов:** `user_defined_tags` из БД (кэш 60 сек)
- **Логика:** ищем каждое keyword тега в тексте
- **Покрытие:** ~60-70% новостей (зависит от количества тегов в системе)
- **Скорость:** мгновенно (локально, без интернета)

**Пример:**
```
Новость: "Apple представила AI-функции в iPhone"
Теги в БД: apple ["apple", "эпл", "iphone", "ipad"], ai ["ai", "искусственный интеллект", ...]
Проверяем: "apple" keywords → ДА → тег "apple"
           "ai" keywords → ДА → тег "ai"
Результат: ["apple", "ai"]
```

### Метод 2: Умный поиск через AI (Smart AI Search) — ВСЕГДА запускается

```typescript
function smartMatchTags(title, summary, { useLLM? }): string[]
```

- **Условие:** ВСЕГДА запускается после метода 1 (если useLLM !== false И KIMI_API_KEY установлен)
- **API:** Kimi (api.moonshot.ai)
- **Список тегов:** `getAllTagNames()` — все tag_id из `user_defined_tags`
- **Как работает:** отправляем текст + список всех тегов в нейросеть → она решает какие **дополнительные** теги подходят
- **Кэш:** `smart_tag_cache` таблица, TTL 7 дней
- **Скорость:** +1-5 секунд к методу 1
- **Покрытие:** находит теги, которые keyword matching пропустил

**Union:** Результат = Метод 1 ∪ Метод 2 (без дубликатов)

**Пример — Метод 1 нашёл, Метод 2 дополнил:**
```
Новость: "NVIDIA builds AI-powered data centers for cloud computing"
Теги в БД: nvidia, ai, tech, cloud, arm

Метод 1 (keywords): нашёл "nvidia"         → ["nvidia"]
Метод 2 (LLM):      нашёл "ai", "tech"     → ["ai", "tech"]
Итог (union):       ["nvidia", "ai", "tech"]
```

**Пример — Метод 1 не нашёл, Метод 2 спас:**
```
Новость: "SoftBank инвестирует в чипы для машинного обучения"
Теги в БД: nvda, ai, tech, arm, softbank

Метод 1 (keywords): ни один keyword не найден → []
Метод 2 (LLM):      нашёл "nvda", "ai", "tech" → ["nvda", "ai", "tech"]
Итог (union):       ["nvda", "ai", "tech"]
```

**Зачем всегда запускать М2:** Keyword matching ищет точные совпадения, но может
пропустить семантически связанные теги. Например, новость про "data centers"
может быть релевантна тегу "cloud", даже если слово "cloud" не встречается
в тексте напрямую.

### Метод 3: Связанные теги через LLM (Related Tags)

```typescript
function getRelatedTags(tagId: string, allTagIds?: string[]): Promise<string[]>
```

- **Источник:** LLM (Kimi API) — динамические связи, нет хардкода
- **Кэш:** in-memory Map, TTL 5 минут
- **Логика:** отправляем tagId + список других тегов → LLM возвращает связанные
- **Пример:**
  ```
  Запрос: getRelatedTags("nvda", ["nvda", "tech", "ai", "gaming", "apple"])
  LLM ответ: ["tech", "ai"]  // GPU → технологии и AI
  ```

**Преимущества LLM over хардкод:**
- Не нужно обновлять код для новых связей
- Связи адаптируются под текущий набор тегов в системе
- Может находить неочевидные связи (например, " uranium" → " nuclear" → " energy")
- Новый тег автоматически участвует в связях

---

## 5. Sentiment Analysis

### 4.1 Keyword-based (fallback, fast)
```
Positive: рост, прибыль, рекорд, превысил, успех, повышение, рали
Negative: падение, убыток, кризис, снижение, крах, санкции
```

### 4.2 LLM-based (Kimi API)
```typescript
function analyzeSentimentLLM(title, summary): 'positive' | 'negative' | 'neutral'
```
- Температура: 0.1 (v1-8k) или 1 (k2.5)
- Max tokens: 10
- Timeout: 10-30 сек

### 4.3 Tag Impact
```typescript
function analyzeTagImpact(title, summary, tags): TagImpact[]
```
- Определяет: как новость влияет на КАЖДЫЙ тег
- Возвращает: `{ tag, impact, reasoning }[]`
- Max tokens: 500

---

## 6. Где используются теги

| Компонент | Использование |
|-----------|--------------|
| **RSS Pipeline** | Матчинг при сохранении новости → `matched_tags` |
| **Карусель 1** | `matched_tags && user_tags` (непрочитанные) |
| **Карусель 2** | `matched_tags && user_tags` (прочитанные) |
| **Карусель 3** | `matched_tags IS NOT NULL` (все с тегами) |
| **Sentiment** | Цвет карточки (green/red/gray) |
| **Tag Impact** | Pills на карточке (позитив/негатив для тега) |
| **Telegram Digest** | Только по тегам пользователя |
| **Related Tags** | LLM-подсказки при создании тега |

---

## 7. Базы данных

### 6.1 Таблицы

```sql
-- Пользовательские теги (единственный источник)
CREATE TABLE user_defined_tags (
  tag_id VARCHAR(50) PRIMARY KEY,
  tag_name VARCHAR(100) NOT NULL,
  tag_type VARCHAR(20) DEFAULT 'custom',
  keywords TEXT[],
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Портфель пользователя
CREATE TABLE portfolios (
  user_id UUID REFERENCES users(id),
  tag_id VARCHAR(50),
  tag_name VARCHAR(100),
  tag_type VARCHAR(20),
  PRIMARY KEY (user_id, tag_id)
);

-- Кэш LLM результатов (tag matching)
CREATE TABLE smart_tag_cache (
  text_hash VARCHAR(64) PRIMARY KEY,
  tags TEXT[],
  created_at TIMESTAMP DEFAULT NOW()
);

-- Новости с matched_tags
CREATE TABLE news (
  ...
  matched_tags TEXT[],
  tag_impact JSONB,
  sentiment VARCHAR(20),
  sentiment_source VARCHAR(20), -- 'keyword' | 'llm'
  ...
);
```

---

## 8. Эндпоинты

### GET /api/user/tags/detect-type?tagName={name}

Автоопределение типа тега (preview перед созданием).

```json
// Запрос: /api/user/tags/detect-type?tagName=AAPL
{
  "tag_name": "AAPL",
  "tag_type": "ticker",
  "tag_type_label": "Тикер"
}
```

### GET /api/user/tags/related?tag={tagId}

Возвращает связанные теги через LLM.

```json
// Запрос: /api/user/tags/related?tag=nvda
// Теги в БД: nvda, tech, ai, gaming, apple, sber
{
  "tag": "nvda",
  "related": [
    { "tag_id": "tech", "tag_name": "tech", "tag_type": "sector" },
    { "tag_id": "ai", "tag_name": "ai", "tag_type": "trend" }
  ]
}
```

---

## 9. Диагностика

```sql
-- Распределение тегов по новостям
SELECT unnest(matched_tags) as tag, COUNT(*) 
FROM news GROUP BY tag ORDER BY count DESC;

-- Новости без тегов
SELECT COUNT(*) FROM news WHERE matched_tags IS NULL OR array_length(matched_tags, 1) = 0;

-- Все пользовательские теги
SELECT * FROM user_defined_tags;

-- Кэш LLM matching
SELECT COUNT(*) FROM smart_tag_cache;

-- Теги конкретного 