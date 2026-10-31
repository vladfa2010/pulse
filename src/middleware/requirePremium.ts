/**
 * =============================================================================
 * PULSE — Require Premium Middleware
 * =============================================================================
 *
 * Гейт доступа к фактчекингу (новостному и ad-hoc).
 *
 * ТЗ-208: единый источник правды — фича-флаг `factcheck` плана
 * (subscription_plans.features), а не plan_level. Проверка — через
 * hasFeature() (grace-aware, сверяет features_registry.is_active).
 * Текст 403 динамический: перечисляет тарифы, где флаг включён.
 *
 * Использование:
 *   if (!(await requirePremium(req, res))) return;
 */

import type { Response } from 'express';
import type { AuthRequest } from './auth';
import { hasFeature, getActivePlans } from '../services/subscription';

async function requirePremium(req: AuthRequest, res: Response): Promise<boolean> {
  const userId = req.user!.userId;

  if (await hasFeature(userId, 'factcheck')) return true;

  const eligible = (await getActivePlans()).filter((p) => p.features?.factcheck === true);
  const names = eligible.map((p) => p.name).join(', ');
  res.status(403).json({
    error: names
      ? `Факт-чекинг доступен на тарифах: ${names}`
      : 'Факт-чекинг недоступен на текущих тарифах',
    upgrade_required: true,
    min_plan: eligible[0]?.id ?? null,
    min_price: eligible[0]?.price ?? null,
  });
  return false;
}

export default requirePremium;
