# TZ: Inline Tag Editing — Admin TagDetailModal

> **ID:** TZ_INLINE_TAG_EDIT
> **Дата:** 2026-06-05
> **Статус:** Ready for implementation
> **Связано с:** PIPELINE.md v9.1, INCIDENTS.md

---

## 1. ЦЕЛЬ

Дать администратору возможность редактировать все поля тега прямо в карточке (TagDetailModal) без перезагрузки страницы.

---

## 2. ПОЛЯ ДЛЯ РЕДАКТИРОВАНИЯ

| Поле | Тип данных | Компонент UI | Валидация |
|------|-----------|--------------|-----------|
| `tag_type` | enum | Dropdown select | company / sector / country / commodity / index |
| `ticker` | string | Text input | 1-20 символов, A-Z0-9 (опционально) |
| `website` | string | Text input | URL format, max 500 символов (опционально) |
| `description_ru` | string | Textarea | max 5000 символов (опционально) |
| `keywords` | string[] | Tag chips + input | min 1, max 50 слов |
| `key_products` | string[] | Tag chips + input | max 20 слов (опционально) |
| `related_tags` | string[] | Multi-select dropdown | max 20 связей (опционально) |
| `synonyms_ru` | string[] | Tag chips + input | max 20 слов (опционально) |
| `synonyms_en` | string[] | Tag chips + input | max 20 слов (опционально) |

---

## 3. API SPECIFICATION

### 3.1 PUT /admin/tags/:tagId

**Один endpoint для всех полей.** Partial update — только переданные поля.

```
PUT /admin/tags/:tagId
Content-Type: application/json
Authorization: Bearer <ADMIN_JWT>
```

**Request body (любые поля из таблицы выше):**
```json
{
  "tag_type": "company",
  "ticker": "SBER",
  "website": "https://www.sberbank.ru",
  "description_ru": "Крупнейший банк России...",
  "keywords": ["сбер", "сбербанк", "sber"],
  "key_products": ["Кредиты", "Депозиты", "Инвестиции"],
  "related_tags": ["втб", "т-банк", "альфа-банк"],
  "synonyms_ru": ["сбер", "сбербанк"],
  "synonyms_en": ["sberbank"]
}
```

**Response 200:**
```json
{
  "success": true,
  "updated_fields": ["ticker", "tag_type"],
  "tag": {
    "tag_id": "сбербанк",
    "tag_name": "Сбербанк",
    "tag_type": "company",
    "ticker": "SBER",
    "website": "https://www.sberbank.ru",
    "description_ru": "Крупнейший банк России...",
    "keywords": ["сбер", "сбербанк", "sber"],
    "key_products": ["Кредиты", "Депозиты", "Инвестиции"],
    "related_tags": ["втб", "т-банк", "альфа-банк"],
    "synonyms_ru": ["сбер", "сбербанк"],
    "synonyms_en": ["sberbank"]
  }
}
```

**Response 400 (validation error):**
```json
{
  "error": "Invalid ticker format",
  "field": "ticker"
}
```

**Response 403:** Не админ.
**Response 404:** Тег не найден.

### 3.2 DELETE /admin/tags/:tagId/keywords

Удаление одного ключевого слова:
```
DELETE /admin/tags/:tagId/keywords
Body: { "keyword": "старое_слово" }
```

### 3.3 Validation rules

```typescript
const RULES = {
  tag_type: { type: 'enum', values: ['company','sector','country','commodity','index'] },
  ticker: { type: 'string', min: 1, max: 20, pattern: /^[A-Z0-9\.]+$/, optional: true },
  website: { type: 'url', max: 500, optional: true },
  description_ru: { type: 'string', max: 5000, optional: true },
  keywords: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', max: 100 } },
  key_products: { type: 'array', maxItems: 20, items: { type: 'string', max: 100 }, optional: true },
  related_tags: { type: 'array', maxItems: 20, items: { type: 'string' }, optional: true },
  synonyms_ru: { type: 'array', maxItems: 20, items: { type: 'string', max: 100 }, optional: true },
  synonyms_en: { type: 'array', maxItems: 20, items: { type: 'string', max: 100 }, optional: true },
};
```

---

## 4. UI SPECIFICATION

### 4.1 Общий принцип

Каждое поле — карточка с заголовком. Справа от заголовка — иконка карандаша (Pencil size=14).

**Режим просмотра:**
```
┌─────────────────────────────────┐
│ Ticker                    [✎] │  ← Pencil icon
│ SBER                            │
└─────────────────────────────────┘
```

**Режим редактирования:**
```
┌─────────────────────────────────┐
│ Ticker                    [✓] [✗] │  ← Save + Cancel
│ ┌─────────────────────────────┐ │
│ │ SBERA                       │ │  ← Input field
│ └─────────────────────────────┘ │
└─────────────────────────────────┘
```

### 4.2 Компоненты по полям

#### tag_type — Dropdown
```
┌─────────────────────────────────┐
│ Type                      [✎] │
│ [company ▼]                      │  ← native <select>
│   sector                         │
│   country                        │
│   commodity                      │
│   index                          │
└─────────────────────────────────┘
```

#### ticker, website — Text input
```
┌─────────────────────────────────┐
│ Ticker                    [✎] │
│ ┌─────────────────────────────┐ │
│ │ SBER                        │ │
│ └─────────────────────────────┘ │
│                    [Save] [Cancel]│
└─────────────────────────────────┘
```

#### description_ru — Textarea
```
┌─────────────────────────────────┐
│ Description               [✎] │
│ ┌─────────────────────────────┐ │
│ │ Крупнейший банк России,    │ │
│ │ основан в 1841 году...     │ │
│ └─────────────────────────────┘ │
│                    [Save] [Cancel]│
└─────────────────────────────────┘
```

#### keywords, key_products, synonyms_ru, synonyms_en — Tag Chips + Input
```
┌─────────────────────────────────┐
│ Keywords                  [✎] │
│ [сбер] [сбербанк] [sber] [+x]│  ← Chips + remove (×)
│ ┌─────────────────────────────┐ │
│ │ Добавить слово...           │ │  ← Input for new tag
│ └─────────────────────────────┘ │
│                    [Save] [Cancel]│
└─────────────────────────────────┘
```

Enter или comma — добавить новый чипс.
Backspace в пустом поле — удалить последний чипс.
Click × на чипсе — удалить.

#### related_tags — Multi-select
```
┌─────────────────────────────────┐
│ Related Tags              [✎] │
│ [втб] [т-банк] [+]            │  ← Existing chips
│ ┌─────────────────────────────┐ │
│ │ Поиск тега...               │ │
│ │ □ втб                       │ │
│ │ □ т-банк                    │ │
│ │ □ альфа-банк ☑              │ │
│ │ □ газпром                   │ │
│ └─────────────────────────────┘ │
│                    [Save] [Cancel]│
└─────────────────────────────────┘
```

### 4.3 Иконки (Lucide React)

| Действие | Иконка |
|----------|--------|
| Редактировать | `Pencil` (size=14) |
| Сохранить | `Check` (size=14, color=#34D399) |
| Отменить | `X` (size=14, color=#6B7280) |
| Удалить чипс | `X` (size=10, color=#6B7280) |
| Добавить чипс | `Plus` (size=14, color=#60A5FA) |
| Успешное сохранение | `CheckCircle` (size=14, color=#34D399) — мигание 2 сек |

### 4.4 Состояния карточки

| Состояние | Визуал |
|-----------|--------|
| Просмотр | Обычная карточка, серый текст |
| Hover карточки | Карандаш появляется справа |
| Редактирование | Жёлтая рамка (borderColor: #FBBF24) |
| Сохранение | Спиннер на кнопке Save |
| Успех | Зелёная рамка (borderColor: #34D399), 2 секунды |
| Ошибка | Красная рамка (borderColor: #EF4444), текст ошибки |

### 4.5 Auto-save debounce

Для text input и textarea — автосохранение через 2 секунды после последнего нажатия (debounce). Для массивов (keywords, tags) — только по кнопке Save.

---

## 5. BACKEND IMPLEMENTATION

### 5.1 SQL Update

```sql
-- Обновление тега (только переданные поля)
UPDATE user_defined_tags
SET
  tag_type = COALESCE($2, tag_type),
  ticker = COALESCE($3, ticker),
  website = COALESCE($4, website),
  description_ru = COALESCE($5, description_ru),
  keywords = COALESCE($6, keywords),
  key_products = COALESCE($7, key_products),
  related_tags = COALESCE($8, related_tags),
  synonyms_ru = COALESCE($9, synonyms_ru),
  synonyms_en = COALESCE($10, synonyms_en),
  updated_at = NOW()
WHERE tag_id = $1
RETURNING *;
```

### 5.2 Validation middleware

```typescript
function validateTagUpdate(req, res, next) {
  const allowed = ['tag_type','ticker','website','description_ru',
                   'keywords','key_products','related_tags','synonyms_ru','synonyms_en'];
  const updates = {};
  
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      // validate by RULES[key]
      updates[key] = req.body[key];
    }
  }
  
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  
  req.updates = updates;
  next();
}
```

### 5.3 Endpoint registration

```typescript
// In src/index.ts after other admin routes
app.put('/admin/tags/:tagId', requireAdmin, validateTagUpdate, async (req, res) => {
  // ... implementation
});
```

---

## 6. FRONTEND IMPLEMENTATION

### 6.1 Компоненты

| Компонент | Файл | Описание |
|-----------|------|----------|
| `EditableCard` | `src/components/admin/EditableCard.tsx` | Обёртка: просмотр ↔ редактирование |
| `TagTypeSelect` | `src/components/admin/TagTypeSelect.tsx` | Dropdown с типами |
| `TagChipsInput` | `src/components/admin/TagChipsInput.tsx` | Чипсы + добавление/удаление |
| `RelatedTagSelect` | `src/components/admin/RelatedTagSelect.tsx` | Multi-select поиск тегов |

### 6.2 State management

```typescript
// В TagDetailModal:
const [editingField, setEditingField] = useState<string | null>(null);
const [editValues, setEditValues] = useState<Partial<TagDetail>>({});
const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
```

### 6.3 API client

```typescript
// В src/lib/api.ts
adminApi.putTag: (tagId: string, data: Partial<TagDetail>) => Promise<{ tag: TagDetail }>
```

---

## 7. ERROR HANDLING

| Сценарий | Frontend | Backend |
|----------|----------|---------|
| Невалидный ticker | Красная рамка + текст ошибки | 400 + `{ error, field }` |
| Пустой keywords | Блокируем Save, подсвечиваем | 400 |
| Тег не найден | — | 404 |
| Не админ | Редирект на / | 403 |
| Timeout | "Сохранение..." → retry | — |
| Conflict | Retry с merge | — |

---

## 8. ACCEPTANCE CRITERIA

- [ ] Админ может изменить Type через dropdown
- [ ] Админ может добавить/изменить Ticker
- [ ] Админ может добавить/изменить Website
- [ ] Админ может редактировать Description (textarea)
- [ ] Админ может добавлять/удалять Keywords (чипсы)
- [ ] Админ может добавлять/удалять Key Products (чипсы)
- [ ] Админ может добавлять/удалять Related Tags (multi-select)
- [ ] Админ может добавлять/удалять Synonyms RU/EN (чипсы)
- [ ] После сохранения — поле мигнёт зелёным, данные обновятся
- [ ] При ошибке — поле мигнёт красным, покажется текст ошибки
- [ ] Без перезагрузки страницы

---

## 9. ESTIMATION

| Этап | Время |
|------|-------|
| Backend: PUT endpoint + validation | 30 мин |
| Frontend: EditableCard component | 20 мин |
| Frontend: TagChipsInput component | 30 мин |
| Frontend: RelatedTagSelect component | 30 мин |
| Frontend: TagTypeSelect + wire up | 15 мин |
| Testing + polish | 15 мин |
| **Total** | **~2.5 часа** |

---

## 10. FILES TOUCHED

### Backend
- `src/index.ts` — +1 endpoint

### Frontend
- `src/pages/admin/TagDetailModal.tsx` — refactored with inline editing
- `src/components/admin/EditableCard.tsx` — NEW
- `src/components/admin/TagChipsInput.tsx` — NEW
- `src/components/admin/TagTypeSelect.tsx` — NEW
- `src/components/admin/RelatedTagSelect.tsx` — NEW
- `src/lib/api.ts` — +adminApi.putTag

---

*Документ создан: 2026-06-05*
*Версия: 1.0*
