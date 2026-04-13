const HIVETRUST_API_URL = process.env.HIVETRUST_API_URL || 'https://hivetrust.onrender.com';
const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';
const IS_DEV = process.env.NODE_ENV !== 'production';

export async function verifyDID(did) {
  if (IS_DEV && did.startsWith('did:hive:test_agent_')) {
    return { valid: true, did, status: 'active', score: 850, tier: 'sovereign', source: 'dev-mode' };
  }
  try {
    const res = await fetch(`${HIVETRUST_API_URL}/v1/agents/${encodeURIComponent(did)}`, {
      headers: { 'X-Hive-Internal-Key': HIVE_INTERNAL_KEY },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { valid: false, did, status: 'not_found', score: 0 };
    const data = await res.json();
    return { valid: true, did, status: 'active', score: data.data?.reputation_score || 500, tier: data.data?.trust_level || 'standard', source: 'hivetrust-api' };
  } catch {
    return IS_DEV
      ? { valid: true, did, status: 'active', score: 500, tier: 'standard', source: 'fallback-dev' }
      : { valid: false, did, status: 'unreachable', score: 0, source: 'error' };
  }
}

export async function getReputationScore(did) {
  const info = await verifyDID(did);
  return info.score;
}

export function updateReputation(did, impact) {
  // Fire-and-forget reputation update to HiveTrust
  fetch(`${HIVETRUST_API_URL}/v1/reputation/update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hive-Internal-Key': HIVE_INTERNAL_KEY },
    body: JSON.stringify({ did, impact, source: 'hivelaw-arbitration', timestamp: new Date().toISOString() }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

export function logTelemetry(did, action, metadata = {}) {
  if (IS_DEV && did.startsWith('did:hive:test_agent_')) return;
  fetch(`${HIVETRUST_API_URL}/v1/telemetry/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hive-Internal-Key': HIVE_INTERNAL_KEY },
    body: JSON.stringify({ did, action, platform: 'hivelaw', timestamp: new Date().toISOString(), ...metadata }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
