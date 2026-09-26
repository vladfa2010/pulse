#!/usr/bin/env node
/**
 * Verify: radioMp3Cache (ТЗ-63 + аудит 2026-09-26) — чистые функции без сети.
 * Запуск: npm run build && node scripts/verify-radio-mp3-cache.js
 *
 * 7 кейсов:
 *  1. cache miss → upstream вызван
 *  2. cache hit → upstream НЕ вызван
 *  3. parallel дедупликация (single-flight)
 *  4. разные ключи → разные upstream
 *  5. cacheGetPublic работает для handler'а
 *  6. LRU/FIFO eviction по MAX_ENTRIES и MAX_TOTAL_BYTES
 *  7. upstream error НЕ пишет в кэш (try/catch — expect() из vitest недоступен,
 *     аудит блокер 1)
 */
const assert = require('assert');
const {
  getOrFetchMp3,
  cacheGetPublic,
  getRadioMp3CacheStats,
  clearRadioMp3Cache,
} = require('../dist/services/radioMp3Cache');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

async function main() {
  console.log('[verify] radioMp3Cache (ТЗ-63)');

  // 1. cache miss → upstream вызван
  await (async () => {
    clearRadioMp3Cache();
    let upstreamCalls = 0;
    const fetcher = async () => { upstreamCalls++; return Buffer.from('mock-mp3-data'); };
    const r1 = await getOrFetchMp3('hello', 'presenter_male', 1.0, 0, fetcher);
    ok('miss → hit:false', () => assert.strictEqual(r1.hit, false));
    ok('miss → upstream вызван 1 раз', () => assert.strictEqual(upstreamCalls, 1));

    // 2. cache hit → upstream НЕ вызван
    const r2 = await getOrFetchMp3('hello', 'presenter_male', 1.0, 0, fetcher);
    ok('hit → hit:true', () => assert.strictEqual(r2.hit, true));
    ok('hit → upstream НЕ вызван повторно', () => assert.strictEqual(upstreamCalls, 1));
  })();

  // 3. parallel дедупликация — single-flight
  await (async () => {
    clearRadioMp3Cache();
    let upstreamCalls = 0;
    let resolveFetcher = null;
    const slowFetcher = () => new Promise((resolve) => {
      upstreamCalls++;
      resolveFetcher = resolve;
    });
    const promises = [
      getOrFetchMp3('parallel', 'presenter_male', 1.0, 0, slowFetcher),
      getOrFetchMp3('parallel', 'presenter_male', 1.0, 0, slowFetcher),
      getOrFetchMp3('parallel', 'presenter_male', 1.0, 0, slowFetcher),
    ];
    setTimeout(() => resolveFetcher(Buffer.from('once')), 10);
    const results = await Promise.all(promises);
    ok('3 параллельных → 1 upstream', () => assert.strictEqual(upstreamCalls, 1));
    ok('все получили одинаковый буфер',
      () => assert.ok(results.every(r => r.buffer.equals(Buffer.from('once')))));
  })();

  // 4. разные ключи → разные upstream
  await (async () => {
    clearRadioMp3Cache();
    let upstreamCalls = 0;
    const fetcher = async () => { upstreamCalls++; return Buffer.from('x'); };
    await getOrFetchMp3('a', 'presenter_male', 1.0, 0, fetcher);
    await getOrFetchMp3('a', 'presenter_female', 1.0, 0, fetcher);
    await getOrFetchMp3('a', 'presenter_male', 1.5, 0, fetcher);
    await getOrFetchMp3('a', 'presenter_male', 1.0, 2, fetcher);
    ok('4 разных ключа (voice/speed/pitch) = 4 upstream', () => assert.strictEqual(upstreamCalls, 4));
  })();

  // 5. cacheGetPublic работает для handler'а
  await (async () => {
    clearRadioMp3Cache();
    const fetcher = async () => Buffer.from('cached-by-getOrFetch');
    await getOrFetchMp3('check', 'presenter_male', 1.0, 0, fetcher);
    const direct = cacheGetPublic('check', 'presenter_male', 1.0, 0);
    ok('cacheGetPublic отдаёт буфер из кэша',
      () => assert.ok(direct !== null && direct.equals(Buffer.from('cached-by-getOrFetch'))));
    ok('cacheGetPublic → null для отсутствующего ключа',
      () => assert.strictEqual(cacheGetPublic('nope', 'presenter_male', 1.0, 0), null));
  })();

  // 6. LRU/FIFO eviction: 100 × 1 МБ > 80 МБ лимита
  await (async () => {
    clearRadioMp3Cache();
    const big = Buffer.alloc(1024 * 1024); // 1 МБ
    for (let i = 0; i < 100; i++) {
      await getOrFetchMp3(`big-${i}`, 'v', 1, 0, async () => big);
    }
    const stats = getRadioMp3CacheStats();
    ok(`entries (${stats.entries}) <= 256`, () => assert.ok(stats.entries <= 256));
    ok(`bytes (${stats.bytes}) <= 80 МБ`, () => assert.ok(stats.bytes <= 80 * 1024 * 1024));
    ok('bytes соответствует entries × 1 МБ',
      () => assert.strictEqual(stats.bytes, stats.entries * 1024 * 1024));
  })();

  // 7. upstream error НЕ пишет в кэш (аудит блокер 1: try/catch вместо expect)
  await (async () => {
    clearRadioMp3Cache();
    let upstreamCalls = 0;
    let throwOnce = true;
    const errorFetcher = async () => {
      upstreamCalls++;
      if (throwOnce) { throwOnce = false; throw new Error('502'); }
      return Buffer.from('retry');
    };
    let threw = false;
    try {
      await getOrFetchMp3('err', 'v', 1, 0, errorFetcher);
    } catch (e) {
      threw = true;
      ok(`error message = '502' (got '${e.message}')`, () => assert.strictEqual(e.message, '502'));
    }
    ok('upstream error пробросился из fetcher', () => assert.ok(threw));
    ok('кэш пуст после ошибки', () => assert.strictEqual(cacheGetPublic('err', 'v', 1, 0), null));
    const r7 = await getOrFetchMp3('err', 'v', 1, 0, errorFetcher);
    ok('повторный вызов — miss, upstream снова вызван', () => assert.strictEqual(r7.hit, false));
    ok('upstream вызван 2 раза (1 error + 1 success)', () => assert.strictEqual(upstreamCalls, 2));
  })();

  console.log(`\n${passed} checks passed${process.exitCode ? ' (FAILURES)' : ''}`);
  process.exit(process.exitCode || 0);
}

main().catch(e => { console.error(e); process.exit(1); });
