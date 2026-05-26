/**
 * =============================================================================
 * PULSE — Auth Middleware (Проверка JWT токена)
 * =============================================================================
 *
 * Этот middleware защищает API эндпоинты.
 * Проверяет JWT токен из заголовка Authorization.
 *
 * Использование в роутерах:
 *   router.get('/profile', authMiddleware, async (req: AuthRequest, res) => {
 *     const userId = req.user!.userId;  // ← Доступно после проверки токена
 *   });
 *
 * Заголовок от клиента:
 *   Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
 *
 * Если токен невалиден → 401 Unauthorized (эндпоинт не вызывается)
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

// ─── Расширяем Request — добавляем поле user ──────────────────────────────
// После проверки токена req.user содержит { userId, email }
export interface AuthRequest extends Request {
  user?: { userId: string; email: string };
}

/**
 * authMiddleware — проверяет JWT токен
 *
 * Логика:
 *   1. Извлекает токен из заголовка Authorization: Bearer <token>
 *   2. Верифицирует токен (проверяет подпись и срок действия)
 *   3. Если валиден → добавляет req.user и вызывает next() (эндпоинт выполняется)
 *   4. Если невалиден → возвращает 401 (эндпоинт НЕ выполняется)
 */
export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    // Извлекаем заголовок Authorization
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Убираем префикс "Bearer " — получаем чистый токен
    const token = authHeader.replace('Bearer ', '');

    // Верифицируем токен (jwt.verify проверяет подпись и exp)
    // Если токен протух или подпись неверна → выбросит ошибку
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };

    // Сохраняем данные пользователя в req — роутер сможет использовать
    req.user = decoded;

    // Пропускаем запрос дальше (к эндпоинту)
    next();
  } catch {
    // Любая ошибка верификации → 401
    res.status(401).json({ error: 'Invalid token' });
  }
}
