/**
 * =============================================================================
 * PULSE — MCP: инструменты образования (ТЗ-183, Задача 3)
 * =============================================================================
 *
 * IDOR (ИБ-4): user_id берётся строго из контекста токена, аргументом не
 * принимается; схемы zod .strict().
 */

import { z } from 'zod4';
import type { McpServer } from '@modelcontextprotocol/server';
import { query } from '../../config/db';
import type { McpContext } from '../context';
import { truncateText } from '../audit';
import { runAudited, textResult } from './helpers';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

const AttemptsSchema = z
  .object({
    course_id: z.string().max(64).optional(),
  })
  .strict();

export function registerEducationTools(server: McpServer, ctx: McpContext): void {
  server.registerTool(
    'education_my_progress',
    {
      title: 'Мой прогресс в обучении',
      description:
        'Мои записи на курсы с прогрессом: название курса, число завершённых уроков, ' +
        'общее число уроков, дата записи. Только свои данные (user_id из токена). Только чтение.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) =>
      runAudited(ctx, 'education_my_progress', args, async () => {
        const res = await query(
          `SELECT c.id AS course_id, c.title,
                  ce.created_at AS enrolled_at, ce.source,
                  (SELECT COUNT(*) FROM course_lessons cl WHERE cl.course_id = c.id) AS lessons_total,
                  (SELECT COUNT(*) FROM lesson_progress lp
                     JOIN course_lessons cl ON cl.id = lp.lesson_id
                    WHERE lp.user_id = ce.user_id AND cl.course_id = c.id) AS lessons_done
           FROM course_enrollments ce
           JOIN courses c ON c.id = ce.course_id
           WHERE ce.user_id = $1
           ORDER BY ce.created_at DESC
           LIMIT 100`,
          [ctx.userId],
        );
        const items = res.rows.map((r: any) => ({
          course_id: r.course_id,
          title: truncateText(r.title, 300),
          enrolled_at: r.enrolled_at,
          source: r.source,
          lessons_done: Number(r.lessons_done),
          lessons_total: Number(r.lessons_total),
        }));
        return textResult({ count: items.length, items });
      }),
  );

  server.registerTool(
    'education_my_attempts',
    {
      title: 'Мои попытки тестов',
      description:
        'Мои попытки прохождения тестов уроков: курс, урок, балл, порог, зачтено/не зачтено, ' +
        'дата. Опциональный фильтр course_id. Только свои данные. Только чтение.',
      inputSchema: AttemptsSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const { course_id } = args as z.infer<typeof AttemptsSchema>;
      return runAudited(ctx, 'education_my_attempts', args, async () => {
        const params: unknown[] = [ctx.userId];
        let courseFilter = '';
        if (course_id) {
          params.push(course_id);
          courseFilter = `AND (event_data->>'course_id') = $${params.length}`;
        }
        const res = await query(
          `SELECT event_data, created_at
           FROM user_events
           WHERE user_id = $1 AND event_type = 'education.test_attempt'
             AND created_at >= ${USE_SQLITE ? "datetime('now', '-1 year')" : "NOW() - INTERVAL '1 year'"}
             ${courseFilter}
           ORDER BY created_at DESC
           LIMIT 100`,
          params,
        );
        const items = res.rows.map((r: any) => {
          const d = typeof r.event_data === 'string' ? JSON.parse(r.event_data || '{}') : (r.event_data ?? {});
          return {
            course_id: d.course_id ?? null,
            lesson_id: d.lesson_id ?? null,
            score: d.score ?? null,
            pass_score: d.pass_score ?? null,
            passed: d.passed ?? null,
            at: r.created_at,
          };
        });
        return textResult({ count: items.length, items });
      });
    },
  );
}
