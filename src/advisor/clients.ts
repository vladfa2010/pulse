/**
 * =============================================================================
 * PULSE — Advisor module: клиенты и их теги (ТЗ-182 Задача 3)
 * =============================================================================
 *
 * Эндпоинты (роутер смонтирован под /api/advisor с гейтом multi_portfolio):
 *   GET    /clients                 — список клиентов (все, включая архивные)
 *   POST   /clients                 — создать (гейт portfolio_limit тарифа)
 *   GET    /clients/:id             — деталь: клиент + теги + counts
 *   PATCH  /clients/:id             — переименовать / архивировать / восстановить
 *   GET    /clients/:id/tags        — теги клиента
 *   POST   /clients/:id/tags        — добавить тег (реестр ядра + лимит tag_limit)
 *   DELETE /clients/:id/tags/:tagId — отвязать тег (:tagId = id строки advisor_client_tags)
 *
 * DELETE клиента нет — только архив (данные клиента не исчезают безвозвратно).
 */

import { Router, Response } from 'express';
import { z } from 'zod';
import { query } from '../config/db';
import { AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getPlanById } from '../services/subscription';
import { resolveRegistryTag } from '../services/tagManager';
import { getUserPlanId } from '../utils/users';
import { slugifyTagId } from '../utils/slugifyTag';
import { advisorAudit, getOwnedClient, OwnedClient } from './service';
import { selectNewsByTags } from '../services/userSummary';

const router = Router();

const CreateClientSchema = z.object({
  name: z.string().max(100),
});

const PatchClientSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_archived: z.boolean().optional(),
});

const AddClientTagSchema = z.object({
  tag_name: z.string().min(1).max(100),
});

async function getAdvisorPlan(userId: string) {
  const planId = (await getUserPlanId(userId)) || 'free';
  return getPlanById(planId);
}

/**
 * Guard владения + ответ 403 при нарушении. Возвращает null, если ответ уже отправлен.
 */
async function requireOwnedClient(
  res: Response,
  clientId: number,
  userId: string,
  write: boolean
): Promise<OwnedClient | null> {
  const client = await getOwnedClient(clientId, userId);
  if (!client) {
    res.status(403).json({ error: 'advisor_client_forbidden' });
    return null;
  }
  if (write && client.is_archived) {
    res.status(403).json({ error: 'advisor_client_archived' });
    return null;
  }
  return client;
}

function parseClientId(raw: string, res: Response): number | null {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid_client_id' });
    return null;
  }
  return id;
}

// GET /api/advisor/clients — список клиентов пользователя
router.get('/', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const result = await query(
      `SELECT c.id, c.name, c.notes, c.is_archived, c.sort_order, c.created_at,
              COUNT(t.id) AS active_tags
       FROM advisor_clients c
       LEFT JOIN advisor_client_tags t ON t.client_id = c.id
       WHERE c.advisor_user_id = $1
       GROUP BY c.id
       ORDER BY c.sort_order ASC, c.created_at ASC`,
      [userId]
    );
    res.json({
      clients: result.rows.map((r: any) => ({
        id: Number(r.id),
        name: r.name,
        notes: r.notes ?? null,
        is_archived: r.is_archived === true || r.is_archived === 1,
        sort_order: Number(r.sort_order),
        created_at: r.created_at,
        active_tags: Number(r.active_tags),
      })),
    });
  } catch (err: any) {
    console.error('[Advisor] List clients error:', err.message);
    res.status(500).json({ error: 'Failed to list clients' });
  }
});

// POST /api/advisor/clients — создать клиента (без LLM-вызова)
router.post('/', validate(CreateClientSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const name = (req.body.name as string).trim();
    if (!name || name.length > 100) {
      return res.status(400).json({ error: 'invalid_name', hint: 'name must be 1..100 chars after trim' });
    }

    const plan = await getAdvisorPlan(userId);
    if (!plan) {
      console.error(`[Advisor] Plan not found for user ${userId}`);
      return res.status(500).json({ error: 'Plan not configured' });
    }
    const limit = plan.portfolio_limit ?? 0;
    if (limit >= 0) {
      const countResult = await query(
        `SELECT COUNT(*) AS cnt FROM advisor_clients
         WHERE advisor_user_id = $1 AND is_archived = FALSE`,
        [userId]
      );
      const activeCount = Number(countResult.rows[0]?.cnt || 0);
      if (activeCount >= limit) {
        return res.status(403).json({ error: 'advisor_limit_reached', limit });
      }
    }

    const insertResult = await query(
      `INSERT INTO advisor_clients (advisor_user_id, name, sort_order)
       VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) FROM advisor_clients WHERE advisor_user_id = $1), 0) + 1)
       RETURNING id, name, notes, is_archived, sort_order, created_at`,
      [userId, name]
    );
    const row = insertResult.rows[0];
    advisorAudit(userId, 'create', Number(row.id));
    res.status(201).json({
      client: {
        id: Number(row.id),
        name: row.name,
        notes: row.notes ?? null,
        is_archived: row.is_archived === true || row.is_archived === 1,
        sort_order: Number(row.sort_order),
        created_at: row.created_at,
        active_tags: 0,
      },
    });
  } catch (err: any) {
    console.error('[Advisor] Create client error:', err.message);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

// GET /api/advisor/clients/:id — деталь для экрана клиента (архивная читается)
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = parseClientId(req.params.id, res);
    if (clientId === null) return;

    const client = await requireOwnedClient(res, clientId, userId, false);
    if (!client) return;

    const tagsResult = await query(
      `SELECT id, tag_id, tag_name, tag_type, created_at
       FROM advisor_client_tags
       WHERE client_id = $1
       ORDER BY created_at ASC, id ASC`,
      [clientId]
    );
    const tags = tagsResult.rows.map((t: any) => ({
      id: Number(t.id),
      tag_id: t.tag_id,
      tag_name: t.tag_name,
      tag_type: t.tag_type,
      created_at: t.created_at,
    }));
    res.json({
      client: {
        id: client.id,
        name: client.name,
        is_archived: client.is_archived,
        sort_order: client.sort_order,
      },
      tags,
      counts: { tags: tags.length },
    });
  } catch (err: any) {
    console.error('[Advisor] Get client error:', err.message);
    res.status(500).json({ error: 'Failed to get client' });
  }
});

// PATCH /api/advisor/clients/:id — переименовать / архивировать / восстановить
router.patch('/:id', validate(PatchClientSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = parseClientId(req.params.id, res);
    if (clientId === null) return;

    const { name, is_archived } = req.body as { name?: string; is_archived?: boolean };

    // Восстановление (is_archived: false) — единственная write-операция над
    // архивным клиентом; rename/archive на архивном → 403.
    const client = await requireOwnedClient(res, clientId, userId, is_archived !== false);
    if (!client) return;

    if (is_archived === false && client.is_archived) {
      const plan = await getAdvisorPlan(userId);
      if (!plan) {
        console.error(`[Advisor] Plan not found for user ${userId}`);
        return res.status(500).json({ error: 'Plan not configured' });
      }
      const limit = plan.portfolio_limit ?? 0;
      if (limit >= 0) {
        const countResult = await query(
          `SELECT COUNT(*) AS cnt FROM advisor_clients
           WHERE advisor_user_id = $1 AND is_archived = FALSE`,
          [userId]
        );
        if (Number(countResult.rows[0]?.cnt || 0) >= limit) {
          return res.status(403).json({ error: 'advisor_limit_reached', limit });
        }
      }
    }

    if (name !== undefined) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 100) {
        return res.status(400).json({ error: 'invalid_name', hint: 'name must be 1..100 chars after trim' });
      }
      await query(`UPDATE advisor_clients SET name = $1 WHERE id = $2`, [trimmed, clientId]);
      advisorAudit(userId, 'rename', clientId);
    }
    if (is_archived === true && !client.is_archived) {
      await query(`UPDATE advisor_clients SET is_archived = TRUE WHERE id = $1`, [clientId]);
      advisorAudit(userId, 'archive', clientId);
    } else if (is_archived === false && client.is_archived) {
      await query(`UPDATE advisor_clients SET is_archived = FALSE WHERE id = $1`, [clientId]);
      advisorAudit(userId, 'restore', clientId);
    }

    const updated = await getOwnedClient(clientId, userId);
    res.json({
      client: updated && {
        id: updated.id,
        name: updated.name,
        is_archived: updated.is_archived,
        sort_order: updated.sort_order,
      },
    });
  } catch (err: any) {
    console.error('[Advisor] Patch client error:', err.message);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

// GET /api/advisor/clients/:id/tags — теги клиента
router.get('/:id/tags', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = parseClientId(req.params.id, res);
    if (clientId === null) return;

    const client = await requireOwnedClient(res, clientId, userId, false);
    if (!client) return;

    const result = await query(
      `SELECT id, tag_id, tag_name, tag_type, created_at
       FROM advisor_client_tags
       WHERE client_id = $1
       ORDER BY created_at ASC, id ASC`,
      [clientId]
    );
    res.json({
      tags: result.rows.map((t: any) => ({
        id: Number(t.id),
        tag_id: t.tag_id,
        tag_name: t.tag_name,
        tag_type: t.tag_type,
        created_at: t.created_at,
      })),
    });
  } catch (err: any) {
    console.error('[Advisor] List client tags error:', err.message);
    res.status(500).json({ error: 'Failed to list client tags' });
  }
});

// POST /api/advisor/clients/:id/tags — добавить тег
// Резолв/создание имени — в глобальном реестре user_defined_tags через
// resolveRegistryTag (библиотечная логика ядра; append-only, инертна при
// откате модуля). Freeze-механика ядра на модуль НЕ распространяется:
// лимит тегов на клиента = tag_limit тарифа, считается по advisor_client_tags.
router.post('/:id/tags', validate(AddClientTagSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = parseClientId(req.params.id, res);
    if (clientId === null) return;

    const client = await requireOwnedClient(res, clientId, userId, true);
    if (!client) return;

    const tagName = (req.body.tag_name as string).trim();
    if (!tagName || tagName.length > 100) {
      return res.status(400).json({ error: 'invalid_tag_name', hint: 'tag_name must be 1..100 chars after trim' });
    }

    const plan = await getAdvisorPlan(userId);
    if (!plan) {
      console.error(`[Advisor] Plan not found for user ${userId}`);
      return res.status(500).json({ error: 'Plan not configured' });
    }
    const limit = plan.tag_limit;
    if (limit >= 0) {
      const countResult = await query(
        `SELECT COUNT(*) AS cnt FROM advisor_client_tags WHERE client_id = $1`,
        [clientId]
      );
      if (Number(countResult.rows[0]?.cnt || 0) >= limit) {
        return res.status(403).json({ error: 'tag_limit_reached', limit });
      }
    }

    const resolution = await resolveRegistryTag(userId, slugifyTagId(tagName), tagName, 'auto');
    if (!resolution.success) {
      return res.status(500).json({ error: 'Failed to resolve tag' });
    }

    const insertResult = await query(
      `INSERT INTO advisor_client_tags (client_id, tag_id, tag_name, tag_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, tag_name) DO NOTHING
       RETURNING id, tag_id, tag_name, tag_type, created_at`,
      [clientId, resolution.finalTagId, resolution.resolvedTagName, resolution.finalType]
    );

    if (insertResult.rows.length > 0) {
      const row = insertResult.rows[0];
      advisorAudit(userId, 'tag_add', clientId);
      return res.status(201).json({
        tag: {
          id: Number(row.id),
          tag_id: row.tag_id,
          tag_name: row.tag_name,
          tag_type: row.tag_type,
          created_at: row.created_at,
        },
        alreadyAdded: false,
      });
    }

    // Уже прикреплён (регистрозависимый UNIQUE(client_id, tag_name)) — идемпотентно
    const existing = await query(
      `SELECT id, tag_id, tag_name, tag_type, created_at
       FROM advisor_client_tags WHERE client_id = $1 AND tag_name = $2`,
      [clientId, resolution.resolvedTagName]
    );
    res.json({
      tag: existing.rows[0] && {
        id: Number(existing.rows[0].id),
        tag_id: existing.rows[0].tag_id,
        tag_name: existing.rows[0].tag_name,
        tag_type: existing.rows[0].tag_type,
        created_at: existing.rows[0].created_at,
      },
      alreadyAdded: true,
    });
  } catch (err: any) {
    console.error('[Advisor] Add client tag error:', err.message);
    res.status(500).json({ error: 'Failed to add client tag' });
  }
});

// GET /api/advisor/clients/:id/news?limit=30 — лента новостей по тегам клиента
// (ТЗ-182 Задача 8, backend-часть). Формат карточек — по образцу ответа основной
// ленты (/api/news). Отметка прочитанного не нужна: фронт шлёт существующий
// POST /api/news/:id/read. Окно — 90 дней (как timeFilterSql основной ленты),
// selectNewsByTags — библиотека Задачи 5 (без копипасты фильтра ядра).
router.get('/:id/news', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = parseClientId(req.params.id, res);
    if (clientId === null) return;

    const client = await requireOwnedClient(res, clientId, userId, false);
    if (!client) return;

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 30, 1), 100);

    const tagsResult = await query(
      `SELECT tag_id FROM advisor_client_tags WHERE client_id = $1 AND tag_id IS NOT NULL`,
      [clientId]
    );
    const tagIds = [...new Set(tagsResult.rows.map((r: any) => r.tag_id as string).filter(Boolean))];
    if (tagIds.length === 0) {
      return res.json({ articles: [], limit, hasMore: false });
    }

    // 90 дней = окно основной ленты (services/newsReads.ts timeFilterSql)
    const articles = await selectNewsByTags(tagIds, 24 * 90, limit);

    res.json({
      articles: articles.map((a) => ({
        id: a.id,
        slug: a.slug,
        title_ru: a.title,
        title_original: a.title_original,
        summary_ru: a.summary,
        summary_original: a.summary_original,
        source: a.source,
        url: a.url,
        published_at: a.published_at,
        sentiment: a.sentiment,
        sentiment_score: a.sentiment_score,
        matched_tags: a.tags,
        source_count: a.source_count,
        all_sources: a.all_sources,
      })),
      limit,
      hasMore: articles.length >= limit,
    });
  } catch (err: any) {
    console.error('[Advisor] Client news error:', err.message);
    res.status(500).json({ error: 'Failed to fetch client news' });
  }
});

// DELETE /api/advisor/clients/:id/tags/:tagId — отвязать тег
// :tagId — id строки advisor_client_tags (как в ответах GET /tags).
router.delete('/:id/tags/:tagId', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const clientId = parseClientId(req.params.id, res);
    if (clientId === null) return;
    const tagRowId = Number(req.params.tagId);
    if (!Number.isInteger(tagRowId) || tagRowId <= 0) {
      return res.status(400).json({ error: 'invalid_tag_id' });
    }

    const client = await requireOwnedClient(res, clientId, userId, true);
    if (!client) return;

    const deleteResult = await query(
      `DELETE FROM advisor_client_tags WHERE id = $1 AND client_id = $2 RETURNING id`,
      [tagRowId, clientId]
    );
    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ error: 'advisor_tag_not_found' });
    }
    advisorAudit(userId, 'tag_remove', clientId);
    res.json({ deleted: true });
  } catch (err: any) {
    console.error('[Advisor] Remove client tag error:', err.message);
    res.status(500).json({ error: 'Failed to remove client tag' });
  }
});

export default router;
