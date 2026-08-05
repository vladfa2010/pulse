/**
 * PULSE — Portfolio sync cron worker
 *
 * Runs every 15 minutes (MSK). Processes active broker portfolios with ok keys,
 * applies diff to broker_positions, rotates BCS refresh tokens, and marks keys
 * invalid after 3 consecutive failures or on 401.
 */

import cron from 'node-cron';
import { query } from '../../config/db';
import * as crypto from '../crypto';
import { getBrokerAdapter, BrokerPosition } from '../brokerApi';
import {
  getAllActiveBrokerKeys,
  getPortfolioById,
  getPortfolioPositions,
  applyPositionDiff,
  updateKeyTokenAfterSync,
} from '../brokerPortfolioService';
import { BrokerKeyRow } from '../brokerKeyService';
import { nowSql } from '../../utils/nowSql';

function isInFinamMaintenanceWindow(): boolean {
  const now = new Date();
  const msk = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const hour = msk.getUTCHours();
  const minute = msk.getUTCMinutes();
  return hour === 5 && minute <= 15;
}

function hashToJitterMs(keyId: string, maxMs: number): number {
  let hash = 0;
  for (let i = 0; i < keyId.length; i++) {
    hash = ((hash << 5) - hash) + keyId.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) % maxMs;
}

async function logCron(taskName: string, status: string, fetched: number, saved: number, errors?: string): Promise<void> {
  try {
    await query(
      `INSERT INTO cron_log (task_name, started_at, finished_at, status, articles_fetched, articles_saved, errors)
       VALUES ($1, ${nowSql()}, ${nowSql()}, $2, $3, $4, $5)`,
      [taskName, status, fetched, saved, errors || null]
    );
  } catch (err: any) {
    console.error('[PortfolioSyncWorker] Failed to log cron:', err.message);
  }
}

async function syncOneKey(key: BrokerKeyRow & { portfolio_id: string }): Promise<void> {
  const portfolio = await getPortfolioById(key.user_id, key.portfolio_id);
  if (!portfolio) {
    console.log(`[PortfolioSync] Portfolio ${key.portfolio_id} not found, skipping`);
    return;
  }

  if (key.broker === 'finam' && isInFinamMaintenanceWindow()) {
    console.log(`[PortfolioSync] Finam maintenance window, skipping ${key.id}`);
    return;
  }

  let token: string;
  try {
    token = crypto.decrypt(key.token_encrypted);
  } catch (err: any) {
    console.error(`[PortfolioSync] Failed to decrypt token for key ${key.id}:`, err.message);
    await markKeyInvalid(key.id, 'decrypt_failed');
    return;
  }

  const adapter = getBrokerAdapter(key.broker);
  try {
    const res = await adapter.getPositions(token);
    if (res.newToken && res.newToken !== token) {
      await updateKeyTokenAfterSync(key.id, res.newToken);
    }

    await applyPositionDiff(key.user_id, portfolio.id, res.positions, 'api');
    await query(
      `UPDATE broker_portfolios SET last_synced_at = ${nowSql()}, updated_at = ${nowSql()} WHERE id = $1`,
      [portfolio.id]
    );
    await query(
      `UPDATE broker_keys
       SET status = 'ok', last_error = NULL, consecutive_failures = 0, last_synced_at = ${nowSql()}, updated_at = ${nowSql()}
       WHERE id = $1`,
      [key.id]
    );
    console.log(`[PortfolioSync] Key ${key.id} (${key.broker}) synced: ${res.positions.length} positions`);
  } catch (err: any) {
    const error = err.message || 'broker_unavailable';
    console.error(`[PortfolioSync] Key ${key.id} (${key.broker}) failed: ${error}`);

    if (error === 'broker_key_invalid' || error === 'broker_maintenance') {
      await markKeyInvalid(key.id, error);
      if (error === 'broker_maintenance') {
        // Do not mark consecutive failures, just note
        await query(
          `UPDATE broker_keys SET last_error = $1, updated_at = ${nowSql()} WHERE id = $2`,
          [error, key.id]
        );
      }
      return;
    }

    await query(
      `UPDATE broker_keys
       SET consecutive_failures = consecutive_failures + 1,
           last_error = $1,
           updated_at = ${nowSql()}
       WHERE id = $2
       RETURNING consecutive_failures`,
      [error, key.id]
    );
  }
}

async function markKeyInvalid(keyId: string, error: string): Promise<void> {
  await query(
    `UPDATE broker_keys
     SET status = 'error', last_error = $1, updated_at = ${nowSql()}
     WHERE id = $2`,
    [error, keyId]
  );
}

async function runSyncCycle(): Promise<void> {
  const keys = await getAllActiveBrokerKeys();
  console.log(`[PortfolioSync] Cycle started: ${keys.length} active keys`);

  let totalPositions = 0;
  let processed = 0;

  const CONCURRENCY = 5;
  async function worker(chunk: (BrokerKeyRow & { portfolio_id: string })[]) {
    for (const key of chunk) {
      const jitter = hashToJitterMs(key.id, 15 * 60 * 1000);
      await new Promise(r => setTimeout(r, jitter));
      await syncOneKey(key);
      processed++;
      totalPositions += await getPortfolioPositionsCount(key.portfolio_id);
    }
  }

  const promises: Promise<void>[] = [];
  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    promises.push(worker(keys.slice(i, i + CONCURRENCY)));
  }
  await Promise.all(promises);

  await logCron('portfolio_sync', 'completed', totalPositions, processed);
  console.log(`[PortfolioSync] Cycle finished: ${processed} keys processed`);
}

async function getPortfolioPositionsCount(portfolioId: string): Promise<number> {
  try {
    const result = await query(
      `SELECT COUNT(*) as cnt FROM broker_positions WHERE broker_portfolio_id = $1`,
      [portfolioId]
    );
    return Number(result.rows[0]?.cnt || 0);
  } catch {
    return 0;
  }
}

export function startPortfolioSyncWorker(): void {
  cron.schedule('*/15 * * * *', () => {
    runSyncCycle().catch(err => {
      console.error('[PortfolioSyncWorker] Unhandled cycle error:', err.message);
      logCron('portfolio_sync', 'error', 0, 0, err.message).catch(() => {});
    });
  }, { timezone: 'Europe/Moscow' });
  console.log('[PortfolioSyncWorker] Scheduled every 15 minutes Europe/Moscow');
}

export { runSyncCycle };
