# PULSE Backend — План продолжения

## Статус: Базовая структура создана
- [x] package.json, tsconfig.json, .env.example
- [x] PostgreSQL schema (8 tables)
- [x] Auth routes (register, login, me)
- [x] News routes (GET /api/news, /api/news/tags/:tagId)
- [x] Payment routes (create, confirm, history)
- [x] RSS aggregator (32 sources, batch fetch, dedup)
- [x] Translation service (cache → Kimi → Google)
- [x] Cron job (15 min, tag matching, sentiment, cleanup)
- [x] Auth middleware (JWT)
- [x] DB init script

## Этап 1: Новые роуты (parallel)
- [ ] `src/routes/user.ts` — profile, tags CRUD, notification settings
- [ ] `src/routes/translate.ts` — POST /api/translate
- [ ] `src/routes/webhook.ts` — YuKassa webhooks
- [ ] `src/routes/admin.ts` — admin panel data

## Этап 2: Сервисы уведомлений (parallel)
- [ ] `src/services/telegram.ts` — Telegram bot
- [ ] `src/services/email.ts` — SendGrid email
- [ ] `src/services/reports.ts` — weekly report generation

## Этап 3: Интеграция
- [ ] Update `src/index.ts` — mount all new routes
- [ ] Dockerfile
- [ ] docker-compose.yml (PostgreSQL + Redis + backend)
- [ ] Git init + first commit
