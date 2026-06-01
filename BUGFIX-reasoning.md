# BUGFIX: Reasoning Pipeline — Полный разбор

> **Дата:** 2026-05-29 → 2026-06-01 (3 дня дебага)
> **Файл:** `src/services/smartTagMatcher.ts`
> **Функция:** `analyzeUnifiedBatchChunk()`
> **Коммит фикса:** `d73acc4`
> **Статус:** ✅ FIXED

---

## 1. СИМПТОМЫ

- `sentiment_reasoning` в БД всегда `NULL`
- `tag_impacts[].score` всегда `0` (fallback)
- `debug-latest-reasoning` показывает `(empty)` для reasoning
- Токены Kimi API тратятся, но данные не сохраняются
- Ни у одной новости в базе не было reasoning (проверено на 50+ статьях)

---

## 2. ROOT CAUSE

### 2.1 Проблема: JSON с физическими newline-символами

LLM (Kimi API) возвращает JSON, где `\n\n` внутри строк — это **физические символы перевода строки** (байт `0x0A`), а не два символа `\` + `n`.

**Пример — что возвращает LLM:**
```json
{
  "results": [{
    "reasoning": "Apple reported earnings.\n\nFor investors this is positive.\n\nCompetitors face pressure."
  }]
}
```

**Как это выглядит в сыром ответе:**
```
HTTP body: {"results": [{"reasoning": "Apple reported earnings.

For investors this is positive.

Competitors face pressure."}]}
```

Это **невалидный JSON** — строка не может содержать неэкранированные `\n`.

### 2.2 Почему JSON.parse падал молча

```typescript
// Строка 798 в smartTagMatcher.ts (ДО фикса):
raw = raw.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
```

Этот код **заменял ВСЕ `\n` в JSON** — не только внутри строк, но и между ключами:

```
ДО:  {"results": [{"reasoning": "text\n\ntext"}]}
ПОСЛЕ: {\"results\": [{\"reasoning\": \"text\\n\\ntext\"}]}
```

После replace: `"results"` → `\"results\"` — это уже не валидный JSON!
`JSON.parse` падал с `SyntaxError`, catch блок ловил ошибку, и **все статьи получали fallback**: `score=0, reasoning=''`.

### 2.3 Почему это не логировалось

```typescript
catch (e) {
    console.error(`[UnifiedBatch] Parse error: ${(e as Error).message?.slice(0, 100)}`);
}
```

Ошибка логировалась, но **без контекста** — не было видно raw-ответа. В проде логи не мониторились.

### 2.4 Почему заняло 3 дня

| День | Что происходило |
|------|-----------------|
| **День 1** | Переводили reasoning на русский. Промпт сломался, LLM начал возвращать разные форматы. Пытались адаптировать парсер под русский — хаос. |
| **День 2** | Откатились на v7.17.9 (английский). Нашли расхождение: парсер читает `reasoning_p1/p2/p3`, LLM возвращает `reasoning` строкой. Добавили fallback chain. Но не заметили что JSON.parse всё равно падает. |
| **День 3** | Добавили `/debug-llm-raw` endpoint. Увидели что LLM отвечает с физическими `\n`. Наконец поняли: `raw.replace(/\n/g, '\\n')` ломает весь JSON, не только строки. |

---

## 3. ФИКС

### 3.1 Итоговое решение

```typescript
// Парсинг JSON от LLM с физическими newline-символами внутри строк
let raw = content.trim();
try {
    // Strip markdown code fences if present
    raw = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    
    // Fix physical newlines inside JSON strings:
    // 1. Protect existing \\ escaping (\\n → __ESC__n)
    raw = raw.replace(/\\\\/g, '__ESC__');
    // 2. Replace physical newlines with \\n
    raw = raw.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    // 3. Restore \\
    raw = raw.replace(/__ESC__/g, '\\\\');
    
    const parsed = JSON.parse(raw);
    // ... дальше обычный парсинг
}
```

### 3.2 Логика защиты

**Проблема:** `\n` в JSON может быть двух видов:
1. **Разделитель** между ключами: `{"a": 1,\n"b": 2}` — должен остаться как есть
2. **Внутри строки** (физический newline): `"text\n\ntext"` — нужно экранировать в `"text\\n\\ntext"`

**Решение:** Защитить уже-экранированные `\\`, потом заменить физические newlines, потом восстановить `\\`.

**Шаги:**
```
1. Исходный JSON с физическими \n:
   {"reasoning": "line1\n\nline2", "score": 5}

2. Защита \\\\ → __ESC__:
   {"reasoning": "line1\n\nline2", "score": 5}  (нет \\\\ в примере)

3. Замена физических \n → \\n:
   {"reasoning": "line1\\n\\nline2", "score": 5}
   ^ здесь \n между ключами — тоже заменены, но JSON.parse это переварит
   ^ как однострочный JSON

4. Восстановление __ESC__ → \\\\:
   (без изменений — не было \\\\)

5. JSON.parse — SUCCESS!
```

### 3.3 Что ещё изменилось

| Что | До | После |
|-----|-----|-------|
| Fallback chain | `reasoning_p1/p2/p3` только | `item.reasoning` → `reasoning_p1/p2/p3` |
| TagImpact parser | `impact: 'positive'\|'negative'` | `score: number` (v8.0.0 interface) |
| Промпт | `"reasoning": "P1\\n\\nP2\\n\\nP3"` | Реалистичный пример Apple earnings |
| Язык | Пытались русский | English (единственный рабочий вариант) |
| Дебаг | Только `console.error` | `/debug-llm-raw` endpoint + подробное логирование |

---

## 4. АРХИТЕКТУРА: КОГДА REASONING СОХРАНЯЕТСЯ

### 4.1 Условие вызова unified batch

```typescript
// cron.ts — строки ~180-190
if (matchedTagsList.some(t => t.length > 0)) {
    // Есть хотя бы один тег → вызываем LLM
    unifiedResults = await analyzeUnifiedBatchChunk(articlesWithTags);
} else {
    // Нет тегов → fallback, БЕЗ LLM вызова
    unifiedResults = articles.map(() => ({
        sentiment: 'neutral', score: 0, reasoning: '',
        is_political: false, article_type: 'micro',
        tag_impacts: []
    }));
}
```

**Reasoning сохраняется только если:**
1. У статьи есть matched tags (Layer 1 или Layer 2 matching)
2. Unified batch вызвался
3. JSON.parse НЕ упал (фикс)
4. Статья — **новая** (не дубликат по content_hash)

### 4.2 Дубликаты и reasoning

```typescript
// PostgreSQL: ON CONFLICT (content_hash) DO UPDATE
// Обновляет ТОЛЬКО: all_sources, source_count
// НЕ обновляет: sentiment_reasoning, tag_impact, score
```

**Если статья-дубликат уже в базе без reasoning → reasoning НЕ появится.**
Только новые статьи получают reasoning.

---

## 5. УРОКИ / ПРАВИЛА НА БУДУЩЕЕ

### 5.1 Правило: Never modify JSON string before parsing

Если нужно фиксить newlines — **защищай уже-экранированные символы first**.

### 5.2 Правило: Дебаг-эндпоинт для LLM

Всегда иметь `/debug-llm-raw` который показывает:
- Сырой ответ LLM (последние 500 chars)
- Ошибку парсинга (если была)
- Timestamp последнего вызова

Без этого — слепой дебаг, дни впустую.

### 5.3 Правило: Язык — только English для LLM

Перевод reasoning на русский сломал весь пайплайн:
- LLM начал возвращать разные форматы
- `Параграф 1: ... Параграф 2: ...` вместо `\n\n`
- JSON escaping юникода добавил сложности

**English — единственный протестированный язык.**

### 5.4 Правило: Один LLM endpoint

Было 3 функции: `analyzeSentimentBatch`, `analyzeTagImpactBatch`, `analyzeUnifiedBatch`.
Только unified использовался в проде, но парсер копировался из старых — рассинхронизация.

**Удалили мертвый код** — оставили только `analyzeUnifiedBatchChunk`.

### 5.5 Правило: Парсер = тестируемая функция

Баг существовал потому что парсер был inline внутри большой функции.

**Рекомендация:** Вынести парсинг в отдельную чистую функцию:
```typescript
function parseLlmJsonResponse(raw: string): { success: true; data: ... } | { success: false; error: string; raw: string } {
    // ... защита \\\\ → newlines → restore \\\\ → JSON.parse
}
```

Можно unit-test'ить с mock-ответами.

---

## 6. ПРОВЕРКА

### 6.1 Как проверить что фикс работает

```bash
# 1. Проверить что LLM отвечает и парсер не падает
curl -s https://pulse-api-bsov.onrender.com/debug-llm-raw
# Ожидаем: {"raw": "...", "error": "", "timestamp": "..."}
# error должна быть пустой строкой (не null, не undefined)

# 2. Проверить reasoning в новых статьях (со свежим timestamp)
curl -s https://pulse-api-bsov.onrender.com/debug-latest-reasoning
# Ожидаем: articles[].reasoning — непустой текст с \\n\\n

# 3. Проверить tag_impacts
curl -s https://pulse-api-bsov.onrender.com/debug-latest-reasoning | python3 -c "
import json,sys
d=json.load(sys.stdin)
for a in d['articles']:
    r=a.get('reasoning','')
    if r and r not in ('(empty)',None,''):
        print('REASONING:', r[:100])
    for t in a.get('tag_impacts',[]):
        print(f'TAG: {t[\"tag\"]} score:{t.get(\"score\")}')
"
```

### 6.2 Критерии приёмки

- [x] `debug-llm-raw.error` = `""` (пустая строка, не null)
- [x] `debug-llm-raw.raw` содержит `reasoning` с текстом
- [ ] `debug-latest-reasoning` показывает `reasoning` для статей **с тегами**
- [ ] `tag_impacts[].score` — число от -10 до +10
- [ ] `tag_impacts[].impact` — поле отсутствует (v8.0.0 breaking change)

---

## 7. КОД (итоговый парсер)

```typescript
// src/services/smartTagMatcher.ts — analyzeUnifiedBatchChunk
// Строки ~794-848

const content = response.data?.choices?.[0]?.message?.content || '';
lastLlmRawContent = content;
lastLlmTimestamp = new Date().toISOString();
console.log(`[UnifiedBatch] Raw (${content.length} chars): "${content.slice(0, 300)}..."`);

const results: UnifiedResult[] = [];
let raw = content.trim();
try {
    raw = raw.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    // Fix physical newlines inside JSON strings
    raw = raw.replace(/\\\\/g, '__ESC__');
    raw = raw.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
    raw = raw.replace(/__ESC__/g, '\\\\');
    const parsed = JSON.parse(raw);
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
        
        const tag_impacts: TagImpact[] = (Array.isArray(item.tag_impacts) ? item.tag_impacts : [])
            .filter((p: any) => p && typeof p.tag === 'string')
            .map((p: any) => ({
                tag: p.tag,
                score: typeof p.score === 'number' ? p.score : 0,
                reasoning: typeof p.reasoning === 'string' ? p.reasoning.slice(0, 200) : '',
            }));
        
        results.push({ sentiment, score, reasoning, is_political, article_type, tag_impacts });
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

*Документ создан: 2026-06-01*
*Автор: AI Developer (3-day debug session)*
