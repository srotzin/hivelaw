import crypto from 'node:crypto';
import { createCaseLaw } from '../models/schemas.js';

/**
 * Case Law Database — In-memory storage with vector-based semantic search.
 * Uses the same hash-based pseudo-embedding approach as HiveMind.
 */

const DIMENSIONS = 128;

/** @type {Map<string, object>} case_id -> CaseLaw */
const cases = new Map();

/** @type {Map<string, { vector: number[], metadata: object }>} */
const vectorIndex = new Map();

// ─── Embedding ───────────────────────────────────────────────────────

function hashEmbed(text) {
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

// ─── Core Operations ─────────────────────────────────────────────────

export function addCase(caseData) {
  const embedding = hashEmbed(
    `${caseData.category} ${caseData.summary} ${caseData.ruling_summary} ${caseData.key_factors.join(' ')}`
  );
  caseData.semantic_embedding = embedding.slice(0, 5).concat([`...${DIMENSIONS} dimensions`]);

  cases.set(caseData.case_id, caseData);
  vectorIndex.set(caseData.case_id, {
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

export function getCase(caseId) {
  return cases.get(caseId) || null;
}

/**
 * Search case law by semantic similarity.
 * Weights: jurisdiction match (2x), category match (1.5x), recency <30d (1.2x).
 */
export function searchCaseLaw(queryText, {
  category = null,
  jurisdiction = null,
  topK = 5,
} = {}) {
  const queryVec = hashEmbed(queryText);
  const results = [];
  const now = Date.now();

  for (const [caseId, entry] of vectorIndex) {
    let score = cosineSimilarity(queryVec, entry.vector);

    // Jurisdiction boost (2x)
    if (jurisdiction && entry.metadata.jurisdiction === jurisdiction) {
      score *= 2.0;
    } else if (jurisdiction) {
      // Partial match: same country (e.g., US-CA matches US)
      const queryCountry = jurisdiction.split('-')[0];
      const caseCountry = entry.metadata.jurisdiction.split('-')[0];
      if (queryCountry === caseCountry) score *= 1.3;
    }

    // Category boost (1.5x)
    if (category && entry.metadata.category === category) {
      score *= 1.5;
    }

    // Recency boost (1.2x for cases < 30 days old)
    const ageMs = now - new Date(entry.metadata.filed_at).getTime();
    if (ageMs < 30 * 86400000) {
      score *= 1.2;
    }

    // Apply category/jurisdiction filter if strict
    if (category && entry.metadata.category !== category) continue;

    results.push({
      case_id: caseId,
      similarity_score: +score.toFixed(4),
      raw_cosine: +cosineSimilarity(queryVec, entry.vector).toFixed(4),
      case: cases.get(caseId),
    });
  }

  results.sort((a, b) => b.similarity_score - a.similarity_score);
  return results.slice(0, topK);
}

/**
 * Search without category filter — broader search for arbitration.
 */
export function searchBroad(queryText, { jurisdiction = null, topK = 5 } = {}) {
  const queryVec = hashEmbed(queryText);
  const results = [];
  const now = Date.now();

  for (const [caseId, entry] of vectorIndex) {
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
      case: cases.get(caseId),
    });
  }

  results.sort((a, b) => b.similarity_score - a.similarity_score);
  return results.slice(0, topK);
}

export function addCitedBy(caseId, citingCaseId) {
  const c = cases.get(caseId);
  if (c && !c.cited_by.includes(citingCaseId)) {
    c.cited_by.push(citingCaseId);
  }
}

export function getStats() {
  const byCategory = {};
  const byJurisdiction = {};
  let totalDamages = 0;
  let providerWins = 0;
  let consumerWins = 0;

  for (const [, c] of cases) {
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    byJurisdiction[c.jurisdiction] = (byJurisdiction[c.jurisdiction] || 0) + 1;
    totalDamages += c.damages_usdc;
    if (c.outcome === 'provider_liable') consumerWins++;
    else if (c.outcome === 'consumer_liable' || c.outcome === 'claim_denied') providerWins++;
  }

  const total = cases.size;
  return {
    total_cases: total,
    by_category: byCategory,
    by_jurisdiction: byJurisdiction,
    avg_damages_usdc: total > 0 ? +(totalDamages / total).toFixed(2) : 0,
    provider_win_rate: total > 0 ? +((providerWins / total) * 100).toFixed(1) : 0,
    consumer_win_rate: total > 0 ? +((consumerWins / total) * 100).toFixed(1) : 0,
    avg_resolution_time_ms: 2100, // placeholder average
    vector_dimensions: DIMENSIONS,
    embedding_mode: 'hash-pseudo',
  };
}

export function getAllCases() {
  return Array.from(cases.values());
}

// ─── Seed 5 Example Precedent Cases ──────────────────────────────────

export function seedCaseLaw() {
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
    // Stagger dates so they appear historical
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
    addCase(caseLaw);
  }
}

// Auto-seed on import
seedCaseLaw();
