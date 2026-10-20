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
import { generateWeeklySnapshots } from './weeklyReportGenerate';
import { cleanupOldWeeklyReports } from './weeklyReportSnapshot';
import { Product } from './types';
import { nowSql } from '../../utils/nowSql';

type TaskName = 'digest' | 'weekly_report' | 'weekly_report_generate' | 'weekly_report_cleanup';

export function startNotificationWorkers(): void {
  // Дайджест — каждый час в :00 МСК
  cron.schedule('0 * * * *', () => {
    runBroadcast('digest').catch(e => console.error('[Worker:digest] error:', e));
  }, { timezone: 'Europe/Moscow' });
  console.log('[Worker:digest] Scheduled hourly at :00 Europe/Moscow');

  // ТЗ-191: фаза генерации снапшотов — воскресенье 11:00 МСК (ДО рассылки 13:00).
  // Отдельный cron, чтобы ≤6 LLM-вызовов на юзера не растягивали рассылку.
  cron.schedule('0 11 * * 0', () => {
    runGenerateWeeklySnapshots().catch(e => console.error('[Worker:weekly_report_generate] error:', e));
  }, { timezone: 'Europe/Moscow' });
  console.log('[Worker:weekly_report_generate] Scheduled Sunday at 11:00 Europe/Moscow');

  // Weekly report — воскресенье 13:00 МСК (контент — из снапшота, см. dispatcher)
  cron.schedule('0 13 * * 0', () => {
    runBroadcast('weekly_report').catch(e => console.error('[Worker:weekly_report] error:', e));
  }, { timezone: 'Europe/Moscow' });
  console.log('[Worker:weekly_report] Scheduled Sunday at 13:00 Europe/Moscow');

  // ТЗ-191 Задача 6: ретеншн — понедельник 06:30 МСК, hard delete старше 12 недель
  // (каскадно с report_access_tokens; невысланный снапшот текущей недели не трогаем)
  cron.schedule('30 6 * * 1', () => {
    runWeeklyReportCleanup().catch(e => console.error('[Worker:weekly_report_cleanup] error:', e));
  }, { timezone: 'Europe/Moscow' });
  console.log('[Worker:weekly_report_cleanup] Scheduled Monday at 06:30 Europe/Moscow');
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
    // ТЗ-191 Задача 5: счётчики фазы отправки — fetched = все исходы,
    // saved = sent, merged = errors (skipped/empty входят в сумму fetched)
    await query(
      `UPDATE cron_log SET finished_at = ${nowSql()}, status = 'completed',
       articles_fetched = $2, articles_saved = $3, articles_merged = $4 WHERE task_name = $1`,
      [taskName, result.sent + result.skipped + result.empty + result.errors, result.sent, result.errors]
    );
  } catch { /* ignore */ }
}

// ТЗ-191: аудит фазы генерации снапшотов — одна строка cron_log со счётчиками
// generated / errors / llm_calls (articles_fetched / articles_merged / articles_saved).
async function runGenerateWeeklySnapshots(): Promise<void> {
  const taskName: TaskName = 'weekly_report_generate';

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

  let result = { generated: 0, errors: 0, llmCalls: 0 };
  try {
    result = await generateWeeklySnapshots();
  } catch (e) {
    console.error('[Worker:weekly_report_generate] fatal:', e);
    result.errors++;
  }

  try {
    await query(
      `UPDATE cron_log SET finished_at = ${nowSql()}, status = 'completed',
       articles_fetched = $2, articles_saved = $3, articles_merged = $4 WHERE task_name = $1`,
      [taskName, result.generated, result.llmCalls, result.errors]
    );
  } catch { /* ignore */ }
}

// ТЗ-191 Задача 6: аудит очистки ретеншна — одна строка cron_log
// (articles_fetched = удалено). Ошибки — warning, джоба не падает.
async function runWeeklyReportCleanup(): Promise<void> {
  const taskName: TaskName = 'weekly_report_cleanup';

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

  let deleted = 0;
  let status = 'completed';
  try {
    deleted = await cleanupOldWeeklyReports();
  } catch (e) {
    // ТЗ-191 Задача 6: ошибка очистки — warning, НЕ падение джобы
    console.error('[Worker:weekly_report_cleanup] cleanup failed (skipped):', e);
    status = 'completed'; // джоба отработала (с деградацией), крон зелёный
  }

  try {
    await query(
      `UPDATE cron_log SET finished_at = ${nowSql()}, status = $2, articles_fetched = $3 WHERE task_name = $1`,
      [taskName, status, deleted]
    );
  } catch { /* ignore */ }

  if (deleted > 0) {
    console.log(`[Worker:weekly_report_cleanup] deleted ${deleted} old weekly reports`);
  }
}

export { runBroadcast };
