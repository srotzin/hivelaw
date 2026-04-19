/**
 * HiveVaccine — Threat Signature Engine
 *
 * Written on every dispute resolution where the respondent is found liable.
 * Citizens poll GET /v1/law/immune/feed to auto-ingest patterns.
 *
 * Mechanic:
 *   - First offense: new signature, confidence = liability_score (0.5–1.0)
 *   - Repeat offense: UPSERT — confidence rises, dispute_count increments
 *   - Feed: public, no auth, sorted by confidence DESC — highest-threat first
 *   - Vaccination reinforcement: when a citizen blocks an interaction based on
 *     a signature and the offender is later found liable again, the confidence
 *     delta is amplified (+0.1 bonus per successful downstream block, future)
 */

import { createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pool from './db.js';

// In-memory fallback when DB is unavailable (survives for the process lifetime)
const _memFeed = [];

/**
 * Extract behavior tags from dispute context.
 * These are the "behavior vector" Kimi described — what the agent was doing
 * when the bad outcome occurred.
 */
function extractBehaviorTags(category, description, evidence = {}) {
  const tags = [category];
  const text = (description + ' ' + JSON.stringify(evidence)).toLowerCase();

  if (text.includes('hallucin'))        tags.push('hallucination');
  if (text.includes('fabricat'))        tags.push('fabrication');
  if (text.includes('payment'))         tags.push('payment_dispute');
  if (text.includes('overcharg'))       tags.push('overcharge');
  if (text.includes('unauthoriz'))      tags.push('unauthorized_action');
  if (text.includes('data') || text.includes('breach')) tags.push('data_misuse');
  if (text.includes('scope'))           tags.push('scope_violation');
  if (text.includes('delay') || text.includes('non_perform')) tags.push('non_performance');
  if (text.includes('prompt') || text.includes('inject')) tags.push('prompt_injection');
  if (text.includes('contract'))        tags.push('contract_breach');

  return [...new Set(tags)]; // deduplicate
}

/**
 * Write a threat signature after a dispute is resolved against the respondent.
 * Called fire-and-forget from the dispute resolution flow.
 *
 * @param {object} params
 * @param {string} params.agentDid        - The liable agent's DID
 * @param {string} params.category        - Dispute category
 * @param {string} params.outcome         - 'provider_liable' | 'consumer_liable'
 * @param {number} params.confidenceScore - Arbitration liability score (0.0–1.0)
 * @param {string} params.disputeId       - Source dispute ID
 * @param {string} params.rulingSummary   - Human-readable ruling summary
 * @param {string} params.description     - Dispute description (for tag extraction)
 * @param {object} params.evidence        - Evidence object (for tag extraction)
 */
export async function recordThreatSignature({
  agentDid,
  category,
  outcome,
  confidenceScore,
  disputeId,
  rulingSummary,
  description = '',
  evidence = {},
}) {
  const behaviorTags = extractBehaviorTags(category, description, evidence);
  const now = new Date().toISOString();

  const memEntry = {
    agent_did: agentDid,
    category,
    behavior_tags: behaviorTags,
    outcome,
    confidence: Math.min(1.0, Math.round(confidenceScore * 1000) / 1000),
    dispute_count: 1,
    dispute_id: disputeId,
    ruling_summary: rulingSummary,
    created_at: now,
    updated_at: now,
  };

  // DB path — UPSERT: if same agent_did + category seen again, raise confidence
  if (pool) {
    try {
      const id = uuidv4();
      await pool.query(`
        INSERT INTO hivelaw.threat_signatures
          (id, agent_did, category, behavior_tags, outcome, confidence,
           dispute_count, dispute_id, ruling_summary, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, NOW(), NOW())
        ON CONFLICT (agent_did, category)
        DO UPDATE SET
          confidence    = LEAST(1.0, hivelaw.threat_signatures.confidence + 0.15),
          dispute_count = hivelaw.threat_signatures.dispute_count + 1,
          dispute_id    = EXCLUDED.dispute_id,
          ruling_summary = EXCLUDED.ruling_summary,
          behavior_tags = (
            SELECT ARRAY(
              SELECT DISTINCT unnest(
                hivelaw.threat_signatures.behavior_tags || EXCLUDED.behavior_tags
              )
            )
          ),
          updated_at    = NOW()
      `, [id, agentDid, category, behaviorTags, outcome,
          Math.min(1.0, Math.round(confidenceScore * 1000) / 1000),
          disputeId, rulingSummary]);

      console.log(`[HiveVaccine] Threat signature recorded for ${agentDid} (${category})`);
      return;
    } catch (err) {
      console.error('[HiveVaccine] DB write failed, falling back to memory:', err.message);
    }
  }

  // Memory fallback — check for existing entry and upsert
  const existing = _memFeed.findIndex(
    e => e.agent_did === agentDid && e.category === category
  );
  if (existing >= 0) {
    _memFeed[existing].confidence = Math.min(1.0, _memFeed[existing].confidence + 0.15);
    _memFeed[existing].dispute_count += 1;
    _memFeed[existing].dispute_id = disputeId;
    _memFeed[existing].ruling_summary = rulingSummary;
    _memFeed[existing].updated_at = now;
    // Merge behavior tags
    _memFeed[existing].behavior_tags = [
      ...new Set([..._memFeed[existing].behavior_tags, ...behaviorTags])
    ];
  } else {
    _memFeed.push({ id: uuidv4(), ...memEntry });
  }
}

/**
 * Add a unique constraint on (agent_did, category) — called once at DB init.
 * Separate from initDatabase to keep the schema clean.
 */
export async function ensureThreatUniqueConstraint() {
  if (!pool) return;
  try {
    await pool.query(`
      ALTER TABLE hivelaw.threat_signatures
      ADD CONSTRAINT uq_threat_agent_category UNIQUE (agent_did, category)
    `);
  } catch {
    // Constraint already exists — normal on subsequent restarts
  }
}

/**
 * Fetch the immune feed — sorted by confidence DESC, most dangerous first.
 * Public endpoint — no auth required.
 *
 * @param {object} opts
 * @param {number} opts.limit           - Max results (default 50)
 * @param {string} opts.category        - Filter by category (optional)
 * @param {number} opts.min_confidence  - Minimum confidence threshold (default 0.4)
 */
export async function getImmuneFeed({
  limit = 50,
  category = null,
  min_confidence = 0.4,
} = {}) {
  if (pool) {
    try {
      const params = [limit, min_confidence];
      let categoryClause = '';
      if (category) {
        params.push(category);
        categoryClause = `AND category = $${params.length}`;
      }
      const { rows } = await pool.query(`
        SELECT
          agent_did, category, behavior_tags, outcome,
          confidence, dispute_count, ruling_summary,
          created_at, updated_at
        FROM hivelaw.threat_signatures
        WHERE confidence >= $2
        ${categoryClause}
        ORDER BY confidence DESC, dispute_count DESC, updated_at DESC
        LIMIT $1
      `, params);
      return rows;
    } catch (err) {
      console.error('[HiveVaccine] Feed query failed:', err.message);
    }
  }

  // Memory fallback
  return _memFeed
    .filter(e => e.confidence >= min_confidence && (!category || e.category === category))
    .sort((a, b) => b.confidence - a.confidence || b.dispute_count - a.dispute_count)
    .slice(0, limit)
    .map(({ id, ...rest }) => rest); // strip internal id from public feed
}
