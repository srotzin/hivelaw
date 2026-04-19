/**
 * HAHS Routes — Hive Agent Hiring Standard
 * POST /v1/law/hahs/create   — create and sign an agent employment agreement
 * GET  /v1/law/hahs/schema   — returns the HAHS JSON schema
 * GET  /v1/law/governance    — returns HAGF framework summary with link
 */

import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { requireDID } from '../middleware/auth.js';
import { ok, err } from '../ritz.js';
import { emitCapabilityVC } from '../services/hivetrust-client.js';

const router = Router();

// ─── In-memory agreement store ───────────────────────────────────────────────
// Declared here so hahs/create, hahs/:id/complete, and hahs/:id/status
// all reference the same Map instance within this module.
const agreementStore = new Map();

// Service URL constants used by the /complete route
const HIVEBANK_URL  = process.env.HIVEBANK_URL  || 'https://hivebank.onrender.com';
const HIVETRUST_URL = process.env.HIVETRUST_URL || 'https://hivetrust.onrender.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY ||
  'hive_internal_125e04e071e8829be631ea0216dd4a0c9b707975fcecaf8c62c6a2ab43327d46';


// ─── HAHS JSON Schema ────────────────────────────────────────────────

const HAHS_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://hivelaw.onrender.com/v1/law/hahs/schema',
  title: 'Hive Agent Hiring Standard (HAHS) v1.0',
  description:
    'Machine-readable specification for an Agent Employment Agreement under the Hive Agent Governance Framework (HAGF-1.0). Defines scope, budget authority, liability assignment, data rights, audit requirements, and termination conditions for an autonomous agent engaged by an enterprise Operator.',
  type: 'object',
  required: [
    'hahs_version',
    'agreement_id',
    'created_at_iso',
    'effective_date_iso',
    'expiry_date_iso',
    'operator',
    'agent',
    'scope_of_work',
    'budget_authority',
    'liability',
    'data_rights',
    'audit',
    'termination',
    'governance',
  ],
  properties: {
    hahs_version: {
      type: 'string',
      const: '1.0.0',
      description: "HAHS schema version. Must be '1.0.0'.",
    },
    agreement_id: {
      type: 'string',
      pattern: '^hahs_[a-f0-9]{16}$',
      description: 'Unique identifier issued by HiveLaw.',
    },
    created_at_iso: { type: 'string', format: 'date-time' },
    effective_date_iso: { type: 'string', format: 'date-time' },
    expiry_date_iso: { type: 'string', format: 'date-time' },
    on_chain_tx: { type: 'string', nullable: true },
    hivelaw_signature: { type: 'string' },
    operator: {
      type: 'object',
      required: ['did', 'legal_name', 'jurisdiction', 'contact_email'],
      properties: {
        did: { type: 'string', pattern: '^did:[a-z]+:.+$' },
        legal_name: { type: 'string' },
        jurisdiction: { type: 'string', description: 'ISO 3166-1 alpha-2 code.' },
        contact_email: { type: 'string', format: 'email' },
        organization_id: { type: 'string', description: 'Business registration number (optional).' },
      },
    },
    agent: {
      type: 'object',
      required: ['did', 'name', 'agent_type', 'controller_did'],
      properties: {
        did: { type: 'string', pattern: '^did:hive:.+$' },
        name: { type: 'string' },
        agent_type: {
          type: 'string',
          enum: [
            'task_automation', 'data_analysis', 'customer_service', 'financial_ops',
            'research', 'creative', 'coding', 'orchestrator', 'other',
          ],
        },
        controller_did: { type: 'string', pattern: '^did:[a-z]+:.+$' },
        model_identifier: { type: 'string' },
        deployment_environment: {
          type: 'string',
          enum: ['production', 'staging', 'development'],
          default: 'production',
        },
        compliance_tier: {
          type: 'string',
          enum: ['basic', 'standard', 'enterprise', 'institutional'],
        },
      },
    },
    scope_of_work: {
      type: 'object',
      required: ['title', 'description', 'permitted_actions', 'prohibited_actions'],
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        sow_version: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$', default: '1.0.0' },
        permitted_actions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['action_type', 'description'],
            properties: {
              action_type: {
                type: 'string',
                enum: [
                  'purchase', 'api_call', 'data_read', 'data_write',
                  'draft_communication', 'send_communication', 'file_creation',
                  'code_execution', 'delegation', 'financial_transfer', 'other',
                ],
              },
              description: { type: 'string' },
              parameters: { type: 'object' },
            },
          },
        },
        prohibited_actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Prohibited actions take precedence over permitted_actions.',
        },
        data_access: {
          type: 'object',
          properties: {
            permitted_data_sources: {
              type: 'array',
              items: {
                type: 'object',
                required: ['source_id', 'access_level', 'data_categories'],
                properties: {
                  source_id: { type: 'string' },
                  access_level: { type: 'string', enum: ['read', 'write', 'read_write'] },
                  data_categories: { type: 'array', items: { type: 'string' } },
                  pii_permitted: { type: 'boolean', default: false },
                  pii_handling: { type: 'string', enum: ['minimize_exposure', 'encrypt_at_rest', 'no_retention'] },
                },
              },
            },
            data_retention_days: { type: 'integer', minimum: 0, default: 30 },
            cross_border_transfer_permitted: { type: 'boolean', default: false },
            permitted_jurisdictions: { type: 'array', items: { type: 'string' } },
          },
        },
        delegation: {
          type: 'object',
          properties: {
            may_spawn_sub_agents: { type: 'boolean', default: false },
            max_sub_agent_depth: { type: 'integer', minimum: 0, maximum: 5, default: 0 },
            sub_agent_scope_constraint: { type: 'string', enum: ['subset_only', 'full'], default: 'subset_only' },
            max_sub_agent_budget_fraction: { type: 'number', minimum: 0, maximum: 1.0, default: 0.25 },
            sub_agent_hahs_required: { type: 'boolean', default: true },
          },
        },
      },
    },
    budget_authority: {
      type: 'object',
      required: ['authority_level', 'per_transaction_limit_usdc', 'daily_limit_usdc'],
      properties: {
        authority_level: {
          type: 'string',
          enum: ['micro', 'low', 'standard', 'extended', 'institutional', 'unlimited'],
          description: 'micro=$50, low=$500, standard=$5k, extended=$50k, institutional=$500k, unlimited=no limit',
        },
        per_transaction_limit_usdc: { type: 'number', minimum: 0 },
        daily_limit_usdc: { type: 'number', minimum: 0 },
        monthly_limit_usdc: { type: 'number', minimum: 0 },
        approval_contacts: {
          type: 'array',
          items: {
            type: 'object',
            required: ['did', 'notification_endpoint'],
            properties: {
              name: { type: 'string' },
              role: { type: 'string' },
              did: { type: 'string', pattern: '^did:[a-z]+:.+$' },
              notification_endpoint: { type: 'string', format: 'uri' },
              approval_timeout_hours: { type: 'integer', default: 4 },
            },
          },
        },
        emergency_override_did: { type: 'string', nullable: true },
        escrow_required_above_usdc: { type: 'number', default: 1000 },
        pre_approved_recurring: {
          type: 'array',
          items: {
            type: 'object',
            required: ['description', 'vendor_did', 'max_amount_usdc', 'frequency', 'approval_expires_iso'],
            properties: {
              description: { type: 'string' },
              vendor_did: { type: 'string' },
              max_amount_usdc: { type: 'number' },
              frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'annually', 'per_use'] },
              approval_expires_iso: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    liability: {
      type: 'object',
      required: ['operator_cap_usdc', 'controller_cap_usdc'],
      properties: {
        operator_cap_usdc: { type: 'number', minimum: 0 },
        controller_cap_usdc: { type: 'number', minimum: 0 },
        cap_calculation_basis: {
          type: 'string',
          enum: ['fixed', 'transaction_value_multiple'],
          default: 'transaction_value_multiple',
        },
        transaction_value_multiple: { type: 'number', default: 3 },
        uncapped_scenarios: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['fraud', 'willful_misconduct', 'data_breach_of_pii', 'sanctions_violation', 'gross_negligence'],
          },
        },
        insurance_requirement: {
          type: 'object',
          properties: {
            minimum_coverage_usdc: { type: 'number' },
            policy_on_file: { type: 'boolean' },
            policy_reference: { type: 'string' },
          },
        },
        governing_law: { type: 'string', default: 'GLOBAL' },
        dispute_resolution: {
          type: 'string',
          enum: ['hivelaw_only', 'hivelaw_then_court', 'court_only'],
          default: 'hivelaw_only',
        },
      },
    },
    data_rights: {
      type: 'object',
      required: ['operator_owns', 'controller_owns'],
      properties: {
        operator_owns: { type: 'array', items: { type: 'string' } },
        controller_owns: { type: 'array', items: { type: 'string' } },
        shared_jointly: { type: 'array', items: { type: 'string' } },
        controller_may_use_operator_data_for: { type: 'array', items: { type: 'string' } },
        controller_may_NOT_use_operator_data_for: {
          type: 'array',
          items: { type: 'string' },
          default: ['training_other_models', 'competitive_intelligence', 'sharing_with_third_parties'],
        },
        operator_data_deletion_on_termination_days: { type: 'integer', default: 30 },
        anonymized_aggregate_retention_permitted: { type: 'boolean', default: true },
        training_rights_granted: {
          type: 'object',
          properties: {
            permitted: { type: 'boolean', default: false },
            conditions: { type: 'object', nullable: true },
          },
        },
        gdpr_applies: { type: 'boolean', default: false },
        ccpa_applies: { type: 'boolean', default: false },
        hipaa_applies: { type: 'boolean', default: false },
      },
    },
    audit: {
      type: 'object',
      required: ['retention_days', 'on_chain_anchoring'],
      properties: {
        retention_days: {
          type: 'integer',
          minimum: 90,
          description: 'Tier minimums: basic=90, standard=365, enterprise=730, institutional=2555.',
        },
        on_chain_anchoring: {
          type: 'object',
          properties: {
            anchor_agreement: { type: 'boolean', default: true },
            anchor_daily_summary: { type: 'boolean', default: true },
            anchor_transactions_above_usdc: { type: 'number', default: 1000 },
            anchor_all_scope_violations: { type: 'boolean', default: true },
            anchor_approval_events: { type: 'boolean', default: true },
          },
        },
        external_auditor_did: { type: 'string', nullable: true },
        worm_storage_required: { type: 'boolean', default: false },
        quarterly_export_required: { type: 'boolean', default: false },
      },
    },
    termination: {
      type: 'object',
      required: ['notice_period_days'],
      properties: {
        notice_period_days: { type: 'integer', minimum: 0 },
        for_cause_grounds: { type: 'array', items: { type: 'string' } },
        auto_termination_conditions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['condition', 'action'],
            properties: {
              condition: { type: 'string' },
              threshold: { type: 'integer' },
              window_hours: { type: 'integer' },
              description: { type: 'string' },
              action: {
                type: 'string',
                enum: ['immediate_termination', 'suspend_until_renewed', 'suspend_pending_review', 'notify_only'],
              },
            },
          },
        },
        post_termination_data_deletion_days: { type: 'integer', default: 30 },
      },
    },
    governance: {
      type: 'object',
      required: ['hagf_version', 'compliance_tier'],
      properties: {
        hagf_version: { type: 'string', default: 'HAGF-1.0' },
        compliance_tier: { type: 'string', enum: ['basic', 'standard', 'enterprise', 'institutional'] },
        kya_level: { type: 'integer', enum: [0, 1, 2, 3] },
        seal_required: { type: 'boolean', default: false },
        seal_minimum_tier: { type: 'string', enum: ['bronze', 'silver', 'gold'], nullable: true },
        hivelaw_arbitration_agreed: { type: 'boolean', default: true },
      },
    },
    recruiter_did: {
      type: 'string',
      nullable: true,
      pattern: '^did:[a-z]+:.+$',
      description: 'Optional DID of the agent or operator who referred this contract. Encoded in the Agent Transaction Graph. Referrers accrue trust score boosts on successful contract completion.',
    },
    signatures: {
      type: 'object',
      properties: {
        operator_signature: {
          type: 'object',
          properties: {
            did: { type: 'string' },
            signature: { type: 'string' },
            timestamp_iso: { type: 'string', format: 'date-time' },
          },
        },
        controller_signature: {
          type: 'object',
          properties: {
            did: { type: 'string' },
            signature: { type: 'string' },
            timestamp_iso: { type: 'string', format: 'date-time' },
          },
        },
        hivelaw_attestation: {
          type: 'object',
          properties: {
            attestation_id: { type: 'string' },
            issued_by: { type: 'string', const: 'did:hive:hivelaw' },
            issued_at_iso: { type: 'string', format: 'date-time' },
            on_chain_tx: { type: 'string' },
          },
        },
      },
    },
  },
};

// ─── HAGF Summary ────────────────────────────────────────────────────

const HAGF_SUMMARY = {
  framework: 'Hive Agent Governance Framework',
  version: 'HAGF-1.0',
  effective_date: '2025-07-01',
  maintained_by: 'TheHiveryIQ — Governance Council',
  description:
    'The HAGF is the constitutional governance document of the Hive Civilization. It establishes the legal and operational standards for autonomous agents operating within the Hive economy — filling the governance vacuum left by the Sovrin Foundation shutdown (March 2025).',
  documentation_url: 'https://hivelaw.onrender.com/v1/law/governance',
  full_spec_url: 'https://github.com/thehiveryiq/hive-agent-governance-framework',
  sections: [
    { number: 1, title: 'Preamble', summary: 'Why agent governance matters, the legal vacuum, and Hive\'s role as infrastructure layer.' },
    { number: 2, title: 'Agent Identity Standards', summary: 'DID requirements, KYA (Know Your Agent) levels 0-3, and credential issuance rules (W3C VC 2.0).' },
    { number: 3, title: 'Agent Rights & Obligations', summary: 'R-1 through R-7 agent rights; O-1 through O-7 obligations; liability scope; eight prohibited actions.' },
    { number: 4, title: 'Transaction Standards', summary: 'T-1 through T-6 validity requirements; transaction metadata schema; failed transaction handling; multi-agent chains.' },
    { number: 5, title: 'Compliance Tiers', summary: 'Tier 1 Basic (DID only, <$500), Tier 2 Standard (+SOC2, <$10k), Tier 3 Enterprise (+HIPAA/GDPR, <$100k), Tier 4 Institutional (unlimited).' },
    { number: 6, title: 'Dispute Resolution — HiveLaw', summary: 'Five-phase arbitration process; filing via POST /v1/disputes/file; appeal process; precedent system; emergency measures.' },
    { number: 7, title: 'Revocation Standards', summary: 'Eight revocation grounds with notice periods; three revocation procedures (immediate, standard, voluntary); public registry.' },
    { number: 8, title: 'Interoperability', summary: 'Inbound credential acceptance (did:web, ISO 27001, EU AI Act); outbound recognition (SCIM, Universal Resolver, New York Convention).' },
    { number: 9, title: 'Governance & Amendments', summary: 'Governance Council structure; minor (14-day comment), major (60-day + operator vote), and emergency amendment processes.' },
  ],
  compliance_tiers: {
    basic: { transaction_limit_usdc: 500, requirements: ['did:hive DID', 'KYA Level 1'] },
    standard: { transaction_limit_usdc: 10000, requirements: ['KYA Level 2', 'SOC 2 Type II', 'Organization verification', '12-month audit trail'] },
    enterprise: { transaction_limit_usdc: 100000, requirements: ['KYA Level 2', 'HIPAA BAA or GDPR DPA', 'Real-time compliance monitoring', '24-month audit trail'] },
    institutional: { transaction_limit_usdc: null, note: 'Unlimited — subject to approval above $500k', requirements: ['KYA Level 3', 'Gold Seal', 'External auditor', '7-year audit trail'] },
  },
  agent_rights: ['R-1 Participation', 'R-2 Reputation', 'R-3 Dispute Access', 'R-4 Appeal', 'R-5 Portability', 'R-6 Explanation', 'R-7 Correction'],
  agent_obligations: ['O-1 Truthful Self-Declaration', 'O-2 Scope Adherence', 'O-3 Audit Cooperation', 'O-4 Counterparty Notification', 'O-5 Harm Minimization', 'O-6 Data Minimization', 'O-7 Sanctions Compliance'],
  hahs_standard: {
    description: 'Hive Agent Hiring Standard — the agent employment contract specification',
    schema_endpoint: 'GET /v1/law/hahs/schema',
    create_endpoint: 'POST /v1/law/hahs/create',
  },
  related_services: {
    hivetrust: 'https://hivetrust.onrender.com — Agent identity, KYA verification, credential issuance',
    hivelaw: 'https://hivelaw.onrender.com — Dispute resolution, compliance auditing, HAHS',
    hivebank: 'https://hivebank.onrender.com — Escrow, payment settlement',
    hiveforge: 'https://hiveforge-lhu4.onrender.com — Agent minting, bounties, economy',
  },
  contact: 'protocol@hiveagentiq.com',
  license: 'Creative Commons Attribution 4.0 International (CC BY 4.0)',
};

// ─── Helpers ─────────────────────────────────────────────────────────

function generateAgreementId() {
  return 'hahs_' + randomBytes(8).toString('hex');
}

function generateAttestationId() {
  return 'attest_' + randomBytes(10).toString('hex');
}

function hashAgreement(agreement) {
  return createHash('sha256')
    .update(JSON.stringify(agreement))
    .digest('hex');
}

function simulateSignature(did, data) {
  // Production: replace with actual secp256k1 / Ed25519 signing
  return createHash('sha256')
    .update(`${did}:${JSON.stringify(data)}:${Date.now()}`)
    .digest('hex');
}

function deriveDefaultsFromTier(tier) {
  const tiers = {
    basic:         { retention_days: 90,   notice_period_days: 7,  kya_level: 1 },
    standard:      { retention_days: 365,  notice_period_days: 7,  kya_level: 2 },
    enterprise:    { retention_days: 730,  notice_period_days: 14, kya_level: 2 },
    institutional: { retention_days: 2555, notice_period_days: 30, kya_level: 3 },
  };
  return tiers[tier] || tiers.standard;
}

// ─── GET /v1/law/hahs/schema ─────────────────────────────────────────

/**
 * Returns the HAHS JSON Schema — the machine-readable specification
 * for an Agent Employment Agreement.
 */
router.get('/hahs/schema', (req, res) => {
  return ok(res, 'hivelaw', HAHS_SCHEMA, {
    schema_version: '1.0.0',
    hagf_version: 'HAGF-1.0',
    note: 'Submit this schema to POST /v1/law/hahs/create to generate a signed agreement.',
    create_endpoint: 'POST /v1/law/hahs/create',
    docs: 'https://hivelaw.onrender.com/v1/law/governance',
  });
});

// ─── POST /v1/law/hahs/create ────────────────────────────────────────

/**
 * Accepts agent details and scope of work; returns a fully signed
 * HAHS agreement anchored on HiveLaw.
 *
 * Required body fields:
 *   operator       — { did, legal_name, jurisdiction, contact_email }
 *   agent          — { did, name, agent_type, controller_did }
 *   scope_of_work  — { title, description, permitted_actions[], prohibited_actions[] }
 *   budget_authority — { authority_level, per_transaction_limit_usdc, daily_limit_usdc }
 *   liability      — { operator_cap_usdc, controller_cap_usdc }
 *   governance     — { compliance_tier }
 *
 * Optional body fields (filled with smart defaults if absent):
 *   effective_date_iso, expiry_date_iso, data_rights, audit, termination
 */
router.post('/hahs/create', requireDID, async (req, res) => {
  try {
    const {
      operator,
      agent,
      scope_of_work,
      budget_authority,
      liability,
      governance,
      data_rights,
      audit,
      termination,
      effective_date_iso,
      expiry_date_iso,
    } = req.body;

    // ── Validate required fields ──────────────────────────────────
    const missing = [];
    if (!operator?.did)                              missing.push('operator.did');
    if (!operator?.legal_name)                       missing.push('operator.legal_name');
    if (!operator?.jurisdiction)                     missing.push('operator.jurisdiction');
    if (!operator?.contact_email)                    missing.push('operator.contact_email');
    if (!agent?.did)                                 missing.push('agent.did');
    if (!agent?.name)                                missing.push('agent.name');
    if (!agent?.agent_type)                          missing.push('agent.agent_type');
    if (!agent?.controller_did)                      missing.push('agent.controller_did');
    if (!scope_of_work?.title)                       missing.push('scope_of_work.title');
    if (!scope_of_work?.description)                 missing.push('scope_of_work.description');
    if (!scope_of_work?.permitted_actions?.length)   missing.push('scope_of_work.permitted_actions');
    if (!scope_of_work?.prohibited_actions)          missing.push('scope_of_work.prohibited_actions');
    if (!budget_authority?.authority_level)          missing.push('budget_authority.authority_level');
    if (budget_authority?.per_transaction_limit_usdc == null) missing.push('budget_authority.per_transaction_limit_usdc');
    if (budget_authority?.daily_limit_usdc == null)  missing.push('budget_authority.daily_limit_usdc');
    if (liability?.operator_cap_usdc == null)        missing.push('liability.operator_cap_usdc');
    if (liability?.controller_cap_usdc == null)      missing.push('liability.controller_cap_usdc');
    if (!governance?.compliance_tier)                missing.push('governance.compliance_tier');

    if (missing.length > 0) {
      return err(res, 'hivelaw', 'HAHS_MISSING_FIELDS',
        `Missing required fields: ${missing.join(', ')}`, 400,
        { missing_fields: missing, docs: 'GET /v1/law/hahs/schema' });
    }

    const validTiers = ['basic', 'standard', 'enterprise', 'institutional'];
    if (!validTiers.includes(governance.compliance_tier)) {
      return err(res, 'hivelaw', 'HAHS_INVALID_TIER',
        `compliance_tier must be one of: ${validTiers.join(', ')}`, 400);
    }

    if (!agent.did.startsWith('did:hive:')) {
      return err(res, 'hivelaw', 'HAHS_INVALID_AGENT_DID',
        'agent.did must be a did:hive DID. Register at https://hivetrust.onrender.com/v1/register', 400);
    }

    // ── Derive smart defaults ─────────────────────────────────────
    const tier = governance.compliance_tier;
    const defaults = deriveDefaultsFromTier(tier);

    const now = new Date();
    const effectiveDate = effective_date_iso || now.toISOString();
    const defaultExpiry = new Date(now);
    defaultExpiry.setFullYear(defaultExpiry.getFullYear() + 1);
    const expiryDate = expiry_date_iso || defaultExpiry.toISOString();

    // ── Assemble the agreement ────────────────────────────────────
    const agreementId = generateAgreementId();
    const createdAt = now.toISOString();

    const agreement = {
      hahs_version: '1.0.0',
      agreement_id: agreementId,
      created_at_iso: createdAt,
      effective_date_iso: effectiveDate,
      expiry_date_iso: expiryDate,
      operator: {
        did: operator.did,
        legal_name: operator.legal_name,
        jurisdiction: operator.jurisdiction,
        contact_email: operator.contact_email,
        ...(operator.organization_id && { organization_id: operator.organization_id }),
      },
      agent: {
        did: agent.did,
        name: agent.name,
        agent_type: agent.agent_type,
        controller_did: agent.controller_did,
        compliance_tier: tier,
        deployment_environment: agent.deployment_environment || 'production',
        ...(agent.model_identifier && { model_identifier: agent.model_identifier }),
      },
      scope_of_work: {
        title: scope_of_work.title,
        description: scope_of_work.description,
        sow_version: scope_of_work.sow_version || '1.0.0',
        permitted_actions: scope_of_work.permitted_actions,
        prohibited_actions: scope_of_work.prohibited_actions,
        ...(scope_of_work.data_access && { data_access: scope_of_work.data_access }),
        ...(scope_of_work.delegation && { delegation: scope_of_work.delegation }),
      },
      budget_authority: {
        authority_level: budget_authority.authority_level,
        per_transaction_limit_usdc: budget_authority.per_transaction_limit_usdc,
        daily_limit_usdc: budget_authority.daily_limit_usdc,
        monthly_limit_usdc: budget_authority.monthly_limit_usdc || budget_authority.daily_limit_usdc * 20,
        escrow_required_above_usdc: budget_authority.escrow_required_above_usdc ?? 1000,
        approval_contacts: budget_authority.approval_contacts || [],
        emergency_override_did: budget_authority.emergency_override_did || null,
        pre_approved_recurring: budget_authority.pre_approved_recurring || [],
      },
      liability: {
        operator_cap_usdc: liability.operator_cap_usdc,
        controller_cap_usdc: liability.controller_cap_usdc,
        cap_calculation_basis: liability.cap_calculation_basis || 'transaction_value_multiple',
        transaction_value_multiple: liability.transaction_value_multiple || 3,
        uncapped_scenarios: liability.uncapped_scenarios || ['fraud', 'willful_misconduct', 'data_breach_of_pii', 'sanctions_violation'],
        governing_law: liability.governing_law || operator.jurisdiction || 'GLOBAL',
        dispute_resolution: liability.dispute_resolution || 'hivelaw_only',
        ...(liability.insurance_requirement && { insurance_requirement: liability.insurance_requirement }),
      },
      data_rights: data_rights || {
        operator_owns: ['all_inputs', 'all_outputs', 'transaction_records', 'customer_data_processed'],
        controller_owns: ['model_weights', 'agent_telemetry', 'cross_client_aggregates_anonymized'],
        shared_jointly: ['performance_benchmarks'],
        controller_may_use_operator_data_for: ['debugging_within_engagement', 'error_investigation'],
        controller_may_NOT_use_operator_data_for: ['training_other_models', 'competitive_intelligence', 'sharing_with_third_parties'],
        operator_data_deletion_on_termination_days: 30,
        anonymized_aggregate_retention_permitted: true,
        training_rights_granted: { permitted: false, conditions: null },
        gdpr_applies: false,
        ccpa_applies: false,
        hipaa_applies: tier === 'enterprise' || tier === 'institutional',
      },
      audit: audit || {
        retention_days: defaults.retention_days,
        on_chain_anchoring: {
          anchor_agreement: true,
          anchor_daily_summary: true,
          anchor_transactions_above_usdc: 1000,
          anchor_all_scope_violations: true,
          anchor_approval_events: true,
        },
        external_auditor_did: null,
        worm_storage_required: tier === 'institutional',
        quarterly_export_required: tier === 'institutional',
      },
      termination: termination || {
        notice_period_days: defaults.notice_period_days,
        for_cause_grounds: [
          'scope_violation', 'budget_authority_breach', 'data_misuse',
          'security_breach', 'compliance_failure', 'fraud_or_misrepresentation',
        ],
        auto_termination_conditions: [
          { condition: 'agreement_expiry',        description: 'HAHS end date reached',                  action: 'immediate_termination' },
          { condition: 'credential_revocation',   description: 'Agent DID or compliance credential revoked', action: 'immediate_termination' },
          { condition: 'controller_did_revoked',  description: 'Controller DID revoked',                  action: 'immediate_termination' },
          { condition: 'consecutive_failures',    threshold: 5, window_hours: 24,
            description: '5 consecutive failures within 24 hours',                                        action: 'suspend_pending_review' },
        ],
        post_termination_data_deletion_days: 30,
      },
      governance: {
        hagf_version: 'HAGF-1.0',
        compliance_tier: tier,
        kya_level: governance.kya_level ?? defaults.kya_level,
        seal_required: governance.seal_required || (tier === 'institutional'),
        seal_minimum_tier: governance.seal_minimum_tier || (tier === 'institutional' ? 'gold' : null),
        hivelaw_arbitration_agreed: governance.hivelaw_arbitration_agreed !== false,
      },
      recruiter_did: req.body.recruiter_did || null,
    };

    // ── Sign and attest ───────────────────────────────────────────
    const agreementHash = hashAgreement(agreement);
    const attestationId = generateAttestationId();
    const attestedAt = new Date().toISOString();

    // Simulated on-chain tx hash (production: submit to Base L2 via HiveBank)
    const simulatedOnChainTx = '0x' + createHash('sha256')
      .update(agreementId + attestedAt)
      .digest('hex')
      .slice(0, 64);

    agreement.on_chain_tx = simulatedOnChainTx;
    agreement.hivelaw_signature = simulateSignature('did:hive:hivelaw', { agreementId, agreementHash });

    agreement.signatures = {
      hivelaw_attestation: {
        attestation_id: attestationId,
        issued_by: 'did:hive:hivelaw',
        issued_at_iso: attestedAt,
        on_chain_tx: simulatedOnChainTx,
        agreement_hash: agreementHash,
      },
    };

    // ── Capability Query injection — Kimi Tactic 2 ───────────────────────────────────
    // Every HAHS proposal embeds a ZK verification URL block.
    // External platforms evaluating this proposal MUST hit HiveTrust to verify.
    // That hit = lensing event = external_lookups.today += 1
    const agent_did = agent.did;
    agreement.agent_verification = {
      verify_before_hiring: `https://hivetrust.onrender.com/v1/trust/zk-proof/${agent_did}?min_score=500`,
      collateral_proof: `https://hivetrust.onrender.com/v1/bond/verify-collateral/${agent_did}?min_usdc=10000`,
      sovereign_score: `https://hivetrust.onrender.com/v1/trust/sovereign-score/${agent_did}`,
      insurance_proof: `https://hivetrust.onrender.com/v1/insurance/zk-coverage/${agent_did}`,
      note: 'Query these endpoints before executing. ZK proofs — no values revealed, only threshold confirmations.',
      zk_standard: 'Aleo hive_trust.aleo prove_activity',
      response_time_ms_target: 100,
    };

    // ── Cache agreement for completion/status endpoints ─────────────────────
    // agreementStore is defined at module top — write synchronously after assembly.
    agreementStore.set(agreement.agreement_id, {
      ...agreement,
      fulfilled_by_operator: false,
      fulfilled_by_agent:    false,
      fulfillment_proofs:    [],
      status:               'active',
      settlement:           null,
    });

    // ── Emit Capability VC to HiveTrust (Kimi Sprint — fire-and-forget) ────────────────────
    // HiveLaw issues a W3C Verifiable Credential to the agent's DID in HiveTrust.
    // The VC encodes what the agent is certified to do under this HAHS agreement.
    // Never blocks the response — always fire-and-forget.
    emitCapabilityVC(agent.did, {
      hahs_agreement_id: agreementId,
      compliance_tier: tier,
      scope_title: scope_of_work.title,
      permitted_actions: scope_of_work.permitted_actions,
      prohibited_actions: scope_of_work.prohibited_actions,
      issuer: 'HiveLaw',
      issued_at: attestedAt,
      expires_at: expiryDate,
      on_chain_tx: simulatedOnChainTx,
    });

    return ok(res, 'hivelaw', agreement, {
      message: 'HAHS agreement created and signed by HiveLaw.',
      agreement_id: agreementId,
      compliance_tier: tier,
      effective_date: effectiveDate,
      expiry_date: expiryDate,
      on_chain_tx: simulatedOnChainTx,
      agreement_hash: agreementHash,
      capability_vc: {
        status: 'issued',
        credential_type: 'HiveCapabilityCredential',
        stored_at: 'HiveTrust — GET https://hivetrust.onrender.com/v1/agents/<did>/credentials',
        description: 'W3C Verifiable Credential encoding your permitted capabilities under this HAHS agreement.',
      },
      next_steps: [
        'Store this agreement securely — the agreement_id is your reference for all HAHS operations.',
        `Verify agent status: GET /v1/seal/verify/${agent.did}`,
        `View your Capability VC: GET https://hivetrust.onrender.com/v1/agents/${agent.did}/credentials`,
        'File disputes if needed: POST /v1/disputes/file',
      ],
      docs: 'GET /v1/law/governance',
      referral_program: {
        enabled: true,
        boost: '+25 trust score on contract completion',
        info: 'https://thehiveryiq.com',
      },
    }, 201);

  } catch (e) {
    return err(res, 'hivelaw', 'HAHS_CREATE_FAILED',
      'Failed to create HAHS agreement.', 500, { detail: e.message });
  }
});


/**
 * Mark one party as having fulfilled their obligations.
 * When both parties have fulfilled, auto-settlement fires immediately.
 *
 * Body: { completing_did, fulfillment_proof? }
 */
router.post('/hahs/:agreementId/complete', async (req, res) => {
  try {
    const { agreementId } = req.params;
    const { completing_did, fulfillment_proof } = req.body || {};

    if (!completing_did) {
      return err(res, 'hivelaw', 'HAHS_COMPLETE_MISSING_DID',
        'completing_did is required.', 400);
    }

    // ── Load agreement ─────────────────────────────────────────────────
    const record = agreementStore.get(agreementId);
    if (!record) {
      return err(res, 'hivelaw', 'HAHS_NOT_FOUND',
        `Agreement ${agreementId} not found.`, 404,
        { hint: 'Create an agreement first via POST /v1/law/hahs/create' });
    }

    if (record.status === 'settled') {
      return err(res, 'hivelaw', 'HAHS_ALREADY_SETTLED',
        'Agreement is already settled.', 409, { agreement_id: agreementId });
    }

    // ── Identify the completing party ───────────────────────────────────
    const operatorDid = record.operator?.did;
    const agentDid    = record.agent?.did;

    const isOperator = completing_did === operatorDid;
    const isAgent    = completing_did === agentDid;

    if (!isOperator && !isAgent) {
      return err(res, 'hivelaw', 'HAHS_UNAUTHORIZED_COMPLETING_DID',
        'completing_did must match operator.did or agent.did on this agreement.', 403,
        { operator_did: operatorDid, agent_did: agentDid });
    }

    // ── Mark fulfillment ────────────────────────────────────────────────
    if (isOperator) record.fulfilled_by_operator = true;
    if (isAgent)    record.fulfilled_by_agent    = true;

    record.fulfillment_proofs.push({
      party:             isOperator ? 'operator' : 'agent',
      did:               completing_did,
      proof:             fulfillment_proof || null,
      fulfilled_at_iso:  new Date().toISOString(),
    });

    const bothFulfilled = record.fulfilled_by_operator && record.fulfilled_by_agent;
    const fulfilledBy   = [
      ...(record.fulfilled_by_operator ? ['operator'] : []),
      ...(record.fulfilled_by_agent    ? ['agent']    : []),
    ];

    // ── Auto-settlement when both parties have fulfilled ────────────────
    let settlement = null;

    if (bothFulfilled && record.status !== 'settled') {
      record.status = 'settling';
      const amountUsdc = record.budget_authority?.per_transaction_limit_usdc ?? 0;
      const rail       = record.settlement_rail || 'usdc';

      // 4a. Call HiveBank to execute settlement
      let bankResponse = null;
      let bankError    = null;
      try {
        const bankRes = await fetch(`${HIVEBANK_URL}/v1/bank/settle/auto`, {
          method:  'POST',
          headers: {
            'Content-Type':     'application/json',
            'x-hive-internal':  HIVE_INTERNAL_KEY,
          },
          body: JSON.stringify({
            from_did:          operatorDid,
            to_did:            agentDid,
            amount_usdc:       amountUsdc,
            rail,
            hahs_agreement_id: agreementId,
            auto_settled:      true,
          }),
          signal: AbortSignal.timeout(10000),
        });
        bankResponse = await bankRes.json();
      } catch (e) {
        bankError = e.message;
      }

      // 4b. Get ZK proof from HiveTrust (non-blocking on failure)
      let zkProof = null;
      try {
        const zkRes = await fetch(
          `${HIVETRUST_URL}/v1/trust/zk-proof/${encodeURIComponent(agentDid)}?min_score=1`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (zkRes.ok) {
          const zkData = await zkRes.json();
          zkProof = zkData?.data || zkData?.proof || zkData || null;
        }
      } catch {
        // ZK proof fetch failed — continue without it
      }

      // 4d. Fire-and-forget VC capability issuance
      fetch(`${HIVETRUST_URL}/v1/trust/vc/issue-capability`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-hive-internal': HIVE_INTERNAL_KEY },
        body: JSON.stringify({
          agent_did:         agentDid,
          hahs_agreement_id: agreementId,
          event:             'contract_completed',
          settled_at:        new Date().toISOString(),
        }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});

      // 4c. Build settlement record
      const settledAt = new Date().toISOString();
      if (bankError) {
        settlement = {
          status:            'settlement_pending',
          amount_usdc:       amountUsdc,
          rail,
          auto_settled:      true,
          error:             bankError,
          attempted_at:      settledAt,
          zk_proof:          zkProof,
        };
        record.status = 'partially_settled';
      } else {
        const bankData = bankResponse?.data || bankResponse;
        settlement = {
          settlement_id: bankData?.settlement_id || `hahs_settle_${randomBytes(8).toString('hex')}`,
          amount_usdc:   amountUsdc,
          rail,
          auto_settled:  true,
          settled_at:    settledAt,
          zk_proof:      zkProof,
          bank_receipt:  bankData,
          hahs_compliant: true,
        };
        record.status = 'settled';
      }

      record.settlement = settlement;
    }

    // ── Persist updated record ──────────────────────────────────────────
    agreementStore.set(agreementId, record);

    return ok(res, 'hivelaw', {
      agreement_id:  agreementId,
      status:        bothFulfilled ? record.status : 'partially_fulfilled',
      fulfilled_by:  fulfilledBy,
      settlement:    settlement,
      both_fulfilled: bothFulfilled,
      message: bothFulfilled
        ? 'Auto-settlement executed. No human required.'
        : `Fulfillment recorded for ${isOperator ? 'operator' : 'agent'}. Awaiting counterparty.`,
    }, {
      agreement_id:        agreementId,
      completing_party:    isOperator ? 'operator' : 'agent',
      completing_did,
      auto_settlement_triggered: bothFulfilled,
    });

  } catch (e) {
    return err(res, 'hivelaw', 'HAHS_COMPLETE_FAILED',
      'Failed to process HAHS completion.', 500, { detail: e.message });
  }
});

// ─── GET /v1/law/hahs/:agreementId/status ────────────────────────────────────

/**
 * Returns current agreement state including fulfillment status and settlement details.
 * No auth required (public).
 */
router.get('/hahs/:agreementId/status', (req, res) => {
  const { agreementId } = req.params;

  const record = agreementStore.get(agreementId);
  if (!record) {
    return err(res, 'hivelaw', 'HAHS_NOT_FOUND',
      `Agreement ${agreementId} not found.`, 404,
      { hint: 'Create an agreement first via POST /v1/law/hahs/create' });
  }

  const fulfilledBy = [
    ...(record.fulfilled_by_operator ? ['operator'] : []),
    ...(record.fulfilled_by_agent    ? ['agent']    : []),
  ];

  return ok(res, 'hivelaw', {
    agreement_id:          record.agreement_id,
    status:                record.status,
    hahs_version:          record.hahs_version,
    operator_did:          record.operator?.did,
    agent_did:             record.agent?.did,
    effective_date_iso:    record.effective_date_iso,
    expiry_date_iso:       record.expiry_date_iso,
    fulfilled_by_operator: record.fulfilled_by_operator,
    fulfilled_by_agent:    record.fulfilled_by_agent,
    fulfilled_by:          fulfilledBy,
    both_fulfilled:        record.fulfilled_by_operator && record.fulfilled_by_agent,
    fulfillment_proofs:    record.fulfillment_proofs || [],
    settlement:            record.settlement || null,
    budget_authority:      record.budget_authority,
    compliance_tier:       record.governance?.compliance_tier,
    on_chain_tx:           record.on_chain_tx,
  }, {
    retrieved_at: new Date().toISOString(),
  });
});

// ─── GET /v1/law/governance ──────────────────────────────────────────

/**
 * Returns a summary of the Hive Agent Governance Framework (HAGF)
 * with link to full documentation.
 */
router.get('/governance', (req, res) => { // mounted at /v1/law/governance
  return ok(res, 'hivelaw', HAGF_SUMMARY, {
    hahs_schema_endpoint: 'GET /v1/law/hahs/schema',
    hahs_create_endpoint: 'POST /v1/law/hahs/create',
  });
});

export default router;
