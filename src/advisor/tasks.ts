/**
 * =============================================================================
 * PULSE — Advisor module: задачи, напоминания, выгрузка .ics (ТЗ-183 Задача 6, v6)
 * =============================================================================
 *
 * Эндпоинты (роутер смонтирован под /api/advisor с гейтом multi_portfolio):
 *   GET   /clients/:id/tasks          — открытые задачи клиента
 *   GET   /tasks                      — все открытые задачи пользователя
 *                                       (агрегат «Мои задачи», с client_name)
 *   POST  /clients/:id/tasks          — создать (title trim 1–200; идемпотентно
 *                                       по partial unique (client_id, source_event_id))
 *   PATCH /tasks/:id                  — { is_done } (владение через advisor_user_id)
 *   PATCH /tasks/:id/reminder         — задать/снять напоминание (ТЗ-183 v6)
 *   GET   /tasks/:id/ics              — stateless VCALENDAR (ТЗ-183 v6)
 *
 * Cron advisorTaskReminders (регистрация в src/index.ts):
 *   каждые 5 минут, выборка по idx_advisor_tasks_remind
 *   (remind_at <= now AND reminded_at IS NULL AND is_done = FALSE),
 *   отправка по каналам telegram/email; failed-канал логируется, cron не падает;
 *   после обработки reminded_at = now() — идемпотентность повторных прогонов.
 *
 * Внутренний календарь PULSE (calendar_events) НЕ трогаем — .ics открывается
 * в личном календаре советника (Google/Apple/Outlook).
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import cron from 'node-cron';
import { query } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { acquireCronLock, releaseCronLock } from '../services/cron';
import { sendEmail } from '../services/email';
import { getOwnedClient } from './service';
import { sendAdvisorTelegram } from './telegram';

const router = Router();

const ADVISER_PAGE_URL = 'pulse.inside-trade.ru/adviser';
const REMINDER_SUBJECT = 'PULSE Adviser: напоминание';
const REMINDER_CHANNELS = ['telegram', 'email'] as const;
type ReminderChannel = (typeof REMINDER_CHANNELS)[number];

const CreateTaskSchema = z.object({
  title: z.string(),
  due_date: z.string().optional(),
  source_event_id: z.string().uuid().optional(),
});

const PatchTaskSchema = z.object({
  is_done: z.boolean(),
});

const PatchReminderSchema = z.object({
  remind_at: z.string().nullable().optional(),
  channels: z.array(z.string()).optional(),
});

interface TaskRow {
  id: number;
  client_id: number;
  title: string;
  due_date: string | null;
  source_event_id: string | null;
  is_done: boolean;
  remind_at: string | null;
  remind_channels: string[] | null;
  reminded_at: string | null;
  created_at: string;
  client_name?: string | null;
}

function mapTask(row: any): TaskRow {
  let channels: string[] | null = null;
  if (row.remind_channels) {
    try {
      const parsed = typeof row.remind_channels === 'string' ? JSON.parse(row.remind_channels) : row.remind_channels;
      channels = Array.isArray(parsed) ? parsed.map(String) : null;
    } catch { channels = null; }
  }
  const dueRaw = row.due_date;
  let dueDate: string | null = null;
  if (dueRaw) {
    if (typeof dueRaw === 'string') {
      const m = dueRaw.match(/^(\d{4}-\d{2}-\d{2})/);
      dueDate = m ? m[1] : null;
    } else if (dueRaw instanceof Date) {
      // PG DATE парсится драйвером как локальная полночь — берём локальные компоненты
      const y = dueRaw.getFullYear();
      const mo = String(dueRaw.getMonth() + 1).padStart(2, '0');
      const d = String(dueRaw.getDate()).padStart(2, '0');
      dueDate = `${y}-${mo}-${d}`;
    }
  }
  return {
    id: Number(row.id),
    client_id: Number(row.client_id),
    title: row.title,
    due_date: dueDate,
    source_event_id: row.source_event_id ?? null,
    is_done: row.is_done === true || row.is_done === 1,
    remind_at: row.remind_at ? new Date(row.remind_at).toISOString() : null,
    remind_channels: channels,
    reminded_at: row.reminded_at ? new Date(row.reminded_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    client_name: row.client_name ?? null,
  };
}

const TASK_COLUMNS = `id, client_id, title, due_date, source_event_id, is_done,
  remind_at, remind_channels, reminded_at, created_at`;

async function requireOwnedClient(
  res: Response,
  clientId: number,
  userId: string
): Promise<{ id: number; name: string } | null> {
  const client = await getOwnedClient(clientId, userId);
  if (!client) {
    res.status(403).json({ error: 'advisor_client_forbidden' });
    return null;
  }
  if (client.is_archived) {
    res.status(403).json({ error: 'advisor_client_archived' });
    return null;
  }
  return client;
}

/** Задача по id: чужая → 403, нет → 404. Ответ уже отправлен → null. */
async function requireOwnedTask(res: Response, taskId: number, userId: string): Promise<any | null> {
  const result = await query(
    `SELECT ${TASK_COLUMNS}, advisor_user_id FROM advisor_tasks WHERE id = $1`,
    [taskId]
  );
  const row = result.rows[0];
  if (!row) {
    res.status(404).json({ error: 'advisor_task_not_found' });
    return null;
  }
  if (row.advisor_user_id !== userId) {
    res.status(403).json({ error: 'advisor_task_forbidden' });
    return null;
  }
  return row;
}

function parseTaskId(raw: string, res: Response): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid_task_id' });
    return null;
  }
  return id;
}

function parseClientId(raw: string, res: Response): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid_client_id' });
    return null;
  }
  return id;
}

/** Нормализация due_date: принимаем 'YYYY-MM-DD' или ISO, храним DATE (YYYY-MM-DD). */
function normalizeDueDate(raw: string): string | null {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : `${m[1]}-${m[2]}-${m[3]}`;
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// GET /api/advisor/clients/:id/tasks — открытые задачи клиента
router.get('/clients/:id/tasks', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = parseClientId(req.params.id, res);
    if (clientId === null) return;

    const client = await getOwnedClient(clientId, userId);
    if (!client) {
      return res.status(403).json({ error: 'advisor_client_forbidden' });
    }

    const result = await query(
      `SELECT ${TASK_COLUMNS} FROM advisor_tasks
       WHERE client_id = $1 AND is_done = FALSE
       ORDER BY (due_date IS NULL), due_date, created_at`,
      [clientId]
    );
    res.json({ tasks: result.rows.map(mapTask) });
  } catch (err: any) {
    console.error('[AdvisorTasks] List client tasks error:', err.message);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

// GET /api/advisor/tasks — все открытые задачи пользователя («Мои задачи»).
// Один запрос по денормализованному advisor_user_id, без N+1.
router.get('/tasks', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const result = await query(
      `SELECT t.id, t.client_id, t.title, t.due_date, t.source_event_id, t.is_done,
              t.remind_at, t.remind_channels, t.reminded_at, t.created_at,
              c.name AS client_name
       FROM advisor_tasks t
       JOIN advisor_clients c ON c.id = t.client_id
       WHERE t.advisor_user_id = $1 AND t.is_done = FALSE AND c.is_archived = FALSE
       ORDER BY (t.due_date IS NULL), t.due_date, t.created_at`,
      [userId]
    );
    res.json({ tasks: result.rows.map(mapTask) });
  } catch (err: any) {
    console.error('[AdvisorTasks] List tasks error:', err.message);
    res.status(500).json({ error: 'Failed to list tasks' });
  }
});

// POST /api/advisor/clients/:id/tasks — создать задачу.
// Повтор того же (client_id, source_event_id) → 200 с существующей задачей
// (partial unique idx_advisor_tasks_event), не дубль.
router.post('/clients/:id/tasks', validate(CreateTaskSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = parseClientId(req.params.id, res);
    if (clientId === null) return;

    const client = await requireOwnedClient(res, clientId, userId);
    if (!client) return;

    const title = (req.body.title as string).trim();
    if (!title || title.length > 200) {
      return res.status(400).json({ error: 'invalid_title', hint: 'title must be 1..200 chars after trim' });
    }

    let dueDate: string | null = null;
    if (req.body.due_date !== undefined) {
      dueDate = normalizeDueDate(req.body.due_date as string);
      if (dueDate === null) {
        return res.status(400).json({ error: 'invalid_due_date', hint: 'due_date must be YYYY-MM-DD or ISO datetime' });
      }
    }

    const sourceEventId = req.body.source_event_id ?? null;

    const insertResult = await query(
      `INSERT INTO advisor_tasks (client_id, advisor_user_id, title, due_date, source_event_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING ${TASK_COLUMNS}`,
      [clientId, userId, title, dueDate, sourceEventId]
    );

    if (insertResult.rows.length > 0) {
      return res.status(201).json({ task: mapTask(insertResult.rows[0]), alreadyExists: false });
    }

    // Идемпотентность: та же пара (client_id, source_event_id) уже есть
    if (sourceEventId) {
      const existing = await query(
        `SELECT ${TASK_COLUMNS} FROM advisor_tasks WHERE client_id = $1 AND source_event_id = $2`,
        [clientId, sourceEventId]
      );
      if (existing.rows.length > 0) {
        return res.json({ task: mapTask(existing.rows[0]), alreadyExists: true });
      }
    }
    // Конфликт без source_event_id теоретически невозможен (partial index),
    // но на всякий случай отдаём честную ошибку, а не 500.
    res.status(409).json({ error: 'advisor_task_conflict' });
  } catch (err: any) {
    console.error('[AdvisorTasks] Create task error:', err.message);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// PATCH /api/advisor/tasks/:id { is_done }
router.patch('/tasks/:id', validate(PatchTaskSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const taskId = parseTaskId(req.params.id, res);
    if (taskId === null) return;

    const row = await requireOwnedTask(res, taskId, userId);
    if (!row) return;

    const result = await query(
      `UPDATE advisor_tasks SET is_done = $2 WHERE id = $1 RETURNING ${TASK_COLUMNS}`,
      [taskId, req.body.is_done === true]
    );
    console.log(`[AdvisorTasks] user=${userId} task=${taskId} is_done=${req.body.is_done === true}`);
    res.json({ task: mapTask(result.rows[0]) });
  } catch (err: any) {
    console.error('[AdvisorTasks] Patch task error:', err.message);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// PATCH /api/advisor/tasks/:id/reminder { remind_at, channels } (ТЗ-183 v6).
// remind_at: null — снять напоминание; смена/снятие сбрасывает reminded_at.
router.patch('/tasks/:id/reminder', validate(PatchReminderSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const taskId = parseTaskId(req.params.id, res);
    if (taskId === null) return;

    const row = await requireOwnedTask(res, taskId, userId);
    if (!row) return;

    const body = req.body as { remind_at?: string | null; channels?: string[] };

    if (body.remind_at === null) {
      await query(
        `UPDATE advisor_tasks
         SET remind_at = NULL, remind_channels = NULL, reminded_at = NULL
         WHERE id = $1`,
        [taskId]
      );
      const updated = await query(`SELECT ${TASK_COLUMNS} FROM advisor_tasks WHERE id = $1`, [taskId]);
      return res.json({ task: mapTask(updated.rows[0]) });
    }

    if (typeof body.remind_at !== 'string' || !body.remind_at) {
      return res.status(400).json({ error: 'invalid_remind_at', hint: 'remind_at must be ISO datetime or null' });
    }
    const remindAt = new Date(body.remind_at);
    if (Number.isNaN(remindAt.getTime())) {
      return res.status(400).json({ error: 'invalid_remind_at', hint: 'remind_at must be ISO datetime or null' });
    }
    if (remindAt.getTime() <= Date.now()) {
      return res.status(400).json({ error: 'remind_at_in_past' });
    }

    const channels = body.channels;
    if (!Array.isArray(channels) || channels.length === 0) {
      return res.status(400).json({ error: 'invalid_channels', allowed: [...REMINDER_CHANNELS] });
    }
    const invalid = channels.filter((c) => !(REMINDER_CHANNELS as readonly string[]).includes(c));
    if (invalid.length > 0 || new Set(channels).size !== channels.length) {
      return res.status(400).json({ error: 'invalid_channels', allowed: [...REMINDER_CHANNELS] });
    }

    if (channels.includes('telegram')) {
      const settingsResult = await query(
        `SELECT telegram_chat_id FROM advisor_settings WHERE user_id = $1`,
        [userId]
      );
      if (!settingsResult.rows[0]?.telegram_chat_id) {
        return res.status(400).json({
          error: 'telegram_not_linked',
          hint: 'Привяжите Telegram в настройках, чтобы получать напоминания в Telegram',
        });
      }
    }

    await query(
      `UPDATE advisor_tasks
       SET remind_at = $2, remind_channels = $3, reminded_at = NULL
       WHERE id = $1`,
      [taskId, remindAt.toISOString(), JSON.stringify(channels)]
    );
    const updated = await query(`SELECT ${TASK_COLUMNS} FROM advisor_tasks WHERE id = $1`, [taskId]);
    console.log(`[AdvisorTasks] user=${userId} task=${taskId} reminder set at=${remindAt.toISOString()} channels=${channels.join(',')}`);
    res.json({ task: mapTask(updated.rows[0]) });
  } catch (err: any) {
    console.error('[AdvisorTasks] Reminder error:', err.message);
    res.status(500).json({ error: 'Failed to save reminder' });
  }
});

// ─── ICS (ТЗ-183 v6) ─────────────────────────────────────────────────────────

/** ICS-экранирование значения свойства (RFC 5545 §3.3.11). */
function icsEscape(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
}

/** Развёртка строки ICS на 75 октетов (RFC 5545 §3.1). */
function icsFold(line: string): string {
  const MAX = 75;
  if (line.length <= MAX) return line;
  const parts: string[] = [];
  let rest = line;
  while (rest.length > MAX) {
    parts.push(rest.slice(0, MAX));
    rest = ` ${rest.slice(MAX)}`;
  }
  parts.push(rest);
  return parts.join('\r\n');
}

function icsTimestamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// GET /api/advisor/tasks/:id/ics — stateless VCALENDAR. Ничего не хранит.
router.get('/tasks/:id/ics', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const taskId = parseTaskId(req.params.id, res);
    if (taskId === null) return;

    const row = await requireOwnedTask(res, taskId, userId);
    if (!row) return;

    const task = mapTask(row);
    if (!task.due_date) {
      return res.status(400).json({ error: 'no_due_date' });
    }

    const client = await getOwnedClient(task.client_id, userId);
    const clientName = client?.name ?? 'Клиент';
    const sourceText = task.source_event_id
      ? 'Источник: событие календаря'
      : 'Источник: создано вручную';

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//PULSE//Advisor Tasks//RU',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      `UID:advisor-task-${task.id}@pulse.inside-trade.ru`,
      `DTSTAMP:${icsTimestamp(new Date())}`,
      `DTSTART;VALUE=DATE:${task.due_date.replace(/-/g, '')}`,
      `SUMMARY:${icsEscape(task.title)}`,
      `DESCRIPTION:${icsEscape(`Клиент: ${clientName}\n${sourceText}`)}`,
      'END:VEVENT',
      'END:VCALENDAR',
    ];

    const ics = lines.map(icsFold).join('\r\n') + '\r\n';
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="advisor-task-${task.id}.ics"`);
    res.send(ics);
  } catch (err: any) {
    console.error('[AdvisorTasks] ICS error:', err.message);
    res.status(500).json({ error: 'Failed to generate ics' });
  }
});

export default router;

// ─── Cron advisorTaskReminders (ТЗ-183 v6) ──────────────────────────────────

function reminderText(task: { title: string; client_name: string | null }): string {
  const client = task.client_name ? ` (${task.client_name})` : '';
  return `⏰ Напоминание: ${task.title}${client}\n\n${ADVISER_PAGE_URL}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Прогон напоминаний: задачи с подошедшим remind_at, не выполненные,
 * не отправленные. Отправка по каждому каналу из remind_channels;
 * failed-канал логируется, cron не падает; после обработки задачи
 * reminded_at = now() — повторный прогон дублей не даст.
 */
export async function runAdvisorTaskReminders(): Promise<{ due: number; sent: number; failed: number }> {
  const nowIso = new Date().toISOString();
  const result = await query(
    `SELECT t.id, t.advisor_user_id, t.title, t.due_date, t.remind_channels, c.name AS client_name
     FROM advisor_tasks t
     JOIN advisor_clients c ON c.id = t.client_id
     WHERE t.remind_at <= $1 AND t.reminded_at IS NULL AND t.is_done = FALSE`,
    [nowIso]
  );

  let sent = 0;
  let failed = 0;

  for (const row of result.rows) {
    let channels: ReminderChannel[] = [];
    try {
      const parsed = typeof row.remind_channels === 'string' ? JSON.parse(row.remind_channels) : row.remind_channels;
      if (Array.isArray(parsed)) channels = parsed.filter((c: string) => (REMINDER_CHANNELS as readonly string[]).includes(c));
    } catch { /* нет каналов — только reminded_at проставим */ }

    const text = reminderText({ title: row.title, client_name: row.client_name ?? null });

    for (const channel of channels) {
      if (channel === 'telegram') {
        try {
          const settingsResult = await query(
            `SELECT telegram_chat_id FROM advisor_settings WHERE user_id = $1`,
            [row.advisor_user_id]
          );
          const chatId = settingsResult.rows[0]?.telegram_chat_id;
          if (!chatId) {
            failed++;
            console.warn(`[AdvisorReminders] task=${row.id} telegram failed: chat_id not linked`);
            continue;
          }
          const ok = await sendAdvisorTelegram(chatId, text);
          if (ok) sent++;
          else {
            failed++;
            console.warn(`[AdvisorReminders] task=${row.id} telegram send failed`);
          }
        } catch (err: any) {
          failed++;
          console.warn(`[AdvisorReminders] task=${row.id} telegram error:`, err.message);
        }
      } else if (channel === 'email') {
        try {
          const userResult = await query(`SELECT email FROM users WHERE id = $1`, [row.advisor_user_id]);
          const email = userResult.rows[0]?.email;
          if (!email) {
            failed++;
            console.warn(`[AdvisorReminders] task=${row.id} email failed: no user email`);
            continue;
          }
          const html = `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>`;
          const ok = await sendEmail(email, REMINDER_SUBJECT, html);
          if (ok) sent++;
          else {
            failed++;
            console.warn(`[AdvisorReminders] task=${row.id} email send failed`);
          }
        } catch (err: any) {
          failed++;
          console.warn(`[AdvisorReminders] task=${row.id} email error:`, err.message);
        }
      }
    }

    await query(`UPDATE advisor_tasks SET reminded_at = $2 WHERE id = $1`, [row.id, nowIso]);
  }

  console.log(`[AdvisorReminders] due=${result.rows.length} sent=${sent} failed=${failed}`);
  return { due: result.rows.length, sent, failed };
}

/** Регистрация cron: каждые 5 минут, тайзона Europe/Moscow. */
export function startAdvisorTaskRemindersCron(opts?: { isShuttingDown?: () => boolean }): void {
  cron.schedule('*/5 * * * *', async () => {
    if (opts?.isShuttingDown?.()) return;
    const acquired = await acquireCronLock('advisor-task-reminders');
    if (!acquired) return;
    try {
      await runAdvisorTaskReminders();
    } catch (err: any) {
      console.error('[Cron] Advisor task reminders failed:', err.message);
    } finally {
      await releaseCronLock('advisor-task-reminders');
    }
  }, { timezone: 'Europe/Moscow' });
  console.log('[Cron] Advisor task reminders scheduled every 5 minutes Europe/Moscow');
}
