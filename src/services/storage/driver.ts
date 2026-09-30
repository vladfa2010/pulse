/**
 * =============================================================================
 * PULSE — Storage-драйвер для файлов LMS (ТЗ-100 v15, Задача 1а; расширена v11)
 * =============================================================================
 *
 * Единый интерфейс хранения файлов для образовательного раздела:
 *   put(file) → url      — атомарная запись (tmp → fsync → rename)
 *   delete(url)          — soft-delete: перенос в tmp/trash (retention 30 дней)
 *   signedUrl(url, ttl)  — HMAC-подписанный URL (?expires=…&sig=…)
 *
 * Драйверы:
 *   local — файлы на диске в UPLOADS_DIR (по умолчанию ./uploads, в docker
 *           /app/uploads через env). Отдача — middleware mediaGuard (media.ts).
 *   s3    — интерфейс заложен, реализация — заглушка до переезда на
 *           объектное хранилище.
 *
 * В БД хранятся ТОЛЬКО относительные пути вида /media/<kind>/<filename> —
 * смена драйвера/домена/бакета не требует миграции данных.
 *
 * Каталоги внутри UPLOADS_DIR (bootstrap при старте):
 *   courses/     — обложки курсов (публичные)
 *   materials/   — материалы курсов (только через signed URL)
 *   ugc/         — UGC-файлы (ТЗ-102)
 *   tmp/         — временные файлы загрузки (сироты зачищаются при старте)
 *   tmp/trash/   — soft-delete корзина (retention TRASH_RETENTION_DAYS)
 *   quarantine/  — карантин ClamAV (ТЗ-102 v2)
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ─── Конфигурация (env) ─────────────────────────────────────────────────────

export const STORAGE_DRIVER: string = process.env.STORAGE_DRIVER || 'local';
export const UPLOADS_DIR: string = process.env.UPLOADS_DIR || './uploads';
export const SIGNED_URL_TTL_SEC: number = parseInt(process.env.SIGNED_URL_TTL_SEC || '3600', 10);
// TTL 1 час — осознанное отличие от 5-минутного эталона (ТЗ-100 v3 §1а):
// подпись защищает от хотлинка/перебора, а единственный барьер доступа —
// проверка ДО выдачи ссылки на download-эндпоинте.

const SIGNED_URL_SECRET: string | undefined = process.env.SIGNED_URL_SECRET;
const TRASH_RETENTION_DAYS: number = parseInt(process.env.STORAGE_TRASH_RETENTION_DAYS || '30', 10);
const TMP_ORPHAN_MAX_AGE_MS: number = 24 * 60 * 60 * 1000; // сироты в tmp/ старше суток
// < N % свободного места → 507 (S6). Env-override для dev-станций с забитым диском.
const MIN_FREE_DISK_PCT = parseInt(process.env.STORAGE_MIN_FREE_PCT || '10', 10);

// Fail-fast, как ENCRYPTION_KEY в services/crypto.ts: локальный драйвер
// без секрета подписи — неработоспособная конфигурация, лучше упасть при старте.
if (STORAGE_DRIVER === 'local' && !SIGNED_URL_SECRET) {
  throw new Error(
    'SIGNED_URL_SECRET environment variable is required when STORAGE_DRIVER=local. ' +
    'Generate: openssl rand -hex 32'
  );
}
if (STORAGE_DRIVER !== 'local' && STORAGE_DRIVER !== 's3') {
  throw new Error(`Unknown STORAGE_DRIVER="${STORAGE_DRIVER}" (expected local|s3)`);
}

export class StorageError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ─── Пути ───────────────────────────────────────────────────────────────────

export type UploadKind = 'courses' | 'materials' | 'ugc';

// Публичные (без подписи) подкаталоги. Всё остальное — только по signed URL.
const PUBLIC_KINDS: UploadKind[] = ['courses'];

const BOOTSTRAP_DIRS = ['courses', 'materials', 'ugc', 'tmp', 'tmp/trash', 'quarantine'];

function absFromRel(relPath: string): string {
  // relPath вида /media/<kind>/<filename> → абсолютный путь внутри UPLOADS_DIR
  const rel = relPath.replace(/^\/+/, '');
  const withoutMedia = rel.startsWith('media/') ? rel.slice('media/'.length) : rel;
  const abs = path.resolve(UPLOADS_DIR, withoutMedia);
  // defense-in-depth: обязан остаться внутри UPLOADS_DIR (паттерн radio.ts)
  if (abs !== UPLOADS_DIR && !abs.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
    throw new StorageError(400, 'invalid path');
  }
  return abs;
}

// ─── HMAC-подпись signed URL ────────────────────────────────────────────────

function hmac(relPath: string, expires: number): string {
  return crypto
    .createHmac('sha256', SIGNED_URL_SECRET!)
    .update(`${relPath}|${expires}`)
    .digest('base64url');
}

/**
 * Выдать подписанный URL для относительного пути.
 * Подпись считается по пути + unix-expiry; проверка — verifySignedUrl().
 */
export function signedUrl(relPath: string, ttlSec?: number): string {
  const expires = Math.floor(Date.now() / 1000) + (ttlSec ?? SIGNED_URL_TTL_SEC);
  return `${relPath}?expires=${expires}&sig=${hmac(relPath, expires)}`;
}

/**
 * Проверить подпись. Любая ошибка формата/протухания/несовпадения → false
 * (вызывающий код отвечает 404 — не раскрываем причину отказа).
 */
export function verifySignedUrl(relPath: string, expires: string, sig: string): boolean {
  const exp = Number(expires);
  if (!Number.isFinite(exp) || !sig) return false;
  if (exp * 1000 < Date.now()) return false; // протух
  const expected = hmac(relPath, exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function isPublicKind(relPath: string): boolean {
  const kind = relPath.replace(/^\/+/, '').split('/')[1]; // media/<kind>/…
  return (PUBLIC_KINDS as string[]).includes(kind);
}

// ─── Диск и квоты (S6) ──────────────────────────────────────────────────────

/**
 * Проверка свободного места перед записью. < 10 % → 507 Insufficient Storage
 * (человекочитаемая ошибка админу, до исчерпания диска).
 */
export async function assertDiskSpace(): Promise<void> {
  const stats = await fs.promises.statfs(UPLOADS_DIR);
  const freePct = (stats.bavail / stats.blocks) * 100;
  if (freePct < MIN_FREE_DISK_PCT) {
    throw new StorageError(
      507,
      `Недостаточно места на диске хранилища (${freePct.toFixed(1)}% свободно, ` +
      `нужно ≥ ${MIN_FREE_DISK_PCT}%). Очистите файлы или увеличьте диск.`
    );
  }
}

// ─── Атомарная запись (S11) ─────────────────────────────────────────────────

// Безопасное имя файла: <uuid><ext> — оригинальное имя в путь не попадает
// (защита от path traversal и проблем с кодировками; имя трека хранится в БД).
function safeFilename(originalName: string): string {
  const ext = path.extname(originalName || '').toLowerCase();
  const safeExt = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
  return `${crypto.randomUUID()}${safeExt}`;
}

async function atomicWrite(absTmp: string, absTarget: string, buf: Buffer): Promise<void> {
  await fs.promises.writeFile(absTmp, buf);
  const fd = await fs.promises.open(absTmp, 'r');
  try {
    await fd.sync(); // fsync до rename — файл цел даже при падении по питанию
  } finally {
    await fd.close();
  }
  await fs.promises.rename(absTmp, absTarget);
}

export interface PutResult {
  relPath: string; // /media/<kind>/<filename> — ЕДИНСТВЕННОЕ, что попадает в БД
  url: string;     // публичный URL (для covers) или путь для signedUrl()
  size: number;
}

/**
 * Записать буфер в хранилище. kind определяет подкаталог и правила отдачи.
 * Атомарность: tmp → fsync → rename; при ошибке после rename — компенсирующее
 * удаление. Ни при каком падении нет пары «запись в БД есть, файла нет»
 * (INSERT в БД делается вызывающим кодом ПОСЛЕ успешного put).
 */
export async function putBuffer(
  buf: Buffer,
  kind: UploadKind,
  originalName: string,
): Promise<PutResult> {
  if (STORAGE_DRIVER !== 'local') throw new StorageError(501, 'storage driver not implemented');
  await assertDiskSpace();

  const filename = safeFilename(originalName);
  const relPath = `/media/${kind}/${filename}`;
  const absTarget = absFromRel(relPath);
  const absTmp = path.join(UPLOADS_DIR, 'tmp', `${crypto.randomUUID()}.part`);

  try {
    await atomicWrite(absTmp, absTarget, buf);
  } catch (err) {
    // Компенсация: цель могла появиться до ошибки — убираем оба варианта
    await fs.promises.unlink(absTmp).catch(() => {});
    await fs.promises.unlink(absTarget).catch(() => {});
    throw err;
  }
  return { relPath, url: relPath, size: buf.length };
}

/**
 * Перенести файл из временного пути (напр. tmp-файл multer из ТЗ-101)
 * в хранилище с той же атомарной гарантией.
 */
export async function putFile(
  srcAbsPath: string,
  kind: UploadKind,
  originalName: string,
): Promise<PutResult> {
  if (STORAGE_DRIVER !== 'local') throw new StorageError(501, 'storage driver not implemented');
  await assertDiskSpace();

  const filename = safeFilename(originalName);
  const relPath = `/media/${kind}/${filename}`;
  const absTarget = absFromRel(relPath);
  const absTmp = path.join(UPLOADS_DIR, 'tmp', `${crypto.randomUUID()}.part`);

  try {
    // copy + fsync + rename (источник может быть на другой файловой системе)
    await fs.promises.copyFile(srcAbsPath, absTmp);
    const fd = await fs.promises.open(absTmp, 'r');
    try {
      await fd.sync();
    } finally {
      await fd.close();
    }
    await fs.promises.rename(absTmp, absTarget);
    await fs.promises.unlink(srcAbsPath).catch(() => {});
  } catch (err) {
    await fs.promises.unlink(absTmp).catch(() => {});
    await fs.promises.unlink(absTarget).catch(() => {});
    throw err;
  }
  return { relPath, url: relPath, size: (await fs.promises.stat(absTarget)).size };
}

/**
 * Soft-delete (S7): файл переносится в tmp/trash/<ts>-<name>.
 * Подписанные URL на удалённый файл не выдаются/не работают (файла нет → 404).
 * Физическое удаление — purgeExpiredTrash() по retention.
 */
export async function removeFile(relPath: string): Promise<void> {
  const abs = absFromRel(relPath);
  const trashName = path.join(UPLOADS_DIR, 'tmp', 'trash', `${Date.now()}-${path.basename(abs)}`);
  await fs.promises.mkdir(path.dirname(trashName), { recursive: true });
  await fs.promises.rename(abs, trashName).catch(() => {}); // уже отсутствует — ок
}

// ─── Bootstrap и очистка ────────────────────────────────────────────────────

/**
 * Удалить просроченные файлы из tmp/trash/ (retention 30 дней, S7)
 * и сироты из tmp/ (оборванные загрузки, критерий 18(7)).
 * Возвращает число удалённых файлов.
 */
export async function purgeExpiredTrash(): Promise<number> {
  let removed = 0;
  const now = Date.now();

  const trashDir = path.join(UPLOADS_DIR, 'tmp', 'trash');
  try {
    for (const entry of await fs.promises.readdir(trashDir)) {
      const st = await fs.promises.stat(path.join(trashDir, entry)).catch(() => null);
      if (st && st.mtimeMs < now - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000) {
        await fs.promises.rm(path.join(trashDir, entry), { recursive: true, force: true });
        removed++;
      }
    }
  } catch { /* каталога ещё нет — ок */ }

  // Сироты в tmp/ (не trash): оборванные загрузки старше суток.
  // Активные upload'ы моложе суток не трогаем.
  const tmpDir = path.join(UPLOADS_DIR, 'tmp');
  try {
    for (const entry of await fs.promises.readdir(tmpDir)) {
      if (entry === 'trash') continue;
      const st = await fs.promises.stat(path.join(tmpDir, entry)).catch(() => null);
      if (st && st.mtimeMs < now - TMP_ORPHAN_MAX_AGE_MS) {
        await fs.promises.rm(path.join(tmpDir, entry), { recursive: true, force: true });
        removed++;
      }
    }
  } catch { /* каталога ещё нет — ок */ }

  return removed;
}

let purgeTimer: NodeJS.Timeout | null = null;

/**
 * Bootstrap при старте сервера (ТЗ-100 v11): создать каталоги uploads
 * (иначе healthcheck test -w из compose падает на чистом volume),
 * почистить сироты и просроченный trash, запустить ежесуточную очистку.
 */
export async function bootstrapStorage(): Promise<void> {
  if (STORAGE_DRIVER !== 'local') return;
  await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
  for (const dir of BOOTSTRAP_DIRS) {
    await fs.promises.mkdir(path.join(UPLOADS_DIR, dir), { recursive: true });
  }
  const removed = await purgeExpiredTrash();
  console.log(`[Storage] Local driver ready: ${UPLOADS_DIR} (driver=${STORAGE_DRIVER}, trash purged: ${removed})`);

  if (!purgeTimer) {
    purgeTimer = setInterval(() => {
      purgeExpiredTrash().catch((e: any) =>
        console.warn('[Storage] purge trash failed:', e?.message)
      );
    }, 24 * 60 * 60 * 1000);
    purgeTimer.unref();
  }
}

export default {
  putBuffer,
  putFile,
  removeFile,
  signedUrl,
  verifySignedUrl,
  isPublicKind,
  assertDiskSpace,
  bootstrapStorage,
  purgeExpiredTrash,
};
