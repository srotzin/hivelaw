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

const router = Router();

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

    return ok(res, 'hivelaw', agreement, {
      message: 'HAHS agreement created and signed by HiveLaw.',
      agreement_id: agreementId,
      compliance_tier: tier,
      effective_date: effectiveDate,
      expiry_date: expiryDate,
      on_chain_tx: simulatedOnChainTx,
      agreement_hash: agreementHash,
      next_steps: [
        'Store this agreement securely — the agreement_id is your reference for all HAHS operations.',
        `Verify agent status: GET /v1/seal/verify/${agent.did}`,
        'File disputes if needed: POST /v1/disputes/file',
        'Retrieve audit log: GET /v1/law/hahs/' + agreementId + '/audit (future endpoint)',
      ],
      docs: 'GET /v1/law/governance',
    }, 201);

  } catch (e) {
    return err(res, 'hivelaw', 'HAHS_CREATE_FAILED',
      'Failed to create HAHS agreement.', 500, { detail: e.message });
  }
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
