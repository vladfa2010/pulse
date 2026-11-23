/**
 * =============================================================================
 * PULSE — ТЗ-198: единый пайплайн обложек курсов/программ
 * =============================================================================
 *
 * До ТЗ-198 обложки сохранялись как есть (sharp делал только EXIF-rotate),
 * оригиналы до 5 МБ отдавались всем ученикам витрины. Теперь:
 *   EXIF-rotate → лимит 50 Мпикс → resize ≤1920px → WebP q82.
 *
 * Ошибки — CoverImageError со status 413 (decompression bomb) / 415
 * (не изображение), роуты маппят в HTTP-ответ без изменения контракта.
 */
import sharp from 'sharp';

export class CoverImageError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CoverImageError';
  }
}

export interface CoverDerivatives {
  /** обложка витрины/карточки: ≤1920px webp q82 (контракт ТЗ-198) */
  webp: Buffer;
  /** ТЗ-205.1: og:image для краулеров — 1200×630 jpeg (Telegram/X не берут webp
   *  в summary_large_image). Считается ОТ ИСХОДНОГО буфера (не от webp) —
   *  качество, один metadata pass. */
  ogJpg: Buffer;
}

export async function compressCoverImage(input: Buffer): Promise<CoverDerivatives> {
  try {
    const img = sharp(input).rotate();
    const meta = await img.metadata();
    const megapixels = (meta.width || 0) * (meta.height || 0) / 1e6;
    if (megapixels > 50) {
      throw new CoverImageError(413, 'Изображение больше 50 Мпикс (decompression bomb)');
    }
    const webp = await img
      .clone()
      .resize({ width: 1920, withoutEnlargement: true })
      .toFormat('webp', { quality: 82 })
      .toBuffer();
    const ogJpg = await img
      .clone()
      .resize({ width: 1200, height: 630, fit: 'cover', position: 'attention' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    return { webp, ogJpg };
  } catch (err: any) {
    if (err instanceof CoverImageError) throw err;
    throw new CoverImageError(415, 'Файл не является корректным изображением');
  }
}
