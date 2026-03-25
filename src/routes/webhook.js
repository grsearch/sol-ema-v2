// src/routes/webhook.js — receive new token from external scanner
const express          = require('express');
const router           = express.Router();
const logger           = require('../logger');
const { TokenMonitor } = require('../monitor');

/**
 * POST /webhook/add-token
 * Body: { "network": "solana", "address": "...", "symbol": "..." }
 */
router.post('/add-token', async (req, res) => {
  const { address, symbol, network } = req.body || {};
  if (!address) return res.status(400).json({ ok: false, error: 'Missing address' });

  logger.info(`[Webhook] Received: ${symbol || '?'} @ ${address}`);

  try {
    const result = await TokenMonitor.getInstance().addToken({ address, symbol, network });
    return res.json({ ok: result.ok, reason: result.reason || null });
  } catch (e) {
    logger.warn(`[Webhook] addToken error: ${e.message}`);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /webhook/status — health check
router.get('/status', (req, res) => {
  const monitor = TokenMonitor.getInstance();
  res.json({
    ok:        true,
    tokens:    monitor.tokens.size,
    uptime:    process.uptime().toFixed(0) + 's',
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
