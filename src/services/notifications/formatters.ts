/**
 * PULSE — Форматтеры контента по каналам.
 * Один контент (DigestContent) → три представления: TG HTML, Email HTML, Push.
 */

import { DigestArticle, DigestContent } from './digestContent';
import { WeeklyReportContent } from './weeklyReportContent';
import { WeeklyAISummaries } from './weeklySummaryAI';
import { statsCurrentTotal } from './weeklyStats';
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
  const first = content.articles[0];

  if (n === 0 || !first) {
    return {
      title: 'Нет непрочитанных новостей',
      body: 'Новые статьи по вашим тегам появятся позже',
      data: { type: 'digest', count: '0' },
    };
  }

  const title = truncateTextSmart(first.title, PUSH_TITLE_MAX);

  let body: string;
  if (n === 1) {
    // summary в DigestArticle отсутствует — показываем контекст: источник и тег.
    const ctx = [first.source, first.tag].filter(Boolean).join(' · ');
    body = truncateTextSmart(ctx, PUSH_BODY_MAX) || '1 новая статья';
  } else {
    body = `+ ещё ${n - 1} ${declineWord(n - 1, 'статья', 'статьи', 'статей')}`;
  }

  return {
    title,
    body,
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

/**
 * Обрезка по границе слова: ищем последний пробел перед лимитом.
 * Если пробел найден не раньше половины лимита — режем по нему,
 * иначе жёсткая обрезка (защита от длинного первого слова/URL).
 */
export function truncateTextSmart(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const cutAt = text.lastIndexOf(' ', maxLength - 1);
  if (cutAt > maxLength * 0.5) {
    return text.slice(0, cutAt) + '…';
  }
  return text.slice(0, maxLength - 1) + '…';
}

// Единый источник лимитов push-уведомлений (ТЗ push v3.0):
// title — 60 симв. (iPhone SE ~50–60), body — 140 (iOS ~120–140)
export const PUSH_TITLE_MAX = 60;
export const PUSH_BODY_MAX = 140;

// ── Weekly Report: дистрибуция «сводка + ссылка» (ТЗ-191, Задача 5) ─────────

/**
 * Опции доставки weekly_report после ТЗ-191: письмо/Telegram — короткая
 * сводка + ссылка на страницу отчёта (magic-link ?k=), полный текст живёт
 * на странице. AI-саммари приходит из payload снапшота (фаза генерации);
 * при отсутствии (LLM недоступен / stats без ai) сводка строится без него.
 */
export interface WeeklyReportDeliveryOptions {
  /** Полный URL страницы отчёта с токеном и UTM (диспетчер); без него — без кнопки */
  reportUrl?: string;
  /** AI-саммари из снапшота */
  ai?: WeeklyAISummaries | null;
}

/** Топ-3 тега недели со счётчиками (для сводки в письме/Telegram) */
function weeklyTopTags(content: WeeklyReportContent, limit = 3): Array<{ tagName: string; count: number }> {
  const tagCount = new Map<string, number>();
  if (content.stats) {
    for (const t of content.stats.perTag) tagCount.set(t.tagId, t.current);
  }
  const sorted = [...content.tagSummaries].sort((a, b) =>
    (tagCount.get(b.tagId) ?? b.articles.length) - (tagCount.get(a.tagId) ?? a.articles.length)
  );
  return sorted.slice(0, limit).map((t) => ({
    tagName: t.tagName,
    count: tagCount.get(t.tagId) ?? t.articles.length,
  }));
}

/** Первый абзац общего AI-саммари (для письма — целиком не нужен) */
function firstParagraph(text: string): string {
  return text.split(/\n\s*\n/)[0]?.trim() ?? '';
}

// ── Weekly Report (Telegram HTML) ───────────────────────────────────────────

/**
 * ТЗ-191 Задача 5: формат рассылки — «сводка + ссылка», полный отчёт на странице.
 * Тело: статистика + общее AI-саммари целиком + топ-3 тега со счётчиками;
 * ссылку с magic-токеном несёт inline-кнопка (диспетчер, reply_markup).
 * Все внешние строки (имена тегов, саммари LLM) — escapeHtml: caption и
 * текст парсятся Telegram как HTML. Счётчики — из stats (ТЗ-184), при
 * stats=null — fallback на старые значения из списка статей.
 */
export function formatWeeklyReportTelegram(
  content: WeeklyReportContent,
  opts: WeeklyReportDeliveryOptions = {}
): string {
  const stats = content.stats;
  const total = stats ? statsCurrentTotal(stats) : content.totalArticles;
  const breakdown = stats
    ? { positive: stats.sentiment.positive, negative: stats.sentiment.negative, neutral: stats.sentiment.neutral }
    : content.sentimentBreakdown;

  let text = `📊 <b>PULSE — Еженедельный отчёт</b>\n`;
  text += `📅 ${content.period}\n\n`;

  text += `📈 Статистика:\n`;
  text += `   Всего новостей: ${total}\n`;
  text += `   🟢 Позитивных: ${breakdown.positive}\n`;
  text += `   🔴 Негативных: ${breakdown.negative}\n`;
  text += `   ⚪ Нейтральных: ${breakdown.neutral}\n\n`;

  const overall = opts.ai?.overall;
  if (overall) {
    text += `🧠 <b>Итоги недели:</b>\n${escapeHtml(overall)}\n\n`;
  }

  const top = weeklyTopTags(content);
  if (top.length > 0) {
    text += `🏷 <b>Главные темы:</b>\n`;
    for (let i = 0; i < top.length; i++) {
      text += `${i + 1}. ${escapeHtml(top[i].tagName)} — ${top[i].count}\n`;
    }
    text += `\n`;
  }

  text += `<i>Полный отчёт — на странице PULSE (кнопка ниже)</i>`;
  return text;
}

/**
 * Caption для sendPhoto (ТЗ-184): заголовок + KPI одной строкой.
 * Telegram лимит caption — 1024 символа. null — когда нет stats (фото не шлём).
 */
export function formatWeeklyReportChartCaption(content: WeeklyReportContent): string | null {
  const stats = content.stats;
  if (!stats) return null;
  const total = statsCurrentTotal(stats);
  const fmtDelta = (pct: number | null) =>
    pct === null ? '—' : `${pct > 0 ? '▲' : pct < 0 ? '▼' : ''}${Math.round(pct)}%`;
  const topTag = stats.perTag.find(t => t.tagId === stats.kpis.topTagId);
  const topTagName = topTag ? topTag.tagName : null;

  let caption = `📊 <b>PULSE — Еженедельный отчёт</b>\n`;
  caption += `📅 ${content.period}\n`;
  caption += `Всего новостей: ${total}`;
  caption += ` (${fmtDelta(stats.kpis.totalDeltaWeekPct)} к пр. неделе`;
  caption += ` · ${fmtDelta(stats.kpis.totalDeltaMonthPct)} к мес. среднему)`;
  if (topTagName) {
    // имя тега задаёт юзер — escape для Telegram HTML parse_mode
    caption += `\nСамый обсуждаемый: ${escapeHtml(topTagName)}`;
  }
  return caption.length > 1024 ? caption.slice(0, 1023) + '…' : caption;
}

// ── Weekly Report (Email HTML) ───────────────────────────────────────────────

/**
 * ТЗ-191 Задача 5: письмо — сводка + ссылка. Тело: PNG-инфографика (ТЗ-184,
 * inline cid:), KPI-карточки (всего/позитив/негатив), первый абзац общего
 * AI-саммари, топ-3 тега со счётчиками и кнопка «Открыть полный отчёт»
 * (magic-link с токеном). Фолбэк для клиентов без картинок — табличная
 * вёрстка читается и без PNG. Все внешние строки — escapeHtml.
 */
export function formatWeeklyReportEmail(
  content: WeeklyReportContent,
  opts: WeeklyReportDeliveryOptions & { withChart?: boolean } = {}
): { subject: string; html: string } {
  const subject = '📊 PULSE — Еженедельный отчёт';

  const stats = content.stats;
  const total = stats ? statsCurrentTotal(stats) : content.totalArticles;
  const breakdown = stats
    ? { positive: stats.sentiment.positive, negative: stats.sentiment.negative, neutral: stats.sentiment.neutral }
    : content.sentimentBreakdown;

  let html = `<div style="margin-bottom:24px;">`;
  // ТЗ-184: инфографика в начале письма — inline-вложение cid:weekly-chart
  if (opts.withChart) {
    html += `<img src="cid:weekly-chart" alt="Инфографика недели" style="width:100%;max-width:640px;border-radius:12px;display:block;margin-bottom:20px;" />`;
  }
  html += `<h3 style="color:#1a1a2e; margin:0 0 16px;">📊 Сводка за неделю</h3>`;
  html += `<div style="display:flex; gap:16px; margin-bottom:24px; flex-wrap:wrap;">`;
  html += statCardHtml(total.toString(), 'Всего новостей', '#10b981');
  html += statCardHtml(breakdown.positive.toString(), 'Позитив', '#10b981');
  html += statCardHtml(breakdown.negative.toString(), 'Негатив', '#ef4444');
  html += `</div>`;

  // Первый абзац общего AI-саммари (полный текст — на странице отчёта)
  const overallFirst = opts.ai?.overall ? firstParagraph(opts.ai.overall) : '';
  if (overallFirst) {
    html += `<div style="margin-bottom:24px; padding:16px; background:#f0f9ff; border-left:3px solid #0ea5e9; border-radius:8px;">`;
    html += `<div style="font-size:12px; color:#0369a1; margin-bottom:8px;">🧠 Итоги недели</div>`;
    html += `<div style="color:#1a1a2e; line-height:1.5;">${escapeHtml(overallFirst)}</div></div>`;
  }

  const top = weeklyTopTags(content);
  if (top.length > 0) {
    html += `<div style="margin-bottom:24px;"><h4 style="color:#1a1a2e; margin:0 0 12px;">Главные темы</h4>`;
    for (const t of top) {
      html += `<div style="margin-bottom:8px; padding:10px 12px; background:#fafafa; border-radius:8px; color:#1a1a2e;">`;
      html += `${escapeHtml(t.tagName)} <span style="color:#8e8e93;">— ${t.count} новостей</span></div>`;
    }
    html += `</div>`;
  }

  if (opts.reportUrl) {
    html += `<div style="margin-bottom:24px;">`;
    html += `<a href="${escapeHtml(opts.reportUrl)}" style="display:inline-block; background:#0ea5e9; color:#ffffff; padding:12px 24px; border-radius:8px; text-decoration:none; font-weight:600;">Открыть полный отчёт</a>`;
    html += `<div style="margin-top:8px; color:#8e8e93; font-size:12px;">Полный отчёт: динамика по дням, графики по тегам, AI-итоги и календарь недели</div>`;
    html += `</div>`;
  }

  html += `</div>`;

  return { subject, html };
}

function statCardHtml(value: string, label: string, color: string): string {
  return `<div style="background:#f0fdf4; border-radius:8px; padding:12px 16px; min-width:100px;">` +
    `<div style="font-size:24px; font-weight:600; color:${color};">${value}</div>` +
    `<div style="font-size:12px; color:#6b7280;">${label}</div></div>`;
}

// ── Weekly Report (Push) ───────────────────────────────────────────────────

export function formatWeeklyReportPush(
  content: WeeklyReportContent,
  reportUrl?: string
): { title: string; body: string; data: Record<string, string> } {
  const n = content.totalArticles;
  const topTag = content.tagSummaries[0]?.tagName || '';

  const title = truncateTextSmart(`📊 Еженедельный отчёт: ${content.period}`, PUSH_TITLE_MAX);

  let body: string;
  if (n === 1) {
    body = '1 новость за неделю';
  } else {
    const base = `${n} ${declineWord(n, 'новость', 'новости', 'новостей')} за неделю`;
    body = topTag ? truncateTextSmart(`${base} · ${topTag}`, PUSH_BODY_MAX) : base;
  }

  const data: Record<string, string> = { type: 'weekly_report', count: String(n), period: content.period };
  // ТЗ-191 Задача 5: deeplink на страницу отчёта (объём уведомления не меняется)
  if (reportUrl) data.report_url = reportUrl;

  return { title, body, data };
}
