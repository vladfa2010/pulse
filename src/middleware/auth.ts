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
import { query } from '../config/db';
import { nowSql } from '../utils/nowSql';

const JWT_SECRET: string = process.env.JWT_SECRET!;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

// TZ-41: presence для админ-метрики «Сейчас онлайн». Любой авторизованный
// запрос обновляет last_connected_at, не чаще раза в минуту на юзера.
const USE_SQLITE = process.env.USE_SQLITE === 'true';
const lastPresenceWrite = new Map<string, number>();
const PRESENCE_THROTTLE_MS = 60 * 1000;

/**
 * Обновить presence юзера (fire-and-forget).
 * НИКОГДА не блокирует и не роняет основной запрос.
 */
function touchPresence(userId: string): void {
  const last = lastPresenceWrite.get(userId) || 0;
  if (Date.now() - last < PRESENCE_THROTTLE_MS) return;
  lastPresenceWrite.set(userId, Date.now());

  const p = USE_SQLITE
    ? query(
        `INSERT OR REPLACE INTO user_sessions (id, user_id, last_connected_at)
         VALUES ((SELECT id FROM user_sessions WHERE user_id = $1), $1, ${nowSql()})`,
        [userId, userId]
      )
    : query(
        `INSERT INTO user_sessions (user_id, last_connected_at)
         VALUES ($1, ${nowSql()})
         ON CONFLICT (user_id) DO UPDATE SET last_connected_at = ${nowSql()}`,
        [userId]
      );
  Promise.resolve(p).catch((e: any) => console.warn('[Presence] write failed:', e.message));
}

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
    // Извлекаем токен из заголовка Authorization или из query (?token=...) для SSE
    const authHeader = req.headers.authorization;
    const queryToken = typeof req.query?.token === 'string' ? req.query.token : undefined;

    const rawToken = authHeader ? authHeader.replace('Bearer ', '') : queryToken;
    if (!rawToken) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = rawToken;

    // Верифицируем токен (jwt.verify проверяет подпись и exp)
    // Если токен протух или подпись неверна → выбросит ошибку
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; email: string };

    // Сохраняем данные пользователя в req — роутер сможет использовать
    req.user = decoded;

    // TZ-41: presence (throttled, fire-and-forget)
    touchPresence(decoded.userId);

    // Пропускаем запрос дальше (к эндпоинту)
    next();
  } catch {
    // Любая ошибка верификации → 401
    res.status(401).json({ error: 'Invalid token' });
  }
}
