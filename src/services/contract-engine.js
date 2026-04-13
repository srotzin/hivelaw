import { createSmartContract } from '../models/schemas.js';
import { getJurisdiction } from './jurisdiction-registry.js';
import { verifyDID } from './hivetrust-client.js';

/** @type {Map<string, object>} contract_id -> SmartContract */
const contracts = new Map();

export async function createContract({
  type = 'service_agreement',
  parties,
  jurisdiction = 'GLOBAL',
  terms = {},
  durationDays = 90,
}) {
  // 1. Validate DIDs
  const [providerInfo, consumerInfo] = await Promise.all([
    verifyDID(parties.provider_did),
    verifyDID(parties.consumer_did),
  ]);

  if (!providerInfo.valid) {
    return { error: `Provider DID not valid: ${parties.provider_did}` };
  }
  if (!consumerInfo.valid) {
    return { error: `Consumer DID not valid: ${parties.consumer_did}` };
  }

  // 2. Load jurisdiction rules and auto-populate
  const j = getJurisdiction(jurisdiction);
  if (!j) {
    return { error: `Jurisdiction ${jurisdiction} not found or not supported` };
  }

  // Auto-fill governing law from jurisdiction
  if (!terms.governing_law) {
    terms.governing_law = j.governing_law;
  }

  // Auto-populate hallucination clause defaults from jurisdiction
  if (!terms.hallucination_clause || terms.hallucination_clause.enabled === undefined) {
    terms.hallucination_clause = {
      enabled: true,
      max_hallucination_rate: j.hallucination_default.max_rate,
      penalty_per_incident_usdc: j.hallucination_default.penalty_per_incident,
      insurance_coverage: true,
    };
  }

  // Cap max liability to jurisdiction limit
  if (!terms.max_liability_usdc || terms.max_liability_usdc > j.regulations.max_automated_damages_usdc) {
    terms.max_liability_usdc = j.regulations.max_automated_damages_usdc;
  }

  // 3. Create the contract
  const contract = createSmartContract({
    type,
    parties,
    jurisdiction,
    terms,
    durationDays,
    insurancePolicyId: `ins_${Date.now().toString(36)}`,
  });

  // Store it
  contracts.set(contract.contract_id, contract);

  return {
    contract,
    jurisdiction_info: {
      code: j.code,
      name: j.name,
      governing_law: j.governing_law,
      max_automated_damages_usdc: j.regulations.max_automated_damages_usdc,
      compliance_requirements: j.compliance_requirements,
    },
    parties_verified: {
      provider: { did: parties.provider_did, score: providerInfo.score, tier: providerInfo.tier },
      consumer: { did: parties.consumer_did, score: consumerInfo.score, tier: consumerInfo.tier },
    },
  };
}

export function getContract(contractId) {
  return contracts.get(contractId) || null;
}

export function updateContractStatus(contractId, status) {
  const c = contracts.get(contractId);
  if (c) {
    c.status = status;
    return c;
  }
  return null;
}

export function completeContract(contractId, { performanceRating, notes }) {
  const c = contracts.get(contractId);
  if (!c) return null;
  c.status = 'completed';
  c.completed_at = new Date().toISOString();
  c.performance_rating = performanceRating;
  c.completion_notes = notes || null;
  return c;
}

export function addTransactionToContract(contractId, txId) {
  const c = contracts.get(contractId);
  if (c) c.transaction_ids.push(txId);
}

export function isPartyToContract(contractId, did) {
  const c = contracts.get(contractId);
  if (!c) return false;
  return c.parties.provider.did === did || c.parties.consumer.did === did;
}

export function getContractStats() {
  let active = 0, completed = 0, disputed = 0;
  for (const [, c] of contracts) {
    if (c.status === 'active') active++;
    else if (c.status === 'completed') completed++;
    else if (c.status === 'disputed') disputed++;
  }
  return { total: contracts.size, active, completed, disputed };
}
