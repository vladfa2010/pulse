/**
 * Smoke test for Finam market provider.
 * Usage: FINAM_MARKET_SECRET=tapi_sk_... npx ts-node --transpile-only src/scripts/testFinamMarket.ts
 */
process.env.FINAM_MARKET_SECRET ||= process.env.FINAM_TEST_SECRET;

import * as finam from '../services/market/finamMarketAdapter';
import { getDailyCandles, getIntraday5min } from '../services/market/marketRouter';

async function main() {
  const daily = await finam.getDailyCandles('SBER', 'MOEX', 10);
  console.log('SBER daily:', daily.length, 'last:', daily[daily.length - 1]);
  if (daily.length === 0) throw new Error('no daily candles');

  const date = daily[daily.length - 1].time.slice(0, 10);
  const m5 = await finam.getIntraday5min('SBER', 'MOEX', date);
  console.log(`SBER M5 for ${date}:`, m5.length);

  const us = await finam.getDailyCandles('MDLN', 'NASDAQ', 10);
  console.log('MDLN@XNGS daily:', us.length);

  const imoex = await finam.getDailyCandles('IMOEX', 'MOEX', 5);
  console.log('IMOEX daily:', imoex.length);

  const resolved = await finam.resolveTicker('MDLN');
  console.log('resolve MDLN:', resolved);

  // NB: different arg order by design — adapter: (ticker, exchange, ...), router: (exchange, ticker, ...)
  const viaRouter = await getDailyCandles('MOEX', 'SBER', 5);
  console.log('router provider:', viaRouter.provider, 'candles:', viaRouter.candles.length);

  const px = await finam.getCurrentPrice('SBER', 'MOEX');
  console.log('SBER price:', px);
  if (!px || px <= 0) throw new Error('no current price');

  // cache check: second call must be instant (TTL)
  const t0 = Date.now();
  await finam.getDailyCandles('SBER', 'MOEX', 10);
  console.log('cached daily call ms:', Date.now() - t0);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
