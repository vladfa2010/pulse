/**
 * GET /api/market/market-dialog (ТЗ-57 v2, public — ТЗ-64)
 *
 * Возвращает { segments: RadioSegment[] } — диалог host+guest по текущей
 * сводке рынка. Источник сводки — кэш globalSummary (Kimi, крон 6ч).
 * Диалог генерируется Minimax chat и кэшируется 6ч30м в in-memory Map.
 *
 * 204 No Content если: кэша крона нет / не задан MINIMAX_API_KEY или
 * MINIMAX_CHAT_MODEL / Minimax вернул ошибку.
 *
 * Фронт на 204 → fallback: speakCustom('Саммари рынка', marketCached.segments).
 *
 * ТЗ-64: optionalAuth — гость получает тот же диалог (кэш общий, один на всех).
 * Токен читается только из Authorization: Bearer или ?token= — куку НЕ читает.
 */
import { Router } from 'express';
import { optionalAuth } from '../middleware/optionalAuth';
import { getMarketDialog } from '../services/radioPodcast';

const router = Router();

router.get('/market-dialog', optionalAuth, async (_req, res) => {
  const segments = await getMarketDialog(); // никогда не бросает
  if (!segments) {
    res.status(204).end();
    return;
  }
  res.json({ segments });
});

export default router;
