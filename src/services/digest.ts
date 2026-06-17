/**
 * =============================================================================
 * PULSE — Telegram Digest Service
 * =============================================================================
 *
 * Периодическая рассылка непрочитанных новостей в Telegram.
 * - Проверка тарифа: Free = 1 тег, Premium = все теги
 * - Quiet hours: не шлём в тихие часы
 * - Настраиваемая частота: 1h, 3h, 6h, 12h, 24h
 * - Короткий формат: заголовок + ссылка на сайт
 */

import { query } from '../config/db';
import { sendTelegramMessage } from './telegram';
import cron from 'node-cron';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

// Frequency mapping: label -> hours
const FREQUENCY_HOURS: Record<string, number> = {
  '1h': 1,
  '3h': 3,
  '6h': 6,
  '12h': 12,
  '24h': 24,
};

// ═══════════════════════════════════════════════════════════════════════════
// Build digest for a single user
// ═══════════════════════════════════════════════════════════════════════════
interface DigestArticle {
  title: string;
  url: string;
  sentiment: string;
  source: string;
  tag: string;
}

async function buildDigest(userId: string, maxTags: number): Promise<DigestArticle[]> {
  // Get user's tags (limited by tariff)
  const portfolioResult = await query(
    `SELECT tag_id, tag_name FROM portfolios WHERE user_id = $1 LIMIT $2`,
    [userId, maxTags]
  );

  if (portfolioResult.rows.length === 0) return [];

  const tagRows = portfolioResult.rows;
  const tagIds = tagRows.map(r => r.tag_id);
  const tagNames: Record<string, string> = {};
  for (const r of tagRows) tagNames[r.tag_id] = r.tag_name;

  // TZ_TG_DIGEST_V3: hybrid filter — fetched_at for API sources, published_at for RSS
  let articlesResult;
  if (USE_SQLITE) {
    const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
    const likeParams = tagIds.map(id => `%"${id}"%`);
    const sincePublished = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const sinceFetched   = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const maxAge         = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    articlesResult = await query(
      `SELECT id, COALESCE(title_ru, title_original) as title, url, sentiment, source, matched_tags
       FROM news
       WHERE (${conditions})
         AND (fetched_at > ? OR published_at > ?)
         AND published_at > ?
         AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = ?)
       ORDER BY fetched_at DESC
       LIMIT 20`,
      [...likeParams, sinceFetched, sincePublished, maxAge, userId]
    );
  } else {
    const sincePublished = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const sinceFetched   = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const maxAge         = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    articlesResult = await query(
      `SELECT id, COALESCE(title_ru, title_original) as title, url, sentiment, source, matched_tags
       FROM news
       WHERE matched_tags && $1::text[]
         AND (fetched_at > $2 OR published_at > $3)
         AND published_at > $4
         AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = $5)
       ORDER BY GREATEST(fetched_at, published_at) DESC
       LIMIT 20`,
      [tagIds, sinceFetched, sincePublished, maxAge, userId]
    );
  }

  const articles: DigestArticle[] = [];
  for (const row of articlesResult.rows) {
    // Find which tag matched
    const matchedTags = row.matched_tags || [];
    const matchedTag = tagIds.find(t => matchedTags.includes(t)) || matchedTags[0] || '';
    articles.push({
      title: row.title,
      url: row.url,
      sentiment: row.sentiment || 'neutral',
      source: row.source,
      tag: tagNames[matchedTag] || matchedTag,
    });
  }

  return articles;
}

// ═══════════════════════════════════════════════════════════════════════════
// Format digest as Telegram HTML
// ═══════════════════════════════════════════════════════════════════════════
function formatDigest(articles: DigestArticle[]): string {
  if (articles.length === 0) return '';

  let text = `🔔 <b>PULSE — непрочитанные новости</b>\n`;
  text += `<i>${articles.length} новых</i>\n\n`;

  for (let i = 0; i < articles.length; i++) {
    const a = articles[i];
    const emoji = a.sentiment === 'positive' ? '🟢' : a.sentiment === 'negative' ? '🔴' : '⚪';
    text += `${i + 1}. ${emoji} <b>${escapeHtml(a.title)}</b>\n`;
    text += `   📎 <a href="${a.url}">Читать на сайте</a> · <i>${escapeHtml(a.source)}</i>\n`;
    text += `   🏷 ${escapeHtml(a.tag)}\n\n`;
  }

  text += `━━━\n`;
  text += `<a href="https://pulse-frontend-jt53.onrender.com">Открыть PULSE →</a>\n`;
  text += `<i>⏰ Следующая подборка через 1 час</i>`;

  return text;
}

function escapeHtml(text: string | null): string {
  if (!text) return 'Без названия';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════════════════
// Check quiet hours
// ═══════════════════════════════════════════════════════════════════════════
function isQuietHours(start: string, end: string): boolean {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return current >= startMinutes && current <= endMinutes;
  }
  // Crosses midnight
  return current >= startMinutes || current <= endMinutes;
}

// ═══════════════════════════════════════════════════════════════════════════
// Check if user is premium (subscription active and not expired)
// ═══════════════════════════════════════════════════════════════════════════
async function isPremium(userId: string): Promise<boolean> {
  const result = await query(
    `SELECT subscription_active, subscription_expires_at
     FROM users WHERE id = $1`,
    [userId]
  );
  if (result.rows.length === 0) return false;
  const row = result.rows[0];
  if (!row.subscription_active) return false;
  // Check expiry
  if (row.subscription_expires_at) {
    const expires = new Date(row.subscription_expires_at);
    if (expires < new Date()) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// Send digest to a single user
// ═══════════════════════════════════════════════════════════════════════════
export async function sendDigestToUser(userId: string): Promise<boolean> {
  try {
    // Get user's digest settings
    const settingsResult = await query(
      `SELECT ns.tg_digest_enabled, ns.digest_frequency, ns.quiet_hours_enabled,
              ns.quiet_hours_start, ns.quiet_hours_end, ns.last_digest_sent
       FROM notification_settings ns
       WHERE ns.user_id = $1`,
      [userId]
    );

    const settings = settingsResult.rows[0];
    if (!settings || !settings.tg_digest_enabled) return false;

    // Check quiet hours
    if (settings.quiet_hours_enabled && isQuietHours(settings.quiet_hours_start, settings.quiet_hours_end)) {
      console.log(`[Digest] Quiet hours for user ${userId}, skipping`);
      return false;
    }

    // Check frequency
    const freqHours = FREQUENCY_HOURS[settings.digest_frequency] || 3;
    if (settings.last_digest_sent) {
      const lastSent = new Date(settings.last_digest_sent);
      const hoursSince = (Date.now() - lastSent.getTime()) / (60 * 60 * 1000);
      if (hoursSince < freqHours) {
        console.log(`[Digest] Too early for user ${userId} (${hoursSince.toFixed(1)}h < ${freqHours}h)`);
        return false;
      }
    }

    // Check tariff
    const premium = await isPremium(userId);
    const maxTags = premium ? 25 : 1;

    // Build digest
    const articles = await buildDigest(userId, maxTags);
    if (articles.length === 0) {
      console.log(`[Digest] No articles for user ${userId}`);
      return false;
    }

    // Get chat_id
    const chatResult = await query(
      `SELECT target FROM user_channels WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
      [userId]
    );
    if (chatResult.rows.length === 0) return false;
    const chatId = chatResult.rows[0].target;

    // Format and send
    const text = formatDigest(articles);
    const ok = await sendTelegramMessage(chatId, text);

    if (ok) {
      // Update last_digest_sent
      await query(
        `UPDATE notification_settings SET last_digest_sent = NOW() WHERE user_id = $1`,
        [userId]
      );
      console.log(`[Digest] Sent ${articles.length} articles to user ${userId} (${premium ? 'premium' : 'free'}, ${maxTags} tag${maxTags > 1 ? 's' : ''})`);
    }

    return ok;
  } catch (err) {
    console.error(`[Digest] Failed for user ${userId}:`, err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Send digest NOW (manual request via /now — bypasses timing check)
// ═══════════════════════════════════════════════════════════════════════════
export async function sendDigestToUserNow(userId: string): Promise<boolean> {
  try {
    console.log(`[Digest] Manual digest for user ${userId}`);

    // Check tariff
    const premium = await isPremium(userId);
    const maxTags = premium ? 25 : 1;

    // Build digest
    const articles = await buildDigest(userId, maxTags);
    if (articles.length === 0) {
      console.log(`[Digest] No articles for user ${userId}`);
      return false;
    }

    // Get chat_id
    const chatResult = await query(
      `SELECT target FROM user_channels WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
      [userId]
    );
    if (chatResult.rows.length === 0) return false;
    const chatId = chatResult.rows[0].target;

    // Format and send
    const text = formatDigest(articles);
    const ok = await sendTelegramMessage(chatId, text);

    if (ok) {
      // Update last_digest_sent
      await query(
        `UPDATE notification_settings SET last_digest_sent = NOW() WHERE user_id = $1`,
        [userId]
      );
      console.log(`[Digest] Manual digest sent: ${articles.length} articles to user ${userId}`);
    }

    return ok;
  } catch (err) {
    console.error(`[Digest] Manual digest failed for ${userId}:`, err);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Send digests to ALL eligible users
// ═══════════════════════════════════════════════════════════════════════════
export async function sendAllDigests(): Promise<void> {
  console.log('[Digest] Starting digest distribution');

  // Audit log — для debug-cron endpoint
  try {
    await query(`INSERT INTO cron_log (task_name, started_at, status) VALUES ('digest', NOW(), 'running')`);
  } catch { /* ignore cron_log errors */ }

  // Find all PREMIUM users with TG digest enabled and active Telegram channel
  const usersResult = await query(
    `SELECT DISTINCT u.id
     FROM users u
     JOIN notification_settings ns ON ns.user_id = u.id
     JOIN user_channels uc ON uc.user_id = u.id
     WHERE u.subscription_active = TRUE
       AND ns.tg_digest_enabled = TRUE
       AND uc.channel = 'telegram'
       AND uc.is_active = TRUE
       AND EXISTS (SELECT 1 FROM portfolios p WHERE p.user_id = u.id LIMIT 1)`
  );

  console.log(`[Digest] Found ${usersResult.rows.length} users with digest enabled`);

  let sent = 0;
  let skipped = 0;

  for (const user of usersResult.rows) {
    const ok = await sendDigestToUser(user.id);
    if (ok) sent++;
    else skipped++;
    // Rate limit
    await sleep(300);
  }

  console.log(`[Digest] Done: ${sent} sent, ${skipped} skipped/empty`);

  // Audit log — finish
  try {
    await query(`INSERT INTO cron_log (task_name, started_at, finished_at, status, articles_fetched, articles_saved) VALUES ('digest', NOW(), NOW(), 'completed', ${sent + skipped}, ${sent})`);
  } catch { /* ignore cron_log errors */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Cron: every 1 hour
// ═══════════════════════════════════════════════════════════════════════════
export function startDigestCron() {
  console.log('[Digest] Scheduled for every hour (:00) MSK via setInterval');
  // Check every minute — trigger at :00 MSK (UTC+3)
  setInterval(() => {
    const now = new Date();
    const mskHour = (now.getUTCHours() + 3) % 24;
    const mskMinute = now.getUTCMinutes();
    if (mskMinute === 0) {
      console.log(`[Digest] Triggering at ${String(mskHour).padStart(2,'0')}:00 MSK`);
      sendAllDigests().catch(e => console.error('[Digest] sendAllDigests error:', e));
    }
  }, 60000); // check every minute
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
// v5.0 deploy attempt 1779922629
