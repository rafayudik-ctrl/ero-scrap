/**
 * Login without Cloudflare Zero Trust: one private password kept in the
 * SITE_PASSWORD secret, exchanged for a signed, HttpOnly session cookie.
 * Pure WebCrypto, no dependencies. The signing key is derived from the
 * password, so changing the password signs every browser out.
 */

export const SESSION_COOKIE = 'es_session';
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 256;
const encoder = new TextEncoder();

export const AUTH_MODES = Object.freeze(['password', 'access']);

export function authMode(env) {
  const value = String(env?.AUTH_MODE ?? 'password').trim().toLowerCase();
  return AUTH_MODES.includes(value) ? value : null;
}

export function passwordConfigured(env) {
  const password = env?.SITE_PASSWORD;
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]+$/u.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/gu, '+').replace(/_/gu, '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secretBytes, usages) {
  return crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

async function sessionKey(password) {
  const base = await hmacKey(encoder.encode(password), ['sign']);
  const derived = await crypto.subtle.sign('HMAC', base, encoder.encode('ero-scrap/session/v1'));
  return hmacKey(derived, ['sign', 'verify']);
}

export async function createSessionToken(password, nowMs = Date.now()) {
  const expiresAt = Math.floor(nowMs / 1000) + SESSION_SECONDS;
  const body = `v1.${expiresAt}`;
  const signature = await crypto.subtle.sign('HMAC', await sessionKey(password), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySessionToken(password, token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 200) return false;
  const match = token.match(/^(v1\.(\d{9,12}))\.([A-Za-z0-9_-]+)$/u);
  if (!match) return false;
  const expiresAt = Number(match[2]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt * 1000 <= nowMs) return false;
  const signature = fromBase64Url(match[3]);
  if (!signature) return false;
  // subtle.verify compares in constant time.
  return crypto.subtle.verify('HMAC', await sessionKey(password), signature, encoder.encode(match[1]));
}

/** Constant-time password check: both sides are hashed to the same length first. */
export async function passwordMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length > MAX_PASSWORD_LENGTH) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export async function authenticatePassword(request, env) {
  if (!passwordConfigured(env)) return { ok: false, status: 503, code: 'authentication_not_configured' };
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return { ok: false, status: 401, code: 'authentication_required' };
  if (!(await verifySessionToken(env.SITE_PASSWORD, token))) {
    return { ok: false, status: 401, code: 'authentication_required' };
  }
  return { ok: true, email: 'owner' };
}
