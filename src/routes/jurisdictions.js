import { Router } from 'express';
import { requireDID } from '../middleware/auth.js';
import { listJurisdictions, getJurisdictionDetails, checkCompliance } from '../services/jurisdiction-registry.js';

const router = Router();

/**
 * GET /v1/jurisdictions — List all supported jurisdictions (public).
 */
router.get('/', (req, res) => {
  return res.json({
    success: true,
    data: {
      jurisdictions: listJurisdictions(),
      total: listJurisdictions().length,
    },
  });
});

/**
 * GET /v1/jurisdictions/:code — Get jurisdiction details (public).
 */
router.get('/:code', (req, res) => {
  const j = getJurisdictionDetails(req.params.code.toUpperCase());
  if (!j) return res.status(404).json({ success: false, error: `Jurisdiction ${req.params.code} not found.` });
  return res.json({ success: true, data: j });
});

/**
 * GET /v1/jurisdictions/:code/compliance-check — Check compliance for a contract type.
 */
router.get('/:code/compliance-check', requireDID, (req, res) => {
  const { contract_type = 'service_agreement' } = req.query;
  const result = checkCompliance(req.params.code.toUpperCase(), contract_type);
  if (result.error) return res.status(404).json({ success: false, error: result.error });
  return res.json({ success: true, data: result });
});

export default router;
