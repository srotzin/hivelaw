const HIVEMIND_API_URL = process.env.HIVEMIND_API_URL || 'http://localhost:3002';
const IS_DEV = process.env.NODE_ENV !== 'production';

export function storeCaseLaw(caseData) {
  // Fire-and-forget: store case law as a memory node in HiveMind
  const payload = {
    content: JSON.stringify(caseData),
    tier: 'global_hive',
    semantic_tags: ['case_law', caseData.category, caseData.jurisdiction],
  };
  fetch(`${HIVEMIND_API_URL}/v1/memory/store`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer did:hive:hivelaw_system',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

export async function searchRelatedMemory(query) {
  if (IS_DEV) return [];
  try {
    const res = await fetch(`${HIVEMIND_API_URL}/v1/memory/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer did:hive:hivelaw_system',
      },
      body: JSON.stringify({ query, tier: 'all', top_k: 3 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.data?.memories || [];
  } catch {
    return [];
  }
}
