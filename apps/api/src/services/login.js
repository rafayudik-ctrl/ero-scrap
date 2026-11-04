import { errorResponse, jsonResponse } from '../lib/http.js';
import {
  authMode, clearedSessionCookie, createSessionToken, passwordConfigured, passwordMatches, sessionCookie,
} from '../lib/password-auth.js';

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES_PER_IP = 5;
const MAX_FAILURES_GLOBAL = 30;
const MAX_BODY_BYTES = 1024;

function trustedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  return typeof env.WEB_ORIGIN === 'string' && origin === env.WEB_ORIGIN;
}

async function readPassword(request) {
  const announced = Number(request.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) return null;
  if (!/^application\/json(?:\s*;|$)/iu.test(request.headers.get('content-type') ?? '')) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value = JSON.parse(text)?.password;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

export async function handleLogin(request, env) {
  if (authMode(env) !== 'password') return errorResponse('not_found', 'Route not found.', 404);
  if (request.method !== 'POST') return errorResponse('method_not_allowed', 'Login requires POST.', 405, { Allow: 'POST' });
  if (!trustedOrigin(request, env)) return errorResponse('origin_forbidden', 'Login must come from the configured application.', 403);
  if (!passwordConfigured(env)) return errorResponse('authentication_not_configured', 'Password login is not configured.', 503);
  if (!env.DB || typeof env.DB.prepare !== 'function' || typeof env.DB.batch !== 'function') {
    return errorResponse('database_unavailable', 'Database binding is not configured.', 503);
  }

  const password = await readPassword(request);
  if (password === null) return errorResponse('invalid_body', 'A JSON body with a password is required.', 400);

  const ip = `ip:${(request.headers.get('cf-connecting-ip') ?? 'unknown').slice(0, 64)}`;
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const windowStart = new Date(nowMs - WINDOW_MS).toISOString();

  try {
    const { results = [] } = await env.DB.prepare(
      'SELECT bucket, failures FROM auth_attempts WHERE bucket IN (?, ?) AND window_start > ?',
    ).bind(ip, 'all', windowStart).all();
    const failures = Object.fromEntries(results.map((row) => [row.bucket, Number(row.failures)]));
    if ((failures[ip] ?? 0) >= MAX_FAILURES_PER_IP || (failures.all ?? 0) >= MAX_FAILURES_GLOBAL) {
      return errorResponse('too_many_attempts', 'Too many failed attempts. Try again in a few minutes.', 429, {
        'Retry-After': String(WINDOW_MS / 1000),
      });
    }

    if (!(await passwordMatches(password, env.SITE_PASSWORD))) {
      const bump = `INSERT INTO auth_attempts (bucket, failures, window_start) VALUES (?, 1, ?)
        ON CONFLICT(bucket) DO UPDATE SET
          failures = CASE WHEN window_start > ? THEN failures + 1 ELSE 1 END,
          window_start = CASE WHEN window_start > ? THEN window_start ELSE ? END`;
      await env.DB.batch([ip, 'all'].map((bucket) => env.DB.prepare(bump).bind(bucket, now, windowStart, windowStart, now)));
      return errorResponse('invalid_credentials', 'Incorrect password.', 401);
    }

    // A correct password clears this client's counter (a write only if one exists).
    if (failures[ip]) await env.DB.prepare('DELETE FROM auth_attempts WHERE bucket = ?').bind(ip).run();
  } catch {
    return errorResponse('login_unavailable', 'Login is temporarily unavailable.', 503);
  }

  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': sessionCookie(await createSessionToken(env.SITE_PASSWORD, nowMs)) });
}

export async function handleLogout(request, env) {
  if (authMode(env) !== 'password') return errorResponse('not_found', 'Route not found.', 404);
  if (request.method !== 'POST') return errorResponse('method_not_allowed', 'Logout requires POST.', 405, { Allow: 'POST' });
  if (!trustedOrigin(request, env)) return errorResponse('origin_forbidden', 'Logout must come from the configured application.', 403);
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
}
