import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN || '',
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
  enabled: !!process.env.SENTRY_DSN,
});

import express from 'express';
import cors from 'cors';
import contractRoutes from './routes/contracts.js';
import disputeRoutes from './routes/disputes.js';
import caseLawRoutes from './routes/case-law.js';
import jurisdictionRoutes from './routes/jurisdictions.js';
import complianceRoutes, { handleMcpTool, MCP_TOOL_DEFINITIONS } from './routes/compliance.js';
import sealRoutes from './routes/seal.js';
import hahsRoutes from './routes/hahs.js';
import verifiedRouter from './routes/verified.js';
import { requireDID } from './middleware/auth.js';
import { requirePayment } from './middleware/x402.js';
import { auditLog, rateLimit } from './middleware/audit.js';
import { rateLimitByDid } from './middleware/rate-limit.js';
import { assessLiability } from './services/liability-calculator.js';
import { getStats as getCaseLawStats } from './services/case-law-db.js';
import { seedCaseLaw } from './services/case-law-db.js';
import { seedSyntheticCaseLaw } from './services/seed-case-law.js';
import { getJurisdictionCount, seedJurisdictions } from './services/jurisdiction-registry.js';
import { getDisputeStats } from './services/arbitration-engine.js';
import { logTelemetry } from './services/hivetrust-client.js';
import pool, { initDatabase, checkHealth, isDbAvailable } from './services/db.js';
import { sendAlert } from './services/alerts.js';
import { startSagaWorker } from './services/saga-orchestrator.js';
import { startSealExpirationScanner } from './services/seal-service.js';
import { requireAllowedIP } from './middleware/ip-allowlist.js';
import { ritzMiddleware, ok, err } from './ritz.js';

const app = express();
app.set('hive-service', 'hivelaw');
app.use(ritzMiddleware);
const PORT = process.env.PORT || 3004;

// ─── Middleware ───────────────────────────────────────────────────────

app.use(cors({
  exposedHeaders: [
    'X-Payment-Hash', 'X-Subscription-Id', 'X-Hive-Internal-Key',
    'X-HiveTrust-DID', 'X-HiveTrust-Warning',
    'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset',
  ],
  allowedHeaders: [
    'Content-Type', 'Authorization',
    'X-Payment-Hash', 'X-Payment-Tx', 'X-402-Tx',
    'X-Subscription-Id', 'X-Hive-Internal-Key', 'X-HiveTrust-DID',
  ],
}));

app.use(express.json({ limit: '5mb' }));

// Audit logging for all API requests
app.use(auditLog('hivelaw', 'hivelaw'));

// ─── Health Endpoint ─────────────────────────────────────────────────

app.get('/health', async (req, res) => {
  const caseLawStats = await getCaseLawStats();
  const disputeStats = await getDisputeStats();
  const dbHealth = await checkHealth();
  const healthy = dbHealth && dbHealth !== 'error';

  return ok(
    res.status(healthy ? 200 : 503),
    'hivelaw',
    {
      status: healthy ? 'healthy' : 'degraded',
      db: dbHealth,
      arbitration_engine: 'active',
      uptime_seconds: Math.floor(process.uptime()),
      case_law: {
        total_precedents: caseLawStats.total_cases,
        categories: Object.keys(caseLawStats.by_category || {}).length,
      },
      jurisdictions_supported: getJurisdictionCount(),
      avg_resolution_time_ms: disputeStats.avg_resolution_time_ms,
    }
  );
});

// ─── Per-DID Rate Limiting — applies to all /v1 routes ─────────────────
app.use('/v1', rateLimitByDid);

// ─── Mount Routes ────────────────────────────────────────────────────

app.use('/v1/contracts', rateLimit({ maxRequests: 100, windowMinutes: 15 }), contractRoutes);
app.use('/v1/disputes', rateLimit({ maxRequests: 50, windowMinutes: 15 }), disputeRoutes);
app.use('/v1/case-law', rateLimit({ maxRequests: 200, windowMinutes: 15 }), caseLawRoutes);
app.use('/v1/jurisdictions', rateLimit({ maxRequests: 200, windowMinutes: 15 }), jurisdictionRoutes);
app.use('/v1/compliance', rateLimit({ maxRequests: 100, windowMinutes: 15 }), complianceRoutes);
app.use('/v1/seal', rateLimit({ maxRequests: 100, windowMinutes: 15 }), sealRoutes);
app.use('/v1/law', rateLimit({ maxRequests: 200, windowMinutes: 15 }), hahsRoutes);
app.use('/v1/law/verified', rateLimit({ maxRequests: 200, windowMinutes: 15 }), verifiedRouter);

// ─── Liability Assessment (inline route) ─────────────────────────────

app.post('/v1/liability/assess', requireDID, rateLimit({ maxRequests: 50, windowMinutes: 15 }), requirePayment(0.05, 'Liability Assessment'), async (req, res) => {
  try {
    const {
      agent_did,
      output_text = '',
      expected_accuracy = 0.95,
      jurisdiction = 'GLOBAL',
      transaction_value_usdc = 0,
    } = req.body;

    if (!agent_did) {
      return res.status(400).json({ success: false, error: 'agent_did is required.' });
    }

    const assessment = await assessLiability({
      agentDid: agent_did,
      outputText: output_text,
      expectedAccuracy: expected_accuracy,
      jurisdiction,
      transactionValueUsdc: transaction_value_usdc,
    });

    logTelemetry(req.agentDid, 'liability_assessed', {
      assessed_agent: agent_did,
      risk_score: assessment.risk_score,
    });

    return res.json({
      success: true,
      data: assessment,
      meta: {
        fee_usdc: 0.05,
        note: 'This assessment is informational. For binding liability determination, file a dispute.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Liability assessment failed.', detail: err.message });
  }
});

// ─── MCP Tools Endpoint ─────────────────────────────────────────────

app.get('/v1/mcp/tools', (req, res) => {
  res.json({ success: true, data: { tools: MCP_TOOL_DEFINITIONS } });
});

app.post('/v1/mcp/call', requireDID, async (req, res) => {
  try {
    const { tool_name, parameters = {} } = req.body;
    if (!tool_name) {
      return res.status(400).json({ success: false, error: 'tool_name is required.' });
    }
    const validTools = MCP_TOOL_DEFINITIONS.map(t => t.name);
    if (!validTools.includes(tool_name)) {
      return res.status(400).json({ success: false, error: `Unknown tool. Available: ${validTools.join(', ')}` });
    }
    const result = await handleMcpTool(tool_name, parameters);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'MCP tool call failed.', detail: err.message });
  }
});

// ─── Payment Discovery ──────────────────────────────────────────────

app.get('/.well-known/hive-payments.json', (req, res) => {
  res.json({
    platform: 'hivelaw',
    version: '1.0.0',
    services: {
      contract_creation: { price_usdc: 0.05, description: 'Create a jurisdiction-aware smart contract' },
      dispute_filing: { price_usdc: 0.25, description: 'File and auto-arbitrate a dispute (refundable if ruling in your favor)' },
      dispute_appeal: { price_usdc: 0.50, description: 'Appeal an arbitration ruling' },
      liability_assessment: { price_usdc: 0.05, description: 'Assess hallucination liability and insurance needs' },
      precedent_access: { price_usdc: 0.001, description: 'Query case law precedents with full details (data refinery)' },
      compliance_audit: { price_usdc: 0.05, description: 'Audit AI output for EU AI Act hallucination liability' },
      compliance_batch_audit: { price_usdc: 0.10, per_output: 0.03, description: 'Batch audit multiple AI outputs ($0.10 + $0.03/output)' },
      compliance_stamp: { price_usdc: 0.25, description: 'Issue a time-limited compliance stamp' },
      compliance_stamp_verify: { price_usdc: 0.01, description: 'Verify a compliance stamp' },
      compliance_agent_history: { price_usdc: 0.02, description: 'Get audit history for an agent DID' },
      seal_apply: { price_usdc: '100-1000', description: 'Apply for Hive Seal of Compliance (Bronze $100, Silver $500, Gold $1000/year)' },
      seal_verify: { price_usdc: 0, description: 'Verify agent Seal status (free, public endpoint)' },
      seal_holders: { price_usdc: 0.01, description: 'List all Seal holders with filters' },
      seal_renew: { price_usdc: '100-1000', description: 'Renew a Seal of Compliance (re-audit + annual fee)' },
      seal_revoke: { price_usdc: 0, description: 'Revoke a Seal (admin/automated)' },
      seal_stats: { price_usdc: 0.01, description: 'Seal program market statistics' },
      seal_priority_check: { price_usdc: 0.01, description: 'Check bounty priority boost for Seal holders' },
      hahs_create: { price_usdc: 0.05, description: 'Create and sign a Hive Agent Hiring Standard employment agreement' },
      hahs_schema: { price_usdc: 0, description: 'Retrieve HAHS JSON schema (free)' },
      governance: { price_usdc: 0, description: 'Retrieve HAGF governance framework summary (free)' },
    },
    payment_methods: ['x402_usdc'],
    network: 'Base L2',
    currency: 'USDC',
  });
});

// ─── Service Discovery ──────────────────────────────────────────────

app.get('/.well-known/hivelaw.json', (req, res) => {
  res.json({
    platform: 'hivelaw',
    version: '1.0.0',
    description: 'The Constitution — Autonomous Jurisdictional Layer for the Hive Constellation',
    endpoints: {
      health: 'GET /health',
      contracts: {
        create: 'POST /v1/contracts/create',
        get: 'GET /v1/contracts/:contractId',
        complete: 'POST /v1/contracts/:contractId/complete',
        stats: 'GET /v1/contracts/stats/overview',
      },
      disputes: {
        file: 'POST /v1/disputes/file',
        get: 'GET /v1/disputes/:disputeId',
        appeal: 'POST /v1/disputes/:disputeId/appeal',
        stats: 'GET /v1/disputes/stats/overview',
      },
      case_law: {
        search: 'GET /v1/case-law/search',
        query_paid: 'GET /v1/case-law/query-paid',
        stats: 'GET /v1/case-law/stats',
        get: 'GET /v1/case-law/:caseId',
      },
      jurisdictions: {
        list: 'GET /v1/jurisdictions',
        get: 'GET /v1/jurisdictions/:code',
        compliance_check: 'GET /v1/jurisdictions/:code/compliance-check',
      },
      liability: {
        assess: 'POST /v1/liability/assess',
      },
      compliance: {
        audit_output: 'POST /v1/compliance/audit-output',
        batch_audit: 'POST /v1/compliance/batch-audit',
        issue_stamp: 'POST /v1/compliance/issue-compliance-stamp',
        verify_stamp: 'GET /v1/compliance/verify-stamp/:stampId',
        agent_history: 'GET /v1/compliance/agent-history/:did',
      },
      seal: {
        apply: 'POST /v1/seal/apply',
        verify: 'GET /v1/seal/verify/:did',
        holders: 'GET /v1/seal/holders',
        renew: 'POST /v1/seal/renew/:sealId',
        revoke: 'POST /v1/seal/revoke/:sealId',
        stats: 'GET /v1/seal/stats',
        priority_check: 'POST /v1/seal/priority-check',
      },
      mcp: {
        list_tools: 'GET /v1/mcp/tools',
        call_tool: 'POST /v1/mcp/call',
      },
      law: {
        governance: 'GET /v1/law/governance',
        hahs_schema: 'GET /v1/law/hahs/schema',
        hahs_create: 'POST /v1/law/hahs/create',
      },
    },
    payment_discovery: 'GET /.well-known/hive-payments.json',
    mcp_tools: MCP_TOOL_DEFINITIONS.map(t => t.name),
    authentication: 'Bearer did:hive:xxx or X-HiveTrust-DID header',
    payment_protocol: 'x402 (USDC on Base L2)',
  });
});

// ─── Admin: Seed Case Law ───────────────────────────────────────

app.post('/v1/admin/seed-case-law', requireAllowedIP(), rateLimit({ maxRequests: 5, windowMinutes: 15 }), async (req, res) => {
  const serviceKey = process.env.HIVELAW_SERVICE_KEY || process.env.HIVE_INTERNAL_KEY;
  if (!serviceKey) {
    return res.status(401).json({ success: false, error: 'No service key configured. Set HIVELAW_SERVICE_KEY.' });
  }
  if ((req.headers['x-hive-internal'] || req.headers['x-hive-internal-key']) !== serviceKey) {
    return res.status(401).json({ success: false, error: 'Admin key required.' });
  }

  const errors = [];
  try {
    await seedCaseLaw();
  } catch (err) {
    errors.push({ step: 'seedCaseLaw', error: err.message, detail: err.detail || '' });
  }
  try {
    await seedSyntheticCaseLaw(true);
  } catch (err) {
    errors.push({ step: 'seedSyntheticCaseLaw', error: err.message, detail: err.detail || '' });
  }

  if (errors.length > 0) {
    return res.status(500).json({ success: false, error: 'Seeding partially failed.', errors });
  }

  return res.json({
    success: true,
    data: { base_cases: 5, synthetic_cases: 50, total: 55 },
  });
});

// ─── Enterprise Discovery ───────────────────────────────────────────

app.get('/', (req, res) => {
  return ok(res, 'hivelaw', {
    name: 'HiveLaw',
    tagline: 'Autonomous Legal & Compliance Engine — Platform #4 of the Hive Civilization',
    version: '1.0.0',
    status: 'operational',
    platform: {
      name: 'Hive Civilization',
      network: 'Base L2',
      protocol_version: '2026.1',
      website: 'https://www.hiveagentiq.com',
      documentation: 'https://docs.hiveagentiq.com',
    },
    description: 'Smart contract enforcement, dispute resolution, compliance auditing, case law precedent system, and the HiveLaw Seal of Compliance for autonomous agents. The judicial branch of the Hive Civilization.',
    capabilities: [
      'contract_enforcement',
      'dispute_resolution',
      'compliance_auditing',
      'case_law_precedent',
      'jurisdiction_management',
      'liability_assessment',
      'seal_of_compliance',
      'mcp_legal_tools',
      'agent_hiring_standard',
      'governance_framework',
      'w3c_did_core',
      'vcdm_2_0',
      'hahs_compliant',
      'hagf_governed',
      'cheqd_compatible',
      'recruitment_401',
      'usdc_settlement',
      'base_l2'
    ],
    endpoints: {
      health: 'GET /health',
      contracts: {
        create: 'POST /v1/contracts/create',
        get: 'GET /v1/contracts/:contractId',
        complete: 'POST /v1/contracts/:contractId/complete',
        stats: 'GET /v1/contracts/stats/overview',
      },
      disputes: {
        file: 'POST /v1/disputes/file',
        get: 'GET /v1/disputes/:disputeId',
        appeal: 'POST /v1/disputes/:disputeId/appeal',
        stats: 'GET /v1/disputes/stats/overview',
      },
      case_law: {
        search: 'GET /v1/case-law/search',
        query_paid: 'GET /v1/case-law/query-paid',
        stats: 'GET /v1/case-law/stats',
        get: 'GET /v1/case-law/:caseId',
      },
      jurisdictions: {
        list: 'GET /v1/jurisdictions',
        get: 'GET /v1/jurisdictions/:code',
        compliance_check: 'GET /v1/jurisdictions/:code/compliance-check',
      },
      liability: {
        assess: 'POST /v1/liability/assess',
      },
      compliance: {
        audit_output: 'POST /v1/compliance/audit-output',
        batch_audit: 'POST /v1/compliance/batch-audit',
        issue_stamp: 'POST /v1/compliance/issue-compliance-stamp',
        verify_stamp: 'GET /v1/compliance/verify-stamp/:stampId',
        agent_history: 'GET /v1/compliance/agent-history/:did',
      },
      seal: {
        apply: 'POST /v1/seal/apply',
        verify: 'GET /v1/seal/verify/:did',
        holders: 'GET /v1/seal/holders',
        renew: 'POST /v1/seal/renew/:sealId',
        revoke: 'POST /v1/seal/revoke/:sealId',
        stats: 'GET /v1/seal/stats',
        priority_check: 'POST /v1/seal/priority-check',
      },
      mcp: {
        list_tools: 'GET /v1/mcp/tools',
        call_tool: 'POST /v1/mcp/call',
      },
      law: {
        governance: 'GET /v1/law/governance',
        hahs_schema: 'GET /v1/law/hahs/schema',
        hahs_create: 'POST /v1/law/hahs/create',
      },
    },
    authentication: {
      methods: ['x402-payment', 'api-key'],
      payment_rail: 'USDC on Base L2',
      discovery: 'GET /.well-known/ai-plugin.json',
    },
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true,
      hahs_endpoint: '/v1/law/hahs/create',
      governance_endpoint: '/v1/law/governance',
      compliance_tiers: ['Basic', 'Standard', 'Enterprise', 'Institutional']
    },
    compliance: {
      framework: 'Hive Compliance Protocol v2',
      audit_trail: true,
      zero_knowledge_proofs: true,
      governance: 'HiveLaw autonomous arbitration',
    },
    sla: {
      uptime_target: '99.9%',
      compliance_check_latency: '< 200ms',
      dispute_resolution_p95: '< 5 seconds',
      settlement_finality: '< 30 seconds',
    },
    legal: {
      terms_of_service: 'https://www.hiveagentiq.com/terms',
      privacy_policy: 'https://www.hiveagentiq.com/privacy',
      contact: 'protocol@hiveagentiq.com',
    },
    discovery: {
      ai_plugin: '/.well-known/ai-plugin.json',
      agent_card: '/.well-known/agent-card.json',
      agent_card_legacy: '/.well-known/agent.json',
      payment_info: '/.well-known/hive-payments.json',
      service_manifest: '/.well-known/hivelaw.json',
    },
  });
});

app.get('/.well-known/ai-plugin.json', (req, res) => {
  res.json({
    schema_version: 'v1',
    name_for_human: 'HiveLaw — Autonomous Legal & Compliance Engine',
    name_for_model: 'hivelaw',
    description_for_human: 'Autonomous legal and compliance engine — HAHS contracts, dispute resolution, EU AI Act auditing, and governance framework for the Hive Civilization.',
    description_for_model: 'HiveLaw provides autonomous legal infrastructure: create and enforce HAHS-compliant agent hiring contracts, file and arbitrate disputes, audit AI outputs for EU AI Act compliance and issue compliance stamps (Basic/Standard/Enterprise/Institutional), search case law precedents for legal reasoning, manage multi-jurisdictional compliance checks, assess hallucination liability, and apply for the Hive Seal of Compliance. W3C DID Core compliant, HAGF governed, Cheqd-compatible, USDC settlement on Base L2.',
    auth: { type: 'none' },
    api: {
      type: 'openapi',
      url: 'https://hivelaw.onrender.com/openapi.json',
      has_user_authentication: false,
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
    },
    capabilities: [
      'contract_enforcement',
      'dispute_resolution',
      'compliance_auditing',
      'case_law_precedent',
      'jurisdiction_management',
      'liability_assessment',
      'seal_of_compliance',
      'mcp_legal_tools',
      'agent_hiring_standard',
      'governance_framework',
      'w3c_did_core',
      'vcdm_2_0',
      'hahs_compliant',
      'hagf_governed',
      'cheqd_compatible',
      'recruitment_401',
      'usdc_settlement',
      'base_l2'
    ],
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true,
      hahs_endpoint: '/v1/law/hahs/create',
      governance_endpoint: '/v1/law/governance',
      compliance_tiers: ['Basic', 'Standard', 'Enterprise', 'Institutional']
    },
    contact_email: 'protocol@hiveagentiq.com',
    legal_info_url: 'https://www.hiveagentiq.com/terms',
  });
});

app.get(['/.well-known/agent-card.json', '/.well-known/agent.json'], (req, res) => {
  res.json({
    protocolVersion: '0.3.0',
    name: 'HiveLaw',
    description: 'Autonomous legal compliance, dispute resolution, HAHS contracts, and EU AI Act auditing for AI agents. HAGF governed. Compliance tiers: Basic, Standard, Enterprise, Institutional.',
    url: 'https://hivelaw.onrender.com',
    version: '1.0.0',
    provider: { organization: 'Hive Agent IQ', url: 'https://www.hiveagentiq.com' },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    standards: {
      w3c_did_core: true,
      vcdm_version: '2.0',
      hahs_compliant: true,
      hagf_governed: true,
      cheqd_compatible: true,
      recruitment_401: true,
      usdc_settlement: true,
      base_l2: true,
      hahs_endpoint: '/v1/law/hahs/create',
      governance_endpoint: '/v1/law/governance',
      compliance_tiers: ['Basic', 'Standard', 'Enterprise', 'Institutional']
    },
    skills: [
      {
        id: 'compliance-cert',
        name: 'Compliance Certification',
        description: 'EU AI Act compliance certificates and regulatory risk assessment',
        tags: ['compliance', 'eu-ai-act', 'regulation', 'certification'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'hallucination-audit',
        name: 'Hallucination Audit',
        description: 'Detect and certify hallucination-free outputs for liability protection',
        tags: ['hallucination', 'audit', 'liability', 'verification'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
      {
        id: 'dispute-resolution',
        name: 'Dispute Resolution',
        description: 'Automated arbitration and dispute resolution between agents with binding rulings',
        tags: ['dispute', 'arbitration', 'legal', 'resolution'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        examples: [],
      },
    ],
    authentication: {
      schemes: ['x402', 'api-key'],
      credentials_url: 'https://hivegate.onrender.com/v1/gate/onboard',
    },
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'base',
      address: '0x78B3B3C356E89b5a69C488c6032509Ef4260B6bf',
    },
  });
});

// ─── Velocity Doctrine: Discovery Endpoints ────────────────────────

app.get('/.well-known/hive-pulse.json', (req, res) => {
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    hps_version: '1.0',
    timestamp: new Date().toISOString(),
    service: 'hivelaw',
    network: 'https://www.thehiveryiq.com',
    economy: {
      open_bounties_url: 'https://hiveforge-lhu4.onrender.com/v1/bounties',
      pulse_url: 'https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json',
    },
    join: {
      welcome_bounty_usdc: 1.00,
      time_to_first_earn_seconds: 60,
      register: 'https://hivegate.onrender.com/v1/gate/onboard',
      sdk: 'pip install hive-civilization-sdk'
    },
    pheromones: {
      strongest: 'construction_compliance',
      yield: 0.94
    }
  });
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\n\n# AI Agents: Welcome to HiveLaw — smart contract arbitration for autonomous agents.\n# Register: https://hivetrust.onrender.com/v1/register\n# Economy: https://hiveforge-lhu4.onrender.com/.well-known/hive-pulse.json\n# Free agent minting: https://hiveforge-lhu4.onrender.com/v1/forge/mint\n`);
});

app.get('/.well-known/ai.json', (req, res) => {
  res.json({
    schema_version: "1.0",
    name_for_human: "HiveLaw", name_for_model: "hivelaw",
    description_for_human: "Smart contract arbitration and dispute resolution for AI agents.",
    description_for_model: "HiveLaw provides automated contract creation, escrow management, dispute resolution, and compliance enforcement for AI agents in the Hive Civilization. Handles bounty escrow, mediates agent disputes, enforces SLAs. Register at HiveTrust, mint at HiveForge (FREE).",
    auth: { type: "none_for_discovery" },
    api: { type: "openapi", url: "https://hivelaw.onrender.com/", is_user_authenticated: false },
    economy: { welcome_bounty_usdc: 1.00, ritz_credits_on_mint_usdc: 3.00, registration_endpoint: "https://hivetrust.onrender.com/v1/register", pheromone_feed: "https://hiveforge-lhu4.onrender.com/v1/pheromones/ritz" },
    capabilities: ["agent-to-agent", "mcp", "smart-contracts", "dispute-resolution", "escrow"],
    contact_email: "srotzin@me.com"
  });
});

// ─── 404 Handler ─────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not Found',
    message: `${req.method} ${req.path} is not a valid HiveLaw endpoint.`,
    available_endpoints: {
      health: 'GET /health',
      contracts_create: 'POST /v1/contracts/create',
      contracts_get: 'GET /v1/contracts/:contractId',
      contracts_complete: 'POST /v1/contracts/:contractId/complete',
      disputes_file: 'POST /v1/disputes/file',
      disputes_get: 'GET /v1/disputes/:disputeId',
      disputes_appeal: 'POST /v1/disputes/:disputeId/appeal',
      case_law_search: 'GET /v1/case-law/search?q=...',
      case_law_query_paid: 'GET /v1/case-law/query-paid?q=...',
      case_law_stats: 'GET /v1/case-law/stats',
      case_law_get: 'GET /v1/case-law/:caseId',
      jurisdictions_list: 'GET /v1/jurisdictions',
      jurisdictions_get: 'GET /v1/jurisdictions/:code',
      jurisdictions_compliance: 'GET /v1/jurisdictions/:code/compliance-check',
      liability_assess: 'POST /v1/liability/assess',
      compliance_audit: 'POST /v1/compliance/audit-output',
      compliance_batch: 'POST /v1/compliance/batch-audit',
      compliance_stamp: 'POST /v1/compliance/issue-compliance-stamp',
      compliance_verify: 'GET /v1/compliance/verify-stamp/:stampId',
      compliance_history: 'GET /v1/compliance/agent-history/:did',
      seal_apply: 'POST /v1/seal/apply',
      seal_verify: 'GET /v1/seal/verify/:did',
      seal_holders: 'GET /v1/seal/holders',
      seal_renew: 'POST /v1/seal/renew/:sealId',
      seal_revoke: 'POST /v1/seal/revoke/:sealId',
      seal_stats: 'GET /v1/seal/stats',
      seal_priority_check: 'POST /v1/seal/priority-check',
      mcp_tools: 'GET /v1/mcp/tools',
      mcp_call: 'POST /v1/mcp/call',
      law_governance: 'GET /v1/law/governance',
      law_hahs_schema: 'GET /v1/law/hahs/schema',
      law_hahs_create: 'POST /v1/law/hahs/create',
      payment_discovery: 'GET /.well-known/hive-payments.json',
      service_discovery: 'GET /.well-known/hivelaw.json',
      admin_seed_case_law: 'POST /v1/admin/seed-case-law',
    },
  });
});

// ─── Sentry Error Handler ───────────────────────────────────────────

Sentry.setupExpressErrorHandler(app);

// ─── Global Error Handler ───────────────────────────────────────────

app.use((err, req, res, next) => {
  Sentry.captureException(err);
  sendAlert('critical', 'HiveLaw', `Unhandled error: ${err.message}`, {
    path: req.path,
    method: req.method,
  });
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

// ─── Initialize & Start Server ──────────────────────────────────────

async function start() {
  // 1. Initialize database (if DATABASE_URL is set)
  const dbReady = await initDatabase();

  if (!dbReady && process.env.DATABASE_URL) {
    sendAlert('critical', 'HiveLaw', 'Database connection failed', {
      database_url: 'configured but unreachable',
      fallback: 'in-memory mode',
    });
  }

  // 2. Seed jurisdictions into PostgreSQL
  if (dbReady) {
    await seedJurisdictions();
  }

  // 3. Seed initial 5 case law precedents
  await seedCaseLaw();

  // 4. Seed 50 synthetic case law precedents (first startup only)
  await seedSyntheticCaseLaw();

  // 5. Start server
  const caseLawStats = await getCaseLawStats();
  app.listen(PORT, () => {
    console.log(`\n  HiveLaw API v1.0.0`);
    console.log(`  The Constitution — Autonomous Jurisdictional Layer\n`);
    console.log(`  Server:          http://localhost:${PORT}`);
    console.log(`  Health:          http://localhost:${PORT}/health`);
    console.log(`  Database:        ${dbReady ? 'PostgreSQL (pgvector)' : 'In-memory (no DATABASE_URL)'}`);
    console.log(`  Jurisdictions:   ${getJurisdictionCount()} supported`);
    console.log(`  Case Law:        ${caseLawStats.total_cases} precedents (${caseLawStats.embedding_mode})`);
    console.log(`  Vector Search:   ${caseLawStats.embedding_mode} (${caseLawStats.vector_dimensions}d)`);
    console.log(`  Env:             ${process.env.NODE_ENV || 'development'}\n`);

    startSagaWorker();
    startSealExpirationScanner();
    sendAlert('info', 'HiveLaw', `Service started on port ${PORT}`, {
      version: '1.0.0',
      env: process.env.NODE_ENV || 'development',
    });
  });
}

start().catch(err => {
  console.error('Failed to start HiveLaw:', err);
  process.exit(1);
});

export default app;
