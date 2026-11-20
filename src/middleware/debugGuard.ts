/**
 * =============================================================================
 * PULSE — Debug guard middleware (ТЗ-186, 2026-11-20)
 * =============================================================================
 *
 * ИБ-аудит 19.10.2026 (Medium): десятки /debug*-эндпоинтов без авторизации
 * «защищены» только Caddy-SPA-фолбэком — маскировка, а не защита: любое
 * будущее `handle /debug*` в Caddyfile мгновенно выставит их наружу
 * (прецедент: handle /debug/mcp из c960ac0).
 *
 * Решения (согласованы до старта, см. ТЗ-186):
 *  - единый guard на префикс /debug — защита по умолчанию для новых эндпоинтов;
 *  - публичность — только через явный allowlist из двух путей;
 *  - отказ — 404, не 403 (не подсвечивать существование эндпоинта);
 *  - fail-closed: без DEBUG_SECRET_KEY и CRON_SECRET_KEY всё под /debug* → 404;
 *  - в dev (NODE_ENV !== 'production') пропуск с warn — локальная диагностика.
 *
 * Публичные пути (причины):
 *  - /debug/mcp   — живость MCP-контура, нужен внешнему мониторингу (ТЗ-183,
 *                   ИБ-9; проксируется Caddy: handle /debug/mcp);
 *  - /debug/version — короткий хэш коммита; skip apiLimiter как health/monitoring.
 *
 * Внутренние вызывающие (инвентаризация ТЗ-186 Задача 0, 2026-11-20):
 *  внешних поллеров /debug* нет — VPS-cron, watchdog.sh, фронт чисты;
 *  rateLimit.ts:90 и rssFetcher.ts:64 лишь упоминают пути (skip/комментарий).
 *  Эндпоинты со своей проверкой ?secret= (/debug/verify-delete, /debug/check-fk,
 *  /migrate-mcp) продолжают работать: guard пропускает запрос с валидным
 *  x-debug-secret, их собственная логика проверяет query-secret как раньше.
 *
 * Секрет никогда не логируем и не возвращаем в теле ответа.
 */

import { Request, Response, NextFunction } from 'express';

const PUBLIC_DEBUG_PATHS = new Set(['/debug/mcp', '/debug/version']);

/** Эффективный секрет: новый DEBUG_SECRET_KEY, fallback — CRON_SECRET_KEY. */
function effectiveSecret(): string {
  return (process.env.DEBUG_SECRET_KEY || process.env.CRON_SECRET_KEY || '').trim();
}

/**
 * Чистая логика решения — вынесена для юнит-прогона без HTTP
 * (src/tests/debugGuard.test.ts). Решения: 'allow' | 'deny' | 'deny_no_secret'.
 */
export function debugGuardDecision(
  path: string,
  headerSecret: string | undefined,
  envSecret: string,
  isProduction: boolean
): 'allow' | 'deny' | 'deny_no_secret' {
  if (!path.startsWith('/debug')) return 'allow';
  if (PUBLIC_DEBUG_PATHS.has(path)) return 'allow';
  if (!envSecret) return 'deny_no_secret';
  if (headerSecret && headerSecret === envSecret) return 'allow';
  return 'deny';
}

let warnedDevBypass = false;
let warnedNoSecret = false;

export function debugGuard(req: Request, res: Response, next: NextFunction): void {
  const decision = debugGuardDecision(
    req.path || '',
    req.headers['x-debug-secret'] as string | undefined,
    effectiveSecret(),
    process.env.NODE_ENV === 'production'
  );

  if (decision === 'allow') return next();

  if (decision === 'deny_no_secret') {
    // Fail-closed: деплой без секрета — все защищаемые /debug* лежат (404).
    // Предупреждение на старте (не на каждый запрос) — деплой должен быть заметен.
    if (!warnedNoSecret) {
      warnedNoSecret = true;
      console.error(
        '[DebugGuard] FATAL: DEBUG_SECRET_KEY и CRON_SECRET_KEY не заданы — ' +
          'все /debug* эндпоинты отдают 404 (fail-closed, ТЗ-186). Пропишите секрет в .env.'
      );
    }
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // decision === 'deny' в dev-режиме — пропускаем с warn (локальная диагностика)
  if (process.env.NODE_ENV !== 'production') {
    if (!warnedDevBypass) {
      warnedDevBypass = true;
      console.warn(
        '[DebugGuard] dev-режим: запрос к защищённому /debug* без валидного x-debug-secret пропущен (ТЗ-186).'
      );
    }
    return next();
  }

  res.status(404).json({ error: 'Not found' });
  return;
}
