/**
 * =============================================================================
 * PULSE — Advisor module: TG-дайджест саммари и новости по клиентам (ТЗ-183 Задачи 3–4)
 * =============================================================================
 *
 * Вызывается из runAdvisorPrecompute (summaries.ts) ПОСЛЕ прогона пула LLM
 * в слоте пользователя. Только чтение advisor_summaries / advisor_client_tags +
 * библиотека selectNewsByTags — НИКАКИХ дополнительных LLM-вызовов.
 *
 *   sendAdvisorSlotMessages(userId, slotHour):
 *     1. Дайджест (advisor_digest): одно сводное сообщение по формату ТЗ —
 *        блоки «▸ Имя (N новостей) [⚠️ негатив]» + текст саммари до 600 символов,
 *        пустые клиенты одной строкой; если пустые ВСЕ — не отправляется.
 *     2. Новости (advisor_news): топ-5 за 12 ч по тегам всех активных клиентов
 *        (ядро/«Мой портфель» не входит — v5), dedup по news id, имена клиентов
 *        через запятую в квадратных скобках; пусто — не отправляется.
 *
 * Ссылки на фронт ведут на pulse.inside-trade.ru/adviser (не /clients).
 */

import { query } from '../config/db';
import { selectNewsByTags } from '../services/userSummary';
import { getNotifyPrefs, NotifyPrefs } from './service';
import { sendAdvisorTelegram } from './telegram';

const DIGEST_PERIOD_HOURS = 12;
const DIGEST_MAX_SUMMARY_CHARS = 600;
const NEWS_WINDOW_HOURS = 12;
const NEWS_TOP = 5;
/** Маркер негатива в дайджесте — те же пороги, что у алертов (alerts.ts). */
const DIGEST_NEG_MARKER_PCT = 60;
const DIGEST_NEG_MARKER_MIN_ARTICLES = 5;

const ADVISER_PAGE_URL = 'pulse.inside-trade.ru/adviser';
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://pulse.inside-trade.ru').replace(/\/+$/, '');

interface AdvisorTgState {
  chatId: string | null;
  prefs: NotifyPrefs;
}

async function getAdvisorTgState(userId: string): Promise<AdvisorTgState> {
  const result = await query(
    `SELECT telegram_chat_id FROM advisor_settings WHERE user_id = $1`,
    [userId]
  );
  return { chatId: result.rows[0]?.telegram_chat_id ?? null, prefs: await getNotifyPrefs(userId) };
}

function tgEnabled(prefs: NotifyPrefs): boolean {
  return prefs.advisor_tg_enabled !== false;
}

function decline(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return many;
  if (mod10 > 1 && mod10 < 5) return few;
  if (mod10 === 1) return one;
  return many;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

interface SentimentMix { pos: number; neg: number; neu: number }

function parseMix(raw: unknown): SentimentMix | null {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object' && 'pos' in obj && 'neg' in obj) {
      return { pos: Number(obj.pos) || 0, neg: Number(obj.neg) || 0, neu: Number(obj.neu) || 0 };
    }
  } catch { /* не JSON — без маркера */ }
  return null;
}

/**
 * Дайджест + блок новостей для пользователя в его слоте.
 * Возвращает факты отправки (для логов/триггера).
 */
export async function sendAdvisorSlotMessages(
  userId: string,
  slotHour: number
): Promise<{ digest: boolean; news: boolean }> {
  const state = await getAdvisorTgState(userId);
  if (!state.chatId || !tgEnabled(state.prefs)) return { digest: false, news: false };

  const digest = state.prefs.advisor_digest
    ? await sendAdvisorDigest(userId, state.chatId, slotHour)
    : false;
  const news = state.prefs.advisor_news
    ? await sendAdvisorClientNews(userId, state.chatId)
    : false;
  return { digest, news };
}

// ─── Задача 3: сводный дайджест саммари ─────────────────────────────────────

async function sendAdvisorDigest(userId: string, chatId: string, slotHour: number): Promise<boolean> {
  const result = await query(
    `SELECT c.id, c.name, s.summary, s.articles_count, s.sentiment_mix
     FROM advisor_clients c
     LEFT JOIN advisor_summaries s ON s.client_id = c.id AND s.period_hours = $2
     WHERE c.advisor_user_id = $1 AND c.is_archived = FALSE
     ORDER BY c.sort_order ASC, c.created_at ASC`,
    [userId, DIGEST_PERIOD_HOURS]
  );
  if (result.rows.length === 0) return false;

  // Все клиенты пустые — сообщение не отправляется вовсе (ТЗ-183 Задача 3)
  const hasContent = result.rows.some((r: any) => Number(r.articles_count) > 0 && r.summary);
  if (!hasContent) {
    console.log(`[AdvisorDigest] user=${userId} all clients empty — skip`);
    return false;
  }

  const lines: string[] = [`📊 Обзор по клиентам · ${String(slotHour).padStart(2, '0')}:00 мск`, ''];
  for (const row of result.rows) {
    const articles = Number(row.articles_count) || 0;
    if (articles === 0 || !row.summary) {
      lines.push(`▸ ${row.name} — без значимых событий`);
      continue;
    }
    let marker = '';
    const mix = parseMix(row.sentiment_mix);
    if (mix && mix.neg >= DIGEST_NEG_MARKER_PCT && articles >= DIGEST_NEG_MARKER_MIN_ARTICLES) {
      marker = ' ⚠️ негатив';
    }
    lines.push(`▸ ${row.name} (${articles} ${decline(articles, 'новость', 'новости', 'новостей')})${marker}`);
    const text = String(row.summary);
    lines.push(text.length > DIGEST_MAX_SUMMARY_CHARS ? `${text.slice(0, DIGEST_MAX_SUMMARY_CHARS).trimEnd()}…` : text);
    lines.push('');
  }
  lines.push(`Все карточки: ${ADVISER_PAGE_URL}`);

  const sent = await sendAdvisorTelegram(chatId, lines.join('\n').trim());
  if (sent) console.log(`[AdvisorDigest] sent: user=${userId} slot=${slotHour} clients=${result.rows.length}`);
  return sent;
}

// ─── Задача 4: топ-5 новостей по тегам всех клиентов ────────────────────────

interface GroupedNews {
  key: string;
  title: string;
  url: string | null;
  slug: string | null;
  names: string[];
}

async function sendAdvisorClientNews(userId: string, chatId: string): Promise<boolean> {
  const tagRowsResult = await query(
    `SELECT c.name, t.tag_id
     FROM advisor_clients c
     JOIN advisor_client_tags t ON t.client_id = c.id AND t.tag_id IS NOT NULL
     WHERE c.advisor_user_id = $1 AND c.is_archived = FALSE
     ORDER BY c.sort_order ASC, c.created_at ASC, t.id ASC`,
    [userId]
  );
  const tagRows = tagRowsResult.rows;
  if (tagRows.length === 0) return false;

  // tag_id → имена клиентов (в порядке клиентов; имя одно даже при нескольких тегах)
  const tagOwners = new Map<string, string[]>();
  for (const r of tagRows) {
    const list = tagOwners.get(r.tag_id) ?? [];
    if (!list.includes(r.name)) list.push(r.name);
    tagOwners.set(r.tag_id, list);
  }
  const tagIds = [...tagOwners.keys()];

  const articles = await selectNewsByTags(tagIds, NEWS_WINDOW_HOURS, 30);

  // Dedup по id новости (v5): одна строка, имена клиентов через запятую
  const grouped = new Map<string, GroupedNews>();
  for (const a of articles) {
    const owners = [...new Set(a.tags.flatMap((t) => tagOwners.get(t) ?? []))];
    if (owners.length === 0) continue;
    const key = a.id ?? a.url ?? a.title;
    const existing = grouped.get(key);
    if (existing) {
      for (const n of owners) if (!existing.names.includes(n)) existing.names.push(n);
    } else {
      grouped.set(key, { key, title: a.title, url: a.url, slug: a.slug, names: owners });
    }
  }
  const top = [...grouped.values()].slice(0, NEWS_TOP);
  if (top.length === 0) return false;

  const lines: string[] = [`📰 Важные новости по клиентам · за ${NEWS_WINDOW_HOURS} ч`, ''];
  for (const item of top) {
    const link = item.url ?? (item.slug ? `${FRONTEND_URL}/news/${item.slug}` : null);
    const suffix = link ? ` — ${link}` : '';
    lines.push(`▸ [${item.names.map(escapeHtml).join(', ')}] ${escapeHtml(item.title)}${suffix}`);
  }
  lines.push('');
  lines.push(`Все карточки: ${ADVISER_PAGE_URL}`);

  const sent = await sendAdvisorTelegram(chatId, lines.join('\n').trim());
  if (sent) console.log(`[AdvisorDigest] news sent: user=${userId} items=${top.length}`);
  return sent;
}
