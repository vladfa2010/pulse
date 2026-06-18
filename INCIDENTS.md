# PULSE — Инциденты (Incident Runbooks)

> **Назначение:** Описание production-инцидентов с root cause, timeline, фиксом и профилактикой.
> **Формат:** Один инцидент = один раздел. Читается как чеклист при повторении симптомов.

---

## INC-001: CRON FREEZE — PostgreSQL Pool Exhaustion

| Поле | Значение |
|------|----------|
| **ID** | INC-001 |
| **Дата** | 2026-06-05 13:05 UTC |
| **Статус** | ✅ RESOLVED |
| **Серьёзность** | P0 — критический (новые статьи не появлялись на сайте) |
| **Коммит фикса** | `ba9ae87` (batch enrichment v3), `409fd92` (zombie cleanup) |

---

### Симптомы

```bash
# /debug-cron показывал 5+ циклов с finished_at: null
{"started_at":"13:05","finished_at":null,"articles_saved":0,"status":"running"}
{"started_at":"13:20","finished_at":null,"articles_saved":0,"status":"running"}
{"started_at":"13:30","finished_at":null,"articles_saved":0,"status":"running"}
{"started_at":"13:45","finished_at":null,"articles_saved":0,"status":"running"}
{"started_at":"13:55","finished_at":null,"articles_saved":0,"status":"running"}
# Последний успешный цикл: 12:55 (50+ минут назад)
```

- Новые статьи не появлялись на сайте
- `/debug-cron` — все циклы "running" но ничего не сохраняется
- `/health` — статус "ok", cron помечен как "healthy" (ложноположительный)

---

### Timeline

| Время | Событие |
|-------|---------|
| 12:55 | ✅ Последний успешный цикл: 65 fetched, 60 saved, 1 merged |
| 13:05 | ❌ Цикл запустился, 75 fetched, 0 saved — **FREEZE** |
| 13:20 | ❌ Следующий цикл тоже замерз (cron lock всё ещё удерживает мёртвый процесс) |
| 13:30 | ❌ Третий frozen цикл |
| 13:45 | ❌ Четвёртый frozen цикл |
| 13:55 | ❌ Пятый frozen цикл |
| 14:20 | 🔍 Обнаружен баг через `/debug-cron` |
| 14:25 | 🔧 Hotfix: закомментирован `populateNewsTagLinks()` в `cron.ts` (коммит `41fd79d`) |
| 14:30 | 🔧 Hard restart на Render для очистки zombie cron lock |
| 14:35 | ✅ Cron восстановился: 86 fetched, 84 saved |
| 14:45 | ✅ Второй успешный цикл подряд: 49 fetched, 49 saved |
| 15:05 | ✅ Правильный фикс: `populateNewsTagLinksBatch()` (коммит `ba9ae87`) |
| 15:15 | ✅ Zombie cleanup добавлен (коммит `409fd92`) |

---

### Root Cause Analysis

#### Неправильный код (приводящий к deadlock)

```typescript
for (const a of processed) {
  // ... INSERT INTO news ...
  
  // ❌ AWAIT внутри цикла! Каждая статья = новое соединение
  await populateNewsTagLinks(newsId, a.matched_tags, a.tag_impact);
  // populateNewsTagLinks() → pool.connect() → BEGIN → INSERT → COMMIT → release()
}
```

#### Цепочка разрушения

```
60 новых статей × pool.connect() = 60 concurrent connection requests
PostgreSQL pool max = 10 connections

1. Статьи 1-10: получают соединения, начинают транзакции
2. Статьи 11-60: встают в очередь ожидания соединения
3. Статьи 1-10: пытаются сделать INSERT → queue написи
4. Pool полностью исчерпан
5. Следующий цикл cron: тоже нужны соединения → встаёт в очередь
6. Все последующие циклы тоже ждут → CASCADE FREEZE
7. Ни один цикл не может завершиться (logCronFinish тоже needs query())
```

#### Почему это не происходило раньше

| Фактор | Раньше | В день инцидента |
|--------|--------|------------------|
| Кол-во статей | ~20-30 | **60-90** (больше RSS-источников) |
| `populateNewsTagLinks` | Не существовало (v2 ещё не было в main) | **Был включён** в цикл |
| Pool size | 10 | 10 |
| Условие deadlock | 20 < 10 = false | **60 > 10 = true** ✅ |

---

### Фикс

#### Phase 1: Hotfix (остановить кровотечение)

```typescript
// Закомментировать вызов в cron.ts
// if (a.sentiment_source === 'llm' ...) {
//   await populateNewsTagLinks(...);  ← БАН
// }
```
Результат: cron работает, enrichment отключён.

#### Phase 2: Правильный фикс (batch enrichment)

```typescript
// cron.ts — сбор задач В цикле, выполнение ПОСЛЕ
const enrichmentTasks: EnrichmentTask[] = [];

for (const a of processed) {
  // ... save article ...
  enrichmentTasks.push({ newsId, matchedTags, tagImpacts });  // ✅ без await
}

// После цикла: 1 соединение на ВЕСЬ batch
populateNewsTagLinksBatch(enrichmentTasks).catch(err => {
  console.error(`Batch enrichment failed: ${err.message}`);
});
```

```typescript
// enrichment.ts — batch функция
export async function populateNewsTagLinksBatch(tasks: EnrichmentTask[]): Promise<void> {
  if (tasks.length === 0) return;
  const client = await pool.connect();  // ← 1 connection!
  try {
    await client.query('BEGIN');
    
    // Все keyword-ссылки одним unnest
    const keywordNewsIds: string[] = [];
    const keywordTags: string[] = [];
    for (const task of tasks) {
      for (const tag of task.matchedTags) {
        keywordNewsIds.push(task.newsId);
        keywordTags.push(tag);
      }
    }
    if (keywordNewsIds.length > 0) {
      await client.query(
        `INSERT INTO news_tag_links (news_id, tag_id, link_source)
         SELECT news_id, tag_id, 'keyword'
         FROM unnest($1::text[], $2::text[]) AS t(news_id, tag_id)
         ON CONFLICT DO NOTHING`,
        [keywordNewsIds, keywordTags]
      );
    }
    
    // Все llm_impact-ссылки одним unnest
    // ... similar pattern ...
    
    // Все статьи помечаем v2
    await client.query(
      'UPDATE news SET enrichment_version = 2 WHERE id = ANY($1::text[])',
      [tasks.map(t => t.newsId)]
    );
    
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}
```

#### Phase 3: Zombie cleanup

```typescript
// В начале каждого цикла — удаляем мусор от мёртвых процессов
const cleanup = await query(
  `DELETE FROM cron_log 
   WHERE finished_at IS NULL 
     AND started_at < NOW() - INTERVAL '15 minutes'
   RETURNING id`
);
```

---

### Уроки

#### ❌ Неправильно | ✅ Правильно

| ❌ Неправильно | ✅ Правильно |
|---------------|-------------|
| `await pool.connect()` внутри `for` цикла | `pool.connect()` один раз **после** цикла |
| N соединений на N элементов | 1 соединение на весь batch |
| `await` блокирует основной поток | `.catch()` — fire-and-forget для некритичных операций |
| Нет cleanup при hard restart | Авто-cleanup мусора при старте |

#### Профилактика

1. **Никогда** не вызывать `pool.connect()` внутри for-loop без лимита concurrency
2. **Всегда** использовать batch-операции (unnest, ANY, IN)
3. **Всегда** делать fire-and-forget для enrichment (`.catch()`, не `await`)
4. **Cron lock TTL** = 10 мин (авто-очистка при зависании)
5. **Zombie cleanup** при старте каждого цикла

---

### Как диагностировать за 30 секунд

```bash
# 1. Проверить /debug-cron
curl https://pulse-api-bsov.onrender.com/debug-cron | jq

# Если 3+ записи с finished_at: null → подозрение на freeze

# 2. Проверить /health
curl https://pulse-api-bsov.onrender.com/health | jq

# Если version старая → деплой не прошёл

# 3. Решение: hard restart на Render
# Dashboard → pulse-api → Kill Instance / Manual Restart
```

---

---

## INC-002: Deferred Processor Overload — Cascade Cron Freeze

| Поле | Значение |
|------|----------|
| **ID** | INC-002 |
| **Дата** | 2026-06-05 15:35 UTC |
| **Статус** | ✅ RESOLVED |
| **Серьёзность** | P1 — высокий (cron замедлился до 15+ мин, новые статьи задерживались) |
| **Связан с** | INC-001 (pool exhaustion — первоначальная причина накопления) |
| **Коммит фикса** | `d72aecf` (`/cleanup-failed-articles` endpoint) |

---

### Симптомы

```bash
# /debug-cron — циклы успешные, НО занимают 15-20 минут вместо нормальных 5-8
{"started_at":"15:20","finished_at":"15:33","articles_saved":74,"status":"success"}  # 13 мин!
{"started_at":"15:35","finished_at":null,"articles_saved":0,"status":"running"}         # завис
{"started_at":"15:45","finished_at":null,"articles_saved":0,"status":"running"}         # завис

# Новые статьи есть, но появляются с большой задержкой
# Карусель показывает старые статьи вперёд свежих
```

- Cron циклы успешные, но длительность **×2-3 от нормы**
- Периодические zombie-записи (циклы не успевают завершиться до следующего)
- Новые статьи на сайте появляются с задержкой 10-15 минут
- Deferred processor логи: `Processing 20 failed articles` каждые 10 минут

---

### Timeline

| Время | Событие |
|-------|---------|
| 13:05 | ❌ INC-001 начался — cron freeze из-за pool exhaustion |
| 13:05-15:20 | ❌ LLM не работает — статьи накапливают `llm_error` (timeout, rate-limit) |
| 15:20 | ✅ Cron восстановился после hotfix INC-001 |
| 15:30 | 🔍 Замечено: циклы занимают 13+ минут вместо 5-8 |
| 15:35 | 🔍 Deferred processor: обработка 20 статей с ошибкой каждые 10 мин |
| 15:40 | 🔍 Подсчёт: **9276 статей** с `llm_error` в базе |
| 15:42 | 🔧 Cleanup endpoint задеплоен (`d72aecf`) |
| 15:43 | 🔧 Вызов `/cleanup-failed-articles` — удалено 9276 статей |
| 16:00 | ✅ Цикл: 94 fetched, 93 saved, finished за 8 минут ✅ (норма!) |
| 16:25 | ✅ Цикл: 72 fetched, 56 saved, finished за 6 минут ✅ |

---

### Root Cause Analysis

#### Цепочка разрушения (CASCADE)

```
INC-001: cron freeze 13:05-15:20 (2.5 часа)
    ↓
LLM не обрабатывает статьи → все получают llm_error='timeout'
    ↓
2.5 часа × 60 статей/15мин × 4 цикла = ~960 статей с ошибкой
    ↓
+ накопленные ошибки за предыдущие дни = 9276 статей
    ↓
Deferred processor каждые 10 мин: берёт 20 статей, LLM retry
    ↓
20 статей × 1 LLM batch = +30-60 секунд к каждому cron циклу
    ↓
Цикл занимает 13-15 минут вместо 5-8
    ↓
Cron lock не успевает освободиться → zombie records
    ↓
Следующий цикл ждёт lock → каскадная задержка
```

#### Почему это не происходило раньше

| Фактор | Раньше | В день инцидента |
|--------|--------|------------------|
| LLM uptime | 95%+ | **2.5 часа downtime** (INC-001) |
| Статей с ошибкой | ~50-100 | **9276** (×100 накопление) |
| Deferred load | 0-2 статьи/10мин | **20 статей/10мин** (максимум) |
| Cron длительность | 5-8 мин | **13-15 мин** (×2-3) |

---

### Фикс

#### Phase 1: Диагностика

```sql
-- Подсчёт статей с ошибкой
SELECT COUNT(*) FROM news WHERE llm_error IS NOT NULL;
-- Результат: 9276 (!!!)

-- Проверка deferred queue
SELECT llm_error, COUNT(*) 
FROM news 
WHERE llm_error IS NOT NULL AND llm_attempts < 3
GROUP BY llm_error;
-- Результат: 9276 × 'timeout', 'rate-limit', 'parse'
```

#### Phase 2: Cleanup

```bash
# Разовый вызов (auth: x-trigger-secret)
curl -X POST https://pulse-api-bsov.onrender.com/cleanup-failed-articles \
  -H "x-trigger-secret: pulse-dev-key"

# Ответ:
{"deleted": 9276, "message": "Removed 9276 articles with llm_error"}
```

**UI (2026-06-18):** Теперь cleanup доступен из Admin Dashboard → LLM Metrics → кнопка **"Удалить ошибки"** в правом верхнем углу. Endpoint также принимает admin JWT.

**Важно:** Удалены только статьи с `llm_error`. Успешные статьи (`sentiment_source='llm'`) НЕ тронуты.

#### Phase 3: Проверка

```bash
# Повторный подсчёт
SELECT COUNT(*) FROM news WHERE llm_error IS NOT NULL;
-- Результат: 0 ✅

# Deferred processor: "Processing 0 failed articles" ✅
```

---

### Уроки

#### ❌ Неправильно | ✅ Правильно

| ❌ Неправильно | ✅ Правильно |
|---------------|-------------|
| Нет лимита на размер deferred queue | Мониторинг `COUNT(*) WHERE llm_error` |
| Нет авто-cleanup старых ошибок | Cleanup статей с `attempts >= 3` раз в сутки |
| Нет алерта на рост queue | Алерт если `llm_error > 1000` за час |

#### Профилактика

1. **Мониторинг:** `SELECT COUNT(*) FROM news WHERE llm_error IS NOT NULL` — раз в час
2. **Авто-cleanup:** `DELETE FROM news WHERE llm_error IS NOT NULL AND llm_attempts >= 3 AND last_retry_at < NOW() - INTERVAL '24 hours'`
3. **Алерт:** Если `llm_error` растёт быстрее чем обрабатывается → Telegram alert
4. **Деградация:** При LLM downtime > 30 мин — авто-отключение deferred processor

---

---

## INC-003: SQL Type Mismatch — text[] @> character varying[]

| Поле | Значение |
|------|----------|
| **ID** | INC-003 |
| **Дата** | 2026-06-05 19:00 UTC |
| **Статус** | ✅ RESOLVED |
| **Серьёзность** | P2 — высокий (admin tags tab broken) |
| **Коммит фикса** | `fba489c` |

### Симптомы
- Admin → вкладка "Теги" — пустая страница
- Console: `500 ()`
- Ошибка: `operator does not exist: text[] @> character varying[]`

### Root Cause
PostgreSQL не может сравнить `text[]` с `character varying[]` через `@>`:
```sql
n.matched_tags @> ARRAY[t.tag_id]  -- text[] @> character varying[] = ERROR
```

### Фикс
```sql
-- Было:
LEFT JOIN news n ON n.matched_tags @> ARRAY[t.tag_id]

-- Стало:
LEFT JOIN news n ON t.tag_id = ANY(n.matched_tags)  -- ← работает с любыми типами
```

**Почему ANY лучше:** не требует кастинга, использует GIN индекс, читаемее.

---

---

## INC-004: COALESCE Partial Update Bug — Empty Arrays Silently Overwritten

| Поле | Значение |
|------|----------|
| **ID** | INC-004 |
| **Дата** | 2026-06-05 (обнаружено при code review TZ_INLINE_TAG_EDIT) |
| **Статус** | ✅ PREVENTED (пойман до production) |
| **Серьёзность** | P2 — высокий (silent data loss) |
| **Коммит фикса** | не применялось — пойман в ТЗ до реализации |

### Симптомы

```sql
-- "Partial update" через COALESCE — выглядит правильно:
UPDATE user_defined_tags
SET keywords = COALESCE($2, keywords)  -- ← BUG!
WHERE tag_id = $1;
```

- PUT endpoint заявляет "partial update — только переданные поля"
- Но `COALESCE` перезаписывает поле при `[]` (пустой массив)
- Никакой ошибки — silent data loss

### Root Cause

**PostgreSQL COALESCE трактует `[]` (empty array) как truthy:**

```
$2 = null        → COALESCE(null, keywords) → keywords ✅ (не меняет)
$2 = ['foo']     → COALESCE(['foo'], kw)    → ['foo']  ✅ (меняет)
$2 = []          → COALESCE([], keywords)    → []       ❌ (перезаписывает!)
```

**Почему это происходит:**
- `COALESCE` проверяет `IS NULL`
- `[]` — это **не NULL** в PostgreSQL
- Поэтому `COALESCE([], old_value)` возвращает `[]`, а не `old_value`

**Когда взрывается:**
- Frontend отправляет обновлённый массив (например, keywords после удаления)
- Backend оборачивает в `COALESCE(new_array, old_value)`
- Если new_array = `[]` (пользователь удалил все элементы) → поле перезаписывается пустым массивом
- Валидация `minItems` **не спасает** — она должна быть ДО SQL, не после

### Фикс

```sql
-- ❌ НЕПРАВИЛЬНО:
keywords = COALESCE($2, keywords)

-- ✅ ПРАВИЛЬНО:
keywords = CASE WHEN $2 IS NOT NULL THEN $2 ELSE keywords END
```

Разница:
| Значение `$2` | `COALESCE($2, kw)` | `CASE WHEN $2 IS NOT NULL...` |
|---------------|--------------------|------------------------------|
| `null` | `keywords` ✅ | `keywords` ✅ |
| `['foo']` | `['foo']` ✅ | `['foo']` ✅ |
| `[]` | `[]` ❌ | `[]` ✅ (если передали — значит так надо) |

**Но** — для `[]` нужна валидация **ДО** SQL:
```typescript
if (updates.keywords !== undefined && updates.keywords.length < 1) {
  return res.status(400).json({ error: 'min 1 required' });
}
```

### Уроки

#### ❌ Неправильно | ✅ Правильно

| ❌ Неправильно | ✅ Правильно |
|---------------|-------------|
| `COALESCE($param, column)` для partial update | `CASE WHEN $param IS NOT NULL THEN $param ELSE column END` |
| Валидация после SQL | Валидация **ДО** SQL |
| Доверять `COALESCE` с массивами | `COALESCE` работает только со скалярами и `NULL` |

#### Где ещё может взорваться

```typescript
// Любое поле массив/JSONB:
COALESCE($2, old_jsonb)   // $2 = {} → перезапишет на {}
COALESCE($3, old_array)   // $3 = [] → перезапишет на []
COALESCE($4, old_text)    // $4 = '' → перезапишет на '' (!)
```

**Даже для `text`:** `COALESCE('', old_value)` вернёт `''`, а не `old_value`!

#### Правило (hard rule)

> **Для partial update: всегда `CASE WHEN $N IS NOT NULL`, никогда `COALESCE($N, column)`.**

**Исключение:** `COALESCE` можно использовать только если `$param` гарантированно `NULL` или **non-empty** (скаляр с проверкой `minLength > 0`).

---

### Профилактика

1. **Code review checklist:** любой `COALESCE($param, column)` → красный флаг
2. **SQL lint rule:** запретить `COALESCE($*, column)` в UPDATE для массивов/JSONB/text
3. **Unit test:** передать `[]`, `{}`, `''` → проверить что поле НЕ изменилось (если partial update)

---

---

## INC-005: Debug Endpoint Cascade — 5 Bugs in 1 Endpoint

| Поле | Значение |
|------|----------|
| **ID** | INC-005 |
| **Дата** | 2026-06-05 |
| **Статус** | ✅ RESOLVED |
| **Серьёзность** | P2 — высокий (5 итераций фиксов) |
| **Коммит** | `0cea93d` (final fix) |

### Симптомы

При создании простого debug endpoint `/debug-tag/:tagId` получили каскад из 5 ошибок:

```
1. {"error":"Forbidden"}                          ← auth через secret, не JWT
2. {"error":"Forbidden"}                          ← secret key нет fallback
3. {"error":"invalid input syntax for type json"}  ← SQL string concat
4. {"error":"could not determine data type of $1"} ← не хватает ::text cast
5. {"error":"column tag_id does not exist"}        ← таблица не существует
6. TS1127: Invalid character                       ← нет trailing newline
```

### Root Cause — Чеклист "Как НЕ делать debug endpoint"

#### ❌ Баг 1: Auth через secret key вместо JWT
```typescript
// ❌ НЕПРАВИЛЬНО — secret key не работает для залогиненных админов:
if (secret !== process.env.CRON_SECRET_KEY) { return 403; }

// ✅ ПРАВИЛЬНО — использовать существующий requireAdmin middleware:
app.get('/debug/...', requireAdmin, async (req, res) => { ... })
// ИЛИ поддерживать ОБА способа (JWT header + secret query для браузера)
```

#### ❌ Баг 2: Нет fallback для secret key
```typescript
// ❌ НЕПРАВИЛЬНО — если CRON_SECRET_KEY не установлен:
if (secret === process.env.CRON_SECRET_KEY)  // null === undefined = false

// ✅ ПРАВИЛЬНО — fallback на дефолтное значение:
if (secret === (process.env.CRON_SECRET_KEY || 'pulse-dev-key'))
```

#### ❌ Баг 3: SQL string concat с JSON
```sql
-- ❌ НЕПРАВИЛЬНО — SQL injection + invalid JSON:
WHERE tag_impact @> '[{"tag": "' || $1 || '"}]'

-- ✅ ПРАВИЛЬНО — jsonb_build_array (безопасно):
WHERE tag_impact @> jsonb_build_array(jsonb_build_object('tag', $1::text))
```

#### ❌ Баг 4: Нет ::text cast для jsonb_build_object
```sql
-- ❌ НЕПРАВИЛЬНО — PostgreSQL не знает тип $1:
jsonb_build_object('tag', $1)

-- ✅ ПРАВИЛЬНО — явный cast:
jsonb_build_object('tag', $1::text)
```

#### ❌ Баг 5: Нет проверки существования таблицы
```typescript
// ❌ НЕПРАВИЛЬНО — падаем если таблица не создана:
const result = await query(`SELECT ... FROM news_tag_links`)

// ✅ ПРАВИЛЬНО — try/catch или проверка существования:
try {
  const result = await query(`SELECT ... FROM news_tag_links`)
} catch { count = 0 }
```

#### ❌ Баг 6: Нет trailing newline
```
// ❌ Файл заканчивается на последней строке без \n
// build check 123456

// ✅ Файл заканчивается пустой строкой
// build check 123456
<пустая строка>
```

### Правильный чеклист для debug endpoint

```markdown
## Чеклист: Создание debug endpoint

- [ ] Auth: использовать requireAdmin (JWT) ИЛИ secret с fallback
- [ ] SQL: jsonb_build_array/object вместо string concat
- [ ] SQL: ::text cast для всех параметров в jsonb_build_object
- [ ] SQL: try/catch для таблиц которые могут не существовать
- [ ] Файл: проверить trailing newline (wc -l, cat -A)
- [ ] Тест: вызвать endpoint перед коммитом (curl или браузер)
```

### Итоговый правильный код

```typescript
app.get('/debug-tag/:tagId', async (req, res) => {
  // Auth: оба способа
  const token = req.headers.authorization?.replace('Bearer ', '');
  const secret = req.query.secret as string;
  let isAdmin = false;
  
  if (secret && secret === (process.env.CRON_SECRET_KEY || 'pulse-dev-key')) {
    isAdmin = true;
  } else if (token) {
    try {
      const jwt = await import('jsonwebtoken');
      const decoded = jwt.default.verify(token, process.env.JWT_SECRET!) as any;
      isAdmin = !!decoded.is_admin;
    } catch { isAdmin = false; }
  }
  if (!isAdmin) return res.status(403).json({ error: 'Forbidden' });

  try {
    const tagId = req.params.tagId;
    
    const tagResult = await query(`SELECT * FROM user_defined_tags WHERE tag_id = $1`, [tagId]);
    if (tagResult.rows.length === 0) return res.status(404).json({ error: 'Tag not found' });
    
    const tag = tagResult.rows[0];
    const ed = tag.enriched_data || {};
    
    // Safe queries with try/catch for optional tables
    let linksCount = 0;
    try {
      const r = await query(`SELECT COUNT(*) as count FROM news_tag_links WHERE tag_id = $1`, [tagId]);
      linksCount = parseInt(r.rows[0].count);
    } catch { /* table may not exist */ }
    
    const matchedResult = await query(
      `SELECT COUNT(*) as count FROM news WHERE $1::text = ANY(matched_tags)`, [tagId]);
    
    const llmResult = await query(
      `SELECT COUNT(*) as count FROM news WHERE tag_impact @> jsonb_build_array(jsonb_build_object('tag', $1::text))`, [tagId]);
    
    let subsCount = 0;
    try {
      const r = await query(`SELECT COUNT(*) as count FROM notification_settings WHERE tag_id = $1`, [tagId]);
      subsCount = parseInt(r.rows[0].count);
    } catch { /* table may not exist */ }
    
    res.json({
      tag_id: tag.tag_id,
      tag_name: tag.tag_name,
      tag_type: tag.tag_type,
      keywords: tag.keywords,
      enriched_data: {
        ticker: ed.ticker || null,
        website: ed.website || null,
        description_ru: ed.description_ru || null,
        key_products: ed.key_products || [],
        related_tags: ed.related_tags || [],
        synonyms_ru: ed.synonyms_ru || [],
        synonyms_en: ed.synonyms_en || [],
      },
      stats: {
        news_tag_links: linksCount,
        matched_in_articles: parseInt(matchedResult.rows[0].count),
        llm_impact_articles: parseInt(llmResult.rows[0].count),
        subscriber_count: subsCount,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
```

---

*Документ создан: 2026-06-05*
---

## INC-006: Таблица Подписок — Название Обманчиво

| Поле | Значение |
|------|----------|
| **ID** | INC-006 |
| **Дата** | 2026-06-05 |
| **Статус** | ✅ RESOLVED |
| **Серьёзность** | P1 — критический (ТЗ v4 неверная таблица) |
| **Источник** | Аудит TZ_TAG_DELETE_v4 → v5 |

### Баг

В ТЗ v4 указана таблица `notification_settings` для удаления подписок:
```sql
DELETE FROM notification_settings WHERE tag_id = $1;
--         ^^^^^^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^
--         НЕПРАВИЛЬНАЯ таблица  НЕСУЩЕСТВУЮЩАЯ колонка
```

### Почему это ошибка

| Таблица | Назначение | Есть `tag_id`? |
|---------|-----------|----------------|
| `notification_settings` | Глобальные настройки уведомлений (tg_enabled, email_enabled, report_frequency) | ❌ **НЕТ** |
| **`portfolios`** | **Подписки пользователей на теги** (`user_id + tag_id`) | ✅ **ДА** |

**notification_settings** хранит НАСТРОЙКИ:  
`{ user_id: 1, tg_enabled: true, email_enabled: false, report_frequency: 'daily' }`

**portfolios** хранит ПОДПИСКИ:  
`{ user_id: 1, tag_id: 'сбербанк', tag_name: 'Сбербанк', tag_type: 'company' }`

### Почему так произошло

Название `portfolios` **неинтуитивно**. Логично было бы:
- `user_tag_subscriptions` ← такого нет
- `notification_settings` ← звучит правильно, но это НЕ подписки

Разработчик предположил логичное название, не сверившись со схемой.

### Исправление

```sql
-- Было (v4):
DELETE FROM notification_settings WHERE tag_id = $1;

-- Стало (v5):
DELETE FROM portfolios WHERE tag_id = $1;
```

### Уроки

#### ❌ Неправильно | ✅ Правильно

| ❌ Неправильно | ✅ Правильно |
|---------------|-------------|
| Предполагать название таблицы по логике | Сверяться с `schema.sql` перед написанием SQL |
| `SELECT * FROM notification_settings` | `\dt` + `\d table_name` в psql |
| Доверять "очевидным" названиям | Проверять `information_schema.columns` |

#### Чеклист перед написанием SQL

```markdown
## Перед любым SQL с новой таблицей:

1. [ ] Открыть schema.sql — найти CREATE TABLE
2. [ ] Проверить ВСЕ колонки — \d table_name
3. [ ] Проверить типы данных — особенно JSONB/text[]
4. [ ] Не доверять названиям — portfolios ≠ subscriptions
5. [ ] Тестовый SELECT на реальной базе перед DELETE/UPDATE
```

#### Запрос для проверки любой таблицы

```sql
-- Быстрая проверка структуры таблицы:
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'portfolios'
ORDER BY ordinal_position;

-- Проверка что колонка существует:
SELECT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_name = 'notification_settings' AND column_name = 'tag_id'
);
-- Результат: false ← колонки нет, не используем
```

---

---

## 7. СВОДНАЯ ТАБЛИЦА ВСЕХ УРОКОВ

| # | Урок | Источник | Раздел |
|---|------|----------|--------|
| 1 | Никогда `COALESCE($param, column)` для partial UPDATE | INC-004 | PIPELINE.md §11 |
| 2 | Всегда `::text` в `jsonb_build_object('tag', $1::text)` | INC-005 | INC-005 |
| 3 | `jsonb_array_elements('[]')` → 0 строк → `ARRAY()` → `NULL` | INC-005 | INC-005 баг #3 |
| 4 | `try/catch` для таблиц которые могут не существовать | INC-005 | INC-005 баг #4 |
| 5 | Не доверять названиям таблиц — сверяться с schema.sql | INC-006 | INC-006 |
| 6 | Trailing newline `\n` в конце файла обязательна | INC-005 | INC-005 баг #6 |
| 7 | `array_remove` а не `DELETE` для массивных полей | INC-005 | INC-005 баг #1 |

---

*Документ создан: 2026-06-05*  
*Версия: 4.0 — добавлен INC-006 (таблица подписок)*
