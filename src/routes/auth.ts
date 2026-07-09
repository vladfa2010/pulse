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
import {
  RegisterSchema, LoginSchema,
  ForgotPasswordSchema, VerifyCodeSchema, ResetPasswordSchema,
} from '../schemas/auth';
import { buildSubscriptionStatus } from '../services/subscription';
import { sendPasswordResetCodeEmail, sendWelcomeEmail } from '../services/email';
import { sendTelegramMessage } from '../services/telegram';

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

    // ─── Проверяем, не занят ли email (case-insensitive) ────────────────
    const existing = await query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
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

    // ─── Отправляем welcome-письмо (не блокируем ответ) ─────────────────
    sendWelcomeEmail(email, username).catch((err: any) => {
      console.error('[Auth] Welcome email failed:', err.message);
    });

    // ─── Генерируем JWT токен ───────────────────────────────────────────
    const token = jwt.sign({ userId, email, is_admin: false }, JWT_SECRET, { expiresIn: '7d' });

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

    // ─── Ищем пользователя по email (case-insensitive) ──────────────────
    const result = await query(
      `SELECT id, email, username, password_hash, is_admin, subscription_active, subscription_plan,
              subscription_expires_at, subscription_auto_renew, scheduled_plan_downgrade
       FROM users WHERE LOWER(email) = LOWER($1)`,
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
    const isAdmin = user.is_admin === 1 || user.is_admin === true;
    const token = jwt.sign({ userId: user.id, email: user.email, is_admin: isAdmin }, JWT_SECRET, {
      expiresIn: '7d',
    });

    const subStatus = buildSubscriptionStatus({
      plan: user.subscription_plan || 'free',
      active: !!user.subscription_active,
      expiresAt: user.subscription_expires_at ? new Date(user.subscription_expires_at) : null,
      autoRenew: !!user.subscription_auto_renew,
      scheduledDowngrade: user.scheduled_plan_downgrade || null,
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        is_admin: user.is_admin === 1 || user.is_admin === true,
        subscription: subStatus,
      },
    });
  } catch (err: any) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Login failed', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/auth/forgot-password — Запрос кода восстановления
// ═══════════════════════════════════════════════════════════════════════════
router.post('/forgot-password', validate(ForgotPasswordSchema), async (req, res) => {
  try {
    const { email } = req.body;

    const userResult = await query(
      `SELECT id, email, username FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );

    // Не раскрываем, существует ли email
    if (userResult.rows.length === 0) {
      return res.json({ success: true });
    }

    const user = userResult.rows[0];

    // Удаляем старые коды пользователя
    await query(
      `DELETE FROM password_reset_codes WHERE user_id = $1`,
      [user.id]
    );

    // Генерируем 6-значный код
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await query(
      `INSERT INTO password_reset_codes (user_id, code, expires_at)
       VALUES ($1, $2, $3)`,
      [user.id, code, expiresAt]
    );

    // Отправляем email
    let sent = await sendPasswordResetCodeEmail(email, code);

    // Fallback в Telegram, если email не удался
    if (!sent) {
      const tgResult = await query(
        `SELECT target FROM user_channels
         WHERE user_id = $1 AND channel = 'telegram' AND is_active = ${USE_SQLITE ? '1' : 'TRUE'}
         LIMIT 1`,
        [user.id]
      );
      if (tgResult.rows.length > 0) {
        const chatId = tgResult.rows[0].target;
        const tgText = `Код для восстановления пароля PULSE: ${code}. Действителен 15 минут.`;
        sent = await sendTelegramMessage(chatId, tgText);
      }
    }

    if (!sent) {
      console.error('[Auth] Failed to deliver reset code to', email);
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error('[Auth] Forgot password error:', err.message);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/auth/verify-code — Проверка кода и выдача reset-токена
// ═══════════════════════════════════════════════════════════════════════════
router.post('/verify-code', validate(VerifyCodeSchema), async (req, res) => {
  try {
    const { email, code } = req.body;

    const userResult = await query(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1)`,
      [email]
    );
    if (userResult.rows.length === 0) {
      return res.status(400).json({ error: 'Неверный или просроченный код', code: 'CODE_INVALID_OR_EXPIRED' });
    }
    const userId = userResult.rows[0].id;

    const codeResult = await query(
      `SELECT id, code FROM password_reset_codes
       WHERE user_id = $1 AND used = ${USE_SQLITE ? '0' : 'FALSE'} AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );

    if (codeResult.rows.length === 0 || codeResult.rows[0].code !== code) {
      return res.status(400).json({ error: 'Неверный или просроченный код', code: 'CODE_INVALID_OR_EXPIRED' });
    }

    // Помечаем код использованным
    await query(
      `UPDATE password_reset_codes SET used = ${USE_SQLITE ? '1' : 'TRUE'}, used_at = NOW() WHERE id = $1`,
      [codeResult.rows[0].id]
    );

    const resetToken = jwt.sign(
      { userId, email, purpose: 'password_reset' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    res.json({ resetToken });
  } catch (err: any) {
    console.error('[Auth] Verify code error:', err.message);
    res.status(500).json({ error: 'Failed to verify code' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/auth/reset-password — Сброс пароля
// ═══════════════════════════════════════════════════════════════════════════
router.post('/reset-password', validate(ResetPasswordSchema), async (req, res) => {
  try {
    const { resetToken, password } = req.body;

    let decoded: { userId: string; email: string; purpose?: string };
    try {
      decoded = jwt.verify(resetToken, JWT_SECRET) as any;
    } catch {
      return res.status(401).json({ error: 'Недействительная или просроченная ссылка', code: 'INVALID_RESET_TOKEN' });
    }

    if (decoded.purpose !== 'password_reset') {
      return res.status(401).json({ error: 'Недействительная или просроченная ссылка', code: 'INVALID_RESET_TOKEN' });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Пароль должен быть не менее 8 символов' });
    }

    const userResult = await query(
      `SELECT id, email, username, password_hash, is_admin, subscription_active, subscription_plan,
              subscription_expires_at, subscription_auto_renew, scheduled_plan_downgrade
       FROM users WHERE id = $1`,
      [decoded.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const user = userResult.rows[0];
    const passwordHash = await bcrypt.hash(password, 10);

    await query(
      `UPDATE users SET password_hash = $1 WHERE id = $2`,
      [passwordHash, user.id]
    );

    const isAdmin = user.is_admin === 1 || user.is_admin === true;
    const token = jwt.sign(
      { userId: user.id, email: user.email, is_admin: isAdmin },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const subStatus = buildSubscriptionStatus({
      plan: user.subscription_plan || 'free',
      active: !!user.subscription_active,
      expiresAt: user.subscription_expires_at ? new Date(user.subscription_expires_at) : null,
      autoRenew: !!user.subscription_auto_renew,
      scheduledDowngrade: user.scheduled_plan_downgrade || null,
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        is_admin: isAdmin,
        subscription: subStatus,
      },
    });
  } catch (err: any) {
    console.error('[Auth] Reset password error:', err.message);
    res.status(500).json({ error: 'Failed to reset password' });
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
      `SELECT id, email, username, subscription_active, subscription_plan, subscription_expires_at,
              subscription_auto_renew, scheduled_plan_downgrade, news_count, is_admin
       FROM users WHERE id = $1`,
      [decoded.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const subStatus = buildSubscriptionStatus({
      plan: user.subscription_plan || 'free',
      active: !!user.subscription_active,
      expiresAt: user.subscription_expires_at ? new Date(user.subscription_expires_at) : null,
      autoRenew: !!user.subscription_auto_renew,
      scheduledDowngrade: user.scheduled_plan_downgrade || null,
    });

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        is_admin: user.is_admin === 1 || user.is_admin === true,
        subscription: subStatus,
      },
    });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
