#!/usr/bin/env node
/**
 * Verify: radioMusic (TZ70) — парсер имён, валидация filename (H-4), magic bytes,
 * флаги radioSettings (music_enabled), публичный флаг в /api/radio/config,
 * presence роутов и security-заголовков, лимитер.
 * Запуск: npm run build && node scripts/verify-radio-music.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  PULSE_MUSIC_DIR,
  PULSE_MUSIC_FILENAME_REGEX,
  PULSE_MUSIC_MAX_FILENAME_LEN,
  PULSE_MUSIC_MAX_FILES,
  PULSE_MUSIC_MAX_FILE_SIZE,
  PULSE_MUSIC_MAX_FOLDER_SIZE,
  PULSE_MUSIC_RANGE_PARTS_LIMIT,
} = require('../dist/config/radio');
const {
  parseMusicFilename,
  validateMusicFilename,
  hasMp3MagicBytes,
} = require('../dist/services/radioMusic');
const { RADIO_FLAG_DEFAULTS } = require('../dist/services/radioSettings');

let passed = 0;
async function ok(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); process.exitCode = 1; }
}

const src = (p) => fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');

async function main() {
  console.log('[verify] radioMusic (TZ70)');

  // ─── Парсер имён ────────────────────────────────────────────────────────
  await ok('parseMusicFilename: валидное имя', () => {
    const m = parseMusicFilename('1_my_song_26_slow_rnb.mp3');
    assert.deepStrictEqual(m, {
      filename: '1_my_song_26_slow_rnb.mp3',
      id: 1, title: 'my song', year: 2026, tempo: 'slow', genre: 'rnb',
    });
  });
  await ok('parseMusicFilename: темп/жанр/год из примеров ТЗ', () => {
    assert.strictEqual(parseMusicFilename('3_market_pulse_26_fast_dubstep.mp3').tempo, 'fast');
    assert.strictEqual(parseMusicFilename('2_evening_walk_25_medium_electronic.mp3').year, 2025);
    assert.strictEqual(parseMusicFilename('2_evening_walk_25_medium_electronic.mp3').genre, 'electronic');
  });
  await ok('parseMusicFilename: невалидные имена → null', () => {
    assert.strictEqual(parseMusicFilename('foo.mp3'), null);
    assert.strictEqual(parseMusicFilename('99_x_y_27_medium__rock.mp3'), null); // пустой genre
    assert.strictEqual(parseMusicFilename('2_evening_walk_25_medium.mp3'), null); // нет genre
    assert.strictEqual(parseMusicFilename('1_x_26_slow_rnb.MP3'), null); // регистрозависимо
    assert.strictEqual(parseMusicFilename('1_x_26_quick_rnb.mp3'), null); // tempo вне enum
  });

  // ─── validateMusicFilename (H-4) ────────────────────────────────────────
  await ok('validate: валидное имя → ok', () => {
    assert.deepStrictEqual(validateMusicFilename('1_x_26_slow_rnb.mp3'), { ok: true });
  });
  await ok('validate: path traversal → path_separator', () => {
    assert.deepStrictEqual(validateMusicFilename('../../../etc/passwd.mp3'), { ok: false, reason: 'path_separator' });
    assert.deepStrictEqual(validateMusicFilename('..\\..\\win.ini.mp3'), { ok: false, reason: 'path_separator' });
  });
  await ok('validate: null byte → null_byte', () => {
    assert.deepStrictEqual(validateMusicFilename('1_x\x0026_slow_rnb.mp3'), { ok: false, reason: 'null_byte' });
  });
  await ok('validate: overlong → invalid_length', () => {
    assert.deepStrictEqual(
      validateMusicFilename('1_x_26_slow_rnb.mp3' + 'A'.repeat(PULSE_MUSIC_MAX_FILENAME_LEN)),
      { ok: false, reason: 'invalid_length' },
    );
    assert.deepStrictEqual(validateMusicFilename(''), { ok: false, reason: 'invalid_length' });
    assert.deepStrictEqual(validateMusicFilename(null), { ok: false, reason: 'invalid_length' });
  });
  await ok('validate: hidden file → hidden_file', () => {
    assert.deepStrictEqual(validateMusicFilename('.hidden.mp3'), { ok: false, reason: 'hidden_file' });
  });
  await ok('validate: regex mismatch', () => {
    assert.deepStrictEqual(validateMusicFilename('wrongname.mp3'), { ok: false, reason: 'regex_mismatch' });
  });

  // ─── Magic bytes (второй слой поверх nosniff) ───────────────────────────
  await ok('hasMp3MagicBytes: ID3 / MPEG frame / мусор', () => {
    assert.strictEqual(hasMp3MagicBytes(Buffer.from('ID3\x04\x00\x00')), true);
    assert.strictEqual(hasMp3MagicBytes(Buffer.from([0xff, 0xfb, 0x90])), true);  // MPEG1 L3
    assert.strictEqual(hasMp3MagicBytes(Buffer.from([0xff, 0xf3, 0x90])), true);  // MPEG2 L3
    assert.strictEqual(hasMp3MagicBytes(Buffer.from([0xff, 0xf2, 0x90])), true);  // MPEG2.5 L3
    assert.strictEqual(hasMp3MagicBytes(Buffer.from('<html><')), false);
    assert.strictEqual(hasMp3MagicBytes(Buffer.from([0x00, 0x01])), false);       // слишком короткий
  });

  // ─── Флаги ──────────────────────────────────────────────────────────────
  await ok('RADIO_FLAG_DEFAULTS: music_enabled=true, валидный boolean', () => {
    assert.strictEqual(RADIO_FLAG_DEFAULTS.music_enabled, true);
    assert.strictEqual(typeof RADIO_FLAG_DEFAULTS.music_enabled, 'boolean');
  });
  await ok('radioSettings: case music_enabled в setRadioFlag (boolean-валидация)', () => {
    const s = src('services/radioSettings.ts');
    assert.match(s, /case 'music_enabled':[\s\S]{0,200}must be a boolean/, 'нет case/валидации music_enabled');
    assert.match(s, /music_enabled: dbValues\.get\('music_enabled'\)/, 'нет чтения music_enabled из БД');
  });
  await ok('/api/radio/config отдаёт radio_music_enabled (boolean)', () => {
    assert.match(src('routes/radio.ts'), /radio_music_enabled: flags\.music_enabled/);
  });

  // ─── Роуты radio.ts ─────────────────────────────────────────────────────
  await ok('routes/radio.ts: music/next, music/list, music/file присутствуют', () => {
    const s = src('routes/radio.ts');
    assert.match(s, /router\.get\('\/music\/next'/);
    assert.match(s, /router\.get\('\/music\/list'/);
    assert.match(s, /router\.get\('\/music\/file\/:filename'/);
  });
  await ok('music-роуты под optionalAuth + radioMusicLimiter', () => {
    const s = src('routes/radio.ts');
    for (const r of ['/music/next', '/music/list', '/music/file/:filename']) {
      const line = s.split('\n').find((l) => l.includes(`router.get('${r}'`));
      assert.ok(line, `${r}: роут не найден`);
      assert.ok(line.includes('optionalAuth'), `${r}: нет optionalAuth в строке: ${line.trim()}`);
      assert.ok(line.includes('radioMusicLimiter'), `${r}: нет radioMusicLimiter в строке: ${line.trim()}`);
    }
  });
  await ok('music/file: security-заголовки (H-2) + range-parts лимит (M-1)', () => {
    const s = src('routes/radio.ts');
    assert.match(s, /X-Content-Type-Options', 'nosniff'/);
    assert.match(s, /Content-Disposition', 'inline'/);
    assert.match(s, /Accept-Ranges', 'bytes'/);
    assert.match(s, /too_many_range_parts/);
    assert.match(s, /PULSE_MUSIC_RANGE_PARTS_LIMIT/);
  });
  await ok('music/file: path traversal defense-in-depth (resolve + startsWith)', () => {
    const s = src('routes/radio.ts');
    assert.match(s, /path\.resolve\(PULSE_MUSIC_DIR, filename\)/);
    assert.match(s, /filepath\.startsWith\(PULSE_MUSIC_DIR \+ path\.sep\)/);
  });

  // ─── Роуты admin.ts ─────────────────────────────────────────────────────
  await ok('routes/admin.ts: upload/delete/patch music присутствуют', () => {
    const s = src('routes/admin.ts');
    assert.match(s, /router\.post\('\/radio\/music\/upload'/);
    assert.match(s, /router\.delete\('\/radio\/music\/:filename'/);
    assert.match(s, /router\.patch\('\/radio\/music\/:filename'/);
  });
  await ok('upload: adminMiddleware + disk-cap (H-1) + duplicate (H-3) + magic bytes', () => {
    const s = src('routes/admin.ts');
    assert.match(s, /router\.post\('\/radio\/music\/upload', adminMiddleware/);
    assert.match(s, /PULSE_MUSIC_MAX_FOLDER_SIZE/);
    assert.match(s, /folder_too_large/);
    assert.match(s, /duplicate_filename/);
    assert.match(s, /hasMp3MagicBytes/);
    assert.match(s, /not_an_mp3/);
    assert.match(s, /PULSE_MUSIC_MAX_FILES/);
    assert.match(s, /LIMIT_FILE_SIZE/);
  });

  // ─── Конфиг ─────────────────────────────────────────────────────────────
  await ok('config/radio.ts: лимиты разумны', () => {
    assert.strictEqual(PULSE_MUSIC_MAX_FILES, 50);
    assert.strictEqual(PULSE_MUSIC_MAX_FILE_SIZE, 50 * 1024 * 1024);
    assert.strictEqual(PULSE_MUSIC_MAX_FOLDER_SIZE, 2 * 1024 * 1024 * 1024);
    assert.strictEqual(PULSE_MUSIC_RANGE_PARTS_LIMIT, 10);
    assert.strictEqual(PULSE_MUSIC_MAX_FILENAME_LEN, 200);
    assert.ok(PULSE_MUSIC_DIR.length > 0);
    assert.ok(PULSE_MUSIC_FILENAME_REGEX.test('1_x_26_slow_rnb.mp3'));
  });

  // ─── Лимитер ────────────────────────────────────────────────────────────
  await ok('middleware/rateLimit.ts: radioMusicLimiter 100/мин, ключ userId||IP', () => {
    const s = src('middleware/rateLimit.ts');
    const m = s.match(/export const radioMusicLimiter = rateLimit\(\{[\s\S]*?\}\);/);
    assert.ok(m, 'radioMusicLimiter не найден');
    assert.match(m[0], /max: 100/);
    assert.match(m[0], /user\?\.userId \|\| req\.ip/);
  });

  // ─── Boot: папка создаётся при старте ────────────────────────────────────
  await ok('index.ts: ensureMusicDir() при старте', () => {
    const s = src('index.ts');
    assert.match(s, /ensureMusicDir\(\)/);
  });

  console.log(`\n[verify] radioMusic: ${passed} проверок пройдено${process.exitCode ? ' (ЕСТЬ ПАДЕНИЯ)' : ''}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
