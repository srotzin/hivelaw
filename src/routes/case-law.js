import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { searchBroad, getCase, getStats, getAllCases } from '../services/case-law-db.js';

const router = Router();

/**
 * GET /v1/case-law/search — Search case law precedent by semantic similarity.
 */
router.get('/search', requireDID, (req, res) => {
  const { q = '', category, jurisdiction, top_k = '10' } = req.query;

  if (!q.trim()) {
    return res.status(400).json({ success: false, error: 'Query parameter ?q= is required.' });
  }

  const results = searchBroad(q, {
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
        cited_by_count: r.case.cited_by.length,
      })),
      total: filtered.length,
    },
  });
});

/**
 * GET /v1/case-law/stats — Case law statistics (public, no auth).
 */
router.get('/stats', (req, res) => {
  return res.json({ success: true, data: getStats() });
});

/**
 * GET /v1/case-law/:caseId — Get specific case details.
 */
router.get('/:caseId', requireDID, (req, res) => {
  const caseLaw = getCase(req.params.caseId);
  if (!caseLaw) return res.status(404).json({ success: false, error: 'Case not found.' });
  return res.json({ success: true, data: caseLaw });
});

export default router;
