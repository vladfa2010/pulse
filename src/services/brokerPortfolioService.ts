/**
 * PULSE — Broker portfolio service
 */

import { query } from '../config/db';
import nodeCrypto from 'crypto';
import * as crypto from './crypto';
import { getBrokerAdapter, Broker } from './brokerApi';
import { getCurrentPricesBatch } from './market/marketRouter';
import { createUserTag, getUserTags } from './tagManager';
import { getPlanById } from './subscription';
import { BrokerKeyRow } from './brokerKeyService';

const USE_SQLITE = process.env.USE_SQLITE === 'true';

function nowSql(): string {
  return USE_SQLITE ? "datetime('now')" : 'NOW()';
}

function validateBroker(broker: string): asserts broker is Broker {
  if (!['inside', 'finam', 'bcs'].includes(broker)) {
    throw new Error('Unsupported broker');
  }
}

export interface BrokerPositionRow {
  id: string;
  broker_portfolio_id: string;
  ticker: string;
  exchange: string;
  company_name: string | null;
  quantity: number;
  avg_price: number | null;
  currency: string;
  external_id: string | null;
  source: 'api' | 'manual' | 'import';
  created_at: string;
  updated_at: string;
}

export interface BrokerPortfolioRow {
  id: string;
  user_id: string;
  broker: Broker;
  name: string;
  source: 'api' | 'manual' | 'import';
  broker_key_id: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  // Extra fields from listBrokerPortfolios JOIN
  broker_key_tail?: string | null;
  broker_key_status?: string | null;
  positions_count?: number;
}

export async function listBrokerPortfolios(userId: string): Promise<BrokerPortfolioRow[]> {
  const result = await query(
    `SELECT bp.*,
            COALESCE(pos.count, 0) as positions_count,
            bk.token_tail as broker_key_tail,
            bk.status as broker_key_status
     FROM broker_portfolios bp
     LEFT JOIN (
       SELECT broker_portfolio_id, COUNT(*) as count
       FROM broker_positions
       GROUP BY broker_portfolio_id
     ) pos ON pos.broker_portfolio_id = bp.id
     LEFT JOIN broker_keys bk ON bk.id = bp.broker_key_id
     WHERE bp.user_id = $1
     ORDER BY bp.created_at DESC`,
    [userId]
  );
  return result.rows.map((r: any) => ({
    ...r,
    positions_count: Number(r.positions_count || 0),
  }));
}

export async function getPortfolioById(userId: string, portfolioId: string): Promise<BrokerPortfolioRow | null> {
  const result = await query(
    `SELECT bp.*, bk.token_tail as broker_key_tail, bk.status as broker_key_status
     FROM broker_portfolios bp
     LEFT JOIN broker_keys bk ON bk.id = bp.broker_key_id
     WHERE bp.id = $1 AND bp.user_id = $2
     LIMIT 1`,
    [portfolioId, userId]
  );
  return result.rows[0] || null;
}

export async function getPortfolioPositions(portfolioId: string): Promise<BrokerPositionRow[]> {
  const result = await query(
    `SELECT * FROM broker_positions WHERE broker_portfolio_id = $1 ORDER BY ticker ASC`,
    [portfolioId]
  );
  return result.rows.map((r: any) => ({
    ...r,
    quantity: Number(r.quantity),
    avg_price: r.avg_price === null || r.avg_price === undefined ? null : Number(r.avg_price),
  }));
}

export async function createBrokerPortfolio(
  userId: string,
  input: { broker: string; name?: string; brokerKeyId: string }
): Promise<BrokerPortfolioRow> {
  validateBroker(input.broker);
  if (!input.brokerKeyId) throw new Error('brokerKeyId is required');

  const keyResult = await query(
    `SELECT * FROM broker_keys WHERE id = $1 AND user_id = $2 AND broker = $3 LIMIT 1`,
    [input.brokerKeyId, userId, input.broker]
  );
  if (keyResult.rows.length === 0) {
    throw Object.assign(new Error('Broker key not found'), { code: 'not_found' });
  }

  const defaultName = input.broker === 'finam' ? 'Портфель Финам' :
                      input.broker === 'bcs' ? 'Портфель БКС' :
                      input.broker === 'inside' ? 'Портфель Инсайд брокер' : 'Портфель';
  const name = (input.name || defaultName).trim();
  const id = nodeCrypto.randomUUID();
  const now = nowSql();

  await query(
    `INSERT INTO broker_portfolios (id, user_id, broker, name, source, broker_key_id, last_synced_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'api', $5, ${now}, ${now}, ${now})`,
    [id, userId, input.broker, name, input.brokerKeyId]
  );

  try {
    await syncBrokerPortfolio(userId, id);
  } catch (err: any) {
    // Roll back portfolio creation on broker error so the portfolio is not created
    await query(`DELETE FROM broker_portfolios WHERE id = $1 AND user_id = $2`, [id, userId]);
    throw err;
  }

  const portfolio = await getPortfolioById(userId, id);
  if (!portfolio) throw new Error('Failed to create portfolio');
  return portfolio;
}

export async function updateBrokerPortfolio(
  userId: string,
  portfolioId: string,
  input: { name?: string; brokerKeyId?: string | null }
): Promise<BrokerPortfolioRow> {
  const portfolio = await getPortfolioById(userId, portfolioId);
  if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { code: 'not_found' });

  if (input.brokerKeyId !== undefined && input.brokerKeyId !== null) {
    const keyResult = await query(
      `SELECT * FROM broker_keys WHERE id = $1 AND user_id = $2 AND broker = $3 LIMIT 1`,
      [input.brokerKeyId, userId, portfolio.broker]
    );
    if (keyResult.rows.length === 0) {
      throw Object.assign(new Error('Broker key not found'), { code: 'not_found' });
    }
  }

  await query(
    `UPDATE broker_portfolios
     SET name = COALESCE($1, name),
         broker_key_id = CASE WHEN $2 IS NULL THEN broker_key_id WHEN $2 = '' THEN NULL ELSE $2 END,
         source = CASE WHEN $2 IS NULL THEN source WHEN $2 = '' THEN 'manual' ELSE 'api' END,
         updated_at = ${nowSql()}
     WHERE id = $3 AND user_id = $4`,
    [input.name ?? null, input.brokerKeyId ?? null, portfolioId, userId]
  );

  const updated = await getPortfolioById(userId, portfolioId);
  if (!updated) throw new Error('Failed to update portfolio');
  return updated;
}

export async function deleteBrokerPortfolio(userId: string, portfolioId: string): Promise<void> {
  const portfolio = await getPortfolioById(userId, portfolioId);
  if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { code: 'not_found' });

  await query(
    `DELETE FROM broker_portfolios WHERE id = $1 AND user_id = $2`,
    [portfolioId, userId]
  );
}

export async function getBrokerPortfolioPositions(userId: string, portfolioId: string): Promise<BrokerPositionRow[]> {
  const portfolio = await getPortfolioById(userId, portfolioId);
  if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { code: 'not_found' });
  return getPortfolioPositions(portfolioId);
}

export async function syncBrokerPortfolio(userId: string, portfolioId: string): Promise<{ added: number; closed: number; updated: number }> {
  const portfolio = await getPortfolioById(userId, portfolioId);
  if (!portfolio) throw Object.assign(new Error('Portfolio not found'), { code: 'not_found' });
  if (!portfolio.broker_key_id) throw new Error('Portfolio has no linked broker key');

  const keyResult = await query(
    `SELECT * FROM broker_keys WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [portfolio.broker_key_id, userId]
  );
  if (keyResult.rows.length === 0) throw Object.assign(new Error('Broker key not found'), { code: 'not_found' });
  const key = keyResult.rows[0];

  let token: string;
  try {
    token = crypto.decrypt(key.token_encrypted);
  } catch (err: any) {
    throw new Error('broker_key_invalid');
  }

  const adapter = getBrokerAdapter(portfolio.broker);
  let positions: import('./brokerApi').BrokerPosition[];
  let newToken: string | undefined;
  try {
    const res = await adapter.getPositions(token);
    positions = res.positions;
    newToken = res.newToken;
  } catch (err: any) {
    console.error(`[BrokerPortfolio] sync failed portfolio=${portfolioId} broker=${portfolio.broker} code=${err.code || 'unknown'}: ${err.message}`);
    throw new Error(err.message || 'broker_unavailable');
  }

  if (newToken && newToken !== token) {
    await query(
      `UPDATE broker_keys
       SET token_encrypted = $1, token_tail = $2, updated_at = ${nowSql()}
       WHERE id = $3`,
      [crypto.encrypt(newToken), crypto.getTail(newToken, 4), key.id]
    );
  }

  const diff = await applyPositionDiff(userId, portfolioId, positions, 'api');

  console.log(
    `[BrokerPortfolio] sync ok portfolio=${portfolioId} broker=${portfolio.broker} ` +
    `positions=${positions.length} added=${diff.added} updated=${diff.updated} closed=${diff.closed}`
  );
  if (positions.length === 0) {
    console.warn(`[BrokerPortfolio] sync returned 0 positions portfolio=${portfolioId} broker=${portfolio.broker} — проверить адаптер/счёт`);
  }

  await query(
    `UPDATE broker_portfolios SET last_synced_at = ${nowSql()}, updated_at = ${nowSql()} WHERE id = $1`,
    [portfolioId]
  );
  await query(
    `UPDATE broker_keys SET last_synced_at = ${nowSql()}, updated_at = ${nowSql()} WHERE id = $1`,
    [key.id]
  );

  return diff;
}

export async function applyPositionDiff(
  userId: string,
  portfolioId: string,
  positions: import('./brokerApi').BrokerPosition[],
  source: 'api' | 'manual' | 'import' = 'api'
): Promise<{ added: number; closed: number; updated: number }> {
  const existing = await getPortfolioPositions(portfolioId);

  const existingByExt = new Map<string, BrokerPositionRow>();
  const existingByTicker = new Map<string, BrokerPositionRow>();
  for (const pos of existing) {
    if (pos.external_id) existingByExt.set(`${pos.external_id}`, pos);
    existingByTicker.set(`${pos.ticker}|${pos.exchange}`, pos);
  }

  const seen = new Set<string>();
  let added = 0;
  let updated = 0;
  const now = nowSql();

  for (const pos of positions) {
    const ticker = pos.ticker.toUpperCase();
    const exchange = pos.exchange.toUpperCase();
    const key = `${ticker}|${exchange}`;
    seen.add(key);

    const match = pos.externalId && existingByExt.get(pos.externalId)
      ? existingByExt.get(pos.externalId)!
      : existingByTicker.get(key);

    const quantity = Number(pos.quantity);
    const avgPrice = pos.avgPrice === null || pos.avgPrice === undefined || pos.avgPrice === 0 ? null : Number(pos.avgPrice);
    const companyName = pos.companyName || null;
    const externalId = pos.externalId || null;
    const currency = pos.currency.toUpperCase();

    if (match) {
      await query(
        `UPDATE broker_positions
         SET quantity = $1,
             avg_price = $2,
             company_name = COALESCE($3, company_name),
             currency = $4,
             external_id = COALESCE($5, external_id),
             updated_at = ${nowSql()}
         WHERE id = $6`,
        [quantity, avgPrice, companyName, currency, externalId, match.id]
      );
      updated++;
    } else {
      const id = nodeCrypto.randomUUID();
      await query(
        `INSERT INTO broker_positions
           (id, broker_portfolio_id, ticker, exchange, company_name, quantity, avg_price, currency, external_id, source, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${now}, ${now})`,
        [id, portfolioId, ticker, exchange, companyName, quantity, avgPrice, currency, externalId, source]
      );
      added++;

      await logUserEvent(userId, 'position_added', {
        portfolio_id: portfolioId,
        ticker,
        exchange,
        company_name: companyName,
        quantity,
      });
    }
  }

  let closed = 0;
  for (const pos of existing) {
    const key = `${pos.ticker}|${pos.exchange}`;
    if (!seen.has(key)) {
      await query(`DELETE FROM broker_positions WHERE id = $1`, [pos.id]);
      closed++;
      await logUserEvent(userId, 'position_closed', {
        portfolio_id: portfolioId,
        ticker: pos.ticker,
        exchange: pos.exchange,
        company_name: pos.company_name,
      });
    }
  }

  return { added, closed, updated };
}

async function logUserEvent(userId: string, type: string, data: Record<string, any>): Promise<void> {
  try {
    const dataJson = USE_SQLITE ? JSON.stringify(data) : data;
    await query(
      `INSERT INTO user_events (id, user_id, event_type, event_data, created_at)
       VALUES ($1, $2, $3, $4, ${nowSql()})`,
      [nodeCrypto.randomUUID(), userId, type, dataJson]
    );
  } catch (err: any) {
    console.error(`[BrokerPortfolio] Failed to log user_event ${type}:`, err.message);
  }
}

export interface PositionWithPrice extends BrokerPositionRow {
  currentPrice: number | null;
  cost: number | null;
  marketValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  weightPct: number | null;
  costPartial: boolean;
  broker: Broker; // injected during summary computation
}

export interface PortfolioSummary {
  mode: 'by-broker' | 'consolidated';
  portfolios: PortfolioBlock[];
  grandTotal: PortfolioTotals;
}

export interface PortfolioBlock {
  id: string;
  broker: Broker;
  name: string;
  source: 'api' | 'manual' | 'import';
  brokerKeyTail: string | null;
  brokerKeyStatus: string | null;
  lastSyncedAt: string | null;
  totals: PortfolioTotals;
  positions: PositionWithPrice[];
}

export interface PortfolioTotals {
  cost: number | null;
  marketValue: number | null;
  pnl: number | null;
  pnlPct: number | null;
  currency: string;
  costPartial: boolean;
}

export interface ConsolidatedSource {
  broker: Broker;
  quantity: number;
}

export interface ConsolidatedPosition extends PositionWithPrice {
  sources: ConsolidatedSource[];
}

export async function getPortfolioSummary(userId: string, mode: 'by-broker' | 'consolidated' = 'by-broker'): Promise<PortfolioSummary> {
  const portfolios = await listBrokerPortfolios(userId);
  const allPositions: Array<BrokerPositionRow & { broker: Broker }> = [];

  for (const portfolio of portfolios) {
    const positions = await getPortfolioPositions(portfolio.id);
    for (const pos of positions) {
      allPositions.push({ ...pos, broker: portfolio.broker });
    }
  }

  const priceItems = allPositions.map(p => ({ ticker: p.ticker, exchange: p.exchange }));
  const priceMap = priceItems.length > 0 ? await getCurrentPricesBatch(priceItems) : new Map();

  const pricedPositions = allPositions.map(p => {
    const priceKey = `${p.ticker}@${p.exchange}`;
    const currentPrice = priceMap.get(priceKey) ?? null;
    const cost = p.avg_price !== null ? p.quantity * p.avg_price : null;
    const marketValue = currentPrice !== null ? p.quantity * currentPrice : null;
    const pnl = cost !== null && marketValue !== null ? marketValue - cost : null;
    const pnlPct = cost !== null && cost !== 0 && pnl !== null ? (pnl / cost) * 100 : null;
    return {
      ...p,
      currentPrice,
      cost,
      marketValue,
      pnl,
      pnlPct,
      weightPct: 0, // filled later
      costPartial: cost === null,
    };
  });

  const grandTotalMarketValue = pricedPositions.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
  const grandTotalCost = pricedPositions.reduce((sum, p) => sum + (p.cost ?? 0), 0);
  const grandTotalPnl = pricedPositions.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
  const grandTotalCostPartial = pricedPositions.some(p => p.costPartial);

  for (const p of pricedPositions) {
    if (grandTotalMarketValue > 0 && p.marketValue !== null) {
      p.weightPct = (p.marketValue / grandTotalMarketValue) * 100;
    } else if (grandTotalCost > 0 && p.cost !== null) {
      p.weightPct = (p.cost / grandTotalCost) * 100;
    } else {
      p.weightPct = 0;
    }
  }

  if (mode === 'consolidated') {
    const grouped = new Map<string, ConsolidatedPosition>();
    for (const p of pricedPositions) {
      const key = `${p.ticker}|${p.exchange}`;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          ...p,
          id: key,
          broker_portfolio_id: '',
          broker: 'inside' as Broker, // marker, not used
          sources: [{ broker: p.broker, quantity: p.quantity }],
        });
      } else {
        existing.quantity += p.quantity;
        existing.cost = (existing.cost ?? 0) + (p.cost ?? 0);
        existing.marketValue = (existing.marketValue ?? 0) + (p.marketValue ?? 0);
        existing.pnl = (existing.pnl ?? 0) + (p.pnl ?? 0);
        existing.costPartial = existing.costPartial || p.costPartial;
        existing.sources.push({ broker: p.broker, quantity: p.quantity });
        // Average: weighted average by quantity when both prices known
        if (existing.avg_price !== null && p.avg_price !== null) {
          const totalQty = existing.quantity;
          const oldQty = existing.quantity - p.quantity;
          if (oldQty > 0) {
            existing.avg_price = ((existing.avg_price * oldQty) + (p.avg_price * p.quantity)) / totalQty;
          }
        } else if (p.avg_price !== null) {
          existing.avg_price = p.avg_price;
        }
      }
    }

    const consolidated = Array.from(grouped.values());
    for (const p of consolidated) {
      p.pnlPct = p.cost !== null && p.cost !== 0 && p.pnl !== null ? (p.pnl / p.cost) * 100 : null;
      if (grandTotalMarketValue > 0 && p.marketValue !== null) {
        p.weightPct = (p.marketValue / grandTotalMarketValue) * 100;
      } else if (grandTotalCost > 0 && p.cost !== null) {
        p.weightPct = (p.cost / grandTotalCost) * 100;
      } else {
        p.weightPct = 0;
      }
    }

    const block: PortfolioBlock = {
      id: 'consolidated',
      broker: 'inside' as Broker,
      name: 'Сводный портфель',
      source: 'api',
      brokerKeyTail: null,
      brokerKeyStatus: null,
      lastSyncedAt: null,
      totals: {
        cost: grandTotalCost || null,
        marketValue: grandTotalMarketValue || null,
        pnl: grandTotalPnl || null,
        pnlPct: grandTotalCost > 0 ? (grandTotalPnl / grandTotalCost) * 100 : null,
        currency: 'RUB',
        costPartial: grandTotalCostPartial,
      },
      positions: consolidated,
    };

    return {
      mode,
      portfolios: [block],
      grandTotal: block.totals,
    };
  }

  // by-broker mode
  const blocks: PortfolioBlock[] = [];
  for (const portfolio of portfolios) {
    const pos = pricedPositions.filter(p => p.broker_portfolio_id === portfolio.id);
    const totalMarketValue = pos.reduce((sum, p) => sum + (p.marketValue ?? 0), 0);
    const totalCost = pos.reduce((sum, p) => sum + (p.cost ?? 0), 0);
    const totalPnl = pos.reduce((sum, p) => sum + (p.pnl ?? 0), 0);
    const costPartial = pos.some(p => p.costPartial);

    for (const p of pos) {
      if (totalMarketValue > 0 && p.marketValue !== null) {
        p.weightPct = (p.marketValue / totalMarketValue) * 100;
      } else if (totalCost > 0 && p.cost !== null) {
        p.weightPct = (p.cost / totalCost) * 100;
      } else {
        p.weightPct = 0;
      }
    }

    blocks.push({
      id: portfolio.id,
      broker: portfolio.broker,
      name: portfolio.name,
      source: portfolio.source,
      brokerKeyTail: portfolio.broker_key_tail || null,
      brokerKeyStatus: portfolio.broker_key_status || null,
      lastSyncedAt: portfolio.last_synced_at,
      totals: {
        cost: totalCost || null,
        marketValue: totalMarketValue || null,
        pnl: totalPnl || null,
        pnlPct: totalCost > 0 ? (totalPnl / totalCost) * 100 : null,
        currency: 'RUB',
        costPartial,
      },
      positions: pos,
    });
  }

  return {
    mode,
    portfolios: blocks,
    grandTotal: {
      cost: grandTotalCost || null,
      marketValue: grandTotalMarketValue || null,
      pnl: grandTotalPnl || null,
      pnlPct: grandTotalCost > 0 ? (grandTotalPnl / grandTotalCost) * 100 : null,
      currency: 'RUB',
      costPartial: grandTotalCostPartial,
    },
  };
}

export interface RecommendedTag {
  ticker: string;
  companyName: string | null;
  suggestedTag: string;
  status: 'available' | 'subscribed' | 'created-new' | 'limit-reached';
  existingTagId: string | null;
  weightPct: number;
}

export async function getRecommendedTags(userId: string): Promise<{ tags: RecommendedTag[]; tagLimit: { used: number; limit: number } }> {
  const summary = await getPortfolioSummary(userId, 'consolidated');
  const positions = summary.portfolios[0]?.positions || [];

  const allUserTags = await getUserTags(userId);
  const subscribedTagIds = new Set(allUserTags.map(t => t.tag_id));

  const existingByTicker = await query(
    `SELECT tag_id, tag_name, enriched_data
     FROM user_defined_tags
     WHERE enriched_data->>'ticker' IS NOT NULL`,
    []
  );
  const existingMap = new Map<string, string>();
  for (const row of existingByTicker.rows) {
    const ed = parseJson(row.enriched_data);
    if (ed?.ticker) {
      existingMap.set(`${ed.ticker.toUpperCase()}|${(ed.exchange || 'MOEX').toUpperCase()}`, row.tag_id);
    }
  }

  // Tag limit
  const userResult = await query(`SELECT subscription_plan FROM users WHERE id = $1`, [userId]);
  const planId = userResult.rows[0]?.subscription_plan || 'free';
  const plan = await getPlanById(planId);
  const limit = plan?.tag_limit ?? 0;
  const activeTagsResult = await query(
    `SELECT COUNT(*) as cnt FROM portfolios WHERE user_id = $1 AND is_frozen = FALSE`,
    [userId]
  );
  const usedCount = Number(activeTagsResult.rows[0]?.cnt || 0);

  const tags: RecommendedTag[] = [];
  for (const pos of positions) {
    const key = `${pos.ticker}|${pos.exchange}`;
    const existingTagId = existingMap.get(key) || null;
    const isSubscribed = existingTagId ? subscribedTagIds.has(existingTagId) : false;

    let status: RecommendedTag['status'];
    if (isSubscribed) {
      status = 'subscribed';
    } else if (limit >= 0 && usedCount + tags.filter(t => t.status === 'available' || t.status === 'created-new').length >= limit) {
      status = 'limit-reached';
    } else {
      status = 'available';
    }

    tags.push({
      ticker: pos.ticker,
      companyName: pos.company_name,
      suggestedTag: `#${pos.ticker}`,
      status,
      existingTagId,
      weightPct: pos.weightPct || 0,
    });
  }

  return { tags, tagLimit: { used: usedCount, limit } };
}

export async function subscribeFromRecommendedTag(
  userId: string,
  ticker: string,
  exchange: string
): Promise<{ success: boolean; tagId?: string; status?: RecommendedTag['status']; error?: string }> {
  const tagId = nodeCrypto.randomUUID();
  const tagName = ticker.toUpperCase();
  const enrichedData = { ticker: tagName, exchange: exchange.toUpperCase() };

  // Ensure the tag exists in user_defined_tags with enriched data so market router works
  const existing = await query(
    `SELECT tag_id FROM user_defined_tags
     WHERE enriched_data->>'ticker' = $1 AND enriched_data->>'exchange' = $2
     LIMIT 1`,
    [tagName, exchange.toUpperCase()]
  );

  let finalTagId: string;
  if (existing.rows.length > 0) {
    finalTagId = existing.rows[0].tag_id;
    await query(
      `UPDATE user_defined_tags
       SET enriched_data = $1, updated_at = ${nowSql()}
       WHERE tag_id = $2`,
      [enrichedData, finalTagId]
    );
  } else {
    finalTagId = tagId;
    await query(
      `INSERT INTO user_defined_tags (tag_id, tag_name, tag_type, keywords, enriched_data, created_by, created_at, updated_at)
       VALUES ($1, $2, 'ticker', $3, $4, $5, ${nowSql()}, ${nowSql()})`,
      [finalTagId, tagName, [tagName.toLowerCase()], enrichedData, userId]
    );
  }

  const result = await createUserTag(userId, finalTagId, tagName, 'ticker');
  if (!result.success) {
    return { success: false, error: result.error || 'Failed to subscribe', status: result.limitReached ? 'limit-reached' : undefined };
  }

  return { success: true, tagId: result.finalTagId || finalTagId, status: 'created-new' };
}

function parseJson(value: any): any {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

export async function updatePortfolioAfterKeyDelete(keyId: string): Promise<void> {
  await query(
    `UPDATE broker_portfolios
     SET source = 'manual', broker_key_id = NULL, updated_at = ${nowSql()}
     WHERE broker_key_id = $1`,
    [keyId]
  );
}

export async function updateKeyTokenAfterSync(keyId: string, newToken?: string): Promise<void> {
  if (!newToken) return;
  await query(
    `UPDATE broker_keys
     SET token_encrypted = $1, token_tail = $2, updated_at = ${nowSql()}
     WHERE id = $3`,
    [crypto.encrypt(newToken), crypto.getTail(newToken, 4), keyId]
  );
}

export async function getAllActiveBrokerKeys(): Promise<Array<BrokerKeyRow & { portfolio_id: string }>> {
  const result = await query(
    `SELECT bk.*, bp.id as portfolio_id
     FROM broker_portfolios bp
     JOIN broker_keys bk ON bk.id = bp.broker_key_id
     WHERE bk.status = 'ok' AND bp.broker_key_id IS NOT NULL
     ORDER BY bk.id`,
    []
  );
  return result.rows;
}

export async function getPortfolioKeyPair(userId: string, portfolioId: string): Promise<{ portfolio: BrokerPortfolioRow; key: any } | null> {
  const portfolio = await getPortfolioById(userId, portfolioId);
  if (!portfolio || !portfolio.broker_key_id) return null;
  const keyResult = await query(
    `SELECT * FROM broker_keys WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [portfolio.broker_key_id, userId]
  );
  if (keyResult.rows.length === 0) return null;
  return { portfolio, key: keyResult.rows[0] };
}
