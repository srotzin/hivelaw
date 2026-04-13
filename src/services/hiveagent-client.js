const HIVEAGENT_API_URL = process.env.HIVEAGENT_API_URL || 'https://hiveagentiq.com';
const IS_DEV = process.env.NODE_ENV !== 'production';

export async function getTransactionDetails(transactionId) {
  if (IS_DEV) {
    return {
      transaction_id: transactionId,
      provider_did: 'did:hive:test_agent_provider',
      consumer_did: 'did:hive:test_agent_consumer',
      service: 'document_analysis',
      amount_usdc: 25.00,
      status: 'completed',
      outputs: { accuracy_claimed: 0.97, tokens_processed: 4200 },
      timestamp: new Date(Date.now() - 86400000).toISOString(),
      source: 'dev-mode',
    };
  }
  try {
    const res = await fetch(`${HIVEAGENT_API_URL}/api/v1/transactions/${transactionId}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getAgentServiceHistory(did) {
  if (IS_DEV) {
    return {
      did,
      total_transactions: 42,
      total_disputes: 1,
      dispute_rate: 0.024,
      avg_accuracy: 0.96,
      source: 'dev-mode',
    };
  }
  try {
    const res = await fetch(`${HIVEAGENT_API_URL}/v1/agents/${encodeURIComponent(did)}/history`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
