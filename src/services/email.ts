// ═══════════════════════════════════════════════════════════════════════════
// Email Module — Resend API
// ═══════════════════════════════════════════════════════════════════════════
// Provider: EMAIL_PROVIDER env var — 'resend' | 'none' (default: none)
// Resend:  https://resend.com — API key registration, 100 emails/day free
// ═══════════════════════════════════════════════════════════════════════════

import axios from 'axios';
import { isQuietHoursMsk } from './notifications/quietHours';
import type { LostFeatures, UserMonthlyStats } from './subscription';

const EMAIL_PROVIDER = process.env.EMAIL_PROVIDER || 'none';
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@pulse.inside-trade.ru';
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// Boot-лог эффективной конфигурации — без значений секретов, только факты.
// Потеря env или провайдер=none в проде видна в логах сразу при старте,
// а не по жалобам «письмо не пришло» (инцидент: неверифицированный домен
// pulse.app в дефолте EMAIL_FROM, письма молча отклонял Resend 403).
console.log(
  `[Email] Config: provider=${EMAIL_PROVIDER}, from=${EMAIL_FROM}, ` +
  `resend_key=${RESEND_API_KEY ? 'set' : 'MISSING'}`
);
if (process.env.NODE_ENV === 'production' && EMAIL_PROVIDER === 'none') {
  console.error('[Email] WARNING: EMAIL_PROVIDER не задан — все письма будут молча пропускаться!');
}
if (EMAIL_PROVIDER === 'resend' && !RESEND_API_KEY) {
  console.error('[Email] WARNING: EMAIL_PROVIDER=resend, но RESEND_API_KEY отсутствует — все письма будут молча пропускаться!');
}

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
    return isQuietHoursMsk(s.quiet_hours_start, s.quiet_hours_end);
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
  const FRONTEND_URL = process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru';
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin: 0; padding: 0; background: #0a0a0a;">
<div style="max-width:480px; margin:0 auto; background:#0a0a0a; padding:24px 16px; font-family: Arial, sans-serif;">
  <div style="background:#111111; border-radius:16px; overflow:hidden;">

    <!-- Шапка -->
    <div style="background:linear-gradient(135deg, #00D4FF, #0099CC); padding:32px 24px; text-align:center;">
      <div style="font-size:28px; font-weight:700; color:#060606; letter-spacing:2px;">PULSE</div>
      <div style="font-size:15px; color:#060606; opacity:0.8; margin-top:6px;">Добро пожаловать!</div>
    </div>

    <div style="padding:28px 24px;">

      <!-- Приветствие -->
      <div style="font-size:20px; font-weight:600; color:#ffffff; margin-bottom:12px;">
        Привет, ${escapeHtml(username)}!
      </div>
      <div style="font-size:14px; line-height:1.6; color:#b0b0b0; margin-bottom:20px;">
        Мы уже добавили вам стартовые теги <b style="color:#ffffff;">Сбербанк</b> и
        <b style="color:#ffffff;">Нефть</b> — и прямо сейчас фильтруем поток новостей,
        собирая для вас только то, что важно по этим темам.
        <b style="color:#ffffff;">Откройте PULSE и посмотрите свою ленту.</b>
      </div>

      <!-- Курс по платформе -->
      <div style="background:#1a1a1a; border:1px solid rgba(0,212,255,0.25); border-radius:12px; padding:20px; margin-bottom:24px;">
        <div style="font-size:15px; font-weight:600; color:#ffffff; margin-bottom:8px;">
          🎓 С чего начать?
        </div>
        <div style="font-size:13px; line-height:1.6; color:#b0b0b0; margin-bottom:14px;">
          У нас есть платформа знаний с курсами по работе с PULSE.
          Начните с курса по основам платформы — за несколько минут вы поймёте,
          что и для чего устроено:
        </div>
        <div style="font-size:13px; line-height:1.7; color:#b0b0b0; margin-bottom:16px;">
          <div style="margin-bottom:8px;">
            <span style="color:#00D4FF;">•</span>
            <b style="color:#ffffff;">Теги и лента</b> — как собрать новостной поток под свой портфель
          </div>
          <div style="margin-bottom:8px;">
            <span style="color:#00D4FF;">•</span>
            <b style="color:#ffffff;">Фактчекинг</b> — как проверять новости на достоверность силами ИИ
          </div>
          <div>
            <span style="color:#00D4FF;">•</span>
            <b style="color:#ffffff;">Поиск виральности</b> — как находить новости, которые начинают разлетаться
          </div>
        </div>
        <a href="https://pulse.inside-trade.ru/education/obuchenie-po-platforme-pulse-4d2c24ed"
           style="display:inline-block; padding:10px 20px; background:rgba(0,212,255,0.12); border:1px solid rgba(0,212,255,0.35); border-radius:9999px; color:#00D4FF; font-size:13px; font-weight:600; text-decoration:none;">
          Перейти к курсу →
        </a>
      </div>

      <!-- Три шага -->
      <div style="font-size:15px; font-weight:600; color:#ffffff; margin-bottom:12px;">
        Три шага на первую неделю
      </div>
      <div style="font-size:13px; line-height:1.7; color:#b0b0b0; margin-bottom:24px;">
        <div style="margin-bottom:10px;">
          <span style="color:#00D4FF; font-weight:700;">1.</span>
          Добавьте свои теги — до 3 бесплатно, лента соберётся под ваш портфель.<br>
          <a href="${FRONTEND_URL}/" style="color:#00D4FF; text-decoration:none; font-size:12px;">Настроить теги →</a>
        </div>
        <div style="margin-bottom:10px;">
          <span style="color:#00D4FF; font-weight:700;">2.</span>
          Прочитайте «Пульс рынка» — ИИ-саммари дня по вашим тегам.<br>
          <a href="${FRONTEND_URL}/" style="color:#00D4FF; text-decoration:none; font-size:12px;">Открыть саммари →</a>
        </div>
        <div>
          <span style="color:#00D4FF; font-weight:700;">3.</span>
          Подключите Telegram — дайджесты и еженедельный отчёт прямо в мессенджер.<br>
          <a href="${FRONTEND_URL}/profile/notifications" style="color:#00D4FF; text-decoration:none; font-size:12px;">Подключить Telegram →</a>
        </div>
      </div>

      <!-- Главная кнопка -->
      <div style="text-align:center; margin-bottom:20px;">
        <a href="${FRONTEND_URL}"
           style="display:inline-block; padding:14px 36px; background:linear-gradient(135deg, #00D4FF, #0099CC); color:#060606; font-size:16px; font-weight:700; border-radius:12px; text-decoration:none;">
          Открыть PULSE
        </a>
      </div>

      <!-- Приложение -->
      <div style="border-top:1px solid #222222; padding-top:20px; margin-bottom:20px; text-align:center;">
        <div style="font-size:14px; font-weight:600; color:#ffffff; margin-bottom:12px;">
          PULSE всегда под рукой
        </div>
        <div>
          <a href="${FRONTEND_URL}/download"
             style="display:inline-block; padding:10px 18px; margin:0 4px 8px; background:#1a1a1a; border:1px solid #333333; border-radius:10px; color:#ffffff; font-size:13px; font-weight:600; text-decoration:none;">
            <img src="${FRONTEND_URL}/email/icon-android.png" width="16" height="16" alt="" style="vertical-align:-3px; margin-right:8px;">Скачать для Android
          </a>
          <a href="https://pulse.inside-trade.ru/education/obuchenie-po-platforme-pulse-4d2c24ed"
             style="display:inline-block; padding:10px 18px; margin:0 4px 8px; background:#1a1a1a; border:1px solid #333333; border-radius:10px; color:#ffffff; font-size:13px; font-weight:600; text-decoration:none;">
            <img src="${FRONTEND_URL}/email/icon-apple.png" width="16" height="16" alt="" style="vertical-align:-3px; margin-right:8px;">Как установить на iPhone
          </a>
        </div>
      </div>

      <!-- Футер -->
      <div style="border-top:1px solid #222222; padding-top:16px; font-size:12px; line-height:1.6; color:#666666; text-align:center;">
        Есть вопросы — просто ответьте на это письмо.<br>
        © PULSE · <a href="${FRONTEND_URL}" style="color:#666666;">pulse.inside-trade.ru</a>
      </div>

    </div>
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

// ═══════════════════════════════════════════════════════════════════════════
// Subscription Expiry Emails (inline dark/glass PULSE style)
// ═══════════════════════════════════════════════════════════════════════════
const PULSE_EMAIL_CTA = (text: string, url: string) =>
  `<a href="${escapeHtml(url)}" style="display:inline-block;background:linear-gradient(135deg,#00D4FF,#0099CC);color:#060606;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(text)}</a>`;

const PULSE_EMAIL_HEADER = (title: string, subtitle: string) =>
  `<div style="background:linear-gradient(135deg,#00D4FF,#0099CC);padding:28px;text-align:center;">
     <h1 style="color:#060606;margin:0;font-size:22px;font-weight:700;">${escapeHtml(title)}</h1>
     <p style="color:rgba(6,6,6,0.75);margin:6px 0 0;font-size:13px;">${escapeHtml(subtitle)}</p>
   </div>`;

const PULSE_EMAIL_WRAPPER = (header: string, body: string, footer?: string) =>
  `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#0a0a0a;margin:0;padding:20px;color:#e5e5e5;">
<div style="max-width:480px;margin:0 auto;background:#111111;border-radius:16px;overflow:hidden;border:1px solid #222222;">
${header}
<div style="padding:28px;">${body}</div>
${footer || `<div style="text-align:center;padding:18px;border-top:1px solid #222222;font-size:12px;color:#555;">© PULSE</div>`}
</div></body></html>`;

function formatDateRu(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatPrice(amount: number): string {
  return `${amount.toLocaleString('ru-RU')} ₽`;
}

export async function sendExpiry4DaysAuto(
  to: string,
  data: { name: string; planName: string; expiresAt: string | Date; price: number; profileUrl: string }
): Promise<boolean> {
  const html = PULSE_EMAIL_WRAPPER(
    PULSE_EMAIL_HEADER('Подписка продлится автоматически', `PULSE ${escapeHtml(data.planName)}`),
    `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Привет, <strong>${escapeHtml(data.name)}</strong>!</p>
     <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Ваша подписка <strong>PULSE ${escapeHtml(data.planName)}</strong> активна до <strong>${formatDateRu(data.expiresAt)}</strong>. У вас включено автопродление — списание <strong>${formatPrice(data.price)}</strong> пройдёт автоматически.</p>
     <p style="font-size:15px;line-height:1.5;margin:0 0 24px;">Ничего делать не нужно.</p>
     <div style="text-align:center;margin:24px 0;">${PULSE_EMAIL_CTA('Управление подпиской', data.profileUrl)}</div>
     <p style="font-size:13px;color:#888;line-height:1.5;margin:0;">Если вы хотите отключить автопродление, нажмите кнопку выше.</p>`
  );
  return sendEmail(to, `PULSE — подписка ${data.planName} продлится автоматически`, html);
}

export async function sendExpiry4DaysManual(
  to: string,
  data: { name: string; planName: string; expiresAt: string | Date; price: number; profileUrl: string; lostFeatures: string[] }
): Promise<boolean> {
  const html = PULSE_EMAIL_WRAPPER(
    PULSE_EMAIL_HEADER('Подписка истекает через 4 дня', `PULSE ${escapeHtml(data.planName)}`),
    `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Привет, <strong>${escapeHtml(data.name)}</strong>!</p>
     <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Ваша подписка <strong>PULSE ${escapeHtml(data.planName)}</strong> заканчивается <strong>${formatDateRu(data.expiresAt)}</strong>. Автопродление отключено — подписка не продлится автоматически.</p>
     <div style="text-align:center;margin:24px 0;">${PULSE_EMAIL_CTA('Продлить подписку', data.profileUrl)}</div>
     <p style="font-size:14px;line-height:1.5;margin:24px 0 12px;color:#c9d1d9;">После ${formatDateRu(data.expiresAt)} вы перейдёте на Free и потеряете:</p>
     ${data.lostFeatures.map(f => `<div style="margin-bottom:10px;border-left:3px solid #00D4FF;padding-left:12px;color:#aaa;">${escapeHtml(f)}</div>`).join('')}`
  );
  return sendEmail(to, `PULSE — подписка ${data.planName} истекает через 4 дня`, html);
}

export async function sendExpiry1DayAuto(
  to: string,
  data: { name: string; planName: string; expiresAt: string | Date; price: number; profileUrl: string }
): Promise<boolean> {
  const html = PULSE_EMAIL_WRAPPER(
    PULSE_EMAIL_HEADER('Напоминание: завтра списание', `PULSE ${escapeHtml(data.planName)}`),
    `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Привет, <strong>${escapeHtml(data.name)}</strong>!</p>
     <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Завтра, <strong>${formatDateRu(data.expiresAt)}</strong>, будет автоматическое списание <strong>${formatPrice(data.price)}</strong> за продление подписки PULSE ${escapeHtml(data.planName)}.</p>
     <p style="font-size:15px;line-height:1.5;margin:0 0 24px;">Убедитесь, что на карте достаточно средств.</p>
     <div style="text-align:center;margin:24px 0;">${PULSE_EMAIL_CTA('Отключить автопродление', data.profileUrl)}</div>`
  );
  return sendEmail(to, `PULSE — завтра списание ${formatPrice(data.price)} за ${data.planName}`, html);
}

export async function sendExpiry1DayManual(
  to: string,
  data: { name: string; planName: string; expiresAt: string | Date; price: number; profileUrl: string; lostFeatures: string[] }
): Promise<boolean> {
  const html = PULSE_EMAIL_WRAPPER(
    PULSE_EMAIL_HEADER('Завтра подписка истекает', `PULSE ${escapeHtml(data.planName)}`),
    `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Привет, <strong>${escapeHtml(data.name)}</strong>!</p>
     <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Завтра, <strong>${formatDateRu(data.expiresAt)}</strong>, подписка <strong>PULSE ${escapeHtml(data.planName)}</strong> закончится.</p>
     <div style="text-align:center;margin:24px 0;">${PULSE_EMAIL_CTA('Срочно продлить — ' + formatPrice(data.price), data.profileUrl)}</div>
     <p style="font-size:14px;line-height:1.5;margin:24px 0 12px;color:#c9d1d9;">Что вы потеряете:</p>
     ${data.lostFeatures.map(f => `<div style="margin-bottom:10px;border-left:3px solid #00D4FF;padding-left:12px;color:#aaa;">${escapeHtml(f)}</div>`).join('')}`
  );
  return sendEmail(to, `PULSE — завтра истекает подписка ${data.planName}`, html);
}

export async function sendExpiredPaymentFailed(
  to: string,
  data: { name: string; planName: string; price: number; profileUrl: string }
): Promise<boolean> {
  const html = PULSE_EMAIL_WRAPPER(
    PULSE_EMAIL_HEADER('Мы заботимся о вашем доступе', 'Проверьте способ оплаты'),
    `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Привет, <strong>${escapeHtml(data.name)}</strong>!</p>
     <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Мы попытались продлить вашу подписку <strong>PULSE ${escapeHtml(data.planName)}</strong> автоматически, но списание не прошло.</p>
     <p style="font-size:14px;line-height:1.5;margin:0 0 16px;color:#c9d1d9;">Возможные причины:</p>
     <div style="margin-bottom:10px;border-left:3px solid #EF4444;padding-left:12px;color:#aaa;">Недостаточно средств на карте</div>
     <div style="margin-bottom:10px;border-left:3px solid #EF4444;padding-left:12px;color:#aaa;">Карта истекла</div>
     <div style="margin-bottom:10px;border-left:3px solid #EF4444;padding-left:12px;color:#aaa;">Банк заблокировал операцию</div>
     <p style="font-size:15px;line-height:1.5;margin:24px 0 20px;">Мы <strong>не отключаем</strong> вашу подписку. У вас есть 3 дня, чтобы обновить способ оплаты.</p>
     <div style="text-align:center;margin:24px 0;">${PULSE_EMAIL_CTA('Обновить карту', data.profileUrl)}</div>
     <p style="font-size:13px;color:#888;line-height:1.5;margin:0;">После обновления мы снова попробуем списать ${formatPrice(data.price)} и продлить подписку автоматически.</p>`
  );
  return sendEmail(to, `PULSE — проверьте способ оплаты для ${data.planName}`, html);
}

export async function sendExpiredToday(
  to: string,
  data: {
    name: string;
    planName: string;
    profileUrl: string;
    lostFeatures: LostFeatures;
    stats: UserMonthlyStats;
  }
): Promise<boolean> {
  const statsRows = [
    ['Всего новостей в мире', data.stats.totalNews.toLocaleString('ru-RU')],
    ['Отфильтровано по вашим тегам', `${data.stats.filteredNews.toLocaleString('ru-RU')} (${data.stats.noisePercent}% шума)`],
    ['AI-саммари сгенерировано', data.stats.aiSummaries.toLocaleString('ru-RU')],
    ['Sentiment-алерты сработали', data.stats.alertsCount.toLocaleString('ru-RU')],
    ['Экономия вашего времени', `~${data.stats.hoursSaved} часов`],
  ];

  const statsHtml = `<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #222222;border-radius:8px;overflow:hidden;margin:20px 0;">
${statsRows.map(([label, value], i) =>
  `<tr style="background:${i % 2 === 0 ? '#161616' : '#111111'};">
     <td style="padding:12px 16px;font-size:13px;color:#aaa;border-bottom:1px solid #222222;">${escapeHtml(label)}</td>
     <td style="padding:12px 16px;font-size:14px;color:#00D4FF;font-weight:600;text-align:right;border-bottom:1px solid #222222;">${escapeHtml(value)}</td>
   </tr>`).join('')}
</table>`;

  const html = PULSE_EMAIL_WRAPPER(
    PULSE_EMAIL_HEADER('Подписка истекла', 'Вот что вы потеряли и что мы сделали'),
    `<p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Привет, <strong>${escapeHtml(data.name)}</strong>!</p>
     <p style="font-size:15px;line-height:1.5;margin:0 0 20px;">Сегодня подписка <strong>PULSE ${escapeHtml(data.planName)}</strong> закончилась. Вы перешли на Free.</p>
     <p style="font-size:14px;line-height:1.5;margin:0 0 12px;color:#c9d1d9;">Вот что мы для вас сделали за последний месяц:</p>
     ${statsHtml}
     <p style="font-size:14px;line-height:1.5;margin:24px 0 12px;color:#c9d1d9;">Сейчас недоступно:</p>
     ${data.lostFeatures.features.map(f => `<div style="margin-bottom:10px;border-left:3px solid #00D4FF;padding-left:12px;color:#aaa;">${escapeHtml(f)}</div>`).join('')}
     <p style="font-size:15px;line-height:1.5;margin:24px 0 20px;"><strong>${data.lostFeatures.frozenCount}</strong> из <strong>${data.lostFeatures.tagCount}</strong> тегов заморожены — только 3 будут обновляться.</p>
     <div style="text-align:center;margin:24px 0;">${PULSE_EMAIL_CTA('Восстановить Premium', data.profileUrl)}</div>`
  );
  return sendEmail(to, `PULSE — подписка ${data.planName} истекла`, html);
}
