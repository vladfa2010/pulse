/**
 * =============================================================================
 * PULSE — Advisor module: заметки клиента (ТЗ-193)
 * =============================================================================
 *
 * Эндпоинты (роутер смонтирован в routes.ts под /api/advisor):
 *   POST   /clients/:id/notes  — добавить заметку (лимит ADVISOR_NOTE_LIMIT)
 *   PATCH  /notes/:noteId      — редактировать (inline-edit, updated_at)
 *   DELETE /notes/:noteId      — удалить (204)
 *
 * Модель: лента advisor_notes (до 5 на клиента), замещает одиночную колонку
 * advisor_clients.notes (ТЗ-183 Задача 5) — колонка не дропается (песочница).
 * Одиночные эндпоинты резолвят заметку → клиента → владение (getOwnedClient);
 * коды ошибок единые с модулем: advisor_client_forbidden / advisor_client_archived.
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getOwnedClient } from './service';
import { nowSql } from '../utils/nowSql';

const router = Router();

export const ADVISOR_NOTE_LIMIT = 5;
const NOTE_MAX_LEN = 2000;
const NoteTextSchema = z.object({
  text: z.string().min(1).max(NOTE_MAX_LEN),
});

const iso = (v: any) => (v ? new Date(v).toISOString() : null);

function toNote(row: any) {
  return { id: Number(row.id), text: row.text, created_at: iso(row.created_at), updated_at: iso(row.updated_at) };
}

/** Guard: заметка существует → клиент принадлежит юзеру (write). null = ответ отправлен. */
async function requireOwnedNote(res: Response, noteId: number, userId: string): Promise<any> {
  const result = await query(`SELECT id, client_id FROM advisor_notes WHERE id = $1`, [noteId]);
  const note = result.rows[0];
  if (!note) {
    res.status(404).json({ error: 'advisor_note_not_found' });
    return null;
  }
  const client = await getOwnedClient(Number(note.client_id), userId);
  if (!client) {
    res.status(403).json({ error: 'advisor_client_forbidden' });
    return null;
  }
  if (client.is_archived) {
    res.status(403).json({ error: 'advisor_client_archived' });
    return null;
  }
  return note;
}

// POST /api/advisor/clients/:id/notes — добавить заметку
router.post('/clients/:id/notes', validate(NoteTextSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = Number(req.params.id);
    if (!Number.isInteger(clientId) || clientId <= 0) {
      return res.status(400).json({ error: 'invalid_client_id' });
    }
    const client = await getOwnedClient(clientId, userId);
    if (!client) return res.status(403).json({ error: 'advisor_client_forbidden' });
    if (client.is_archived) return res.status(403).json({ error: 'advisor_client_archived' });

    const text = (req.body.text as string).trim();
    if (!text) return res.status(400).json({ error: 'invalid_note_text' });

    const count = await query(`SELECT COUNT(*) AS cnt FROM advisor_notes WHERE client_id = $1`, [clientId]);
    if (Number(count.rows[0]?.cnt || 0) >= ADVISOR_NOTE_LIMIT) {
      return res.status(403).json({ error: 'note_limit_reached', limit: ADVISOR_NOTE_LIMIT });
    }

    const inserted = await query(
      `INSERT INTO advisor_notes (client_id, text) VALUES ($1, $2) RETURNING id, text, created_at, updated_at`,
      [clientId, text]
    );
    res.status(201).json({ note: toNote(inserted.rows[0]) });
  } catch (err: any) {
    console.error('[Advisor] Create note error:', err.message);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// PATCH /api/advisor/notes/:noteId — редактировать заметку (updated_at = now)
router.patch('/notes/:noteId', validate(NoteTextSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const noteId = Number(req.params.noteId);
    if (!Number.isInteger(noteId) || noteId <= 0) {
      return res.status(400).json({ error: 'invalid_note_id' });
    }
    const note = await requireOwnedNote(res, noteId, userId);
    if (!note) return;

    const text = (req.body.text as string).trim();
    if (!text) return res.status(400).json({ error: 'invalid_note_text' });

    const updated = await query(
      `UPDATE advisor_notes SET text = $1, updated_at = ${nowSql()} WHERE id = $2 RETURNING id, text, created_at, updated_at`,
      [text, noteId]
    );
    res.json({ note: toNote(updated.rows[0]) });
  } catch (err: any) {
    console.error('[Advisor] Update note error:', err.message);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

// DELETE /api/advisor/notes/:noteId — удалить заметку
router.delete('/notes/:noteId', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const noteId = Number(req.params.noteId);
    if (!Number.isInteger(noteId) || noteId <= 0) {
      return res.status(400).json({ error: 'invalid_note_id' });
    }
    const note = await requireOwnedNote(res, noteId, userId);
    if (!note) return;

    await query(`DELETE FROM advisor_notes WHERE id = $1`, [noteId]);
    res.status(204).end();
  } catch (err: any) {
    console.error('[Advisor] Delete note error:', err.message);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

export default router;
