# PULSE — TODO / Open Questions

> Задачи и архитектурные вопросы, требующие решения.
> Дата создания: 2026-05-30

## ✅ РЕШЁННЫЕ (c документацией)

- **[Бэкапы — внешняя копия в S3 (ТЗ-152)]** — DONE 2026-10-10
  - Ночной дамп + файлы + `.env` выгружаются в S3-бакет хостера
    (`s3://0fa1c3a824ae-pulses3/pulse/`), cron `15 3 * * *`, lifecycle 30 дней.
  - Скрипты: `scripts/backup/backup-nightly.sh` (в git + sha256),
    `scripts/backup/s3-upload-backup.sh`; квартальная проверка —
    `S3_CHECK=1 bash scripts/maintenance/test-restore.sh`.
  - См. DEPLOYMENT.md, раздел «Внешняя копия в S3». Коммит `876bf8c`.

- **[BUG: Reasoning pipeline пустой → 3 дня дебага](BUGFIX-reasoning.md)** — FIXED 2026-06-01
  - Root cause: `raw.replace(/\n/g, '\\n')` ломал валидный JSON от LLM
  - Фикс: защита `\\` → замена newline → восстановление `\\`
  - См. полный разбор в `BUGFIX-reasoning.md`

---

## ❌ ОТКРЫТЫЕ

---

## 🔒 ТЗ-188 донастройка: CSP enforce (Задачи 3–4)

**Дата постановки:** 2026-11-20 · **Статус:** ⏸ Отложено решением владельца
**Готовность к работе:** после ручного прогона ключевых сценариев владельцем

### Что уже сделано (не откатывать)

Фаза 1 включена 20.11.2026 (`fc31fb1`): четыре базовых заголовка
(`nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`)
+ `Content-Security-Policy-Report-Only` в `(common)` Caddyfile. Они уже
работают в проде и дают основной ИБ-выигрыш (clickjacking, MIME-sniffing,
утечка referrer). Report-only **ничего не блокирует** — продукт неизменен.

### Что осталось (Задача 3 — enforce)

Переименовать `Content-Security-Policy-Report-Only` → `Content-Security-Policy`
(финальный текст — в SECURITY.md, раздел «Безопасные заголовки») отдельным
revert-able коммитом, затем Задача 4 (приёмочная матрица + securityheaders.com,
цель A).

### Почему отложено

1. **По ТЗ нужна выдержка 3–7 дней** report-only, чтобы поймать неучтённые
   источники. У нас нет report-uri — нарушения видны только в консоли браузера
   пользователя, серверные логи их не содержат.
2. **Риск enforce без ручной проверки:** CSP сломает легитимные сценарии,
   если инвентаризация (20.11) что-то пропустила: плееры уроков
   (youtube-nocookie/rutube/vkvideo/vimeo через iframe), Telegram Login Widget
   (script + iframe oauth.telegram.org), Яндекс.Метрика (script + connect).
3. **Триггер к работе:** владелец прогоняет с открытой консолью 4 сценария
   (логин вкл. TG-виджет, урок с видео, лента/SSE-графики, страница курса
   с обложкой) и подтверждает «чисто» → включаем enforce без ожидания.
   Либо ждём 25–27.11 (выдержка) и делаем штатно.

### Файлы

`pulse-backend/deploy/Caddyfile` (переименование одной директивы),
`SECURITY.md` (дата enforce), док — `../ТЗ-188-security-заголовки-основного-домена_2026-10-19.md`.

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
