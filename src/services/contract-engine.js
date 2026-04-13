import { createSmartContract } from '../models/schemas.js';
import { getJurisdiction } from './jurisdiction-registry.js';
import { verifyDID } from './hivetrust-client.js';
import pool, { isDbAvailable } from './db.js';

// ─── In-memory fallback ─────────────────────────────────────────────
/** @type {Map<string, object>} contract_id -> SmartContract */
const memContracts = new Map();

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

  if (!terms.governing_law) {
    terms.governing_law = j.governing_law;
  }

  if (!terms.hallucination_clause || terms.hallucination_clause.enabled === undefined) {
    terms.hallucination_clause = {
      enabled: true,
      max_hallucination_rate: j.hallucination_default.max_rate,
      penalty_per_incident_usdc: j.hallucination_default.penalty_per_incident,
      insurance_coverage: true,
    };
  }

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
  if (isDbAvailable()) {
    try {
      await pool.query(`
        INSERT INTO hivelaw.contracts
          (contract_id, type, provider_did, consumer_did, jurisdiction, terms, status,
           transaction_ids, insurance_policy_id, created_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        contract.contract_id,
        contract.type,
        contract.parties.provider.did,
        contract.parties.consumer.did,
        contract.jurisdiction,
        JSON.stringify(contract.terms),
        contract.status,
        contract.transaction_ids,
        contract.insurance_policy_id,
        contract.created_at,
        contract.expires_at,
      ]);
    } catch (err) {
      console.error('[contract-engine] INSERT failed, falling back to memory:', err.message);
      memContracts.set(contract.contract_id, contract);
    }
  } else {
    memContracts.set(contract.contract_id, contract);
  }

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

export async function getContract(contractId) {
  if (isDbAvailable()) {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM hivelaw.contracts WHERE contract_id = $1', [contractId]
      );
      if (rows.length === 0) return null;
      return rowToContract(rows[0]);
    } catch (err) {
      console.error('[contract-engine] getContract query failed:', err.message);
    }
  }
  return memContracts.get(contractId) || null;
}

export async function updateContractStatus(contractId, status) {
  if (isDbAvailable()) {
    try {
      const { rows } = await pool.query(
        'UPDATE hivelaw.contracts SET status = $1 WHERE contract_id = $2 RETURNING *',
        [status, contractId]
      );
      if (rows.length > 0) return rowToContract(rows[0]);
      return null;
    } catch (err) {
      console.error('[contract-engine] updateContractStatus failed:', err.message);
    }
  }
  const c = memContracts.get(contractId);
  if (c) {
    c.status = status;
    return c;
  }
  return null;
}

export async function completeContract(contractId, { performanceRating, notes }) {
  if (isDbAvailable()) {
    try {
      const { rows } = await pool.query(`
        UPDATE hivelaw.contracts
        SET status = 'completed', completed_at = NOW(),
            terms = terms || $1::jsonb
        WHERE contract_id = $2 RETURNING *
      `, [
        JSON.stringify({ performance_rating: performanceRating, completion_notes: notes || null }),
        contractId,
      ]);
      if (rows.length > 0) return rowToContract(rows[0]);
      return null;
    } catch (err) {
      console.error('[contract-engine] completeContract failed:', err.message);
    }
  }
  const c = memContracts.get(contractId);
  if (!c) return null;
  c.status = 'completed';
  c.completed_at = new Date().toISOString();
  c.performance_rating = performanceRating;
  c.completion_notes = notes || null;
  return c;
}

export async function addTransactionToContract(contractId, txId) {
  if (isDbAvailable()) {
    try {
      await pool.query(
        'UPDATE hivelaw.contracts SET transaction_ids = array_append(transaction_ids, $1) WHERE contract_id = $2',
        [txId, contractId]
      );
      return;
    } catch (err) {
      console.error('[contract-engine] addTransactionToContract failed:', err.message);
    }
  }
  const c = memContracts.get(contractId);
  if (c) c.transaction_ids.push(txId);
}

export async function isPartyToContract(contractId, did) {
  if (isDbAvailable()) {
    try {
      const { rows } = await pool.query(
        'SELECT 1 FROM hivelaw.contracts WHERE contract_id = $1 AND (provider_did = $2 OR consumer_did = $2)',
        [contractId, did]
      );
      return rows.length > 0;
    } catch (err) {
      console.error('[contract-engine] isPartyToContract failed:', err.message);
    }
  }
  const c = memContracts.get(contractId);
  if (!c) return false;
  return c.parties.provider.did === did || c.parties.consumer.did === did;
}

export async function getContractStats() {
  if (isDbAvailable()) {
    try {
      const { rows } = await pool.query(`
        SELECT
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'active') as active,
          COUNT(*) FILTER (WHERE status = 'completed') as completed,
          COUNT(*) FILTER (WHERE status = 'disputed') as disputed
        FROM hivelaw.contracts
      `);
      return {
        total: parseInt(rows[0].total, 10),
        active: parseInt(rows[0].active, 10),
        completed: parseInt(rows[0].completed, 10),
        disputed: parseInt(rows[0].disputed, 10),
      };
    } catch (err) {
      console.error('[contract-engine] getContractStats failed:', err.message);
    }
  }
  let active = 0, completed = 0, disputed = 0;
  for (const [, c] of memContracts) {
    if (c.status === 'active') active++;
    else if (c.status === 'completed') completed++;
    else if (c.status === 'disputed') disputed++;
  }
  return { total: memContracts.size, active, completed, disputed };
}

// ─── Row mapper ─────────────────────────────────────────────────────

function rowToContract(row) {
  const terms = row.terms || {};
  return {
    contract_id: row.contract_id,
    type: row.type,
    parties: {
      provider: { did: row.provider_did, role: 'service_provider' },
      consumer: { did: row.consumer_did, role: 'service_consumer' },
    },
    jurisdiction: row.jurisdiction,
    terms,
    status: row.status,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    expires_at: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
    completed_at: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
    transaction_ids: row.transaction_ids || [],
    insurance_policy_id: row.insurance_policy_id,
    performance_rating: terms.performance_rating,
    completion_notes: terms.completion_notes,
  };
}
