// Safe, readable error details for logs. The repository is public, so Actions
// logs are public too: everything here is stripped of URLs and long opaque
// strings (tokens, keys, base64) and cut to a short length before printing.

const MAX_DETAIL = 400;

export function sanitizeDiagnostic(value, max = MAX_DETAIL) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/<[^>]*>/gu, ' ')
    .replace(/https?:\/\/\S+/giu, '[url]')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/gu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, max);
}

/** Name, code and sanitized message of an error and of its causes (max 3 levels). */
export function describeError(error) {
  const chain = [];
  let current = error;
  for (let depth = 0; current && depth < 3; depth += 1) {
    chain.push({
      name: typeof current.name === 'string' ? current.name : 'Error',
      ...(current.code !== undefined ? { code: sanitizeDiagnostic(current.code, 60) } : {}),
      ...(current.status !== undefined && current.status !== null ? { status: current.status } : {}),
      message: sanitizeDiagnostic(current.message ?? current),
    });
    current = current.cause;
  }
  return chain;
}

/** Likely explanation for well-known free-plan limits, to speed up diagnosis. */
export function hintFor(text) {
  const value = String(text ?? '').toLowerCase();
  if (/exceeded|limit|quota|too many|overload|rate/u.test(value) && /d1|row|write|read|storage|daily|queue/u.test(value)) {
    return 'D1 free-plan limit or overload (daily limits reset at 00:00 UTC). Check Cloudflare > D1 > Metrics.';
  }
  if (/no such (table|column)/u.test(value)) return 'Database migrations are missing: run the D1 migrations (docs 6.2).';
  if (/database binding|database_unavailable/u.test(value)) return 'The D1 binding "DB" is not connected to the Pages project.';
  return null;
}
