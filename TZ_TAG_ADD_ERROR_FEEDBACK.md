# TZ — Обратная связь при ошибке добавления тега

## Проблема

При добавлении тега `addTag()` в `useAuth.tsx` глотает все ошибки через `catch { return false }`. Пользователь кликает «+», видит спиннер — и тишину. Не понятно: это лимит, дубль, или баг.

## Сценарий воспроизведения

1. Бесплатный пользователь добавляет 3 тега (лимит)
2. Кликает «+» на 4-м теге
3. Бэкенд отвечает `403 Tag limit reached`
4. Фронт: `catch { return false }` → никакого UI-ответа

**Текущее поведение:** спиннер пропал, тег не добавился, пользователь в недоумении.

**Ожидаемое:** красный toast/баннер — «Достигнут лимит тегов. Обновитесь до Premium».

## Решение

Минимум: два файла, три изменения.

### 1. useAuth.tsx — addTag() возвращает ошибку

```typescript
const addTag = useCallback(async (tag: { tagId: string; tagName: string; tagType: string }) => {
  try {
    const data = await api.post('/user/tags', tag)
    if (data.tag) {
      setPortfolio(prev => [...prev, data.tag])
      setTagVersion(v => v + 1)
      return { success: true }
    }
    return { success: false, error: 'Unknown error' }
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Failed to add tag',
    }
  }
}, [])
```

Тип интерфейса:
```typescript
addTag: (tag: { tagId: string; tagName: string; tagType: string }) => Promise<{ success: boolean; error?: string }>
```

### 2. Home.tsx — показать ошибку пользователю

В `handleAddTag()`:
```typescript
const result = await addTag({ tagId: s.id, tagName: s.label, tagType: s.type })
if (result.success) {
  // ...текущая логика успеха
} else {
  // Показать toast с ошибкой
  toast?.error?.(result.error) || console.error(result.error)
}
```

Аналогично в `handleCreateCustomTag()`.

**Toast:** если в проекте нет toast-библиотеки — использовать `alert()` или inline-ошибку под поиском. **Не** добавлять новую зависимость ради одного toast.

## Критерии приёмки

- [ ] Пользователь с 3 тегами кликает «+» → видит сообщение о лимите
- [ ] Пользователь добавляет существующий тег → видит сообщение о дубле
- [ ] Успешное добавление работает как раньше (зелёная анимация)
- [ ] Нет новых зависимостей
- [ ] Изменения только в `useAuth.tsx` и `Home.tsx`

## Связь

- Бэкенд уже возвращает `403` (лимит) и `409` (дубль) — ничего не менять
- Дедупликация по содержимому (TZ_TAG_DEDUPLICATION) — отдельная задача
