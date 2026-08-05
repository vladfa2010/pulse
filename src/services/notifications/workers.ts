/**
 * PULSE — Notification Workers (cron).
 *
 * Фикс хрупкого триггера: вместо setInterval с ручной проверкой mskMinute===0
 * (пропускал целый час при любом лаге event loop или рестарте) —
 * node-cron с явным timezone Europe/Moscow, как уже сделано в reports.ts.
 */

import cron from 'node-cron';
import { query } from '../../config/db';
import { broadcastProduct } from './dispatcher';
import { Product } from './types';
import { nowSql } from '../../utils/nowSql';

type TaskName = 'digest' | 'weekly_report';

export function startNotificationWorkers(): void {
  // Дайджест — каждый час в :00 МСК
  cron.schedule('0 * * * *', () => {
    runBroadcast('digest').catch(e => console.error('[Worker:digest] error:', e));
  }, { timezone: 'Europe/Moscow' });
  console.log('[Worker:digest] Scheduled hourly at :00 Europe/Moscow');

  // Weekly report — воскресенье 13:00 МСК
  cron.schedule('0 13 * * 0', () => {
    runBroadcast('weekly_report').catch(e => console.error('[Worker:weekly_report] error:', e));
  }, { timezone: 'Europe/Moscow' });
  console.log('[Worker:weekly_report] Scheduled Sunday at 13:00 Europe/Moscow');
}

async function runBroadcast(product: Product): Promise<void> {
  const taskName: TaskName = product === 'digest' || product === 'weekly_report' ? product : 'digest';

  // Audit: одна строка cron_log, как раньше (админка её показывает)
  try {
    const upd = await query(
      `UPDATE cron_log SET started_at = ${nowSql()}, status = 'running', finished_at = NULL,
       articles_fetched = NULL, articles_saved = NULL WHERE task_name = $1`,
      [taskName]
    );
    if (upd.rowCount === 0) {
      await query(`INSERT INTO cron_log (task_name, started_at, status) VALUES ($1, ${nowSql()}, 'running')`, [taskName]);
    }
  } catch { /* cron_log — best effort */ }

  const result = await broadcastProduct(product);

  try {
    await query(
      `UPDATE cron_log SET finished_at = ${nowSql()}, status = 'completed',
       articles_fetched = $2, articles_saved = $3 WHERE task_name = $1`,
      [taskName, result.sent + result.skipped + result.empty + result.errors, result.sent]
    );
  } catch { /* ignore */ }
}

export { runBroadcast };
