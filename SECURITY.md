# Политика безопасности backend PULSE

Этот документ описывает правила работы с секретами для backend-части PULSE.

---

## Что считается секретом

Никогда не коммитьте в git и не публикуйте в открытом доступе:

- `TELEGRAM_BOT_TOKEN`
- `JWT_SECRET`
- `DB_PASSWORD`
- `FIREBASE_SERVICE_ACCOUNT_BASE64`
- `YOOKASSA_SECRET_KEY`
- `RESEND_API_KEY`, `YANDEX_PASS`
- `TRANSLATION_API_KEY`
- API-токены и приватные ключи
- `.env`-файлы

## Где хранить секреты

### Локально

В файле `pulse-backend/.env` (добавлен в `.gitignore`).

Используйте `.env.example` только как шаблон с плейсхолдерами (`your_...`), без реальных значений.

### Production / Render

Все секреты передаются через **Environment Variables** сервиса `pulse-api`:

```
TELEGRAM_BOT_TOKEN=
JWT_SECRET=
DB_PASSWORD=
FIREBASE_SERVICE_ACCOUNT_BASE64=
YOOKASSA_SECRET_KEY=
RESEND_API_KEY=
```

### CI/CD

Если добавите GitHub Actions для backend, используйте **GitHub Repository Secrets** (`secrets.*`), а не plaintext в workflow.

---

## Firebase service account

- Локальный JSON-файл service account (`firebase-adminsdk-*.json`) не должен лежать в репозитории.
- На Render используется base64-кодированное содержимое JSON в переменной `FIREBASE_SERVICE_ACCOUNT_BASE64`.
- Если ключ мог быть скомпрометирован — удалите его в Firebase Console и создайте новый.

---

## Что делать при утечке

1. Отзовите скомпрометированный токен/ключ в сервисе-поставщике.
2. Сгенерируйте новый.
3. Обновите:
   - локальный `.env`;
   - Environment Variables на Render;
   - GitHub Secrets, если используются.
4. Перезапустите деплой backend.
5. Проверьте логи.

---

## Общая политика проекта

См. [`../pulse-frontend/SECURITY.md`](../pulse-frontend/SECURITY.md).
