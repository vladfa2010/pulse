/**
 * =============================================================================
 * PULSE — MCP: инструмент news (ТЗ-183, Задача 3)
 * =============================================================================
 *
 * news_search — word-AND по 4 полям (тот же подход, что в GET /api/news/search,
 * ТЗ-163) + фолбэк на подстроку целиком; фильтры tags/date_from/date_to;
 * limit ≤ 50, default 20. news_get — выборка по id (тот же набор полей, что у
 * публичного GET /api/news/:id). Тела обрезаются до 2000 символов.
 */

import { z } from 'zod4';
import type { McpServer } from '@modelcontextprotocol/server';
import { query } from '../../config/db';
import type { McpContext } from '../context';
import { truncateText } from '../audit';
import { runAudited, textResult } from './helpers';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const LIKE = USE_SQLITE ? 'LIKE' : 'ILIKE';

const NEWS_FIELDS = `
  id, title_ru, summary_ru, title_original, summary_original, lang_original,
  source, url, published_at, sentiment, sentiment_score, matched_tags, slug`;

function newsRowToResult(r: any, withBody: boolean): Record<string, unknown> {
  const title = r.title_ru || r.title_original || '';
  const summary = r.summary_ru || r.summary_original || '';
  const out: Record<string, unknown> = {
    id: r.id,
    title: title ? truncateText(title) : null,
    summary: summary ? truncateText(summary) : null,
    source: r.source,
    url: r.url,
    published_at: r.published_at,
    sentiment: r.sentiment,
    sentiment_score: r.sentiment_score != null ? Number(r.sentiment_score) : null,
    tags: r.matched_tags ?? [],
    lang: r.lang_original ?? null,
  };
  if (withBody) {
    out.title_original = r.title_original ? truncateText(r.title_original) : null;
    out.summary_original = r.summary_original ? truncateText(r.summary_original) : null;
  }
  return out;
}

async function searchNews(args: {
  query?: string;
  tags?: string[];
  date_from?: string;
  date_to?: string;
  limit: number;
}): Promise<Record<string, unknown>[]> {
  const conds: string[] = [];
  const params: unknown[] = [];

  if (args.tags && args.tags.length > 0) {
    // matched_tags — JSON-массив текстом; кросс-диалектный поиск подстрокой
    for (const tag of args.tags.slice(0, 10)) {
      params.push(`%"${tag}"%`);
      conds.push(`matched_tags::text ${LIKE} $${params.length}`);
    }
  }
  if (args.date_from) {
    params.push(args.date_from);
    conds.push(`published_at >= $${params.length}`);
  }
  if (args.date_to) {
    params.push(args.date_to.length === 10 ? `${args.date_to} 23:59:59` : args.date_to);
    conds.push(`published_at <= $${params.length}`);
  }

  const q = (args.query || '').trim();
  if (q) {
    // ТЗ-163: word-AND — слова ≥2 символов, каждое в любом из 4 полей
    const words = q.split(/\s+/).map((t) => t.replace(/^\W+|\W+$/gu, '')).filter((t) => t.length >= 2);
    const allFields = `(COALESCE(title_ru,'') || ' ' || COALESCE(summary_ru,'') || ' ' || COALESCE(title_original,'') || ' ' || COALESCE(summary_original,''))`;
    if (words.length > 0) {
      const parts = words.map((w) => {
        params.push(`%${w}%`);
        return `${allFields} ${LIKE} $${params.length} ESCAPE '\\'`;
      });
      conds.push(`(${parts.join(' AND ')})`);
    } else {
      params.push(`%${q}%`);
      conds.push(`${allFields} ${LIKE} $${params.length} ESCAPE '\\'`);
    }
  }

  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  params.push(args.limit);
  const res = await query(
    `SELECT ${NEWS_FIELDS} FROM news ${where} ORDER BY published_at DESC LIMIT $${params.length}`,
    params,
  );
  return res.rows.map((r: any) => newsRowToResult(r, false));
}

const SearchSchema = z
  .object({
    query: z.string().max(300).optional(),
    tags: z.array(z.string().max(64)).max(10).optional(),
    date_from: z.string().max(30).optional(),
    date_to: z.string().max(30).optional(),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const GetSchema = z.object({ id: z.string().max(64) }).strict();

export function registerNewsTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'news_search',
    {
      title: 'Поиск новостей',
      description:
        'Поиск по ленте новостей Пульса: word-AND по заголовку/саммари (RU и оригинал), ' +
        'фильтры по тегам и датам публикации. Возвращает заголовок, саммари, источник, URL, ' +
        'дату, сентимент. Только чтение.',
      inputSchema: SearchSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      runAudited(ctx, 'news_search', args, async () => {
        const items = await searchNews(args as z.infer<typeof SearchSchema>);
        return textResult({ count: items.length, items });
      }),
  );

  server.registerTool(
    'news_get',
    {
      title: 'Новость по id',
      description:
        'Карточка новости по UUID: заголовок и саммари на русском и оригинале, источник, URL, дата, сентимент, теги. Только чтение.',
      inputSchema: GetSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const { id } = args as z.infer<typeof GetSchema>;
      return runAudited(ctx, 'news_get', args, async () => {
        const res = await query(`SELECT ${NEWS_FIELDS} FROM news WHERE id = $1`, [id]);
        const row = res.rows[0];
        if (!row) return textResult({ error: 'not_found', id });
        return textResult(newsRowToResult(row, true));
      });
    },
  );
}
