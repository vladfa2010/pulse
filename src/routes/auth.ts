/**
 * =============================================================================
 * PULSE — Auth Routes (Аутентификация)
 * =============================================================================
 *
 * Эндпоинты:
 *   POST /api/auth/register  — Регистрация нового пользователя
 *   POST /api/auth/login     — Вход (получение JWT токена)
 *   GET  /api/auth/me        — Проверка токена (кто я?)
 *   POST /api/auth/demo      — Демо-вход (без регистрации)
 *
 * JWT (JSON Web Token):
 *   - Токен подписывается секретом (JWT_SECRET)
 *   - Срок жизни: 7 дней
 *   - В payload: userId, email
 *   - Передаётся в заголовке: Authorization: Bearer <token>
 *
 * Пароли:
 *   - Хранятся как bcrypt hash (10 раундов)
 *   - НИКОГДА не хранятся в открытом виде
 */

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query } from '../config/db';
import { validate } from '../middleware/validate';
import { RegisterSchema, LoginSchema } from '../schemas/auth';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Генератор UUID v4 (уникальный идентификатор для каждой записи)
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/auth/register — Регистрация
// ═══════════════════════════════════════════════════════════════════════════
// Принимает: { email, username, password }
// Возвращает: { token, user: { id, email, username, is_admin } }
// Ошибки: 400 (неверные данные), 409 (email уже занят), 500 (внутренняя)
router.post('/register', validate(RegisterSchema), async (req, res) => {
  try {
    const { email, username, password } = req.body;

    // ─── Валидация ──────────────────────────────────────────────────────
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Email, username and password required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // ─── Проверяем, не занят ли email ───────────────────────────────────
    const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'На эту почту уже зарегистрирован аккаунт',
        code: 'EMAIL_EXISTS'
      });
    }

    // ─── Хешируем пароль (bcrypt, 10 раундов) ───────────────────────────
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = uuidv4();

    // ─── Создаём пользователя ───────────────────────────────────────────
    await query(
      `INSERT INTO users (id, email, username, password_hash, news_count)
       VALUES ($1, $2, $3, $4, 0)`,
      [userId, email, username, passwordHash]
    );

    // ─── Создаём настройки уведомлений по умолчанию ─────────────────────
    await query(
      `INSERT INTO notification_settings (user_id) VALUES ($1)`,
      [userId]
    );

    // ─── Генерируем JWT токен ───────────────────────────────────────────
    const token = jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      token,
      user: { id: userId, email, username, is_admin: false },
    });
  } catch (err: any) {
    console.error('[Auth] Register error:', err.message);
    res.status(500).json({ error: 'Registration failed', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/auth/login — Вход
// ═══════════════════════════════════════════════════════════════════════════
// Принимает: { email, password }
// Возвращает: { token, user: { id, email, username, is_admin } }
// Ошибки: 400 (нет данных), 404 (пользователь не найден), 401 (неверный пароль)
router.post('/login', validate(LoginSchema), async (req, res) => {
  try {
    const { email, password } = req.body;

    // ─── Валидация ──────────────────────────────────────────────────────
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    // ─── Ищем пользователя по email ─────────────────────────────────────
    const result = await query(
      'SELECT id, email, username, password_hash, is_admin FROM users WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Неправильный логин или пароль',
        code: 'USER_NOT_FOUND'
      });
    }

    const user = result.rows[0];

    // ─── Проверяем пароль (bcrypt.compare) ──────────────────────────────
    // bcrypt сравнивает plain-text пароль с хешем из БД
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({
        error: 'Неправильный логин или пароль',
        code: 'INVALID_PASSWORD'
      });
    }

    // ─── Генерируем JWT токен ───────────────────────────────────────────
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
  } catch (err: any) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/auth/me — Кто я? (проверка токена)
// ═══════════════════════════════════════════════════════════════════════════
// Заголовок: Authorization: Bearer <token>
// Возвращает: { user: { id, email, username, subscription_active, ... } }
// Ошибки: 401 (нет токена), 401 (токен невалиден), 404 (пользователь удалён)
router.get('/me', async (req, res) => {
  try {
    // Извлекаем токен из заголовка Authorization
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token' });
    }

    const token = authHeader.replace('Bearer ', '');

    // Верифицируем токен (проверяем подпись и срок действия)
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

    // Загружаем пользователя из БД
    const result = await query(
      `SELECT id, email, username, subscription_active, subscription_expires_at,
              news_count, is_admin FROM users WHERE id = $1`,
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

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/auth/demo — Демо-вход (без регистрации)
// ═══════════════════════════════════════════════════════════════════════════
// Создаёт демо-пользователя demo@pulse.ru если его ещё нет
// Возвращает: { token, user }
router.post('/demo', async (_req, res) => {
  try {
    const demoEmail = 'demo@pulse.ru';
    const demoUsername = 'Демо';
    const demoPassword = 'demo123';

    // Проверяем, существует ли демо-пользователь
    let result = await query(
      'SELECT id, email, username FROM users WHERE email = $1',
      [demoEmail]
    );

    let userId: string;

    if (result.rows.length === 0) {
      // ─── Создаём демо-пользователя ──────────────────────────────────
      userId = uuidv4();
      const passwordHash = await bcrypt.hash(demoPassword, 10);
      await query(
        `INSERT INTO users (id, email, username, password_hash, subscription_active,
                           subscription_expires_at, news_count, is_admin)
         VALUES ($1, $2, $3, $4, 1, datetime('now', '+30 days'), 0, 0)`,
        [userId, demoEmail, demoUsername, passwordHash]
      );
      // Создаём демо-портфель (5 тегов)
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
    } else {
      userId = result.rows[0].id;
    }

    // ─── Генерируем JWT токен ───────────────────────────────────────────
    const token = jwt.sign({ userId, email: demoEmail }, JWT_SECRET, {
      expiresIn: '7d',
    });

    res.json({
      token,
      user: { id: userId, email: demoEmail, username: demoUsername },
    });
  } catch (err: any) {
    console.error('Demo login error:', err);
    res.status(500).json({ error: 'Demo login failed' });
  }
});

export default router;
