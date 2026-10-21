/**
 * =============================================================================
 * PULSE — Библиотека саммари (ТЗ-182 Задача 5)
 * =============================================================================
 *
 * Чистый рефакторинг summary-сервиса ядра (routes/user.ts): выборка новостей
 * и сборка промпта вынесены сюда, чтобы их переиспользовал и ядро, и модуль
 * advisor (Задача 6). Поведение GET /api/user/summary не меняется ни на байт.
 *
 *   - selectNewsByTags  — значимые новости за окно `hours` по набору тегов
 *                         (matched_tags && tagIds, ORDER BY published_at DESC,
 *                         LIMIT 30) — та же выборка, что была в user.ts
 *   - buildSummaryPrompt — сборка промпта для LLM; упоминание окна часов
 *                         параметризовано (v15: раньше хардкод «12 часов»;
 *                         при hours=12 текст промпта идентичен прежнему)
 */

import axios from 'axios';
import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

export interface SummaryArticle {
  id: string | null;
  slug: string | null;
  title: string;
  title_original: string | null;
  summary: string;
  summary_original: string | null;
  source: string | null;
  url: string | null;
  published_at: string | null;
  tags: string[];
  sentiment: string;
  sentiment_score: number | null;
  source_count: number | null;
  all_sources: string[] | null;
}

const NEWS_CARD_COLUMNS = `id, slug, title_ru, title_original, summary_ru, summary_original,
       source, url, published_at, sentiment, sentiment_score, matched_tags,
       source_count, all_sources`;

function parseStringArray(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* не JSON — оставляем как есть ниже */ }
    return [value];
  }
  return null;
}

function mapNewsRow(row: any): SummaryArticle {
  return {
    id: row.id ?? null,
    slug: row.slug ?? null,
    title: row.title_ru || '',
    title_original: row.title_original ?? null,
    summary: row.summary_ru || '',
    summary_original: row.summary_original ?? null,
    source: row.source ?? null,
    url: row.url ?? null,
    published_at: row.published_at ? new Date(row.published_at).toISOString() : null,
    tags: parseStringArray(row.matched_tags) ?? [],
    sentiment: row.sentiment || 'neutral',
    sentiment_score: row.sentiment_score ?? null,
    source_count: row.source_count ?? null,
    all_sources: parseStringArray(row.all_sources),
  };
}

export const SUMMARY_LLM_MODEL = process.env.KIMI_MODEL || 'kimi-k2.6';
const SUMMARY_LLM_API_KEY = process.env.KIMI_API_KEY;

/** Значимые новости за окно `hours` по набору тегов (LIMIT 30 — как в ядре;
 * limit — опциональный параметр для потребителей модуля, ядро не меняется). */
export async function selectNewsByTags(tagIds: string[], hours: number, limit = 30): Promise<SummaryArticle[]> {
  if (USE_SQLITE) {
    // SQLite: matched_tags — JSON TEXT, пересечение через LIKE по каждому тегу.
    // Двойные кавычки вокруг значения — чтобы 'sber' не матчил 'sberbank'.
    // Окно: julianday-арифметика (published_at — ISO-строка).
    const conditions = tagIds.map(() => 'matched_tags LIKE ?').join(' OR ');
    const result = await query(
      `SELECT ${NEWS_CARD_COLUMNS}
       FROM news
       WHERE (${conditions})
         AND published_at > datetime('now', '-${hours} hours')
       ORDER BY published_at DESC
       LIMIT ${limit}`,
      tagIds.map((id) => `%"${id}"%`)
    );
    return result.rows.map(mapNewsRow);
  }

  const newsResult = await query(
    `SELECT ${NEWS_CARD_COLUMNS}
     FROM news
     WHERE published_at > NOW() - INTERVAL '${hours} hours'
       AND matched_tags && $1
     ORDER BY published_at DESC
     LIMIT ${limit}`,
    [tagIds]
  );
  return newsResult.rows.map(mapNewsRow);
}

/** Сборка промпта саммари. При hours=12 текст идентичен прежнему хардкоду. */
export function buildSummaryPrompt(
  tagNames: string[],
  articles: SummaryArticle[],
  hours: number
): string {
  const tagList = tagNames.join(', ');

  const articlesText = articles
    .map((a, i) => {
      const tagStr = a.tags?.join(', ') || '';
      const emoji = a.sentiment === 'positive' ? '🟢' : a.sentiment === 'negative' ? '🔴' : '⚪';
      return `${i + 1}. ${emoji} ${a.title}\n   ${a.summary.slice(0, 200)}\n   Теги: ${tagStr}`;
    })
    .join('\n\n');

  return `Ты — инвестиционный аналитик PULSE. Подготовь краткое саммари для клиента о событиях, затрагивающих его активы.

Активы клиента: ${tagList}

Новости за последние ${hours} часов:
${articlesText}

Требования к саммари:
1. Напиши на русском языке
2. Общий объем — 80-150 слов (3-5 коротких абзацев)
3. Стиль: уверенный аналитический, без воды, конкретные выводы
4. Укажи ключевые события и их влияние на активы клиента
5. Если новостей нет или мало — напиши "За последние ${hours} часов значимых событий по вашим активам не зафиксировано."
6. Не используй markdown-заголовки, списки, эмодзи — только плавный текст
7. Начинай с фразы типа "За последние ${hours} часов..." или "В фокусе..."

Саммари:`;
}

export interface LlmSummaryResult {
  text: string;
  model: string;
}

/**
 * Единый LLM-вызов для саммари: тот же клиент/модель, что ядро
 * (api.moonshot.ai/v1/chat/completions, KIMI_MODEL || 'kimi-k2.6',
 * temperature 0.6 для kimi-k*, max_tokens 600, timeout 30 с).
 * Бросает ошибку при недоступности ключа/сети — вызывающий решает фолбэк.
 */
export async function callSummaryLLM(prompt: string): Promise<LlmSummaryResult> {
  if (!SUMMARY_LLM_API_KEY) {
    throw new Error('KIMI_API_KEY is not configured');
  }
  const model = SUMMARY_LLM_MODEL;
  let llmResponse: any;
  try {
    llmResponse = await axios.post(
      'https://api.moonshot.ai/v1/chat/completions',
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: model.startsWith('kimi-k') ? 0.6 : 0.3,
        max_tokens: 600,
        thinking: model.startsWith('kimi-k') ? { type: 'disabled' } : undefined,
      },
      {
        headers: {
          'Authorization': `Bearer ${SUMMARY_LLM_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );
  } catch (err: any) {
    // ТЗ-50 (п.4): body ответа Moonshot логируем для диагностики
    console.error('[Summary] LLM error:', err.message,
      'status:', err.response?.status,
      'body:', JSON.stringify(err.response?.data ?? null).slice(0, 500));
    throw err;
  }

  const text = llmResponse.data?.choices?.[0]?.message?.content?.trim()
    || 'Не удалось сгенерировать саммари. Попробуйте обновить позже.';
  return { text, model };
}
