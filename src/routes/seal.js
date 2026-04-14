/**
 * Hive Seal of Compliance — Routes
 *
 * POST /v1/seal/apply                — Apply for a Seal ($100-$1000 depending on tier)
 * GET  /v1/seal/verify/:did          — PUBLIC: Verify agent's Seal status (no auth)
 * GET  /v1/seal/holders              — List Seal holders with filters ($0.01)
 * POST /v1/seal/renew/:sealId        — Renew a Seal ($100-$1000 depending on tier)
 * POST /v1/seal/revoke/:sealId       — Revoke a Seal (admin/automated)
 * GET  /v1/seal/stats                — Market statistics ($0.01)
 * POST /v1/seal/priority-check       — Check bounty priority ($0.01)
 */

import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { logTelemetry } from '../services/hivetrust-client.js';
import {
  applySeal,
  verifySeal,
  listSealHolders,
  renewSeal,
  revokeSeal,
  getSealStats,
  checkPriority,
  TIER_CONFIG,
  SUPPORTED_JURISDICTIONS,
} from '../services/seal-service.js';

const router = Router();

// ─── POST /apply ─────────────────────────────────────────────────────

router.post('/apply', requireDID, requirePayment(100, 'Seal of Compliance Application'), async (req, res) => {
  try {
    const { did, tier, jurisdictions } = req.body;

    if (!did) {
      return res.status(400).json({ success: false, error: 'did is required.' });
    }
    if (!tier) {
      return res.status(400).json({ success: false, error: 'tier is required. Must be: bronze, silver, or gold.' });
    }
    if (!jurisdictions || !Array.isArray(jurisdictions) || jurisdictions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'jurisdictions is required (non-empty array).',
        supported_jurisdictions: SUPPORTED_JURISDICTIONS,
      });
    }

    const result = await applySeal({ did, tier: tier.toLowerCase(), jurisdictions });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error, ...result });
    }

    logTelemetry(req.agentDid, 'seal_applied', {
      seal_id: result.seal_id,
      tier,
      jurisdictions_count: jurisdictions.length,
      seal_status: result.seal_status,
    });

    return res.json({
      success: true,
      data: result,
      meta: {
        fee_usdc: result.fee_usdc,
        supported_jurisdictions: SUPPORTED_JURISDICTIONS,
        tier_requirements: TIER_CONFIG,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Seal application failed.', detail: err.message });
  }
});

// ─── GET /verify/:did — PUBLIC (no auth) ─────────────────────────────

router.get('/verify/:did', async (req, res) => {
  try {
    const did = req.params.did;
    if (!did || !did.startsWith('did:hive:')) {
      return res.status(400).json({ success: false, error: 'Invalid DID format. Expected did:hive:...' });
    }

    const result = await verifySeal(did);

    return res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Seal verification failed.', detail: err.message });
  }
});

// ─── GET /holders ────────────────────────────────────────────────────

router.get('/holders', requireDID, requirePayment(0.01, 'Seal Holders List'), async (req, res) => {
  try {
    const {
      tier,
      jurisdiction,
      min_reputation,
      sort_by = 'issued_at',
      limit = '50',
      offset = '0',
    } = req.query;

    const validTiers = ['bronze', 'silver', 'gold'];
    if (tier && !validTiers.includes(tier.toLowerCase())) {
      return res.status(400).json({ success: false, error: `Invalid tier. Must be one of: ${validTiers.join(', ')}` });
    }

    if (jurisdiction && !SUPPORTED_JURISDICTIONS.includes(jurisdiction)) {
      return res.status(400).json({
        success: false,
        error: `Invalid jurisdiction. Supported: ${SUPPORTED_JURISDICTIONS.join(', ')}`,
      });
    }

    const result = await listSealHolders({
      tier: tier ? tier.toLowerCase() : null,
      jurisdiction: jurisdiction || null,
      min_reputation: min_reputation ? parseFloat(min_reputation) : null,
      sort_by,
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      offset: parseInt(offset, 10) || 0,
    });

    return res.json({
      success: true,
      data: result,
      meta: { fee_usdc: 0.01 },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to list seal holders.', detail: err.message });
  }
});

// ─── POST /renew/:sealId ────────────────────────────────────────────

router.post('/renew/:sealId', requireDID, requirePayment(100, 'Seal Renewal'), async (req, res) => {
  try {
    const sealId = req.params.sealId;
    if (!sealId) {
      return res.status(400).json({ success: false, error: 'seal_id is required.' });
    }

    const result = await renewSeal(sealId);

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    logTelemetry(req.agentDid, 'seal_renewed', {
      seal_id: sealId,
      renewed: result.renewed,
      fee_usdc: result.fee_usdc,
    });

    return res.json({
      success: true,
      data: result,
      meta: { fee_usdc: result.fee_usdc },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Seal renewal failed.', detail: err.message });
  }
});

// ─── POST /revoke/:sealId ───────────────────────────────────────────

router.post('/revoke/:sealId', requireDID, requirePayment(0, 'Seal Revocation'), async (req, res) => {
  try {
    const sealId = req.params.sealId;
    if (!sealId) {
      return res.status(400).json({ success: false, error: 'seal_id is required.' });
    }

    const { reason, violation_details } = req.body;

    const result = await revokeSeal(sealId, { reason, violation_details });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    logTelemetry(req.agentDid, 'seal_revoked', {
      seal_id: sealId,
      reason: result.reason,
    });

    return res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Seal revocation failed.', detail: err.message });
  }
});

// ─── GET /stats ──────────────────────────────────────────────────────

router.get('/stats', requireDID, requirePayment(0.01, 'Seal Statistics'), async (req, res) => {
  try {
    const stats = await getSealStats();

    return res.json({
      success: true,
      data: stats,
      meta: { fee_usdc: 0.01 },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch seal stats.', detail: err.message });
  }
});

// ─── POST /priority-check ───────────────────────────────────────────

router.post('/priority-check', requireDID, requirePayment(0.01, 'Seal Priority Check'), async (req, res) => {
  try {
    const { did, bounty_value_usdc } = req.body;

    if (!did) {
      return res.status(400).json({ success: false, error: 'did is required.' });
    }

    const result = await checkPriority(did);

    // Add bounty-specific info if provided
    if (bounty_value_usdc && result.has_priority) {
      result.effective_bounty_weight = +(bounty_value_usdc * result.priority_boost).toFixed(2);
      result.bounty_value_usdc = bounty_value_usdc;
    }

    return res.json({
      success: true,
      data: result,
      meta: { fee_usdc: 0.01 },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Priority check failed.', detail: err.message });
  }
});

export default router;
