/**
 * Construction Precedents Route
 * GET /v1/law/precedents/construction
 *
 * Returns filtered construction-specific case law precedents from the DB,
 * falling back to the in-memory constructionPrecedents array when DB is unavailable.
 *
 * Query parameters:
 *   category    — one of the 10 construction categories (optional)
 *   jurisdiction — e.g. US-CA, UK, AU (optional)
 *   limit        — max results to return (default 20, max 100)
 *   offset       — pagination offset (default 0)
 */

import { Router } from 'express';
import pool, { isDbAvailable } from '../services/db.js';
import { constructionPrecedents } from '../construction-precedents-seed.js';
import { ok, err } from '../ritz.js';

const router = Router();

const VALID_CATEGORIES = new Set([
  'change_order', 'specification_defect', 'material_substitution', 'payment_delay',
  'code_compliance', 'delay_damages', 'force_majeure', 'lien_dispute',
  'warranty_claim', 'professional_liability',
]);

const VALID_JURISDICTIONS = new Set([
  'US-CA', 'US-TX', 'US-NY', 'US-FL', 'EU-DE', 'EU-FR', 'UK', 'SG', 'AU',
]);

/**
 * GET /v1/law/precedents/construction
 * Returns construction-specific precedents with optional category/jurisdiction filters.
 */
router.get('/', async (req, res) => {
  try {
    const {
      category = null,
      jurisdiction = null,
      limit: limitParam = '20',
      offset: offsetParam = '0',
    } = req.query;

    const limit = Math.min(parseInt(limitParam, 10) || 20, 100);
    const offset = Math.max(parseInt(offsetParam, 10) || 0, 0);

    // Validate filters
    if (category && !VALID_CATEGORIES.has(category)) {
      return err(res, 'hivelaw', 'INVALID_CATEGORY',
        `Invalid category. Valid values: ${[...VALID_CATEGORIES].join(', ')}`, 400);
    }
    if (jurisdiction && !VALID_JURISDICTIONS.has(jurisdiction)) {
      return err(res, 'hivelaw', 'INVALID_JURISDICTION',
        `Invalid jurisdiction. Valid values: ${[...VALID_JURISDICTIONS].join(', ')}`, 400);
    }

    // ── Try DB first ─────────────────────────────────────────────────
    if (isDbAvailable()) {
      try {
        const conditions = ["source = 'construction'"];
        const params = [];
        let paramIdx = 1;

        if (category) {
          conditions.push(`category = $${paramIdx++}`);
          params.push(category);
        }
        if (jurisdiction) {
          conditions.push(`jurisdiction = $${paramIdx++}`);
          params.push(jurisdiction);
        }

        const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        // Count total matching rows
        const countResult = await pool.query(
          `SELECT COUNT(*) AS total FROM hivelaw.case_law ${whereClause}`,
          params
        );
        const total = parseInt(countResult.rows[0].total, 10);

        // Fetch paginated rows
        const dataResult = await pool.query(
          `SELECT case_id, category, jurisdiction, summary, ruling_summary,
                  key_factors, outcome, damages_usdc, filed_at,
                  jurisdiction_applicability, cited_by, source
           FROM hivelaw.case_law
           ${whereClause}
           ORDER BY filed_at DESC
           LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
          [...params, limit, offset]
        );

        const precedents = dataResult.rows.map(r => ({
          precedent_id: r.case_id,
          category: r.category,
          jurisdiction: r.jurisdiction,
          dispute_summary: r.summary,
          ruling: mapOutcomeToRuling(r.outcome),
          principle_established: extractPrinciple(r.ruling_summary),
          evidence_submitted: r.key_factors || [],
          citations: (r.cited_by || []).length,
          filed_at: r.filed_at,
          jurisdiction_applicability: r.jurisdiction_applicability || [],
          source: r.source,
        }));

        return ok(res, 'hivelaw', {
          precedents,
          pagination: {
            total,
            limit,
            offset,
            has_more: offset + limit < total,
          },
          filters: { category: category || null, jurisdiction: jurisdiction || null },
          source: 'database',
        });
      } catch (dbErr) {
        console.warn('[construction-precedents] DB query failed, falling back to in-memory:', dbErr.message);
        // Fall through to in-memory fallback
      }
    }

    // ── In-memory fallback ────────────────────────────────────────────
    let filtered = constructionPrecedents;

    if (category) {
      filtered = filtered.filter(p => p.category === category);
    }
    if (jurisdiction) {
      filtered = filtered.filter(p => p.jurisdiction === jurisdiction);
    }

    const total = filtered.length;
    const paginated = filtered.slice(offset, offset + limit);

    return ok(res, 'hivelaw', {
      precedents: paginated.map(p => ({
        precedent_id: p.precedent_id,
        category: p.category,
        jurisdiction: p.jurisdiction,
        title: p.title,
        dispute_summary: p.dispute_summary,
        ruling: p.ruling,
        principle_established: p.principle_established,
        evidence_submitted: p.evidence_submitted,
        arbitration_ms: p.arbitration_ms,
        confidence_score: p.confidence_score,
        citations: p.citations,
        created_at: p.created_at,
      })),
      pagination: {
        total,
        limit,
        offset,
        has_more: offset + limit < total,
      },
      filters: { category: category || null, jurisdiction: jurisdiction || null },
      source: 'in_memory',
    });
  } catch (e) {
    return err(res, 'hivelaw', 'CONSTRUCTION_PRECEDENTS_ERROR',
      'Failed to fetch construction precedents.', 500, { detail: e.message });
  }
});

/**
 * GET /v1/law/precedents/construction/categories
 * Returns the list of valid construction categories with counts.
 */
router.get('/categories', async (req, res) => {
  try {
    if (isDbAvailable()) {
      try {
        const { rows } = await pool.query(`
          SELECT category, COUNT(*) AS count
          FROM hivelaw.case_law
          WHERE source = 'construction'
          GROUP BY category
          ORDER BY category
        `);
        return ok(res, 'hivelaw', {
          categories: rows.map(r => ({ category: r.category, count: parseInt(r.count, 10) })),
          source: 'database',
        });
      } catch (dbErr) {
        // Fall through to in-memory
      }
    }

    // In-memory fallback
    const counts = {};
    for (const p of constructionPrecedents) {
      counts[p.category] = (counts[p.category] || 0) + 1;
    }
    return ok(res, 'hivelaw', {
      categories: Object.entries(counts)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([category, count]) => ({ category, count })),
      source: 'in_memory',
    });
  } catch (e) {
    return err(res, 'hivelaw', 'CATEGORIES_ERROR', 'Failed to fetch categories.', 500, { detail: e.message });
  }
});

/**
 * GET /v1/law/precedents/construction/:precedentId
 * Returns a single construction precedent by ID (e.g. cp_001).
 */
router.get('/:precedentId', async (req, res) => {
  try {
    const { precedentId } = req.params;

    if (isDbAvailable()) {
      try {
        const { rows } = await pool.query(
          `SELECT case_id, category, jurisdiction, summary, ruling_summary,
                  key_factors, outcome, damages_usdc, filed_at,
                  jurisdiction_applicability, cited_by, source
           FROM hivelaw.case_law
           WHERE case_id = $1 AND source = 'construction'`,
          [precedentId]
        );
        if (rows.length > 0) {
          const r = rows[0];
          return ok(res, 'hivelaw', {
            precedent_id: r.case_id,
            category: r.category,
            jurisdiction: r.jurisdiction,
            dispute_summary: r.summary,
            ruling: mapOutcomeToRuling(r.outcome),
            principle_established: extractPrinciple(r.ruling_summary),
            evidence_submitted: r.key_factors || [],
            citations: (r.cited_by || []).length,
            filed_at: r.filed_at,
            jurisdiction_applicability: r.jurisdiction_applicability || [],
          });
        }
      } catch (dbErr) {
        // Fall through to in-memory
      }
    }

    // In-memory fallback
    const p = constructionPrecedents.find(x => x.precedent_id === precedentId);
    if (!p) {
      return err(res, 'hivelaw', 'NOT_FOUND', `Construction precedent '${precedentId}' not found.`, 404);
    }
    return ok(res, 'hivelaw', p);
  } catch (e) {
    return err(res, 'hivelaw', 'PRECEDENT_FETCH_ERROR', 'Failed to fetch precedent.', 500, { detail: e.message });
  }
});

// ── Helpers ───────────────────────────────────────────────────────────

function mapOutcomeToRuling(outcome) {
  switch (outcome) {
    case 'claim_denied':    return 'Principal prevails';
    case 'provider_liable': return 'Agent prevails';
    case 'split_liability': return 'Split ruling';
    default:                return outcome || 'Unknown';
  }
}

function extractPrinciple(rulingSummary) {
  if (!rulingSummary) return '';
  // ruling_summary format: "Ruling. Principle."
  const dotIdx = rulingSummary.indexOf('. ');
  return dotIdx >= 0 ? rulingSummary.slice(dotIdx + 2) : rulingSummary;
}

export default router;
