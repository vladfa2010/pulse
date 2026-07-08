import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Middleware: check is_admin flag in database
function adminMiddleware(req: AuthRequest, res: any, next: any) {
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

// GET /api/admin/users — list all users with payment totals
router.get('/users', adminMiddleware, async (_req, res) => {
  try {
    const sql = USE_SQLITE
      ? `SELECT 
           u.id, u.email, u.username, u.is_verified, u.is_admin,
           u.subscription_active, u.subscription_expires_at,
           u.news_count, u.created_at,
           COALESCE(p.total_payments, 0) as total_payments,
           COALESCE(p.total_amount, 0) as total_amount
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*) as total_payments,
                  COALESCE(SUM(amount), 0) as total_amount
           FROM payments
           WHERE status = 'completed'
           GROUP BY user_id
         ) p ON p.user_id = u.id
         ORDER BY u.created_at DESC LIMIT 500`
      : `SELECT 
           u.id, u.email, u.username, u.is_verified, u.is_admin,
           u.subscription_active, u.subscription_expires_at,
           u.news_count, u.created_at,
           COALESCE(p.total_payments, 0)::int as total_payments,
           COALESCE(p.total_amount, 0)::float as total_amount
         FROM users u
         LEFT JOIN (
           SELECT user_id,
                  COUNT(*)::int as total_payments,
                  COALESCE(SUM(amount), 0)::float as total_amount
           FROM payments
           WHERE status = 'completed'
           GROUP BY user_id
         ) p ON p.user_id = u.id
         ORDER BY u.created_at DESC LIMIT 500`;

    const result = await query(sql);

    const users = result.rows.map((row: any) => ({
      ...row,
      total_payments: Number(row.total_payments ?? 0),
      total_amount: Number(row.total_amount ?? 0),
    }));

    res.json({ users });
  } catch (err) {
    console.error('[Admin] Failed to fetch users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/admin/stats — dashboard stats
router.get('/stats', adminMiddleware, async (_req, res) => {
  try {
    const usersResult = await query('SELECT COUNT(*) FROM users');
    const premiumResult = await query(
      'SELECT COUNT(*) FROM users WHERE subscription_active = TRUE'
    );
    const newsResult = await query('SELECT COUNT(*) FROM news');
    const news24hResult = await query(
      USE_SQLITE
        ? "SELECT COUNT(*) FROM news WHERE created_at > datetime('now', '-24 hours')"
        : "SELECT COUNT(*) FROM news WHERE created_at > NOW() - INTERVAL '24 hours'"
    );
    const paymentsResult = await query(
      'SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE status = \'completed\''
    );

    res.json({
      users: parseInt(usersResult.rows[0].count),
      premiumUsers: parseInt(premiumResult.rows[0].count),
      totalNews: parseInt(newsResult.rows[0].count),
      newsLast24h: parseInt(news24hResult.rows[0].count),
      totalRevenue: parseFloat(paymentsResult.rows[0].total),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

export default router;
