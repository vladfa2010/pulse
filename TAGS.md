# PULSE — Методология тегов

> Дата: 2026-05-28
> Файлы: `smartTagMatcher.ts`, `tagManager.ts`
> Статус: ✅ Реализовано и работает

---

## 1. Общая архитектура (3 метода поиска)

```
Новость (title + summary)
  │
  ├──> Метод 1: Поиск по словам (быстрый, локальный)
  │     ├── 18 стандартных тегов (hardcoded)
  │     └── Пользовательские теги (из БД)
  │
  ├──> Метод 2: Умный поиск через AI (Kimi API, медленный)
  │     └── Только если метод 1 ничего не нашёл
  │
  └──> Метод 3: Связанные теги (быстрый, локальный)
        └── Нашли "nvda" → добавляем "tech" + "ai"
```

---

## 2. Стандартные теги (TAG_KEYWORDS)

### 2.1 Компании

| Тег | Ключевые слова | Пример срабатывания |
|-----|---------------|-------------------|
| **sber** | сбербанк, сбер, sberbank, сбербанка, сбережбанк, сбера, сберу | "Сбербанк повысил ставки" |
| **gazprom** | газпром, gazprom, газпрому, газпрома, газпромовск | "Газпром отчитался о прибыли" |
| **yandex** | яндекс, yandex, яндекса, яндексу | "Яндекс запустил новую функцию" |
| **nvda** | nvidia, nvda, енвидиа, видеокарт, geforce, rtx, gpu, графическ | "NVIDIA анонсировала RTX 5090" |
| **tesla** | tesla, тесла, musk, маск, elon, элон, модель 3, model 3, cybertruck, электромобил | "Tesla открыла завод в Берлине" |
| **apple** | apple, эпл, iphone, ipad, macbook, mac, ios, app store, тим кук | "Apple представила iPhone 16" |
| **samsung** | samsung, самсунг, galaxy | "Samsung Galaxy S25 — обзор" |
| **microsoft** | microsoft, майкрософт, azure, windows | "Microsoft инвестирует в AI" |
| **google** | google, гугл, alphabet, android | "Google закрыл проект" |
| **amazon** | amazon, амазон, aws, bezoz, безос | "AWS запустил новый сервис" |
| **meta** | meta, facebook, instagram, whatsapp, цукерберг, zuckerberg | "Meta отчиталась о выручке" |

### 2.2 Секторы

| Тег | Ключевые слова | Пример |
|-----|---------------|--------|
| **tech** | технолог, technology, tech, it-компан, айти, цифров, digital, software, hardware, startup, стартап, silicon valley | "Технологический сектор растёт" |
| **oil** | нефт, нефть, oil, газ, газов, opec, опек, баррел, barrel, добыч, трубопровод | "Цены на нефть выросли" |
| **gold** | золот, gold, золото, драгметал, серебр, silver, precious metal | "Золото обновило максимум" |
| **bank** | банк, bank, банковск, кредит, депозит, ипотек, ставк, цб, центробанк, central bank | "ЦБ снизил ключевую ставку" |
| **realestate** | недвижимост, real estate, жиль, ипотек, квартиру, застройщик, строительств | "Рынок недвижимости падает" |

### 2.3 Тренды

| Тег | Ключевые слова | Пример |
|-----|---------------|--------|
| **crypto** | криптовалют, bitcoin, биткоин, ethereum, эфириум, блокчейн, blockchain, altcoin, binance, coinbase, майнинг, defi, nft, web3 | "Биткоин превысил $100K" |
| **ai** | искусственный интеллект, ии, нейросет, chatgpt, gpt, llm, machine learning, openai, anthropic, claude, midjourney, stable diffusion, искин, большой языковой модел, generative ai | "ChatGPT-5 обошёл конкурентов" |
| **fed** | фрс, федеральный резерв, fed, federal reserve, powell, паунел, процентн, ставка, ставки, inflation, инфляц, доллар, usd, treasury, казначейств | "ФРС сохранила ставку" |
| **greentech** | зелен, green, эколог, eco, возобновляем, renewable, solar, wind, carbon, углерод, climate, климат | "Зелёные технологии на подъёме" |
| **space** | космос, space, космическ, спутник, rocket, ракет, mars, марс, orbital, наса, nasa, роскосмос | "SpaceX запустила ракету" |

### 2.4 Связанные теги (RELATED_TAGS)

```
| Тег    | Связанные          | Логика                          |
|--------|-------------------|--------------------------------|
| nvda   | tech, ai, gaming  | GPU для AI и игр               |
| tesla  | tech, ai, elon    | Электромобили + AI автопилот   |
| apple  | tech, ai          | Технологии + Apple Intelligence|
| google | tech, ai           | Поиск + AI (Gemini)            |
| sber   | bank, tech, ai     | Банк с технологиями + GigaChat |
| crypto | tech, fed, bank    | Зависит от ставок ФРС          |
| ai     | tech, nvda, google | Ядро — tech, hardware — nvda   |
| fed    | bank, gold, crypto | Ставки влияют на все           |
```

---

## 3. Алгоритм матчинга (3 метода)

### Метод 1: Поиск по словам (Keyword Search)
```typescript
function matchTagsByKeywords(text: string): string[]
```
- **Вход:** title + summary (конкатенация в нижний регистр)
- **Логика:** ищем каждое ключевое слово тега в тексте
- **Покрытие:** ~60-70% новостей
- **Скорость:** мгновенно (локально, без интернета)
- **Порядок:** сначала стандартные теги, потом пользовательские

**Пример:**
```
Новость: "Apple представила AI-функции в iPhone"
Проверяем: "apple"? → ДА → тег "apple"
           "iphone"? → ДА → тег "apple" (уже есть)
           "ai"? → ДА → тег "ai"
Результат: ["apple", "ai"]
```

### Метод 2: Умный поиск через AI (Smart AI Search)
```typescript
function smartMatchTags(title, summary, { useLLM? }): string[]
```
- **Условие:** метод 1 ничего не нашёл И useLLM !== false И KIMI_API_KEY установлен
- **API:** Kimi (api.moonshot.ai)
- **Как работает:** отправляем текст + список тегов в нейросеть → она решает
- **Кэш:** `smart_tag_cache` таблица, TTL 7 дней
- **Скорость:** 1-5 секунд
- **Покрытие:** оставшиеся 30-40%
- **Стоимость:** платим за API (токены)

**Пример:**
```
Новость: "SoftBank инвестирует в чипы для машинного обучения"
Метод 1: "softbank" нет в keywords → []
Метод 2: отправляем в Kimi → ответ: ["nvda", "ai", "tech"]
```

### Метод 3: Связанные теги (Related Tags)
```typescript
function getRelatedTags(tagId: string): string[]
```
- **Условие:** всегда после методов 1 или 2
- **Логика:** если нашли "nvda" → добавляем "tech", "ai", "gaming"
- **Скорость:** мгновенно (локальная таблица)

---

## 4. Пользовательские теги

### 4.1 Создание
```
Пользователь вводит "Лукойл"
  → generateTagKeywords("Лукойл")
    → ["лукойл", "lukoil", "лукойла", "лукойлу", "лукойле", "лукойлом", "лукойлов", ...]
  → INSERT INTO user_defined_tags
  → INSERT INTO portfolios
  → BACKFILL: scanAllNewsForTag(keywords)
```

### 4.2 Генерация keywords
```typescript
function generateTagKeywords(tagName: string): string[]
```
1. Само название (lowercase)
2. Транслитерация (кириллица → латиница)
3. Обратная транслитерация (латиница → кириллица)
4. Склонения: а, у, е, ом, ов, ам, ах

### 4.3 Хранение
- **Таблица:** `user_defined_tags` (tag_id, tag_name, tag_type, keywords[], created_by)
- **Портфель:** `portfolios` (user_id, tag_id, tag_name, tag_type)
- **Кэш:** in-memory, TTL 1 минута

---

## 5. Sentiment Analysis

### 5.1 Keyword-based (fallback, fast)
```
Positive: рост, прибыль, рекорд, превысил, успех, повышение, рали
Negative: падение, убыток, кризис, снижение, крах, санкции
```

### 5.2 LLM-based (Kimi API)
```typescript
function analyzeSentimentLLM(title, summary): 'positive' | 'negative' | 'neutral'
```
- Температура: 0.1 (v1-8k) или 1 (k2.5)
- Max tokens: 10
- Timeout: 10-30 сек

### 5.3 Tag Impact
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
| **Weekly Report** | Группировка по тегам |

---

## 7. Базы данных

### 7.1 Таблицы
```sql
-- Стандартные теги: hardcoded в TAG_KEYWORDS (не в БД)

-- Пользовательские теги
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

-- Кэш LLM результатов
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

## 8. Статистика (актуальная)

| Метрика | Значение |
|---------|----------|
| Стандартных тегов | 18 |
| Ключевых слов (всего) | ~200 |
| Связанных тегов | 9 наборов |
| Новостей с тегами | ~1,565 из 2,871 (54%) |
| Топ-тег | ai (1,026 новостей) |
| Пользовательских тегов | ∞ (через профиль) |

---

## 9. Диагностика

```sql
-- Распределение тегов
SELECT unnest(matched_tags) as tag, COUNT(*) 
FROM news GROUP BY tag ORDER BY count DESC;

-- Новости без тегов
SELECT COUNT(*) FROM news WHERE matched_tags IS NULL OR array_length(matched_tags, 1) = 0;

-- Пользовательские теги
SELECT * FROM user_defined_tags;

-- Кэш LLM
SELECT COUNT(*) FROM smart_tag_cache;

-- Теги конкретного пользователя
SELECT * FROM portfolios WHERE user_id = '...';
```

---

## 10. Правила модификации

1. **Добавить стандартный тег:** добавить в `TAG_KEYWORDS` + `RELATED_TAGS` → commit → deploy
2. **Изменить keywords:** отредактировать массив в `TAG_KEYWORDS` → commit → deploy
3. **Добавить связанные теги:** добавить в `RELATED_TAGS` → commit → deploy
4. **Пользовательский тег:** через UI (профиль → поиск → создать) — backfill автоматический

---

## 11. TODO / Улучшения

| # | Проблема | Приоритет |
|---|----------|-----------|
| 1 | `ai` слишком широкий (1,026 новостей) — разбить на под-теги | medium |
| 2 | Нет пересечения тегов (AND logic) — только OR | medium |
| 3 | Нет весов у keywords — "apple" = "app store" по весу | low |
| 4 | Нет negative keywords — исключений | low |
| 5 | Склонения только русские — нужны английские (s, es, ing) | low |
