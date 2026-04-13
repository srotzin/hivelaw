import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
import { searchBroad, getCase, getStats, getAllCases } from '../services/case-law-db.js';

const router = Router();

/**
 * GET /v1/case-law/search — Search case law precedent by semantic similarity.
 */
router.get('/search', requireDID, async (req, res) => {
  try {
    const { q = '', category, jurisdiction, top_k = '10' } = req.query;

    if (!q.trim()) {
      return res.status(400).json({ success: false, error: 'Query parameter ?q= is required.' });
    }

    const results = await searchBroad(q, {
      jurisdiction: jurisdiction || null,
      topK: parseInt(top_k, 10),
    });

    // Filter by category client-side if provided
    const filtered = category
      ? results.filter(r => r.case.category === category)
      : results;

    return res.json({
      success: true,
      data: {
        query: q,
        filters: { category: category || null, jurisdiction: jurisdiction || null },
        cases: filtered.map(r => ({
          case_id: r.case_id,
          similarity_score: r.similarity_score,
          category: r.case.category,
          jurisdiction: r.case.jurisdiction,
          summary: r.case.summary,
          ruling_summary: r.case.ruling_summary,
          outcome: r.case.outcome,
          damages_usdc: r.case.damages_usdc,
          key_factors: r.case.key_factors,
          filed_at: r.case.filed_at,
          jurisdiction_applicability: r.case.jurisdiction_applicability,
          cited_by_count: (r.case.cited_by || []).length,
        })),
        total: filtered.length,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Search failed.', detail: err.message });
  }
});

/**
 * GET /v1/case-law/query-paid — Paid precedent access with full case details.
 * $0.001 per query via x402 — the "data refinery" revenue stream.
 */
router.get('/query-paid', requireDID, requirePayment(0.001, 'Precedent Access Query'), async (req, res) => {
  try {
    const { q = '', category, jurisdiction, top_k = '10' } = req.query;

    if (!q.trim()) {
      return res.status(400).json({ success: false, error: 'Query parameter ?q= is required.' });
    }

    const results = await searchBroad(q, {
      jurisdiction: jurisdiction || null,
      topK: parseInt(top_k, 10),
    });

    const filtered = category
      ? results.filter(r => r.case.category === category)
      : results;

    return res.json({
      success: true,
      data: {
        query: q,
        filters: { category: category || null, jurisdiction: jurisdiction || null },
        cases: filtered.map(r => ({
          case_id: r.case_id,
          similarity_score: r.similarity_score,
          raw_cosine: r.raw_cosine,
          category: r.case.category,
          jurisdiction: r.case.jurisdiction,
          summary: r.case.summary,
          ruling_summary: r.case.ruling_summary,
          outcome: r.case.outcome,
          damages_usdc: r.case.damages_usdc,
          key_factors: r.case.key_factors,
          source: r.case.source,
          filed_at: r.case.filed_at,
          jurisdiction_applicability: r.case.jurisdiction_applicability,
          cited_by: r.case.cited_by || [],
          cited_by_count: (r.case.cited_by || []).length,
        })),
        total: filtered.length,
      },
      meta: {
        fee_usdc: 0.001,
        access_level: 'full',
        note: 'Includes full case details, ruling reasoning, and citation graph.',
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Paid query failed.', detail: err.message });
  }
});

/**
 * GET /v1/case-law/stats — Case law statistics (public, no auth).
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getStats();
    return res.json({ success: true, data: stats });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch stats.', detail: err.message });
  }
});

/**
 * GET /v1/case-law/:caseId — Get specific case details.
 */
router.get('/:caseId', requireDID, async (req, res) => {
  try {
    const caseLaw = await getCase(req.params.caseId);
    if (!caseLaw) return res.status(404).json({ success: false, error: 'Case not found.' });
    return res.json({ success: true, data: caseLaw });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to fetch case.', detail: err.message });
  }
});

export default router;
