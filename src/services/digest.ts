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
import { sendPushNotification } from './push';
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

const FREQUENCY_LABELS: Record<string, string> = {
  '1h': 'каждый час',
  '3h': 'каждые 3 часа',
  '6h': 'каждые 6 часов',
  '12h': '2 раза в сутки',
  '24h': 'раз в сутки',
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

async function buildDigest(userId: string, maxTags: number | null, lastDigestSent: Date | null, context: string = 'scheduled'): Promise<DigestArticle[]> {
  // Get user's tags (limited by tariff unless maxTags is null — manual /now uses all tags)
  const limitClause = maxTags !== null ? `LIMIT $2` : '';
  const limitParams = maxTags !== null ? [userId, maxTags] : [userId];
  const portfolioResult = await query(
    `SELECT tag_id, tag_name FROM portfolios WHERE user_id = $1 ${limitClause} ORDER BY created_at ASC`,
    limitParams
  );

  if (portfolioResult.rows.length === 0) {
    console.log(`[Digest:${context}] No tags for user ${userId}`);
    return [];
  }

  const tagRows = portfolioResult.rows;
  const tagIds = tagRows.map(r => r.tag_id);
  const tagNames: Record<string, string> = {};
  for (const r of tagRows) tagNames[r.tag_id] = r.tag_name;

  // TZ_TG_DIGEST_V3: hybrid filter — fetched_at for API sources, published_at for RSS
  // For scheduled digests: RSS window starts from last_digest_sent so no unread article is lost.
  // Fallback to 24 hours for manual /now or first-time users (was 3h — too narrow for "all unread").
  const rssFallbackSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rssSince = lastDigestSent ? lastDigestSent : rssFallbackSince;
  const sinceFetched   = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const maxAge         = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  console.log(`[Digest:${context}] user=${userId} maxTags=${maxTags ?? 'all'} tagCount=${tagIds.length} tags=[${tagIds.join(',')}] lastDigestSent=${lastDigestSent?.toISOString() ?? 'null'} rssSince=${rssSince.toISOString()} sinceFetched=${sinceFetched.toISOString()} maxAge=${maxAge.toISOString()}`);

  let articlesResult;
  if (USE_SQLITE) {
    const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
    const likeParams = tagIds.map(id => `%"${id}"%`);
    articlesResult = await query(
      `SELECT id, COALESCE(title_ru, title_original) as title, url, sentiment, source, matched_tags
       FROM news
       WHERE (${conditions})
         AND (fetched_at > ? OR published_at > ?)
         AND published_at > ?
         AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = ?)
       ORDER BY fetched_at DESC
       LIMIT 20`,
      [...likeParams, sinceFetched.toISOString(), rssSince.toISOString(), maxAge.toISOString(), userId]
    );
  } else {
    articlesResult = await query(
      `SELECT id, COALESCE(title_ru, title_original) as title, url, sentiment, source, matched_tags
       FROM news
       WHERE matched_tags && $1::text[]
         AND (fetched_at > $2 OR published_at > $3)
         AND published_at > $4
         AND id NOT IN (SELECT news_id FROM user_news_reads WHERE user_id = $5)
       ORDER BY GREATEST(fetched_at, published_at) DESC
       LIMIT 20`,
      [tagIds, sinceFetched.toISOString(), rssSince.toISOString(), maxAge.toISOString(), userId]
    );
  }

  console.log(`[Digest:${context}] user=${userId} candidateCount=${articlesResult.rows.length}`);

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

const MAX_MESSAGE_LENGTH = 3900;
const MAX_DIGEST_MESSAGES = 3;
const SITE_URL = 'https://pulse.inside-trade.ru';

// ═══════════════════════════════════════════════════════════════════════════
// Format digest as Telegram HTML (split into 1-3 messages)
// ═══════════════════════════════════════════════════════════════════════════
function declineWord(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function tailForRemaining(remaining: number): string {
  return `<i>…и ещё ${remaining} ${declineWord(remaining, 'статья', 'статьи', 'статей')} — <a href="${SITE_URL}">на сайте</a></i>\n\n`;
}

function formatDigestMessages(articles: DigestArticle[], frequency: string = '1h'): string[] {
  if (articles.length === 0) return [];

  const total = articles.length;
  const header = `🔔 <b>PULSE — непрочитанные новости</b>\n<i>${total} ${declineWord(total, 'новая', 'новые', 'новых')}</i>\n\n`;
  const footer = `━━━\n<a href="${SITE_URL}">Открыть PULSE →</a>\n<i>⏰ Следующая подборка — ${FREQUENCY_LABELS[frequency] || 'по расписанию'}</i>`;

  const blocks = articles.map((a, idx) => {
    const emoji = a.sentiment === 'positive' ? '🟢' : a.sentiment === 'negative' ? '🔴' : '⚪';
    return `${idx + 1}. ${emoji} <b>${escapeHtml(a.title)}</b>\n   📎 <a href="${a.url}">Читать на сайте</a> · <i>${escapeHtml(a.source)}</i>\n   🏷 ${escapeHtml(a.tag)}\n\n`;
  });

  // Everything fits in one message
  const full = header + blocks.join('') + footer;
  if (full.length <= MAX_MESSAGE_LENGTH) {
    return [full];
  }

  function splitMessages(startIdx: number, maxMessages: number, isFirst: boolean): string[] | null {
    if (maxMessages === 0) return null;
    const prefix = isFirst ? header : '';
    const remaining = blocks.slice(startIdx).join('');

    // All remaining blocks + footer fit in this message — this is the last one
    if (prefix.length + remaining.length + footer.length <= MAX_MESSAGE_LENGTH) {
      return [prefix + remaining + footer];
    }

    if (maxMessages === 1) {
      // Last possible message: as many as possible, then tail + footer
      let current = prefix;
      let idx = startIdx;
      while (idx < blocks.length) {
        const tail = tailForRemaining(blocks.length - idx - 1);
        if (current.length + blocks[idx].length + tail.length + footer.length > MAX_MESSAGE_LENGTH) break;
        current += blocks[idx];
        idx++;
      }
      const leftover = blocks.length - idx;
      if (leftover > 0) current += tailForRemaining(leftover);
      current += footer;
      return [current];
    }

    // Not the last message: fill greedily without footer
    let current = prefix;
    let idx = startIdx;
    while (idx < blocks.length) {
      if (current.length + blocks[idx].length > MAX_MESSAGE_LENGTH) break;
      current += blocks[idx];
      idx++;
    }
    if (idx === startIdx) return null;

    const rest = splitMessages(idx, maxMessages - 1, false);
    if (rest) return [current, ...rest];
    return null;
  }

  const result = splitMessages(0, MAX_DIGEST_MESSAGES, true);
  if (result) return result;

  // Fallback safety (should never be reached with 3 messages)
  return [header + tailForRemaining(blocks.length) + footer];
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
async function sendAllDigestMessages(chatId: string, messages: string[]): Promise<boolean> {
  for (let i = 0; i < messages.length; i++) {
    const ok = await sendTelegramMessage(chatId, messages[i]);
    if (!ok) {
      console.error(`[Digest] Failed to send part ${i + 1}/${messages.length} to chat ${chatId}`);
      return false;
    }
    if (i < messages.length - 1) await sleep(200);
  }
  return true;
}

export async function sendDigestToUser(userId: string): Promise<'sent' | 'empty' | 'error'> {
  try {
    // Get user's digest settings
    const settingsResult = await query(
      `SELECT ns.tg_digest_enabled, ns.push_enabled, ns.digest_frequency, ns.quiet_hours_enabled,
              ns.quiet_hours_start, ns.quiet_hours_end, ns.last_digest_sent
       FROM notification_settings ns
       WHERE ns.user_id = $1`,
      [userId]
    );

    const settings = settingsResult.rows[0];
    if (!settings || !settings.tg_digest_enabled) return 'empty';

    // Check quiet hours
    if (settings.quiet_hours_enabled && isQuietHours(settings.quiet_hours_start, settings.quiet_hours_end)) {
      console.log(`[Digest] Quiet hours for user ${userId}, skipping`);
      return 'empty';
    }

    // Check frequency
    const freqHours = FREQUENCY_HOURS[settings.digest_frequency] || 1;
    if (settings.last_digest_sent) {
      const lastSent = new Date(settings.last_digest_sent);
      const hoursSince = (Date.now() - lastSent.getTime()) / (60 * 60 * 1000);
      if (hoursSince < freqHours) {
        console.log(`[Digest] Too early for user ${userId} (${hoursSince.toFixed(1)}h < ${freqHours}h)`);
        return 'empty';
      }
    }

    // Check tariff
    const premium = await isPremium(userId);
    const maxTags = premium ? 25 : 1;

    // Build digest (use last_digest_sent for RSS window so nothing is lost)
    const lastDigestSent = settings.last_digest_sent ? new Date(settings.last_digest_sent) : null;
    const articles = await buildDigest(userId, maxTags, lastDigestSent, 'scheduled');
    if (articles.length === 0) {
      console.log(`[Digest:scheduled] No articles for user ${userId}`);
      return 'empty';
    }

    // Get chat_id
    const chatResult = await query(
      `SELECT target FROM user_channels WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
      [userId]
    );
    if (chatResult.rows.length === 0) return 'empty';
    const chatId = chatResult.rows[0].target;

    // Format and send all parts
    const messages = formatDigestMessages(articles, settings.digest_frequency);
    const ok = await sendAllDigestMessages(chatId, messages);

    if (!ok) return 'error';

    // Update last_digest_sent only after all parts are sent
    await query(
      `UPDATE notification_settings SET last_digest_sent = NOW() WHERE user_id = $1`,
      [userId]
    );
    console.log(`[Digest] Sent ${articles.length} articles to user ${userId} in ${messages.length} part(s) (${premium ? 'premium' : 'free'}, ${maxTags} tag${maxTags > 1 ? 's' : ''})`);

    // Also send push notification if enabled
    if (settings.push_enabled) {
      const pushBody = articles.length === 1
        ? '1 новая статья по вашим тегам'
        : `${articles.length} новых статьи по вашим тегам`;
      await sendPushNotification(
        userId,
        'PULSE — непрочитанные новости',
        pushBody,
        { type: 'digest', count: articles.length.toString() }
      );
    }

    return 'sent';
  } catch (err) {
    console.error(`[Digest] Failed for user ${userId}:`, err);
    return 'error';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Send digest NOW (manual request via /now — bypasses timing check)
// ═══════════════════════════════════════════════════════════════════════════
export async function sendDigestToUserNow(userId: string): Promise<'sent' | 'empty' | 'error'> {
  try {
    console.log(`[Digest:manual] Manual digest request for user ${userId}`);

    const premium = await isPremium(userId);
    console.log(`[Digest:manual] user=${userId} premium=${premium}`);

    // Build digest (manual /now uses ALL user tags like the site feed, not tariff limit)
    const articles = await buildDigest(userId, null, null, 'manual');
    if (articles.length === 0) {
      console.log(`[Digest:manual] No articles for user ${userId}`);
      return 'empty';
    }

    // Get chat_id
    const chatResult = await query(
      `SELECT target FROM user_channels WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
      [userId]
    );
    if (chatResult.rows.length === 0) return 'empty';
    const chatId = chatResult.rows[0].target;

    // Format and send all parts
    const messages = formatDigestMessages(articles);
    const ok = await sendAllDigestMessages(chatId, messages);

    if (!ok) return 'error';

    // Update last_digest_sent only after all parts are sent
    await query(
      `UPDATE notification_settings SET last_digest_sent = NOW() WHERE user_id = $1`,
      [userId]
    );
    console.log(`[Digest:manual] Sent ${articles.length} articles to user ${userId} in ${messages.length} part(s)`);

    return 'sent';
  } catch (err) {
    console.error(`[Digest] Manual digest failed for ${userId}:`, err);
    return 'error';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Send digests to ALL eligible users
// ═══════════════════════════════════════════════════════════════════════════
export async function sendAllDigests(): Promise<void> {
  console.log('[Digest] Starting digest distribution');

  // Cleanup old duplicate digest rows (pre-fix leftovers). Keep only the latest one.
  try {
    const latestDigest = await query(
      `SELECT id FROM cron_log WHERE task_name = 'digest' ORDER BY started_at DESC LIMIT 1`
    );
    if (latestDigest.rows.length > 0) {
      const keepId = latestDigest.rows[0].id;
      await query(
        `DELETE FROM cron_log WHERE task_name = 'digest' AND id <> $1`,
        [keepId]
      );
    }
  } catch { /* ignore cleanup errors */ }

  // Audit log — single row per digest task (update if exists, insert otherwise)
  try {
    const updatedStart = await query(
      `UPDATE cron_log SET started_at = NOW(), status = 'running', finished_at = NULL, articles_fetched = NULL, articles_saved = NULL WHERE task_name = 'digest'`
    );
    if (updatedStart.rowCount === 0) {
      await query(`INSERT INTO cron_log (task_name, started_at, status) VALUES ('digest', NOW(), 'running')`);
    }
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
  let errors = 0;

  for (const user of usersResult.rows) {
    const result = await sendDigestToUser(user.id);
    if (result === 'sent') sent++;
    else if (result === 'error') errors++;
    else skipped++;
    // Rate limit
    await sleep(300);
  }

  console.log(`[Digest] Done: ${sent} sent, ${skipped} skipped/empty, ${errors} errors`);

  // Audit log — finish
  try {
    await query(
      `UPDATE cron_log SET finished_at = NOW(), status = 'completed', articles_fetched = $1, articles_saved = $2 WHERE task_name = 'digest'`,
      [sent + skipped + errors, sent]
    );
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
