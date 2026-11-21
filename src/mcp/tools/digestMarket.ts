/**
 * =============================================================================
 * PULSE — MCP: дайджест и саммари рынка (ТЗ-193, вторая волна)
 * =============================================================================
 *
 * my_digest — AI-саммари по тегам юзера из кэша крона (getCachedGlobalSummary,
 * тот же источник, что GET /api/user/summary-global/cached). КРИТИЧНО: кэш-only,
 * МСП никогда не триггерит LLM-генерацию (read-only дух ТЗ-183 + защита
 * LLM-бюджета). Кэша нет → не ошибка, а { status: 'warming_up' }.
 *
 * market_summary — диалог-сводка по рынку (getMarketDialog, тот же сервис,
 * что GET /api/market/market-dialog, ТЗ-57/64). Публичная семантика кэша
 * (один диалог на всех), привязки к юзеру нет. Нет кэша → warming_up.
 *
 * my_tags — подписки юзера (getUserTagsFull, тот же сервис, что
 * GET /api/user/tags) — имена тегов для news_feed.
 */

import { z } from 'zod4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { McpContext } from '../context';
import { truncateText } from '../audit';
import { runAudited, textResult } from './helpers';
import { getCachedGlobalSummary } from '../../services/globalSummary';
import { getCachedMarketDialog } from '../../services/radioPodcast';
import { getUserTagsFull } from '../../services/tagManager';

const EmptySchema = z.object({}).strict();

export function registerDigestMarketTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'my_digest',
    {
      title: 'Мой дайджест',
      description:
        'AI summary of the latest news cycle for the token owner\'s tags, from cache only. ' +
        'Never triggers LLM generation. If the cache is not warm yet, returns a warming_up ' +
        'status — retry in a few minutes. Read-only.',
      inputSchema: EmptySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      runAudited(ctx, 'my_digest', args, async () => {
        const cached = getCachedGlobalSummary();
        if (!cached) {
          return textResult({
            status: 'warming_up',
            hint: 'Кэш прогревается, повторите через несколько минут',
          });
        }
        return textResult({
          status: 'ok',
          summary: truncateText(cached.summary, 4000),
          generated_at: cached.generatedAt,
          articles_count: cached.articlesCount,
        });
      }),
  );

  server.registerTool(
    'market_summary',
    {
      title: 'Саммари рынка',
      description:
        'Market overview as a host+guest dialog, from cache (same data as the public ' +
        'market page). Not tied to the token owner. Never triggers LLM generation. ' +
        'Returns warming_up if the cache is cold. Read-only.',
      inputSchema: EmptySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      runAudited(ctx, 'market_summary', args, async () => {
        // КЭШ-ONLY (ТЗ-193, критерий 2): getCachedMarketDialog не триггерит
        // LLM-генерацию в отличие от getMarketDialog (ленивая генерация в
        // эндпоинте). Холодный кэш → warming_up, а не генерация.
        const segments = getCachedMarketDialog();
        if (!segments) {
          return textResult({
            status: 'warming_up',
            hint: 'Сводка рынка прогревается, повторите через несколько минут',
          });
        }
        return textResult({
          status: 'ok',
          segments: segments.map((s) => ({
            role: s.role,
            text: truncateText(s.text),
          })),
        });
      }),
  );

  server.registerTool(
    'my_tags',
    {
      title: 'Мои теги',
      description:
        'Tag subscriptions of the token owner (names, types, frozen status, news per month). ' +
        'Use these tag names with news_feed. Returns only the token owner\'s tags. Read-only.',
      inputSchema: EmptySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      runAudited(ctx, 'my_tags', args, async () => {
        const tags = await getUserTagsFull(ctx.userId);
        return textResult({
          count: tags.length,
          tags: tags.map((t) => ({
            name: t.tag_name,
            type: t.tag_type,
            is_frozen: t.is_frozen,
            news_per_month: t.news_per_month,
          })),
        });
      }),
  );
}
