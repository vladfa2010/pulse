import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { translateBatch } from '../services/translate';

const router = Router();

// POST /api/translate — translate EN → RU
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { texts } = req.body;

    if (!Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ error: 'texts array required' });
    }

    if (texts.length > 50) {
      return res.status(400).json({ error: 'Max 50 texts per request' });
    }

    const translated = await translateBatch(texts);

    res.json({
      translated,
      count: translated.length,
    });
  } catch (err) {
    console.error('Translate error:', err);
    res.status(500).json({ error: 'Translation failed' });
  }
});

export default router;
