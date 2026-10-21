/**
 * =============================================================================
 * PULSE — Advisor module: общие хелперы (ТЗ-182)
 * =============================================================================
 *
 * Модуль-песочница клиентских портфелей. Ядро этот файл не импортирует
 * (единственное касание ядра — lazy-вызов archiveExcessAdvisorClients из
 * applyDowngradeNow, services/subscription.ts).
 *
 *   - getOwnedClient        — guard владения свежим SELECT на каждый запрос
 *   - advisorAudit          — аудит-лог действий модуля (стабильный id клиента)
 *   - archiveExcessAdvisorClients — даунгрейд-хук (Задача 4 ТЗ-182)
 */

import { query } from '../config/db';

export interface OwnedClient {
  id: number;
  advisor_user_id: string;
  name: string;
  is_archived: boolean;
  sort_order: number;
}

/**
 * Guard владения: свежий SELECT на каждый запрос (прецедент ТЗ-120 — admin.ts
 * перепроверяет is_admin в БД). Не доверяем JWT/сессии/параметрам.
 * Не найден или чужой → null (роут отвечает 403 advisor_client_forbidden);
 * проверка архивности — на стороне роута для write-операций
 * (403 advisor_client_archived).
 */
export async function getOwnedClient(clientId: number, userId: string): Promise<OwnedClient | null> {
  const result = await query(
    `SELECT id, advisor_user_id, name, is_archived, sort_order
     FROM advisor_clients
     WHERE id = $1`,
    [clientId]
  );
  const row = result.rows[0];
  if (!row) return null;
  if (row.advisor_user_id !== userId) return null;
  return {
    id: Number(row.id),
    advisor_user_id: row.advisor_user_id,
    name: row.name,
    is_archived: row.is_archived === true || row.is_archived === 1,
    sort_order: Number(row.sort_order),
  };
}

/**
 * Аудит-лог модуля. Стабильный id клиента, не имя.
 */
export function advisorAudit(
  userId: string,
  action: 'create' | 'archive' | 'restore' | 'rename' | 'tag_add' | 'tag_remove' | 'downgrade_archive',
  clientId: number
): void {
  console.log(`[Advisor] user=${userId} action=${action} client=${clientId}`);
}

/**
 * Даунгрейд-хук (ТЗ-182 Задача 4.4): архивирует клиентские портфели сверх
 * нового лимита тарифа. Архивируются самые поздние по sort_order
 * (при равенстве — поздние по created_at/id). Каждая архивация пишет аудит.
 * newLimit < 0 = безлимитный тариф — ничего не делает.
 * Восстановление при последующем апгрейде — только руками (v10).
 */
export async function archiveExcessAdvisorClients(userId: string, newLimit: number): Promise<number> {
  if (newLimit < 0) return 0;

  const active = await query(
    `SELECT id FROM advisor_clients
     WHERE advisor_user_id = $1 AND is_archived = FALSE
     ORDER BY sort_order ASC, created_at ASC, id ASC`,
    [userId]
  );

  const excess = active.rows.slice(Math.max(0, newLimit));
  let archived = 0;
  for (const row of excess) {
    await query(
      `UPDATE advisor_clients SET is_archived = TRUE WHERE id = $1 AND is_archived = FALSE`,
      [row.id]
    );
    advisorAudit(userId, 'downgrade_archive', Number(row.id));
    archived++;
  }

  if (archived > 0) {
    console.log(`[Advisor] Downgrade archive: user=${userId} archived=${archived} limit=${newLimit}`);
  }
  return archived;
}
