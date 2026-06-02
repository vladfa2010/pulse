# BUGFIX: Reasoning Pipeline — Полный разбор

> **Дата:** 2026-05-29 → 2026-06-01 (3 дня дебага)
> **Файл:** `src/services/smartTagMatcher.ts`
> **Функция:** `analyzeUnifiedBatchChunk()`
> **Коммит фикса:** `6ee28d9` (two-pass JSON parsing)
> **Статус:** ✅ FIXED — reasoning сохраняется в БД

---

## 1. СИМПТОМЫ

- `sentiment_reasoning` в БД всегда `NULL`
- `tag_impacts[].score` всегда `0` (fallback)
- `debug-latest-reasoning` показывает `(empty)` для reasoning
- Токены Kimi API тратятся, но данные не сохраняются
- Ни у одной новости в базе не было reasoning (проверено на 50+ статьях)
- Пользователь впервые увидел карточку с reasoning + tag_impacts + score **только после фикса**

---

## 2. ROOT CAUSE

### 2.1 Проблема: JSON с физическими newline-символами

LLM (Kimi API) возвращает JSON, где `\n\n` внутри строк — это **физические символы перевода строки** (байт `0x0A`), а не два символа `\` + `n`.

**Что возвращает LLM (сырой HTTP body):**
```
{"results": [{"reasoning": "Apple reported earnings.

For investors this is positive.

Competitors face pressure.", "score": 5}]}
```

Это **невалидный JSON** — строка не может содержать неэкранированные `\n`.

### 2.2 Код который всё ломал

```typescript
// Строка ~798 в smartTagMatcher.ts (ДО фикса):
raw = raw.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
```

Этот код **заменял ВСЕ `\n` в JSON** — не только внутри строк, но и между ключами:

```
ДО:    {"results": [{
    "reasoning": "text

text"
}]}
ПОСЛЕ: {\"results\": [{\\n    \"reasoning\": \"text\\n\\ntext\"\\n}]}
        ^^^^^^^^^^^^^ ломает ВСЕ ключи → SyntaxError
```

`JSON.parse` падал → catch блок → fallback: `score=0, reasoning=''`.

### 2.3 Почему ошибка была silent

```typescript
catch (e) {
    console.error(`[UnifiedBatch] Parse error: ${(e as Error).message?.slice(0, 100)}`);
}
```

Ошибка логировалась **без raw-ответа**. В проде логи не смотрели. Не было `/debug-llm-raw` endpoint.

---

## 3. ЭВОЛЮЦИЯ ФИКСА (3 попытки)

### Попытка 1: Удалить replace полностью ❌

```typescript
// Просто JSON.parse(raw)
```

**Результат:** Работает для `\n` между ключами, падает для `\n` внутри строк.
LLM возвращает **и то, и другое** в зависимости от ответа.

### Попытка 2: Single-pass с защитой `\\` ❌

```typescript
raw = raw.replace(/\\/g, '__ESC__');
raw = raw.replace(/\n/g, '\\n');
raw = raw.replace(/__ESC__/g, '\\');
```

**Результат:** Всегда делает replace — ломает `\n` между ключами!
Видели `Parse error` на 6890 chars raw в 12:32.

### Попытка 3: Two-Pass ✅✅✅

```typescript
// Pass 1: parse as-is (\n между ключами — ВАЛИДНЫЙ JSON)
try {
  parsed = JSON.parse(raw);
} catch (e1) {
  // Pass 2: fix physical newlines inside strings
  let fixed = raw.replace(/\\/g, '__ESC__');
  fixed = fixed.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
  fixed = fixed.replace(/__ESC__/g, '\\');
  parsed = JSON.parse(fixed);
}
```

**Результат:** Работает для ОБЕИХ форм. В 12:47 reasoning появился в БД.

---

## 4. ЛОГИКА Two-Pass

**Ключевой инсайт:** `\n` в ответе LLM может быть в двух местах:

| Место | Пример | JSON.parse | Нужен replace? |
|-------|--------|------------|----------------|
| **Между ключами** | `{
  "score": 5
}` | ✅ Да | ❌ Нет |
| **Внутри строки** | `"reasoning": "line1

line2"` | ❌ Нет | ✅ Да |

**Two-Pass решает оба случая:**
```
Ответ от LLM
    │
    ▼
┌─────────────────┐
│ Pass 1:         │
│ JSON.parse(raw) │
│ (as-is)         │
└────────┬────────┘
    │
    ├─► ✅ Успех — форма A (\n между ключами)
    │
    └─► ❌ SyntaxError
        │
        ▼
    ┌──────────────────────────┐
    │ Pass 2:                  │
    │ replace(/\n/g, '\\n') │
    │ JSON.parse(fixed)        │
    └────────┬─────────────────┘
             │
             └─► ✅ Успех — форма B (\n внутри строк)
```

**Защита `\\` (backslash):**
Внутри строки может быть уже-экранированный `\\n` (два символа: `\` + `n`).
Без защиты `replace(/\n/g, '\\n')` превратит `\\n` в `\\\\n`.
Решение: `\\\\ → __ESC__ → \\\\`.

---

## 5. РЕЗУЛЬТАТ

### 5.1 Подтверждение работы (2026-06-01 12:47)

```json
{
  "title": "США перехватили иранские ракеты, нацелившиеся на американские силы в Кувейте",
  "score": 0,
  "sentiment": "neutral",
  "article_type": "macro",
  "reasoning": "The article reports on the interception of Iranian missiles targeting US forces in Kuwait by the Central Command.\n\nThis event is a significant geopolitical development that could escalate tensions between the US and Iran...\n\nThe incident could also affect investor sentiment toward...",
  "tag_impacts": [
    {"tag": "defense", "score": 3, "reasoning": "Potential for increased military spending due to heightened tensions."},
    {"tag": "oil", "score": -3, "reasoning": "Volatility due to potential supply disruptions in the Middle East."}
  ]
}
```

**Проверено:**
- ✅ `debug-llm-raw.error = ""` (пустая строка)
- ✅ `reasoning` — 3 paragraphs через `\n\n`, English
- ✅ `tag_impacts[].score` — число (`-3`, `+3`), не undefined
- ✅ `tag_impacts[].impact` — поле ОТСУТСТВУЕТ (v8.0.0)
- ✅ `tag_impacts[].reasoning` — текст
- ✅ `article_type: macro/micro`

### 5.2 Условия сохранения reasoning

Reasoning сохраняется **только если**:
1. У статьи есть matched tags (Layer 1/2 keyword matching)
2. Unified batch вызвался (требуется ≥1 тег)
3. JSON.parse **не упал** (two-pass фикс)
4. Статья — **новая** (ON CONFLICT не обновляет reasoning)

Статьи без тегов получают fallback: `score=0, reasoning='', tag_impacts=[]`.

---

## 6. УРОКИ / ПРАВИЛА

### 6.1 Never unconditionally modify before JSON.parse

Если делаешь `replace(/\n/g, '\\n')` — делай это **только после** неудачного `JSON.parse()`.

### 6.2 Two-Pass для нестандартного JSON

| Ситуация | Подход |
|----------|--------|
| Валидный JSON | `JSON.parse(raw)` |
| `\n` между ключами | `JSON.parse(raw)` — работает напрямую |
| `\n` внутри строк | Pass 2: `replace` + `JSON.parse` |
| Не знаешь какой формат | **Always two-pass** |

### 6.3 Дебаг-эндпоинт для LLM

Всегда иметь `/debug-llm-raw`:
```json
{
  "raw": "...сырой ответ LLM...",
  "error": "...ошибка парсинга или пустая строка...",
  "timestamp": "2026-06-01T12:47:00Z"
}
```

Без этого — слепой дебаг. Мы 2.5 дня не видели что LLM реально отвечает.

### 6.4 Язык — English

Перевод reasoning на русский сломал весь пайплайн:
- LLM вернул `Параграф 1: ... Параграф 2: ...` вместо `\n\n`
- JSON escaping юникода добавил сложности
- **English — единственный протестированный язык**

### 6.5 Один LLM endpoint

Было 3 функции: `analyzeSentimentBatch`, `analyzeTagImpactBatch`, `analyzeUnifiedBatch`.
Только unified использовался в проде, но парсер копировался из старых.
**Решение:** оставить только `analyzeUnifiedBatchChunk`.

---

## 7. ПРОВЕРКА

```bash
# 1. LLM отвечает и парсер не падает
curl -s https://pulse-api-bsov.onrender.com/debug-llm-raw
# → {"raw": "...", "error": "", "timestamp": "..."}
# error ДОЛЖНА быть пустой строкой

# 2. Reasoning в новых статьях
curl -s https://pulse-api-bsov.onrender.com/debug-latest-reasoning
# → articles[].reasoning — непустой текст с \n\n

# 3. Tag impacts с числовыми scores
curl -s https://pulse-api-bsov.onrender.com/debug-latest-reasoning | python3 -c "
import json,sys
d=json.load(sys.stdin)
for a in d['articles']:
    r=a.get('reasoning','')
    if r and r not in ('(empty)',None,''):
        print('REASONING:', r[:100])
    for t in a.get('tag_impacts',[]):
        print(f'TAG: {t["tag"]} score:{t.get("score")} r:{t.get("reasoning","")[:60]}')
"
```

---

## 8. ИТОГОВЫЙ КОД

```typescript
// src/services/smartTagMatcher.ts — analyzeUnifiedBatchChunk (~строка 794)

const content = response.data?.choices?.[0]?.message?.content || '';
lastLlmRawContent = content;
lastLlmTimestamp = new Date().toISOString();
console.log(`[UnifiedBatch] Raw (${content.length} chars): "${content.slice(0, 300)}..."`);

const results: UnifiedResult[] = [];
let raw = content.trim();
try {
  // Strip markdown code fences if present
  raw = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '');

  // ═══════════════════════════════════════════
  // TWO-PASS JSON PARSING — ключевой фикс
  // ═══════════════════════════════════════════
  let parsed: any;

  // Pass 1: try as-is (handles \n between keys — VALID JSON)
  try {
    parsed = JSON.parse(raw);
  } catch (e1) {
    // Pass 2: fix physical newlines INSIDE strings (INVALID JSON → fixed)
    let fixed = raw.replace(/\\\\/g, '__ESC__');      // 1. protect \\
    fixed = fixed.replace(/\n/g, '\\n')                 // 2. fix \n
            .replace(/\r/g, '\\r')                     //    fix \r
            .replace(/\t/g, '\\t');                    //    fix \t
    fixed = fixed.replace(/__ESC__/g, '\\\\');      // 3. restore \\
    parsed = JSON.parse(fixed);
  }
  // ═══════════════════════════════════════════

  const items = parsed.results || parsed;
  const arr = Array.isArray(items) ? items : [];
  console.log(`[UnifiedBatch] Parsed ${arr.length} results`);

  for (const item of arr) {
    const score = typeof item.score === 'number'
      ? Math.max(-10, Math.min(10, Math.round(item.score)))
      : 0;

    // Fallback chain: reasoning string → reasoning_p1/p2/p3
    let reasoning: string;
    if (typeof item.reasoning === 'string' && item.reasoning.length > 0) {
      reasoning = item.reasoning.slice(0, 500);
    } else {
      const p1 = item.reasoning_p1 || '';
      const p2 = item.reasoning_p2 || '';
      const p3 = item.reasoning_p3 || '';
      reasoning = [p1, p2, p3].filter(Boolean).join('\n\n').slice(0, 500);
    }

    const is_political = item.is_political === true;
    const article_type = item.article_type === 'macro' ? 'macro' : 'micro';
    let sentiment: 'positive' | 'negative' | 'neutral';
    if (score <= -1) sentiment = 'negative';
    else if (score >= 1) sentiment = 'positive';
    else sentiment = 'neutral';

    const tag_impacts: TagImpact[] = (Array.isArray(item.tag_impacts)
        ? item.tag_impacts : [])
      .filter((p: any) => p && typeof p.tag === 'string')
      .map((p: any) => ({
        tag: p.tag,
        score: typeof p.score === 'number' ? p.score : 0,
        reasoning: typeof p.reasoning === 'string'
          ? p.reasoning.slice(0, 200) : '',
      }));

    results.push({ sentiment, score, reasoning, is_political,
                   article_type, tag_impacts });
  }
} catch (e) {
  const errMsg = `[UnifiedBatch] Parse error: ${(e as Error).message?.slice(0, 200)} | raw_length=${content.length} | raw_preview="${content.slice(0, 300)}"`;
  lastLlmParseError = errMsg;
  console.error(errMsg);
}

// Fallback for missing results
while (results.length < batch.length) {
  const idx = results.length;
  results.push({
    sentiment: 'neutral', score: 0, reasoning: '',
    is_political: false, article_type: 'micro',
    tag_impacts: batch[idx].tags.map(t => ({ tag: t, score: 0, reasoning: '' }))
  });
}
return results.slice(0, batch.length);
```

---

## 9. СВЯЗАННЫЕ ИЗМЕНЕНИЯ

| Коммит | Что | Зачем |
|--------|-----|-------|
| `3a2ce6c` | Fallback chain `item.reasoning → reasoning_p1/p2/p3` | LLM возвращает `reasoning` строкой, не `p1/p2/p3` |
| `3a2ce6c` | `impact → score` в парсере + промпте | TagImpact v8.0.0 interface |
| `3a2ce6c` | Placeholder `P1\n\nP2` → Apple earnings пример | Реалистичный пример в промпте |
| `1d03e6e` | `/debug-llm-raw` endpoint | Диагностика сырых LLM ответов |
| `d73acc4` | Two-pass JSON parsing | **Ключевой фикс** — handle `\n` внутри строк |
| `618655f` | English language for LLM | Русский сломал формат |
| `e37ad48` | Chunk loop в основном cron | Был один вызов на 65 статей → timeout |
| `4b14acf` | JWT_SECRET unified `'dev-secret'` | Admin endpoints возвращали 401 |
| `ab75518` | BATCH_SIZE 10→5 | Timeout на 10 статьях за 30 сек |

---

*Документ создан: 2026-06-01*
*Последнее обновление: 2026-06-02 (batch size 10→5, chunk loop, JWT_SECRET fix)*
*Автор: AI Developer (3-day debug session)*
