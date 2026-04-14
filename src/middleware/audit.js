import pool, { isDbAvailable } from '../services/db.js';

/**
 * Audit logging middleware — logs cross-platform calls to public.audit_log.
 */
export function auditLog(fromPlatform, toPlatform) {
  return (req, res, next) => {
    const start = Date.now();

    // Capture the original end to log after response
    const originalEnd = res.end;
    res.end = function (...args) {
      const durationMs = Date.now() - start;

      const endpoint = req.originalUrl || req.url;
      const did = req.agentDid || null;
      const statusCode = res.statusCode;
      const success = statusCode < 400;

      if (isDbAvailable()) {
        pool.query(`
          INSERT INTO public.audit_log (from_platform, to_platform, endpoint, did, method, status_code, success, duration_ms)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          fromPlatform,
          toPlatform,
          endpoint,
          did,
          req.method,
          statusCode,
          success,
          durationMs,
        ]).catch(() => {
          // DB unavailable — fall through to console fallback below
          if (!success || durationMs > 5000) {
            console.warn(`[audit] DB write failed | ${req.method} ${endpoint} ${statusCode} ${durationMs}ms did=${did || 'anon'}`);
          }
        });
      }

      // Console fallback for errors and slow requests when DB is unavailable
      if (!isDbAvailable() && (!success || durationMs > 5000)) {
        console.warn(`[audit] ${req.method} ${endpoint} ${statusCode} ${durationMs}ms did=${did || 'anon'} success=${success}`);
      }

      originalEnd.apply(res, args);
    };

    next();
  };
}

/**
 * Per-DID rate limiting middleware.
 * Allows `maxRequests` per `windowMinutes` window per DID.
 */
export function rateLimit({ maxRequests = 100, windowMinutes = 15 } = {}) {
  // In-memory fallback counters
  const memCounters = new Map();

  return async (req, res, next) => {
    const did = req.agentDid;
    if (!did) return next(); // No DID = no rate limit (auth middleware handles this)

    // Dev mode: relaxed limits — gated behind ALLOW_TEST_DIDS env var
    if (process.env.ALLOW_TEST_DIDS === 'true' && did.startsWith('did:hive:test_agent_')) {
      return next();
    }

    const windowMs = windowMinutes * 60 * 1000;
    const now = new Date();
    const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);

    if (isDbAvailable()) {
      try {
        const { rows } = await pool.query(`
          INSERT INTO public.rate_limits (did, window_start, request_count)
          VALUES ($1, $2, 1)
          ON CONFLICT (did, window_start)
          DO UPDATE SET request_count = public.rate_limits.request_count + 1
          RETURNING request_count
        `, [did, windowStart.toISOString()]);

        const count = rows[0].request_count;
        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - count));
        res.setHeader('X-RateLimit-Reset', new Date(windowStart.getTime() + windowMs).toISOString());

        if (count > maxRequests) {
          return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded',
            retry_after_seconds: Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000),
          });
        }
        return next();
      } catch (err) {
        // Fall through to in-memory
      }
    }

    // In-memory fallback
    const key = `${did}:${windowStart.getTime()}`;
    const count = (memCounters.get(key) || 0) + 1;
    memCounters.set(key, count);

    // Cleanup old windows
    for (const [k, ] of memCounters) {
      const ts = parseInt(k.split(':').pop(), 10);
      if (ts < windowStart.getTime() - windowMs) memCounters.delete(k);
    }

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - count));

    if (count > maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        retry_after_seconds: Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000),
      });
    }

    next();
  };
}
