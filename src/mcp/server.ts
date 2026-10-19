/**
 * =============================================================================
 * PULSE — MCP: фабрика сервера и HTTP-обработчик (ТЗ-183, Задача 1)
 * =============================================================================
 *
 * Фабрика на запрос: buildServer(ctx) создаёт инстанс McpServer с ролью из
 * контекста; один инстанс на все запросы падает со второго (требование SDK
 * v2 2.3.x). Общие репозитории/кэши — снаружи фабрики, в ctx только
 * { tokenId, userId, isAdmin, scopes, ip, userAgent }.
 *
 * Транспорт: createMcpHandler (SDK v2) + toNodeHandler (@modelcontextprotocol/node)
 * — обе эры протокола (2025-11-25 и 2026-07-28) обслуживаются фабрикой, ничего
 * специально не выключаем. Лимит тела — дефолт адаптера (4 МиБ).
 */

import { AsyncLocalStorage } from 'async_hooks';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import type { McpContext } from './context';
import { registerNewsTools } from './tools/news';
import { registerCalendarTools } from './tools/calendarSentimentRadio';
import { registerEducationTools } from './tools/education';
import { registerAdminTools } from './tools/admin';

/** Версия serverInfo — держим в паре с константой в /health (src/index.ts) */
const MCP_SERVER_VERSION = '8.4.0';

/**
 * Контекст запроса течёт в фабрику через ALS: createMcpHandler не гарантирует
 * передачу исходного Request-объекта в McpRequestContext.requestInfo (может
 * клонировать), а фабрика вызывается внутри fetch(). mountMcp оборачивает
 * handler.fetch в mcpContextStorage.run(ctx, ...).
 */
export const mcpContextStorage = new AsyncLocalStorage<McpContext>();

export function buildServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'pulse', version: MCP_SERVER_VERSION },
    {
      capabilities: {
        tools: {
          // read-only релиз: писалок нет (ТЗ-183, ключевое решение 1)
          listChanged: false,
        },
      },
    },
  );
  registerNewsTools(server, ctx);
  registerCalendarTools(server, ctx);
  registerEducationTools(server, ctx);
  registerAdminTools(server, ctx);
  return server;
}

/** HTTP-обработчик: контекст — из ALS (см. mountMcp) */
export function createMcpHttpHandler() {
  return createMcpHandler(
    () => {
      const ctx = mcpContextStorage.getStore();
      if (!ctx) {
        throw new Error('MCP context missing: mount /mcp behind authenticateMcpToken');
      }
      return buildServer(ctx);
    },
    {
      onerror: (error) => console.error('[MCP] handler error:', error.message),
    },
  );
}
