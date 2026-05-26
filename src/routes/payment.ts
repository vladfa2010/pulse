/**
 * =============================================================================
 * PULSE — Payment Routes (Платежи через YuKassa)
 * =============================================================================
 *
 * Эндпоинты:
 *   POST /api/payment/create   — Создать платёж (возвращает ссылку на YuKassa)
 *   POST /api/payment/confirm  — Подтвердить платёж (demo-режим)
 *   GET  /api/payment/status/:id — Проверить статус платежа
 *   GET  /api/payment/history  — История платежей пользователя
 *
 * YuKassa Flow (реальный):
 *   1. Фронтенд → POST /api/payment/create (amount, discount)
 *   2. Бэкенд → YuKassa API (создаём платёж)
 *   3. YuKassa → возвращает confirmation_url (форма оплаты)
 *   4. Бэкенд → фронтенд: { confirmation_url }
 *   5. Фронтенд → редирект на confirmation_url (пользователь видит форму YuKassa)
 *   6. Пользователь оплачивает → YuKassa редиректит на return_url
 *   7. YuKassa → webhook (/api/webhook/yookassa) → подписка активирована
 *
 * DEMO-режим (когда YuKassa не настроена):
 *   - Если YOOKASSA_SHOP_ID не задан → возвращаем demo=true
 *   - Фронтенд показывает имитацию формы карты
 *   - При нажатии "Подтвердить" → вызываем POST /api/payment/confirm
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import axios from 'axios';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ─── YuKassa конфигурация ─────────────────────────────────────────────────
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
// YuKassa настроена если заданы оба параметра
const IS_YOOKASSA_CONFIGURED = YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY;
// URL фронтенда для редиректа после оплаты
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://pulse-frontend-jt53.onrender.com';

// Генератор UUID v4
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// SQL-функции для работы с датами (SQLite vs PostgreSQL)
function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}
function nowPlusDaysSql(days: number): string {
  return USE_SQLITE ? `datetime('now', '+${days} days')` : `NOW() + INTERVAL '${days} days'`;
}

// ─── Basic Auth заголовок для YuKassa API ─────────────────────────────────
// YuKassa требует: Base64(shop_id:secret_key)
function yookassaAuth(): string {
  return 'Basic ' + Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64');
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/payment/create — Создать платёж
// ═══════════════════════════════════════════════════════════════════════════
// Принимает: { amount, discount, method }
// Возвращает: { payment: { id, amount, status }, confirmation_url, demo? }
//
// Логика:
//   1. Сохраняем платёж в БД (status = 'pending')
//   2. Если YuKassa настроена → создаём платёж через API YuKassa
//   3. Если YuKassa НЕ настроена → demo-режим
router.post('/create', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;     // ID пользователя из JWT токена
    const { amount = 490, discount = 0, method = 'bank_card' } = req.body;

    // ─── Рассчитываем итоговую сумму со скидкой ─────────────────────────
    const finalAmount = Math.round(amount * (1 - discount / 100));
    const paymentId = uuidv4();

    // ─── Шаг 1: Сохраняем платёж в БД ───────────────────────────────────
    await query(
      `INSERT INTO payments (id, user_id, amount, base_amount, discount, method, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
      [paymentId, userId, finalAmount, amount, discount, method]
    );

    // ─── Шаг 2a: YuKassa НЕ настроена → DEMO режим ──────────────────────
    if (!IS_YOOKASSA_CONFIGURED) {
      return res.json({
        payment: { id: paymentId, amount: finalAmount, status: 'pending' },
        demo: true,
        // Редирект на страницу с demo-формой карты
        confirmation_url: `${FRONTEND_URL}/#/payment/return?demo=1&payment_id=${paymentId}`
      });
    }

    // ─── Шаг 2b: YuKassa настроена → реальный API вызов ─────────────────
    const idempotenceKey = uuidv4(); // Защита от дублей (одинаковый ключ = один платёж)

    const yookassaPayload = {
      amount: {
        value: finalAmount.toFixed(2),  // Сумма в рублях (например, "490.00")
        currency: 'RUB'
      },
      capture: true,  // Автоматическое списание (без холда)
      confirmation: {
        type: 'redirect',
        // Куда YuKassa редиректит после оплаты
        return_url: `${FRONTEND_URL}/#/payment/return?payment_id=${paymentId}`
      },
      description: `PULSE Premium — ${req.user!.email || userId}`,
      metadata: {
        payment_id: paymentId,   // Наш ID для связи
        user_id: userId,
        discount: String(discount)
      }
    };

    // Вызываем API YuKassa
    const yookassaRes = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      yookassaPayload,
      {
        headers: {
          'Authorization': yookassaAuth(),
          'Idempotence-Key': idempotenceKey,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const yookassaData = yookassaRes.data;

    // ─── Шаг 3: Сохраняем provider_ref (ID платежа в YuKassa) ───────────
    await query(
      `UPDATE payments SET provider_ref = $1 WHERE id = $2`,
      [yookassaData.id, paymentId]
    );

    // ─── Шаг 4: Возвращаем ссылку на оплату ─────────────────────────────
    res.json({
      payment: { id: paymentId, amount: finalAmount, status: 'pending' },
      confirmation_url: yookassaData.confirmation?.confirmation_url
    });

  } catch (err: any) {
    console.error('[Payment] Create failed:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Payment creation failed',
      details: err.response?.data?.description || err.message
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/payment/confirm — Ручное подтверждение (demo-режим)
// ═══════════════════════════════════════════════════════════════════════════
// Используется в demo-режиме когда YuKassa не подключена.
// Просто активирует подписку без реальной оплаты.
router.post('/confirm', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { paymentId } = req.body;

    // Обновляем статус платежа
    await query(
      `UPDATE payments SET status = 'completed', paid_at = ${nowSql()} WHERE id = $1`,
      [paymentId]
    );

    // Активируем подписку на 30 дней
    await query(
      `UPDATE users
       SET subscription_active = 1,
           subscription_expires_at = ${nowPlusDaysSql(30)}
       WHERE id = $1`,
      [userId]
    );

    res.json({ success: true, message: 'Subscription activated' });
  } catch (err) {
    res.status(500).json({ error: 'Payment confirmation failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/payment/status/:id — Проверить статус платежа
// ═══════════════════════════════════════════════════════════════════════════
// Фронтенд вызывает после возврата с YuKassa (polling).
// Если YuKassa настроена → дополнительно проверяем статус у YuKassa API.
router.get('/status/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const userId = req.user!.userId;

    // Загружаем платёж из БД
    const result = await query(
      `SELECT id, amount, base_amount, discount, method, status, provider_ref,
              paid_at, created_at FROM payments WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const payment = result.rows[0];

    // Если YuKassa настроена и платёж всё ещё pending → проверяем у YuKassa
    if (IS_YOOKASSA_CONFIGURED && payment.provider_ref && payment.status === 'pending') {
      try {
        const yookassaRes = await axios.get(
          `https://api.yookassa.ru/v3/payments/${payment.provider_ref}`,
          { headers: { 'Authorization': yookassaAuth() }, timeout: 10000 }
        );

        const yookassaStatus = yookassaRes.data.status;

        // YuKassa подтвердил оплату → активируем подписку
        if (yookassaStatus === 'succeeded' && payment.status !== 'completed') {
          await query(
            `UPDATE payments SET status = 'completed', paid_at = ${nowSql()} WHERE id = $1`,
            [id]
          );
          await query(
            `UPDATE users SET subscription_active = 1,
                 subscription_expires_at = ${nowPlusDaysSql(30)} WHERE id = $1`,
            [userId]
          );
          payment.status = 'completed';
          payment.paid_at = new Date().toISOString();
        }
        // YuKassa отменил → помечаем failed
        else if (yookassaStatus === 'canceled') {
          await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [id]);
          payment.status = 'failed';
        }
      } catch (ykErr: any) {
        console.error('[YuKassa] Status check failed:', ykErr.message);
      }
    }

    res.json({ payment });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/payment/history — История платежей
// ═══════════════════════════════════════════════════════════════════════════
router.get('/history', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const result = await query(
      `SELECT id, amount, base_amount, discount, method, status, paid_at, created_at
       FROM payments WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user!.userId]
    );
    res.json({ payments: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

export default router;
