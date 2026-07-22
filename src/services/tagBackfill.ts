/**
 * =============================================================================
 * PULSE — Tag Backfill Service (event-driven retro scan)
 * =============================================================================
 *
 * Replaces the synchronous backfill block inside NewsSourceManager.
 * Scans existing news articles for a given tag's keywords and appends the tag
 * to news.matched_tags when a match is found.
 *
 * Design goals:
 *   - No blocking in news ingestion cycle.
 *   - Bounded concurrency (max 2 simultaneous scans).
 *   - Chunked by article id to keep queries light.
 *   - PostgreSQL word-boundary regex; SQLite LIKE fallback.
 *   - Idempotent: re-running the same tag skips already tagged articles.
 *   - Persists a `_backfill` marker inside tag.enriched_data.
 */

import { query, pool } from '../config/db';
import { sendTelegramMessage } from './telegram';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

const MAX_CONCURRENT_SCANS = 2;
const DEFAULT_CHUNK_SIZE = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;
const MAX_TOKENS = 500;

const runningScans = new Map<string, Promise<BackfillResult>>();

export interface BackfillOptions {
  dryRun?: boolean;
  chunkSize?: number;
  since?: Date; // optional: only scan articles published after
  adminUserId?: string;
  silent?: boolean; // when true, suppress per-tag success alerts (used by backfillAllTags)
}

export interface BackfillResult {
  tagId: string;
  matched: number;
  scanned: number;
  dryRun: boolean;
  durationMs: number;
  error?: string;
  skipped?: boolean;
}

interface CountResult {
  matched: number;
  tokens: number;
}

interface ScanRecord {
  id: string;
  matched_tags?: string | string[] | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: any;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      console.warn(`[TagBackfill] ${label} attempt ${attempt} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseJsonb(value: any): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function fetchTag(tagId: string): Promise<{ tag_id: string; tag_name: string; keywords: string[]; enriched_data: any } | null> {
  const result = await query(
    `SELECT tag_id, tag_name, keywords, enriched_data FROM user_defined_tags WHERE tag_id = $1`,
    [tagId.toLowerCase()]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    tag_id: row.tag_id,
    tag_name: row.tag_name,
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    enriched_data: parseJsonb(row.enriched_data),
  };
}

/**
 * Build the final keyword list used for scanning.
 * 1. Stored keywords (admin override / enrichment).
 * 2. If empty, fall back to dynamically generated keywords from enrichment.
 * The ticker is intentionally NOT added here — it is already included in stored
 * keywords when enrichment is saved. Adding it unconditionally would ignore
 * admin edits that removed the ticker from keywords.
 */
async function buildScanKeywords(tag: { tag_id: string; tag_name: string; keywords: string[]; enriched_data: any }): Promise<string[]> {
  const keywords = new Set(tag.keywords.map(k => k.toLowerCase().trim()).filter(k => k.length >= 2));
  if (keywords.size > 0) {
    return [...keywords].sort((a, b) => b.length - a.length);
  }

  // Fallback: dynamic keywords from enrichment (breaks the static import cycle
  // with tagManager by using a dynamic import).
  if (tag.enriched_data) {
    try {
      const { buildEnrichedKeywords } = await import('./tagManager');
      const generated = buildEnrichedKeywords(tag.tag_id, tag.enriched_data || null);
      generated.forEach(k => {
        const norm = k.toLowerCase().trim();
        if (norm.length >= 2) keywords.add(norm);
      });
    } catch (err: any) {
      console.warn('[TagBackfill] buildEnrichedKeywords fallback failed:', err.message);
    }
  }

  return [...keywords].sort((a, b) => b.length - a.length);
}

function buildPostgresPattern(keywords: string[]): string | null {
  if (keywords.length === 0) return null;
  const escaped = keywords.map(escapeRegex).join('|');
  return `\\m(${escaped})\\M`;
}

function buildTextConcat(): string {
  return "COALESCE(title_original, title_ru, '') || ' ' || COALESCE(summary_original, summary_ru, '')";
}

function buildWhereClausePostgres(tagId: string, pattern: string, since?: Date): { sql: string; params: any[] } {
  const params: any[] = [tagId, pattern];
  let sql = `
    WHERE (matched_tags IS NULL OR NOT ($1 = ANY(matched_tags)))
      AND ${buildTextConcat()} ~* $2
  `;
  if (since) {
    sql += ` AND published_at > $3`;
    params.push(since.toISOString());
  }
  return { sql, params };
}

function buildWhereClauseSqlite(tagId: string, keywords: string[], since?: Date): { sql: string; params: any[] } {
  const params: any[] = [tagId];
  const likeConditions = keywords.map((_, i) => `
    (
      COALESCE(title_original, title_ru, '') || ' ' || COALESCE(summary_original, summary_ru, '')
      LIKE $${i + 2}
    )
  `).join(' OR ');
  keywords.forEach(k => params.push(`%${k}%`));
  let sql = `
    WHERE (
      matched_tags IS NULL
      OR matched_tags = '[]'
      OR matched_tags NOT LIKE '%"' || $1 || '"%'
    )
    AND (${likeConditions})
  `;
  if (since) {
    sql += ` AND published_at > $${params.length + 1}`;
    params.push(since.toISOString());
  }
  return { sql, params };
}

async function countMatches(tagId: string, keywords: string[], since?: Date): Promise<CountResult> {
  if (keywords.length === 0) return { matched: 0, tokens: 0 };
  if (keywords.length > MAX_TOKENS) {
    throw new Error(`Too many keywords/tokens (${keywords.length} > ${MAX_TOKENS})`);
  }

  if (USE_SQLITE) {
    const { sql, params } = buildWhereClauseSqlite(tagId, keywords, since);
    const result = await query(`SELECT COUNT(*) as count FROM news ${sql}`, params);
    return { matched: parseInt(result.rows[0]?.count) || 0, tokens: keywords.length };
  }

  const pattern = buildPostgresPattern(keywords);
  if (!pattern) return { matched: 0, tokens: 0 };
  const { sql, params } = buildWhereClausePostgres(tagId, pattern, since);

  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '120s'");
      const result = await client.query(`SELECT COUNT(*) as count FROM news ${sql}`, params);
      await client.query('COMMIT');
      return { matched: parseInt(result.rows[0]?.count) || 0, tokens: keywords.length };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  const result = await query(`SELECT COUNT(*) as count FROM news ${sql}`, params);
  return { matched: parseInt(result.rows[0]?.count) || 0, tokens: keywords.length };
}

async function scanChunkPostgres(
  tagId: string,
  pattern: string,
  lastId: string | null,
  chunkSize: number,
  since?: Date
): Promise<string[]> {
  return withRetry('scanChunkPostgres', async () => {
    const { sql, params } = buildWhereClausePostgres(tagId, pattern, since);
    const idParams = lastId ? [...params, lastId] : params;
    const idCondition = lastId ? `AND id > $${params.length + 1}` : '';

    const result = await query(
      `SELECT id FROM news
       ${sql}
       ${idCondition}
       ORDER BY id
       LIMIT $${idParams.length + 1}`,
      [...idParams, chunkSize]
    );
    return result.rows.map((r: any) => r.id);
  });
}

async function applyChunkPostgres(tagId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await withRetry('applyChunkPostgres', () =>
    query(
      `UPDATE news
       SET matched_tags = COALESCE(matched_tags, '{}'::text[]) || ARRAY[$1]
       WHERE id = ANY($2::uuid[])
         AND (matched_tags IS NULL OR NOT ($1 = ANY(matched_tags)))`,
      [tagId, ids]
    )
  );
  return result.rowCount || 0;
}

async function scanChunkSqlite(
  tagId: string,
  keywords: string[],
  lastId: string | null,
  chunkSize: number,
  since?: Date
): Promise<ScanRecord[]> {
  return withRetry('scanChunkSqlite', async () => {
    const { sql, params } = buildWhereClauseSqlite(tagId, keywords, since);
    const idParams = lastId ? [...params, lastId] : params;
    const idCondition = lastId ? `AND id > $${params.length + 1}` : '';

    const result = await query(
      `SELECT id, matched_tags FROM news
       ${sql}
       ${idCondition}
       ORDER BY id
       LIMIT $${idParams.length + 1}`,
      [...idParams, chunkSize]
    );
    return result.rows;
  });
}

async function applyChunkSqlite(tagId: string, rows: ScanRecord[]): Promise<number> {
  let updated = 0;
  for (const row of rows) {
    let matched: string[] = [];
    try {
      const parsed = parseJsonb(row.matched_tags);
      matched = Array.isArray(parsed) ? parsed : [];
    } catch {
      matched = [];
    }
    if (matched.includes(tagId)) continue;
    matched.push(tagId);
    await withRetry('applyChunkSqlite', () =>
      query(
        `UPDATE news SET matched_tags = $1 WHERE id = $2`,
        [JSON.stringify(matched), row.id]
      )
    );
    updated++;
  }
  return updated;
}

async function updateBackfillMarker(
  tagId: string,
  marker: {
    version: string;
    started_at: string;
    completed_at?: string;
    matched_count: number;
    status: 'running' | 'completed' | 'failed';
    error?: string;
  }
): Promise<void> {
  await withRetry('updateBackfillMarker', async () => {
    const current = await query(
      `SELECT enriched_data FROM user_defined_tags WHERE tag_id = $1`,
      [tagId]
    );
    if (current.rows.length === 0) return;
    let enriched = parseJsonb(current.rows[0].enriched_data) || {};
    enriched._backfill = marker;
    if (USE_SQLITE) {
      await query(
        `UPDATE user_defined_tags SET enriched_data = $1 WHERE tag_id = $2`,
        [JSON.stringify(enriched), tagId]
      );
    } else {
      await query(
        `UPDATE user_defined_tags
         SET enriched_data = enriched_data || $1::jsonb
         WHERE tag_id = $2`,
        [JSON.stringify({ _backfill: marker }), tagId]
      );
    }
  });
}

async function sendAdminBackfillAlert(result: BackfillResult, isSummary = false): Promise<void> {
  try {
    const tagName = isSummary ? 'All tags' : (await fetchTag(result.tagId))?.tag_name || result.tagId;
    const statusIcon = result.error ? '❌' : '✅';
    const text = isSummary
      ? `${statusIcon} <b>Tag backfill all ${result.error ? 'failed' : 'completed'}</b>

🏷 Тегов обработано: ${result.scanned}
📰 Всего сопоставлено статей: ${result.matched}
⏱ Длительность: ${result.durationMs}мс
${result.error ? `⚠️ Ошибка: ${result.error}` : ''}`
      : `${statusIcon} <b>Tag backfill ${result.error ? 'failed' : 'completed'}</b>

🏷 Тег: <code>${result.tagId}</code> (${tagName})
📰 Сопоставлено статей: ${result.matched}
🔍 Обработано (совпадений): ${result.scanned}
⏱ Длительность: ${result.durationMs}мс
${result.error ? `⚠️ Ошибка: ${result.error}` : ''}`;

    const settings = await query(
      `SELECT tg_chat_id FROM admin_tg_settings
       WHERE is_active = TRUE AND tg_chat_id IS NOT NULL AND tg_chat_id <> ''`,
      []
    );
    for (const row of settings.rows) {
      await sendTelegramMessage(row.tg_chat_id, text).catch(() => {});
    }
  } catch (err: any) {
    console.error('[TagBackfill] sendAdminBackfillAlert failed:', err.message);
  }
}

/**
 * Run the retro scan for a single tag.
 * Respects the global concurrency limit of MAX_CONCURRENT_SCANS.
 */
export async function backfillTagMatches(
  tagId: string,
  options: BackfillOptions = {}
): Promise<BackfillResult> {
  const tagIdNorm = tagId.toLowerCase();
  const start = Date.now();
  const startedAtIso = new Date().toISOString();
  const dryRun = options.dryRun ?? false;
  const chunkSize = options.chunkSize || DEFAULT_CHUNK_SIZE;
  const since = options.since;

  if (runningScans.has(tagIdNorm)) {
    console.warn(`[TagBackfill] skipped (already running): ${tagIdNorm}`);
    return { tagId: tagIdNorm, matched: 0, scanned: 0, dryRun, durationMs: 0, skipped: true };
  }
  if (runningScans.size >= MAX_CONCURRENT_SCANS) {
    console.warn(`[TagBackfill] skipped (concurrency): ${tagIdNorm} — ${runningScans.size} running`);
    return {
      tagId: tagIdNorm,
      matched: 0,
      scanned: 0,
      dryRun,
      durationMs: 0,
      skipped: true,
      error: `Too many concurrent scans (limit ${MAX_CONCURRENT_SCANS})`,
    };
  }

  const runPromise = (async (): Promise<BackfillResult> => {
    try {
      const tag = await fetchTag(tagIdNorm);
      if (!tag) {
        return { tagId: tagIdNorm, matched: 0, scanned: 0, dryRun, durationMs: Date.now() - start, error: 'Tag not found' };
      }

      const keywords = await buildScanKeywords(tag);
      if (keywords.length === 0) {
        return { tagId: tagIdNorm, matched: 0, scanned: 0, dryRun, durationMs: Date.now() - start };
      }
      if (keywords.length > MAX_TOKENS) {
        return { tagId: tagIdNorm, matched: 0, scanned: 0, dryRun, durationMs: Date.now() - start, error: `Too many keywords (${keywords.length} > ${MAX_TOKENS})` };
      }

      if (dryRun) {
        const { matched } = await countMatches(tagIdNorm, keywords, since);
        return { tagId: tagIdNorm, matched, scanned: 0, dryRun, durationMs: Date.now() - start };
      }

      await updateBackfillMarker(tagIdNorm, {
        version: '1',
        started_at: startedAtIso,
        matched_count: 0,
        status: 'running',
      });

      let totalMatched = 0;
      let totalScanned = 0;
      let lastId: string | null = null;
      let finished = false;

      if (USE_SQLITE) {
        while (!finished) {
          const rows = await scanChunkSqlite(tagIdNorm, keywords, lastId, chunkSize, since);
          if (rows.length === 0) {
            finished = true;
            break;
          }
          const updated = await applyChunkSqlite(tagIdNorm, rows);
          totalMatched += updated;
          totalScanned += rows.length;
          lastId = rows[rows.length - 1].id;
          if (rows.length < chunkSize) finished = true;
          await sleep(100);
        }
      } else {
        const pattern = buildPostgresPattern(keywords);
        if (!pattern) {
          return { tagId: tagIdNorm, matched: 0, scanned: 0, dryRun, durationMs: Date.now() - start };
        }
        while (!finished) {
          const ids = await scanChunkPostgres(tagIdNorm, pattern, lastId, chunkSize, since);
          if (ids.length === 0) {
            finished = true;
            break;
          }
          const updated = await applyChunkPostgres(tagIdNorm, ids);
          totalMatched += updated;
          totalScanned += ids.length;
          lastId = ids[ids.length - 1];
          if (ids.length < chunkSize) finished = true;
          await sleep(100);
        }
      }

      const durationMs = Date.now() - start;
      console.log(`[TagBackfill] DONE tag=${tagIdNorm} matched=${totalMatched} scanned=${totalScanned} in ${durationMs}ms`);
      await updateBackfillMarker(tagIdNorm, {
        version: '1',
        started_at: startedAtIso,
        completed_at: new Date().toISOString(),
        matched_count: totalMatched,
        status: 'completed',
      });

      const result: BackfillResult = {
        tagId: tagIdNorm,
        matched: totalMatched,
        scanned: totalScanned,
        dryRun,
        durationMs,
      };
      if (!options.silent) sendAdminBackfillAlert(result).catch(() => {});
      return result;
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const result: BackfillResult = {
        tagId: tagIdNorm,
        matched: 0,
        scanned: 0,
        dryRun,
        durationMs,
        error: err.message,
      };
      await updateBackfillMarker(tagIdNorm, {
        version: '1',
        started_at: startedAtIso,
        completed_at: new Date().toISOString(),
        matched_count: 0,
        status: 'failed',
        error: err.message,
      }).catch(() => {});
      if (!options.silent || result.error) sendAdminBackfillAlert(result).catch(() => {});
      return result;
    } finally {
      runningScans.delete(tagIdNorm);
    }
  })();

  runningScans.set(tagIdNorm, runPromise);
  return runPromise;
}

/**
 * Dry-run preview: count how many articles would be matched.
 */
export async function countTagMatches(tagId: string, since?: Date): Promise<CountResult> {
  const tag = await fetchTag(tagId);
  if (!tag) return { matched: 0, tokens: 0 };
  const keywords = await buildScanKeywords(tag);
  if (keywords.length > MAX_TOKENS) {
    return { matched: 0, tokens: keywords.length };
  }
  return countMatches(tag.tag_id, keywords, since);
}

/**
 * Run backfill for all tags sequentially (one-shot migration / admin action).
 */
export async function backfillAllTags(adminUserId?: string): Promise<{ processed: number; skipped: number; totalMatched: number; errors: string[] }> {
  const result = await query(
    `SELECT tag_id FROM user_defined_tags ORDER BY tag_id`,
    []
  );
  const errors: string[] = [];
  let totalMatched = 0;
  let processed = 0;
  let skipped = 0;
  const start = Date.now();

  for (const row of result.rows) {
    try {
      const r = await backfillTagMatches(row.tag_id, { dryRun: false, silent: true });
      if (r.error && !r.skipped) errors.push(`${row.tag_id}: ${r.error}`);
      if (r.skipped) {
        skipped++;
      } else {
        totalMatched += r.matched;
        processed++;
      }
    } catch (err: any) {
      errors.push(`${row.tag_id}: ${err.message}`);
    }
  }

  const durationMs = Date.now() - start;
  const summary: BackfillResult = {
    tagId: '(all)',
    matched: totalMatched,
    scanned: processed,
    dryRun: false,
    durationMs,
    error: errors.length > 0 ? `${errors.length} errors` : undefined,
  };
  await sendAdminBackfillAlert(summary, true).catch(() => {});
  console.log(`[TagBackfill] DONE all processed=${processed} skipped=${skipped} matched=${totalMatched} errors=${errors.length} in ${durationMs}ms`);

  return { processed, skipped, totalMatched, errors };
}

/**
 * Expose the currently running scans (for health checks / admin).
 */
export function getRunningScans(): string[] {
  return [...runningScans.keys()];
}
