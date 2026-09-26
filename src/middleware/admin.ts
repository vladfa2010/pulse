/**
 * =============================================================================
 * PULSE — Admin middleware (ТЗ-66-lite, 2026-09-26)
 * =============================================================================
 *
 * Проверка прав администратора: поверх authMiddleware дёргает is_admin из БД
 * (SQLite/Postgres-совместимо). Раньше жил в routes/admin.ts — перенесён
 * сюда, чтобы роуты админки (routes/adminRadioCache.ts и далее) могли
 * импортировать middleware без подтягивания всего роутера admin.
 *
 * Re-export из routes/admin.ts сохранён — старые импорты не ломаются.
 */

import { authMiddleware, AuthRequest } from './auth';
import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Middleware: check is_admin flag in database
export function adminMiddleware(req: AuthRequest, res: any, next: any) {
  authMiddleware(req, res, async () => {
    try {
      const userId = req.user?.userId;
      if (!userId) {
        return res.status(401).json({ error: 'Authentication required' });
      }

      const result = await query(
        'SELECT is_admin FROM users WHERE id = $1',
        [userId]
      );

      const isAdmin = USE_SQLITE
        ? (result.rows[0]?.is_admin === 1)
        : (result.rows[0]?.is_admin === true);

      if (!isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }

      next();
    } catch {
      res.status(500).json({ error: 'Admin check failed' });
    }
  });
}
