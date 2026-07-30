/**
 * PULSE — Broker key management service
 */

import { query } from '../config/db';
import * as crypto from './crypto';
import nodeCrypto from 'crypto';
import { getBrokerAdapter, Broker } from './brokerApi';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

function validateBroker(broker: string): asserts broker is Broker {
  if (!['inside', 'finam', 'bcs'].includes(broker)) {
    throw new Error('Unsupported broker');
  }
}

export interface BrokerKeyRow {
  id: string;
  user_id: string;
  broker: Broker;
  label: string;
  token_encrypted: string;
  token_tail: string;
  status: 'ok' | 'error';
  last_error: string | null;
  consecutive_failures: number;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function listBrokerKeys(userId: string): Promise<BrokerKeyRow[]> {
  const result = await query(
    `SELECT bk.*, bp.name as portfolio_name
     FROM broker_keys bk
     LEFT JOIN broker_portfolios bp ON bp.broker_key_id = bk.id
     WHERE bk.user_id = $1
     ORDER BY bk.created_at DESC`,
    [userId]
  );
  return result.rows.map((r: any) => ({
    ...r,
    consecutive_failures: Number(r.consecutive_failures || 0),
  }));
}

export async function getBrokerKeyById(userId: string, keyId: string): Promise<BrokerKeyRow | null> {
  const result = await query(
    `SELECT * FROM broker_keys WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [keyId, userId]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0] as BrokerKeyRow;
}

export async function createBrokerKey(
  userId: string,
  input: { broker: string; label: string; token: string }
): Promise<BrokerKeyRow> {
  validateBroker(input.broker);
  const token = input.token?.trim();
  if (!token) throw new Error('Token is required');

  const adapter = getBrokerAdapter(input.broker);
  const test = await adapter.testKey(token);
  if (!test.ok) {
    throw Object.assign(new Error(test.error || 'broker_key_invalid'), { code: test.error || 'broker_key_invalid' });
  }

  const id = nodeCrypto.randomUUID();
  const encrypted = crypto.encrypt(token);
  const tail = crypto.getTail(token, 4);
  const now = nowSql();

  await query(
    `INSERT INTO broker_keys
       (id, user_id, broker, label, token_encrypted, token_tail, status, last_error, consecutive_failures, last_synced_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'ok', NULL, 0, ${now}, ${now}, ${now})`,
    [id, userId, input.broker, input.label || '', encrypted, tail]
  );

  const key = await getBrokerKeyById(userId, id);
  if (!key) throw new Error('Failed to create broker key');
  return key;
}

export async function updateBrokerKey(
  userId: string,
  keyId: string,
  input: { label?: string; token?: string }
): Promise<BrokerKeyRow> {
  const key = await getBrokerKeyById(userId, keyId);
  if (!key) throw Object.assign(new Error('Broker key not found'), { code: 'not_found' });

  let newEncrypted = key.token_encrypted;
  let newTail = key.token_tail;
  let newStatus: 'ok' | 'error' = 'ok';
  let newLastError: string | null = null;

  if (input.token && input.token.trim()) {
    const token = input.token.trim();
    const adapter = getBrokerAdapter(key.broker);
    const test = await adapter.testKey(token);
    if (!test.ok) {
      throw Object.assign(new Error(test.error || 'broker_key_invalid'), { code: test.error || 'broker_key_invalid' });
    }
    newEncrypted = crypto.encrypt(token);
    newTail = crypto.getTail(token, 4);
    // If BCS rotated the refresh token, persist it
    if (test.newToken) {
      newEncrypted = crypto.encrypt(test.newToken);
      newTail = crypto.getTail(test.newToken, 4);
    }
  }

  await query(
    `UPDATE broker_keys
     SET label = COALESCE($1, label),
         token_encrypted = $2,
         token_tail = $3,
         status = $4,
         last_error = $5,
         consecutive_failures = 0,
         updated_at = ${nowSql()}
     WHERE id = $6 AND user_id = $7`,
    [input.label ?? null, newEncrypted, newTail, newStatus, newLastError, keyId, userId]
  );

  const updated = await getBrokerKeyById(userId, keyId);
  if (!updated) throw new Error('Failed to update broker key');
  return updated;
}

export async function deleteBrokerKey(userId: string, keyId: string): Promise<void> {
  const key = await getBrokerKeyById(userId, keyId);
  if (!key) throw Object.assign(new Error('Broker key not found'), { code: 'not_found' });

  await query(
    `UPDATE broker_portfolios
     SET source = 'manual', broker_key_id = NULL, updated_at = ${nowSql()}
     WHERE broker_key_id = $1 AND user_id = $2`,
    [keyId, userId]
  );

  await query(
    `DELETE FROM broker_keys WHERE id = $1 AND user_id = $2`,
    [keyId, userId]
  );
}

export async function testBrokerKey(
  userId: string,
  keyId: string
): Promise<{ ok: boolean; positionsCount?: number; error?: string }> {
  const key = await getBrokerKeyById(userId, keyId);
  if (!key) throw Object.assign(new Error('Broker key not found'), { code: 'not_found' });

  try {
    const token = crypto.decrypt(key.token_encrypted);
    const adapter = getBrokerAdapter(key.broker);
    const test = await adapter.testKey(token);

    if (test.ok) {
      await query(
        `UPDATE broker_keys SET status = 'ok', last_error = NULL, consecutive_failures = 0, last_synced_at = ${nowSql()}, updated_at = ${nowSql()} WHERE id = $1`,
        [keyId]
      );
    } else {
      await query(
        `UPDATE broker_keys SET status = 'error', last_error = $1, updated_at = ${nowSql()} WHERE id = $2`,
        [test.error || 'broker_key_invalid', keyId]
      );
    }

    return { ok: test.ok, positionsCount: test.positionsCount, error: test.error };
  } catch (err: any) {
    const error = err.code || 'broker_key_invalid';
    await query(
      `UPDATE broker_keys SET status = 'error', last_error = $1, updated_at = ${nowSql()} WHERE id = $2`,
      [error, keyId]
    );
    return { ok: false, error };
  }
}

export async function decryptKeyToken(key: BrokerKeyRow): Promise<string> {
  return crypto.decrypt(key.token_encrypted);
}

export async function markKeyStatus(
  keyId: string,
  status: 'ok' | 'error',
  error?: string
): Promise<void> {
  await query(
    `UPDATE broker_keys
     SET status = $1,
         last_error = $2,
         consecutive_failures = CASE WHEN $1 = 'ok' THEN 0 ELSE consecutive_failures + 1 END,
         updated_at = ${nowSql()}
     WHERE id = $3`,
    [status, error || null, keyId]
  );
}

export async function markKeySynced(keyId: string): Promise<void> {
  await query(
    `UPDATE broker_keys SET last_synced_at = ${nowSql()}, updated_at = ${nowSql()} WHERE id = $1`,
    [keyId]
  );
}

export async function resetKeyFailures(keyId: string): Promise<void> {
  await query(
    `UPDATE broker_keys SET consecutive_failures = 0, status = 'ok', last_error = NULL, updated_at = ${nowSql()} WHERE id = $1`,
    [keyId]
  );
}

export async function incrementKeyFailures(keyId: string, error?: string): Promise<number> {
  const result = await query(
    `UPDATE broker_keys
     SET consecutive_failures = consecutive_failures + 1,
         last_error = $1,
         updated_at = ${nowSql()}
     WHERE id = $2
     RETURNING consecutive_failures`,
    [error || null, keyId]
  );
  const failures = Number(result.rows[0]?.consecutive_failures || 0);
  if (failures >= 3) {
    await query(
      `UPDATE broker_keys SET status = 'error', updated_at = ${nowSql()} WHERE id = $1`,
      [keyId]
    );
  }
  return failures;
}
