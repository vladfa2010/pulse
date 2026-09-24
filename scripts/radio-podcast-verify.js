#!/usr/bin/env node
/**
 * Verify: radioPodcast (ТЗ-57 v2) — чистые функции без сети.
 * Запуск: npm run build && node scripts/radio-podcast-verify.js
 */
const assert = require('assert');
const {
  parseDialogResponse,
  invalidatePodcastCache,
  logRadioPodcastConfig,
} = require('../dist/services/radioPodcast');

let passed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

console.log('[verify] radioPodcast (ТЗ-57 v2)');

ok('plain JSON → segments', () => {
  const r = parseDialogResponse('{"dialog":[{"role":"host","text":"Привет"},{"role":"guest","text":"Здравствуйте"}]}');
  assert.deepStrictEqual(r, [
    { role: 'host', text: 'Привет' },
    { role: 'guest', text: 'Здравствуйте' },
  ]);
});

ok('```json обёртка снимается', () => {
  const r = parseDialogResponse('```json\n{"dialog":[{"role":"host","text":"OK"}]}\n```');
  assert.deepStrictEqual(r, [{ role: 'host', text: 'OK' }]);
});

ok('невалидный JSON → throw', () => {
  assert.throws(() => parseDialogResponse('not json'));
});

ok('пустой text сегмента → throw', () => {
  assert.throws(() => parseDialogResponse('{"dialog":[{"role":"host","text":" "}]}'));
});

ok('strict role whitelist: narrator → host', () => {
  const r = parseDialogResponse('{"dialog":[{"role":"narrator","text":"Hi"}]}');
  assert.strictEqual(r[0].role, 'host');
});

ok('отсутствует dialog[] → throw', () => {
  assert.throws(() => parseDialogResponse('{"segments":[]}'));
});

ok('invalidatePodcastCache — no-throw', () => {
  invalidatePodcastCache();
});

ok('logRadioPodcastConfig — no-throw без env', () => {
  delete process.env.MINIMAX_CHAT_MODEL;
  logRadioPodcastConfig();
});

console.log(`[verify] radioPodcast: ${passed}/8 OK`);
