/**
 * =============================================================================
 * PULSE — Радио: SFX-библиотека (TZ71)
 * =============================================================================
 *
 * Звуковые эффекты («пилик» о новой новости). Симметрично TZ70 radioMusic.ts,
 * но проще: имена без метаданных ([a-z0-9_]+.(mp3|wav|ogg)), true-random pick
 * (без round-robin — повторы допустимы), форматы mp3/wav/ogg.
 *
 * Хранилище: PULSE_SFX_DIR (на VDS /opt/pulse/sfx, bind-mount в compose).
 *
 *   validateSfxFilename()  — security H-4: regex + null byte + separator +
 *                            length cap + hidden file. Единая точка валидации.
 *   listSfxFiles()         — список, in-memory кэш TTL 30 с.
 *   pickRandomSfx()        — случайный файл (null если папка пуста).
 *   getSfxFolderSize()     — security H-1: disk-cap для admin upload.
 *   hasSfxMagicBytes()     — второй слой поверх nosniff: сигнатура по формату
 *                            (mp3: ID3/MPEG frame, wav: RIFF/WAVE, ogg: OggS).
 *   invalidateSfxCache()   — сброс кэша после upload/delete/rename.
 *   ensureSfxDir()         — mkdir recursive при старте сервера (idempotent).
 *
 * Ошибки логируем только кодами (M-2): err.message из fs содержит абсолютные
 * пути — в логи/ответы они не утекают.
 *
 * Почему отдельный сервис, а не обобщение radioMusic.ts (как скетчил TZ71):
 * music несёт метаданные в имени (N_title_YY_tempo_genre) и round-robin,
 * sfx — нет. Обобщение размазало бы эти различия по kind-ветвлениям и
 * сломало бы TZ70 verify-скрипт. Дублирование здесь дешевле абстракции.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import {
  PULSE_SFX_DIR,
  PULSE_SFX_FILENAME_REGEX,
  PULSE_SFX_MAX_FILENAME_LEN,
} from '../config/radio';

export interface SfxFile {
  filename: string;
  sizeBytes: number;
  addedAt: string;
}

interface SfxCache {
  fetchedAt: number;
  files: SfxFile[];
}

let cache: SfxCache | null = null;
const CACHE_TTL_MS = 30_000;

const AUDIO_EXT_REGEX = /\.(mp3|wav|ogg)$/i;

/** Security H-4: усиленная валидация filename — единая точка для всех роутов. */
export function validateSfxFilename(filename: unknown): { ok: boolean; reason?: string } {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > PULSE_SFX_MAX_FILENAME_LEN) {
    return { ok: false, reason: 'invalid_length' };
  }
  if (filename.includes('\0')) return { ok: false, reason: 'null_byte' };
  if (filename.includes('/') || filename.includes('\\')) return { ok: false, reason: 'path_separator' };
  if (filename.startsWith('.')) return { ok: false, reason: 'hidden_file' };
  if (!PULSE_SFX_FILENAME_REGEX.test(filename)) return { ok: false, reason: 'regex_mismatch' };
  return { ok: true };
}

/** Security H-1: суммарный размер папки для disk-cap проверки (admin upload). */
export async function getSfxFolderSize(): Promise<number> {
  try {
    const entries = await fs.readdir(PULSE_SFX_DIR);
    let total = 0;
    for (const entry of entries) {
      try {
        const stat = await fs.stat(path.join(PULSE_SFX_DIR, entry));
        if (stat.isFile()) total += stat.size;
      } catch {
        // race: файл удалили между readdir и stat — игнорируем
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/** Второй слой поверх nosniff (H-2): сигнатура файла должна совпадать с расширением. */
export function hasSfxMagicBytes(buf: Buffer, filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.mp3')) {
    if (buf.length < 3) return false;
    // ID3v2-тег
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
    // MPEG Audio frame header: MPEG1 Layer III (0xFFFB) / MPEG2 (0xFFF3) / MPEG2.5 (0xFFF2)
    if (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) return true;
    return false;
  }
  if (lower.endsWith('.wav')) {
    // "RIFF"...."WAVE" — нужны первые 12 байт
    if (buf.length < 12) return false;
    return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45;
  }
  if (lower.endsWith('.ogg')) {
    // "OggS"
    if (buf.length < 4) return false;
    return buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53;
  }
  return false;
}

/** Список SFX с кэшем 30 с. Пустая/отсутствующая папка → []. */
export async function listSfxFiles(): Promise<SfxFile[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.files;

  try {
    await fs.mkdir(PULSE_SFX_DIR, { recursive: true });
  } catch (err: any) {
    console.error('[RadioSfx] mkdir:', { code: err?.code });
  }

  let entries: string[];
  try {
    entries = await fs.readdir(PULSE_SFX_DIR);
  } catch (err: any) {
    console.error('[RadioSfx] readdir:', { code: err?.code });
    cache = { fetchedAt: Date.now(), files: [] };
    return [];
  }

  const files: SfxFile[] = [];
  for (const filename of entries) {
    if (!AUDIO_EXT_REGEX.test(filename)) continue;
    try {
      const stat = await fs.stat(path.join(PULSE_SFX_DIR, filename));
      if (!stat.isFile()) continue;
      files.push({ filename, sizeBytes: stat.size, addedAt: stat.mtime.toISOString() });
    } catch {
      // race: файл удалили между readdir и stat — пропускаем
    }
  }

  cache = { fetchedAt: Date.now(), files };
  return files;
}

/** Случайный SFX. null если папка пуста — вызывающий код отдаёт { url: null }. */
export async function pickRandomSfx(): Promise<SfxFile | null> {
  const files = await listSfxFiles();
  if (files.length === 0) return null;
  return files[Math.floor(Math.random() * files.length)];
}

/** Очистить кэш (после upload/delete/rename). */
export function invalidateSfxCache(): void {
  cache = null;
}

/** Создать папку при старте сервера (idempotent). Вызывается из index.ts. */
export async function ensureSfxDir(): Promise<void> {
  await fs.mkdir(PULSE_SFX_DIR, { recursive: true });
}
