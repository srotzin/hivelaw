import { getReputationScore } from './hivetrust-client.js';
import { searchBroad } from './case-law-db.js';
import { getJurisdiction } from './jurisdiction-registry.js';
import { createLiabilityAssessment } from '../models/schemas.js';

/**
 * Liability Calculator — Scores hallucination risk and maps to dollar liability.
 *
 * Risk factors:
 *   - Agent reputation (from HiveTrust): lower rep = higher risk
 *   - Output length: longer outputs have more surface for hallucination
 *   - Claim specificity: specific claims (numbers, dates, names) are higher risk
 *   - Source attribution: absence of citations increases risk
 *   - Jurisdiction: stricter jurisdictions amplify liability
 */

export async function assessLiability({
  agentDid,
  outputText = '',
  expectedAccuracy = 0.95,
  jurisdiction = 'GLOBAL',
  transactionValueUsdc = 0,
}) {
  const startTime = Date.now();

  // 1. Get agent reputation
  const repScore = await getReputationScore(agentDid);
  const repNormalized = repScore / 1000; // 0-1

  // 2. Analyze output for hallucination risk signals
  const factors = [];
  let riskScore = 0;

  // Reputation factor (0-0.25)
  const repRisk = Math.max(0, 0.25 * (1 - repNormalized));
  riskScore += repRisk;
  factors.push({
    factor: 'agent_reputation',
    score: repScore,
    risk_contribution: +repRisk.toFixed(4),
    detail: repScore >= 700 ? 'High reputation — lower risk' : repScore >= 400 ? 'Moderate reputation' : 'Low reputation — elevated risk',
  });

  // Output length factor (0-0.15)
  const wordCount = outputText.split(/\s+/).length;
  const lengthRisk = Math.min(0.15, (wordCount / 5000) * 0.15);
  riskScore += lengthRisk;
  factors.push({
    factor: 'output_length',
    word_count: wordCount,
    risk_contribution: +lengthRisk.toFixed(4),
    detail: wordCount > 2000 ? 'Long output — higher hallucination surface' : 'Moderate length',
  });

  // Claim specificity (0-0.25) — detect numbers, dates, proper nouns
  const specificClaims = (outputText.match(/\b\d{4,}\b|\b(?:ICC|ESR|ISO|ASTM|NIST|FDA|SEC)\b|\b\d+\.\d+%/gi) || []).length;
  const specificityRisk = Math.min(0.25, specificClaims * 0.03);
  riskScore += specificityRisk;
  factors.push({
    factor: 'claim_specificity',
    specific_claims_detected: specificClaims,
    risk_contribution: +specificityRisk.toFixed(4),
    detail: specificClaims > 5 ? 'Multiple specific claims — high verification burden' : 'Few specific claims',
  });

  // Source attribution (0-0.20)
  const hasCitations = /\b(?:source|reference|according to|cited|per|see)\b/i.test(outputText);
  const hasUrls = /https?:\/\//.test(outputText);
  const citationRisk = hasCitations || hasUrls ? 0.02 : 0.20;
  riskScore += citationRisk;
  factors.push({
    factor: 'source_attribution',
    has_citations: hasCitations,
    has_urls: hasUrls,
    risk_contribution: +citationRisk.toFixed(4),
    detail: hasCitations ? 'Sources cited — reduced risk' : 'No source attribution — elevated risk',
  });

  // Accuracy gap (0-0.15)
  const accuracyGap = Math.max(0, 1 - expectedAccuracy);
  const accuracyRisk = accuracyGap * 1.5;
  riskScore += Math.min(0.15, accuracyRisk);
  factors.push({
    factor: 'accuracy_threshold',
    expected_accuracy: expectedAccuracy,
    risk_contribution: +Math.min(0.15, accuracyRisk).toFixed(4),
    detail: `Expected accuracy: ${(expectedAccuracy * 100).toFixed(0)}%`,
  });

  riskScore = Math.min(1.0, riskScore);

  // 3. Get jurisdiction rules
  const j = getJurisdiction(jurisdiction);
  const maxDamages = j?.regulations?.max_automated_damages_usdc || 10000;
  const penaltyPerIncident = j?.hallucination_default?.penalty_per_incident || 10.00;

  // 4. Calculate liability
  const potentialLiability = Math.min(maxDamages, transactionValueUsdc * riskScore * 3);
  const recommendedCoverage = potentialLiability * 1.5; // 150% of potential liability
  const insurancePremium = recommendedCoverage * (0.02 + riskScore * 0.08); // 2-10% of coverage

  // 5. Find similar cases
  const similarCases = searchBroad(outputText.substring(0, 200), { jurisdiction, topK: 3 });

  return createLiabilityAssessment({
    agentDid,
    riskScore,
    potentialLiability,
    recommendedCoverage,
    similarCases: similarCases.length,
    insurancePremium,
    jurisdiction,
    factors,
  });
}
