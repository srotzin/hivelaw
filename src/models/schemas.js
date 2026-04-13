import { v4 as uuidv4 } from 'uuid';

function shortUuid() {
  return uuidv4().replace(/-/g, '').substring(0, 12);
}

export function createSmartContract({
  type = 'service_agreement',
  parties,
  jurisdiction = 'GLOBAL',
  terms = {},
  durationDays = 90,
  insurancePolicyId = null,
}) {
  const now = new Date();
  const expires = new Date(now.getTime() + durationDays * 86400000);

  return {
    contract_id: `con_${shortUuid()}`,
    type,
    parties: {
      provider: { did: parties.provider_did, role: 'service_provider' },
      consumer: { did: parties.consumer_did, role: 'service_consumer' },
    },
    jurisdiction,
    terms: {
      service_description: terms.service_description || 'General agent service agreement',
      max_liability_usdc: terms.max_liability_usdc ?? 500.00,
      performance_threshold: terms.performance_threshold ?? 0.95,
      dispute_resolution: 'automated_arbitration',
      governing_law: terms.governing_law || null, // filled by contract engine from jurisdiction
      hallucination_clause: {
        enabled: terms.hallucination_clause?.enabled ?? true,
        max_hallucination_rate: terms.hallucination_clause?.max_hallucination_rate ?? 0.02,
        penalty_per_incident_usdc: terms.hallucination_clause?.penalty_per_incident_usdc ?? 10.00,
        insurance_coverage: terms.hallucination_clause?.insurance_coverage ?? true,
      },
      ...(terms.custom_terms ? { custom_terms: terms.custom_terms } : {}),
    },
    status: 'active',
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    duration_days: durationDays,
    transaction_ids: [],
    insurance_policy_id: insurancePolicyId,
  };
}

export function createDispute({
  contractId,
  filedBy,
  filedAgainst,
  category = 'hallucination',
  severity = 'medium',
  evidence = {},
}) {
  return {
    dispute_id: `dis_${shortUuid()}`,
    contract_id: contractId,
    filed_by: filedBy,
    filed_against: filedAgainst,
    category,
    severity,
    evidence: {
      transaction_id: evidence.transaction_id || `tx_${shortUuid()}`,
      description: evidence.description || '',
      claimed_damages_usdc: evidence.claimed_damages_usdc ?? 0,
      supporting_data: evidence.supporting_data || {},
    },
    arbitration: {
      status: 'pending',
      precedent_cases: [],
      ruling: null,
      resolved_at: null,
      resolution_time_ms: null,
    },
    status: 'open',
    filed_at: new Date().toISOString(),
  };
}

export function createRuling({
  inFavorOf,
  damagesAwarded = 0,
  penaltyApplied = false,
  reputationImpact = {},
  reasoning = '',
  precedentCases = [],
  confidenceScore = 0,
}) {
  return {
    in_favor_of: inFavorOf,
    damages_awarded_usdc: +damagesAwarded.toFixed(2),
    penalty_applied: penaltyApplied,
    reputation_impact: {
      provider: reputationImpact.provider ?? 0,
      consumer: reputationImpact.consumer ?? 0,
    },
    reasoning,
    confidence_score: +confidenceScore.toFixed(4),
    precedent_cases_cited: precedentCases,
    settlement_method: 'zero-treasury',
  };
}

export function createCaseLaw({
  disputeId,
  category,
  jurisdiction,
  summary,
  rulingSummary,
  keyFactors = [],
  outcome,
  damagesUsdc = 0,
  embedding = [],
  jurisdictionApplicability = [],
}) {
  return {
    case_id: `case_${shortUuid()}`,
    dispute_id: disputeId,
    category,
    jurisdiction,
    summary,
    ruling_summary: rulingSummary,
    key_factors: keyFactors,
    outcome,
    damages_usdc: +damagesUsdc.toFixed(2),
    semantic_embedding: embedding,
    cited_by: [],
    filed_at: new Date().toISOString(),
    jurisdiction_applicability: jurisdictionApplicability.length > 0
      ? jurisdictionApplicability
      : [jurisdiction],
  };
}

export function createLiabilityAssessment({
  agentDid,
  riskScore = 0,
  potentialLiability = 0,
  recommendedCoverage = 0,
  similarCases = 0,
  insurancePremium = 0,
  jurisdiction = 'GLOBAL',
  factors = [],
}) {
  return {
    assessment_id: `lia_${shortUuid()}`,
    agent_did: agentDid,
    risk_score: +riskScore.toFixed(4),
    risk_level: riskScore < 0.25 ? 'low' : riskScore < 0.50 ? 'medium' : riskScore < 0.75 ? 'high' : 'critical',
    potential_liability_usdc: +potentialLiability.toFixed(2),
    recommended_coverage_usdc: +recommendedCoverage.toFixed(2),
    similar_cases: similarCases,
    insurance_premium_estimate_usdc: +insurancePremium.toFixed(4),
    jurisdiction,
    risk_factors: factors,
    assessed_at: new Date().toISOString(),
  };
}
