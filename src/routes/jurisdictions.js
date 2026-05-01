import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireDID } from '../middleware/auth.js';
import { requirePayment } from '../middleware/x402.js';
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
 * Fee: $200 per GDPR audit run (per task spec / monetization proforma).
 * Sliding scale applied by org size: $500-$5,000 for EU AI Act cert (handled in /compliance routes).
 */
router.get('/:code/compliance-check', requirePayment(200, 'Jurisdiction Compliance Audit — HiveLaw'), requireDID, (req, res) => {
  const { contract_type = 'service_agreement' } = req.query;
  const result = checkCompliance(req.params.code.toUpperCase(), contract_type);
  if (result.error) return res.status(404).json({ success: false, error: result.error });
  return res.json({ success: true, data: result, payment_verified: true, fee_usdc: 200 });
});

/**
 * POST /v1/monitoring/subscribe — Ongoing regulation monitoring.
 * Fee: $50/mo per regulation tracked (per task spec).
 * x402: $50 USDC monthly, charged at subscribe-time.
 */
router.post('/monitoring/subscribe', requirePayment(50, 'Regulation Monitoring Subscription — HiveLaw'), requireDID, (req, res) => {
  const { did, regulation_code, org_name } = req.body;
  if (!regulation_code) {
    return res.status(400).json({ success: false, error: 'regulation_code is required', example: 'EU_AI_ACT, GDPR, HAHS, CCPA' });
  }
  const subscriptionId = `mon_${randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  return res.status(201).json({
    success: true,
    subscription_id: subscriptionId,
    did: did || req.agentDid,
    regulation_code,
    org_name,
    entitlements: ['real_time_regulation_alerts', 'monthly_compliance_digest', 'precedent_updates'],
    valid_from: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    amount_usdc: 50,
    currency: 'USDC',
    network: 'base',
    payment_verified: req.paymentVerified || false,
    receipt_endpoint: 'POST https://hive-receipt.onrender.com/v1/receipts/sign',
    _hive: { service: 'hivelaw', protocol: 'x402', treasury: '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E' },
  });
});

export default router;
