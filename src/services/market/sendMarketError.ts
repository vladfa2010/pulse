/**
 * Unified Finam/market error response helper.
 * Shared between admin market routes and public/news routes to avoid
 * a circular dependency between routes/market.ts and routes/newsHeatmap.ts.
 */

import type { Response } from 'express';

export function sendMarketError(res: Response, err: any): void {
  const byCode: Record<string, { status: number; text: string }> = {
    finam_no_key: { status: 503, text: 'Маркет-данные не настроены на сервере (нет ключа)' },
    finam_auth_failed: { status: 503, text: 'Ошибка авторизации в источнике данных' },
    finam_rate_limited: { status: 503, text: 'Превышен лимит запросов к источнику, попробуйте позже' },
    finam_maintenance: { status: 503, text: 'Источник данных на техобслуживании (05:00–06:15 МСК)' },
    finam_not_found: { status: 404, text: err?.message || 'Инструмент не найден' },
    finam_bad_exchange: { status: 400, text: err?.message || 'Биржа не поддерживается' },
  };

  if (err?.message?.includes('not found')) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err?.message?.includes('not supported')) {
    res.status(400).json({ error: err.message });
    return;
  }

  const m = err?.code ? byCode[err.code] : undefined;
  if (m) {
    res.status(m.status).json({ error: m.text, code: err.code });
    return;
  }

  res.status(502).json({ error: err?.message || 'Failed to fetch market data' });
}
