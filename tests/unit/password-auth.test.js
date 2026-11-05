import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../apps/api/src/index.js';
import { COPY_AUTHORIZED } from '../../packages/config/src/security.js';
import { createSqliteD1 } from '../helpers/sqlite-d1.js';
import {
  authMode, createSessionToken, passwordConfigured, passwordMatches, verifySessionToken, SESSION_SECONDS,
} from '../../apps/api/src/lib/password-auth.js';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = 'https://ero-scrap.example.test';
const baseEnv = (db) => ({ APP_ENV: 'production', WEB_ORIGIN: ORIGIN, SITE_PASSWORD: PASSWORD, DB: db });

function loginRequest(password, { origin = ORIGIN, ip = '203.0.113.7' } = {}) {
  return new Request(`${ORIGIN}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), 'cf-connecting-ip': ip },
    body: JSON.stringify({ password }),
  });
}

test('AUTH_MODE defaults to password and refuses unknown values', () => {
  assert.equal(authMode({}), 'password');
  assert.equal(authMode({ AUTH_MODE: ' Access ' }), 'access');
  assert.equal(authMode({ AUTH_MODE: 'none' }), null);
  assert.equal(passwordConfigured({ SITE_PASSWORD: 'short' }), false);
  assert.equal(passwordConfigured({ SITE_PASSWORD: PASSWORD }), true);
});

test('session tokens verify, expire, and reject tampering or another password', async () => {
  const now = Date.UTC(2026, 10, 3);
  const token = await createSessionToken(PASSWORD, now);
  assert.equal(await verifySessionToken(PASSWORD, token, now + 1000), true);
  assert.equal(await verifySessionToken(PASSWORD, token, now + (SESSION_SECONDS + 1) * 1000), false, 'expired');
  assert.equal(await verifySessionToken('another password!!', token, now + 1000), false, 'password changed');
  const [v, exp, sig] = token.split('.');
  assert.equal(await verifySessionToken(PASSWORD, `${v}.${Number(exp) + 99999}.${sig}`, now + 1000), false, 'tampered expiry');
  assert.equal(await verifySessionToken(PASSWORD, `${v}.${exp}.${sig.slice(0, -2)}AA`, now + 1000), false, 'tampered signature');
  assert.equal(await verifySessionToken(PASSWORD, 'garbage', now), false);
  assert.equal(await passwordMatches(PASSWORD, PASSWORD), true);
  assert.equal(await passwordMatches('wrong', PASSWORD), false);
});

test('login sets a hardened cookie that unlocks the API, and logout clears it', async () => {
  const db = createSqliteD1();
  try {
    const env = baseEnv(db);
    const locked = await worker.fetch(new Request(`${ORIGIN}/api/status`), env);
    assert.equal(locked.status, 401);
    assert.equal((await locked.json()).error.code, 'authentication_required');

    const login = await worker.fetch(loginRequest(PASSWORD), env);
    assert.equal(login.status, 200);
    const setCookie = login.headers.get('set-cookie');
    assert.match(setCookie, /^es_session=v1\.\d+\.[\w-]+;/u);
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(setCookie.includes(flag), flag);
    assert.equal(setCookie.includes(PASSWORD), false);

    const cookie = setCookie.split(';')[0];
    const status = await worker.fetch(new Request(`${ORIGIN}/api/status`, { headers: { cookie } }), env);
    assert.equal(status.status, 200);
    const payload = await status.json();
    assert.equal(payload.authMode, 'password');
    assert.equal(payload.copyAuthorized, COPY_AUTHORIZED);

    const out = await worker.fetch(new Request(`${ORIGIN}/api/logout`, { method: 'POST', headers: { Origin: ORIGIN } }), env);
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/u);
  } finally { db.sqlite.close(); }
});

test('login rejects a wrong password, a foreign origin and a missing configuration', async () => {
  const db = createSqliteD1();
  try {
    const env = baseEnv(db);
    assert.equal((await worker.fetch(loginRequest('nope nope nope nope'), env)).status, 401);
    assert.equal((await worker.fetch(loginRequest(PASSWORD, { origin: 'https://evil.example' }), env)).status, 403);
    assert.equal((await worker.fetch(loginRequest(PASSWORD, { origin: null }), env)).status, 403);
    assert.equal((await worker.fetch(loginRequest(PASSWORD), { ...env, SITE_PASSWORD: 'short' })).status, 503);
    assert.equal((await worker.fetch(new Request(`${ORIGIN}/api/login`), env)).status, 405);
    assert.equal((await worker.fetch(loginRequest(PASSWORD), { ...env, AUTH_MODE: 'access' })).status, 404, 'no login route in access mode');
  } finally { db.sqlite.close(); }
});

test('five wrong passwords lock that client out for the window, even with the right password', async () => {
  const db = createSqliteD1();
  try {
    const env = baseEnv(db);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await worker.fetch(loginRequest(`wrong password ${attempt}`), env)).status, 401);
    }
    const blocked = await worker.fetch(loginRequest(PASSWORD), env);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '900');
    // Another client is unaffected.
    assert.equal((await worker.fetch(loginRequest(PASSWORD, { ip: '198.51.100.9' }), env)).status, 200);
    // The counter is one tiny row per bucket.
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM auth_attempts').get().n, 2);
  } finally { db.sqlite.close(); }
});

test('a correct login clears earlier failures and old throttle rows are pruned', async () => {
  const db = createSqliteD1();
  try {
    const env = baseEnv(db);
    await worker.fetch(loginRequest('bad bad bad bad bad'), env);
    assert.equal((await worker.fetch(loginRequest(PASSWORD), env)).status, 200);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE bucket LIKE 'ip:%'").get().n, 0);

    db.sqlite.prepare("INSERT INTO auth_attempts VALUES ('ip:old', 3, '2026-01-01T00:00:00.000Z')").run();
    const { executeCollectorCommand } = await import('../../apps/api/src/services/collector-service.js');
    await executeCollectorCommand(db, 'maintenance.prune', { now: '2026-11-03T00:00:00.000Z' });
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM auth_attempts WHERE bucket = 'ip:old'").get().n, 0);
  } finally { db.sqlite.close(); }
});

test('the open-item route also requires the session cookie in password mode', async () => {
  const db = createSqliteD1();
  try {
    const env = baseEnv(db);
    const id = 'a'.repeat(32);
    const request = new Request(`${ORIGIN}/api/catalog/${id}/open`, { method: 'POST', headers: { Origin: ORIGIN } });
    assert.equal((await worker.fetch(request, env)).status, 401);
  } finally { db.sqlite.close(); }
});
