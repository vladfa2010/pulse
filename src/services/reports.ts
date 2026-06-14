import cron from 'node-cron';
import { query } from '../config/db';
import { sendWeeklyReport } from './telegram';
import { sendWeeklyReportEmail } from './email';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

// ============================================================
// Report Generation
// ============================================================

interface ReportData {
  period: string;
  tagSummaries: TagSummary[];
  totalArticles: number;
  sentimentBreakdown: { positive: number; negative: number; neutral: number };
}

interface TagSummary {
  tagId: string;
  tagName: string;
  articles: Article[];
}

interface Article {
  title: string;
  summary: string;
  source: string;
  url: string;
  publishedAt: Date;
  sentiment: string;
}

// Generate report for a user
async function generateReportForUser(userId: string): Promise<ReportData | null> {
  // Get user's tags
  const portfolioResult = await query(
    `SELECT tag_id, tag_name FROM portfolios WHERE user_id = $1`,
    [userId]
  );

  if (portfolioResult.rows.length === 0) return null;

  const tagIds = portfolioResult.rows.map(r => r.tag_id);
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Get news for user's tags from last 7 days
  let newsResult;
  if (USE_SQLITE) {
    // SQLite: matched_tags stored as JSON text, use LIKE for each tag
    const conditions = tagIds.map((_, i) => `matched_tags LIKE $${i + 1}`).join(' OR ');
    const likeParams = tagIds.map((id: string) => `%"${id}"%`);
    newsResult = await query(
      `SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags
       FROM news
       WHERE (${conditions})
         AND published_at > $${tagIds.length + 1}
       ORDER BY published_at DESC
       LIMIT 200`,
      [...likeParams, since]
    );
  } else {
    newsResult = await query(
      `SELECT title_ru, summary_ru, source, url, published_at, sentiment, matched_tags
       FROM news
       WHERE matched_tags && $1::text[]
         AND published_at > $2
       ORDER BY published_at DESC
       LIMIT 200`,
      [tagIds, since]
    );
  }

  const articles = newsResult.rows;
  if (articles.length === 0) return null;

  // Group by tag
  const tagMap = new Map<string, TagSummary>();
  for (const row of portfolioResult.rows) {
    tagMap.set(row.tag_id, { tagId: row.tag_id, tagName: row.tag_name, articles: [] });
  }

  const sentimentBreakdown = { positive: 0, negative: 0, neutral: 0 };

  for (const article of articles) {
    const sentiment = article.sentiment || 'neutral';
    sentimentBreakdown[sentiment as keyof typeof sentimentBreakdown]++;

    // Add article to each matching tag
    for (const tagId of article.matched_tags || []) {
      if (tagMap.has(tagId)) {
        tagMap.get(tagId)!.articles.push({
          title: article.title_ru,
          summary: article.summary_ru,
          source: article.source,
          url: article.url,
          publishedAt: article.published_at,
          sentiment,
        });
      }
    }
  }

  // Remove tags with no articles
  const tagSummaries = Array.from(tagMap.values()).filter(t => t.articles.length > 0);

  if (tagSummaries.length === 0) return null;

  return {
    period: `${formatDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))} — ${formatDate(new Date())}`,
    tagSummaries,
    totalArticles: articles.length,
    sentimentBreakdown,
  };
}

// Format report as text for Telegram
function formatReportText(data: ReportData): string {
  let text = `📊 <b>PULSE — Еженедельный отчёт</b>\n`;
  text += `📅 ${data.period}\n\n`;

  text += `📈 Статистика:\n`;
  text += `   Всего новостей: ${data.totalArticles}\n`;
  text += `   🟢 Позитивных: ${data.sentimentBreakdown.positive}\n`;
  text += `   🔴 Негативных: ${data.sentimentBreakdown.negative}\n`;
  text += `   ⚪ Нейтральных: ${data.sentimentBreakdown.neutral}\n\n`;

  for (const tag of data.tagSummaries) {
    text += `━━━ <b>${tag.tagName.toUpperCase()}</b> (${tag.articles.length}) ━━━\n\n`;

    for (const article of tag.articles.slice(0, 5)) {
      const emoji = article.sentiment === 'positive' ? '🟢' : article.sentiment === 'negative' ? '🔴' : '⚪';
      const date = formatShortDate(article.publishedAt);
      text += `${emoji} <a href="${article.url}">${article.title}</a>\n`;
      text += `   <i>${article.source}</i> · ${date}\n\n`;
    }

    if (tag.articles.length > 5) {
      text += `<i>…и ещё ${tag.articles.length - 5} новостей</i>\n\n`;
    }
  }

  text += `━━━\n<i>Отчёт составлен автоматически сервисом PULSE</i>`;
  return text;
}

// Format report as HTML for email
function formatReportHtml(data: ReportData): string {
  let html = `<div style="margin-bottom:24px;">`;
  html += `<h3 style="color:#1a1a2e; margin:0 0 16px;">📊 Сводка за неделю</h3>`;
  html += `<div style="display:flex; gap:16px; margin-bottom:24px; flex-wrap:wrap;">`;
  html += `<div style="background:#f0fdf4; border-radius:8px; padding:12px 16px; min-width:100px;">`;
  html += `<div style="font-size:24px; font-weight:600; color:#10b981;">${data.totalArticles}</div>`;
  html += `<div style="font-size:12px; color:#6b7280;">Всего новостей</div></div>`;
  html += `<div style="background:#f0fdf4; border-radius:8px; padding:12px 16px; min-width:80px;">`;
  html += `<div style="font-size:24px; font-weight:600; color:#10b981;">${data.sentimentBreakdown.positive}</div>`;
  html += `<div style="font-size:12px; color:#6b7280;">Позитив</div></div>`;
  html += `<div style="background:#fef2f2; border-radius:8px; padding:12px 16px; min-width:80px;">`;
  html += `<div style="font-size:24px; font-weight:600; color:#ef4444;">${data.sentimentBreakdown.negative}</div>`;
  html += `<div style="font-size:12px; color:#6b7280;">Негатив</div></div>`;
  html += `</div></div>`;

  for (const tag of data.tagSummaries) {
    html += `<div style="margin-bottom:32px;">`;
    html += `<h4 style="color:#1a1a2e; margin:0 0 12px; padding-bottom:8px; border-bottom:2px solid #e5e7eb;">`;
    html += `${tag.tagName} <span style="color:#8e8e93; font-weight:400;">(${tag.articles.length})</span></h4>`;

    for (const article of tag.articles.slice(0, 5)) {
      const tagClass = article.sentiment === 'positive' ? 'tag-positive'
        : article.sentiment === 'negative' ? 'tag-negative' : 'tag-neutral';
      const sentimentLabel = article.sentiment === 'positive' ? 'Позитив'
        : article.sentiment === 'negative' ? 'Негатив' : 'Нейтрал';

      html += `<div style="margin-bottom:12px; padding:12px; background:#fafafa; border-radius:8px;">`;
      html += `<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">`;
      html += `<a href="${article.url}" style="font-weight:500; color:#1a1a2e; text-decoration:none; flex:1;">${article.title}</a>`;
      html += `<span class="tag ${tagClass}">${sentimentLabel}</span></div>`;
      html += `<div style="margin-top:6px; color:#8e8e93; font-size:12px;">`;
      html += `${article.source} · ${formatShortDate(article.publishedAt)}</div>`;
      html += `</div>`;
    }

    if (tag.articles.length > 5) {
      html += `<p style="color:#8e8e93; font-size:12px;">…и ещё ${tag.articles.length - 5} новостей</p>`;
    }

    html += `</div>`;
  }

  return html;
}

// ============================================================
// Main: Send reports to all premium users
// ============================================================

export async function sendAllWeeklyReports(): Promise<void> {
  console.log('[Reports] Starting weekly report distribution');

  // Get all premium users
  const usersResult = await query(
    `SELECT u.id
     FROM users u
     WHERE u.subscription_active = TRUE
       AND EXISTS (SELECT 1 FROM portfolios p WHERE p.user_id = u.id LIMIT 1)`
  );

  console.log(`[Reports] Found ${usersResult.rows.length} premium users with tags`);

  let sent = 0;
  let failed = 0;

  for (const user of usersResult.rows) {
    try {
      // Get user's notification settings
      const settingsResult = await query(
        `SELECT tg_enabled, email_enabled, report_format
         FROM notification_settings WHERE user_id = $1`,
        [user.id]
      );

      const settings = settingsResult.rows[0] || { tg_enabled: true, email_enabled: true, report_format: 'full' };

      // Generate report
      const reportData = await generateReportForUser(user.id);
      if (!reportData) {
        console.log(`[Reports] No data for user ${user.id}, skipping`);
        continue;
      }

      // Send via Telegram
      if (settings.tg_enabled) {
        const text = formatReportText(reportData);
        const ok = await sendWeeklyReport(user.id, text);
        if (ok) sent++;
      }

      // Send via Email
      if (settings.email_enabled) {
        const html = formatReportHtml(reportData);
        const emailResult = await query(`SELECT email FROM users WHERE id = $1`, [user.id]);
        const userEmail = emailResult.rows[0]?.email;
        if (userEmail) {
          const stats = reportData.sentimentBreakdown;
          const ok = await sendWeeklyReportEmail(userEmail, reportData.tagSummaries.flatMap(t => t.articles), { total: reportData.totalArticles, ...stats });
          if (ok) sent++;
        }
      }

      // Rate limit
      await sleep(200);
    } catch (err) {
      console.error(`[Reports] Failed for user ${user.id}:`, err);
      failed++;
    }
  }

  console.log(`[Reports] Done: ${sent} sent, ${failed} failed`);
}

// ============================================================
// Cron: Sunday 13:00 MSK
// ============================================================

// ============================================================
// Manual: Send weekly report to single user
// ============================================================

export async function sendWeeklyReportForUser(userId: string): Promise<{ sent: boolean; message: string }> {
  try {
    // Check user has tags
    const hasTags = await query(
      `SELECT 1 FROM portfolios WHERE user_id = $1 LIMIT 1`,
      [userId]
    );
    if (hasTags.rows.length === 0) {
      return { sent: false, message: 'User has no tags in portfolio' };
    }

    // Generate report
    const reportData = await generateReportForUser(userId);
    if (!reportData) {
      return { sent: false, message: 'No report data generated (no news for tags)' };
    }

    // Send via Telegram
    const text = formatReportText(reportData);
    const ok = await sendWeeklyReport(userId, text);

    if (ok) {
      return { sent: true, message: `Weekly report sent to user ${userId}` };
    } else {
      return { sent: false, message: 'Failed to send Telegram message' };
    }
  } catch (err: any) {
    return { sent: false, message: `Error: ${err.message}` };
  }
}

// ============================================================
// Cron: Sunday 13:00 MSK
// ============================================================

export function startReportCron() {
  console.log('[Reports] Scheduled for every Sunday at 13:00 MSK');
  // Sunday 13:00 = '0 13 * * 0'
  cron.schedule('0 13 * * 0', () => {
    console.log('[Reports] Triggering weekly reports');
    sendAllWeeklyReports();
  }, {
    timezone: 'Europe/Moscow',
  });
}

// ============================================================
// Helpers
// ============================================================

function formatDate(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

function formatShortDate(d: Date): string {
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
