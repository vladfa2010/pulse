# EMAIL — заметки по email-подсистеме

Провайдер: Resend (`src/services/email.ts`). Конфиг через env: `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_FROM`.

## Захардкоженные ссылки

Ссылки ниже зашиты в коде шаблонов напрямую (не через `FRONTEND_URL`). При смене домена, slug курса или CDN фронтенда письма поведут на 404 — обновлять шаблоны вручную.

| Где | Ссылка | Комментарий |
|---|---|---|
| `sendWelcomeEmail` (ТЗ-142) | `https://pulse.inside-trade.ru/education/obuchenie-po-platforme-pulse-4d2c24ed` | Курс «Обучение по платформе PULSE». Две кнопки в письме: «Перейти к курсу» и «Как установить на iPhone». При смене slug курса — обновить обе. |

Иконки писем (`public/email/icon-*.png`) лежат в репозитории **frontend** — при смене домена/CDN фронтенда письма потеряют иконки.
