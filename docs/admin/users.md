# Админка — таба «Пользователи»

## Выгрузка CSV (ТЗ-120, 2026-10-17)

`GET /api/admin/users/export` (`adminMiddleware`) — полная выгрузка базы
пользователей в CSV (`Content-Disposition: attachment`). Кнопка «Выгрузить
CSV» в табе «Пользователи» админки. Роут — `src/routes/admin.ts` рядом с
остальными users-роутами; middleware гарантирует, что выгрузку может сделать
только живой незаблокированный админ.

## is_blocked в adminMiddleware (ТЗ-120)

`src/middleware/admin.ts`: раньше `is_blocked` проверялся только при логине —
заблокированный админ с живым JWT (7 дней) сохранял доступ на всю неделю.
Теперь middleware читает `is_admin, is_blocked` из БД **на каждый запрос**
и отсекает `!isAdmin || isBlocked` (кросс-диалектно PG/sql.js).
