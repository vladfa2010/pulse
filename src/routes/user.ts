import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import { validate } from '../middleware/validate';
import { AddTagSchema } from '../schemas/user';
import { getRelatedTags, matchTagsByKeywords } from '../services/smartTagMatcher';
import { createUserTag, getAllTagNames, detectTagTypeViaLLM, TAG_TYPE_LABELS } from '../services/tagManager';
import {
  getPlanById, getUserSubscription, buildSubscriptionStatus,
  scheduleDowngrade, cancelScheduledDowngrade, requireMinPlan,
  getExcessTagsForDowngrade, parseDbJson,
} from '../services/subscription';
import type { TagType, TagEnrichment } from '../services/tagManager';
import axios from 'axios';
import { getVapidPublicKey } from '../services/webPush';
import { logTagAdded, logTagRemoved } from '../services/activityLog';
import { savePaymentMethod } from '../services/subscription';

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
      `SELECT id, email, username, is_verified, subscription_active, subscription_plan,
              subscription_expires_at, subscription_auto_renew, scheduled_plan_downgrade,
              news_count, created_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const subStatus = buildSubscriptionStatus({
      plan: user.subscription_plan || 'free',
      active: !!user.subscription_active,
      expiresAt: user.subscription_expires_at ? new Date(user.subscription_expires_at) : null,
      autoRenew: !!user.subscription_auto_renew,
      scheduledDowngrade: user.scheduled_plan_downgrade || null,
    });

    // Count active portfolio tags
    const portfolioResult = await query(
      'SELECT COUNT(*) as count FROM portfolios WHERE user_id = $1 AND is_frozen = FALSE',
      [userId]
    );
    const tagCount = parseInt(portfolioResult.rows[0].count);

    res.json({
      id: user.id,
      email: user.email,
      username: user.username,
      isVerified: user.is_verified,
      subscription: subStatus,
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
      `SELECT
         p.id,
         p.tag_id,
         p.tag_name,
         p.tag_type,
         p.created_at,
         CASE WHEN udt.enriched_data IS NOT NULL THEN TRUE ELSE FALSE END AS enriched
       FROM portfolios p
       LEFT JOIN user_defined_tags udt ON udt.tag_id = p.tag_id
       WHERE p.user_id = $1
       ORDER BY p.created_at DESC`,
      [userId]
    );

    res.json({ tags: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// POST /api/user/tags — add a tag (auto-detects type via LLM)
router.post('/tags', authMiddleware, validate(AddTagSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { tagId, tagName, tagType } = req.body;

    if (!tagId || !tagName) {
      return res.status(400).json({ error: 'tagId and tagName required' });
    }

    // Check tag limit based on subscription plan
    const subResult = await query(
      `SELECT subscription_plan FROM users WHERE id = $1`,
      [userId]
    );
    const planId = subResult.rows[0]?.subscription_plan || 'free';
    const plan = await getPlanById(planId);
    if (!plan) {
      console.error(`[tagLimit] Plan not found: ${planId}`);
      return res.status(500).json({ error: 'Plan not configured' });
    }
    const maxTags = plan.tag_limit;

    const countResult = await query(
      'SELECT COUNT(*) as count FROM portfolios WHERE user_id = $1 AND is_frozen = FALSE',
      [userId]
    );
    const tagCount = parseInt(countResult.rows[0].count);

    if (maxTags >= 0 && tagCount >= maxTags) {
      return res.status(403).json({
        error: `Tag limit reached (${maxTags}). Upgrade your plan for more.`,
      });
    }

    // Auto-detect type if 'auto' or not provided
    const result = await createUserTag(userId, tagId, tagName, tagType);
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to create tag' });
    }

    const finalType = result.detectedType || tagType;
    const finalTagId = result.finalTagId || tagId;
    const finalTagName = result.resolvedTagName || tagName;

    if (!result.alreadySubscribed) {
      logTagAdded(userId, finalTagId, finalTagName, finalType).catch(() => {});
    }

    res.status(201).json({
      tag: {
        tag_id: finalTagId,
        tag_name: finalTagName,
        tag_type: finalType,
        tag_type_label: TAG_TYPE_LABELS[finalType as TagType],
        enriched: result.enriched ?? false,
      },
      alreadySubscribed: result.alreadySubscribed ?? false,
      backgroundEnrichmentStarted: result.backgroundEnrichmentStarted ?? false,
    });
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

    const tagInfo = await query(
      'SELECT tag_name FROM portfolios WHERE user_id = $1 AND tag_id = $2',
      [userId, tagId]
    );
    const removedTagName = tagInfo.rows[0]?.tag_name || tagId;

    await query(
      'DELETE FROM portfolios WHERE user_id = $1 AND tag_id = $2',
      [userId, tagId]
    );

    logTagRemoved(userId, tagId, removedTagName).catch(() => {});

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
              report_format, report_language,
              fact_check_email_enabled, fact_check_tg_enabled
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
                report_format, report_language,
                fact_check_email_enabled, fact_check_tg_enabled
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
      'fact_check_email_enabled', 'fact_check_tg_enabled',
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

// GET /api/user/tags/related?tag=nvidia — get related tag suggestions (LLM-based)
router.get('/tags/related', async (req, res) => {
  try {
    const tagId = req.query.tag as string;
    if (!tagId) {
      return res.status(400).json({ error: 'tag parameter required' });
    }

    // Get all tag IDs from DB + find related via LLM
    const allTagIds = await getAllTagNames();
    const related = await getRelatedTags(tagId, allTagIds);

    // Build response with tag info from DB
    const result = await query(
      `SELECT tag_id, tag_name, tag_type FROM user_defined_tags WHERE tag_id = ANY($1)`,
      [related]
    );
    const tagInfoMap = new Map(result.rows.map((r: any) => [r.tag_id, r]));

    const relatedWithInfo = related
      .map(id => {
        const info = tagInfoMap.get(id);
        return {
          tag_id: id,
          tag_name: info?.tag_name || id,
          tag_type: info?.tag_type || 'company',
        };
      });

    res.json({ tag: tagId, related: relatedWithInfo });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user/tags/:tagName/enrichment — enriched data for a tag (PUBLIC)
router.get('/tags/:tagName/enrichment', async (req, res) => {
  try {
    const tagName = req.params.tagName;

    const result = await query(
      `SELECT tag_name, tag_type, enriched_data, created_at
       FROM user_defined_tags
       WHERE tag_name = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [tagName]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tag not found' });
    }

    const row = result.rows[0];
    const enriched = row.enriched_data || {};

    res.json({
      tag_name: row.tag_name,
      tag_type: row.tag_type || enriched.tag_type || 'company',
      ticker: enriched.ticker || null,
      website: enriched.website || null,
      synonyms_en: enriched.synonyms_en || [],
      synonyms_ru: enriched.synonyms_ru || [],
      key_products: enriched.key_products || [],
      related_entities: enriched.related_entities || [],
      description_ru: enriched.description_ru || enriched.description || null,
      created_at: row.created_at,
    });
  } catch (err: any) {
    console.error('[TagEnrichment] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/user/tags/detect-type?tagName=Apple — автоопределение типа (preview)
router.get('/tags/detect-type', async (req, res) => {
  try {
    const tagName = req.query.tagName as string;
    if (!tagName || tagName.length < 1) {
      return res.status(400).json({ error: 'tagName required' });
    }

    const detectedType = await detectTagTypeViaLLM(tagName);
    res.json({
      tag_name: tagName,
      tag_type: detectedType,
      tag_type_label: TAG_TYPE_LABELS[detectedType],
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
      channelExists: !!channel,
      chatId: channel?.target || undefined,
      digestEnabled: settings.tg_digest_enabled || false,
      frequency: settings.digest_frequency || '1h',
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

// GET /api/user/email-settings — получить email для дайджеста
router.get('/email-settings', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const result = await query(
      `SELECT digest_email, email_digest_enabled FROM notification_settings WHERE user_id = $1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.json({ email: '', enabled: false });
    }
    res.json({
      email: result.rows[0].digest_email || '',
      enabled: result.rows[0].email_digest_enabled || false,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch email settings' });
  }
});

// POST /api/user/email-settings — сохранить email для дайджеста
router.post('/email-settings', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { email, enabled } = req.body;

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (email && !emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    await query(
      `UPDATE notification_settings 
       SET digest_email = $1, email_digest_enabled = $2, updated_at = ${nowSql()}
       WHERE user_id = $3`,
      [email || null, enabled === true, userId]
    );

    res.json({ success: true, email, enabled: enabled === true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save email settings' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Daily AI Summary — новости по тегам пользователя за последние N часов
// ═══════════════════════════════════════════════════════════════════════════

const KIMI_API_KEY_SUMMARY = process.env.KIMI_API_KEY;
const KIMI_MODEL_SUMMARY = process.env.KIMI_MODEL || 'kimi-k2.5';

// In-memory cache: userId -> { text, timestamp }
const summaryCache: Map<string, { text: string; time: number; generatedAt: string }> = new Map();
const SUMMARY_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Build prompt for daily summary
function buildSummaryPrompt(
  tagNames: string[],
  articles: { title: string; summary: string; tags: string[]; sentiment: string }[]
): string {
  const tagList = tagNames.join(', ');

  const articlesText = articles
    .map((a, i) => {
      const tagStr = a.tags?.join(', ') || '';
      const emoji = a.sentiment === 'positive' ? '🟢' : a.sentiment === 'negative' ? '🔴' : '⚪';
      return `${i + 1}. ${emoji} ${a.title}\n   ${a.summary.slice(0, 200)}\n   Теги: ${tagStr}`;
    })
    .join('\n\n');

  return `Ты — инвестиционный аналитик PULSE. Подготовь краткое саммари для клиента о событиях, затрагивающих его активы.

Активы клиента: ${tagList}

Новости за последние 12 часов:
${articlesText}

Требования к саммари:
1. Напиши на русском языке
2. Общий объем — 80-150 слов (3-5 коротких абзацев)
3. Стиль: уверенный аналитический, без воды, конкретные выводы
4. Укажи ключевые события и их влияние на активы клиента
5. Если новостей нет или мало — напиши "За последние 12 часов значимых событий по вашим активам не зафиксировано."
6. Не используй markdown-заголовки, списки, эмодзи — только плавный текст
7. Начинай с фразы типа "За последние 12 часов..." или "В фокусе..."

Саммари:`;
}

// GET /api/user/summary — AI summary of recent news for user's tags
router.get('/summary', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const hours = parseInt(req.query.hours as string) || 12;
    const skipCache = req.query.refresh === '1';

    // 1. Check cache (unless refresh requested)
    if (!skipCache) {
      const cached = summaryCache.get(userId);
      if (cached && Date.now() - cached.time < SUMMARY_CACHE_TTL) {
        console.log(`[Summary] Cache hit for user ${userId.slice(0, 8)}`);
        return res.json({
          summary: cached.text,
          cached: true,
          generated_at: cached.generatedAt,
          articles_count: 0,
        });
      }
    }

    // 2. Get user's tags
    const tagsResult = await query(
      `SELECT tag_id, tag_name FROM portfolios WHERE user_id = $1`,
      [userId]
    );
    const userTags = tagsResult.rows;
    if (userTags.length === 0) {
      return res.json({
        summary: 'У вас пока нет отслеживаемых активов. Добавьте тег в профиле, чтобы получать персональное саммари.',
        cached: false,
        articles_count: 0,
      });
    }

    const tagIds = userTags.map((t: any) => t.tag_id);
    const tagNames = userTags.map((t: any) => t.tag_name);

    // 3. Fetch recent news matching user's tags
    const newsResult = await query(
      `SELECT title_ru, summary_ru, matched_tags, sentiment
       FROM news
       WHERE published_at > NOW() - INTERVAL '${hours} hours'
         AND matched_tags && $1
       ORDER BY published_at DESC
       LIMIT 30`,
      [tagIds]
    );

    const articles = newsResult.rows.map((row: any) => ({
      title: row.title_ru || '',
      summary: row.summary_ru || '',
      tags: row.matched_tags || [],
      sentiment: row.sentiment || 'neutral',
    }));

    // 4. If no LLM key — return fallback
    if (!KIMI_API_KEY_SUMMARY) {
      return res.json({
        summary: `Новостей по вашим активам (${tagNames.join(', ')}) за последние ${hours} часов: ${articles.length}. LLM недоступен для генерации саммари.`,
        cached: false,
        articles_count: articles.length,
      });
    }

    // 5. Call LLM for summary
    const prompt = buildSummaryPrompt(tagNames, articles);

    console.log(`[Summary] Generating for user ${userId.slice(0, 8)}, tags: ${tagNames.join(', ')}, articles: ${articles.length}`);

    const llmResponse = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model: KIMI_MODEL_SUMMARY,
        messages: [{ role: 'user', content: prompt }],
        temperature: KIMI_MODEL_SUMMARY.startsWith('kimi-k') ? 0.6 : 0.3,
        max_tokens: 600,
        thinking: KIMI_MODEL_SUMMARY.startsWith('kimi-k') ? { type: 'disabled' } : undefined,
      },
      {
        headers: {
          'Authorization': `Bearer ${KIMI_API_KEY_SUMMARY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const summaryText = llmResponse.data?.choices?.[0]?.message?.content?.trim()
      || 'Не удалось сгенерировать саммари. Попробуйте обновить позже.';

    // 6. Save to cache
    const now = new Date().toISOString();
    summaryCache.set(userId, { text: summaryText, time: Date.now(), generatedAt: now });

    console.log(`[Summary] Generated ${summaryText.length} chars for user ${userId.slice(0, 8)}`);

    res.json({
      summary: summaryText,
      cached: false,
      generated_at: now,
      articles_count: articles.length,
    });
  } catch (err: any) {
    console.error('[Summary] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ============================================================
// Stats — общее кол-во новостей + персональное
// ============================================================

router.get('/stats', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;

    // 1. Общее количество новостей в базе
    const totalResult = await query(`SELECT COUNT(*)::int as total FROM news`, []);
    const totalNews = totalResult.rows[0]?.total || 0;

    // 2. Количество новостей за 24ч
    const dayResult = await query(
      `SELECT COUNT(*)::int as cnt FROM news WHERE published_at > NOW() - INTERVAL '24 hours'`,
      []
    );
    const last24h = dayResult.rows[0]?.cnt || 0;

    // 3. Теги пользователя (from portfolios) — matched_tags stores tag_id!
    const tagsResult = await query(
      `SELECT tag_id FROM portfolios WHERE user_id = $1`,
      [userId]
    );
    const userTags = tagsResult.rows.map((r: any) => r.tag_id);

    // 4. Новости, подходящие пользователю (matched_tags && user_tags)
    let personalNews = 0;
    let personalNews24h = 0;

    if (userTags.length > 0) {
      // PostgreSQL: проверяем пересечение массивов
      const personalResult = await query(
        `SELECT COUNT(*)::int as cnt FROM news
         WHERE matched_tags && $1::text[]`,
        [userTags]
      );
      personalNews = personalResult.rows[0]?.cnt || 0;

      const personal24hResult = await query(
        `SELECT COUNT(*)::int as cnt FROM news
         WHERE matched_tags && $1::text[]
           AND published_at > NOW() - INTERVAL '24 hours'`,
        [userTags]
      );
      personalNews24h = personal24hResult.rows[0]?.cnt || 0;
    }

    res.json({
      total_news: totalNews,
      total_news_24h: last24h,
      personal_news: personalNews,
      personal_news_24h: personalNews24h,
      user_tags_count: userTags.length,
      user_tags: userTags,
    });
  } catch (err: any) {
    console.error('[Stats] Error:', err.message);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ============================================================
// Subscription / downgrade / auto-renew / push subscriptions
// ============================================================

// GET /api/user/my-plan — текущий тариф пользователя (даже удалённый)
router.get('/my-plan', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const userResult = await query(
      `SELECT subscription_plan FROM users WHERE id = $1`,
      [userId]
    );
    const planId = userResult.rows[0]?.subscription_plan || 'free';
    const planResult = await query(
      `SELECT * FROM subscription_plans WHERE id = $1`,
      [planId]
    );
    const plan = planResult.rows[0];
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    res.json({
      plan: {
        id: plan.id,
        name: plan.name,
        price: Number(plan.price),
        billingFrequency: plan.billing_frequency,
        yearlyDiscount: plan.yearly_discount,
        tagLimit: plan.tag_limit,
        features: parseDbJson(plan.features) || {},
        isActive: plan.is_active,
        isPopular: plan.is_popular,
        deletedAt: plan.deleted_at,
        planLevel: plan.plan_level,
      },
    });
  } catch (err) {
    console.error('[MyPlan] Error:', err);
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});

// POST /api/user/update-payment-method — создать 1₽ платёж для привязки карты
router.post('/update-payment-method', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const userEmail = req.user!.email || '';

    const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || '';
    const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || '';
    const IS_YOOKASSA_CONFIGURED = YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY;
    const FRONTEND_URL = process.env.FRONTEND_URL || 'https://pulse-frontend-jt53.onrender.com';

    if (!IS_YOOKASSA_CONFIGURED) {
      return res.status(400).json({ error: 'YuKassa not configured' });
    }

    function uuidv4(): string {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    const paymentId = uuidv4();
    const amount = 1.0;

    await query(
      `INSERT INTO payments (id, user_id, amount, base_amount, discount, method, status, plan_id, billing_cycle, duration_days, is_upgrade)
       VALUES ($1, $2, $3, $3, 0, 'bank_card', 'pending', NULL, 'monthly', 0, FALSE)`,
      [paymentId, userId, amount]
    );

    const yookassaRes = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: amount.toFixed(2), currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: `${FRONTEND_URL}/payment/return?payment_id=${paymentId}&update_method=1` },
        description: `PULSE — привязка карты ${userEmail}`.slice(0, 128),
        save_payment_method: 'true',
        merchant_customer_id: userId,
        metadata: {
          payment_id: paymentId,
          user_id: userId,
          update_payment_method: 'true',
        },
        receipt: {
          customer: { email: userEmail },
          items: [{
            description: 'Привязка карты PULSE'.slice(0, 128),
            quantity: '1.00',
            amount: { value: amount.toFixed(2), currency: 'RUB' },
            vat_code: 1,
            payment_subject: 'service',
            payment_mode: 'full_payment',
          }],
        },
      },
      {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString('base64'),
          'Idempotence-Key': uuidv4(),
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    await query(`UPDATE payments SET provider_ref = $1 WHERE id = $2`, [yookassaRes.data.id, paymentId]);

    res.json({
      payment: { id: paymentId, amount, status: 'pending' },
      confirmation_url: yookassaRes.data.confirmation?.confirmation_url,
    });
  } catch (err: any) {
    console.error('[UpdatePaymentMethod] Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create payment method update' });
  }
});

// GET /api/user/tariff-status — полный статус тарифа для профиля
router.get('/tariff-status', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const sub = await getUserSubscription(userId);
    const status = buildSubscriptionStatus(sub);
    const plan = await getPlanById(sub.plan);
    if (!plan) {
      return res.status(500).json({ error: 'Plan not configured', planId: sub.plan });
    }

    const tagsResult = await query(
      `SELECT COUNT(*) FILTER (WHERE is_frozen = FALSE) as active,
              COUNT(*) FILTER (WHERE is_frozen = TRUE) as frozen
       FROM portfolios WHERE user_id = $1`,
      [userId]
    );
    const tagUsage = {
      active: parseInt(tagsResult.rows[0]?.active || '0'),
      frozen: parseInt(tagsResult.rows[0]?.frozen || '0'),
      limit: plan.tag_limit,
    };

    const methods = await query(
      `SELECT id, payment_method_id, card_last4, card_brand, card_expiry, is_default
       FROM user_payment_methods WHERE user_id = $1 AND is_active = TRUE
       ORDER BY is_default DESC, created_at DESC`,
      [userId]
    );

    const renewals = await query(
      `SELECT r.id, r.plan_id, r.billing_cycle, r.status, r.period_start, r.period_end,
              p.amount, p.paid_at
       FROM subscription_renewals r
       LEFT JOIN payments p ON p.id = r.payment_id
       WHERE r.user_id = $1
       ORDER BY r.period_start DESC
       LIMIT 20`,
      [userId]
    );

    res.json({
      subscription: status,
      plan: plan
        ? {
            id: plan.id,
            name: plan.name,
            tagLimit: plan.tag_limit,
            features: plan.features,
          }
        : null,
      tagUsage,
      savedMethods: methods.rows,
      renewals: renewals.rows,
    });
  } catch (err) {
    console.error('[TariffStatus] Error:', err);
    res.status(500).json({ error: 'Failed to fetch tariff status' });
  }
});

// GET /api/user/downgrade-preview — какие теги заморозятся при даунгрейде
router.get('/downgrade-preview', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { targetPlan } = req.query;
    if (!targetPlan || typeof targetPlan !== 'string') {
      return res.status(400).json({ error: 'targetPlan required' });
    }
    const tags = await getExcessTagsForDowngrade(userId, targetPlan);
    res.json({ targetPlan, tags });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch downgrade preview' });
  }
});

// GET /api/user/auto-renew — текущий статус автопродления
router.get('/auto-renew', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const result = await query(
      `SELECT subscription_auto_renew FROM users WHERE id = $1`,
      [userId]
    );
    const methods = await query(
      `SELECT payment_method_id, card_last4, card_brand, card_expiry, is_default
       FROM user_payment_methods WHERE user_id = $1 AND is_active = TRUE`,
      [userId]
    );
    res.json({
      enabled: result.rows[0]?.subscription_auto_renew ?? true,
      savedMethods: methods.rows,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch auto-renew status' });
  }
});

// DELETE /api/user/payment-methods/:id — удалить сохранённую карту
router.delete('/payment-methods/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { id } = req.params;
    await query(
      `UPDATE user_payment_methods SET is_active = FALSE WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove payment method' });
  }
});

// POST /api/user/auto-renew — включить/выключить автопродление
router.post('/auto-renew', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { enabled } = req.body;
    await query(
      `UPDATE users SET subscription_auto_renew = $1 WHERE id = $2`,
      [enabled === true, userId]
    );
    res.json({ success: true, enabled: enabled === true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update auto-renew' });
  }
});

// POST /api/user/downgrade — запланировать понижение тарифа
router.post('/downgrade', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { targetPlan } = req.body;
    if (!targetPlan) {
      return res.status(400).json({ error: 'targetPlan required' });
    }
    await scheduleDowngrade(userId, targetPlan);
    res.json({ success: true, scheduledPlan: targetPlan });
  } catch (err) {
    res.status(500).json({ error: 'Failed to schedule downgrade' });
  }
});

// POST /api/user/downgrade/cancel — отменить запланированное понижение
router.post('/downgrade/cancel', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    await cancelScheduledDowngrade(userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel downgrade' });
  }
});

// GET /api/user/frozen-tags — список замороженных тегов
router.get('/frozen-tags', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const result = await query(
      `SELECT tag_id, tag_name, tag_type, frozen_at FROM frozen_tags
       WHERE user_id = $1 AND unfrozen_at IS NULL
       ORDER BY frozen_at DESC`,
      [userId]
    );
    res.json({ tags: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch frozen tags' });
  }
});

// GET /api/user/vapid-public-key — VAPID public key for web push
router.get('/vapid-public-key', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const key = getVapidPublicKey();
    if (!key) {
      return res.status(503).json({ error: 'VAPID not configured' });
    }
    res.json({ publicKey: key });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get VAPID key' });
  }
});

// POST /api/user/push-subscribe — web push (VAPID)
router.post('/push-subscribe', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { endpoint, p256dh, auth } = req.body;
    if (!endpoint || !p256dh || !auth) {
      return res.status(400).json({ error: 'endpoint, p256dh, auth required' });
    }
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         is_active = TRUE`,
      [userId, endpoint, p256dh, auth]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save push subscription' });
  }
});

// POST /api/user/push-unsubscribe
router.post('/push-unsubscribe', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: 'endpoint required' });
    }
    await query(
      `UPDATE push_subscriptions SET is_active = FALSE WHERE user_id = $1 AND endpoint = $2`,
      [userId, endpoint]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

export default router;
