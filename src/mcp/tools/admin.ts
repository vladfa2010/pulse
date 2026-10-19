/**
 * =============================================================================
 * PULSE — MCP: админские инструменты (ТЗ-183, Задача 3)
 * =============================================================================
 *
 * Регистрируются только при isAdmin из свежей выборки БД: не-админ не видит
 * admin_* в tools/list. Вызов с не-админским контекстом → JSON-RPC -32602
 * «Admin access required» (двойная линия защиты на случай обхода листинга).
 *
 * admin_education_stats / admin_course_stats (ТЗ-180/181) — минорным релизом,
 * когда стабилизируются зависимости (план, Этап 6).
 */

import { z } from 'zod4';
import type { McpServer } from '@modelcontextprotocol/server';
import type { McpContext } from '../context';
import { runAudited, textResult } from './helpers';
import { handlers as adminMetricHandlers } from '../../routes/adminMetrics';
import { getRadioMp3CacheStats } from '../../services/radioMp3Cache';
import { getRadioTtsMetrics } from '../../services/radioMetrics';

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const MetricsSchema = z
  .object({
    section: z.enum([
      'overview', 'daily', 'funnel', 'retention', 'sentiment', 'tags', 'revenue',
      'adoption', 'online', 'plans', 'mrr', 'promos', 'engagement', 'churn', 'radio',
    ] as const).optional(),
    days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]).default(30),
  })
  .strict();

const CACHE_SECTIONS = ['overview', 'daily', 'funnel', 'retention', 'sentiment', 'tags', 'revenue', 'adoption', 'online', 'plans', 'mrr', 'promos', 'engagement', 'churn', 'radio'] as const;

export function registerAdminTools(server: McpServer, ctx: McpContext): void {
  if (!ctx.isAdmin) return; // не-админ: admin_* не регистрируем вовсе

  server.registerTool(
    'admin_metrics',
    {
      title: 'Метрики платформы (админ)',
      description:
        'Сводные метрики админки: overview, daily, funnel, retention, sentiment, tags, revenue, ' +
        'adoption, online, plans, mrr, promos, engagement, churn, radio. days: 1/7/30/90. Только чтение.',
      inputSchema: MetricsSchema,
      annotations: ANNOTATIONS,
    },
    (args) => {
      const { section, days } = args as z.infer<typeof MetricsSchema>;
      return runAudited(ctx, 'admin_metrics', args, async () => {
        const sections = section ? [section] : CACHE_SECTIONS;
        const data: Record<string, unknown> = {};
        const errors: Record<string, string> = {};
        for (const s of sections) {
          try {
            data[s] = await adminMetricHandlers[s](days);
          } catch (e: any) {
            errors[s] = e.message;
          }
        }
        return textResult({ days, data, errors });
      });
    },
  );

  server.registerTool(
    'admin_radio_cache',
    {
      title: 'Кэш MP3 радио (админ)',
      description:
        'Статистика MP3-кэша радио: занятость, лимиты, TTS hit/miss, hit rate. Только чтение.',
      inputSchema: z.object({}).strict(),
      annotations: ANNOTATIONS,
    },
    (args) =>
      runAudited(ctx, 'admin_radio_cache', args, async () => {
        const cache = getRadioMp3CacheStats();
        const tts = getRadioTtsMetrics();
        const total = tts.cache_hit + tts.cache_miss;
        const hitRate = total > 0 ? Math.round((tts.cache_hit / total) * 1000) / 10 : 0;
        return textResult({ cache, tts, hitRate });
      }),
  );
}
