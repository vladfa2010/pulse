/**
 * =============================================================================
 * PULSE — MCP: счётчики использования токенов (ТЗ-183 Задача 5 / ТЗ-185 Задача 1)
 * =============================================================================
 *
 * requests_count: in-memory счётчик + flush раз в минуту одним UPDATE на токен
 * (паттерн presence в middleware/auth.ts). Не инкрементировать синхронно на
 * каждый запрос — лишняя запись на каждый вызов MCP не нужна.
 *
 * last_used_at: throttled обновление, не чаще раза в час на токен. При первом
 * использовании нового токена — email-уведомление юзеру (ИБ-10, детектор
 * компрометации) — колбэк onFirstUse вызывает сервис уведомлений.
 */

import { query } from '../config/db';

const USE_SQLITE = process.env.USE_SQLITE === 'true';
const FLUSH_INTERVAL_MS = 60 * 1000;
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000;

const counters = new Map<string, number>();
const lastUsedWritten = new Map<string, number>();
/** Токены, по которым уже уходил «первый» email (в пределах жизни процесса) */
const firstUseNotified = new Set<string>();

export function bumpRequestCount(tokenId: string): void {
  counters.set(tokenId, (counters.get(tokenId) || 0) + 1);
}

/** Вызывается на каждом валидном MCP-запросе; fire-and-forget */
export function touchTokenUsed(tokenId: string): { isFirstUse: boolean } {
  const now = Date.now();
  const last = lastUsedWritten.get(tokenId) || 0;
  const isFirstUse = !firstUseNotified.has(tokenId);
  if (now - last >= LAST_USED_THROTTLE_MS) {
    lastUsedWritten.set(tokenId, now);
    const p = query(
      `UPDATE mcp_tokens SET last_used_at = ${USE_SQLITE ? "datetime('now')" : 'NOW()'} WHERE id = $1`,
      [tokenId],
    );
    Promise.resolve(p).catch((e: any) => console.warn('[MCP] last_used_at write failed:', e.message));
  }
  if (isFirstUse) firstUseNotified.add(tokenId);
  return { isFirstUse };
}

export function markFirstUseNotified(tokenId: string): void {
  firstUseNotified.add(tokenId);
}

/** Одним UPDATE на токен — сбрасывает накопленное. Возвращает снапшот для flush. */
function drainCounters(): Map<string, number> {
  const snap = new Map(counters);
  counters.clear();
  return snap;
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

export function startMcpCounterFlush(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    const snap = drainCounters();
    for (const [tokenId, n] of snap) {
      if (n <= 0) continue;
      query('UPDATE mcp_tokens SET requests_count = requests_count + $2 WHERE id = $1', [tokenId, n]).catch(
        (e: any) => {
          console.warn('[MCP] requests_count flush failed:', e.message);
          bumpRequestCount(tokenId); // вернём в очередь, чтобы не потерять
        },
      );
    }
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
  console.log('[MCP] counter flush scheduled (every 60s)');
}

export function stopMcpCounterFlush(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}
