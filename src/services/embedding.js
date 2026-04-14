import crypto from 'node:crypto';

const DIMENSIONS = 128;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

/**
 * Hash-based pseudo-embedding fallback — deterministic, no external dependency.
 * Produces a normalized 128-dimensional vector from SHA-512 hashing.
 */
export function hashEmbed(text) {
  const normalized = text.toLowerCase().trim();
  const vec = new Float64Array(DIMENSIONS);
  const rounds = Math.ceil(DIMENSIONS / 8);
  for (let r = 0; r < rounds; r++) {
    const hash = crypto.createHash('sha512').update(`${r}:${normalized}`).digest();
    for (let i = 0; i < 8 && r * 8 + i < DIMENSIONS; i++) {
      vec[r * 8 + i] = hash.readInt32BE(i * 8) / 2147483647;
    }
  }
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return Array.from(vec);
}

/**
 * Generate a real semantic embedding via OpenAI text-embedding-3-small.
 * Falls back to hashEmbed() when OPENAI_API_KEY is not set or API call fails.
 * Uses native fetch (no openai package dependency).
 */
export async function embed(text) {
  if (!OPENAI_API_KEY) {
    return hashEmbed(text);
  }

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: text,
        dimensions: DIMENSIONS,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[embedding] OpenAI API error: ${res.status} ${res.statusText}`);
      return hashEmbed(text);
    }

    const data = await res.json();
    const vector = data.data?.[0]?.embedding;

    if (!vector || vector.length !== DIMENSIONS) {
      console.error('[embedding] Unexpected response shape, falling back to hashEmbed');
      return hashEmbed(text);
    }

    return vector;
  } catch (err) {
    console.error('[embedding] OpenAI call failed, falling back to hashEmbed:', err.message);
    return hashEmbed(text);
  }
}

/**
 * Returns the current embedding mode for health/stats reporting.
 */
export function getEmbeddingMode() {
  return OPENAI_API_KEY ? 'openai-text-embedding-3-small' : 'hash-pseudo';
}
