// ═══════════════════════════════════════════════════════════════════════════
// Email Module — Multi-provider: Resend API (primary) + Yandex SMTP (fallback)
// ═══════════════════════════════════════════════════════════════════════════
// Provider: EMAIL_PROVIDER env var — 'resend' | 'yandex' | 'none' (default: none)
// Resend:  https://resend.com — API key registration, 100 emails/day free
// Yandex:  https://yandex.ru — SMTP, password app required, 500/day
// ═══════════════════════════════════════════════════════════════════════════

import axios from 'axios';
// @ts-ignore — nodemailer types not installed
import nodemailer from 'nodemailer';

const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'none';
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@pulse.app';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const YANDEX_USER = process.env.YANDEX_USER;       // e.g. vladfa@ya.ru
const YANDEX_PASS = process.env.YANDEX_PASS;       // app password

// ═══════════════════════════════════════════════════════════════════════════
// Quiet hours check
// ═══════════════════════════════════════════════════════════════════════════
export async function isQuietHours(userId: string): Promise<boolean> {
  try {
    const { query } = await import('../config/db');
    const result = await query(
      `SELECT quiet_hours_enabled, quiet_hours_start, quiet_hours_end
       FROM notification_settings WHERE user_id = $1`,
      [userId]
    );
    const s = result.rows[0];
    if (!s || !s.quiet_hours_enabled) return false;

    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const nowStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

    if (s.quiet_hours_start < s.quiet_hours_end) {
      return nowStr >= s.quiet_hours_start && nowStr <= s.quiet_hours_end;
    } else {
      return nowStr >= s.quiet_hours_start || nowStr <= s.quiet_hours_end;
    }
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Send email (universal)
// ═══════════════════════════════════════════════════════════════════════════
export async function sendEmail(
  to: string, subject: string, html: string
): Promise<boolean> {
  if (EMAIL_PROVIDER === 'resend' && RESEND_API_KEY) {
    return sendViaResend(to, subject, html);
  }
  if (EMAIL_PROVIDER === 'yandex' && YANDEX_USER && YANDEX_PASS) {
    return sendViaYandex(to, subject, html);
  }
  console.log('[Email] No provider configured. Skipped.');
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Resend API
// ═══════════════════════════════════════════════════════════════════════════
async function sendViaResend(
  to: string, subject: string, html: string
): Promise<boolean> {
  try {
    const resp = await axios.post(
      'https://api.resend.com/emails',
      {
        from: EMAIL_FROM,
        to,
        subject,
        html,
      },
      {
        headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
        timeout: 30000,
      }
    );
    console.log('[Email] Resend OK:', resp.data?.id);
    return true;
  } catch (err: any) {
    console.error('[Email] Resend error:', err.response?.data || err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Yandex SMTP
// ═══════════════════════════════════════════════════════════════════════════
let yandexTransporter: nodemailer.Transporter | null = null;

function getYandexTransporter(): nodemailer.Transporter {
  if (!yandexTransporter) {
    yandexTransporter = nodemailer.createTransporter({
      host: 'smtp.yandex.ru',
      port: 465,
      secure: true,
      auth: {
        user: YANDEX_USER,
        pass: YANDEX_PASS,
      },
    });
  }
  return yandexTransporter;
}

async function sendViaYandex(
  to: string, subject: string, html: string
): Promise<boolean> {
  try {
    const info = await getYandexTransporter().sendMail({
      from: `"PULSE" <${YANDEX_USER}>`,
      to,
      subject,
      html,
    });
    console.log('[Email] Yandex OK:', info.messageId);
    return true;
  } catch (err: any) {
    console.error('[Email] Yandex error:', err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Password Reset Code Email
// ═══════════════════════════════════════════════════════════════════════════
export async function sendPasswordResetCodeEmail(
  to: string,
  code: string
): Promise<boolean> {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #0a0a0a; margin: 0; padding: 20px; color: #e5e5e5;">
<div style="max-width: 480px; margin: 0 auto; background: #111111; border-radius: 16px; overflow: hidden; border: 1px solid #222222;">
  <div style="background: linear-gradient(135deg, #00D4FF, #0099CC); padding: 28px; text-align: center;">
    <h1 style="color: #060606; margin: 0; font-size: 22px; font-weight: 700;">PULSE</h1>
    <p style="color: rgba(6,6,6,0.75); margin: 6px 0 0; font-size: 13px;">Восстановление пароля</p>
  </div>
  <div style="padding: 28px;">
    <p style="font-size: 15px; line-height: 1.5; margin: 0 0 20px;">Вы запросили восстановление пароля. Используйте код ниже. Он действителен <strong>15 минут</strong>.</p>
    <div style="text-align: center; margin: 24px 0;">
      <span style="display: inline-block; letter-spacing: 8px; font-size: 32px; font-weight: 700; font-family: monospace; background: #161616; border: 1px solid #222222; border-radius: 10px; padding: 14px 24px; color: #00D4FF;">${code}</span>
    </div>
    <p style="font-size: 13px; color: #888; line-height: 1.5; margin: 0;">Если вы не запрашивали восстановление, просто проигнорируйте это письмо.</p>
  </div>
  <div style="text-align: center; padding: 18px; border-top: 1px solid #222222; font-size: 12px; color: #555;">
    © PULSE
  </div>
</div>
</body></html>`;

  return sendEmail(to, 'PULSE — код для восстановления пароля', html);
}

// ═══════════════════════════════════════════════════════════════════════════
// Welcome Email
// ═══════════════════════════════════════════════════════════════════════════
export async function sendWelcomeEmail(
  to: string,
  username: string
): Promise<boolean> {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #0a0a0a; margin: 0; padding: 20px; color: #e5e5e5;">
<div style="max-width: 480px; margin: 0 auto; background: #111111; border-radius: 16px; overflow: hidden; border: 1px solid #222222;">
  <div style="background: linear-gradient(135deg, #00D4FF, #0099CC); padding: 28px; text-align: center;">
    <h1 style="color: #060606; margin: 0; font-size: 22px; font-weight: 700;">Добро пожаловать в PULSE</h1>
  </div>
  <div style="padding: 28px;">
    <p style="font-size: 15px; line-height: 1.5; margin: 0 0 16px;">Привет, <strong>${escapeHtml(username)}</strong>!</p>
    <p style="font-size: 15px; line-height: 1.5; margin: 0 0 20px;">Вы создали аккаунт в PULSE — сервисе персонализированных финансовых новостей. Добавляйте теги, отслеживайте рынок и получайте важные события первыми.</p>
    <div style="text-align: center; margin: 24px 0;">
      <a href="${process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru'}" style="display: inline-block; background: linear-gradient(135deg, #00D4FF, #0099CC); color: #060606; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 600;">Открыть PULSE</a>
    </div>
    <p style="font-size: 13px; color: #888; line-height: 1.5; margin: 0;">Если у вас есть вопросы, ответьте на это письмо.</p>
  </div>
  <div style="text-align: center; padding: 18px; border-top: 1px solid #222222; font-size: 12px; color: #555;">
    © PULSE
  </div>
</div>
</body></html>`;

  return sendEmail(to, 'Добро пожаловать в PULSE', html);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ═══════════════════════════════════════════════════════════════════════════
// Weekly Report Email
// ═══════════════════════════════════════════════════════════════════════════
export async function sendWeeklyReportEmail(
  to: string,
  articles: any[],
  stats: { total: number; positive: number; negative: number; neutral: number }
): Promise<boolean> {
  const html = formatReportHtml(articles, stats);
  return sendEmail(to, '📊 PULSE — Еженедельный отчёт', html);
}

function formatReportHtml(articles: any[], stats: any): string {
  const now = new Date();
  const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  const dateStr = `${pad(periodStart.getDate())}.${pad(periodStart.getMonth() + 1)} — ${pad(now.getDate())}.${pad(now.getMonth() + 1)}`;

  let html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: Arial,sans-serif; background: #f5f5f5; margin: 0; padding: 20px;">
<div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden;">
<div style="background: linear-gradient(135deg, #00D4FF, #0099CC); padding: 24px; text-align: center;">
<h1 style="color: #fff; margin: 0; font-size: 22px;">📊 Еженедельный отчёт PULSE</h1>
<p style="color: rgba(255,255,255,0.8); margin: 8px 0 0;">${dateStr}</p>
</div>
<div style="padding: 24px;">
<div style="background: #f8f9fa; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
<h3 style="margin: 0 0 12px; color: #333;">Статистика</h3>
<p style="margin: 4px 0; color: #666;">Всего новостей: <strong>${stats.total}</strong></p>
<p style="margin: 4px 0; color: #34D399;">🟢 Позитивных: ${stats.positive}</p>
<p style="margin: 4px 0; color: #EF4444;">🔴 Негативных: ${stats.negative}</p>
<p style="margin: 4px 0; color: #9CA3AF;">⚪ Нейтральных: ${stats.neutral}</p>
</div>`;

  // Group by tag
  const byTag: Record<string, any[]> = {};
  for (const a of articles) {
    for (const tag of (a.matched_tags || [])) {
      if (!byTag[tag]) byTag[tag] = [];
      byTag[tag].push(a);
    }
  }

  for (const [tag, items] of Object.entries(byTag).slice(0, 5)) {
    html += `<div style="margin-bottom: 16px; border-left: 3px solid #00D4FF; padding-left: 12px;">
<h4 style="margin: 0 0 8px; color: #333; text-transform: uppercase; font-size: 13px;">${tag}</h4>`;
    for (const a of items.slice(0, 3)) {
      const color = a.sentiment === 'positive' ? '#34D399' : a.sentiment === 'negative' ? '#EF4444' : '#9CA3AF';
      html += `<div style="margin-bottom: 8px; padding: 8px; background: #f8f9fa; border-radius: 6px;">
<p style="margin: 0 0 4px; font-size: 14px;"><span style="color: ${color};">●</span> ${a.title_ru}</p>
<a href="${a.url}" style="font-size: 12px; color: #00D4FF;">Читать →</a>
</div>`;
    }
    html += '</div>';
  }

  html += `<div style="text-align: center; margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee;">
<a href="https://pulse-frontend-jt53.onrender.com" style="display: inline-block; background: linear-gradient(135deg, #00D4FF, #0099CC); color: #fff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-size: 14px;">Открыть PULSE</a>
<p style="font-size: 11px; color: #999; margin-top: 12px;">
Управление уведомлениями: <a href="https://pulse-frontend-jt53.onrender.com/profile" style="color: #00D4FF;">Профиль</a>
</p></div></div></div></body></html>`;

  return html;
}

// ═══════════════════════════════════════════════════════════════════════════
// Instant Alert Email
// ═══════════════════════════════════════════════════════════════════════════
export async function sendAlertEmail(
  to: string, article: any
): Promise<boolean> {
  if (await isQuietHours(article.user_id)) return false;

  const sentimentEmoji =
    article.sentiment === 'positive' ? '🟢' :
    article.sentiment === 'negative' ? '🔴' : '⚪';

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: Arial,sans-serif; background: #f5f5f5; padding: 20px;">
<div style="max-width: 500px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px;">
<h2 style="margin: 0 0 12px;">${sentimentEmoji} ${article.title_ru}</h2>
<p style="color: #666; font-size: 14px;">${article.summary_ru || ''}</p>
<div style="margin-top: 16px;">
<a href="${article.url}" style="display: inline-block; background: #00D4FF; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 6px;">Читать полностью</a>
</div>
</div></body></html>`;

  return sendEmail(to, `${sentimentEmoji} ${article.title_ru.slice(0, 60)}`, html);
}
