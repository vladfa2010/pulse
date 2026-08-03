/**
 * PULSE — Portfolio API (broker-linked portfolios)
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import * as service from '../services/brokerPortfolioService';
import { logPortfolioCreated } from '../services/activityLog';

const router = Router();

function isValidBroker(broker: any): broker is 'inside' | 'finam' | 'bcs' {
  return typeof broker === 'string' && ['inside', 'finam', 'bcs'].includes(broker);
}

function isValidMode(mode: any): mode is 'by-broker' | 'consolidated' {
  return mode === 'by-broker' || mode === 'consolidated';
}

router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const portfolios = await service.listBrokerPortfolios(req.user!.userId);
    res.json({ portfolios });
  } catch (err: any) {
    console.error('[PortfolioAPI] GET list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch portfolios' });
  }
});

router.post('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { broker, name, brokerKeyId } = req.body;
    if (!isValidBroker(broker)) {
      return res.status(400).json({ error: 'Invalid broker' });
    }
    if (!brokerKeyId || typeof brokerKeyId !== 'string') {
      return res.status(400).json({ error: 'brokerKeyId is required' });
    }

    const portfolio = await service.createBrokerPortfolio(req.user!.userId, { broker, name, brokerKeyId });

    logPortfolioCreated(req.user!.userId, broker, name || portfolio.name, portfolio.id).catch(() => {});

    res.status(201).json({ portfolio });
  } catch (err: any) {
    console.error('[PortfolioAPI] POST create error:', err.message);
    if (err.code === 'broker_key_invalid' || err.message === 'broker_key_invalid') {
      return res.status(400).json({ error: 'broker_key_invalid' });
    }
    if (err.code === 'not_found' || err.message === 'Not found') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Portfolio for this broker already exists' });
    }
    res.status(500).json({ error: 'Failed to create portfolio' });
  }
});

router.patch('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { name, brokerKeyId } = req.body;
    const portfolio = await service.updateBrokerPortfolio(req.user!.userId, req.params.id, { name, brokerKeyId });
    res.json({ portfolio });
  } catch (err: any) {
    console.error('[PortfolioAPI] PATCH error:', err.message);
    if (err.code === 'not_found' || err.message === 'Not found') {
      return res.status(404).json({ error: 'Not found' });
    }
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Portfolio name already exists' });
    }
    res.status(500).json({ error: 'Failed to update portfolio' });
  }
});

router.delete('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    await service.deleteBrokerPortfolio(req.user!.userId, req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[PortfolioAPI] DELETE error:', err.message);
    if (err.code === 'not_found' || err.message === 'Not found') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(500).json({ error: 'Failed to delete portfolio' });
  }
});

router.get('/:id/positions', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const positions = await service.getBrokerPortfolioPositions(req.user!.userId, req.params.id);
    res.json({ positions });
  } catch (err: any) {
    console.error('[PortfolioAPI] GET positions error:', err.message);
    if (err.code === 'not_found' || err.message === 'Not found') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

router.post('/:id/sync', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const result = await service.syncBrokerPortfolio(req.user!.userId, req.params.id);
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('[PortfolioAPI] POST sync error:', err.message);
    if (err.message === 'broker_key_invalid') {
      return res.status(400).json({ error: 'broker_key_invalid' });
    }
    if (err.message === 'broker_unavailable' || err.message === 'broker_timeout') {
      return res.status(502).json({ error: err.message });
    }
    if (err.code === 'not_found' || err.message === 'Not found' || err.message === 'Portfolio has no linked broker key') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(500).json({ error: 'Failed to sync portfolio' });
  }
});

router.get('/summary', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const mode = isValidMode(req.query.mode) ? req.query.mode : 'by-broker';
    const summary = await service.getPortfolioSummary(req.user!.userId, mode);
    res.json(summary);
  } catch (err: any) {
    console.error('[PortfolioAPI] GET summary error:', err.message);
    res.status(500).json({ error: 'Failed to fetch portfolio summary' });
  }
});

router.get('/recommended-tags', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const result = await service.getRecommendedTags(req.user!.userId);
    res.json(result);
  } catch (err: any) {
    console.error('[PortfolioAPI] GET recommended tags error:', err.message);
    res.status(500).json({ error: 'Failed to fetch recommended tags' });
  }
});

router.post('/recommended-tags/subscribe', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { ticker, exchange } = req.body;
    if (!ticker || typeof ticker !== 'string') {
      return res.status(400).json({ error: 'ticker is required' });
    }
    const result = await service.subscribeFromRecommendedTag(
      req.user!.userId,
      ticker,
      exchange || 'MOEX'
    );
    if (!result.success) {
      return res.status(400).json({ error: result.error || 'Failed to subscribe', status: result.status });
    }
    const updated = await service.getRecommendedTags(req.user!.userId);
    res.json({ success: true, ...updated });
  } catch (err: any) {
    console.error('[PortfolioAPI] POST subscribe tag error:', err.message);
    res.status(500).json({ error: 'Failed to subscribe to tag' });
  }
});

export default router;
