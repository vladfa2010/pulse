/**
 * PULSE — Форматтеры контента по каналам.
 * Один контент (DigestContent) → три представления: TG HTML, Email HTML, Push.
 */

import { DigestArticle, DigestContent } from './digestContent';
import { WeeklyReportContent } from './weeklyReportContent';
import { FREQUENCY_LABELS } from './types';

const MAX_MESSAGE_LENGTH = 3900;
const MAX_DIGEST_MESSAGES = 3;
const SITE_URL = 'https://pulse.inside-trade.ru';

// ── Telegram (HTML, 1–3 сообщения) ──────────────────────────────────────────

export function formatDigestTelegram(content: DigestContent, frequency: string = '1h'): string[] {
  const { articles } = content;
  if (articles.length === 0) return [];

  const total = articles.length;
  const header = `🔔 <b>PULSE — непрочитанные новости</b>\n<i>${total} ${declineWord(total, 'новая', 'новые', 'новых')}</i>\n\n`;
  const footer = `━━━\n<a href="${SITE_URL}">Открыть PULSE →</a>\n<i>⏰ Следующая подборка — ${FREQUENCY_LABELS[frequency] || 'по расписанию'}</i>`;

  const blocks = articles.map((a, idx) => {
    const emoji = a.sentiment === 'positive' ? '🟢' : a.sentiment === 'negative' ? '🔴' : '⚪';
    return `${idx + 1}. ${emoji} <b>${escapeHtml(a.title)}</b>\n   📎 <a href="${a.url}">Читать на сайте</a> · <i>${escapeHtml(a.source)}</i>\n   🏷 ${escapeHtml(a.tag)}\n\n`;
  });

  const full = header + blocks.join('') + footer;
  if (full.length <= MAX_MESSAGE_LENGTH) return [full];

  const result = splitMessages(blocks, header, footer, 0, MAX_DIGEST_MESSAGES, true);
  return result ?? [header + tailForRemaining(blocks.length) + footer];
}

// ── Email (HTML-письмо) ─────────────────────────────────────────────────────

export function formatDigestEmail(content: DigestContent): { subject: string; html: string } {
  const { articles } = content;
  const subject = articles.length === 1
    ? 'PULSE: 1 новая статья по вашим тегам'
    : `PULSE: ${articles.length} новых статей по вашим тегам`;

  const items = articles.map(a => {
    const badge = a.sentiment === 'positive' ? '🟢' : a.sentiment === 'negative' ? '🔴' : '⚪';
    return `
      <div style="margin-bottom:12px;padding:12px;background:#fafafa;border-radius:8px;">
        <a href="${a.url}" style="font-weight:500;color:#1a1a2e;text-decoration:none;">
          ${badge} ${escapeHtml(a.title)}
        </a>
        <div style="margin-top:6px;color:#8e8e93;font-size:12px;">
          ${escapeHtml(a.source)} · 🏷 ${escapeHtml(a.tag)}
        </div>
      </div>`;
  }).join('');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">🔔 PULSE — непрочитанные новости</h2>
      ${items}
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0;">
      <a href="${SITE_URL}" style="color:#007aff;">Открыть PULSE →</a>
    </div>`;

  return { subject, html };
}

// ── Push (короткий текст) ───────────────────────────────────────────────────

export function formatDigestPush(content: DigestContent): { title: string; body: string; data: Record<string, string> } {
  const n = content.totalUnread;
  return {
    title: 'PULSE — непрочитанные новости',
    body: n === 1 ? '1 новая статья по вашим тегам' : `${n} новых статьи по вашим тегам`,
    data: { type: 'digest', count: String(n) },
  };
}

// ── Внутренние helpers (перенесены из digest.ts без изменений логики) ───────

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

function escapeHtml(text: string | null): string {
  if (!text) return 'Без названия';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function splitMessages(
  blocks: string[], header: string, footer: string,
  startIdx: number, maxMessages: number, isFirst: boolean
): string[] | null {
  if (maxMessages === 0) return null;
  const prefix = isFirst ? header : '';
  const remaining = blocks.slice(startIdx).join('');

  if (prefix.length + remaining.length + footer.length <= MAX_MESSAGE_LENGTH) {
    return [prefix + remaining + footer];
  }

  if (maxMessages === 1) {
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
    return [current + footer];
  }

  let current = prefix;
  let idx = startIdx;
  while (idx < blocks.length) {
    if (current.length + blocks[idx].length > MAX_MESSAGE_LENGTH) break;
    current += blocks[idx];
    idx++;
  }
  if (idx === startIdx) return null;

  const rest = splitMessages(blocks, header, footer, idx, maxMessages - 1, false);
  return rest ? [current, ...rest] : null;
}

export { DigestArticle, DigestContent };

export function formatDigestPreview(content: DigestContent): string {
  const n = content.totalUnread;
  if (n === 0) return 'Нет непрочитанных новостей';
  return `${n} ${declineWord(n, 'новая', 'новые', 'новых')} по вашим тегам`;
}

export function formatDigestTitle(content: DigestContent): string {
  const n = content.totalUnread;
  return n === 1 ? 'PULSE: 1 новая статья' : `PULSE: ${n} новых статей`;
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}

// ── Weekly Report (Telegram HTML) ───────────────────────────────────────────

export function formatWeeklyReportTelegram(content: WeeklyReportContent): string {
  let text = `📊 <b>PULSE — Еженедельный отчёт</b>\n`;
  text += `📅 ${content.period}\n\n`;

  text += `📈 Статистика:\n`;
  text += `   Всего новостей: ${content.totalArticles}\n`;
  text += `   🟢 Позитивных: ${content.sentimentBreakdown.positive}\n`;
  text += `   🔴 Негативных: ${content.sentimentBreakdown.negative}\n`;
  text += `   ⚪ Нейтральных: ${content.sentimentBreakdown.neutral}\n\n`;

  for (const tag of content.tagSummaries) {
    text += `━━━ <b>${escapeHtml(tag.tagName.toUpperCase())}</b> (${tag.articles.length}) ━━━\n\n`;

    for (const article of tag.articles.slice(0, 5)) {
      const emoji = article.sentiment === 'positive' ? '🟢' : article.sentiment === 'negative' ? '🔴' : '⚪';
      const date = formatShortDate(article.publishedAt);
      text += `${emoji} <a href="${article.url}">${escapeHtml(article.title)}</a>\n`;
      text += `   <i>${escapeHtml(article.source)}</i> · ${date}\n\n`;
    }

    if (tag.articles.length > 5) {
      text += `<i>…и ещё ${tag.articles.length - 5} новостей</i>\n\n`;
    }
  }

  text += `━━━\n<i>Отчёт составлен автоматически сервисом PULSE</i>`;
  return text;
}

function formatShortDate(d: Date): string {
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ── Weekly Report (Email HTML) ───────────────────────────────────────────────

export function formatWeeklyReportEmail(content: WeeklyReportContent): { subject: string; html: string } {
  const subject = '📊 PULSE — Еженедельный отчёт';

  let html = `<div style="margin-bottom:24px;">`;
  html += `<h3 style="color:#1a1a2e; margin:0 0 16px;">📊 Сводка за неделю</h3>`;
  html += `<div style="display:flex; gap:16px; margin-bottom:24px; flex-wrap:wrap;">`;
  html += statCardHtml(content.totalArticles.toString(), 'Всего новостей', '#10b981');
  html += statCardHtml(content.sentimentBreakdown.positive.toString(), 'Позитив', '#10b981');
  html += statCardHtml(content.sentimentBreakdown.negative.toString(), 'Негатив', '#ef4444');
  html += `</div></div>`;

  for (const tag of content.tagSummaries) {
    html += `<div style="margin-bottom:32px;">`;
    html += `<h4 style="color:#1a1a2e; margin:0 0 12px; padding-bottom:8px; border-bottom:2px solid #e5e7eb;">`;
    html += `${escapeHtml(tag.tagName)} <span style="color:#8e8e93; font-weight:400;">(${tag.articles.length})</span></h4>`;

    for (const article of tag.articles.slice(0, 5)) {
      const tagClass = article.sentiment === 'positive' ? 'tag-positive'
        : article.sentiment === 'negative' ? 'tag-negative' : 'tag-neutral';
      const sentimentLabel = article.sentiment === 'positive' ? 'Позитив'
        : article.sentiment === 'negative' ? 'Негатив' : 'Нейтрал';

      html += `<div style="margin-bottom:12px; padding:12px; background:#fafafa; border-radius:8px;">`;
      html += `<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">`;
      html += `<a href="${article.url}" style="font-weight:500; color:#1a1a2e; text-decoration:none; flex:1;">${escapeHtml(article.title)}</a>`;
      html += `<span class="tag ${tagClass}">${sentimentLabel}</span></div>`;
      html += `<div style="margin-top:6px; color:#8e8e93; font-size:12px;">`;
      html += `${escapeHtml(article.source)} · ${formatShortDate(article.publishedAt)}</div>`;
      html += `</div>`;
    }

    if (tag.articles.length > 5) {
      html += `<p style="color:#8e8e93; font-size:12px;">…и ещё ${tag.articles.length - 5} новостей</p>`;
    }

    html += `</div>`;
  }

  return { subject, html };
}

function statCardHtml(value: string, label: string, color: string): string {
  return `<div style="background:#f0fdf4; border-radius:8px; padding:12px 16px; min-width:100px;">` +
    `<div style="font-size:24px; font-weight:600; color:${color};">${value}</div>` +
    `<div style="font-size:12px; color:#6b7280;">${label}</div></div>`;
}

// ── Weekly Report (Push) ───────────────────────────────────────────────────

export function formatWeeklyReportPush(content: WeeklyReportContent): { title: string; body: string; data: Record<string, string> } {
  const n = content.totalArticles;
  return {
    title: '📊 PULSE — Еженедельный отчёт',
    body: n === 1 ? '1 новость за неделю' : `${n} новостей за неделю`,
    data: { type: 'weekly_report', count: String(n) },
  };
}
