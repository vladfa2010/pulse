/**
 * =============================================================================
 * PULSE — Rate Limiting
 * =============================================================================
 *
 * Task 4: Защита API от DDoS и спама.
 * Разные лимиты для разных endpoint:
 *   - Auth (логин/регистрация): строгий лимит — защита от брутфорса
 *   - API (общие): стандартный лимит
 *   - Webhook (YuKassa): высокий лимит — YuKassa шлёт много запросов
 */

import rateLimit from 'express-rate-limit';

// ─── Auth endpoints — защита от брутфорса ─────────────────────────────────
// 5 попыток за 15 минут на IP
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 минут
  max: 5,                       // 5 попыток
  message: {
    error: 'Слишком много попыток. Попробуйте через 15 минут.',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,   // X-RateLimit-*
  legacyHeaders: false,    // Отключаем X-Rate-Limit-*
  keyGenerator: (req) => req.ip || 'unknown',
});

// ─── API endpoints — стандартный лимит ────────────────────────────────────
// 100 запросов за 15 минут на IP
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 минут
  max: 100,                     // 100 запросов
  message: {
    error: 'Слишком много запросов. Попробуйте позже.',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Пропускаем health check (Render мониторинг)
    return req.path === '/health';
  },
});

// ─── Webhook endpoints — высокий лимит ────────────────────────────────────
// YuKassa может слать много запросов
export const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 минута
  max: 60,                     // 60 запросов
  message: {
    error: 'Webhook rate limit exceeded',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
