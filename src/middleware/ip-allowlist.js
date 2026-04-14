/**
 * IP Allowlist Middleware — restricts access to internal/admin endpoints.
 *
 * Reads ALLOWED_INTERNAL_IPS from env (comma-separated).
 * If not set, passes through (backward compatible).
 */
export function requireAllowedIP() {
  const allowedIPs = process.env.ALLOWED_INTERNAL_IPS
    ? process.env.ALLOWED_INTERNAL_IPS.split(',').map(ip => ip.trim()).filter(Boolean)
    : null;

  return (req, res, next) => {
    // If no allowlist configured, pass through (backward compatible)
    if (!allowedIPs) {
      return next();
    }

    const clientIP = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress;

    if (allowedIPs.includes(clientIP)) {
      return next();
    }

    console.warn(`[ip-allowlist] Blocked request from ${clientIP} to ${req.originalUrl || req.url}`);
    return res.status(403).json({
      success: false,
      error: 'Forbidden — IP not allowed.',
    });
  };
}
