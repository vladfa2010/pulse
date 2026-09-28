/**
 * =============================================================================
 * PULSE — Радио: фоновая музыка между блоками новостей (TZ70)
 * =============================================================================
 *
 * Хранилище: PULSE_MUSIC_DIR (на VDS /opt/pulse/music, проброшена в контейнер
 * bind-mount'ом). Имя файла несёт метаданные: N_title_YY_tempo_genre.mp3.
 *
 *   listMusicFiles()      — список треков, in-memory кэш TTL 30 с (минимизируем
 *                           disk I/O: /music/list поллит админка каждые 30 с).
 *   pickRandomMusic()     — shuffle без повторов до полного обхода (round-robin
 *                           по кэшированному порядку).
 *   parseMusicFilename()  — парсер метаданных из имени.
 *   validateMusicFilename() — security H-4: regex + null byte + separator +
 *                           length cap + hidden file. Единая точка валидации
 *                           для upload/delete/patch/get-file.
 *   getMusicFolderSize()  — security H-1: суммарный размер папки (disk-cap).
 *   hasMp3MagicBytes()    — второй слой поверх nosniff: заголовок ID3 / MPEG frame.
 *   invalidateMusicCache()— сброс кэша после upload/delete/rename.
 *   ensureMusicDir()      — mkdir recursive при старте (первый upload не падает,
 *                           если папку забыли создать на хосте).
 *
 * Ошибки логируем только кодами (M-2): err.message из fs содержит абсолютные
 * пути — в логи/ответы они не утекают.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import {
  PULSE_MUSIC_DIR,
  PULSE_MUSIC_FILENAME_REGEX,
  PULSE_MUSIC_MAX_FILENAME_LEN,
} from '../config/radio';

export interface MusicTrackMeta {
  filename: string;
  id: number;
  title: string;
  year: number;
  tempo: 'slow' | 'medium' | 'fast';
  genre: string;
  sizeBytes: number;
  addedAt: string;
}

interface MusicCache {
  fetchedAt: number;
  files: MusicTrackMeta[];
  /** shuffle-перестановка индексов files; cursor — позиция round-robin. */
  order: number[];
  cursor: number;
}

let cache: MusicCache | null = null;
const CACHE_TTL_MS = 30_000;

function shuffledOrder(n: number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Security H-4: усиленная валидация filename — единая точка для всех роутов. */
export function validateMusicFilename(filename: unknown): { ok: boolean; reason?: string } {
  if (typeof filename !== 'string' || filename.length === 0 || filename.length > PULSE_MUSIC_MAX_FILENAME_LEN) {
    return { ok: false, reason: 'invalid_length' };
  }
  if (filename.includes('\0')) return { ok: false, reason: 'null_byte' };
  if (filename.includes('/') || filename.includes('\\')) return { ok: false, reason: 'path_separator' };
  if (filename.startsWith('.')) return { ok: false, reason: 'hidden_file' };
  if (!PULSE_MUSIC_FILENAME_REGEX.test(filename)) return { ok: false, reason: 'regex_mismatch' };
  return { ok: true };
}

/** Парсер метаданных из имени файла. null если имя не соответствует формату. */
export function parseMusicFilename(filename: string): Omit<MusicTrackMeta, 'sizeBytes' | 'addedAt'> | null {
  const m = filename.match(PULSE_MUSIC_FILENAME_REGEX);
  if (!m) return null;
  return {
    filename,
    id: Number(m[1]),
    title: m[2].replace(/_/g, ' ').trim(), // висячий '_' перед годом → пробел → trim
    year: 2000 + Number(m[3]),
    tempo: m[4] as 'slow' | 'medium' | 'fast',
    genre: m[5],
  };
}

/** Security H-1: суммарный размер папки для disk-cap проверки (admin upload). */
export async function getMusicFolderSize(): Promise<number> {
  try {
    const entries = await fs.readdir(PULSE_MUSIC_DIR);
    let total = 0;
    for (const entry of entries) {
      try {
        const stat = await fs.stat(path.join(PULSE_MUSIC_DIR, entry));
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

/** Второй слой поверх nosniff (H-2): по заголовку проверяем, что это реально mp3. */
export function hasMp3MagicBytes(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  // ID3v2-тег
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // "ID3"
  // MPEG Audio frame header: 11 sync bits + MPEG1 Layer III (0xFFFB) / MPEG2 (0xFFF3) / MPEG2.5 (0xFFF2)
  if (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) return true;
  return false;
}

/** Список треков с кэшем 30 с. Пустая/отсутствующая папка → []. */
export async function listMusicFiles(): Promise<MusicTrackMeta[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.files;

  try {
    await fs.mkdir(PULSE_MUSIC_DIR, { recursive: true });
  } catch (err: any) {
    console.error('[RadioMusic] mkdir:', { code: err?.code });
  }

  let entries: string[];
  try {
    entries = await fs.readdir(PULSE_MUSIC_DIR);
  } catch (err: any) {
    console.error('[RadioMusic] readdir:', { code: err?.code });
    cache = { fetchedAt: Date.now(), files: [], order: [], cursor: 0 };
    return [];
  }

  const files: MusicTrackMeta[] = [];
  for (const filename of entries) {
    if (!filename.endsWith('.mp3')) continue;
    const meta = parseMusicFilename(filename);
    if (!meta) continue;
    try {
      const stat = await fs.stat(path.join(PULSE_MUSIC_DIR, filename));
      files.push({ ...meta, sizeBytes: stat.size, addedAt: stat.mtime.toISOString() });
    } catch {
      // race: файл удалили между readdir и stat — пропускаем
    }
  }

  cache = { fetchedAt: Date.now(), files, order: shuffledOrder(files.length), cursor: 0 };
  return files;
}

/**
 * Следующий трек: round-robin по shuffle-порядку, без повторов до полного обхода.
 * null если папка пуста — вызывающий код отдаёт { url: null } (тишина, не 404).
 */
export async function pickRandomMusic(): Promise<MusicTrackMeta | null> {
  const files = await listMusicFiles();
  if (files.length === 0 || !cache) return null;

  if (cache.order.length !== files.length) {
    // Состав папки изменился с момента shuffle — пересоздаём порядок.
    cache.order = shuffledOrder(files.length);
    cache.cursor = 0;
  }
  if (cache.cursor >= cache.order.length) {
    cache.order = shuffledOrder(files.length);
    cache.cursor = 0;
  }
  const idx = cache.order[cache.cursor++];
  return files[idx] ?? null;
}

/** Очистить кэш (после upload/delete/rename — TTL 30 с тоже покрыло бы, но явно надёжнее). */
export function invalidateMusicCache(): void {
  cache = null;
}

/** Создать папку при старте сервера (idempotent). Вызывается из index.ts. */
export async function ensureMusicDir(): Promise<void> {
  await fs.mkdir(PULSE_MUSIC_DIR, { recursive: true });
}
