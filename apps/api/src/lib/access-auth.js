import { createRemoteJWKSet, jwtVerify } from 'jose';

const MAX_TOKEN_LENGTH = 8_192;
const jwksByTeamDomain = new Map();

function normalizeTeamDomain(value) {
  if (typeof value !== 'string' || value.length > 200) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function getJwks(teamDomain) {
  let jwks = jwksByTeamDomain.get(teamDomain);
  if (!jwks) {
    const certsUrl = new URL('/cdn-cgi/access/certs', teamDomain);
    jwks = createRemoteJWKSet(certsUrl, {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
    });
    jwksByTeamDomain.set(teamDomain, jwks);
  }
  return jwks;
}

function allowedEmailSet(value) {
  return new Set(
    (typeof value === 'string' ? value : '')
      .split(',')
      .map((email) => email.trim().toLocaleLowerCase('en-US'))
      .filter(Boolean),
  );
}

/**
 * Cloudflare Access is the production identity provider. In development only,
 * an explicit local bypass can be enabled in an untracked .dev.vars file.
 */
export async function authenticateRequest(request, env) {
  if (env.APP_ENV === 'development' && env.DEV_AUTH_BYPASS === 'true') {
    return { ok: true, email: 'local-development' };
  }

  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, status: 401, code: 'authentication_required' };
  }

  const teamDomain = normalizeTeamDomain(env.TEAM_DOMAIN);
  const audience = typeof env.POLICY_AUD === 'string' ? env.POLICY_AUD.trim() : '';
  const allowedEmails = allowedEmailSet(env.ALLOWED_EMAILS);

  // Fail closed if production Access configuration is incomplete.
  if (!teamDomain || !audience || allowedEmails.size === 0) {
    return { ok: false, status: 503, code: 'authentication_not_configured' };
  }

  try {
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      algorithms: ['RS256'],
      issuer: teamDomain,
      audience,
      requiredClaims: ['exp'],
      clockTolerance: 5,
    });

    const email = typeof payload.email === 'string'
      ? payload.email.toLocaleLowerCase('en-US')
      : '';

    if (!email || !allowedEmails.has(email)) {
      return { ok: false, status: 403, code: 'identity_not_allowed' };
    }

    return { ok: true, email };
  } catch {
    // Do not return token-validation details to a caller.
    return { ok: false, status: 401, code: 'invalid_access_token' };
  }
}
