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

// ТЗ-58: диалог с персонажами Михаил/Татьяна — парсится как обычный role/text
ok('ТЗ-58: Михаил/Татьяна + прощание парсятся (whitelist ролей без изменений)', () => {
  const r = parseDialogResponse(`{"dialog":[
    {"role":"host","text":"Здравствуйте. Сегодня у нас в студии Татьяна — наш аналитик."},
    {"role":"guest","text":"Привет, Михаил. Начнём с торговли."},
    {"role":"host","text":"Подытожим ключевое. Продолжаем следить для вас за рынком."}
  ]}`);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].role, 'host');
  assert.strictEqual(r[1].role, 'guest');
  assert.ok(r[2].text.includes('Продолжаем следить'), 'прощание сохранено в тексте');
});

// Hotfix прод: M2.x (MiniMax-M2.5) — reasoning-модель, в content ответ приходит
// с <think>...</think> перед JSON. Парсер обязан снимать.
ok('hotfix: <think>-блок reasoning-модели снимается перед парсингом', () => {
  const r = parseDialogResponse(`<think>
Мне нужно превратить сводку в диалог Михаила и Татьяны.
Подумаю о структуре: приветствие, три темы, подытог.
</think>
{"dialog":[{"role":"host","text":"Здравствуйте. Сегодня у нас в студии Татьяна."},{"role":"guest","text":"Привет, Михаил. Начнём."}]}`);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].role, 'host');
  assert.ok(!JSON.stringify(r).includes('think'), 'think не просочился в сегменты');
});

ok('hotfix: <answer>-обёртка снимается', () => {
  const r = parseDialogResponse(`<answer>{"dialog":[{"role":"host","text":"OK"}]}</answer>`);
  assert.deepStrictEqual(r, [{ role: 'host', text: 'OK' }]);
});

console.log(`[verify] radioPodcast: ${passed}/11 OK`);
