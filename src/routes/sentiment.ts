/**
 * =============================================================================
 * PULSE — Sentiment Index Routes
 * =============================================================================
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { VoteSchema } from '../schemas/sentiment';
import {
  getCurrentIndex,
  getIndexHistory,
  getUserWindow,
  canVote,
  secondsUntilNextVote,
  recordVote,
  getCommunityMetrics,
  getImoexData,
  getUserVoteHistory,
} from '../services/sentimentIndex';
import { broadcastSentimentUpdate } from '../services/sse';

const router = Router();

/**
 * GET /api/sentiment/index
 * Публичный индекс + история для графика + IMOEX.
 */
router.get('/index', async (req, res) => {
  try {
    const now = new Date();
    const [currentValue, history, imoex] = await Promise.all([
      getCurrentIndex(now),
      getIndexHistory(now),
      getImoexData(now),
    ]);

    res.json({
      currentValue,
      history,
      imoex,
      updatedAt: now.toISOString(),
    });
  } catch (err: any) {
    console.error('[Sentiment] index error:', err.message);
    res.status(500).json({ error: 'Failed to fetch sentiment index' });
  }
});

/**
 * GET /api/sentiment/status
 * Персональный статус + метрики + история.
 */
router.get('/status', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const now = new Date();
    const [windowRow, currentValue, community, history] = await Promise.all([
      getUserWindow(userId),
      getCurrentIndex(now),
      getCommunityMetrics(),
      getUserVoteHistory(userId, 20),
    ]);

    const state = !canVote(windowRow) ? 'active' : 'voting';

    res.json({
      state,
      secondsUntilNextVote: secondsUntilNextVote(windowRow),
      currentValue,
      personal: {
        totalVotes: windowRow.total_votes_all_time || 0,
        todayVotes: windowRow.vote_count_today || 0,
        syncRate:
          windowRow.total_votes_count > 0
            ? Math.round((windowRow.sync_count / windowRow.total_votes_count) * 100)
            : 0,
        streakDays: windowRow.streak_days || 0,
        impactSum: windowRow.impact_sum || 0,
      },
      community,
      history,
    });
  } catch (err: any) {
    console.error('[Sentiment] status error:', err.message);
    res.status(500).json({ error: 'Failed to fetch sentiment status' });
  }
});

/**
 * POST /api/sentiment/vote
 */
router.post('/vote', authMiddleware, validate(VoteSchema), async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.userId;
    const { value } = req.body;

    const result = await recordVote(userId, value);

    // Оповестить всех клиентов о новом индексе
    broadcastSentimentUpdate({
      currentValue: result.newIndex,
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      success: true,
      newIndex: result.newIndex,
      nextVoteAt: result.nextVoteAt.toISOString(),
      secondsUntilNext: result.secondsUntilNext,
      sync: result.sync,
    });
  } catch (err: any) {
    console.error('[Sentiment] vote error:', err.message);
    if (err.message === 'Vote cooldown') {
      return res.status(429).json({ error: 'Too soon. Wait for your personal window.' });
    }
    if (err.message === 'Invalid vote value') {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

export default router;
