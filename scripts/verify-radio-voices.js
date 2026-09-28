#!/usr/bin/env node
/**
 * Verify: radioVoices (ТЗ68) — словарь голосов, merge-метаданные, эвристики,
 * preview (hex-декодирование, 2054 → VoiceNotInAccountError), кэш 24ч, fallback.
 * Сеть стаббится через глобальный fetch. Запуск: npm run build && node scripts/verify-radio-voices.js
 */
const assert = require('assert');
const {
  MINIMAX_VOICES, MINIMAX_VOICE_IDS, MINIMAX_VOICE_IDS_SET,
} = require('../dist/config/radio');
const {
  getAvailableVoices, resetVoicesCache, generatePreviewMp3,
  mergeVoiceMeta, humanize, inferGender, inferLanguages,
  VoiceNotInAccountError,
} = require('../dist/services/radioVoices');

let passed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

const REAL_FETCH = global.fetch;
/** Лог всех fetch-вызовов (ключи), заполняется stubFetch. */
const fetchLog = [];
/** Стаббит fetch: ключ карты — url, или `${url} ${voice_type}` для /get_voice. */
function stubFetch(map) {
  global.fetch = async (url, opts) => {
    let voiceType = '';
    try { voiceType = JSON.parse(opts?.body || '{}').voice_type || ''; } catch { /* ignore */ }
    const key = voiceType ? `${url} ${voiceType}` : url;
    fetchLog.push(key);
    const handler = map[key] || map[url];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    const res = typeof handler === 'function' ? await handler(url, opts) : handler;
    return {
      ok: (res.status ?? 200) < 400,
      status: res.status ?? 200,
      json: async () => res.json ?? {},
      text: async () => JSON.stringify(res.json ?? {}),
    };
  };
}

function hexMp3() {
  // «ID3» заголовок в hex — достаточно для декодирования.
  return Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00').toString('hex');
}

async function main() {
  console.log('[verify] radioVoices (ТЗ68)');

  // ─── Словарь MINIMAX_VOICES ────────────────────────────────────────────
  await ok('все голоса словаря валидны (обязательные поля, gender/age enums)', () => {
    for (const [key, v] of Object.entries(MINIMAX_VOICES)) {
      assert.strictEqual(v.id, key, `${key}: id !== ключ`);
      assert.ok(v.labelRu && v.labelEn, `${key}: нет label`);
      assert.ok(['m', 'f', 'n'].includes(v.gender), `${key}: gender`);
      assert.ok(['young', 'middle', 'mature'].includes(v.age), `${key}: age`);
      assert.ok(Array.isArray(v.language) && v.language.length, `${key}: language`);
      assert.ok(['neutral', 'energetic', 'calm', 'warm', 'dramatic'].includes(v.tone), `${key}: tone`);
    }
  });
  await ok('whitelist-голоса эфира (presenter/audiobook/qn) в словаре', () => {
    for (const id of ['presenter_male', 'presenter_female', 'audiobook_male_1', 'male-qn-qingse']) {
      assert.ok(MINIMAX_VOICES[id], `${id} отсутствует`);
    }
  });
  await ok('MINIMAX_VOICE_IDS / SET — производные от словаря', () => {
    assert.deepStrictEqual([...MINIMAX_VOICE_IDS].sort(), Object.keys(MINIMAX_VOICES).sort());
    for (const id of MINIMAX_VOICE_IDS) assert.ok(MINIMAX_VOICE_IDS_SET.has(id));
    assert.ok(!MINIMAX_VOICE_IDS_SET.has('foobar'));
  });
  await ok('в словаре нет выдуманных голосов (все id валидного формата)', () => {
    for (const id of MINIMAX_VOICE_IDS) {
      assert.match(id, /^[a-zA-Z][a-zA-Z0-9_-]+$/, `подозрительный id: ${id}`);
    }
  });

  // ─── Эвристики ─────────────────────────────────────────────────────────
  await ok('humanize: Spanish_Lively_Man → Spanish Lively Man', () => {
    assert.strictEqual(humanize('Spanish_Lively_Man'), 'Spanish Lively Man');
    assert.strictEqual(humanize('male-qn-qingse'), 'Male-Qn-Qingse'); // дефисы не трогаем
  });
  await ok('inferGender: male/female/n', () => {
    assert.strictEqual(inferGender('English Friendly Guy'), 'm');
    assert.strictEqual(inferGender('English Graceful Lady'), 'f');
    assert.strictEqual(inferGender('Saturn'), 'n');
  });
  await ok('inferLanguages по префиксам', () => {
    assert.deepStrictEqual(inferLanguages('English_X'), ['en']);
    assert.deepStrictEqual(inferLanguages('male-qn-qingse'), ['zh']);
    assert.deepStrictEqual(inferLanguages('Japanese_X'), ['ja']);
    assert.deepStrictEqual(inferLanguages('Korean_X'), ['ko']);
    assert.deepStrictEqual(inferLanguages('Mystery'), ['en']);
  });

  // ─── mergeVoiceMeta ────────────────────────────────────────────────────
  await ok('merge: известный голос берёт метаданные из словаря', () => {
    const v = mergeVoiceMeta('presenter_male', { voice_name: 'Presenter Male' }, 'system');
    assert.strictEqual(v.labelRu, 'Михаил');
    assert.strictEqual(v.gender, 'm');
    assert.strictEqual(v.voiceType, 'system');
  });
  await ok('merge: неизвестный голос — humanize + эвристики', () => {
    const v = mergeVoiceMeta('Spanish_Lively_Man', { voice_name: 'Spanish Lively Man' }, 'system');
    assert.strictEqual(v.labelEn, 'Spanish Lively Man');
    assert.strictEqual(v.gender, 'm');
    assert.ok(v.labelRu.length > 0);
  });
  await ok('merge: gender из description, если имени недостаточно', () => {
    const v = mergeVoiceMeta('English_expressive_narrator', {
      voice_name: 'Expressive Narrator',
      description: ['An expressive adult male voice with a British accent.'],
    }, 'system');
    assert.strictEqual(v.gender, 'm');
  });

  // ─── pickVoiceList — реальные структуры ответа Minimax ─────────────────
  await ok('pickVoiceList: system_voice / клонированный массив / null / старые ключи', async () => {
    const { pickVoiceList } = require('../dist/services/radioVoices');
    assert.strictEqual(pickVoiceList({ system_voice: [1, 2] }, 'system').length, 2);
    assert.strictEqual(pickVoiceList({ voice_cloning: [3] }, 'voice_cloning').length, 1);
    assert.deepStrictEqual(pickVoiceList({ voice_generation: null }, 'voice_generation'), []);
    assert.strictEqual(pickVoiceList({ voice_list: [4] }, 'system').length, 1);
    assert.deepStrictEqual(pickVoiceList({ base_resp: {} }, 'system'), []);
  });

  // ─── getAvailableVoices: minimax-ветка + merge + probe + кэш ───────────
  await ok('minimax-ветка: 3 типа, probe словарных голосов, кэш 24ч', async () => {
    resetVoicesCache();
    fetchLog.length = 0;
    let ttsCalls = 0;
    stubFetch({
      'https://api.minimax.io/v1/get_voice system': () => {
        // Реальная структура: system → data.system_voice. В каталоге НЕТ
        // словарных голосов (presenter_male и др. — аккаунтные, не каталожные).
        return { json: { system_voice: [
          { voice_id: 'Spanish_Lively_Man', voice_name: 'Spanish Lively Man',
            description: ['An expressive adult male voice.'] },
        ] } };
      },
      'https://api.minimax.io/v1/get_voice voice_cloning': { json: { voice_cloning: [] } },
      'https://api.minimax.io/v1/get_voice voice_generation': { json: { voice_generation: null } },
      'https://api.minimax.io/v1/t2a_v2': (url, opts) => {
        ttsCalls++;
        // Все словарные голоса кроме audiobook_male_2 — доступны.
        const body = JSON.parse((opts && opts.body) || '{}');
        if (body?.voice_setting?.voice_id === 'audiobook_male_2') {
          return { json: { base_resp: { status_code: 2054, status_msg: 'voice id not exist' } } };
        }
        return { json: { base_resp: { status_code: 0 }, data: { audio: hexMp3() } } };
      },
    });

    const r1 = await getAvailableVoices('test-key');
    assert.strictEqual(r1.source, 'minimax');
    assert.strictEqual(
      fetchLog.filter((k) => k.includes('/get_voice')).length, 3, 'должно быть 3 вызова get_voice',
    );
    // Каталог (1) + словарь целиком (24, минус пересечения) — без дублей.
    const ids = r1.voices.map((v) => v.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'дубли голосов');
    assert.ok(ids.includes('Spanish_Lively_Man'), 'каталожный голос');
    // Словарные голоса добавлены поверх каталога, даже если каталог их не знает.
    const pm = r1.voices.find((v) => v.id === 'presenter_male');
    assert.strictEqual(pm.labelRu, 'Михаил');
    assert.strictEqual(pm.voiceType, 'system');
    const am2 = r1.voices.find((v) => v.id === 'audiobook_male_2');
    assert.strictEqual(am2.inAccount, false);
    const es = r1.voices.find((v) => v.id === 'Spanish_Lively_Man');
    assert.strictEqual(es.inAccount, undefined); // вне словаря — не пробуем
    // Probe идёт ровно по всем словарным голосам.
    assert.strictEqual(ttsCalls, Object.keys(MINIMAX_VOICES).length, 'probe не всех словарных');

    // Кэш: повторный вызов без сети.
    const netCalls = fetchLog.length;
    const r2 = await getAvailableVoices('test-key');
    assert.strictEqual(fetchLog.length, netCalls, 'кэш не сработал');
    assert.strictEqual(r2.source, 'minimax');
    global.fetch = REAL_FETCH;
  });

  // ─── getAvailableVoices: static fallback без ключа / при ошибке API ─────
  await ok('fallback: без API-ключа → static-словарь', async () => {
    resetVoicesCache();
    const r = await getAvailableVoices(undefined);
    assert.strictEqual(r.source, 'static');
    assert.strictEqual(r.voices.length, Object.keys(MINIMAX_VOICES).length);
  });
  await ok('fallback: 5xx от get_voice → static-словарь', async () => {
    resetVoicesCache();
    stubFetch({ 'https://api.minimax.io/v1/get_voice system': { status: 500, json: {} } });
    const r = await getAvailableVoices('test-key');
    assert.strictEqual(r.source, 'static');
    global.fetch = REAL_FETCH;
  });

  // ─── generatePreviewMp3 ────────────────────────────────────────────────
  await ok('preview: status 0 + hex audio → Buffer с ID3-заголовком', async () => {
    stubFetch({
      'https://api.minimax.io/v1/t2a_v2': { json: { base_resp: { status_code: 0 }, data: { audio: hexMp3() } } },
    });
    const buf = await generatePreviewMp3('Привет', 'presenter_male', 1, 0, 'key');
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.subarray(0, 3).toString('latin1'), 'ID3');
    global.fetch = REAL_FETCH;
  });
  await ok('preview: 2054 → VoiceNotInAccountError', async () => {
    stubFetch({
      'https://api.minimax.io/v1/t2a_v2': { json: { base_resp: { status_code: 2054, status_msg: 'voice id not exist' } } },
    });
    await assert.rejects(
      () => generatePreviewMp3('Тест', 'Russian_Reliable_Man', 1, 0, 'key'),
      (e) => e instanceof VoiceNotInAccountError && e.statusCode === 2054,
    );
    global.fetch = REAL_FETCH;
  });
  await ok('preview: прочая ошибка Minimax → generic Error', async () => {
    stubFetch({
      'https://api.minimax.io/v1/t2a_v2': { json: { base_resp: { status_code: 1004, status_msg: 'invalid text' } } },
    });
    await assert.rejects(
      () => generatePreviewMp3('x', 'presenter_male', 1, 0, 'key'),
      /invalid text/,
    );
    global.fetch = REAL_FETCH;
  });

  console.log(`\n[verify] radioVoices: ${passed} проверок пройдено${process.exitCode ? ' (ЕСТЬ ПАДЕНИЯ)' : ''}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
