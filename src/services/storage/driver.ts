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

export type UploadKind = 'courses' | 'materials' | 'ugc' | 'content';

const UPLOAD_KINDS: UploadKind[] = ['courses', 'materials', 'ugc', 'content'];

// Публичные (без подписи) подкаталоги. Всё остальное — только по signed URL.
// 'content' (ТЗ-136): картинки конспекта/описания — путь зашит в text_content
// навсегда, подписать URL per-request невозможно → публичная отдача, как у
// обложек. Осознанный trade-off: картинка платного урока доступна по прямой
// ссылке любому (контент ценен текстом/тестом, картинки — иллюстрации).
const PUBLIC_KINDS: UploadKind[] = ['courses', 'content'];

const BOOTSTRAP_DIRS = ['courses', 'materials', 'ugc', 'content', 'tmp', 'tmp/trash', 'quarantine'];

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
 * (ТЗ-102 v2, S4) Записать UGC-файл сразу в карантин quarantine/ — до результата
 * сканирования clamd файл НЕ должен лежать в отдаваемом каталоге (mediaGuard
 * /media/quarantine/** не отдаёт никогда). Атомарность — как у putBuffer.
 * В БД путь /media/quarantine/<uuid>.<ext> — после чистого скана moveToKind()
 * переносит файл в целевой каталог и обновляет путь в БД.
 */
export async function putBufferQuarantine(
  buf: Buffer,
  originalName: string,
): Promise<PutResult> {
  if (STORAGE_DRIVER !== 'local') throw new StorageError(501, 'storage driver not implemented');
  await assertDiskSpace();

  const filename = safeFilename(originalName);
  const relPath = `/media/quarantine/${filename}`;
  const absTarget = absFromRel(relPath);
  const absTmp = path.join(UPLOADS_DIR, 'tmp', `${crypto.randomUUID()}.part`);

  try {
    await atomicWrite(absTmp, absTarget, buf);
  } catch (err) {
    await fs.promises.unlink(absTmp).catch(() => {});
    await fs.promises.unlink(absTarget).catch(() => {});
    throw err;
  }
  return { relPath, url: relPath, size: buf.length };
}

/**
 * (ТЗ-102 v2, S4/S11) Атомарно перенести файл между каталогами хранилища
 * (quarantine/ → ugc/ после чистого скана). rename внутри одного UPLOADS_DIR —
 * одна файловая система, атомарен. Возвращает новый относительный путь
 * (/media/<targetKind>/<имя>), который вызывающий код сохраняет в БД.
 */
export async function moveToKind(relPath: string, targetKind: UploadKind): Promise<PutResult> {
  if (STORAGE_DRIVER !== 'local') throw new StorageError(501, 'storage driver not implemented');
  const absSource = absFromRel(relPath);
  const relTarget = `/media/${targetKind}/${path.basename(absSource)}`;
  const absTarget = absFromRel(relTarget);
  await fs.promises.mkdir(path.dirname(absTarget), { recursive: true });
  await fs.promises.rename(absSource, absTarget);
  return { relPath: relTarget, url: relTarget, size: (await fs.promises.stat(absTarget)).size };
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
 *
 * ТЗ-199: рядом с файлом в trash пишется манифест `<trashName>.path` с
 * исходным relPath — без него restore невозможен (плоское имя теряет
 * каталог). Запись манифеста best-effort: ошибка манифеста не ломает
 * удаление (старые записи без манифеста показываем в корзине без restore).
 */
export async function removeFile(relPath: string): Promise<void> {
  const abs = absFromRel(relPath);
  const trashName = path.join(UPLOADS_DIR, 'tmp', 'trash', `${Date.now()}-${path.basename(abs)}`);
  await fs.promises.mkdir(path.dirname(trashName), { recursive: true });
  await fs.promises.rename(abs, trashName).catch(() => {}); // уже отсутствует — ок
  await fs.promises.writeFile(`${trashName}.path`, relPath).catch(() => {});
}

// ─── ТЗ-199: галерея файлов админки (листинг, корзина, restore/purge) ───────

export interface ListedFile {
  relPath: string; // /media/<kind>/<…>
  size: number;
  mtime: Date;
}

export interface TrashEntry {
  trashName: string;            // имя файла в tmp/trash (стабильный идентификатор)
  originalRelPath: string | null; // из манифеста <trashName>.path; null у записей до ТЗ-199
  size: number;
  mtime: Date;
  deletedAt: Date | null;       // префикс <ts>- в имени trash-файла
  expiresAt: Date | null;       // deletedAt + TRASH_RETENTION_DAYS
}

/**
 * Нормализовать и проверить пользовательский путь из API (ТЗ-199, критерий 7):
 * обязателен префикс /media/, запрет '..', kind — из разрешённого набора
 * (patтерн absFromRel выше). Возвращает канонический relPath или StorageError 400.
 */
export function normalizeMediaPath(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw || raw.includes('\0')) throw new StorageError(400, 'invalid path');
  const norm = path.posix.normalize(raw);
  if (!norm.startsWith('/media/')) throw new StorageError(400, 'invalid path');
  const segments = norm.split('/').filter(Boolean);
  if (segments.some((s) => s === '..')) throw new StorageError(400, 'invalid path');
  if (!UPLOAD_KINDS.includes(segments[1] as UploadKind)) {
    throw new StorageError(400, 'invalid path');
  }
  return norm;
}

/**
 * Проверить имя trash-записи (restore/purge из API): только плоское имя
 * файла из tmp/trash — без разделителей и '..'.
 */
export function sanitizeTrashName(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw.endsWith('.path')) {
    throw new StorageError(400, 'invalid trash name');
  }
  return raw;
}

/** Рекурсивный обход каталога kind: /media/<kind>/<sub…> → relPath. */
async function walkKind(kind: UploadKind, dir: string, prefix: string, out: ListedFile[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // каталога нет — ок
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walkKind(kind, abs, `${prefix}${e.name}/`, out);
      continue;
    }
    if (!e.isFile()) continue;
    const st = await fs.promises.stat(abs).catch(() => null);
    if (!st) continue;
    out.push({ relPath: `/media/${kind}/${prefix}${e.name}`, size: st.size, mtime: st.mtime });
  }
}

/**
 * ТЗ-199 Задача 1: листинг файлов хранилища. kind отсутствует → все четыре
 * каталога. Сортировка по relPath — детерминированная пагинация в API.
 */
export async function listFiles(kind?: UploadKind): Promise<ListedFile[]> {
  if (STORAGE_DRIVER !== 'local') throw new StorageError(501, 'storage driver not implemented');
  const kinds = kind ? [kind] : UPLOAD_KINDS;
  const out: ListedFile[] = [];
  for (const k of kinds) {
    await walkKind(k, path.join(UPLOADS_DIR, k), '', out);
  }
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

/**
 * ТЗ-199 Задача 1/3: содержимое tmp/trash. Для каждого файла читается
 * манифест `<trashName>.path` (исходный relPath). Сами манифесты в выдачу
 * не попадают; записи без манифеста (до ТЗ-199) — с originalRelPath=null.
 */
export async function listTrash(): Promise<TrashEntry[]> {
  if (STORAGE_DRIVER !== 'local') throw new StorageError(501, 'storage driver not implemented');
  const trashDir = path.join(UPLOADS_DIR, 'tmp', 'trash');
  let names: string[] = [];
  try {
    names = await fs.promises.readdir(trashDir);
  } catch {
    return [];
  }
  const out: TrashEntry[] = [];
  for (const name of names) {
    if (name.endsWith('.path')) continue; // манифесты — служебные
    const abs = path.join(trashDir, name);
    const st = await fs.promises.stat(abs).catch(() => null);
    if (!st || !st.isFile()) continue;
    const manifest = await fs.promises.readFile(`${abs}.path`, 'utf8').catch(() => null);
    const tsPrefix = /^(\d{10,})-/.exec(name);
    const deletedAt = tsPrefix ? new Date(Number(tsPrefix[1])) : null;
    out.push({
      trashName: name,
      originalRelPath: manifest !== null ? manifest.trim() : null,
      size: st.size,
      mtime: st.mtime,
      deletedAt,
      expiresAt: deletedAt
        ? new Date(deletedAt.getTime() + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000)
        : null,
    });
  }
  out.sort((a, b) => (a.trashName < b.trashName ? -1 : a.trashName > b.trashName ? 1 : 0));
  return out;
}

/**
 * ТЗ-199: вернуть файл из trash на исходный relPath (из манифеста).
 * Нет манифеста → 400 (запись до ТЗ-199, путь не восстановим);
 * по исходному пути уже есть файл → 409. Восстанавливает файл, НЕ запись БД.
 */
export async function restoreFile(trashName: string): Promise<{ relPath: string }> {
  if (STORAGE_DRIVER !== 'local') throw new StorageError(501, 'storage driver not implemented');
  const name = sanitizeTrashName(trashName);
  const trashAbs = path.join(UPLOADS_DIR, 'tmp', 'trash', name);
  const manifest = await fs.promises.readFile(`${trashAbs}.path`, 'utf8').catch(() => null);
  if (manifest === null) {
    throw new StorageError(400, 'У записи нет манифеста исходного пути (trash до ТЗ-199) — восстановление невозможно');
  }
  const relPath = normalizeMediaPath(manifest.trim());
  const targetAbs = absFromRel(relPath);
  if (fs.existsSync(targetAbs)) {
    throw new StorageError(409, `Путь занят: по адресу ${relPath} уже есть файл`);
  }
  await fs.promises.mkdir(path.dirname(targetAbs), { recursive: true });
  await fs.promises.rename(trashAbs, targetAbs);
  await fs.promises.unlink(`${trashAbs}.path`).catch(() => {});
  return { relPath };
}

/**
 * ТЗ-199: удалить trash-запись навсегда (файл + его манифест). Confirm-only
 * на фронте; здесь — чистая fs-операция, отсутствующие файлы не ошибка.
 */
export async function purgeTrashFile(trashName: string): Promise<void> {
  if (STORAGE_DRIVER !== 'local') throw new StorageError(501, 'storage driver not implemented');
  const name = sanitizeTrashName(trashName);
  const trashAbs = path.join(UPLOADS_DIR, 'tmp', 'trash', name);
  await fs.promises.unlink(trashAbs).catch(() => {});
  await fs.promises.unlink(`${trashAbs}.path`).catch(() => {});
}

/**
 * ТЗ-199: прочитать файл хранилища по relPath — для админского скачивания
 * приватных kind (materials/ugc отдаёт mediaGuard только по signed URL).
 * Путь проходит normalizeMediaPath (префикс /media/, без '..'). 404, если
 * файла нет.
 */
export async function readFileBuffer(relPath: string): Promise<Buffer> {
  if (STORAGE_DRIVER !== 'local') throw new StorageError(501, 'storage driver not implemented');
  const abs = absFromRel(normalizeMediaPath(relPath));
  try {
    return await fs.promises.readFile(abs);
  } catch {
    throw new StorageError(404, 'Файл не найден в хранилище');
  }
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
  putBufferQuarantine,
  moveToKind,
  removeFile,
  listFiles,
  listTrash,
  restoreFile,
  purgeTrashFile,
  readFileBuffer,
  normalizeMediaPath,
  sanitizeTrashName,
  signedUrl,
  verifySignedUrl,
  isPublicKind,
  assertDiskSpace,
  bootstrapStorage,
  purgeExpiredTrash,
};
