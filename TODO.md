# PULSE — TODO / Open Questions

> Задачи и архитектурные вопросы, требующие решения.
> Дата создания: 2026-05-30

## ✅ РЕШЁННЫЕ (c документацией)

- **[BUG: Reasoning pipeline пустой → 3 дня дебага](BUGFIX-reasoning.md)** — FIXED 2026-06-01
  - Root cause: `raw.replace(/\n/g, '\\n')` ломал валидный JSON от LLM
  - Фикс: защита `\\` → замена newline → восстановление `\\`
  - См. полный разбор в `BUGFIX-reasoning.md`

---

## ❌ ОТКРЫТЫЕ

---

## 🔴 related_entities в keywords — ложные срабатывания (важно)

**Дата:** 2026-05-30
**Статус:** ❌ Открыт
**Коммит:** c195bc7 (v7.10.4)

### Проблема

При backfill нового тега `related_entities` от LLM попадают в keywords.
Это вызывает ложные срабатывания — новости про другие компании получают тег.

**Пример — тег "Яндекс":**
```
related_entities: ["Mail.ru", "Sberbank", "VKontakte", "Tinkoff", "Megafon"]
→ keywords включают: "sberbank", "vkontakte", "mail.ru"...

Новость: "Сбербанк повысил ставки по вкладам"
→ text.includes("sberbank") → true
→ matched_tags добавляет "яндекс" ❌ ЛОЖНОЕ
```

**Эффект:** В карусели "Яндекс" показывались новости про Сбер, VK, Mail.ru.
Пользователь видел "все новости про Яндекс" — но не все были про Яндекс.

### Trade-off

| Подход | Плюс | Минус |
|--------|------|-------|
| **A. Убрать related_entities из keywords** | Чистый matching, нет ложных | Меньше перекрестных новостей ("Яндекс + Сбер партнерство") |
| **B. Word-boundary matching (`\bword\b`)** | Не ловит части слов | Не ловит "sberbank-инвестиции", теряет новости |
| **C. Two-pass matching** | Прямые = высокий confidence, related = низкий | Сложнее UI, нужен confidence score |
| **D. Оставить как есть** | Больше новостей | Ложные срабатывания, портит UX |

### Рекомендация

Вариант **A** — убрать `related_entities` из `buildEnrichedKeywords()`.
Оставить их только для отображения в UI ("связанные компании").
Прямые keywords (synonyms + products + base) достаточно для ~85-90% coverage.

### Где менять

```
tagManager.ts: buildEnrichedKeywords()
  → убрать строки 168-169 (related_entities)
  → оставить только synonyms + key_products + base + ticker
```

---

## 🟡 Тестовый тег "Яндекс" — удалить из prod БД

**Дата:** 2026-05-30
**Статус:** ❌ Открыт

При тестировании enrichment был создан тег "яндекс" (кириллица).
Он создал дубль существующего "yandex" (латиница).

**Нужно:** удалить `tag_id = "яндекс"` из `user_defined_tags` и `portfolios`.

---

## 🟡 Per-source RSS dedup — отложено (deadlock в v7.10)

**Дата:** 2026-05-28
**Статус:** ⏳ Отложено

Попытка добавить фильтр по `last_fetched_at` вызвала deadlock.
Сейчас работает: timezone normalization + `sourceMetaCache`.
Нужен правильный подход без блокировки DB внутри `processArticles`.

---

*Последнее обновление: 2026-05-30*
