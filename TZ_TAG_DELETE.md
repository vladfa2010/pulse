# TZ: Tag Deletion — Admin TagDetailModal

> **ID:** TZ_TAG_DELETE
> **Дата:** 2026-06-05
> **Статус:** Ready for implementation
> **Связано с:** TZ_INLINE_TAG_EDIT_v2, INCIDENTS.md

---

## 1. ЦЕЛЬ

Дать администратору возможность безопасно удалить тег из системы с полной очисткой всех связей. Никаких висячих ссылок.

---

## 2. ПРИНЦИПЫ

| Принцип | Реализация |
|---------|-----------|
| **Hard delete** | Полное удаление, не soft delete. Данные не восстанавливаются. |
| **Все связи очищены** | Тег удаляется из ВСЕХ таблиц где есть ссылки. |
| **Транзакция** | Всё или ничего — `BEGIN ... COMMIT/ROLLBACK`. |
| **Подтверждение** | Два шага: кнопка "Delete" → модал "Confirm" → удаление. |
| **Предпросмотр** | Показываем что будет удалено (N статей, M подписок). |

---

## 3. ГДЕ ТЕГ ССЫЛАЕТСЯ (полный аудит)

| # | Таблица | Поле | Что хранит | Что делаем |
|---|---------|------|-----------|------------|
| 1 | `user_defined_tags` | `tag_id` PK | Сам тег | **DELETE** — последним шагом |
| 2 | `news_tag_links` | `tag_id` FK | Связи тег ↔ статья | **DELETE** все записи с tag_id |
| 3 | `notification_settings` | `tag_id` FK | Подписки юзеров | **DELETE** все подписки на tag_id |
| 4 | `news` | `matched_tags` (text[]) | Теги в статье | **array_remove()** — убрать tag_id из массива |
| 5 | `news` | `tag_impact` (jsonb) | LLM результаты | **jsonb фильтр** — убрать объекты где `tag == tag_id` |

---

## 4. SQL — ТРАНЗАКЦИЯ УДАЛЕНИЯ

```sql
-- TZ_TAG_DELETE: полное удаление тега с очисткой связей
-- Выполняется в одной транзакции: всё или ничего

CREATE OR REPLACE FUNCTION delete_tag_cascade(tag_id_param VARCHAR)
RETURNS TABLE (
  deleted_links INTEGER,
  deleted_subscriptions INTEGER,
  cleaned_articles_matched INTEGER,
  cleaned_articles_llm INTEGER
) AS $$
DECLARE
  v_deleted_links INTEGER := 0;
  v_deleted_subs INTEGER := 0;
  v_cleaned_matched INTEGER := 0;
  v_cleaned_llm INTEGER := 0;
BEGIN
  -- 1. Удалить связи со статьями (news_tag_links)
  DELETE FROM news_tag_links WHERE tag_id = tag_id_param;
  GET DIAGNOSTICS v_deleted_links = ROW_COUNT;

  -- 2. Удалить подписки юзеров (notification_settings)
  DELETE FROM notification_settings WHERE tag_id = tag_id_param;
  GET DIAGNOSTICS v_deleted_subs = ROW_COUNT;

  -- 3. Убрать из matched_tags (text[] array)
  UPDATE news 
  SET matched_tags = array_remove(matched_tags, tag_id_param)
  WHERE tag_id_param = ANY(matched_tags);
  GET DIAGNOSTICS v_cleaned_matched = ROW_COUNT;

  -- 4. Убрать из tag_impact JSONB (LLM результаты)
  -- Безопасно: фильтруем jsonb_array_elements
  UPDATE news
  SET tag_impact = COALESCE(
    (SELECT jsonb_agg(elem) 
     FROM jsonb_array_elements(tag_impact) elem 
     WHERE elem->>'tag' != tag_id_param),
    '[]'::jsonb
  )
  WHERE tag_impact @> jsonb_build_object('tag', tag_id_param);
  GET DIAGNOSTICS v_cleaned_llm = ROW_COUNT;

  -- 5. Удалить сам тег (последним!)
  DELETE FROM user_defined_tags WHERE tag_id = tag_id_param;

  -- Вернуть статистику
  RETURN QUERY SELECT v_deleted_links, v_deleted_subs, v_cleaned_matched, v_cleaned_llm;
END;
$$ LANGUAGE plpgsql;
```

---

## 5. API SPECIFICATION

### 5.1 DELETE /admin/tags/:tagId

```
DELETE /admin/tags/:tagId
Authorization: Bearer <ADMIN_JWT>
```

**Response 200:**
```json
{
  "success": true,
  "deleted_tag": "илон-маск",
  "stats": {
    "deleted_links": 45,
    "deleted_subscriptions": 12,
    "cleaned_articles_matched": 38,
    "cleaned_articles_llm": 15
  }
}
```

**Response 403:** Не админ.  
**Response 404:** Тег не найден.  
**Response 500:** Ошибка транзакции (ROLLBACK выполнен).

### 5.2 GET /admin/tags/:tagId/delete-preview

```
GET /admin/tags/:tagId/delete-preview
Authorization: Bearer <ADMIN_JWT>
```

**Response 200:**
```json
{
  "tag_id": "илон-маск",
  "tag_name": "Илон Маск",
  "links_count": 45,
  "subscriptions_count": 12,
  "matched_articles_count": 38,
  "llm_articles_count": 15
}
```

---

## 6. UI SPECIFICATION

### 6.1 Кнопка Delete (внизу карточки тега)

```
┌─────────────────────────────────────┐
│                                     │
│  [Последняя секция карточки]       │
│                                     │
│  ─────────────────────────────────  │
│                                     │
│  [🗑 Delete Tag]                    │  ← красная кнопка
│                                     │
└─────────────────────────────────────┘
```

**Стиль кнопки:**
- Цвет: `#EF4444` (красный)
- Фон: `#111111`
- Рамка: `#EF4444` 1px
- Hover: фон `#EF444411`

### 6.2 Модальное окно Confirm Delete

```
┌─────────────────────────────────────┐
│  ⚠️ Delete Tag                      │  ← заголовок
│                                     │
│  Delete "Илон Маск"?               │  ← название тега
│                                     │
│  This action will permanently       │
│  remove:                            │
│                                     │
│  • 45 article links                 │  ← из preview API
│  • 12 user subscriptions            │
│  • 38 articles (matched_tags)       │
│  • 15 articles (LLM references)     │
│                                     │
│  This action is IRREVERSIBLE.       │  ← красный текст
│                                     │
│  [Cancel]        [Delete Forever]   │
│                                     │
│  Delete Forever:                    │
│  ┌─────────────────────────────┐   │
│  │ Type tag name to confirm    │   │  ← safety input
│  │ илон-маск                   │   │
│  └─────────────────────────────┘   │
│                                     │
└─────────────────────────────────────┘
```

**Safety input:** Поле ввода — нужно напечатать `tag_id` для активации кнопки "Delete Forever". Предотвращает случайное удаление.

**Стиль модалки:**
- Фон: `#111111`
- Рамка: `#EF4444` 1px
- Заголовок: белый, ⚠️ иконка
- Предупреждение: `#EF4444`
- Кнопка Cancel: серая
- Кнопка Delete Forever: красная, disabled пока safety input не совпадает

### 6.3 После удаления

- Модалка закрывается
- TagDetailModal закрывается
- TagsTab обновляется (тег исчезает из списка)
- Toast: `Tag "Илон Маск" deleted. 45 links, 12 subscriptions removed.`

---

## 7. FRONTEND IMPLEMENTATION

### 7.1 Компоненты

| Компонент | Файл | Описание |
|-----------|------|----------|
| `DeleteTagButton` | в TagDetailModal | Красная кнопка внизу карточки |
| `DeleteConfirmModal` | новый файл | Модал подтверждения с preview + safety input |

### 7.2 State flow

```
[TagDetailModal]
    ↓ click "Delete Tag"
[DeleteConfirmModal] ← загружаем preview (N статей, M подписок)
    ↓ type tag_id в safety input
[Delete Forever] ← активируется при совпадении
    ↓ click
[DELETE /admin/tags/:tagId]
    ↓ success
[Close all modals] + [Refresh TagsTab] + [Toast]
```

### 7.3 API client

```typescript
// src/lib/api.ts
adminApi.delete: (path: string) => Promise<any>
```

---

## 8. ERROR HANDLING

| Сценарий | Frontend | Backend |
|----------|----------|---------|
| Тег не найден | — | 404 |
| Не админ | Редирект на / | 403 |
| Ошибка транзакции | "Delete failed, no changes made" | 500 + ROLLBACK |
| Safety input не совпадает | Кнопка disabled | — |
| Preview API недоступен | Показываем "unknown" counts | 500 |

---

## 9. ESTIMATION

| Этап | Время |
|------|-------|
| SQL функция delete_tag_cascade | 20 мин |
| DELETE endpoint + preview endpoint | 20 мин |
| Frontend: DeleteConfirmModal | 30 мин |
| Frontend: интеграция в TagDetailModal | 10 мин |
| Testing | 10 мин |
| **Total** | **~1.5 часа** |

---

## 10. FILES TOUCHED

### Backend
- `src/index.ts` — +2 endpoints, +SQL function

### Frontend
- `src/pages/admin/TagDetailModal.tsx` — +DeleteButton
- `src/components/admin/DeleteConfirmModal.tsx` — NEW
- `src/lib/api.ts` — +adminApi.delete

---

*Документ создан: 2026-06-05*
*Версия: 1.0*
