import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';

const router = Router();

// ============================================================
// Profile
// ============================================================

// GET /api/user/profile — get full profile
router.get('/profile', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    const userResult = await query(
      `SELECT id, email, username, is_verified, subscription_active,
              subscription_expires_at, subscription_auto_renew, news_count, created_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Count portfolio tags
    const portfolioResult = await query(
      'SELECT COUNT(*) FROM portfolios WHERE user_id = $1',
      [userId]
    );
    const tagCount = parseInt(portfolioResult.rows[0].count);

    res.json({
      id: user.id,
      email: user.email,
      username: user.username,
      isVerified: user.is_verified,
      subscription: {
        active: user.subscription_active,
        expiresAt: user.subscription_expires_at,
        autoRenew: user.subscription_auto_renew,
      },
      stats: {
        newsCount: user.news_count,
        tagCount,
        memberSince: user.created_at,
      },
    });
  } catch (err) {
    console.error('Profile fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PATCH /api/user/profile — update username
router.patch('/profile', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { username } = req.body;

    if (!username || username.length < 2 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 2-30 characters' });
    }

    const result = await query(
      'UPDATE users SET username = $1 WHERE id = $2 RETURNING username',
      [username, userId]
    );

    res.json({ username: result.rows[0].username });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============================================================
// Portfolio (Tags)
// ============================================================

// GET /api/user/tags — get all user tags
router.get('/tags', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    const result = await query(
      `SELECT id, tag_id, tag_name, tag_type, created_at
       FROM portfolios WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId]
    );

    res.json({ tags: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// POST /api/user/tags — add a tag
router.post('/tags', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { tagId, tagName, tagType } = req.body;

    if (!tagId || !tagName || !tagType) {
      return res.status(400).json({ error: 'tagId, tagName, tagType required' });
    }

    // Check tag limit (10 for premium, 3 for free)
    const countResult = await query(
      'SELECT COUNT(*) FROM portfolios WHERE user_id = $1',
      [userId]
    );
    const tagCount = parseInt(countResult.rows[0].count);

    const userResult = await query(
      'SELECT subscription_active FROM users WHERE id = $1',
      [userId]
    );
    const isPremium = userResult.rows[0]?.subscription_active || false;
    const maxTags = isPremium ? 10 : 3;

    if (tagCount >= maxTags) {
      return res.status(403).json({
        error: `Tag limit reached (${maxTags}). Upgrade to Premium for more.`,
      });
    }

    const result = await query(
      `INSERT INTO portfolios (user_id, tag_id, tag_name, tag_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, tag_id) DO UPDATE SET tag_name = $3
       RETURNING id, tag_id, tag_name, tag_type, created_at`,
      [userId, tagId, tagName, tagType]
    );

    res.status(201).json({ tag: result.rows[0] });
  } catch (err) {
    console.error('Add tag error:', err);
    res.status(500).json({ error: 'Failed to add tag' });
  }
});

// DELETE /api/user/tags/:tagId — remove a tag
router.delete('/tags/:tagId', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { tagId } = req.params;

    await query(
      'DELETE FROM portfolios WHERE user_id = $1 AND tag_id = $2',
      [userId, tagId]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove tag' });
  }
});

// ============================================================
// Notification Settings
// ============================================================

// GET /api/user/notifications
router.get('/notifications', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    const result = await query(
      `SELECT tg_enabled, email_enabled, push_enabled, report_frequency,
              report_type, alert_negative, alert_positive, alert_threshold,
              report_time, quiet_hours_start, quiet_hours_end, quiet_hours_enabled,
              report_format, report_language
       FROM notification_settings WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      // Create defaults
      await query(
        `INSERT INTO notification_settings (user_id) VALUES ($1)`,
        [userId]
      );
      const defaults = await query(
        `SELECT tg_enabled, email_enabled, push_enabled, report_frequency,
                report_type, alert_negative, alert_positive, alert_threshold,
                report_time, quiet_hours_start, quiet_hours_end, quiet_hours_enabled,
                report_format, report_language
         FROM notification_settings WHERE user_id = $1`,
        [userId]
      );
      return res.json({ settings: defaults.rows[0] });
    }

    res.json({ settings: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch notification settings' });
  }
});

// PATCH /api/user/notifications
router.patch('/notifications', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const updates = req.body;

    const allowedFields = [
      'tg_enabled', 'email_enabled', 'push_enabled', 'report_frequency',
      'report_type', 'alert_negative', 'alert_positive', 'alert_threshold',
      'report_time', 'quiet_hours_start', 'quiet_hours_end', 'quiet_hours_enabled',
      'report_format', 'report_language',
    ];

    const fields: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(updates)) {
      if (allowedFields.includes(key)) {
        fields.push(`${key} = $${paramIdx}`);
        values.push(value);
        paramIdx++;
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(userId);
    await query(
      `UPDATE notification_settings SET ${fields.join(', ')}, updated_at = NOW() WHERE user_id = $${paramIdx}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
});

// ============================================================
// Channels (Telegram / Email)
// ============================================================

// GET /api/user/channels
router.get('/channels', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const result = await query(
      `SELECT id, channel, target, is_active, created_at
       FROM user_channels WHERE user_id = $1`,
      [req.user!.userId]
    );
    res.json({ channels: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// POST /api/user/channels — add/update channel
router.post('/channels', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { channel, target } = req.body;

    if (!channel || !target) {
      return res.status(400).json({ error: 'channel and target required' });
    }

    const result = await query(
      `INSERT INTO user_channels (user_id, channel, target, is_active)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (user_id, channel) DO UPDATE SET target = $3, is_active = TRUE
       RETURNING id, channel, target, is_active`,
      [userId, channel, target]
    );

    res.json({ channel: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save channel' });
  }
});

export default router;
