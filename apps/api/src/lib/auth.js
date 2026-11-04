import { authMode, authenticatePassword } from './password-auth.js';

/**
 * One entry point for "who is calling the public API". AUTH_MODE (a variable
 * in wrangler.jsonc) picks the method:
 *   "password" (default) - SITE_PASSWORD + signed cookie. No extra service.
 *   "access"             - Cloudflare Zero Trust Access (needs its own setup).
 * An unknown value fails closed.
 */
export async function authenticateRequest(request, env) {
  if (env.APP_ENV === 'development' && env.DEV_AUTH_BYPASS === 'true') {
    return { ok: true, email: 'local-development' };
  }
  switch (authMode(env)) {
    case 'password':
      return authenticatePassword(request, env);
    case 'access': {
      // Loaded only in this mode, so password mode never pays for the JWT library.
      const { authenticateAccess } = await import('./access-auth.js');
      return authenticateAccess(request, env);
    }
    default:
      return { ok: false, status: 503, code: 'authentication_not_configured' };
  }
}
