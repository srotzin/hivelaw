/**
 * seed-construction.js
 *
 * Seeds 500 construction-specific case law precedents into HiveLaw's case_law table.
 * Maps constructionPrecedents schema to createCaseLaw / addCase conventions.
 *
 * Usage:
 *   node --experimental-vm-modules src/seed-construction.js
 *   or import and call seedConstructionPrecedents() from server startup.
 */

import { constructionPrecedents } from './construction-precedents-seed.js';
import { createCaseLaw } from './models/schemas.js';
import { addCase, isSeeded } from './services/case-law-db.js';
import pool, { isDbAvailable } from './services/db.js';

// ── Outcome mapping ──────────────────────────────────────────────────
// constructionPrecedents uses 'Principal prevails' | 'Agent prevails' | 'Split ruling'
// case_law table uses 'provider_liable' | 'claim_denied' | 'split_liability'
function mapOutcome(ruling) {
  switch (ruling) {
    case 'Principal prevails': return 'claim_denied';       // principal = owner/claimant wins => contractor claim denied
    case 'Agent prevails':     return 'provider_liable';    // agent = contractor wins => agent (provider) claim upheld
    case 'Split ruling':       return 'split_liability';
    default:                   return 'split_liability';
  }
}

// ── Category → jurisdiction_applicability defaults ──────────────────
const CATEGORY_JURISDICTIONS = {
  change_order:          ['US-CA', 'US-TX', 'US-NY', 'US-FL', 'UK', 'AU'],
  specification_defect:  ['US-CA', 'US-NY', 'UK', 'AU', 'EU-DE'],
  material_substitution: ['US-CA', 'US-TX', 'US-FL', 'UK', 'SG'],
  payment_delay:         ['US-CA', 'US-TX', 'US-NY', 'US-FL', 'UK', 'AU'],
  code_compliance:       ['US-CA', 'US-TX', 'US-NY', 'US-FL', 'EU-DE', 'EU-FR'],
  delay_damages:         ['US-CA', 'US-TX', 'US-NY', 'UK', 'AU', 'SG'],
  force_majeure:         ['US-CA', 'US-TX', 'UK', 'EU-DE', 'SG', 'AU'],
  lien_dispute:          ['US-CA', 'US-TX', 'US-NY', 'US-FL', 'AU'],
  warranty_claim:        ['US-CA', 'US-TX', 'US-NY', 'UK', 'AU', 'EU-DE'],
  professional_liability: ['US-CA', 'US-NY', 'UK', 'AU', 'EU-DE', 'SG'],
};

/**
 * Seed all 500 construction precedents.
 * @param {boolean} force - Skip the "already seeded" check and insert all.
 */
export async function seedConstructionPrecedents(force = false) {
  if (!force && isDbAvailable()) {
    try {
      const { rows } = await pool.query(
        "SELECT COUNT(*) AS cnt FROM hivelaw.case_law WHERE source = 'construction'"
      );
      const existing = parseInt(rows[0].cnt, 10);
      if (existing >= 500) {
        console.log(`  [Seed] Construction precedents already seeded (${existing} rows) — skipping`);
        return;
      }
    } catch (err) {
      console.warn('[seed-construction] Count check failed:', err.message);
    }
  }

  console.log('  [Seed] Seeding 500 construction-specific precedents...');

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < constructionPrecedents.length; i++) {
    const cp = constructionPrecedents[i];

    // Build key_factors from evidence_submitted items (short tags derived from the evidence list)
    const keyFactors = cp.evidence_submitted.map(e =>
      e.toLowerCase()
        .replace(/[^a-z0-9 ]/g, '')
        .trim()
        .split(' ')
        .slice(0, 3)
        .join('_')
    );

    // Map ruling → outcome
    const outcome = mapOutcome(cp.ruling);

    // Build a ruling_summary from ruling + principle
    const rulingSummary = `${cp.ruling}. ${cp.principle_established}`;

    // Use the precedent_id as the case_id directly so ON CONFLICT works predictably
    const caseLaw = {
      case_id: cp.precedent_id,
      dispute_id: null,
      category: cp.category,
      jurisdiction: cp.jurisdiction,
      summary: cp.dispute_summary,
      ruling_summary: rulingSummary,
      key_factors: keyFactors,
      outcome,
      damages_usdc: 0,
      cited_by: [],
      filed_at: cp.created_at,
      jurisdiction_applicability: CATEGORY_JURISDICTIONS[cp.category] || [cp.jurisdiction],
    };

    try {
      await addCase(caseLaw, 'construction');
      inserted++;
    } catch (err) {
      console.warn(`  [Seed] Skipped ${cp.precedent_id}: ${err.message}`);
      skipped++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  [Seed] Progress: ${i + 1}/500 precedents processed`);
    }
  }

  console.log(`  [Seed] Construction precedents seeded: ${inserted} inserted, ${skipped} skipped`);
}

// ── Direct execution (node src/seed-construction.js) ─────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const { initDatabase } = await import('./services/db.js');
  await initDatabase();
  await seedConstructionPrecedents(true);
  process.exit(0);
}
