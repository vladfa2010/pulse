#!/usr/bin/env node
/**
 * Verify: radioMp3Cache dashboard (ТЗ-65) — history ring buffer + top-keys.
 * Чистые функции, без сети. Запуск: npm run build && node scripts/verify-radio-cache-dashboard.js
 */
const assert = require('assert');
const {
  getOrFetchMp3, cacheGetPublic, clearRadioMp3Cache, getTopKeys, getRadioMp3CacheStats,
} = require('../dist/services/radioMp3Cache');
const {
  recordSnapshot, getHistory, clearHistory,
} = require('../dist/services/radioMp3CacheHistory');
const { recordTtsResult } = require('../dist/services/radioMetrics');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

async function main() {
  console.log('[verify] radioMp3Cache dashboard (ТЗ-65)');

  // 1. recordSnapshot → корректная структура
  clearHistory(); clearRadioMp3Cache();
  const snap = recordSnapshot();
  ok('snapshot имеет все поля', () => {
    for (const f of ['ts', 'entries', 'bytes', 'cache_hit', 'cache_miss', 'hitRate', 'inflight']) {
      assert.ok(f in snap, `нет поля ${f}`);
    }
  });

  // 2. Delta hit rate: 3 hit'а между snapshot'ами → 100%
  clearHistory();
  recordTtsResult('ok', 10, 'hit');
  recordTtsResult('ok', 10, 'hit');
  recordTtsResult('ok', 10, 'hit');
  const s2 = recordSnapshot();
  ok('hitRate = 100% при hit-only за интервал', () => assert.strictEqual(s2.hitRate, 100));
  ok('cache_hit cumulative = 3', () => assert.strictEqual(s2.cache_hit, 3));

  // 3. Ring buffer: 1500 snapshot'ов → обрезка до 1440
  clearHistory();
  for (let i = 0; i < 1500; i++) recordSnapshot();
  const h = getHistory();
  ok('ring buffer <= 1440', () => assert.ok(h.length <= 1440));
  ok('ring buffer = 1440', () => assert.strictEqual(h.length, 1440));

  // 4. getHistory возвращает копию
  const before = getHistory().length;
  getHistory().push({ junk: true });
  ok('мутация возвращённого массива не портит ring', () =>
    assert.strictEqual(getHistory().length, before));

  // 5. Top-keys: два hit'а одного ключа → hits = 2, сортировка по убыванию
  clearRadioMp3Cache();
  const fetcher = async () => Buffer.from('mp3');
  await getOrFetchMp3('топ-текст один', 'presenter_male', 1.05, 0, fetcher);
  cacheGetPublic('топ-текст один', 'presenter_male', 1.05, 0);
  cacheGetPublic('топ-текст один', 'presenter_male', 1.05, 0);
  await getOrFetchMp3('редкий текст', 'presenter_male', 1.05, 0, fetcher);
  cacheGetPublic('редкий текст', 'presenter_male', 1.05, 0);
  const top = getTopKeys(10);
  ok('top-keys непустой', () => assert.ok(top.length > 0));
  ok('первый ключ — самый частый (2 hits)', () => {
    assert.strictEqual(top[0].hits, 2);
    assert.ok(top[0].key.includes('топ-текст один'));
  });
  ok('bytes у живой записи > 0', () => assert.ok(top[0].bytes > 0));

  // 6. clearRadioMp3Cache сбрасывает topKeys и stats
  clearRadioMp3Cache();
  ok('topKeys пуст после clear', () => assert.strictEqual(getTopKeys(10).length, 0));
  ok('stats обнулены после clear', () => {
    const st = getRadioMp3CacheStats();
    assert.strictEqual(st.entries, 0);
    assert.strictEqual(st.bytes, 0);
  });

  console.log(`\n${passed} checks passed${process.exitCode ? ' (FAILURES)' : ''}`);
  process.exit(process.exitCode || 0);
}

main().catch(e => { console.error(e); process.exit(1); });
