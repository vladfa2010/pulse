import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';

const router = Router();

// Middleware: check admin role (simple: check email domain or list)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').filter(Boolean);

function adminMiddleware(req: AuthRequest, res: any, next: any) {
  authMiddleware(req, res, () => {
    const email = req.user?.email;
    if (!email || !ADMIN_EMAILS.includes(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

// GET /api/admin/users — list all users
router.get('/users', adminMiddleware, async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, email, username, is_verified, subscription_active,
              subscription_expires_at, news_count, created_at
       FROM users ORDER BY created_at DESC LIMIT 500`
    );

    res.json({ users: result.rows });
  } catch (err) {
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
      'SELECT COUNT(*) FROM news WHERE created_at > NOW() - INTERVAL \'24 hours\''
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
