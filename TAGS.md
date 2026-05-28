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
  │     └── Все теги из БД → LLM решает релевантность
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

## 3. Алгоритм матчинга (3 метода)

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

### Метод 2: Умный поиск через AI (Smart AI Search)

```typescript
function smartMatchTags(title, summary, { useLLM? }): string[]
```

- **Условие:** метод 1 ничего не нашёл И useLLM !== false И KIMI_API_KEY установлен
- **API:** Kimi (api.moonshot.ai)
- **Список тегов:** `getAllTagNames()` — все tag_id из `user_defined_tags`
- **Как работает:** отправляем текст + список всех тегов в нейросеть → она решает какие подходят
- **Кэш:** `smart_tag_cache` таблица, TTL 7 дней
- **Скорость:** 1-5 секунд
- **Покрытие:** оставшиеся 30-40%

**Пример:**
```
Новость: "SoftBank инвестирует в чипы для машинного обучения"
Теги в БД: nvda, ai, tech, arm, softbank
Метод 1: ни один keyword не найден → []
Метод 2: отправляем в Kimi → ответ: ["nvda", "ai", "tech"]
```

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

## 4. Sentiment Analysis

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

## 5. Где используются теги

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

## 6. Базы данных

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

## 7. Эндпоинты

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

## 8. Диагностика

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

-- Теги конкретного пользователя
SELECT * FROM portfolios WHERE user_id = '...';

-- Сколько тегов в системе
SELECT COUNT(*) FROM user_defined_tags;
```

---

## 9. Правила модификации

1. **Добавить тег:** пользователь создаёт через UI → автоматический backfill по всей базе
2. **Изменить keywords:** нет ручного редактирования — keywords генерируются автоматически
3. **Related tags:** автоматические через LLM — не требуют ручного обновления
4. **Нет деплоя для тегов:** всё через UI или БД

---

## 10. Технические детали

### Производительность

| Операция | Скорость | Зависимость |
|----------|----------|-------------|
| Keyword match | < 1 мс | Количество тегов в БД |
| LLM tag match | 1-5 сек | Сеть + API |
| LLM related tags | 1-3 сек | Сеть + API (кэш 5 мин) |
| Sentiment LLM | 1-3 сек | Сеть + API |
| Tag impact | 2-5 сек | Сеть + API |

### Кэширование

```
User tags (keywords):     60 секунд (in-memory)
LLM matching results:     7 дней (БД: smart_tag_cache)
LLM related tags:         5 минут (in-memory Map)
```

### Fallback-цепочка

```
Новость пришла
  → Метод 1 (keywords): нашли? → return
  → Метод 2 (LLM tags): нашли? → return
  → Метод 3 (LLM related): дополняем найденные
  → Ничего не нашли → matched_tags = NULL
```

---

## 11. TODO / Улучшения

| # | Проблема | Приоритет |
|---|----------|-----------|
| 1 | Нет пересечения тегов (AND logic) — только OR | medium |
| 2 | Нет весов у keywords — "apple" = "app store" по весу | low |
| 3 | Нет negative keywords — исключений | low |
| 4 | Склонения только русские — нужны английские (s, es, ing) | low |
| 5 | LLM related tags: персистентный кэш в БД вместо in-memory | low |
