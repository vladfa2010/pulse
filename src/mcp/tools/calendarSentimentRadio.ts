/**
 * =============================================================================
 * PULSE — MCP: инструменты календарь / сентимент / радио (ТЗ-183, Задача 3)
 * =============================================================================
 */

import { z } from 'zod4';
import type { McpServer } from '@modelcontextprotocol/server';
import { query } from '../../config/db';
import type { McpContext } from '../context';
import { truncateText } from '../audit';
import { runAudited, textResult } from './helpers';
import { getCurrentIndex, getImoexData } from '../../services/sentimentIndex';
import { getRadioFlags } from '../../services/radioSettings';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const DAY = USE_SQLITE ? "date(created_at)" : "date_trunc('day', created_at)";

const CalendarSchema = z
  .object({
    date_from: z.string().max(30),
    date_to: z.string().max(30),
  })
  .strict();

const SentimentSchema = z
  .object({
    days: z.number().int().min(1).max(365).default(30),
  })
  .strict();

export function registerCalendarTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'calendar_events',
    {
      title: 'События календаря',
      description:
        'События экономического календаря за диапазон (окно ≤ 92 дней): дата, название, тип, ' +
        'статус, компания, тикер. Только чтение.',
      inputSchema: CalendarSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const { date_from, date_to } = args as z.infer<typeof CalendarSchema>;
      return runAudited(ctx, 'calendar_events', args, async () => {
        const res = await query(
          `SELECT date, title, kind, status, company, ticker
           FROM calendar_events
           WHERE date >= $1 AND date <= $2
           ORDER BY date, title
           LIMIT 1000`,
          [date_from, date_to],
        );
        const items = res.rows.map((r: any) => ({
          date: r.date,
          title: truncateText(r.title, 300),
          kind: r.kind,
          status: r.status,
          company: r.company,
          ticker: r.ticker,
        }));
        return textResult({ count: items.length, items });
      });
    },
  );

  server.registerTool(
    'sentiment_index',
    {
      title: 'Индекс настроения',
      description:
        'Текущее значение индекса настроения сообщества, дневная история за период ' +
        '(≤365 дней, default 30) и данные Индекса МосБиржи. Только чтение.',
      inputSchema: SentimentSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const { days } = args as z.infer<typeof SentimentSchema>;
      return runAudited(ctx, 'sentiment_index', args, async () => {
        const [current, imoex, historyRes] = await Promise.all([
          getCurrentIndex().catch(() => null),
          getImoexData().catch(() => null),
          query(
            `SELECT ${DAY} AS day,
                    COUNT(*) AS votes,
                    SUM(CASE WHEN vote_value > 0 THEN 1 ELSE 0 END) AS positive,
                    SUM(CASE WHEN vote_value < 0 THEN 1 ELSE 0 END) AS negative
             FROM sentiment_votes
             WHERE created_at >= ${USE_SQLITE ? "datetime('now', ?)" : "NOW() - ($1 || ' days')::interval"}
             GROUP BY 1 ORDER BY 1 DESC
             LIMIT $${USE_SQLITE ? 1 : 2}`,
            USE_SQLITE ? [`-${days} days`] : [String(days)],
          ).catch(() => ({ rows: [] as any[] })),
        ]);
        const history = historyRes.rows.map((r: any) => ({
          day: r.day,
          votes: Number(r.votes),
          positive: Number(r.positive),
          negative: Number(r.negative),
        }));
        return textResult({
          current: current != null ? Math.round(current) : null,
          days,
          history,
          imoex: imoex ? { current: imoex.current, session_active: imoex.sessionActive } : null,
        });
      });
    },
  );

  server.registerTool(
    'radio_config',
    {
      title: 'Конфиг радио',
      description:
        'Конфигурация радио Пульса: доступность сервиса, провайдер озвучки, голоса ведущего/гостя, ' +
        'режим по умолчанию, музыка. Только чтение.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      runAudited(ctx, 'radio_config', args, async () => {
        const flags = await getRadioFlags();
        return textResult({
          radio_service_enabled: flags.service_enabled,
          radio_voice_provider: flags.voice_provider,
          radio_minimax_host_voice: flags.minimax_host_voice,
          radio_minimax_guest_voice: flags.minimax_guest_voice,
          radio_default_mode: flags.default_mode,
          radio_music_enabled: flags.music_enabled,
          minimax_configured: !!process.env.MINIMAX_API_KEY,
        });
      }),
  );
}
