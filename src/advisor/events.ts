/**
 * =============================================================================
 * PULSE — Advisor module: агрегированные события календаря (ТЗ-182 Задача 7)
 * =============================================================================
 *
 * GET /api/advisor/events?days=14 (default 14, max 45)
 *
 * Для каждого не-архивного клиента — окно calendar_events по тому же WHERE, что
 * публичный getCalendarData (services/calendar.ts): дата от server_date −2 до
 * server_date + days (верхняя граница окна — параметр days вместо +120 публичной
 * выборки). Фильтр tag_ids ∩ теги клиента — в JS-слое после стандартной выборки
 * окна (окно маленькое, SQL-джойн не нужен — trade-off зафиксирован в ТЗ-182 §5:
 * окна > 120 дней — отдельное ТЗ на SQL-фильтр).
 *
 * Осознанные свойства (ТЗ-182):
 *   - События без матчинга (tag_ids пуст / matched_via IS NULL) не возвращаются
 *     НИКОГДА — ожидаемо, не баг: лучше не показать, чем показать чужое событие
 *     в контексте клиента (риск «Качество событий» в ТЗ-182 §5).
 *   - Группы без событий в окне не возвращаются; одно событие может повторяться
 *     в нескольких группах (задача создаётся в контексте конкретного клиента).
 *   - Публичный GET /api/calendar — контракт без изменений.
 */

import { Router } from 'express';
import { query } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { getMskDateString, addDays } from '../services/calendar';

const router = Router();

/** Парсинг tag_ids (TEXT-JSON, заполняет M6 как JSON.stringify(tag_id[])). */
function parseTagIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch { /* событие без тегов */ }
  }
  return [];
}

// GET /api/advisor/events?days=14 — события календаря по тегам клиентов
router.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const days = Math.min(Math.max(parseInt(req.query.days as string) || 14, 1), 45);

    const clientsResult = await query(
      `SELECT c.id, c.name, t.tag_id, t.tag_name
       FROM advisor_clients c
       LEFT JOIN advisor_client_tags t ON t.client_id = c.id
       WHERE c.advisor_user_id = $1 AND c.is_archived = FALSE
       ORDER BY c.sort_order ASC, c.created_at ASC`,
      [userId]
    );

    const clients = new Map<number, { name: string; tagIds: Set<string>; tagNames: Map<string, string> }>();
    for (const row of clientsResult.rows) {
      const cid = Number(row.id);
      if (!clients.has(cid)) {
        clients.set(cid, { name: row.name, tagIds: new Set(), tagNames: new Map() });
      }
      if (row.tag_id) {
        clients.get(cid)!.tagIds.add(row.tag_id);
        clients.get(cid)!.tagNames.set(row.tag_id, row.tag_name);
      }
    }

    if (clients.size === 0) {
      return res.json({ groups: [], days });
    }

    // Окно — тот же WHERE, что публичный getCalendarData: server_date −2 … +days
    const serverDate = await getMskDateString();
    const windowStart = addDays(serverDate, -2);
    const windowEnd = addDays(serverDate, days);

    const eventsResult = await query(
      `SELECT id, date, title, kind, status, company, ticker, tag_ids, matched_via
       FROM calendar_events
       WHERE date >= $1 AND date <= $2
       ORDER BY date, title`,
      [windowStart, windowEnd]
    );

    const groups: any[] = [];
    for (const [clientId, client] of clients) {
      if (client.tagIds.size === 0) continue; // у клиента нет тегов — матчиться нечему
      const events: any[] = [];
      for (const row of eventsResult.rows) {
        const eventTags = parseTagIds(row.tag_ids);
        // События без матчинга (matched_via IS NULL / пустые tag_ids) не
        // возвращаются НИКОГДА — см. шапку файла (осознанное решение ТЗ-182).
        if (!row.matched_via || eventTags.length === 0) continue;
        const matched = eventTags.filter((t) => client.tagIds.has(t));
        if (matched.length === 0) continue;
        events.push({
          id: row.id,
          date: typeof row.date === 'string' ? row.date.slice(0, 10) : row.date,
          title: row.title,
          kind: row.kind,
          status: row.status,
          company: row.company,
          ticker: row.ticker,
          tag_name: client.tagNames.get(matched[0]) ?? null,
          matched_via: row.matched_via,
        });
      }
      if (events.length > 0) {
        groups.push({ client_id: clientId, name: client.name, events });
      }
    }

    res.json({ groups, days, window: { start: windowStart, end: windowEnd } });
  } catch (err: any) {
    console.error('[AdvisorEvents] List error:', err.message);
    res.status(500).json({ error: 'Failed to list events' });
  }
});

export default router;
