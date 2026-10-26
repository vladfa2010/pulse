/**
 * =============================================================================
 * PULSE — ТЗ-198: сжатие обложек курсов/программ при загрузке (тесты)
 * =============================================================================
 *
 * Чистый юнит-прогон без HTTP и БД — гоняем compressCoverImage (реальный sharp).
 *   1. jpeg/png/webp на входе → webp на выходе.
 *   2. 4000px-фото → ширина 1920px.
 *   3. Файл <1920px не увеличивается.
 *   4. Вес результата < входа на типовой (шумной) фикстуре.
 *   5. 50+ Мпикс → CoverImageError 413 (decompression bomb).
 *   6. Битый буфер → CoverImageError 415 (не изображение).
 *
 * Запуск:  npx ts-node src/tests/coverUpload.tz198.test.ts
 */

import sharp from 'sharp';
import { compressCoverImage, CoverImageError } from '../utils/coverImage';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: any) {
  if (cond) { passed++; console.log(`  ok  ${name}`); }
  else { failed++; console.error(`  FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

/** Шумная фикстура — сжимаемый контент (однотонный webp жмётся до копеек и так). */
async function noisyFixture(width: number, height: number, format: 'jpeg' | 'png' | 'webp'): Promise<Buffer> {
  // Градиент + псевдошум через повторённые полосы — достаточно энтропии для веса
  const svg = `<svg width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#203040"/><stop offset="1" stop-color="#a0b0c0"/>
    </linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#g)"/>
    ${Array.from({ length: 400 }, (_, i) =>
      `<circle cx="${(i * 97) % width}" cy="${(i * 211) % height}" r="${(i % 5) + 1}"
        fill="rgba(${(i * 37) % 255},${(i * 53) % 255},${(i * 71) % 255},0.6)"/>`,
    ).join('')}
  </svg>`;
  const img = sharp(Buffer.from(svg)).resize({ width, height });
  if (format === 'png') return img.png({ compressionLevel: 1 }).toBuffer(); // «тяжёлый» png
  if (format === 'webp') return img.webp({ quality: 95 }).toBuffer();
  return img.jpeg({ quality: 92 }).toBuffer();
}

async function run() {
  console.log('ТЗ-198 compressCoverImage:');

  // 1. Форматы на входе → webp на выходе
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const input = await noisyFixture(1200, 800, format);
    const out = await compressCoverImage(input);
    const meta = await sharp(out).metadata();
    check(`${format} → выход webp`, meta.format === 'webp', meta.format);
    check(`${format} → EXIF/GPS отсутствуют`, !meta.exif && !meta.xmp, { exif: !!meta.exif, xmp: !!meta.xmp });
  }

  // 2. 4000px → 1920px
  const big = await noisyFixture(4000, 3000, 'jpeg');
  const bigOut = await compressCoverImage(big);
  const bigMeta = await sharp(bigOut).metadata();
  check('4000px → ширина 1920px', bigMeta.width === 1920, bigMeta.width);
  check('пропорции сохранены (h=1440)', bigMeta.height === 1440, bigMeta.height);
  check('вес выхода < веса входа', bigOut.length < big.length,
    { in: big.length, out: bigOut.length });

  // 3. Меньше 1920 — не увеличиваем
  const small = await noisyFixture(800, 600, 'jpeg');
  const smallOut = await compressCoverImage(small);
  const smallMeta = await sharp(smallOut).metadata();
  check('800px → не увеличен (800px)', smallMeta.width === 800, smallMeta.width);

  // 4. Бомба: 9000×7000 = 63 Мпикс > 50 → 413
  const bomb = await noisyFixture(9000, 7000, 'jpeg');
  try {
    await compressCoverImage(bomb);
    check('63 Мпикс → CoverImageError 413', false, 'не бросил');
  } catch (err: any) {
    check('63 Мпикс → CoverImageError 413',
      err instanceof CoverImageError && err.status === 413, { status: err?.status });
  }

  // 5. Битый буфер → 415
  try {
    await compressCoverImage(Buffer.from('это не изображение, а текст 12345'));
    check('битый буфер → CoverImageError 415', false, 'не бросил');
  } catch (err: any) {
    check('битый буфер → CoverImageError 415',
      err instanceof CoverImageError && err.status === 415, { status: err?.status });
  }

  console.log(`\nИтого: ${passed} ok, ${failed} fail`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Непредвиденное падение прогона:', err);
  process.exit(1);
});
