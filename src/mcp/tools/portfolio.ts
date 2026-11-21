/**
 * =============================================================================
 * PULSE — MCP: инструменты портфеля (ТЗ-193, вторая волна)
 * =============================================================================
 *
 * portfolio_list — брокерские портфели владельца токена (listBrokerPortfolios,
 * тот же сервис, что GET /api/portfolio/). portfolio_summary — сводка позиций/
 * стоимости/динамики (getPortfolioSummary, GET /api/portfolio/summary).
 * portfolio_recommended_tags — тикеры из портфеля, не подписанные на теги
 * (getRecommendedTags, GET /api/portfolio/recommended-tags).
 *
 * ИБ-4: данные ТОЛЬКО владельца токена — userId из McpContext, аргумента
 * user_id у инструментов нет (zod .strict() отсечёт лишнее). В description
 * каждого — явная граница на английском (модель читает description).
 */

import { z } from 'zod4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { McpContext } from '../context';
import { runAudited, textResult } from './helpers';
import {
  listBrokerPortfolios,
  getPortfolioSummary,
  getRecommendedTags,
} from '../../services/brokerPortfolioService';

const EmptySchema = z.object({}).strict();

export function registerPortfolioTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'portfolio_list',
    {
      title: 'Мои портфели',
      description:
        'List broker portfolios of the token owner only (names, brokers, linked keys). ' +
        'Returns only the token owner\'s portfolios. Read-only.',
      inputSchema: EmptySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      runAudited(ctx, 'portfolio_list', args, async () => {
        const portfolios = await listBrokerPortfolios(ctx.userId);
        return textResult({
          count: portfolios.length,
          portfolios: portfolios.map((p) => ({
            id: p.id,
            name: p.name,
            broker: p.broker,
            created_at: p.created_at,
          })),
        });
      }),
  );

  server.registerTool(
    'portfolio_summary',
    {
      title: 'Сводка портфеля',
      description:
        'Portfolio summary for the token owner only: positions, market value, dynamics ' +
        '(same data as GET /api/portfolio/summary). Returns only the token owner\'s data. Read-only.',
      inputSchema: EmptySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      runAudited(ctx, 'portfolio_summary', args, async () => {
        const summary = await getPortfolioSummary(ctx.userId, 'by-broker');
        return textResult(summary);
      }),
  );

  server.registerTool(
    'portfolio_recommended_tags',
    {
      title: 'Рекомендуемые теги из портфеля',
      description:
        'Tickers from the token owner\'s portfolios that have no subscribed tag yet, ' +
        'with the used/limit tag quota (same data as GET /api/portfolio/recommended-tags). ' +
        'Returns only the token owner\'s data. Read-only.',
      inputSchema: EmptySchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      runAudited(ctx, 'portfolio_recommended_tags', args, async () => {
        const result = await getRecommendedTags(ctx.userId);
        return textResult(result);
      }),
  );
}
