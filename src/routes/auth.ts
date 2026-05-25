import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../config/db';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Simple UUID v4 generator
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, username, password } = req.body;

    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Email, username and password required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Check if email exists
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    // Insert user
    if (USE_SQLITE) {
      await query(
        `INSERT INTO users (id, email, username, password_hash, news_count)
         VALUES ($1, $2, $3, $4, 0)`,
        [userId, email, username, passwordHash]
      );
    } else {
      await query(
        `INSERT INTO users (id, email, username, password_hash, news_count)
         VALUES ($1, $2, $3, $4, 0)`,
        [userId, email, username, passwordHash]
      );
    }

    // Create default notification settings
    await query(
      `INSERT INTO notification_settings (user_id) VALUES ($1)`,
      [userId]
    );

    // Generate JWT
    const token = jwt.sign({ userId, email }, JWT_SECRET, {
      expiresIn: '7d',
    });

    res.status(201).json({
      token,
      user: {
        id: userId,
        email,
        username,
        is_admin: false,
      },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // Find user
    const result = await query(
      'SELECT id, email, username, password_hash, is_admin FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    // Check password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: '7d',
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        is_admin: user.is_admin === 1 || user.is_admin === true,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token' });
    }

    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

    const result = await query(
      'SELECT id, email, username, subscription_active, subscription_expires_at, news_count, is_admin FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    res.json({
      user: {
        ...user,
        is_admin: user.is_admin === 1 || user.is_admin === true,
      },
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// POST /api/auth/demo — create or login demo user
router.post('/demo', async (_req, res) => {
  try {
    const demoEmail = 'demo@pulse.ru';
    const demoUsername = 'Демо';
    const demoPassword = 'demo123';

    // Check if demo user exists
    let result = await query(
      'SELECT id, email, username FROM users WHERE email = $1',
      [demoEmail]
    );

    let userId: string;

    if (result.rows.length === 0) {
      // Create demo user
      userId = uuidv4();
      const passwordHash = await bcrypt.hash(demoPassword, 10);

      await query(
        `INSERT INTO users (id, email, username, password_hash, subscription_active, subscription_expires_at, news_count, is_admin)
         VALUES ($1, $2, $3, $4, 1, datetime('now', '+30 days'), 0, 0)`,
        [userId, demoEmail, demoUsername, passwordHash]
      );

      // Create default notification settings
      await query(
        `INSERT INTO notification_settings (user_id) VALUES ($1)`,
        [userId]
      );

      // Create demo portfolio (5 tags)
      const demoTags = [
        { id: 'sber', name: 'SBER', type: 'company' },
        { id: 'gazp', name: 'GAZP', type: 'company' },
        { id: 'tech', name: 'Технологии', type: 'sector' },
        { id: 'musk', name: 'Илон Маск', type: 'person' },
        { id: 'ai', name: 'AI', type: 'trend' },
      ];

      for (const tag of demoTags) {
        await query(
          `INSERT INTO portfolios (id, user_id, tag_id, tag_name, tag_type)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv4(), userId, tag.id, tag.name, tag.type]
        );
      }

      // Create demo payment
      await query(
        `INSERT INTO payments (id, user_id, amount, base_amount, discount, method, status, paid_at)
         VALUES ($1, $2, 490, 490, 0, 'card', 'completed', datetime('now'))`,
        [uuidv4(), userId]
      );

      console.log('[Auth] Demo user created:', userId);
    } else {
      userId = result.rows[0].id;
    }

    // Generate JWT
    const token = jwt.sign({ userId, email: demoEmail }, JWT_SECRET, {
      expiresIn: '7d',
    });

    res.json({
      token,
      user: {
        id: userId,
        email: demoEmail,
        username: demoUsername,
      },
    });
  } catch (err) {
    console.error('Demo login error:', err);
    res.status(500).json({ error: 'Demo login failed' });
  }
});

export default router;
