/**
 * =============================================================================
 * PULSE — LMS: tenure подписки в днях (ТЗ-100 v13, критерии 20-21)
 * =============================================================================
 *
 * MVP-оценка накопленных дней активной подписки (дрип-режим уроков).
 *
 * ИСТОЧНИК ДАННЫХ (зафиксировано, риск ТЗ-100 v13): история активности
 * хранится в таблице subscription_renewals (period_start/period_end со
 * статусом 'completed' — пишется при каждой активации/продлении подписки,
 * см. services/subscription.ts:439). Паузы (подписка мертва) tenure не
 * уменьшают и не увеличивают — «заморозка», а не сброс: суммируются только
 * интервалы активности.
 *
 * TODO(ТЗ-100 v13): если полной истории нет (подписка старше таблицы
 * renewals / записей нет) — возвращаем текущий активный период от
 * users.created_at до now как нижнюю оценку. Точную границу текущего
 * периода (дата первого платежа текущей непрерывной активности) при
 * появлении отдельной колонки subscription_started_at заменить здесь.
 */

import { query } from '../../config/db';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function subscriptionTenureDays(userId: string): Promise<number> {
  const now = Date.now();

  // Сумма интервалов активности из истории подписок (renewals).
  const renewals = await query(
    `SELECT period_start, period_end FROM subscription_renewals
     WHERE user_id = $1 AND status = 'completed'`,
    [userId],
  );

  let tenureMs = 0;
  for (const row of renewals.rows) {
    if (!row.period_start) continue;
    const start = new Date(row.period_start).getTime();
    // Незакрытый период (period_end NULL) считаем до текущего момента.
    const endRaw = row.period_end ? new Date(row.period_end).getTime() : now;
    const end = Math.min(endRaw, now);
    if (Number.isFinite(start) && end > start) {
      tenureMs += end - start;
    }
  }

  // Если истории нет, а подписка активна — MVP-оценка: текущий период от
  // регистрации юзера (created_at) до now. TODO: заменить на дату первого
  // платежа текущего периода при появлении subscription_started_at.
  if (tenureMs === 0) {
    const user = await query(
      `SELECT subscription_active, created_at FROM users WHERE id = $1`,
      [userId],
    );
    const row = user.rows[0];
    if (row && Number(row.subscription_active) === 1 && row.created_at) {
      const start = new Date(row.created_at).getTime();
      if (Number.isFinite(start) && now > start) {
        tenureMs = now - start;
      }
    }
  }

  return Math.floor(tenureMs / DAY_MS);
}

export default { subscriptionTenureDays };
