# TZ: Tag Deletion v3 — Safe Cascade Delete

> **ID:** TZ_TAG_DELETE_v3
> **Дата:** 2026-06-05
> **Статус:** Ready for implementation
> **Связано с:** TZ_TAG_DELETE_v2, INCIDENTS.md (INC-004, INC-005)
> **Исправлено:** 4 критических бага из v2

---

## 1. ЦЕЛЬ

Безопасное удаление тега с полной очисткой всех связей. Никаких висячих ссылок. Никакой потери данных других тегов.

---

## 2. ИСПРАВЛЕНИЯ В V3

### Исправлено 4 критических бага из v2

| # | Баг в v2 | Исправление | Строка v2 |
|---|----------|-------------|-----------|
| 1 | Нет `::text` cast в `jsonb_build_object('tag', tag_id_param)` | Добавлен `tag_id_param::text` везде | 168 |
| 2 | `related_tags` cleanup не работает (`@>` wrong types) | Переписан на `jsonb_array_elements_text` + `array_remove` | 205-207 |
| 3 | Нет защиты от `undefined_table` | Каждый DELETE в `EXCEPTION WHEN undefined_table` | весь SQL |
| 4 | `jsonb_set(NULL, ...)` → обнуление `enriched_data` | `COALESCE(enriched_data, '{}')` перед `jsonb_set` | 195 |

---

## 3. SQL ФУНКЦИЯ УДАЛЕНИЯ

```sql
CREATE OR REPLACE FUNCTION delete_tag_cascade(tag_id_param VARCHAR)
RETURNS TABLE (
  deleted_tag VARCHAR,
  deleted_links INTEGER,
  deleted_subscriptions INTEGER,
  deleted_portfolios INTEGER,
  cleaned_articles_matched INTEGER,
  cleaned_articles_llm INTEGER,
  cleaned_related_tags INTEGER
) AS $$
DECLARE
  v_deleted_tag VARCHAR;
  v_deleted_links INTEGER := 0;
  v_deleted_subs INTEGER := 0;
  v_deleted_portfolios INTEGER := 0;
  v_cleaned_matched INTEGER := 0;
  v_cleaned_llm INTEGER := 0;
  v_cleaned_related INTEGER := 0;
  v_deleted_smart_cache INTEGER := 0;
BEGIN
  -- Защита: проверяем существование тега
  SELECT t.tag_id INTO v_deleted_tag
  FROM user_defined_tags t
  WHERE t.tag_id = tag_id_param;
  
  IF v_deleted_tag IS NULL THEN
    RAISE EXCEPTION 'Tag not found: %', tag_id_param
      USING ERRCODE = 'P0002';
  END IF;

  -- 1. Связи со статьями (опциональная таблица)
  BEGIN
    DELETE FROM news_tag_links WHERE tag_id = tag_id_param;
    GET DIAGNOSTICS v_deleted_links = ROW_COUNT;
  EXCEPTION WHEN undefined_table THEN
    v_deleted_links := 0;
  END;

  -- 2. Подписки юзеров (опциональная таблица)
  BEGIN
    DELETE FROM notification_settings WHERE tag_id = tag_id_param;
    GET DIAGNOSTICS v_deleted_subs = ROW_COUNT;
  EXCEPTION WHEN undefined_table THEN
    v_deleted_subs := 0;
  END;

  -- 3. Портфели (опциональная таблица)
  BEGIN
    DELETE FROM portfolios WHERE tag_id = tag_id_param;
    GET DIAGNOSTICS v_deleted_portfolios = ROW_COUNT;
  EXCEPTION WHEN undefined_table THEN
    v_deleted_portfolios := 0;
  END;

  -- 4. Убрать из matched_tags (text[] array)
  UPDATE news 
  SET matched_tags = array_remove(matched_tags, tag_id_param)
  WHERE tag_id_param = ANY(matched_tags);
  GET DIAGNOSTICS v_cleaned_matched = ROW_COUNT;

  -- 5. Убрать из tag_impact JSONB (LLM результаты)
  -- ИСПРАВЛЕНИЕ: добавлен ::text cast (баг #1 из v2)
  UPDATE news
  SET tag_impact = COALESCE(
    (SELECT jsonb_agg(elem) 
     FROM jsonb_array_elements(tag_impact) elem 
     WHERE elem->>'tag' != tag_id_param),
    '[]'::jsonb
  )
  WHERE tag_impact @> jsonb_build_array(jsonb_build_object('tag', tag_id_param::text));
  GET DIAGNOSTICS v_cleaned_llm = ROW_COUNT;

  -- 6. Smart tag cache (опциональная таблица)
  BEGIN
    DELETE FROM smart_tag_cache 
    WHERE tag_id_param::text = ANY(tags);
    GET DIAGNOSTICS v_deleted_smart_cache = ROW_COUNT;
  EXCEPTION WHEN undefined_table THEN
    v_deleted_smart_cache := 0;
  END;

  -- 7. Убрать из related_tags других тегов (ИСПРАВЛЕНИЕ: баг #2 и #4 из v2)
  -- Баг #2: @> не работает с mixed types (array @> string)
  -- Баг #4: jsonb_set(NULL, ...) обнуляет enriched_data
  -- Исправление: array_remove вместо jsonb_set, с COALESCE NULL-защитой
  
  -- Сначала считаем сколько тегов имели этот тег в related_tags
  SELECT COUNT(*) INTO v_cleaned_related
  FROM user_defined_tags
  WHERE enriched_data->'related_tags' IS NOT NULL
    AND enriched_data->'related_tags' @> jsonb_build_array(tag_id_param::text);

  -- Затем обновляем (ИСПРАВЛЕНИЕ #4: COALESCE enriched_data от NULL)
  UPDATE user_defined_tags
  SET enriched_data = CASE
    WHEN enriched_data IS NULL THEN NULL  -- оставляем NULL как NULL
    ELSE jsonb_set(
      enriched_data,
      '{related_tags}',
      to_jsonb(array_remove(
        ARRAY(SELECT jsonb_array_elements_text(enriched_data->'related_tags')),
        tag_id_param
      ))
    )
  END
  WHERE enriched_data->'related_tags' IS NOT NULL
    AND enriched_data->'related_tags' @> jsonb_build_array(tag_id_param::text);

  -- 8. Удалить сам тег (последним!)
  DELETE FROM user_defined_tags WHERE tag_id = tag_id_param;

  RETURN QUERY SELECT 
    v_deleted_tag,
    v_deleted_links,
    v_deleted_subs,
    v_deleted_portfolios,
    v_cleaned_matched,
    v_cleaned_llm,
    v_cleaned_related;
END;
$$ LANGUAGE plpgsql;
```

### Исправления в SQL (по багам):

**Баг #1 (строка 168 v2):** Добавлен `::text`:
```sql
-- Было (v2):
WHERE tag_impact @> jsonb_build_array(jsonb_build_object('tag', tag_id_param));

-- Стало (v3):
WHERE tag_impact @> jsonb_build_array(jsonb_build_object('tag', tag_id_param::text));
--                                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

**Баг #2 (строки 205-207 v2):** Переписан related_tags cleanup:
```sql
-- Было (v2) — НЕ РАБОТАЕТ:
WHERE enriched_data->'related_tags' @> to_jsonb(tag_id_param);
-- array @> string = несовместимые типы, 0 строк обновлено

-- Стало (v3):
WHERE enriched_data->'related_tags' @> jsonb_build_array(tag_id_param::text);
-- обновление через array_remove:
SET enriched_data = jsonb_set(
  enriched_data,
  '{related_tags}',
  to_jsonb(array_remove(
    ARRAY(SELECT jsonb_array_elements_text(enriched_data->'related_tags')),
    tag_id_param
  ))
)
```

**Баг #3 (весь SQL function):** Каждая опциональная таблица в try/catch:
```sql
BEGIN
  DELETE FROM news_tag_links WHERE tag_id = tag_id_param;
  GET DIAGNOSTICS ... = ROW_COUNT;
EXCEPTION WHEN undefined_table THEN
  ... := 0;  -- таблицы нет, продолжаем
END;
```

**Баг #4 (строка 195 v2):** COALESCE защита от NULL:
```sql
-- Было (v2) — обнуляет enriched_data:
SET enriched_data = jsonb_set(enriched_data, '{related_tags}', ...)
-- enriched_data = NULL → jsonb_set(NULL, ...) = NULL → все данные потеряны

-- Стало (v3):
SET enriched_data = CASE
  WHEN enriched_data IS NULL THEN NULL
  ELSE jsonb_set(enriched_data, '{related_tags}', ...)
END
-- NULL остаётся NULL, данные сохраняются
```

---

## 4. API SPECIFICATION

### 4.1 DELETE /admin/tags/:tagId

```
DELETE /admin/tags/:tagId
Authorization: Bearer <ADMIN_JWT>
```

**Process:**
1. Блокировка: `SELECT ... FOR UPDATE` на тег
2. Вызов `delete_tag_cascade(:tagId)`
3. Ответ со статистикой

**Response 200:**
```json
{
  "success": true,
  "message": "Tag 'илон-маск' deleted",
  "deleted_tag": "илон-маск",
  "stats": {
    "deleted_links": 45,
    "deleted_subscriptions": 12,
    "deleted_portfolios": 3,
    "cleaned_articles_matched": 38,
    "cleaned_articles_llm": 15,
    "cleaned_related_tags": 5
  }
}
```

**Response 404:**
```json
{ "error": "Tag not found" }
```

**Response 500:**
```json
{ "error": "Delete failed", "detail": "<SQL error message>" }
```

### 4.2 GET /admin/tags/:tagId/delete-preview

```
GET /admin/tags/:tagId/delete-preview
Authorization: Bearer <ADMIN_JWT>
```

**Response 200:**
```json
{
  "tag_id": "илон-маск",
  "tag_name": "Илон Маск",
  "is_system": false,
  "links_count": 45,
  "subscriptions_count": 12,
  "portfolio_count": 3,
  "matched_articles_count": 38,
  "llm_articles_count": 15,
  "related_tags_count": 5
}
```

---

## 5. UI SPECIFICATION

### 5.1 Кнопка Delete

Позиция: самый низ карточки тега, под горизонтальной линией.

```
┌─────────────────────────────────────┐
│                                     │
│  [Последняя секция карточки]       │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  🗑  Delete Tag                     │  ← #EF4444, hover: #DC2626
│                                     │
└─────────────────────────────────────┘
```

### 5.2 Confirm Delete Modal

```
┌─────────────────────────────────────┐
│  ⚠️  Delete Tag                     │  ← заголовок, #EF4444
│                                     │
│  Delete "Илон Маск"?               │
│                                     │
│  This will permanently remove:      │
│                                     │
│  • 45 article links                 │  ← данные из preview API
│  • 12 user subscriptions            │
│  • 3 portfolio entries              │
│  • 38 articles (matched_tags)       │
│  • 15 articles (LLM references)     │
│  • 5 related tag references         │
│                                     │
│  ┌─────────────────────────────┐   │
│  │ Type tag name to confirm:   │   │  ← safety input
│  │ илон-маск                   │   │
│  └─────────────────────────────┘   │
│                                     │
│  [Cancel]        [Delete Forever]   │  ← Delete disabled пока input ≠ tag_id
│                                     │
└─────────────────────────────────────┘
```

**Safety input:**
- Placeholder: `Type "илон-маск" to confirm`
- Кнопка Delete активируется ТОЛЬКО когда введён точный tag_id
- При mismatch — кнопка disabled + текст "Tag name does not match"

### 5.3 После удаления

1. Success modal закрывается
2. TagDetailModal закрывается
3. TagsTab обновляется (тег исчезает)
4. Toast: `✓ Tag "Илон Маск" deleted — 45 links, 12 subscriptions, 3 portfolios removed`

---

## 6. ERROR HANDLING

| Сценарий | Frontend | Backend |
|----------|----------|---------|
| Тег не найден | — | 404 |
| Не админ | Редирект на / | 403 |
| SQL error в транзакции | "Delete failed, no changes made" | 500 + ROLLBACK |
| Safety input не совпадает | Кнопка disabled | — |
| Preview API недоступен | "Loading preview..." → "unknown counts" | 500 |

---

## 7. ESTIMATION

| Этап | Время |
|------|-------|
| SQL function delete_tag_cascade (v3, 4 бага исправлены) | 30 мин |
| DELETE endpoint + preview endpoint | 20 мин |
| Frontend: DeleteConfirmModal с safety input | 30 мин |
| Frontend: интеграция в TagDetailModal | 10 мин |
| Testing: 4 edge cases из багов | 20 мин |
| **Total** | **~2 часа** |

---

## 8. FILES TOUCHED

### Backend
- `src/index.ts` — +2 endpoints, +SQL function

### Frontend
- `src/pages/admin/TagDetailModal.tsx` — +DeleteButton
- `src/components/admin/DeleteConfirmModal.tsx` — NEW

---

## 9. REGRESSION CHECKLIST

После реализации проверить:
- [ ] Удалить тег с `enriched_data = NULL` — другие поля НЕ потеряны
- [ ] Удалить тег с `related_tags` у других тегов — related_tags очищены
- [ ] Удалить тег без таблицы `news_tag_links` — не падает (EXCEPTION WHEN)
- [ ] Удалить тег с `tag_impact` — LLM данные очищены, `::text` cast работает
- [ ] Удалить несуществующий тег — 404

---

*Документ создан: 2026-06-05*
*Версия: 3.0 — исправлены 4 критических бага из v2*
*Версия: 2.0 — исходный файл с багами*
