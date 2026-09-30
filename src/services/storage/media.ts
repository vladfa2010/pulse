/**
 * =============================================================================
 * PULSE — Отдача файлов storage (ТЗ-100 v15, Задача 1а; v11 S8/S10)
 * =============================================================================
 *
 * Express-middleware, монтируется в index.ts: app.use('/media', mediaGuard).
 *
 * Правила доступа (ТЗ-100 v3 §1а «Правило доступа»):
 *   /media/courses/**   — обложки курсов, ПУБЛИЧНЫЕ, отдаются как есть.
 *   /media/materials/** — материалы курсов, ТОЛЬКО по signed URL
 *                         (выдаётся download-эндпоинтом после проверки доступа).
 *   /media/ugc/**       — UGC-файлы (ТЗ-102), только по signed URL.
 *   /media/tmp/**, /media/quarantine/** — НИКОГДА не отдаются.
 *
 * Заголовки безопасности (S8):
 *   X-Content-Type-Options: nosniff — всегда.
 *   Cache-Control: private, max-age=0 — для signed; публичные — max-age=1ч.
 *   HTML/SVG из загруженных не отдаются как документ — принудительно
 *   Content-Disposition: attachment (same-origin XSS-вектор, S10 закрыт заголовками).
 *
 * Любой отказ → 404 (не раскрываем существование/причину).
 */

import path from 'path';
import fs from 'fs';
import { Request, Response, NextFunction } from 'express';
import {
  UPLOADS_DIR,
  verifySignedUrl,
  isPublicKind,
} from './driver';

export function mediaGuard(req: Request, res: Response, _next: NextFunction): void {
  // req.path при монтировании на '/media' — уже без префикса: /courses/xxx.png
  const relPath = `/media${req.path}`;

  // Запрещённые подкаталоги — как будто файла нет
  const firstSeg = req.path.replace(/^\/+/, '').split('/')[0];
  if (firstSeg === 'tmp' || firstSeg === 'quarantine') {
    res.status(404).end();
    return;
  }

  // Защита от path traversal (defense-in-depth: absFromRel тоже проверяет)
  const abs = path.resolve(UPLOADS_DIR, relPath.replace(/^\/+/, '').replace(/^media\//, ''));
  if (abs !== path.resolve(UPLOADS_DIR) && !abs.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
    res.status(404).end();
    return;
  }

  // Подпись обязательна для НЕ-публичных подкаталогов
  if (!isPublicKind(relPath)) {
    const { expires, sig } = req.query as { expires?: string; sig?: string };
    if (!expires || !sig || !verifySignedUrl(relPath, expires, sig)) {
      res.status(404).end();
      return;
    }
  }

  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      res.status(404).end();
      return;
    }

    // S8: nosniff всегда; private-кэш для signed URL
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Cache-Control',
      isPublicKind(relPath) ? 'public, max-age=3600' : 'private, max-age=0'
    );

    // S8: HTML/SVG — только как вложение, никогда не как документ
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.html' || ext === '.htm' || ext === '.svg' || ext === '.xhtml') {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(abs)}"`);
    }

    // Content-Type по расширению; неизвестные — application/octet-stream
    // и принудительно attachment (не рендерим чужой контент как документ)
    const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
    if (mime === 'application/octet-stream') {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(abs)}"`);
    }

    res.sendFile(abs, (sendErr: any) => {
      if (sendErr && !res.headersSent) {
        res.status(404).end();
      }
    });
  });
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.epub': 'application/epub+zip',
};

export default mediaGuard;
