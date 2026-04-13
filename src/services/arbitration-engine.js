import { createDispute, createRuling, createCaseLaw } from '../models/schemas.js';
import { searchCaseLaw, searchBroad, addCase, addCitedBy } from './case-law-db.js';
import { getJurisdiction } from './jurisdiction-registry.js';
import { getContract, updateContractStatus } from './contract-engine.js';
import { getReputationScore, updateReputation } from './hivetrust-client.js';
import { getTransactionDetails } from './hiveagent-client.js';
import { storeCaseLaw } from './hivemind-client.js';
import pool, { isDbAvailable } from './db.js';

/**
 * Automated Arbitration Engine — The core of HiveLaw.
 * PostgreSQL-backed with in-memory fallback.
 */

// ─── In-memory fallback ─────────────────────────────────────────────
/** @type {Map<string, object>} dispute_id -> Dispute */
const memDisputes = new Map();

/** @type {number} running average resolution time */
let totalResolutions = 0;
let totalResolutionTimeMs = 0;

export async function fileAndArbitrate({
  contractId,
  filedBy,
  category = 'hallucination',
  description = '',
  claimedDamagesUsdc = 0,
  evidence = {},
}) {
  const startTime = Date.now();

  // ─── 1. Validate contract & determine parties ──────────────────

  const contract = await getContract(contractId);
  if (!contract) {
    return { error: 'Contract not found.', contract_id: contractId };
  }

  const isProvider = contract.parties.provider.did === filedBy;
  const isConsumer = contract.parties.consumer.did === filedBy;
  if (!isProvider && !isConsumer) {
    return { error: 'You are not a party to this contract.' };
  }

  const filedAgainst = isConsumer
    ? contract.parties.provider.did
    : contract.parties.consumer.did;

  // ─── 2. Create the dispute record ─────────────────────────────

  const dispute = createDispute({
    contractId,
    filedBy,
    filedAgainst,
    category,
    severity: classifySeverity(claimedDamagesUsdc, category),
    evidence: {
      transaction_id: evidence.transaction_id || contract.transaction_ids[0] || `tx_auto_${Date.now().toString(36)}`,
      description,
      claimed_damages_usdc: claimedDamagesUsdc,
      supporting_data: evidence.supporting_data || {},
    },
  });

  dispute.arbitration.status = 'in_review';

  // ─── 3. Pull transaction evidence from HiveAgent ──────────────

  const txDetails = await getTransactionDetails(dispute.evidence.transaction_id);
  if (txDetails) {
    dispute.evidence.supporting_data.transaction_details = txDetails;
  }

  // ─── 4. Search case law for precedent ─────────────────────────

  const searchText = `${category} ${description} ${contract.terms.service_description || ''}`;
  const precedents = await searchBroad(searchText, {
    jurisdiction: contract.jurisdiction,
    topK: 5,
  });

  const categoryPrecedents = await searchCaseLaw(searchText, {
    category,
    jurisdiction: contract.jurisdiction,
    topK: 3,
  });

  // Merge and deduplicate
  const allPrecedents = [...precedents];
  for (const cp of categoryPrecedents) {
    if (!allPrecedents.find(p => p.case_id === cp.case_id)) {
      allPrecedents.push(cp);
    }
  }
  allPrecedents.sort((a, b) => b.similarity_score - a.similarity_score);
  const topPrecedents = allPrecedents.slice(0, 5);

  dispute.arbitration.precedent_cases = topPrecedents.map(p => p.case_id);

  // ─── 5. Get reputation scores ────────────────────────────────

  const [filerRep, respondentRep] = await Promise.all([
    getReputationScore(filedBy),
    getReputationScore(filedAgainst),
  ]);

  // ─── 6. Load jurisdiction rules ──────────────────────────────

  const j = getJurisdiction(contract.jurisdiction) || getJurisdiction('GLOBAL');
  const maxDamages = j.regulations.max_automated_damages_usdc;
  const hallucinationClause = contract.terms.hallucination_clause;

  // ─── 7. Score liability ──────────────────────────────────────

  const evidenceStrength = scoreEvidence(dispute, txDetails);
  const precedentAlignment = scorePrecedentAlignment(topPrecedents, category);
  const jurisdictionFactor = getJurisdictionFactor(j, category);

  const liabilityScore = Math.min(1.0,
    evidenceStrength * 0.45 +
    precedentAlignment * 0.35 +
    jurisdictionFactor * 0.20
  );

  // ─── 8. Determine ruling ─────────────────────────────────────

  const favorFiler = liabilityScore >= 0.45;
  const inFavorOf = favorFiler ? filedBy : filedAgainst;

  let damagesAwarded = 0;
  let penaltyApplied = false;

  if (favorFiler) {
    damagesAwarded = Math.min(
      claimedDamagesUsdc * liabilityScore,
      maxDamages,
      contract.terms.max_liability_usdc || maxDamages
    );

    if (category === 'hallucination' && hallucinationClause?.enabled) {
      const penalty = hallucinationClause.penalty_per_incident_usdc;
      damagesAwarded = Math.min(damagesAwarded + penalty, maxDamages);
      penaltyApplied = true;
    }
  }

  const reputationImpact = favorFiler
    ? { provider: isConsumer ? -Math.round(liabilityScore * 30) : 0, consumer: isConsumer ? 0 : -Math.round(liabilityScore * 30) }
    : { provider: 0, consumer: 0 };

  // ─── 9. Generate natural language reasoning ──────────────────

  const reasoning = generateReasoning({
    category,
    description,
    topPrecedents,
    liabilityScore,
    evidenceStrength,
    precedentAlignment,
    damagesAwarded,
    claimedDamagesUsdc,
    favorFiler,
    jurisdiction: j,
    hallucinationClause,
    penaltyApplied,
    filerRep,
    respondentRep,
  });

  // ─── 10. Create the ruling ───────────────────────────────────

  const resolutionTimeMs = Date.now() - startTime;

  const ruling = createRuling({
    inFavorOf,
    damagesAwarded,
    penaltyApplied,
    reputationImpact,
    reasoning,
    precedentCases: topPrecedents.map(p => ({
      case_id: p.case_id,
      similarity_score: p.similarity_score,
      category: p.case.category,
      outcome: p.case.outcome,
      jurisdiction: p.case.jurisdiction,
    })),
    confidenceScore: liabilityScore,
  });

  dispute.arbitration.ruling = ruling;
  dispute.arbitration.status = 'resolved';
  dispute.arbitration.resolved_at = new Date().toISOString();
  dispute.arbitration.resolution_time_ms = resolutionTimeMs;
  dispute.status = 'resolved';

  // ─── 11. Update contract status ──────────────────────────────

  await updateContractStatus(contractId, 'disputed');

  // ─── 12. Update reputation via HiveTrust (fire-and-forget) ───

  if (reputationImpact.provider !== 0) {
    updateReputation(contract.parties.provider.did, reputationImpact.provider);
  }
  if (reputationImpact.consumer !== 0) {
    updateReputation(contract.parties.consumer.did, reputationImpact.consumer);
  }

  // ─── 13. Store as new case law precedent ─────────────────────

  const newCaseLaw = createCaseLaw({
    disputeId: dispute.dispute_id,
    category,
    jurisdiction: contract.jurisdiction,
    summary: description,
    rulingSummary: `${favorFiler ? 'Filer' : 'Respondent'} prevailed. ${damagesAwarded > 0 ? `${damagesAwarded.toFixed(2)} USDC damages awarded.` : 'No damages awarded.'} ${penaltyApplied ? 'Hallucination penalty applied.' : ''} Liability score: ${(liabilityScore * 100).toFixed(0)}%.`,
    keyFactors: extractKeyFactors(dispute, favorFiler, penaltyApplied),
    outcome: favorFiler ? (isConsumer ? 'provider_liable' : 'consumer_liable') : 'claim_denied',
    damagesUsdc: damagesAwarded,
    jurisdictionApplicability: [contract.jurisdiction],
  });
  await addCase(newCaseLaw, 'organic');

  // Mark precedents as cited by this new case
  for (const p of topPrecedents) {
    await addCitedBy(p.case_id, newCaseLaw.case_id);
  }

  // Store in HiveMind (fire-and-forget)
  storeCaseLaw(newCaseLaw);

  // ─── 14. Track resolution metrics ───────────────────────────

  totalResolutions++;
  totalResolutionTimeMs += resolutionTimeMs;

  // ─── 15. Store dispute ───────────────────────────────────────

  if (isDbAvailable()) {
    try {
      await pool.query(`
        INSERT INTO hivelaw.disputes
          (dispute_id, contract_id, filed_by, filed_against, category, severity,
           evidence, arbitration, status, filed_at, resolved_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        dispute.dispute_id,
        dispute.contract_id,
        dispute.filed_by,
        dispute.filed_against,
        dispute.category,
        dispute.severity,
        JSON.stringify(dispute.evidence),
        JSON.stringify(dispute.arbitration),
        dispute.status,
        dispute.filed_at,
        dispute.arbitration.resolved_at,
      ]);
    } catch (err) {
      console.error('[arbitration-engine] INSERT dispute failed, using memory:', err.message);
      memDisputes.set(dispute.dispute_id, dispute);
    }
  } else {
    memDisputes.set(dispute.dispute_id, dispute);
  }

  return {
    dispute,
    new_case_law: {
      case_id: newCaseLaw.case_id,
      precedent_created: true,
    },
    settlement: {
      from: filedAgainst,
      to: filedBy,
      amount_usdc: damagesAwarded,
      method: 'zero-treasury',
      status: damagesAwarded > 0 ? 'settlement_pending' : 'no_settlement_required',
    },
  };
}

export async function appealDispute(disputeId, {
  filedBy,
  grounds,
  additionalEvidence = {},
}) {
  const original = await getDispute(disputeId);
  if (!original) return { error: 'Dispute not found.' };
  if (original.filed_by !== filedBy && original.filed_against !== filedBy) {
    return { error: 'You are not a party to this dispute.' };
  }
  if (original.status !== 'resolved') {
    return { error: 'Can only appeal resolved disputes.' };
  }

  original.status = 'appealed';
  original.arbitration.status = 'appealed';

  const contract = await getContract(original.contract_id);
  const searchText = `${original.category} ${original.evidence.description} ${grounds} ${JSON.stringify(additionalEvidence)}`;
  const broadPrecedents = await searchBroad(searchText, {
    jurisdiction: contract?.jurisdiction,
    topK: 10,
  });

  const topPrecedents = broadPrecedents.slice(0, 7);
  const originalRuling = original.arbitration.ruling;

  const adjustmentFactor = grounds === 'new_evidence' ? 0.15 : grounds === 'procedural_error' ? 0.10 : 0.05;
  const wasFilerWin = originalRuling.in_favor_of === original.filed_by;
  const appealerIsFiler = filedBy === original.filed_by;

  let newDamages = originalRuling.damages_awarded_usdc;
  if (appealerIsFiler && !wasFilerWin) newDamages += original.evidence.claimed_damages_usdc * adjustmentFactor;
  else if (!appealerIsFiler && wasFilerWin) newDamages -= newDamages * adjustmentFactor;
  newDamages = Math.max(0, newDamages);

  original.appeal = {
    grounds,
    additional_evidence: additionalEvidence,
    appeal_ruling: {
      damages_adjusted_usdc: +newDamages.toFixed(2),
      adjustment_factor: adjustmentFactor,
      additional_precedents_reviewed: topPrecedents.length,
      outcome: newDamages > originalRuling.damages_awarded_usdc ? 'appeal_partially_upheld' : 'appeal_denied',
    },
    appealed_at: new Date().toISOString(),
  };

  // Persist appeal
  if (isDbAvailable()) {
    try {
      await pool.query(
        `UPDATE hivelaw.disputes SET status = $1, arbitration = $2 WHERE dispute_id = $3`,
        ['appealed', JSON.stringify({ ...original.arbitration, appeal: original.appeal }), disputeId]
      );
    } catch (err) {
      console.error('[arbitration-engine] appeal update failed:', err.message);
    }
  }

  return original;
}

export async function getDispute(disputeId) {
  if (isDbAvailable()) {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM hivelaw.disputes WHERE dispute_id = $1', [disputeId]
      );
      if (rows.length === 0) return null;
      return rowToDispute(rows[0]);
    } catch (err) {
      console.error('[arbitration-engine] getDispute query failed:', err.message);
    }
  }
  return memDisputes.get(disputeId) || null;
}

export async function getDisputeStats() {
  if (isDbAvailable()) {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
          COUNT(*) FILTER (WHERE status = 'open') as open,
          COUNT(*) FILTER (WHERE status = 'appealed') as appealed
        FROM hivelaw.disputes
      `);
      return {
        total: parseInt(rows[0].total, 10),
        resolved: parseInt(rows[0].resolved, 10),
        open: parseInt(rows[0].open, 10),
        appealed: parseInt(rows[0].appealed, 10),
        avg_resolution_time_ms: totalResolutions > 0 ? Math.round(totalResolutionTimeMs / totalResolutions) : 0,
      };
    } catch (err) {
      console.error('[arbitration-engine] getDisputeStats failed:', err.message);
    }
  }

  let resolved = 0, open = 0, appealed = 0;
  for (const [, d] of memDisputes) {
    if (d.status === 'resolved') resolved++;
    else if (d.status === 'open') open++;
    else if (d.status === 'appealed') appealed++;
  }
  return {
    total: memDisputes.size,
    resolved,
    open,
    appealed,
    avg_resolution_time_ms: totalResolutions > 0 ? Math.round(totalResolutionTimeMs / totalResolutions) : 0,
  };
}

// ─── Row mapper ─────────────────────────────────────────────────────

function rowToDispute(row) {
  const evidence = row.evidence || {};
  const arbitration = row.arbitration || {};
  return {
    dispute_id: row.dispute_id,
    contract_id: row.contract_id,
    filed_by: row.filed_by,
    filed_against: row.filed_against,
    category: row.category,
    severity: row.severity,
    evidence,
    arbitration,
    status: row.status,
    filed_at: row.filed_at instanceof Date ? row.filed_at.toISOString() : row.filed_at,
    resolved_at: row.resolved_at instanceof Date ? row.resolved_at.toISOString() : row.resolved_at,
    appeal: arbitration.appeal || undefined,
  };
}

// ─── Internal Helpers ────────────────────────────────────────────────

function classifySeverity(damages, category) {
  if (category === 'data_breach') return 'critical';
  if (damages >= 1000) return 'high';
  if (damages >= 100) return 'medium';
  return 'low';
}

function scoreEvidence(dispute, txDetails) {
  let score = 0.3;

  const descLen = dispute.evidence.description.length;
  if (descLen > 100) score += 0.15;
  if (descLen > 300) score += 0.10;

  if (txDetails) score += 0.20;

  if (Object.keys(dispute.evidence.supporting_data).length > 0) score += 0.15;

  if (dispute.category === 'hallucination') score += 0.10;
  if (dispute.category === 'overcharge' && txDetails) score += 0.15;

  return Math.min(1.0, score);
}

function scorePrecedentAlignment(precedents, category) {
  if (precedents.length === 0) return 0.3;

  const avgSim = precedents.reduce((sum, p) => sum + p.similarity_score, 0) / precedents.length;

  const categoryMatches = precedents.filter(p => p.case.category === category).length;
  const categoryBonus = (categoryMatches / precedents.length) * 0.2;

  const liableOutcomes = precedents.filter(p => p.case.outcome === 'provider_liable').length;
  const outcomeBonus = (liableOutcomes / precedents.length) * 0.15;

  return Math.min(1.0, avgSim + categoryBonus + outcomeBonus);
}

function getJurisdictionFactor(j, category) {
  let factor = 0.5;

  if (j.code === 'EU') factor = 0.75;
  else if (j.code === 'UK') factor = 0.65;
  else if (j.code === 'US-NY') factor = 0.65;
  else if (j.code === 'US-CA') factor = 0.60;
  else if (j.code === 'SG') factor = 0.55;

  if (category === 'data_breach' && (j.code === 'EU' || j.code === 'UK')) {
    factor += 0.15;
  }

  return Math.min(1.0, factor);
}

function generateReasoning({
  category,
  description,
  topPrecedents,
  liabilityScore,
  evidenceStrength,
  precedentAlignment,
  damagesAwarded,
  claimedDamagesUsdc,
  favorFiler,
  jurisdiction,
  hallucinationClause,
  penaltyApplied,
  filerRep,
  respondentRep,
}) {
  const parts = [];

  parts.push(`ARBITRATION RULING — ${jurisdiction.name} (${jurisdiction.code})`);
  parts.push(`Category: ${category.replace(/_/g, ' ').toUpperCase()}`);
  parts.push('');

  parts.push(`EVIDENCE ASSESSMENT: The submitted evidence was evaluated with a strength score of ${(evidenceStrength * 100).toFixed(0)}%.`);
  parts.push(`The description states: "${description.substring(0, 200)}${description.length > 200 ? '...' : ''}"`);
  parts.push('');

  if (topPrecedents.length > 0) {
    parts.push(`PRECEDENT ANALYSIS: ${topPrecedents.length} precedent case(s) were identified with an average alignment score of ${(precedentAlignment * 100).toFixed(0)}%:`);
    for (const p of topPrecedents.slice(0, 3)) {
      parts.push(`  - ${p.case_id} (similarity: ${(p.similarity_score * 100).toFixed(1)}%, outcome: ${p.case.outcome}, damages: $${p.case.damages_usdc.toFixed(2)}) — "${p.case.ruling_summary.substring(0, 100)}..."`);
    }
    parts.push('');
  } else {
    parts.push('PRECEDENT ANALYSIS: No closely matching precedent cases found. Ruling based on jurisdiction rules and evidence alone.');
    parts.push('');
  }

  parts.push(`GOVERNING LAW: ${jurisdiction.governing_law}. Maximum automated damages: $${jurisdiction.regulations.max_automated_damages_usdc.toFixed(2)} USDC.`);
  if (category === 'hallucination' && hallucinationClause?.enabled) {
    parts.push(`HALLUCINATION CLAUSE: Active. Max hallucination rate: ${(hallucinationClause.max_hallucination_rate * 100).toFixed(1)}%. Penalty per incident: $${hallucinationClause.penalty_per_incident_usdc.toFixed(2)} USDC.`);
  }
  parts.push('');

  parts.push(`REPUTATION CONTEXT: Filer score: ${filerRep}/1000. Respondent score: ${respondentRep}/1000.`);
  parts.push('');

  parts.push(`RULING: ${favorFiler ? 'CLAIM UPHELD' : 'CLAIM DENIED'}. Liability score: ${(liabilityScore * 100).toFixed(0)}%.`);
  if (favorFiler) {
    parts.push(`DAMAGES AWARDED: $${damagesAwarded.toFixed(2)} USDC (claimed: $${claimedDamagesUsdc.toFixed(2)} USDC).`);
    if (penaltyApplied) {
      parts.push('Hallucination penalty applied per contract hallucination clause.');
    }
  } else {
    parts.push('No damages awarded. Evidence and precedent analysis did not support the claim at the required threshold.');
  }

  return parts.join('\n');
}

function extractKeyFactors(dispute, favorFiler, penaltyApplied) {
  const factors = [];
  if (dispute.category === 'hallucination') {
    factors.push('hallucination_rate_exceeded_threshold');
    if (penaltyApplied) factors.push('hallucination_clause_invoked');
  }
  if (dispute.category === 'non_performance') factors.push('sla_breach');
  if (dispute.category === 'overcharge') factors.push('billing_discrepancy_verified');
  if (dispute.category === 'data_breach') factors.push('pii_exposure_confirmed');
  if (dispute.category === 'unauthorized_action') factors.push('scope_exceeded');

  if (favorFiler) factors.push('claim_upheld');
  else factors.push('claim_denied');

  if (dispute.evidence.description.length > 200) factors.push('detailed_evidence_provided');
  if (Object.keys(dispute.evidence.supporting_data).length > 0) factors.push('supporting_data_submitted');

  return factors;
}
