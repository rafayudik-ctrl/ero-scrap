import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

function makeRequest(path, options = {}) {
  return new Request(`https://api.example.test${path}`, options);
}

test('health endpoint is public and exposes no configuration secrets', async () => {
  const response = await worker.fetch(makeRequest('/health'), {});
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 'ok');
  assert.equal(payload.service, 'ero-scrap-api');
  assert.equal('env' in payload, false);
});

test('API routes fail closed without an Access identity', async () => {
  const response = await worker.fetch(makeRequest('/api/status'), {
    APP_ENV: 'production',
    TEAM_DOMAIN: 'https://example.cloudflareaccess.com',
    POLICY_AUD: 'expected-audience',
    ALLOWED_EMAILS: 'owner@example.test',
  });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error.code, 'authentication_required');
});

test('local auth bypass is honored only in explicit development mode', async () => {
  const request = makeRequest('/api/status');
  const devResponse = await worker.fetch(request, {
    APP_ENV: 'development',
    DEV_AUTH_BYPASS: 'true',
  });
  assert.equal(devResponse.status, 503); // Authentication passed; D1 is intentionally absent.

  const productionResponse = await worker.fetch(makeRequest('/api/status'), {
    APP_ENV: 'production',
    DEV_AUTH_BYPASS: 'true',
  });
  assert.equal(productionResponse.status, 401);
});

test('only GET and OPTIONS methods are accepted by the public API', async () => {
  const response = await worker.fetch(makeRequest('/api/status', { method: 'POST' }), {
    APP_ENV: 'development',
    DEV_AUTH_BYPASS: 'true',
  });
  assert.equal(response.status, 405);
});

test('unrecognized routes return a structured 404', async () => {
  const response = await worker.fetch(makeRequest('/not-a-route'), {});
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.error.code, 'not_found');
});


test('status endpoint reports the copy gate as disabled', async () => {
  const db = {
    prepare() {
      const statement = { bind() { return statement; }, async first() { return null; } };
      return statement;
    },
  };
  const response = await worker.fetch(makeRequest('/api/status'), {
    APP_ENV: 'development',
    DEV_AUTH_BYPASS: 'true',
    DB: db,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.copyAuthorized, false);
  assert.equal(payload.mode, 'catalog-and-retention');
  assert.equal(payload.monitor.listingPagesPerScan, 2);
  // Counters are folded into the status response: one request instead of two.
  assert.deepEqual(payload.stats, { stored: 0, clicked: 0, unopened: 0, deletionPending: 0 });
});

test('invalid catalog page size is rejected before a database query', async () => {
  const response = await worker.fetch(makeRequest('/api/catalog?limit=49'), {
    APP_ENV: 'development',
    DEV_AUTH_BYPASS: 'true',
    DB: { prepare() { throw new Error('Database must not be queried.'); } },
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, 'invalid_limit');
});

test('cross-origin requests from an unconfigured origin are blocked', async () => {
  const response = await worker.fetch(makeRequest('/api/status', {
    headers: { Origin: 'https://attacker.example' },
  }), {
    APP_ENV: 'development',
    DEV_AUTH_BYPASS: 'true',
    WEB_ORIGIN: 'https://app.example.test',
  });
  assert.equal(response.status, 403);
});

test('catalog open records the click and redirects without exposing the MEGA URL in JSON', async () => {
  const assetId = 'a'.repeat(32);
  const shareUrl = 'https://mega.nz/file/AbCdEf#secretKey';
  const updates = [];
  let selectCount = 0;
  const db = {
    prepare(sql) {
      let params = [];
      return {
        bind(...values) { params = values; return this; },
        async first() {
          if (sql.includes('SELECT share_url') && selectCount === 0) {
            selectCount += 1;
            return { share_url: shareUrl };
          }
          selectCount += 1;
          return { share_url: shareUrl, status: 'clicked', expires_at: '2026-11-02T00:00:00.000Z' };
        },
        async run() { updates.push({ sql, params }); return { meta: { changes: 1 } }; },
      };
    },
  };
  const response = await worker.fetch(makeRequest(`/api/catalog/${assetId}/open`, {
    method: 'POST',
    headers: { Origin: 'https://app.example.test' },
  }), {
    APP_ENV: 'development',
    DEV_AUTH_BYPASS: 'true',
    WEB_ORIGIN: 'https://app.example.test',
    DB: db,
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), shareUrl);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
  assert.equal(updates.length, 1);
  assert.match(updates[0].sql, /COALESCE\(first_clicked_at, \?\)/u);
  assert.match(updates[0].sql, /CASE WHEN first_clicked_at IS NULL/u);
});

test('catalog open rejects requests from an untrusted Origin before touching D1', async () => {
  let databaseTouched = false;
  const response = await worker.fetch(makeRequest(`/api/catalog/${'a'.repeat(32)}/open`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example' },
  }), {
    APP_ENV: 'development',
    DEV_AUTH_BYPASS: 'true',
    WEB_ORIGIN: 'https://app.example.test',
    DB: { prepare() { databaseTouched = true; throw new Error('must not be called'); } },
  });
  assert.equal(response.status, 403);
  assert.equal(databaseTouched, false);
});
