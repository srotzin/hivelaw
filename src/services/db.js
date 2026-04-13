import pg from 'pg';
const { Pool } = pg;

let pool = null;
let dbAvailable = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 20,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });
}

export function isDbAvailable() {
  return dbAvailable;
}

export async function initDatabase() {
  if (!pool) {
    console.log('  [DB] No DATABASE_URL set — running in-memory mode');
    return false;
  }

  try {
    // Test connection
    await pool.query('SELECT 1');

    // Create pgvector extension
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Create hivelaw schema
    await pool.query('CREATE SCHEMA IF NOT EXISTS hivelaw');

    // Create contracts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hivelaw.contracts (
        contract_id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('service_agreement', 'escrow', 'insurance', 'licensing', 'custom')),
        provider_did TEXT NOT NULL,
        consumer_did TEXT NOT NULL,
        jurisdiction TEXT NOT NULL,
        terms JSONB NOT NULL DEFAULT '{}',
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'disputed', 'terminated')),
        transaction_ids TEXT[] DEFAULT '{}',
        insurance_policy_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_contracts_provider ON hivelaw.contracts(provider_did)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_contracts_consumer ON hivelaw.contracts(consumer_did)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_contracts_jurisdiction ON hivelaw.contracts(jurisdiction)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_contracts_status ON hivelaw.contracts(status)');

    // Create disputes table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hivelaw.disputes (
        dispute_id TEXT PRIMARY KEY,
        contract_id TEXT REFERENCES hivelaw.contracts(contract_id),
        filed_by TEXT NOT NULL,
        filed_against TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('hallucination', 'non_performance', 'overcharge', 'data_breach', 'unauthorized_action')),
        severity TEXT DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        evidence JSONB NOT NULL DEFAULT '{}',
        arbitration JSONB NOT NULL DEFAULT '{}',
        status TEXT DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'appealed', 'closed')),
        filed_at TIMESTAMPTZ DEFAULT NOW(),
        resolved_at TIMESTAMPTZ
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_disputes_category ON hivelaw.disputes(category)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_disputes_status ON hivelaw.disputes(status)');

    // Create case_law table with pgvector
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hivelaw.case_law (
        case_id TEXT PRIMARY KEY,
        dispute_id TEXT REFERENCES hivelaw.disputes(dispute_id),
        category TEXT NOT NULL,
        jurisdiction TEXT NOT NULL,
        summary TEXT NOT NULL,
        ruling_summary TEXT NOT NULL,
        key_factors TEXT[] DEFAULT '{}',
        outcome TEXT NOT NULL,
        damages_usdc NUMERIC(10, 4) DEFAULT 0,
        embedding vector(128),
        source TEXT DEFAULT 'organic' CHECK (source IN ('organic', 'synthetic', 'imported')),
        cited_by TEXT[] DEFAULT '{}',
        jurisdiction_applicability TEXT[] DEFAULT '{}',
        filed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query('CREATE INDEX IF NOT EXISTS idx_caselaw_category ON hivelaw.case_law(category)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_caselaw_jurisdiction ON hivelaw.case_law(jurisdiction)');

    // Create ivfflat index for pgvector — only if rows exist (ivfflat requires data)
    const { rows: caseCount } = await pool.query('SELECT COUNT(*) as cnt FROM hivelaw.case_law');
    if (parseInt(caseCount[0].cnt, 10) >= 100) {
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_caselaw_embedding
        ON hivelaw.case_law USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
      `).catch(() => {}); // Ignore if already exists or not enough rows
    }

    // Create jurisdictions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hivelaw.jurisdictions (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        parent TEXT,
        regulations JSONB NOT NULL DEFAULT '{}',
        supported BOOLEAN DEFAULT true,
        compliance_requirements TEXT[] DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Create shared tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.audit_log (
        id SERIAL PRIMARY KEY,
        from_platform TEXT NOT NULL,
        to_platform TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        did TEXT,
        method TEXT NOT NULL DEFAULT 'GET',
        status_code INTEGER,
        success BOOLEAN DEFAULT true,
        error_message TEXT,
        duration_ms INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.rate_limits (
        did TEXT NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        request_count INTEGER DEFAULT 1,
        PRIMARY KEY (did, window_start)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.sagas (
        saga_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        state JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'in_progress',
        steps_completed JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
      )
    `);

    dbAvailable = true;
    console.log('  [DB] PostgreSQL connected and schema initialized');
    return true;
  } catch (err) {
    console.error('  [DB] PostgreSQL initialization failed — falling back to in-memory:', err.message);
    dbAvailable = false;
    return false;
  }
}

export async function checkHealth() {
  if (!pool) return { connected: false, mode: 'in-memory' };
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    return { connected: true, mode: 'postgresql', latency_ms: Date.now() - start };
  } catch {
    return { connected: false, mode: 'postgresql', error: 'connection_failed' };
  }
}

export default pool;
