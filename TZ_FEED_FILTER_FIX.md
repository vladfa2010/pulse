# TZ: Fix NewsFeed фильтр по тегу

## Проблема

Клик на тег в Home → `/feed?tag=Сбербанк` → NewsFeed фильтрует по `a.tag === activeTag`.

- `activeTag` = `"Сбербанк"` (tag_name)
- `article.tag` = `"sberbank"` (matched_tags[0] = tag_id)
- `"sberbank" === "Сбербанк"` → **false → пустой результат**

## Причина

Фильтрация на фронте сравнивает разные поля (tag_id vs tag_name). К тому same — загружаются ВСЕ новости, фильтр на фронте неэффективен.

## Решение

| Режим | До | После |
|-------|-----|-------|
| Все новости | `GET /news?all=true` | `GET /news?all=true` (без изменений) |
| По тегу | фильтр на фронте (баг) | `GET /api/news/tags/{tagId}` (backend фильтр) |

## Изменения

### NewsFeed.tsx

1. `activeTag` → `activeTagId` (храним tag_id а не tag_name)
2. `activeTagName` — для отображения (UI)
3. `loadArticles()` — если `activeTagId` → `GET /api/news/tags/{tagId}`
4. Клик на тег — `setActiveTagId(tag.id)` + `setActiveTagName(tag.tag_name)`

## Критерии

- [ ] Клик на «Сбербанк» → показывает новости по sberbank
- [ ] Клик «Все» → показывает все новости
- [ ] TagEnrichment получает tag_name как раньше
- [ ] URL ?tag= поддерживается (читаем tag из URL)
