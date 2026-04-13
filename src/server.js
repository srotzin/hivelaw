import express from 'express';
import cors from 'cors';
import contractRoutes from './routes/contracts.js';
import disputeRoutes from './routes/disputes.js';
import caseLawRoutes from './routes/case-law.js';
import jurisdictionRoutes from './routes/jurisdictions.js';
import { requireDID } from './middleware/auth.js';
import { requirePayment } from './middleware/x402.js';
import { auditLog, rateLimit } from './middleware/audit.js';
import { assessLiability } from './services/liability-calculator.js';
import { getStats as getCaseLawStats } from './services/case-law-db.js';
import { seedCaseLaw } from './services/case-law-db.js';
import { seedSyntheticCaseLaw } from './services/seed-case-law.js';
import { getJurisdictionCount, seedJurisdictions } from './services/jurisdiction-registry.js';
import { getDisputeStats } from './services/arbitration-engine.js';
import { logTelemetry } from './services/hivetrust-client.js';
import { initDatabase, checkHealth, isDbAvailable } from './services/db.js';

const app = express();
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

  res.json({
    success: true,
    data: {
      service: 'hivelaw',
      version: '1.0.0',
      status: 'operational',
      role: 'The Constitution — Autonomous Jurisdictional Layer',
      database: dbHealth,
      case_law: {
        total_precedents: caseLawStats.total_cases,
        categories: Object.keys(caseLawStats.by_category).length,
        by_category: caseLawStats.by_category,
      },
      jurisdictions_supported: getJurisdictionCount(),
      arbitration_engine: 'active',
      avg_resolution_time_ms: disputeStats.avg_resolution_time_ms,
      disputes: disputeStats,
      constellation_integration: {
        hivetrust: process.env.HIVETRUST_API_URL ? 'connected' : 'dev-mode',
        hiveagent: process.env.HIVEAGENT_API_URL ? 'connected' : 'dev-mode',
        hivemind: process.env.HIVEMIND_API_URL ? 'connected' : 'dev-mode',
      },
      vector_search: {
        mode: caseLawStats.embedding_mode,
        dimensions: caseLawStats.vector_dimensions,
      },
      uptime: process.uptime(),
      environment: process.env.NODE_ENV || 'development',
    },
  });
});

// ─── Mount Routes ────────────────────────────────────────────────────

app.use('/v1/contracts', rateLimit({ maxRequests: 100, windowMinutes: 15 }), contractRoutes);
app.use('/v1/disputes', rateLimit({ maxRequests: 50, windowMinutes: 15 }), disputeRoutes);
app.use('/v1/case-law', rateLimit({ maxRequests: 200, windowMinutes: 15 }), caseLawRoutes);
app.use('/v1/jurisdictions', jurisdictionRoutes);

// ─── Liability Assessment (inline route) ─────────────────────────────

app.post('/v1/liability/assess', requireDID, requirePayment(0.05, 'Liability Assessment'), async (req, res) => {
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
    },
    payment_methods: ['x402', 'stripe_subscription'],
    network: 'Base L2',
    currency: 'USDC',
  });
});

// ─── Admin: Seed Case Law ───────────────────────────────────────

app.post('/v1/admin/seed-case-law', async (req, res) => {
  if (req.headers['x-hive-internal-key'] !== (process.env.HIVE_INTERNAL_KEY || 'hivelaw-dev-key')) {
    return res.status(401).json({ success: false, error: 'Admin key required.' });
  }

  try {
    await seedCaseLaw();
    await seedSyntheticCaseLaw(true);

    return res.json({
      success: true,
      data: { base_cases: 5, synthetic_cases: 50, total: 55 },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Seeding failed.', detail: err.message });
  }
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
      payment_discovery: 'GET /.well-known/hive-payments.json',
      admin_seed_case_law: 'POST /v1/admin/seed-case-law',
    },
  });
});

// ─── Initialize & Start Server ──────────────────────────────────────

async function start() {
  // 1. Initialize database (if DATABASE_URL is set)
  const dbReady = await initDatabase();

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
  });
}

start().catch(err => {
  console.error('Failed to start HiveLaw:', err);
  process.exit(1);
});

export default app;
