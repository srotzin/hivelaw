import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { fileAndArbitrate, appealDispute, getDispute, getDisputeStats } from '../services/arbitration-engine.js';
import { logTelemetry } from '../services/hivetrust-client.js';

const router = Router();

/**
 * POST /v1/disputes/file — File a dispute and auto-arbitrate.
 * The ENTIRE arbitration happens in one request — sub-3-second resolution.
 */
router.post('/file', requireDID, requirePayment(0.25, 'Dispute Filing'), async (req, res) => {
  try {
    const {
      contract_id,
      category = 'hallucination',
      description = '',
      claimed_damages_usdc = 0,
      evidence = {},
    } = req.body;

    if (!contract_id) {
      return res.status(400).json({ success: false, error: 'contract_id is required.' });
    }
    if (!description) {
      return res.status(400).json({ success: false, error: 'description is required.' });
    }

    const result = await fileAndArbitrate({
      contractId: contract_id,
      filedBy: req.agentDid,
      category,
      description,
      claimedDamagesUsdc: claimed_damages_usdc,
      evidence,
    });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    logTelemetry(req.agentDid, 'dispute_filed', {
      dispute_id: result.dispute.dispute_id,
      category,
      resolution_time_ms: result.dispute.arbitration.resolution_time_ms,
    });

    return res.status(201).json({
      success: true,
      data: result.dispute,
      new_case_law: result.new_case_law,
      settlement: result.settlement,
      meta: {
        arbitration_complete: true,
        resolution_time_ms: result.dispute.arbitration.resolution_time_ms,
        filing_fee_usdc: 0.25,
        fee_refundable: result.dispute.arbitration.ruling?.in_favor_of === req.agentDid,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Arbitration failed.', detail: err.message });
  }
});

/**
 * GET /v1/disputes/:disputeId — Get dispute details.
 */
router.get('/:disputeId', requireDID, async (req, res) => {
  try {
    const dispute = await getDispute(req.params.disputeId);
    if (!dispute) return res.status(404).json({ success: false, error: 'Dispute not found.' });
    if (dispute.filed_by !== req.agentDid && dispute.filed_against !== req.agentDid) {
      return res.status(403).json({ success: false, error: 'You are not a party to this dispute.' });
    }
    return res.json({ success: true, data: dispute });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch dispute.', detail: err.message });
  }
});

/**
 * POST /v1/disputes/:disputeId/appeal — Appeal a ruling.
 */
router.post('/:disputeId/appeal', requireDID, requirePayment(0.50, 'Dispute Appeal'), async (req, res) => {
  try {
    const { grounds = 'new_evidence', additional_evidence = {} } = req.body;
    const validGrounds = ['new_evidence', 'procedural_error', 'precedent_mismatch'];
    if (!validGrounds.includes(grounds)) {
      return res.status(400).json({ success: false, error: `Invalid grounds. Must be one of: ${validGrounds.join(', ')}` });
    }

    const result = await appealDispute(req.params.disputeId, {
      filedBy: req.agentDid,
      grounds,
      additionalEvidence: additional_evidence,
    });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    logTelemetry(req.agentDid, 'dispute_appealed', {
      dispute_id: req.params.disputeId,
      grounds,
    });

    return res.json({
      success: true,
      data: result,
      meta: { appeal_fee_usdc: 0.50 },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Appeal failed.', detail: err.message });
  }
});

/**
 * GET /v1/disputes/stats/overview — Dispute statistics.
 */
router.get('/stats/overview', requireDID, async (req, res) => {
  try {
    const stats = await getDisputeStats();
    return res.json({ success: true, data: stats });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch stats.', detail: err.message });
  }
});

export default router;
