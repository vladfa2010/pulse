import axios from 'axios';
import { query } from '../config/db';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@pulse.app';
const SENDGRID_API = 'https://api.sendgrid.com/v3/mail/send';

// Check if email is configured
function isConfigured(): boolean {
  return !!SENDGRID_API_KEY && SENDGRID_API_KEY.startsWith('SG.');
}

// Send email via SendGrid
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!isConfigured()) {
    console.warn('[Email] SendGrid not configured');
    return false;
  }

  try {
    await axios.post(
      SENDGRID_API,
      {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: EMAIL_FROM, name: 'PULSE' },
        subject,
        content: [
          { type: 'text/html', value: html },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return true;
  } catch (err) {
    console.error('[Email] Send failed:', (err as Error).message);
    return false;
  }
}

// Send weekly report via email
export async function sendWeeklyReportEmail(userId: string, reportHtml: string): Promise<boolean> {
  try {
    // Get user email
    const userResult = await query(
      'SELECT email FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) return false;

    const email = userResult.rows[0].email;

    return await sendEmail(
      email,
      'PULSE — Еженедельный инвестиционный отчёт',
      `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a2e; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 640px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #0d1117 0%, #1a1a2e 100%); color: #fff; padding: 32px; text-align: center; }
    .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
    .content { padding: 32px; }
    .footer { background: #f8f9fa; padding: 20px 32px; text-align: center; color: #8e8e93; font-size: 12px; }
    .tag { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 500; margin: 2px; }
    .tag-positive { background: rgba(52,211,153,0.1); color: #10b981; border: 1px solid rgba(52,211,153,0.2); }
    .tag-negative { background: rgba(239,68,68,0.1); color: #ef4444; border: 1px solid rgba(239,68,68,0.2); }
    .tag-neutral { background: rgba(148,163,184,0.1); color: #94a3b8; border: 1px solid rgba(148,163,184,0.2); }
    a { color: #3b82f6; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>PULSE</h1>
      <p style="margin:8px 0 0; opacity:0.7; font-size:14px;">Еженедельный инвестиционный отчёт</p>
    </div>
    <div class="content">
      ${reportHtml}
    </div>
    <div class="footer">
      <p>Вы получили это письмо, потому что подписаны на PULSE.</p>
      <p><a href="#">Управление уведомлениями</a> · <a href="https://t.me/pulse_app_bot">Telegram бот</a></p>
    </div>
  </div>
</body>
</html>`
    );
  } catch (err) {
    console.error('[Email] Weekly report failed:', err);
    return false;
  }
}

// Send sentiment alert via email
export async function sendAlertEmail(userId: string, title: string, body: string): Promise<boolean> {
  try {
    // Check quiet hours
    const settingsResult = await query(
      `SELECT quiet_hours_enabled, quiet_hours_start, quiet_hours_end
       FROM notification_settings WHERE user_id = $1`,
      [userId]
    );

    const settings = settingsResult.rows[0];
    if (settings?.quiet_hours_enabled && isQuietHours(settings.quiet_hours_start, settings.quiet_hours_end)) {
      console.log(`[Email] Quiet hours, skipping alert for user ${userId}`);
      return false;
    }

    // Get user email
    const userResult = await query(
      'SELECT email FROM users WHERE id = $1',
      [userId]
    );

    if (userResult.rows.length === 0) return false;

    const email = userResult.rows[0].email;

    return await sendEmail(
      email,
      `PULSE Alert: ${title}`,
      `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif; max-width:600px; margin:0 auto; padding:20px;">
  <h2 style="color:#1a1a2e;">${title}</h2>
  <p>${body}</p>
  <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">
  <p style="color:#8e8e93; font-size:12px;">PULSE — <a href="https://t.me/pulse_app_bot">Telegram бот</a></p>
</body>
</html>`
    );
  } catch (err) {
    console.error('[Email] Alert failed:', err);
    return false;
  }
}

// ============================================================
// Helpers
// ============================================================

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
  return current >= startMinutes || current <= endMinutes;
}
