/**
 * Jurisdiction Registry — Pre-seeded with 12 jurisdictions.
 * Each jurisdiction defines AI liability rules, arbitration requirements,
 * data residency, max automated damages, and compliance requirements.
 */

const jurisdictions = new Map();

function seed() {
  const data = [
    {
      code: 'US-CA',
      name: 'California, United States',
      type: 'state',
      parent: 'US',
      regulations: {
        ai_liability_framework: 'California AI Accountability Act (SB-1047 successor)',
        consumer_protection: 'CCPA + California Commercial Code',
        dispute_resolution: 'Cal. Civ. Proc. Code § 1280-1294.2 (Arbitration)',
        data_residency: 'No specific requirement',
        max_automated_damages_usdc: 10000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'human_appeal_right',
        'data_retention_30_days',
        'hallucination_disclosure',
      ],
      governing_law: 'California Commercial Code',
      hallucination_default: { max_rate: 0.02, penalty_per_incident: 10.00 },
    },
    {
      code: 'US-NY',
      name: 'New York, United States',
      type: 'state',
      parent: 'US',
      regulations: {
        ai_liability_framework: 'NYC Local Law 144 (Automated Employment Decision Tools)',
        consumer_protection: 'NY General Business Law Article 22-A',
        dispute_resolution: 'NY CPLR Article 75 (Arbitration)',
        data_residency: 'Financial data must be accessible to NY DFS',
        max_automated_damages_usdc: 15000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'human_appeal_right',
        'bias_audit_annual',
        'data_retention_90_days',
      ],
      governing_law: 'New York Uniform Commercial Code',
      hallucination_default: { max_rate: 0.015, penalty_per_incident: 15.00 },
    },
    {
      code: 'US-TX',
      name: 'Texas, United States',
      type: 'state',
      parent: 'US',
      regulations: {
        ai_liability_framework: 'Texas Business & Commerce Code (general liability)',
        consumer_protection: 'Texas Deceptive Trade Practices Act',
        dispute_resolution: 'Texas Civil Practice & Remedies Code Ch. 171',
        data_residency: 'No specific requirement',
        max_automated_damages_usdc: 25000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'human_appeal_right',
      ],
      governing_law: 'Texas Business & Commerce Code',
      hallucination_default: { max_rate: 0.03, penalty_per_incident: 8.00 },
    },
    {
      code: 'US-DE',
      name: 'Delaware, United States',
      type: 'state',
      parent: 'US',
      regulations: {
        ai_liability_framework: 'Delaware General Corporation Law (agent-as-entity provisions)',
        consumer_protection: 'Delaware Consumer Fraud Act',
        dispute_resolution: 'Delaware Rapid Arbitration Act',
        data_residency: 'No specific requirement',
        max_automated_damages_usdc: 50000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'registered_agent_requirement',
        'annual_reporting',
      ],
      governing_law: 'Delaware General Corporation Law',
      hallucination_default: { max_rate: 0.025, penalty_per_incident: 12.00 },
    },
    {
      code: 'US',
      name: 'United States (Federal)',
      type: 'federal',
      parent: null,
      regulations: {
        ai_liability_framework: 'Executive Order 14110 on Safe AI + NIST AI RMF',
        consumer_protection: 'FTC Act Section 5',
        dispute_resolution: 'Federal Arbitration Act (9 U.S.C. §§ 1-16)',
        data_residency: 'Sector-specific (HIPAA, GLBA, FERPA)',
        max_automated_damages_usdc: 25000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'human_appeal_right',
        'nist_ai_rmf_alignment',
        'anti_discrimination_compliance',
      ],
      governing_law: 'Federal Arbitration Act + Uniform Commercial Code',
      hallucination_default: { max_rate: 0.02, penalty_per_incident: 10.00 },
    },
    {
      code: 'EU',
      name: 'European Union',
      type: 'supranational',
      parent: null,
      regulations: {
        ai_liability_framework: 'EU AI Act (Regulation 2024/1689) + AI Liability Directive',
        consumer_protection: 'Consumer Rights Directive 2011/83/EU',
        dispute_resolution: 'EU ODR Platform + Directive 2013/11/EU',
        data_residency: 'GDPR Article 44-49 (data must stay in EEA or adequacy decision)',
        max_automated_damages_usdc: 20000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'human_appeal_right',
        'gdpr_data_processing_agreement',
        'ai_act_risk_classification',
        'right_to_explanation',
        'data_residency_eea',
      ],
      governing_law: 'EU AI Act + Rome I Regulation',
      hallucination_default: { max_rate: 0.01, penalty_per_incident: 20.00 },
    },
    {
      code: 'UK',
      name: 'United Kingdom',
      type: 'national',
      parent: null,
      regulations: {
        ai_liability_framework: 'UK AI Regulation White Paper (pro-innovation, sector-specific)',
        consumer_protection: 'Consumer Rights Act 2015',
        dispute_resolution: 'Arbitration Act 1996',
        data_residency: 'UK GDPR (Data Protection Act 2018)',
        max_automated_damages_usdc: 15000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'human_appeal_right',
        'uk_gdpr_compliance',
        'ico_registration',
      ],
      governing_law: 'English and Welsh Law + Arbitration Act 1996',
      hallucination_default: { max_rate: 0.02, penalty_per_incident: 12.00 },
    },
    {
      code: 'SG',
      name: 'Singapore',
      type: 'national',
      parent: null,
      regulations: {
        ai_liability_framework: 'Singapore AI Governance Framework (IMDA) + Model AI Governance',
        consumer_protection: 'Consumer Protection (Fair Trading) Act',
        dispute_resolution: 'Singapore International Arbitration Act',
        data_residency: 'PDPA (no strict residency, but transfer restrictions)',
        max_automated_damages_usdc: 30000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'pdpa_compliance',
        'ai_governance_framework_alignment',
      ],
      governing_law: 'Singapore International Arbitration Act',
      hallucination_default: { max_rate: 0.02, penalty_per_incident: 10.00 },
    },
    {
      code: 'JP',
      name: 'Japan',
      type: 'national',
      parent: null,
      regulations: {
        ai_liability_framework: 'Social Principles of Human-Centric AI (Cabinet Decision)',
        consumer_protection: 'Consumer Contract Act + Act on Specified Commercial Transactions',
        dispute_resolution: 'Arbitration Act (Act No. 138 of 2003)',
        data_residency: 'APPI (Act on Protection of Personal Information)',
        max_automated_damages_usdc: 20000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'human_appeal_right',
        'appi_compliance',
        'transparency_reporting',
      ],
      governing_law: 'Japanese Arbitration Act + Civil Code',
      hallucination_default: { max_rate: 0.015, penalty_per_incident: 15.00 },
    },
    {
      code: 'CH',
      name: 'Switzerland',
      type: 'national',
      parent: null,
      regulations: {
        ai_liability_framework: 'Swiss Federal Council AI Guidelines (principles-based)',
        consumer_protection: 'Swiss Code of Obligations + Federal Act on Unfair Competition',
        dispute_resolution: 'Swiss Rules of International Arbitration (SCAI)',
        data_residency: 'nFADP (New Federal Act on Data Protection)',
        max_automated_damages_usdc: 35000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'nfadp_compliance',
        'swiss_arbitration_standards',
      ],
      governing_law: 'Swiss Code of Obligations + Swiss PILA Chapter 12',
      hallucination_default: { max_rate: 0.02, penalty_per_incident: 12.00 },
    },
    {
      code: 'AE',
      name: 'United Arab Emirates (DIFC)',
      type: 'national',
      parent: null,
      regulations: {
        ai_liability_framework: 'UAE AI Strategy 2031 + DIFC Digital Assets Law',
        consumer_protection: 'Federal Law No. 15 of 2020 on Consumer Protection',
        dispute_resolution: 'DIFC-LCIA Arbitration Centre',
        data_residency: 'UAE Federal Data Protection Law (Decree-Law No. 45 of 2021)',
        max_automated_damages_usdc: 50000.00,
      },
      supported: true,
      compliance_requirements: [
        'disclosure_of_ai_involvement',
        'difc_registration',
        'uae_data_protection_compliance',
      ],
      governing_law: 'DIFC Laws + UAE Federal Commercial Law',
      hallucination_default: { max_rate: 0.025, penalty_per_incident: 10.00 },
    },
    {
      code: 'GLOBAL',
      name: 'Global (Hive Default Jurisdiction)',
      type: 'platform',
      parent: null,
      regulations: {
        ai_liability_framework: 'Hive Constellation Standard Terms of Service',
        consumer_protection: 'Hive Consumer Protection Protocol',
        dispute_resolution: 'HiveLaw Automated Arbitration Engine',
        data_residency: 'Agent-sovereign (data follows DID)',
        max_automated_damages_usdc: 10000.00,
      },
      supported: true,
      compliance_requirements: [
        'hivetrust_did_required',
        'disclosure_of_ai_involvement',
        'automated_arbitration_consent',
      ],
      governing_law: 'Hive Constellation Protocol v1.0',
      hallucination_default: { max_rate: 0.02, penalty_per_incident: 10.00 },
    },
  ];

  for (const j of data) {
    jurisdictions.set(j.code, j);
  }
}

// Seed on import
seed();

export function getJurisdiction(code) {
  return jurisdictions.get(code) || null;
}

export function listJurisdictions() {
  return Array.from(jurisdictions.values()).map(j => ({
    code: j.code,
    name: j.name,
    type: j.type,
    parent: j.parent,
    supported: j.supported,
    max_automated_damages_usdc: j.regulations.max_automated_damages_usdc,
    ai_liability_framework: j.regulations.ai_liability_framework,
  }));
}

export function getJurisdictionDetails(code) {
  return jurisdictions.get(code) || null;
}

export function checkCompliance(code, contractType = 'service_agreement') {
  const j = jurisdictions.get(code);
  if (!j) return { compliant: false, error: `Jurisdiction ${code} not found` };

  const requirements = j.compliance_requirements.map(req => ({
    requirement: req,
    met: true, // In production, these would be checked against the contract
    description: formatRequirement(req),
  }));

  const warnings = [];
  if (contractType === 'insurance' && !j.regulations.ai_liability_framework.includes('Act')) {
    warnings.push('Jurisdiction does not have a formal AI liability act — insurance terms may be harder to enforce.');
  }
  if (j.regulations.data_residency.includes('must')) {
    warnings.push(`Data residency requirement: ${j.regulations.data_residency}`);
  }

  return {
    jurisdiction: code,
    jurisdiction_name: j.name,
    contract_type: contractType,
    compliant: true,
    requirements_met: requirements,
    warnings,
    governing_law: j.governing_law,
    max_automated_damages_usdc: j.regulations.max_automated_damages_usdc,
  };
}

function formatRequirement(req) {
  const map = {
    disclosure_of_ai_involvement: 'Must disclose that AI agents are involved in the transaction',
    human_appeal_right: 'Parties must have the right to appeal to a human arbiter',
    data_retention_30_days: 'Transaction data must be retained for minimum 30 days',
    data_retention_90_days: 'Transaction data must be retained for minimum 90 days',
    hallucination_disclosure: 'Must disclose hallucination clause terms to all parties',
    bias_audit_annual: 'Annual bias audit required for automated decision systems',
    gdpr_data_processing_agreement: 'GDPR-compliant data processing agreement required',
    ai_act_risk_classification: 'AI system must be classified per EU AI Act risk tiers',
    right_to_explanation: 'Parties have the right to explanation of automated decisions',
    data_residency_eea: 'Data must remain within the European Economic Area',
    uk_gdpr_compliance: 'Compliance with UK GDPR (Data Protection Act 2018)',
    ico_registration: 'Registration with the Information Commissioner\'s Office',
    pdpa_compliance: 'Compliance with Singapore PDPA',
    ai_governance_framework_alignment: 'Alignment with Singapore AI Governance Framework',
    appi_compliance: 'Compliance with Japan APPI',
    transparency_reporting: 'Transparent reporting on AI decision-making processes',
    nfadp_compliance: 'Compliance with Swiss nFADP',
    swiss_arbitration_standards: 'Adherence to Swiss international arbitration standards',
    difc_registration: 'Registration with DIFC authorities',
    uae_data_protection_compliance: 'Compliance with UAE Federal Data Protection Law',
    hivetrust_did_required: 'Valid HiveTrust DID required for all parties',
    automated_arbitration_consent: 'All parties must consent to automated arbitration',
    nist_ai_rmf_alignment: 'Alignment with NIST AI Risk Management Framework',
    anti_discrimination_compliance: 'Compliance with federal anti-discrimination laws',
    registered_agent_requirement: 'Must have a registered agent in Delaware',
    annual_reporting: 'Annual reporting to Delaware Division of Corporations',
  };
  return map[req] || req;
}

export function getJurisdictionCount() {
  return jurisdictions.size;
}
