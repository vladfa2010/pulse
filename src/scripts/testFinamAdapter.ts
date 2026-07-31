/**
 * Integration smoke test for Finam adapter.
 *
 * Usage:
 *   FINAM_TEST_SECRET=tapi_sk_... npx ts-node --transpile-only src/scripts/testFinamAdapter.ts
 */

import finamAdapter from '../services/brokerApi/finamAdapter';

async function main() {
  const secret = process.env.FINAM_TEST_SECRET;
  if (!secret) {
    console.error('Set FINAM_TEST_SECRET env variable');
    process.exit(1);
  }

  console.log('[TestFinam] testKey...');
  const test = await finamAdapter.testKey(secret);
  console.log('[TestFinam] testKey result:', test);

  if (!test.ok) {
    console.error('[TestFinam] FAILED: key not accepted');
    process.exit(1);
  }

  console.log('[TestFinam] getPositions...');
  const { positions } = await finamAdapter.getPositions(secret);
  console.log(`[TestFinam] positions: ${positions.length}`);
  for (const p of positions) {
    console.log(`  ${p.ticker}@${p.exchange} qty=${p.quantity} avg=${p.avgPrice} currency=${p.currency} ext=${p.externalId}`);
  }

  // Expected from TZ: at least these tickers
  const expected = ['SBER', 'BELU', 'SMLT', 'FLOT', 'MOEX', 'T', 'VTBR', 'TATN', 'X5', 'SIBN', 'VKCO', 'MDLN', 'SECZ', 'RU000A1053P7', 'SU26244RMFS2'];
  const found = expected.filter(t => positions.some(p => p.ticker === t));
  console.log(`[TestFinam] expected tickers found: ${found.length}/${expected.length}`);
  if (found.length < expected.length) {
    console.warn('[TestFinam] missing:', expected.filter(t => !found.includes(t)));
  }

  // BELU avg_price is "0.0" -> must be NULL
  const belu = positions.find(p => p.ticker === 'BELU');
  if (belu && belu.avgPrice !== null) {
    console.error('[TestFinam] FAILED: BELU avgPrice should be null, got', belu.avgPrice);
    process.exit(1);
  }

  // SBER must have a real company name (via /v1/assets cache)
  const sber = positions.find(p => p.ticker === 'SBER');
  if (sber && sber.companyName === 'SBER') {
    console.error('[TestFinam] FAILED: SBER companyName should be enriched, got', sber.companyName);
    process.exit(1);
  }

  // MDLN is NASDAQ, SECZ is NYSE
  const mdln = positions.find(p => p.ticker === 'MDLN');
  if (!mdln || mdln.exchange !== 'NASDAQ' || mdln.currency !== 'USD') {
    console.error('[TestFinam] FAILED: MDLN should be NASDAQ/USD, got', mdln);
    process.exit(1);
  }
  const secz = positions.find(p => p.ticker === 'SECZ');
  if (!secz || secz.exchange !== 'NYSE' || secz.currency !== 'USD') {
    console.error('[TestFinam] FAILED: SECZ should be NYSE/USD, got', secz);
    process.exit(1);
  }

  console.log('[TestFinam] PASSED');
}

main().catch(err => {
  console.error('[TestFinam] ERROR:', err.message);
  process.exit(1);
});
