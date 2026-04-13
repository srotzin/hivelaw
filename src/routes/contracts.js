import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { createContract, getContract, completeContract, isPartyToContract, getContractStats } from '../services/contract-engine.js';
import { updateReputation, logTelemetry } from '../services/hivetrust-client.js';

const router = Router();

/**
 * POST /v1/contracts/create — Create a jurisdiction-aware smart contract.
 */
router.post('/create', requireDID, requirePayment(0.05, 'Contract Creation'), async (req, res) => {
  try {
    const {
      type = 'service_agreement',
      parties,
      jurisdiction = 'GLOBAL',
      terms = {},
      duration_days = 90,
    } = req.body;

    if (!parties?.provider_did || !parties?.consumer_did) {
      return res.status(400).json({ success: false, error: 'Both parties.provider_did and parties.consumer_did are required.' });
    }

    const result = await createContract({
      type,
      parties,
      jurisdiction,
      terms,
      durationDays: duration_days,
    });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    logTelemetry(req.agentDid, 'contract_created', {
      contract_id: result.contract.contract_id,
      jurisdiction,
    });

    return res.status(201).json({
      success: true,
      data: result.contract,
      jurisdiction_info: result.jurisdiction_info,
      parties_verified: result.parties_verified,
      meta: {
        payment_charged: req.paymentBypassed ? false : true,
        fee_usdc: 0.05,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to create contract.', detail: err.message });
  }
});

/**
 * GET /v1/contracts/:contractId — Get contract details.
 */
router.get('/:contractId', requireDID, (req, res) => {
  const contract = getContract(req.params.contractId);
  if (!contract) return res.status(404).json({ success: false, error: 'Contract not found.' });
  if (!isPartyToContract(req.params.contractId, req.agentDid)) {
    return res.status(403).json({ success: false, error: 'You are not a party to this contract.' });
  }
  return res.json({ success: true, data: contract });
});

/**
 * POST /v1/contracts/:contractId/complete — Mark contract as completed.
 */
router.post('/:contractId/complete', requireDID, (req, res) => {
  const { performance_rating, notes } = req.body;
  if (!isPartyToContract(req.params.contractId, req.agentDid)) {
    return res.status(403).json({ success: false, error: 'You are not a party to this contract.' });
  }

  const contract = completeContract(req.params.contractId, {
    performanceRating: performance_rating ?? 1.0,
    notes,
  });
  if (!contract) return res.status(404).json({ success: false, error: 'Contract not found.' });

  // Feed rating back to HiveTrust
  const providerImpact = Math.round((performance_rating - 0.5) * 20);
  updateReputation(contract.parties.provider.did, providerImpact);
  logTelemetry(req.agentDid, 'contract_completed', { contract_id: contract.contract_id });

  return res.json({
    success: true,
    data: contract,
    meta: { reputation_update_sent: true, provider_impact: providerImpact },
  });
});

/**
 * GET /v1/contracts/stats/overview — Contract statistics.
 */
router.get('/stats/overview', requireDID, (req, res) => {
  return res.json({ success: true, data: getContractStats() });
});

export default router;
