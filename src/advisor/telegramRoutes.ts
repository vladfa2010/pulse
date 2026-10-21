/**
 * =============================================================================
 * PULSE — Advisor module: привязка Telegram и настройки уведомлений (ТЗ-183)
 * =============================================================================
 *
 * Эндпоинты (роутер смонтирован под /api/advisor с гейтом multi_portfolio):
 *   POST   /telegram/link    — deep-link с одноразовым токеном (TTL 15 мин)
 *   POST   /telegram/unlink  — отвязка (advisor_settings.telegram_chat_id = NULL)
 *   GET    /telegram/status  — { linked: boolean }
 *   PATCH  /prefs            — тоглы notify_prefs (merge, UPSERT; ТЗ-183 Задача 1)
 *
 * Обработка /start <токен> — в src/routes/webhook.ts (ядро), ветка для
 * модульного токена userId:timestamp:signature, вся в try/catch: kill-switch
 * модуля не должен ломать ядерный /start.
 */

import { Router } from 'express';
import { query } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { getNotifyPrefs, saveNotifyPrefs, NotifyPrefs } from './service';
import { generateAdvisorLinkToken } from './telegram';

const router = Router();

// Имя бота — как в ядре (index.ts, /api/telegram/link).
const BOT_USERNAME = 'Insidepulse_bot';

/** Пользовательские флаги (служебные ключи авто-отключения TG не принимаем). */
const PREFS_KEYS = ['advisor_digest', 'advisor_news', 'advisor_alert_neg', 'advisor_alert_pos', 'advisor_weekly'] as const;

function publicPrefs(prefs: NotifyPrefs): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of PREFS_KEYS) out[k] = prefs[k] !== false;
  return out;
}

// POST /api/advisor/telegram/link — deep-link с одноразовым токеном
router.post('/telegram/link', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const result = await query(
      `SELECT telegram_chat_id FROM advisor_settings WHERE user_id = $1`,
      [userId]
    );
    if (result.rows[0]?.telegram_chat_id) {
      return res.json({ deepLink: null, linked: true, botUsername: BOT_USERNAME });
    }
    const deepLink = `https://t.me/${BOT_USERNAME}?start=${generateAdvisorLinkToken(userId)}`;
    console.log(`[AdvisorTg] Link generated for user ${userId}`);
    res.json({ deepLink, botUsername: BOT_USERNAME, linked: false, expiresIn: '15m' });
  } catch (err: any) {
    console.error('[AdvisorTg] Link error:', err.message);
    res.status(500).json({ error: 'Failed to generate link' });
  }
});

// POST /api/advisor/telegram/unlink — отвязка
router.post('/telegram/unlink', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    await query(
      `UPDATE advisor_settings SET telegram_chat_id = NULL WHERE user_id = $1`,
      [userId]
    );
    console.log(`[Advisor] user=${userId} action=telegram_unlink`);
    res.json({ linked: false });
  } catch (err: any) {
    console.error('[AdvisorTg] Unlink error:', err.message);
    res.status(500).json({ error: 'Failed to unlink' });
  }
});

// GET /api/advisor/telegram/status
router.get('/telegram/status', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const result = await query(
      `SELECT telegram_chat_id FROM advisor_settings WHERE user_id = $1`,
      [userId]
    );
    res.json({ linked: !!result.rows[0]?.telegram_chat_id });
  } catch (err: any) {
    console.error('[AdvisorTg] Status error:', err.message);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// PATCH /api/advisor/prefs — тоглы notify_prefs (merge, UPSERT)
router.patch('/prefs', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const body = req.body ?? {};
    const patch: Partial<NotifyPrefs> = {};
    for (const k of PREFS_KEYS) {
      if (typeof body[k] === 'boolean') patch[k] = body[k];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'invalid_prefs', allowed: [...PREFS_KEYS] });
    }
    const prefs = await saveNotifyPrefs(userId, patch);
    res.json({ notify_prefs: publicPrefs(prefs) });
  } catch (err: any) {
    console.error('[AdvisorTg] Prefs error:', err.message);
    res.status(500).json({ error: 'Failed to save prefs' });
  }
});

// GET /api/advisor/prefs — текущие флаги (для модала «Расписание и доставка»)
router.get('/prefs', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const prefs = await getNotifyPrefs(userId);
    res.json({ notify_prefs: publicPrefs(prefs) });
  } catch (err: any) {
    console.error('[AdvisorTg] Prefs read error:', err.message);
    res.status(500).json({ error: 'Failed to get prefs' });
  }
});

// ─── Алиасы /notify-prefs (фронтенд ТЗ-183) ────────────────────────────────
// Тот же handler, что и /prefs; PUT принимает тело { prefs: {...} } И голые флаги.

// GET /api/advisor/notify-prefs — алиас GET /prefs
router.get('/notify-prefs', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const prefs = await getNotifyPrefs(userId);
    res.json({ notify_prefs: publicPrefs(prefs) });
  } catch (err: any) {
    console.error('[AdvisorTg] Prefs read error:', err.message);
    res.status(500).json({ error: 'Failed to get prefs' });
  }
});

// PUT /api/advisor/notify-prefs { prefs: {...} } | { advisor_digest: bool, ... }
router.put('/notify-prefs', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const body = req.body ?? {};
    const source = (body.prefs && typeof body.prefs === 'object' && !Array.isArray(body.prefs))
      ? body.prefs
      : body;
    const patch: Partial<NotifyPrefs> = {};
    for (const k of PREFS_KEYS) {
      if (typeof source[k] === 'boolean') patch[k] = source[k];
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'invalid_prefs', allowed: [...PREFS_KEYS] });
    }
    const prefs = await saveNotifyPrefs(userId, patch);
    res.json({ notify_prefs: publicPrefs(prefs) });
  } catch (err: any) {
    console.error('[AdvisorTg] Prefs error:', err.message);
    res.status(500).json({ error: 'Failed to save prefs' });
  }
});

export default router;
