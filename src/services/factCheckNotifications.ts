// ═══════════════════════════════════════════════════════════════════════════
// Fact-check report delivery: email (HTML) + Telegram (MarkdownV2)
// ═══════════════════════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';
import { query } from '../config/db';
import { sendEmail } from './email';
import { sendTelegramMessage } from './telegram';
import type { FactCheckResultV4, SourceV4 } from './factCheck';

const APP_URL = process.env.APP_URL || process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru';

let emailTemplate: string | null = null;

function loadEmailTemplate(): string {
  if (emailTemplate) return emailTemplate;
  const templatePath = path.resolve(__dirname, '../../templates/fact-check-result.html');
  emailTemplate = fs.readFileSync(templatePath, 'utf-8');
  return emailTemplate;
}

export async function sendFactCheckNotifications(args: {
  userId: string;
  newsId: string;
  result: FactCheckResultV4;
}): Promise<void> {
  const { userId, newsId, result } = args;

  try {
    const settingsRes = await query(
      `SELECT fact_check_email_enabled, fact_check_tg_enabled
       FROM notification_settings WHERE user_id = $1`,
      [userId]
    );
    const settings = settingsRes.rows[0];
    if (!settings) return;

    const userRes = await query(
      `SELECT email FROM users WHERE id = $1`,
      [userId]
    );
    const user = userRes.rows[0];

    const tgRes = await query(
      `SELECT target FROM user_channels
       WHERE user_id = $1 AND channel = 'telegram' AND is_active = TRUE`,
      [userId]
    );
    const tgChatId = tgRes.rows[0]?.target as string | undefined;

    const newsRes = await query(
      `SELECT title_ru, title_original FROM news WHERE id = $1`,
      [newsId]
    );
    const newsTitle = (newsRes.rows[0]?.title_ru || newsRes.rows[0]?.title_original || 'Без названия') as string;

    if (settings.fact_check_email_enabled && user?.email) {
      const subject = `PULSE — результат проверки: ${truncate(newsTitle, 80)}`;
      const html = buildEmailHtml(result, newsTitle, newsId);
      await sendEmail(user.email, subject, html);
    }

    if (settings.fact_check_tg_enabled && tgChatId) {
      const text = buildTelegramText(result, newsTitle, newsId);
      const chunks = splitMessage(text, 4000);
      for (const chunk of chunks) {
        await sendTelegramMessage(tgChatId, chunk, 'MarkdownV2');
      }
    }
  } catch (err) {
    console.error('[FactCheckNotifications] Failed to send notifications:', err);
  }
}

function buildEmailHtml(result: FactCheckResultV4, newsTitle: string, newsId: string): string {
  const assessment = result.assessment;
  const score = assessment.credibility_score ?? 0;
  const label = assessment.credibility_label ?? 'Неизвестно';
  const scoreClass = scoreClassName(score);
  const labelColor = labelColorHex(label);

  const sourcesHtml = result.sources.slice(0, 10).map((source) => sourceItemHtml(source)).join('');
  const analysis = escapeHtml(result.analysis || assessment.verdict || 'Анализ отсутствует')
    .replace(/\n/g, '<br>');
  const verdict = escapeHtml(assessment.verdict || 'Вердикт не сформирован').replace(/\n/g, '<br>');

  let html = loadEmailTemplate();
  html = html
    .replace(/\{\{score\}\}/g, String(score))
    .replace(/\{\{scoreClass\}\}/g, scoreClass)
    .replace(/\{\{label\}\}/g, escapeHtml(label))
    .replace(/\{\{labelColor\}\}/g, labelColor)
    .replace(/\{\{newsTitle\}\}/g, escapeHtml(newsTitle))
    .replace(/\{\{analysis\}\}/g, analysis)
    .replace(/\{\{sources\}\}/g, sourcesHtml)
    .replace(/\{\{sourcesCount\}\}/g, String(result.sources.length))
    .replace(/\{\{tone\}\}/g, escapeHtml(assessment.tone || '—'))
    .replace(/\{\{factsVerified\}\}/g, escapeHtml(assessment.facts_verified || '—'))
    .replace(/\{\{hasBias\}\}/g, assessment.has_opinion_bias ? 'Да' : 'Нет')
    .replace(/\{\{verdict\}\}/g, verdict)
    .replace(/\{\{appUrl\}\}/g, escapeHtml(APP_URL))
    .replace(/\{\{newsId\}\}/g, newsId)
    .replace(/\{\{checkedAt\}\}/g, formatDate(result.checked_at))
    .replace(/\{\{model\}\}/g, escapeHtml(result.model || 'kimi-k2.6'));

  return html;
}

function sourceItemHtml(source: SourceV4): string {
  const url = source.url || '#';
  const title = escapeHtml(source.title || 'Источник');
  const site = escapeHtml(source.site || extractHost(url));
  const engine = source.engine || 'kimi';
  const badgeClass = `badge-${engine.replace(/_/g, '-')}`;
  const date = source.date ? escapeHtml(source.date) : '';

  return `
    <div class="source-item">
      <a href="${escapeHtml(url)}" class="source-title" target="_blank" rel="noopener">${title}</a>
      <div class="source-meta">
        <span class="badge ${badgeClass}">${engine.toUpperCase().replace(/_/g, ' ')}</span>
        ${site ? `· ${site}` : ''}
        ${date ? `· ${date}` : ''}
      </div>
    </div>
  `;
}

function buildTelegramText(result: FactCheckResultV4, newsTitle: string, newsId: string): string {
  const assessment = result.assessment;
  const score = assessment.credibility_score ?? 0;
  const label = assessment.credibility_label ?? 'Неизвестно';

  const lines: string[] = [
    `*🔍 PULSE — результат проверки*`,
    '',
    `${escapeMarkdownV2(newsTitle)}`,
    '',
    `*Оценка достоверности:* ${score}% — ${escapeMarkdownV2(label)}`,
    `*Тон:* ${escapeMarkdownV2(assessment.tone || '—')}`,
    `*Факты подтверждены:* ${escapeMarkdownV2(assessment.facts_verified || '—')}`,
    `*Оценочный сдвиг:* ${assessment.has_opinion_bias ? 'Да' : 'Нет'}`,
    '',
    `*Анализ:*`,
    `${escapeMarkdownV2(result.analysis || assessment.verdict || 'Анализ отсутствует')}`,
    '',
  ];

  if (result.sources.length > 0) {
    lines.push(`*Источники (${result.sources.length}):*`);
    result.sources.slice(0, 5).forEach((source, idx) => {
      const title = escapeMarkdownV2(source.title || 'Источник');
      const url = (source.url || '').replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
      const site = escapeMarkdownV2(source.site || extractHost(source.url || ''));
      if (url) {
        lines.push(`${idx + 1}\\. [${title}](${url})${site ? ` — ${site}` : ''}`);
      } else {
        lines.push(`${idx + 1}\\. ${title}`);
      }
    });
    lines.push('');
  }

  const openUrl = `${APP_URL}/news/${newsId}`.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
  lines.push(`[Открыть в приложении](${openUrl})`);
  lines.push('');
  lines.push(escapeMarkdownV2('⚠️ Этот анализ не является индивидуальной инвестиционной рекомендацией. Результаты сгенерированы ИИ и могут содержать ошибки.'));

  return lines.join('\n');
}

function scoreClassName(score: number): string {
  if (score >= 70) return 'high';
  if (score >= 50) return 'medium';
  if (score >= 30) return 'low';
  return 'critical';
}

function labelColorHex(label: string): string {
  switch (label) {
    case 'Высокая': return '#22C55E';
    case 'Средняя': return '#EAB308';
    case 'Низкая': return '#F97316';
    case 'Критическая': return '#EF4444';
    default: return '#6B7280';
  }
}

function extractHost(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  try {
    const d = new Date(value);
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeMarkdownV2(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + '…';
}

function splitMessage(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n', maxLength);
    if (cutAt === -1) cutAt = maxLength;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trim();
  }
  return chunks;
}
