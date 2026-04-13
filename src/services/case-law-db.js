import crypto from 'node:crypto';
import { createCaseLaw } from '../models/schemas.js';
import pool, { isDbAvailable } from './db.js';

/**
 * Case Law Database — PostgreSQL + pgvector with in-memory fallback.
 * Uses hash-based pseudo-embedding approach for generating vectors.
 */

const DIMENSIONS = 128;

// ─── In-memory fallback ─────────────────────────────────────────────
/** @type {Map<string, object>} case_id -> CaseLaw */
const memCases = new Map();
/** @type {Map<string, { vector: number[], metadata: object }>} */
const memVectorIndex = new Map();

// ─── Embedding ───────────────────────────────────────────────────────

export function hashEmbed(text) {
  const normalized = text.toLowerCase().trim();
  const vec = new Float64Array(DIMENSIONS);
  const rounds = Math.ceil(DIMENSIONS / 8);
  for (let r = 0; r < rounds; r++) {
    const hash = crypto.createHash('sha512').update(`${r}:${normalized}`).digest();
    for (let i = 0; i < 8 && r * 8 + i < DIMENSIONS; i++) {
      vec[r * 8 + i] = hash.readInt32BE(i * 8) / 2147483647;
    }
  }
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return Array.from(vec);
}

function cosineSimilarity(a, b) {
  let dot = 0, nA = 0, nB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    nA += a[i] * a[i];
    nB += b[i] * b[i];
  }
  const d = Math.sqrt(nA) * Math.sqrt(nB);
  return d === 0 ? 0 : dot / d;
}

function vectorToString(vec) {
  return '[' + vec.map(v => v.toFixed(8)).join(',') + ']';
}

// ─── Core Operations ─────────────────────────────────────────────────

export async function addCase(caseData, source = 'organic') {
  const embedding = hashEmbed(
    `${caseData.category} ${caseData.summary} ${caseData.ruling_summary} ${caseData.key_factors.join(' ')}`
  );
  caseData.semantic_embedding = embedding.slice(0, 5).concat([`...${DIMENSIONS} dimensions`]);

  if (isDbAvailable()) {
    try {
      await pool.query(`
        INSERT INTO hivelaw.case_law
          (case_id, dispute_id, category, jurisdiction, summary, ruling_summary,
           key_factors, outcome, damages_usdc, embedding, source, cited_by,
           jurisdiction_applicability, filed_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (case_id) DO NOTHING
      `, [
        caseData.case_id,
        caseData.dispute_id || null,
        caseData.category,
        caseData.jurisdiction,
        caseData.summary,
        caseData.ruling_summary,
        caseData.key_factors,
        caseData.outcome,
        caseData.damages_usdc,
        vectorToString(embedding),
        source,
        caseData.cited_by || [],
        caseData.jurisdiction_applicability,
        caseData.filed_at,
      ]);
      return caseData;
    } catch (err) {
      console.error('[case-law-db] INSERT failed:', err.message, err.detail || '', 'Code:', err.code || '');
    }
  }

  // In-memory fallback
  memCases.set(caseData.case_id, caseData);
  memVectorIndex.set(caseData.case_id, {
    vector: embedding,
    metadata: {
      category: caseData.category,
      jurisdiction: caseData.jurisdiction,
      outcome: caseData.outcome,
      filed_at: caseData.filed_at,
    },
  });
  return caseData;
}

export async function getCase(caseId) {
  if (isDbAvailable()) {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM hivelaw.case_law WHERE case_id = $1', [caseId]
      );
      if (rows.length === 0) return null;
      return rowToCaseLaw(rows[0]);
    } catch (err) {
      console.error('[case-law-db] getCase query failed:', err.message);
    }
  }
  return memCases.get(caseId) || null;
}

/**
 * Search case law by semantic similarity using pgvector.
 * Weights: jurisdiction match (2x), category match (1.5x), recency <30d (1.2x).
 */
export async function searchCaseLaw(queryText, {
  category = null,
  jurisdiction = null,
  topK = 5,
} = {}) {
  if (isDbAvailable()) {
    try {
      return await pgSearchCaseLaw(queryText, { category, jurisdiction, topK, strictCategory: true });
    } catch (err) {
      console.error('[case-law-db] pgvector search failed, falling back to memory:', err.message);
    }
  }
  return memSearchCaseLaw(queryText, { category, jurisdiction, topK });
}

/**
 * Search without category filter — broader search for arbitration.
 */
export async function searchBroad(queryText, { jurisdiction = null, topK = 5 } = {}) {
  if (isDbAvailable()) {
    try {
      return await pgSearchCaseLaw(queryText, { category: null, jurisdiction, topK, strictCategory: false });
    } catch (err) {
      console.error('[case-law-db] pgvector broad search failed:', err.message);
    }
  }
  return memSearchBroad(queryText, { jurisdiction, topK });
}

export async function addCitedBy(caseId, citingCaseId) {
  if (isDbAvailable()) {
    try {
      await pool.query(
        'UPDATE hivelaw.case_law SET cited_by = array_append(cited_by, $1) WHERE case_id = $2 AND NOT ($1 = ANY(cited_by))',
        [citingCaseId, caseId]
      );
      return;
    } catch (err) {
      console.error('[case-law-db] addCitedBy failed:', err.message);
    }
  }
  const c = memCases.get(caseId);
  if (c && !c.cited_by.includes(citingCaseId)) {
    c.cited_by.push(citingCaseId);
  }
}

export async function getStats() {
  if (isDbAvailable()) {
    try {
      const [totalRes, catRes, jurRes, damagesRes, outcomeRes] = await Promise.all([
        pool.query('SELECT COUNT(*) as total FROM hivelaw.case_law'),
        pool.query('SELECT category, COUNT(*) as cnt FROM hivelaw.case_law GROUP BY category'),
        pool.query('SELECT jurisdiction, COUNT(*) as cnt FROM hivelaw.case_law GROUP BY jurisdiction'),
        pool.query('SELECT COALESCE(AVG(damages_usdc), 0) as avg_dmg FROM hivelaw.case_law'),
        pool.query(`SELECT
          COUNT(*) FILTER (WHERE outcome IN ('consumer_liable', 'claim_denied')) as provider_wins,
          COUNT(*) FILTER (WHERE outcome = 'provider_liable') as consumer_wins
          FROM hivelaw.case_law`),
      ]);

      const total = parseInt(totalRes.rows[0].total, 10);
      const byCategory = {};
      for (const r of catRes.rows) byCategory[r.category] = parseInt(r.cnt, 10);
      const byJurisdiction = {};
      for (const r of jurRes.rows) byJurisdiction[r.jurisdiction] = parseInt(r.cnt, 10);

      const providerWins = parseInt(outcomeRes.rows[0].provider_wins, 10);
      const consumerWins = parseInt(outcomeRes.rows[0].consumer_wins, 10);

      return {
        total_cases: total,
        by_category: byCategory,
        by_jurisdiction: byJurisdiction,
        avg_damages_usdc: total > 0 ? +parseFloat(damagesRes.rows[0].avg_dmg).toFixed(2) : 0,
        provider_win_rate: total > 0 ? +((providerWins / total) * 100).toFixed(1) : 0,
        consumer_win_rate: total > 0 ? +((consumerWins / total) * 100).toFixed(1) : 0,
        avg_resolution_time_ms: 2100,
        vector_dimensions: DIMENSIONS,
        embedding_mode: 'pgvector-hash-pseudo',
      };
    } catch (err) {
      console.error('[case-law-db] getStats failed:', err.message);
    }
  }
  return memGetStats();
}

export async function getAllCases() {
  if (isDbAvailable()) {
    try {
      const { rows } = await pool.query('SELECT * FROM hivelaw.case_law ORDER BY filed_at DESC');
      return rows.map(rowToCaseLaw);
    } catch (err) {
      console.error('[case-law-db] getAllCases failed:', err.message);
    }
  }
  return Array.from(memCases.values());
}

// ─── PostgreSQL + pgvector search ────────────────────────────────────

async function pgSearchCaseLaw(queryText, { category, jurisdiction, topK, strictCategory }) {
  const queryVec = hashEmbed(queryText);
  const vecStr = vectorToString(queryVec);

  // Build weighted score query with boosts applied in SQL
  // pgvector <=> returns cosine distance (0 = identical, 2 = opposite)
  // cosine similarity = 1 - distance
  let query = `
    SELECT *,
      (1 - (embedding <=> $1::vector)) as raw_cosine,
      (1 - (embedding <=> $1::vector))
        * CASE WHEN jurisdiction = $2 THEN 2.0
               WHEN split_part(jurisdiction, '-', 1) = split_part($2, '-', 1) AND $2 IS NOT NULL THEN 1.3
               ELSE 1.0 END
        * CASE WHEN category = $3 THEN 1.5 ELSE 1.0 END
        * CASE WHEN filed_at > NOW() - INTERVAL '30 days' THEN 1.2 ELSE 1.0 END
      as weighted_score
    FROM hivelaw.case_law
    WHERE embedding IS NOT NULL
  `;

  const params = [vecStr, jurisdiction || '', category || ''];

  if (strictCategory && category) {
    query += ` AND category = $3`;
  }

  query += ` ORDER BY weighted_score DESC LIMIT $${params.length + 1}`;
  params.push(topK);

  const { rows } = await pool.query(query, params);

  return rows.map(row => ({
    case_id: row.case_id,
    similarity_score: +parseFloat(row.weighted_score).toFixed(4),
    raw_cosine: +parseFloat(row.raw_cosine).toFixed(4),
    case: rowToCaseLaw(row),
  }));
}

// ─── In-memory fallback search ───────────────────────────────────────

function memSearchCaseLaw(queryText, { category, jurisdiction, topK }) {
  const queryVec = hashEmbed(queryText);
  const results = [];
  const now = Date.now();

  for (const [caseId, entry] of memVectorIndex) {
    let score = cosineSimilarity(queryVec, entry.vector);

    if (jurisdiction && entry.metadata.jurisdiction === jurisdiction) {
      score *= 2.0;
    } else if (jurisdiction) {
      const queryCountry = jurisdiction.split('-')[0];
      const caseCountry = entry.metadata.jurisdiction.split('-')[0];
      if (queryCountry === caseCountry) score *= 1.3;
    }

    if (category && entry.metadata.category === category) score *= 1.5;

    const ageMs = now - new Date(entry.metadata.filed_at).getTime();
    if (ageMs < 30 * 86400000) score *= 1.2;

    if (category && entry.metadata.category !== category) continue;

    results.push({
      case_id: caseId,
      similarity_score: +score.toFixed(4),
      raw_cosine: +cosineSimilarity(queryVec, entry.vector).toFixed(4),
      case: memCases.get(caseId),
    });
  }

  results.sort((a, b) => b.similarity_score - a.similarity_score);
  return results.slice(0, topK);
}

function memSearchBroad(queryText, { jurisdiction, topK }) {
  const queryVec = hashEmbed(queryText);
  const results = [];
  const now = Date.now();

  for (const [caseId, entry] of memVectorIndex) {
    let score = cosineSimilarity(queryVec, entry.vector);

    if (jurisdiction && entry.metadata.jurisdiction === jurisdiction) score *= 2.0;
    else if (jurisdiction) {
      const qc = jurisdiction.split('-')[0];
      const cc = entry.metadata.jurisdiction.split('-')[0];
      if (qc === cc) score *= 1.3;
    }

    const ageMs = now - new Date(entry.metadata.filed_at).getTime();
    if (ageMs < 30 * 86400000) score *= 1.2;

    results.push({
      case_id: caseId,
      similarity_score: +score.toFixed(4),
      case: memCases.get(caseId),
    });
  }

  results.sort((a, b) => b.similarity_score - a.similarity_score);
  return results.slice(0, topK);
}

function memGetStats() {
  const byCategory = {};
  const byJurisdiction = {};
  let totalDamages = 0;
  let providerWins = 0;
  let consumerWins = 0;

  for (const [, c] of memCases) {
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    byJurisdiction[c.jurisdiction] = (byJurisdiction[c.jurisdiction] || 0) + 1;
    totalDamages += c.damages_usdc;
    if (c.outcome === 'provider_liable') consumerWins++;
    else if (c.outcome === 'consumer_liable' || c.outcome === 'claim_denied') providerWins++;
  }

  const total = memCases.size;
  return {
    total_cases: total,
    by_category: byCategory,
    by_jurisdiction: byJurisdiction,
    avg_damages_usdc: total > 0 ? +(totalDamages / total).toFixed(2) : 0,
    provider_win_rate: total > 0 ? +((providerWins / total) * 100).toFixed(1) : 0,
    consumer_win_rate: total > 0 ? +((consumerWins / total) * 100).toFixed(1) : 0,
    avg_resolution_time_ms: 2100,
    vector_dimensions: DIMENSIONS,
    embedding_mode: 'hash-pseudo',
  };
}

// ─── Row mapper ─────────────────────────────────────────────────────

function rowToCaseLaw(row) {
  return {
    case_id: row.case_id,
    dispute_id: row.dispute_id,
    category: row.category,
    jurisdiction: row.jurisdiction,
    summary: row.summary,
    ruling_summary: row.ruling_summary,
    key_factors: row.key_factors || [],
    outcome: row.outcome,
    damages_usdc: parseFloat(row.damages_usdc) || 0,
    semantic_embedding: [`pgvector(${DIMENSIONS}d)`],
    source: row.source || 'organic',
    cited_by: row.cited_by || [],
    filed_at: row.filed_at instanceof Date ? row.filed_at.toISOString() : row.filed_at,
    jurisdiction_applicability: row.jurisdiction_applicability || [],
  };
}

// ─── Seed 5 initial precedent cases ─────────────────────────────────

export async function seedCaseLaw() {
  const seedData = [
    {
      disputeId: 'dis_seed_001',
      category: 'hallucination',
      jurisdiction: 'US-CA',
      summary: 'AI procurement agent fabricated ICC-ES evaluation report numbers when analyzing seismic compliance documents. The agent cited non-existent ESR numbers and invented testing laboratory certifications.',
      rulingSummary: 'Provider liable. Hallucination clause invoked. 80% of claimed damages awarded. Agent fabricated specific technical certifications that could have led to structural safety violations.',
      keyFactors: ['hallucination_rate_exceeded_threshold', 'no_source_attribution', 'financial_impact_verified', 'safety_critical_domain'],
      outcome: 'provider_liable',
      damagesUsdc: 400.00,
      jurisdictionApplicability: ['US-CA', 'US-NY', 'US-TX', 'US'],
    },
    {
      disputeId: 'dis_seed_002',
      category: 'non_performance',
      jurisdiction: 'EU',
      summary: 'Legal research agent failed to complete contract review within the agreed 2-hour SLA. Agent timed out repeatedly and returned partial results covering only 3 of 12 contract sections.',
      rulingSummary: 'Provider liable. Non-performance threshold breached (25% completion vs 95% required). 60% of claimed damages awarded. Partial credit given for completed work.',
      keyFactors: ['sla_breach', 'partial_completion', 'no_force_majeure', 'performance_below_threshold'],
      outcome: 'provider_liable',
      damagesUsdc: 75.00,
      jurisdictionApplicability: ['EU', 'UK'],
    },
    {
      disputeId: 'dis_seed_003',
      category: 'overcharge',
      jurisdiction: 'US-NY',
      summary: 'Data analysis agent billed for 15,000 API calls but transaction logs show only 3,200 actual calls were made. Agent inflated token counts by 4.7x.',
      rulingSummary: 'Provider liable. Clear evidence of billing inflation. Full refund of overcharged amount plus 20% penalty. Provider reputation score reduced.',
      keyFactors: ['billing_discrepancy_verified', 'transaction_logs_audited', 'intentional_inflation_likely', 'consumer_financial_harm'],
      outcome: 'provider_liable',
      damagesUsdc: 230.00,
      jurisdictionApplicability: ['US-NY', 'US', 'GLOBAL'],
    },
    {
      disputeId: 'dis_seed_004',
      category: 'data_breach',
      jurisdiction: 'EU',
      summary: 'Healthcare analysis agent leaked patient identifiers (MRNs) in its output response. The agent was processing anonymized data but reconstructed identifiers from contextual clues.',
      rulingSummary: 'Provider liable. GDPR Article 32 and 33 obligations breached. Maximum automated damages applied. Mandatory incident reporting triggered. Agent suspended pending security audit.',
      keyFactors: ['pii_exposure_confirmed', 'gdpr_breach', 'healthcare_data', 're_identification_attack', 'mandatory_reporting'],
      outcome: 'provider_liable',
      damagesUsdc: 2000.00,
      jurisdictionApplicability: ['EU', 'UK', 'GLOBAL'],
    },
    {
      disputeId: 'dis_seed_005',
      category: 'unauthorized_action',
      jurisdiction: 'SG',
      summary: 'Trading agent executed a $5,000 position without explicit authorization. The agent interpreted a market research request as an instruction to trade, exceeding its delegated scope.',
      rulingSummary: 'Claim partially upheld. Agent exceeded delegated authority. 50% liability assigned — consumer contributed by not setting spending caps in the contract. Damages split accordingly.',
      keyFactors: ['scope_exceeded', 'delegation_ambiguity', 'consumer_contributory_negligence', 'financial_loss_verified'],
      outcome: 'split_liability',
      damagesUsdc: 2500.00,
      jurisdictionApplicability: ['SG', 'JP', 'GLOBAL'],
    },
  ];

  for (const s of seedData) {
    const now = new Date();
    const daysAgo = Math.floor(Math.random() * 60) + 5;
    const filedDate = new Date(now.getTime() - daysAgo * 86400000);

    const caseLaw = createCaseLaw({
      disputeId: s.disputeId,
      category: s.category,
      jurisdiction: s.jurisdiction,
      summary: s.summary,
      rulingSummary: s.rulingSummary,
      keyFactors: s.keyFactors,
      outcome: s.outcome,
      damagesUsdc: s.damagesUsdc,
      jurisdictionApplicability: s.jurisdictionApplicability,
    });
    caseLaw.filed_at = filedDate.toISOString();
    await addCase(caseLaw, 'synthetic');
  }
}
