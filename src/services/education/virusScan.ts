/**
 * =============================================================================
 * PULSE — LMS: антивирусный контур UGC-файлов (ТЗ-102 v2, S4; ClamAV/clamd)
 * =============================================================================
 *
 * Поток: user-файл атомарно пишется в quarantine/ с scan_status='pending_scan'
 * (education.ts), далее этот модуль отправляет содержимое в clamd по unix-сокету
 * (протокол INSTREAM, нативный клиент на stdlib net/fs — без npm-зависимостей):
 *   clean    → атомарный rename quarantine/ → ugc/ (driver.moveToKind),
 *              scan_status='clean', путь в БД обновлён;
 *   infected → файл остаётся в quarantine/ навсегда, предложение → 'rejected'
 *              с системной причиной, в лог `AV infected {…}`;
 *   clamd недоступен (нет сокета/таймаут) → файл остаётся 'pending_scan',
 *              загрузка уже ответила 201 «на проверке».
 *
 * Стратегия retry (зафиксовано, ТЗ-102 §2): комбинированная —
 *   1) enqueueScan() сразу после загрузки (fire-and-forget);
 *   2) фоновый sweeper (startVirusScanSweeper, раз в минуту) пересканирует ВСЕ
 *      pending_scan-файлы — покрывает недоступность clamd на момент загрузки;
 *   3) GET /moderation (adminEducation) дополнительно ставит pending_scan-записи
 *      в очередь — модератор всегда видит актуальный статус.
 * Скачивание файла с scan_status != 'clean' заблокировано для всех (423 Locked)
 * в download-эндпоинте education.ts — очередь модерации не вектор заражения.
 *
 * Env: CLAMAV_SOCKET (default /run/clamav/clamd.sock), CLAMAV_TIMEOUT_MS
 * (default 10000 — деградация по ТЗ), CLAMAV_SWEEP_INTERVAL_MS (default 60000),
 * CLAMAV_STALE_MS — возраст pending_scan, после которого админке показывается
 * флаг «антивирус недоступен» (default 10 минут, вычисляется в adminEducation).
 */

import net from 'net';
import fs from 'fs';
import path from 'path';

import { query } from '../../config/db';
import { moveToKind, UPLOADS_DIR } from '../storage/driver';

const CLAMAV_SOCKET: string = process.env.CLAMAV_SOCKET || '/run/clamav/clamd.sock';
const CLAMAV_TIMEOUT_MS: number = parseInt(process.env.CLAMAV_TIMEOUT_MS || '10000', 10);
const CLAMAV_SWEEP_INTERVAL_MS: number = parseInt(process.env.CLAMAV_SWEEP_INTERVAL_MS || '60000', 10);

/** Системная причина отказа для infected-файлов (видна ученику в my/submissions). */
export const AV_REJECT_REASON = 'файл не прошёл проверку безопасности';

// ─── clamd-протокол: INSTREAM по unix-сокету ────────────────────────────────

export interface ScanResult {
  ok: boolean;        // false — clamd недоступен/ошибка протокола
  infected: boolean;
  signature?: string; // имя сигнатуры для FOUND
}

/**
 * Отправить буфер в clamd командой INSTREAM: «zINSTREAM\0», затем блоки
 * <4-byte big-endian length><data>, завершение — нулевой блок. Ответ clamd —
 * строка вида «stream: OK» или «stream: <Signature> FOUND».
 * Любая ошибка сокета/таймаута → { ok: false } (вызывающий решает по retry).
 */
export async function scanBuffer(buf: Buffer): Promise<ScanResult> {
  return new Promise<ScanResult>((resolve) => {
    const socket = net.createConnection({ path: CLAMAV_SOCKET });
    let settled = false;
    let response = Buffer.alloc(0);

    const finish = (result: ScanResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    const onError = () => finish({ ok: false, infected: false });

    socket.setTimeout(CLAMAV_TIMEOUT_MS, () => {
      socket.destroy();
      onError();
    });
    socket.once('error', onError);

    socket.once('connect', () => {
      try {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let off = 0; off < buf.length; off += CHUNK) {
          const piece = buf.subarray(off, Math.min(off + CHUNK, buf.length));
          const header = Buffer.alloc(4);
          header.writeUInt32BE(piece.length, 0);
          socket.write(Buffer.concat([header, piece]));
        }
        socket.write(Buffer.alloc(4)); // завершающий нулевой блок
      } catch {
        onError();
      }
    });

    socket.on('data', (data) => {
      response = Buffer.concat([response, data]);
      const text = response.toString('utf-8');
      if (!text.includes('\n')) return;
      const line = text.trim();
      if (/: OK$/.test(line)) {
        finish({ ok: true, infected: false });
      } else {
        const m = line.match(/:\s*(.+?)\s+FOUND$/);
        finish({ ok: true, infected: true, signature: m ? m[1] : 'unknown' });
      }
    });

    socket.once('close', () => {
      // Ответ без завершающего '\n' — трактуем по содержимому, если есть
      if (settled) return;
      const text = response.toString('utf-8').trim();
      if (/: OK$/.test(text)) finish({ ok: true, infected: false });
      else if (/ FOUND$/.test(text)) {
        const m = text.match(/:\s*(.+?)\s+FOUND$/);
        finish({ ok: true, infected: true, signature: m ? m[1] : 'unknown' });
      } else {
        onError();
      }
    });
  });
}

// ─── Воркер: сканирование материала по записи БД ────────────────────────────

const inFlight = new Set<string>();

/**
 * Отсканировать файл материала и применить результат к записи БД.
 * idempotent: защита от параллельных прогонов (inFlight) — sweeper и
 * модераторский enqueue могут пересечься.
 */
export async function scanMaterial(materialId: string): Promise<void> {
  if (inFlight.has(materialId)) return;
  inFlight.add(materialId);
  try {
    const r = await query(
      `SELECT id, url, submitted_by, scan_status, status FROM course_materials WHERE id = $1`,
      [materialId],
    );
    if (r.rows.length === 0) return;
    const m = r.rows[0];
    if (m.scan_status !== 'pending_scan') return; // уже обработан другим прогоном

    // url вида /media/quarantine/<name> → абсолютный путь внутри UPLOADS_DIR
    const absPath = path.join(UPLOADS_DIR, String(m.url || '').replace(/^\/media\//, ''));
    let buf: Buffer;
    try {
      buf = await fs.promises.readFile(absPath);
    } catch {
      // Файл потерян (не должно случаться: запись в БД — после put) — оставляем
      // pending_scan; sweeper повторит, файл появится из бэкапа или запись снимут.
      return;
    }

    const result = await scanBuffer(buf);
    if (!result.ok) {
      // clamd недоступен (нет сокета/таймаут): файл остаётся в карантине,
      // статус 'pending_scan' сохраняется; sweeper/модераторский retry догонят.
      return;
    }

    if (result.infected) {
      // Файл НАВСЕГДА остаётся в quarantine/ (не отдаётся mediaGuard). Отказ —
      // системный: reviewed_by не проставляем (решение не модераторское).
      await query(
        `UPDATE course_materials
           SET status = 'rejected', reject_reason = $1, reviewed_at = ${nowSql()}
         WHERE id = $2`,
        [AV_REJECT_REASON, materialId],
      );
      console.warn(`AV infected { userId: ${m.submitted_by}, file: ${m.url}, signature: ${result.signature} }`);
      return;
    }

    // clean: атомарный rename quarantine/ → ugc/ + обновление пути в БД.
    // Сначала переносим файл, потом пишем БД — при падении между шагами файл
    // в ugc/ с путём quarantine/ в БД: скачивание всё равно закрыто статусом,
    // sweeper по pending_scan перенесёт/обновит повторно (moveToKind идемпотентен
    // по смыслу: источника нет → rename бросит, обработчик молча выйдёт).
    try {
      const moved = await moveToKind(String(m.url), 'ugc');
      await query(`UPDATE course_materials SET url = $1, scan_status = 'clean' WHERE id = $2`, [moved.relPath, materialId]);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return; // файл уже перенесён — sweeper догонит
      throw err;
    }
  } finally {
    inFlight.delete(materialId);
  }
}

/** Поставить материал в очередь сканирования (fire-and-forget). */
export function enqueueScan(materialId: string): void {
  scanMaterial(materialId).catch((err: any) =>
    console.warn('[VirusScan] scanMaterial failed:', err?.message || err));
}

let sweeperTimer: NodeJS.Timeout | null = null;

/**
 * Фоновый sweeper: раз в минуту пересканирует все pending_scan-материалы.
 * Покрывает деградацию «clamd лежал в момент загрузки» (ТЗ-102 §2): юзеру
 * ответили 201 «на проверке», как только clamd поднялся — файлы дочистятся.
 */
export function startVirusScanSweeper(): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    query(
      `SELECT id FROM course_materials WHERE scan_status = 'pending_scan' AND status = 'pending'`,
      [],
    )
      .then((r) => {
        for (const row of r.rows) enqueueScan(row.id);
      })
      .catch((err: any) => console.warn('[VirusScan] sweeper query failed:', err?.message));
  }, CLAMAV_SWEEP_INTERVAL_MS);
  sweeperTimer.unref();
  console.log(`[VirusScan] sweeper started (socket=${CLAMAV_SOCKET}, every ${CLAMAV_SWEEP_INTERVAL_MS}ms)`);
}

function nowSql(): string {
  return process.env.USE_SQLITE === 'true' ? "datetime('now')" : 'NOW()';
}

export default { scanBuffer, scanMaterial, enqueueScan, startVirusScanSweeper, AV_REJECT_REASON };
