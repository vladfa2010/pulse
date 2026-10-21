/**
 * =============================================================================
 * PULSE — MCP: монтирование /mcp (ТЗ-183, Задача 1)
 * =============================================================================
 *
 * Цепочка на запрос:
 *   1. Origin-валидация (браузерные клиенты): присутствующий невалидный Origin
 *      → 403; отсутствующий (не-браузерный клиент) — ок.
 *   2. Аутентификация токена (только Authorization: Bearer, ИБ-2). Неудача →
 *      mcpAuthLimiter (20 неудач / 15 мин на IP, ИБ-6) → 401 «Invalid token»
 *      (единый, без различения «нет/отозван/истёк»; blocked → 403).
 *   3. mcpLimiter — 120 запросов / 15 мин на токен (ключ — mcpTokenId).
 *   4. Счётчики: bumpRequestCount + throttled last_used_at; при первом
 *      использовании — email юзеру (ИБ-10).
 *   5. toWebRequest(req, req.body) → handler.fetch(...) → ответ проксируется.
 *
 * Тело распарсено локальным express.json({ limit: '1mb' }) (ТЗ-189) — первым
 * в цепочке, до auth: переполненный мусор отсекается дёшево, до проверок
 * токена. Глобальный 15-МБ парсер для /mcp отключён skip-функцией (иначе
 * двойной парсинг), общий apiLimiter — тоже skip (иначе двойной учёт).
 */

import express from 'express';
import type { Express, Request, Response } from 'express';
import { toWebRequest } from '@modelcontextprotocol/node';
import { tryAuthenticateMcpToken, MCP_AUTH_ERROR } from './context';
import { createMcpHttpHandler, mcpContextStorage } from './server';
import { bumpRequestCount, touchTokenUsed, markFirstUseNotified } from './counters';
import { sendMcpFirstUseEmail } from '../services/mcpEmails';
import { mcpLimiter, mcpAuthLimiter, checkRateLimit } from '../middleware/rateLimit';
import { recordMcpRequest, recordMcpAuthFail, recordMcpAuthLimited, recordMcpTokenLimited } from './securityStats'; // ТЗ-190: счётчики для базовой линии и алертинга
import { query } from '../config/db';

/** Допустимые Origin (браузерные клиенты). Порт не учитывается. */
const ALLOWED_ORIGIN_HOSTS = new Set([
  'pulse.inside-trade.ru',
  'localhost',
  '127.0.0.1',
  '[::1]',
]);

function originAllowed(req: Request): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // не-браузерный клиент — ок
  try {
    const host = new URL(origin).hostname;
    // Вложенные/приватные адреса не принимаем; только явный список
    return ALLOWED_ORIGIN_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** Первое использование токена: email с названием токена (fire-and-forget) */
async function notifyFirstUse(tokenId: string, userId: string): Promise<void> {
  try {
    const r = await query('SELECT name FROM mcp_tokens WHERE id = $1', [tokenId]);
    const name = r.rows[0]?.name || 'MCP-токен';
    const sent = await sendMcpFirstUseEmail(userId, name);
    if (sent) markFirstUseNotified(tokenId);
  } catch (e: any) {
    console.warn('[MCP] first-use notify failed:', e.message);
  }
}

export function mountMcp(app: Express): void {
  const handler = createMcpHttpHandler();

  // ТЗ-189: свой парсер с лимитом 1 МБ — первым, до auth (дешёвый 413 на
  // неаутентифицированный мусор; глобальный 15-МБ парсер для /mcp выключен
  // skip-функцией в src/index.ts, иначе двойной парсинг).
  app.use('/mcp', express.json({ limit: '1mb' }));

  app.use('/mcp', async (req: Request, res: Response) => {
    try {
      recordMcpRequest(req.ip); // ТЗ-190: общий счётчик + уникальные IP дня

      // 1. Origin
      if (!originAllowed(req)) {
        res.status(403).json({ error: 'Origin not allowed' });
        return;
      }

      // 2. Auth (+ mcpAuthLimiter на неудачу)
      const auth = await tryAuthenticateMcpToken(req, res);
      if (!auth.ok) {
        await checkRateLimit(req, res, mcpAuthLimiter); // true = лимит не исчерпан
        if (res.headersSent) {
          recordMcpAuthLimited(); // ТЗ-190: 429 анти-перебора
          return; // 429 ушёл из лимитера
        }
        if (auth.reason === 'blocked') {
          res.status(403).json({ error: 'Account blocked' });
        } else {
          recordMcpAuthFail(); // ТЗ-190: мусорный 401
          res.status(401).json(MCP_AUTH_ERROR);
        }
        return;
      }
      const ctx = auth.ctx;

      // 3. Лимитер на токен (клю�� — res.locals.mcpTokenId)
      const allowed = await checkRateLimit(req, res, mcpLimiter);
      if (!allowed) {
        recordMcpTokenLimited(); // ТЗ-190: 429 per-token
        return; // 429 ушёл
      }

      // 4. Счётчики / last_used_at / first-use email
      bumpRequestCount(ctx.tokenId);
      const { isFirstUse } = touchTokenUsed(ctx.tokenId);
      if (isFirstUse) notifyFirstUse(ctx.tokenId, ctx.userId).catch(() => {});

      // 5. MCP-обработка (контекст в фабрику — через ALS)
      const webReq = await toWebRequest(req, req.body);
      const response = await mcpContextStorage.run(ctx, () => handler.fetch(webReq));
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (e: any) {
      console.error('[MCP] request failed:', e.message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal error' });
      } else {
        res.end();
      }
    }
  });

  console.log('[MCP] /mcp mounted (streamable HTTP, token auth)');
}
