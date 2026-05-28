import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import { validate } from '../middleware/validate';
import { AddTagSchema } from '../schemas/user';
import { getRelatedTags, TAG_KEYWORDS } from '../services/smartTagMatcher';
import { createUserTag, generateTagKeywords } from '../services/tagManager';
import { matchTagsByKeywords } from '../services/smartTagMatcher';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

function insertOrReplace(table: string, columns: string[], values: any[]): string {
  if (USE_SQLITE) {
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    return `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
  }
  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`;
}

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
      'SELECT COUNT(*) as count FROM portfolios WHERE user_id = $1',
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

    await query(
      'UPDATE users SET username = $1 WHERE id = $2',
      [username, userId]
    );

    res.json({ username });
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
router.post('/tags', authMiddleware, validate(AddTagSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { tagId, tagName, tagType } = req.body;

    if (!tagId || !tagName || !tagType) {
      return res.status(400).json({ error: 'tagId, tagName, tagType required' });
    }

    // Check tag limit (10 for premium, 3 for free)
    const countResult = await query(
      'SELECT COUNT(*) as count FROM portfolios WHERE user_id = $1',
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

    const portfolioId = uuidv4();

    if (USE_SQLITE) {
      await query(
        `INSERT OR REPLACE INTO portfolios (id, user_id, tag_id, tag_name, tag_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [portfolioId, userId, tagId, tagName, tagType]
      );
    } else {
      await query(
        `INSERT INTO portfolios (id, user_id, tag_id, tag_name, tag_type)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, tag_id) DO UPDATE SET tag_name = $4`,
        [portfolioId, userId, tagId, tagName, tagType]
      );
    }

    res.status(201).json({ tag: { id: portfolioId, tag_id: tagId, tag_name: tagName, tag_type: tagType } });
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
      `UPDATE notification_settings SET ${fields.join(', ')}, updated_at = ${nowSql()} WHERE user_id = $${paramIdx}`,
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

    const channelId = uuidv4();

    if (USE_SQLITE) {
      await query(
        `INSERT OR REPLACE INTO user_channels (id, user_id, channel, target, is_active)
         VALUES ($1, $2, $3, $4, 1)`,
        [channelId, userId, channel, target]
      );
    } else {
      await query(
        `INSERT INTO user_channels (id, user_id, channel, target, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (user_id, channel) DO UPDATE SET target = $4, is_active = TRUE`,
        [channelId, userId, channel, target]
      );
    }

    res.json({ channel: { id: channelId, channel, target, is_active: true } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save channel' });
  }
});

// GET /api/user/tags/related?tag=nvidia — get related tag suggestions
router.get('/tags/related', async (req, res) => {
  try {
    const tagId = req.query.tag as string;
    if (!tagId) {
      return res.status(400).json({ error: 'tag parameter required' });
    }

    const related = getRelatedTags(tagId);
    const availableTags = Object.keys(TAG_KEYWORDS);

    // Build response with tag info
    const relatedWithInfo = related
      .filter(id => availableTags.includes(id))
      .map(id => {
        const keywords = TAG_KEYWORDS[id];
        return {
          tag_id: id,
          tag_name: keywords ? keywords[0] : id,
          tag_type: 'company' as const,
        };
      });

    res.json({ tag: tagId, related: relatedWithInfo });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/user/tags/custom — создать пользовательский тег + backfill по всей базе
router.post('/tags/custom', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { tagName, tagType = 'company' } = req.body;

    if (!tagName || tagName.length < 2) {
      return res.status(400).json({ error: 'Tag name must be at least 2 characters' });
    }

    // Генерируем tag_id из названия (транслит + lowercase)
    const tagId = tagName.toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/g, '')
      .replace(/\s+/g, '_')
      .substring(0, 50);

    if (!tagId) {
      return res.status(400).json({ error: 'Invalid tag name' });
    }

    // Создаем тег
    const success = await createUserTag(userId, tagId, tagName, tagType);
    if (!success) {
      return res.status(500).json({ error: 'Failed to create tag' });
    }

    const keywords = generateTagKeywords(tagName);

    // BACKFILL: Ищем по ВСЕЙ базе новостей и привязываем тег
    console.log(`[TagBackfill] Starting backfill for "${tagId}"...`);
    const allNews = await query(
      `SELECT id, title_ru, summary_ru, matched_tags FROM news ORDER BY published_at DESC`,
      []
    );

    let matched = 0;
    for (const row of allNews.rows) {
      const text = `${row.title_ru || ''} ${row.summary_ru || ''}`.toLowerCase();
      const hasMatch = keywords.some(kw => text.includes(kw.toLowerCase()));

      if (hasMatch) {
        // Добавляем тег в matched_tags (если ещё нет)
        const currentTags = row.matched_tags || [];
        if (!currentTags.includes(tagId)) {
          await query(
            `UPDATE news SET matched_tags = array_append(matched_tags, $1) WHERE id = $2`,
            [tagId, row.id]
          );
          matched++;
        }
      }
    }
    console.log(`[TagBackfill] Matched ${matched} articles for "${tagId}"`);

    res.json({
      tag: {
        id: tagId,
        tag_id: tagId,
        tag_name: tagName,
        tag_type: tagType,
        keywords,
      },
      backfill: {
        scanned: allNews.rows.length,
        matched,
      },
      message: 'Tag created and backfilled successfully',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user/telegram-status — статус подключения Telegram
router.get('/telegram-status', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    // Get channel info
    const channelResult = await query(
      `SELECT target, is_active FROM user_channels WHERE user_id = $1 AND channel = 'telegram'`,
      [userId]
    );

    // Get notification settings
    const settingsResult = await query(
      `SELECT tg_digest_enabled, digest_frequency, quiet_hours_enabled, quiet_hours_start, quiet_hours_end
       FROM notification_settings WHERE user_id = $1`,
      [userId]
    );

    const channel = channelResult.rows[0];
    const settings = settingsResult.rows[0] || {};

    res.json({
      connected: !!channel && channel.is_active,
      chatId: channel?.target || undefined,
      digestEnabled: settings.tg_digest_enabled || false,
      frequency: settings.digest_frequency || '3h',
      quietHoursEnabled: settings.quiet_hours_enabled || false,
      quietHoursStart: settings.quiet_hours_start || '23:00',
      quietHoursEnd: settings.quiet_hours_end || '07:00',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch telegram status' });
  }
});

// POST /api/user/telegram-disconnect — отключить Telegram
router.post('/telegram-disconnect', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    // Deactivate channel
    await query(
      `UPDATE user_channels SET is_active = FALSE WHERE user_id = $1 AND channel = 'telegram'`,
      [userId]
    );

    // Disable digest
    await query(
      `UPDATE notification_settings SET tg_digest_enabled = FALSE WHERE user_id = $1`,
      [userId]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect telegram' });
  }
});

// POST /api/user/notification-settings — сохранить настройки уведомлений
router.post('/notification-settings', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { frequency, quietHoursEnabled, quietHoursStart, quietHoursEnd } = req.body;

    const fields: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (frequency !== undefined) {
      fields.push(`digest_frequency = $${paramIdx++}`);
      values.push(frequency);
    }
    if (quietHoursEnabled !== undefined) {
      fields.push(`quiet_hours_enabled = $${paramIdx++}`);
      values.push(quietHoursEnabled);
    }
    if (quietHoursStart !== undefined) {
      fields.push(`quiet_hours_start = $${paramIdx++}`);
      values.push(quietHoursStart);
    }
    if (quietHoursEnd !== undefined) {
      fields.push(`quiet_hours_end = $${paramIdx++}`);
      values.push(quietHoursEnd);
    }

    if (fields.length === 0) {
      return res.status(400).json({ error: 'No settings provided' });
    }

    fields.push(`updated_at = ${nowSql()}`);
    values.push(userId);

    await query(
      `UPDATE notification_settings SET ${fields.join(', ')} WHERE user_id = $${paramIdx}`,
      values
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save notification settings' });
  }
});

export default router;
