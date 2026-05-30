import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../config/db';
import { validate } from '../middleware/validate';
import { AddTagSchema } from '../schemas/user';
import { getRelatedTags, matchTagsByKeywords } from '../services/smartTagMatcher';
import { createUserTag, generateTagKeywords, getAllTagNames, detectTagTypeViaLLM, TAG_TYPE_LABELS, buildEnrichedKeywords } from '../services/tagManager';
import type { TagType, TagEnrichment } from '../services/tagManager';
import axios from 'axios';

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

// POST /api/user/tags — add a tag (auto-detects type via LLM)
router.post('/tags', authMiddleware, validate(AddTagSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { tagId, tagName, tagType } = req.body;

    if (!tagId || !tagName) {
      return res.status(400).json({ error: 'tagId and tagName required' });
    }

    // Check tag limit (10 for premium, 1 for free)
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
    const maxTags = isPremium ? 10 : 1;

    if (tagCount >= maxTags) {
      return res.status(403).json({
        error: `Tag limit reached (${maxTags}). Upgrade to Premium for more.`,
      });
    }

    // Auto-detect type if 'auto' or not provided
    const result = await createUserTag(userId, tagId, tagName, tagType);
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to create tag' });
    }

    const finalType = result.detectedType || tagType;

    res.status(201).json({
      tag: {
        tag_id: tagId,
        tag_name: tagName,
        tag_type: finalType,
        tag_type_label: TAG_TYPE_LABELS[finalType as TagType],
      },
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
      synonyms_en: enriched.synonyms_en || [],
      synonyms_ru: enriched.synonyms_ru || [],
      key_products: enriched.key_products || [],
      related_entities: enriched.related_entities || [],
      description: enriched.description || null,
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

// POST /api/user/tags/custom — создать пользовательский тег + backfill по всей базе
router.post('/tags/custom', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { tagName, tagType = 'auto' } = req.body;

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

    // Создаем тег (auto-detect type + LLM enrichment)
    const result = await createUserTag(userId, tagId, tagName, tagType);
    if (!result.success) {
      return res.status(500).json({ error: 'Failed to create tag' });
    }

    // Use enriched keywords for backfill (LLM synonyms + products + related entities)
    const keywords = result.enrichment
      ? buildEnrichedKeywords(tagName, result.enrichment)
      : generateTagKeywords(tagName);

    // BACKFILL: Ищем по ВСЕЙ базе новостей и привязываем тег
    console.log(`[TagBackfill] Starting backfill for "${tagId}" with ${keywords.length} keywords...`);
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
        tag_type: result.detectedType || tagType,
        tag_type_label: TAG_TYPE_LABELS[(result.detectedType || tagType) as TagType],
        keywords,
        enriched: !!result.enrichment,
      },
      enrichment: result.enrichment || null,
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
const KIMI_MODEL_SUMMARY = process.env.KIMI_MODEL || 'moonshot-v1-8k';

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
        temperature: KIMI_MODEL_SUMMARY.startsWith('kimi-k') ? 1 : 0.3,
        max_tokens: 500,
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

export default router;
