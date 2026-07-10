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
// 15 попыток за 15 минут на IP
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 минут
  max: 15,                      // 15 попыток
  message: {
    error: 'Слишком много попыток. Попробуйте через 15 минут.',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,   // X-RateLimit-*
  legacyHeaders: false,    // Отключаем X-Rate-Limit-*
  keyGenerator: (req) => req.ip || 'unknown',
  validate: { trustProxy: false },
  skip: (req) => {
    // У этих путей свои лимитеры, /me — обычный авторизованный GET
    const path = req.path || '';
    return ['/forgot-password', '/verify-code', '/reset-password', '/me'].includes(path);
  },
});

// ─── Forgot password — защита от спама по email ───────────────────────────
// 3 запроса в час на email
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 час
  max: 3,                     // 3 запроса в час
  message: {
    error: 'Слишком много попыток восстановления. Попробуйте через час.',
    retryAfter: '1 hour',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.body?.email || req.ip || 'unknown',
  validate: { trustProxy: false },
});

// ─── Password reset flow (verify-code / reset-password) ───────────────────
// 10 попыток за 15 минут на IP
export const passwordResetFlowLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 минут
  max: 10,                    // 10 попыток — flow из 3-4 запросов
  message: {
    error: 'Слишком много попыток. Попробуйте через 15 минут.',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  validate: { trustProxy: false },
});

// ─── API endpoints — стандартный лимит ────────────────────────────────────
// 300 запросов за 15 минут на IP
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 минут
  max: 300,                     // 300 запросов
  message: {
    error: 'Слишком много запросов. Попробуйте позже.',
    retryAfter: '15 minutes',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    const path = req.path || '';
    // Health check для Render мониторинга
    if (path === '/health') return true;
    // SSE-потоки — у них долгоживущие соединения
    if (path === '/api/news/stream' || path === '/api/sentiment/stream') return true;
    // Webhook'и имеют свой собственный лимитер
    if (path.startsWith('/api/webhook/')) return true;
    // Статус-страница и debug
    if (path === '/' || path === '/debug/version') return true;
    return false;
  },
  validate: { trustProxy: false },
});

// ─── Webhook endpoints — высокий лимит ────────────────────────────────────
// YuKassa может слать много запросов
export const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,  // 1 минута
  max: 180,                    // 180 запросов
  message: {
    error: 'Webhook rate limit exceeded',
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});
