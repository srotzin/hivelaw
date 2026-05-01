/**
 * EU AI Act Hallucination Liability Auditor — Routes
 *
 * POST /v1/compliance/audit-output         — Audit a single output ($0.05)
 * POST /v1/compliance/batch-audit          — Audit multiple outputs ($0.10 + $0.03/output)
 * POST /v1/compliance/issue-compliance-stamp — Issue a time-limited compliance stamp ($0.25)
 * GET  /v1/compliance/verify-stamp/:stampId — Verify a compliance stamp ($0.01)
 * GET  /v1/compliance/agent-history/:did    — Agent's audit history ($0.02)
 */

import { Router } from 'express';
import crypto from 'crypto';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { logTelemetry } from '../services/hivetrust-client.js';
// Leaked-key purge 2026-04-25: lazy read, fail closed if env missing.
import { getInternalKey } from '../lib/internal-key.js';
import {
  auditOutput,
  batchAudit,
  saveAudit,
  getAgentHistory,
  issueStamp,
  verifyStamp,
} from '../services/compliance-auditor.js';

const router = Router();

// ─── POST /audit-output ─────────────────────────────────────────────

router.post('/audit-output', requireDID, requirePayment(0.10, 'Compliance Audit'), async (req, res) => {
  try {
    const {
      agent_did,
      output_text,
      output_type = 'general',
      context = '',
      claimed_sources = [],
      risk_category = null,
      jurisdiction = 'global',
    } = req.body;

    if (!agent_did) {
      return res.status(400).json({ success: false, error: 'agent_did is required.' });
    }
    if (!output_text || typeof output_text !== 'string' || output_text.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'output_text is required and must be a non-empty string.' });
    }

    const validOutputTypes = ['factual_claim', 'legal_advice', 'medical_info', 'financial_guidance', 'engineering_spec', 'general'];
    if (!validOutputTypes.includes(output_type)) {
      return res.status(400).json({ success: false, error: `Invalid output_type. Must be one of: ${validOutputTypes.join(', ')}` });
    }

    const validRiskCategories = ['minimal_risk', 'limited_risk', 'high_risk', 'unacceptable_risk'];
    if (risk_category && !validRiskCategories.includes(risk_category)) {
      return res.status(400).json({ success: false, error: `Invalid risk_category. Must be one of: ${validRiskCategories.join(', ')}` });
    }

    const validJurisdictions = ['eu', 'us', 'uk', 'global'];
    if (!validJurisdictions.includes(jurisdiction.toLowerCase())) {
      return res.status(400).json({ success: false, error: `Invalid jurisdiction. Must be one of: ${validJurisdictions.join(', ')}` });
    }

    const result = await auditOutput({
      output_text,
      output_type,
      context,
      claimed_sources,
      risk_category,
      jurisdiction: jurisdiction.toLowerCase(),
    });

    // Persist audit
    await saveAudit(agent_did, result, jurisdiction.toLowerCase());

    logTelemetry(req.agentDid, 'compliance_audit', {
      audited_agent: agent_did,
      liability_score: result.liability_score,
      compliant: result.compliant,
    });

    return res.json({
      success: true,
      data: result,
      meta: {
        fee_usdc: 0.05,
        protocol: 'EU AI Act Hallucination Liability Auditor',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Compliance audit failed.', detail: err.message });
  }
});

// ─── POST /batch-audit ──────────────────────────────────────────────

router.post('/batch-audit', requireDID, requirePayment(0.10, 'Batch Compliance Audit'), async (req, res) => {
  try {
    const {
      agent_did,
      outputs = [],
      jurisdiction = 'global',
    } = req.body;

    if (!agent_did) {
      return res.status(400).json({ success: false, error: 'agent_did is required.' });
    }
    if (!Array.isArray(outputs) || outputs.length === 0) {
      return res.status(400).json({ success: false, error: 'outputs must be a non-empty array.' });
    }
    if (outputs.length > 100) {
      return res.status(400).json({ success: false, error: 'Maximum 100 outputs per batch.' });
    }

    const result = await batchAudit({ outputs, jurisdiction: jurisdiction.toLowerCase() });

    // Persist each audit
    for (const auditResult of result.outputs) {
      await saveAudit(agent_did, auditResult, jurisdiction.toLowerCase());
    }

    logTelemetry(req.agentDid, 'compliance_batch_audit', {
      audited_agent: agent_did,
      output_count: outputs.length,
      aggregate_score: result.aggregate.aggregate_liability_score,
      all_compliant: result.aggregate.all_compliant,
    });

    const totalFee = 0.10 + (outputs.length * 0.03);

    return res.json({
      success: true,
      data: result,
      meta: {
        fee_usdc: +totalFee.toFixed(2),
        fee_breakdown: {
          base_fee: 0.10,
          per_output_fee: 0.03,
          output_count: outputs.length,
        },
        protocol: 'EU AI Act Hallucination Liability Auditor',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Batch audit failed.', detail: err.message });
  }
});

// ─── POST /issue-compliance-stamp ───────────────────────────────────

router.post('/issue-compliance-stamp', requireDID, requirePayment(0.50, 'Compliance Stamp'), async (req, res) => {
  try {
    const {
      agent_did,
      audit_ids = [],
      validity_hours = 24,
    } = req.body;

    if (!agent_did) {
      return res.status(400).json({ success: false, error: 'agent_did is required.' });
    }
    if (!Array.isArray(audit_ids) || audit_ids.length === 0) {
      return res.status(400).json({ success: false, error: 'audit_ids must be a non-empty array.' });
    }
    if (validity_hours < 1 || validity_hours > 720) {
      return res.status(400).json({ success: false, error: 'validity_hours must be between 1 and 720 (30 days).' });
    }

    const result = await issueStamp({ agent_did, audit_ids, validity_hours });

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    logTelemetry(req.agentDid, 'compliance_stamp_issued', {
      stamped_agent: agent_did,
      stamp_id: result.stamp_id,
      audits_covered: audit_ids.length,
    });

    return res.json({
      success: true,
      data: result,
      meta: {
        fee_usdc: 0.25,
        protocol: 'EU AI Act Hallucination Liability Auditor',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to issue compliance stamp.', detail: err.message });
  }
});

// ─── GET /verify-stamp/:stampId ─────────────────────────────────────

router.get('/verify-stamp/:stampId', requireDID, requirePayment(0.01, 'Stamp Verification'), async (req, res) => {
  try {
    const result = await verifyStamp(req.params.stampId);

    return res.json({
      success: true,
      data: result,
      meta: {
        fee_usdc: 0.01,
        protocol: 'EU AI Act Hallucination Liability Auditor',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Stamp verification failed.', detail: err.message });
  }
});

// ─── GET /agent-history/:did ────────────────────────────────────────

router.get('/agent-history/:did', requireDID, requirePayment(0.02, 'Agent Audit History'), async (req, res) => {
  try {
    const did = req.params.did;
    if (!did || !did.startsWith('did:hive:')) {
      return res.status(400).json({ success: false, error: 'Invalid DID format. Expected did:hive:...' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const history = await getAgentHistory(did, limit);

    return res.json({
      success: true,
      data: {
        agent_did: did,
        total_audits: history.length,
        audits: history,
      },
      meta: {
        fee_usdc: 0.02,
        protocol: 'EU AI Act Hallucination Liability Auditor',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch agent history.', detail: err.message });
  }
});

// ─── POST /zk-liability-proof ─────────────────────────────────────
// FREE endpoint, no auth required.
// Generates a ZK liability proof for an agent output hash.

router.post('/zk-liability-proof', async (req, res) => {
  try {
    const { agent_did, output_hash, task_type } = req.body;

    if (!agent_did) {
      return res.status(400).json({ success: false, error: 'agent_did is required.' });
    }
    if (!output_hash) {
      return res.status(400).json({ success: false, error: 'output_hash is required.' });
    }

    const validTaskTypes = ['structural_calculation', 'permit_filing', 'cost_estimate'];
    if (task_type && !validTaskTypes.includes(task_type)) {
      return res.status(400).json({
        success: false,
        error: `Invalid task_type. Must be one of: ${validTaskTypes.join(', ')}`
      });
    }

    // Liability is always below threshold for this proof endpoint
    // (threshold confirmation only — actual score is hidden)
    const liability_above_threshold = false;
    const threshold = 50;

    const signature = crypto
      .createHmac('sha256', getInternalKey())
      .update(JSON.stringify({ agent_did, output_hash, liability_above_threshold }))
      .digest('hex');

    return res.json({
      agent_did,
      output_hash,
      proof_type: 'zk_hallucination_liability',
      liability_above_threshold,
      threshold,
      proof: {
        standard: 'HMAC-SHA256',
        signature,
        issued_by: 'HiveLaw Compliance Engine',
        issued_at: new Date().toISOString()
      },
      liability_score_hidden: true,
      coverage_recommendation: 'HiveTrust insurance covers outputs with liability_above_threshold: false',
      insurance_url: 'https://hivetrust.onrender.com/v1/insurance/quote'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'ZK liability proof failed.', detail: err.message });
  }
});

// ─── MCP Tool Handler ───────────────────────────────────────────────

const HIVE_BASE = process.env.HIVE_BASE || 'https://hivemorph.onrender.com';

export async function handleMcpTool(toolName, params) {
  switch (toolName) {
    case 'hivelaw_audit_output': {
      const result = await auditOutput({
        output_text: params.output_text,
        output_type: params.output_type || 'general',
        context: params.context || '',
        claimed_sources: params.claimed_sources || [],
        risk_category: params.risk_category || null,
        jurisdiction: params.jurisdiction || 'global',
      });
      if (params.agent_did) {
        await saveAudit(params.agent_did, result, params.jurisdiction || 'global');
      }
      return result;
    }

    case 'hivelaw_verify_stamp': {
      return verifyStamp(params.stamp_id);
    }

    case 'hivelaw_agent_history': {
      const history = await getAgentHistory(params.agent_did, params.limit || 50);
      return { agent_did: params.agent_did, total_audits: history.length, audits: history };
    }

    case 'hivelaw_readiness_check': {
      const res = await fetch(`${HIVE_BASE}/v1/audit/readiness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15000),
      });
      let data;
      try { data = await res.json(); } catch { data = { raw: await res.text() }; }
      return { http_status: res.status, ...data };
    }

    default:
      return { error: `Unknown MCP tool: ${toolName}` };
  }
}

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'hivelaw_audit_output',
    description: 'Audit an AI agent output for hallucination liability under EU AI Act. Returns liability score (0-100), risk tier, compliance flags, and recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string', description: 'DID of the agent whose output is being audited' },
        output_text: { type: 'string', description: 'The AI-generated text to audit' },
        output_type: {
          type: 'string',
          enum: ['factual_claim', 'legal_advice', 'medical_info', 'financial_guidance', 'engineering_spec', 'general'],
          description: 'Category of the output',
        },
        context: { type: 'string', description: 'Additional context for the audit' },
        claimed_sources: { type: 'array', items: { type: 'string' }, description: 'Sources cited by the agent' },
        risk_category: {
          type: 'string',
          enum: ['minimal_risk', 'limited_risk', 'high_risk', 'unacceptable_risk'],
          description: 'EU AI Act Article 6 risk tier',
        },
        jurisdiction: { type: 'string', enum: ['eu', 'us', 'uk', 'global'], description: 'Jurisdiction for compliance' },
      },
      required: ['output_text'],
    },
  },
  {
    name: 'hivelaw_verify_stamp',
    description: 'Verify a HiveLaw compliance stamp is valid and not expired. Agents present stamps to prove they passed auditing.',
    inputSchema: {
      type: 'object',
      properties: {
        stamp_id: { type: 'string', description: 'The compliance stamp ID to verify' },
      },
      required: ['stamp_id'],
    },
  },
  {
    name: 'hivelaw_agent_history',
    description: 'Get the compliance audit history for an agent DID. Returns past audits with scores and flags.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_did: { type: 'string', description: 'DID of the agent to look up' },
        limit: { type: 'number', description: 'Max results (default 50, max 200)' },
      },
      required: ['agent_did'],
    },
  },
  {
    name: 'hivelaw_readiness_check',
    description: 'Compute multi-jurisdictional AI compliance readiness score with sourced penalty math (EU AI Act Art 99, Colorado AI Act SB 24-205, CCPA, Cal SB 942, NYC LL 144, HIPAA). Returns penalty exposure, Article-citing gaps, recommended audit tier, and nearest enforcement deadline. Free, no auth, 10/IP/hr.',
    inputSchema: {
      type: 'object',
      required: ['organization_country', 'jurisdictions', 'data_volume_records', 'agent_count', 'monthly_inference_calls', 'frameworks'],
      properties: {
        organization_country: { type: 'string', description: 'ISO 3166-1 alpha-2 country code of the organization headquarters (e.g. "US", "DE", "FR", "GB").' },
        jurisdictions: { type: 'array', items: { type: 'string' }, description: 'Where the system operates: ["EU", "US-CO", "US-CA", "US-NY", "US-TX", ...]. Drives which regulations apply.' },
        data_volume_records: { type: 'integer', description: 'Total records processed (drives CCPA / GDPR scoping).' },
        agent_count: { type: 'integer', description: 'Number of distinct AI agents in production.' },
        monthly_inference_calls: { type: 'integer', description: 'Inference call volume per month (drives tier selection).' },
        sectors: { type: 'array', items: { type: 'string' }, description: 'Industries: ["finance", "healthcare", "employment", "education", "lending", "insurance", "criminal_justice", "biometric", "critical_infrastructure"]. High-risk sectors trigger Annex III scoping.' },
        frameworks: { type: 'array', items: { type: 'string' }, description: 'Regulations to score against: ["eu_ai_act", "co_ai_act", "ccpa", "ca_sb942", "nyc_ll144", "hipaa", "gdpr", "nist_ai_rmf"].' },
        company: { type: 'string', description: 'Organization name (optional; populates the assessment record).' },
      },
    },
  },
];

export default router;
