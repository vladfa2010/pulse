/**
 * =============================================================================
 * PULSE — Require Premium Middleware
 * =============================================================================
 *
 * Гейт тарифа Premium+ для эндпоинтов фактчекинга (новостного и ad-hoc).
 * Вынесен из routes/factCheck.ts в shared-хелпер (TZ_FACTCHECK_PAGE v1.3).
 *
 * Использование:
 *   if (!(await requirePremium(req, res))) return;
 */

import type { Response } from 'express';
import type { AuthRequest } from './auth';
import { getUserSubscription, planLevel, computeAccessState } from '../services/subscription';

async function requirePremium(req: AuthRequest, res: Response): Promise<boolean> {
  const userId = req.user!.userId;
  const sub = await getUserSubscription(userId);
  const access = computeAccessState(sub.expiresAt);
  const [currentLevel, premiumLevel] = await Promise.all([
    planLevel(sub.plan),
    planLevel('premium'),
  ]);
  const isEligible = access.active && currentLevel >= premiumLevel;

  if (!isEligible) {
    res.status(403).json({
      error: 'Факт-чекинг доступен только на тарифе Premium и выше',
      upgrade_required: true,
      min_plan: 'premium',
      min_price: 990,
    });
    return false;
  }
  return true;
}

export default requirePremium;
