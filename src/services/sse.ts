/**
 * =============================================================================
 * PULSE — SSE (Server-Sent Events) Real-Time News Stream
 * =============================================================================
 *
 * SSE broadcasts new articles to all connected browsers instantly.
 * When cron saves a new article → broadcast to all SSE subscribers.
 *
 * Why SSE (not WebSocket):
 *   - One-directional: server → browser (perfect for news push)
 *   - Works over HTTP (no protocol upgrade)
 *   - Auto-reconnect built into browser
 *   - Simpler than WebSocket (no socket management)
 */

import { Response } from 'express';

// Active SSE subscribers
const subscribers: Set<Response> = new Set();

/**
 * Register a new SSE subscriber
 */
export function addSubscriber(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  // Send initial heartbeat
  res.write('event: connected\n');
  res.write(`data: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`);

  subscribers.add(res);
  console.log(`[SSE] Subscriber added. Total: ${subscribers.size}`);

  // Remove on disconnect
  res.on('close', () => {
    subscribers.delete(res);
    console.log(`[SSE] Subscriber disconnected. Total: ${subscribers.size}`);
  });

  // Heartbeat to keep connection alive (every 30s)
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write('event: ping\n');
    res.write('data: {}\n\n');
  }, 30000);

  res.on('close', () => clearInterval(heartbeat));
}

/**
 * Broadcast new article to all connected subscribers
 */
export function broadcastNews(article: any): void {
  if (subscribers.size === 0) return;

  const payload = JSON.stringify({
    id: article.id,
    title_ru: article.title_ru,
    summary_ru: article.summary_ru,
    source: article.source,
    published_at: article.published_at,
    sentiment: article.sentiment,
    matched_tags: article.matched_tags || [],
    url: article.url,
  });

  const message = `event: news\ndata: ${payload}\n\n`;

  let sent = 0;
  for (const res of subscribers) {
    if (!res.writableEnded) {
      res.write(message);
      sent++;
    }
  }

  if (sent > 0) {
    console.log(`[SSE] Broadcasted article to ${sent} subscriber(s): ${article.title_ru?.slice(0, 50)}`);
  }
}

/**
 * Broadcast a refresh signal — tells all clients to refetch their news lists.
 * Used when the NewsSourceManager finishes a cycle and new articles were saved.
 */
export function broadcastRefresh(): void {
  if (subscribers.size === 0) return;

  const message = `event: refresh\ndata: ${JSON.stringify({ time: new Date().toISOString() })}\n\n`;

  let sent = 0;
  for (const res of subscribers) {
    if (!res.writableEnded) {
      res.write(message);
      sent++;
    }
  }

  if (sent > 0) {
    console.log(`[SSE] Broadcasted refresh signal to ${sent} subscriber(s)`);
  }
}

/**
 * Get current subscriber count (for health/debug)
 */
export function getSubscriberCount(): number {
  return subscribers.size;
}
