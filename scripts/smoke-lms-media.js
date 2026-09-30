process.env.USE_SQLITE = 'true';
process.env.SQLITE_FILE = '/tmp/lms-smoke2/pulse.db';
process.env.UPLOADS_DIR = '/tmp/lms-smoke2/uploads';
process.env.SIGNED_URL_SECRET = 'smoke-secret-0123456789abcdef';
process.env.STORAGE_MIN_FREE_PCT = '0';
const assert = require('assert');
const fs = require('fs');
const express = require('express');
(async () => {
  fs.mkdirSync('/tmp/lms-smoke2', { recursive: true });
  const driver = require('../dist/services/storage/driver');
  const { mediaGuard } = require('../dist/services/storage/media');
  await driver.bootstrapStorage();
  // публичная обложка + платный материал
  const cover = await driver.putBuffer(Buffer.from('PNG-DATA'), 'courses', 'cover.png');
  const mat = await driver.putBuffer(Buffer.from('PDF-DATA'), 'materials', 'report.pdf');

  const app = express();
  app.use('/media', mediaGuard);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const port = server.address().port;
  const get = async (p) => fetch(`http://127.0.0.1:${port}${p}`);

  // 1. публичная обложка без подписи → 200 + nosniff
  let r = await get(cover.relPath);
  assert(r.status === 200, `cover status ${r.status}`);
  assert(r.headers.get('x-content-type-options') === 'nosniff');
  assert((r.headers.get('cache-control') || '').startsWith('public'));
  assert((await r.text()) === 'PNG-DATA');

  // 2. материал без подписи → 404
  r = await get(mat.relPath);
  assert(r.status === 404, `material unsigned ${r.status}`);

  // 3. материал с валидной подписью → 200 + private + nosniff
  const signed = driver.signedUrl(mat.relPath, 3600);
  r = await get(signed);
  assert(r.status === 200, `material signed ${r.status}`);
  assert((r.headers.get('cache-control') || '').startsWith('private'));
  assert(r.headers.get('x-content-type-options') === 'nosniff');
  assert((await r.text()) === 'PDF-DATA');

  // 4. подделанная подпись → 404; протухшая → 404
  r = await get(mat.relPath + '?expires=9999999999&sig=forged');
  assert(r.status === 404);
  r = await get(driver.signedUrl(mat.relPath, -10));
  assert(r.status === 404);

  // 5. traversal и запрещённые каталоги → 404
  r = await get('/media/../.env');
  assert(r.status === 404, `traversal ${r.status}`);
  r = await get('/media/tmp/secret.part');
  assert(r.status === 404);
  r = await get('/media/quarantine/virus.bin');
  assert(r.status === 404);

  // 6. SVG/HTML — attachment
  const svg = await driver.putBuffer(Buffer.from('<svg/>'), 'courses', 'x.svg');
  r = await get(svg.relPath);
  assert((r.headers.get('content-disposition') || '').startsWith('attachment'));

  console.log('MEDIA HTTP SMOKE OK (6/6)');
  server.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
