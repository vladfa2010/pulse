/**
 * =============================================================================
 * PULSE — Features Registry Routes (boolean-only)
 * =============================================================================
 *
 * Public: GET /api/features
 * Admin:  GET/POST/PUT /api/admin/features (mounted via admin.ts)
 */

import { Router, Request, Response } from 'express';
import { query } from '../config/db';

const router = Router();
const USE_SQLITE = process.env.USE_SQLITE === 'true';

function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

function normalizeFeatureRow(row: any): any {
  return {
    id: row.id,
    label: row.label,
    description: row.description,
    is_active: USE_SQLITE ? Boolean(row.is_active) : row.is_active,
  };
}

// Public list of active features
export async function listFeatures(_req: Request, res: Response): Promise<void> {
  try {
    const result = await query(
      `SELECT id, label, description, is_active
       FROM features_registry
       WHERE is_active = TRUE
       ORDER BY created_at ASC`,
      []
    );
    res.json({ features: result.rows.map(normalizeFeatureRow) });
  } catch (err: any) {
    console.error('[Features] List error:', err.message);
    res.status(500).json({ error: 'Failed to fetch features' });
  }
}

// Admin list all features
export async function listAllFeatures(_req: Request, res: Response): Promise<void> {
  try {
    const result = await query(
      `SELECT id, label, description, is_active
       FROM features_registry
       ORDER BY created_at ASC`,
      []
    );
    res.json({ features: result.rows.map(normalizeFeatureRow) });
  } catch (err: any) {
    console.error('[Features] Admin list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch features' });
  }
}

// Admin create feature
export async function createFeature(req: Request, res: Response): Promise<void> {
  try {
    const { id, label, description, is_active } = req.body;
    await query(
      `INSERT INTO features_registry (id, label, description, is_active)
       VALUES ($1, $2, $3, $4)`,
      [id, label, description || null, is_active !== false]
    );
    const result = await query(
      `SELECT id, label, description, is_active
       FROM features_registry WHERE id = $1`,
      [id]
    );
    res.status(201).json({ feature: normalizeFeatureRow(result.rows[0]) });
  } catch (err: any) {
    console.error('[Features] Create error:', err.message);
    if (err.message?.includes('unique constraint') || err.message?.includes('UNIQUE')) {
      res.status(409).json({ error: 'Feature ID already exists' });
      return;
    }
    res.status(500).json({ error: 'Failed to create feature' });
  }
}

// Admin update feature
export async function updateFeature(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const updates = req.body;
    const allowed = ['label', 'description', 'is_active'];
    const fields: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        fields.push(`${key} = $${paramIdx}`);
        values.push(updates[key]);
        paramIdx++;
      }
    }

    if (fields.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    values.push(id);
    await query(
      `UPDATE features_registry SET ${fields.join(', ')}, updated_at = ${nowSql()} WHERE id = $${paramIdx}`,
      values
    );

    const result = await query(
      `SELECT id, label, description, is_active
       FROM features_registry WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Feature not found' });
      return;
    }
    res.json({ feature: normalizeFeatureRow(result.rows[0]) });
  } catch (err: any) {
    console.error('[Features] Update error:', err.message);
    res.status(500).json({ error: 'Failed to update feature' });
  }
}

router.get('/', listFeatures);

export default router;
