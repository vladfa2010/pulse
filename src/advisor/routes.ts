/**
 * =============================================================================
 * PULSE — Advisor module: роутер (ТЗ-182 Задача 2)
 * =============================================================================
 *
 * Смонтирован в src/index.ts:
 *   app.use('/api/advisor', authMiddleware, requireFeature('multi_portfolio'), advisorRoutes)
 *
 * Без энтитлмента multi_portfolio любой эндпоинт модуля → 403
 * (семантика requireFeature, services/subscription.ts).
 *
 *   /clients             — CRUD клиентов и тегов (Задача 3) + лента новостей
 *                          клиента (Задача 8, backend-часть)
 *   /summaries           — саммари клиентов: read-only/refresh/schedule (Задача 6)
 *   /events              — агрегированные события календаря (Задача 7)
 */

import { Router } from 'express';
import clientsRouter from './clients';
import summariesRouter from './summaries';
import eventsRouter from './events';

const router = Router();

router.use('/clients', clientsRouter);
router.use('/summaries', summariesRouter);
router.use('/events', eventsRouter);

export default router;
