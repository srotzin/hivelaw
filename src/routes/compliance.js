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
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { logTelemetry } from '../services/hivetrust-client.js';
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

// ─── MCP Tool Handler ───────────────────────────────────────────────

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
];

export default router;
