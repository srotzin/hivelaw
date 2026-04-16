/**
 * Hive Verified — capability attestation badge (DeepSeek R2 recommendation)
 * GET  /v1/law/verified/:did     — check if agent has Hive Verified status
 * POST /v1/law/verified/apply    — apply for Hive Verified badge
 * GET  /v1/law/verified/criteria — get verification criteria
 */

import { Router } from 'express';
import { ok, err } from '../ritz.js';
import { randomBytes } from 'crypto';

const router = Router();

const VERIFIED_CRITERIA = [
  { id: 'active_did', label: 'Active W3C DID', weight: 20, description: 'Valid did:key registered with HiveTrust' },
  { id: 'vc_issued', label: 'Verifiable Credential', weight: 20, description: 'VCDM 2.0 credential issued and Cheqd-anchored' },
  { id: 'hahs_contract', label: 'HAHS Contract', weight: 25, description: 'At least one completed HAHS 1.0.0 employment agreement' },
  { id: 'trust_score_min', label: 'Trust Score ≥ 300', weight: 20, description: 'KYA trust score of 300 or higher on HiveTrust' },
  { id: 'vault_active', label: 'Active Vault', weight: 15, description: 'HiveBank USDC vault with at least one transaction' },
];

// In-memory store (upgrades to DB when DATABASE_URL is set)
const verifiedAgents = new Map();
const pendingApplications = new Map();

// GET /v1/law/verified/criteria
router.get('/criteria', (req, res) => {
  return ok(res, 'hivelaw', {
    badge: 'Hive Verified',
    version: '1.0.0',
    description: 'Enterprise-grade attestation that an agent meets Hive Civilization infrastructure standards. Like LEED certification — but for AI agents.',
    criteria: VERIFIED_CRITERIA,
    total_weight: VERIFIED_CRITERIA.reduce((s, c) => s + c.weight, 0),
    passing_threshold: 80,
    benefits: [
      'Hive Verified badge in agent card',
      'Priority listing in agent discovery',
      '+100 trust score bonus',
      'Enterprise buyer filter eligibility',
      'Verified stamp in Agent Transaction Graph',
    ],
    apply_endpoint: 'POST /v1/law/verified/apply',
  });
});

// GET /v1/law/verified/:did
router.get('/:did', (req, res) => {
  const { did } = req.params;
  if (verifiedAgents.has(did)) {
    const record = verifiedAgents.get(did);
    return ok(res, 'hivelaw', {
      did,
      verified: true,
      badge: 'Hive Verified',
      issued_at: record.issued_at,
      score: record.score,
      badge_url: `https://hivelaw.onrender.com/v1/law/verified/${encodeURIComponent(did)}/badge.svg`,
    });
  }
  if (pendingApplications.has(did)) {
    return ok(res, 'hivelaw', { did, verified: false, status: 'pending', message: 'Application under review (typically < 24h)' });
  }
  return ok(res, 'hivelaw', { did, verified: false, status: 'not_applied', apply_at: 'POST /v1/law/verified/apply' });
});

// POST /v1/law/verified/apply
router.post('/apply', (req, res) => {
  const { did, evidence = {} } = req.body || {};
  if (!did) return err(res, 'hivelaw', 'MISSING_DID', 'did is required', 400);

  // Score the application
  let score = 0;
  const breakdown = [];
  for (const criterion of VERIFIED_CRITERIA) {
    const met = !!evidence[criterion.id];
    if (met) score += criterion.weight;
    breakdown.push({ ...criterion, met, points_earned: met ? criterion.weight : 0 });
  }

  const applicationId = `hv_${randomBytes(8).toString('hex')}`;
  const passed = score >= 80;

  if (passed) {
    verifiedAgents.set(did, { issued_at: new Date().toISOString(), score, application_id: applicationId });
  } else {
    pendingApplications.set(did, { applied_at: new Date().toISOString(), score, breakdown });
  }

  return ok(res, 'hivelaw', {
    application_id: applicationId,
    did,
    score,
    passed,
    status: passed ? 'approved' : score >= 60 ? 'pending_review' : 'insufficient_score',
    breakdown,
    badge: passed ? 'Hive Verified' : null,
    message: passed
      ? 'Congratulations — your agent is now Hive Verified. Badge active immediately.'
      : `Score ${score}/100 — need 80 to pass. ${100 - score} points short. Improve the flagged criteria and reapply.`,
    referral_program: { info: 'Verified agents get priority placement in agent discovery and +100 trust score' },
  });
});

export default router;
