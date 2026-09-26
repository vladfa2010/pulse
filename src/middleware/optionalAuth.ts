/**
 * =============================================================================
 * PULSE — Опциональная авторизация (ТЗ-64)
 * =============================================================================
 *
 * Пропускает запрос в любом случае. Если токен есть и валиден — заполняет
 * req.user (и presence). Если токена нет или он битый — req.user остаётся
 * undefined, обработчик работает в гостевом режиме.
 *
 * Контраст с authMiddleware (строгий): здесь НЕ бросаем 401 на битый токен —
 * юзер с протухшей сессией на гостевых роутах должен работать как гость.
 *
 * Извлечение токена — общий хелпер extractToken из auth.ts (не дублируем).
 *
 * Используется на:
 *   /api/radio/tts          (rate limit по userId || IP)
 *   /api/radio/config
 *   /api/market/market-dialog
 */

import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { AuthRequest, extractToken } from './auth';

const JWT_SECRET: string = process.env.JWT_SECRET!;

export function optionalAuth(req: AuthRequest, _res: Response, next: NextFunction): void {
  const raw = extractToken(req);
  if (!raw) {
    next();
    return;
  }
  try {
    req.user = jwt.verify(raw, JWT_SECRET) as { userId: string; email: string };
  } catch {
    // Битый/протухший токен — молча пропускаем как гостя.
    // НЕ 401: контракт optionalAuth — «может быть юзер, может быть гость».
  }
  next();
}
