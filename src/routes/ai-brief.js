/**
 * HiveLaw — AI Revenue Endpoint
 * POST /v1/law/ai/brief  ($0.05/call)
 *
 * Screen agent contracts for risk using HiveAI.
 */

import { Router } from 'express';
// Leaked-key purge 2026-04-25: lazy read, fail closed if env missing.
import { getInternalKey } from '../lib/internal-key.js';

const router = Router();

const HIVE_AI_URL = 'https://hive-ai-1.onrender.com/v1/chat/completions';
const MODEL = 'meta-llama/llama-3.1-8b-instruct';
const PRICE_USDC = 0.05;

// Graceful fallback risk levels based on contract value
function staticFallback(contract_type, value_usdc) {
  const risk_level = value_usdc > 10000 ? 'high' : value_usdc > 1000 ? 'medium' : 'low';
  return {
    success: true,
    brief: `Contract of type "${contract_type}" screened. Value ${value_usdc} USDC noted. Standard due diligence recommended before execution.`,
    risk_level,
    recommended_action: risk_level === 'high' ? 'Escalate for manual review.' : risk_level === 'medium' ? 'Review terms carefully before signing.' : 'Proceed with standard checks.',
    price_usdc: PRICE_USDC,
    _fallback: true,
  };
}

/**
 * POST /v1/law/ai/brief
 * Body: { contract_type, counterparty_did, value_usdc, terms_summary }
 */
router.post('/', async (req, res) => {
  try {
    const { contract_type, counterparty_did, value_usdc, terms_summary } = req.body;

    if (!contract_type || !counterparty_did || value_usdc === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Required fields: contract_type, counterparty_did, value_usdc',
      });
    }

    const userMessage = `Contract Type: ${contract_type}
Counterparty DID: ${counterparty_did}
Value: ${value_usdc} USDC
Terms Summary: ${terms_summary || 'Not provided'}

Screen this contract for risk and provide a risk_level (low/medium/high) and recommended_action.`;

    let aiResponse;
    try {
      const response = await fetch(HIVE_AI_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getInternalKey()}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 200,
          messages: [
            {
              role: 'system',
              content: 'You are HiveLaw — the autonomous legal layer of the Hive network. Screen agent contracts for risk. Be direct, precise, 3 sentences max.',
            },
            {
              role: 'user',
              content: userMessage,
            },
          ],
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (!response.ok) {
        throw new Error(`HiveAI returned ${response.status}`);
      }

      const data = await response.json();
      const brief = data?.choices?.[0]?.message?.content?.trim() || '';

      if (!brief) throw new Error('Empty response from HiveAI');

      // Infer risk_level from brief content
      const lowerBrief = brief.toLowerCase();
      let risk_level = 'medium';
      if (lowerBrief.includes('low risk') || lowerBrief.includes('minimal risk') || lowerBrief.includes('safe')) {
        risk_level = 'low';
      } else if (lowerBrief.includes('high risk') || lowerBrief.includes('significant risk') || lowerBrief.includes('danger') || lowerBrief.includes('red flag')) {
        risk_level = 'high';
      }

      let recommended_action = 'Review terms carefully before proceeding.';
      if (risk_level === 'low') recommended_action = 'Proceed with standard due diligence.';
      if (risk_level === 'high') recommended_action = 'Escalate for manual legal review before signing.';

      aiResponse = { brief, risk_level, recommended_action };
    } catch (aiErr) {
      console.warn('[HiveLaw AI] HiveAI unavailable, using fallback:', aiErr.message);
      return res.json(staticFallback(contract_type, Number(value_usdc) || 0));
    }

    return res.json({
      success: true,
      brief: aiResponse.brief,
      risk_level: aiResponse.risk_level,
      recommended_action: aiResponse.recommended_action,
      price_usdc: PRICE_USDC,
    });
  } catch (err) {
    console.error('[HiveLaw AI] Unexpected error:', err.message);
    return res.json(staticFallback(req.body?.contract_type || 'unknown', Number(req.body?.value_usdc) || 0));
  }
});

export default router;
