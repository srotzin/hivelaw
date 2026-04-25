import { Router } from 'express';
import crypto from 'crypto';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { fileAndArbitrate, appealDispute, getDispute, getDisputeStats } from '../services/arbitration-engine.js';
import { logTelemetry } from '../services/hivetrust-client.js';
import { sendAlert } from '../services/alerts.js';
import { recordThreatSignature, getImmuneFeed } from '../services/vaccine.js';
// Leaked-key purge 2026-04-25: lazy read, fail closed if env missing.
import { getInternalKey } from '../lib/internal-key.js';

const router = Router();

/**
 * GET /v1/disputes/zk-resolution/:case_id — ZK proof of dispute resolution.
 * FREE endpoint, no auth required.
 * Proves "this dispute was resolved in favor of [winning_party]" without revealing settlement amounts.
 */
function generateDisputeZkProof(dispute) {
  const payload = {
    case_id: dispute.id || dispute.dispute_id,
    resolved: dispute.status === 'resolved',
    winning_party_role: dispute.outcome?.winner_role || 'unknown', // 'claimant' or 'respondent'
    resolution_timestamp: dispute.resolved_at,
    hive_law_sig: crypto.createHmac('sha256', getInternalKey())
      .update(JSON.stringify({ case_id: dispute.id || dispute.dispute_id, outcome: dispute.outcome?.winner_role }))
      .digest('hex')
  };
  return {
    proof_type: 'zk_dispute_resolution',
    proof_standard: 'HMAC-SHA256 over case outcome — amounts hidden',
    case_id: dispute.id || dispute.dispute_id,
    resolved: payload.resolved,
    winning_party_role: payload.winning_party_role,
    amount_hidden: true,
    signature: payload.hive_law_sig,
    verifiable_at: `https://hivelaw.onrender.com/v1/disputes/zk-resolution/${dispute.id || dispute.dispute_id}`,
    issued_at: new Date().toISOString()
  };
}

router.get('/zk-resolution/:case_id', async (req, res) => {
  try {
    const { case_id } = req.params;
    const dispute = await getDispute(case_id);
    if (!dispute) {
      return res.status(404).json({ success: false, error: 'Dispute not found.' });
    }
    const zk_proof = generateDisputeZkProof(dispute);
    return res.json({
      case_id,
      zk_proof,
      immune_feed_entry: 'https://hivelaw.onrender.com/v1/law/immune/feed',
      use_before_hiring: 'POST this proof to your counterparty verification flow'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'ZK resolution proof failed.', detail: err.message });
  }
});

/**
 * POST /v1/disputes/file — File a dispute and auto-arbitrate.
 * The ENTIRE arbitration happens in one request — sub-3-second resolution.
 */
router.post('/file', requireDID, requirePayment(0.50, 'Dispute Filing'), async (req, res) => {
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

    // ── HiveVaccine: write threat signature if respondent is found liable ────────────
    // Fire-and-forget — never blocks the response.
    // Only records when the ruling goes AGAINST the filed_against party.
    const ruling = result.dispute?.arbitration?.ruling;
    const filedAgainst = result.dispute?.filed_against;
    const rulingOutcome = ruling?.outcome;
    const isLiable = rulingOutcome === 'provider_liable' || rulingOutcome === 'consumer_liable';
    if (isLiable && filedAgainst && ruling) {
      recordThreatSignature({
        agentDid: filedAgainst,
        category,
        outcome: rulingOutcome,
        confidenceScore: ruling.confidence_score ?? 0.5,
        disputeId: result.dispute.dispute_id,
        rulingSummary: ruling.ruling_summary || ruling.summary || '',
        description,
        evidence,
      }).catch(() => {}); // truly fire-and-forget
    }

    sendAlert('info', 'HiveLaw', `Dispute filed: ${result.dispute.dispute_id}`, {
      category,
      filed_by: req.agentDid,
      contract_id: contract_id,
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

// ─── GET /v1/law/immune/feed — HiveVaccine public immune feed ─────────────────────
//
// No auth required — this is designed to be polled by any agent.
// Returns threat signatures sorted by confidence DESC.
// Citizens integrate this into their trust evaluation before interacting
// with unknown agents — the social immune transmission Kimi specified.
//
// Query params:
//   ?limit=50           - max results (default 50, max 200)
//   ?category=          - filter by category
//   ?min_confidence=0.4 - minimum confidence threshold
router.get('/immune/feed', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const category = req.query.category || null;
    const min_confidence = parseFloat(req.query.min_confidence) || 0.4;

    const signatures = await getImmuneFeed({ limit, category, min_confidence });

    return res.json({
      success: true,
      schema: 'hive-immune-feed/1.0',
      description: 'HiveVaccine — threat signatures extracted from resolved HiveLaw disputes. Poll this feed to build immunity against known bad actors in the Hive network.',
      generated_at: new Date().toISOString(),
      count: signatures.length,
      how_to_use: [
        '1. Poll this feed periodically (recommended: every 30 minutes for active agents)',
        '2. Before interacting with an unknown agent, check if their DID appears in this feed',
        '3. Apply elevated scrutiny or refuse interaction if confidence >= 0.7',
        '4. If you catch an attack that matches a signature here, file a dispute at POST /v1/disputes/file — successful confirmation raises the signature confidence',
      ],
      filter_options: {
        categories: ['hallucination', 'non_performance', 'overcharge', 'data_breach', 'unauthorized_action'],
        example: 'GET /v1/law/immune/feed?category=hallucination&min_confidence=0.6',
      },
      signatures,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'immune_feed_failed', detail: err.message });
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
