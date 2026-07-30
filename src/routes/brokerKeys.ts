/**
 * PULSE — Broker keys API (ЛК → вкладка «Брокеры»)
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { brokerKeyLimiter } from '../middleware/rateLimit';
import * as service from '../services/brokerKeyService';

const router = Router();

function isValidBroker(broker: any): broker is 'inside' | 'finam' | 'bcs' {
  return typeof broker === 'string' && ['inside', 'finam', 'bcs'].includes(broker);
}

router.get('/', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const keys = await service.listBrokerKeys(req.user!.userId);
    res.json({
      keys: keys.map(k => ({
        id: k.id,
        broker: k.broker,
        label: k.label,
        tail: k.token_tail,
        status: k.status,
        lastError: k.last_error,
        lastSyncedAt: k.last_synced_at,
        portfolioName: (k as any).portfolio_name || null,
      })),
    });
  } catch (err: any) {
    console.error('[BrokerKeysAPI] GET list error:', err.message);
    res.status(500).json({ error: 'Failed to fetch broker keys' });
  }
});

router.post('/', authMiddleware, brokerKeyLimiter, async (req: AuthRequest, res) => {
  try {
    const { broker, label, token } = req.body;
    if (!isValidBroker(broker)) {
      return res.status(400).json({ error: 'Invalid broker' });
    }
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'Token is required' });
    }

    const key = await service.createBrokerKey(req.user!.userId, { broker, label: label || '', token });
    res.status(201).json({
      id: key.id,
      broker: key.broker,
      label: key.label,
      tail: key.token_tail,
      status: key.status,
      lastSyncedAt: key.last_synced_at,
    });
  } catch (err: any) {
    console.error('[BrokerKeysAPI] POST create error:', err.message);
    if (err.code === 'broker_key_invalid' || err.message === 'broker_key_invalid') {
      return res.status(400).json({ error: 'broker_key_invalid' });
    }
    if (err.code === 'not_found') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(500).json({ error: 'Failed to create broker key' });
  }
});

router.patch('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { label, token } = req.body;
    const key = await service.updateBrokerKey(req.user!.userId, req.params.id, { label, token });
    res.json({
      id: key.id,
      broker: key.broker,
      label: key.label,
      tail: key.token_tail,
      status: key.status,
      lastError: key.last_error,
      lastSyncedAt: key.last_synced_at,
    });
  } catch (err: any) {
    console.error('[BrokerKeysAPI] PATCH error:', err.message);
    if (err.code === 'broker_key_invalid' || err.message === 'broker_key_invalid') {
      return res.status(400).json({ error: 'broker_key_invalid' });
    }
    if (err.code === 'not_found') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(500).json({ error: 'Failed to update broker key' });
  }
});

router.delete('/:id', authMiddleware, async (req: AuthRequest, res) => {
  try {
    await service.deleteBrokerKey(req.user!.userId, req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[BrokerKeysAPI] DELETE error:', err.message);
    if (err.code === 'not_found') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(500).json({ error: 'Failed to delete broker key' });
  }
});

router.post('/:id/test', authMiddleware, brokerKeyLimiter, async (req: AuthRequest, res) => {
  try {
    const result = await service.testBrokerKey(req.user!.userId, req.params.id);
    if (result.ok) {
      res.json({ ok: true, positionsCount: result.positionsCount });
    } else {
      res.status(502).json({ ok: false, error: result.error || 'broker_key_invalid' });
    }
  } catch (err: any) {
    console.error('[BrokerKeysAPI] POST test error:', err.message);
    if (err.code === 'not_found') {
      return res.status(404).json({ error: 'Not found' });
    }
    res.status(500).json({ error: 'Failed to test broker key' });
  }
});

export default router;
