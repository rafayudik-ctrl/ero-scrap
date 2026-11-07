import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRunnerConfig, loadMegaConfig } from '../../../apps/runner/src/config/env.js';

const validEnv = {
  APP_ENV: 'production',
  COLLECTOR_API_URL: 'https://api.example.test/internal/collector',
  COLLECTOR_API_TOKEN: 'a'.repeat(64),
  CF_ACCESS_CLIENT_ID: 'access-id',
  CF_ACCESS_CLIENT_SECRET: 'access-secret',
};

test('runner config uses the fixed keyword file and does not accept an env override', () => {
  const config = loadRunnerConfig({ ...validEnv, SEARCH_KEYWORD_FILE: '/tmp/other-keyword.txt' });
  assert.match(config.keywordFilePath, /config[\\/]search-keyword\.txt$/u);
  assert.equal(config.scanIntervalMs, 900_000);
  assert.equal(config.maxPostInspectionsPerRun, 160);
  assert.equal(config.collectorApiUrl, validEnv.COLLECTOR_API_URL);
  assert.equal(config.accessClientId, 'access-id');
});

test('runner config allows plain HTTP only for localhost in development', () => {
  const config = loadRunnerConfig({
    ...validEnv,
    APP_ENV: 'development',
    COLLECTOR_API_URL: 'http://127.0.0.1:8787/internal/collector',
  });
  assert.equal(config.collectorApiUrl, 'http://127.0.0.1:8787/internal/collector');
  assert.throws(() => loadRunnerConfig({
    ...validEnv,
    COLLECTOR_API_URL: 'http://api.example.test/internal/collector',
  }), /HTTPS/);
});

test('runner config rejects missing and malformed collector credentials', () => {
  assert.throws(() => loadRunnerConfig({}), /COLLECTOR_API_URL/);
  assert.throws(() => loadRunnerConfig({ ...validEnv, COLLECTOR_API_TOKEN: 'short' }), /32 characters/);
  assert.throws(() => loadRunnerConfig({ ...validEnv, CF_ACCESS_CLIENT_SECRET: '' }), /configured together/);
  const local = loadRunnerConfig({ ...validEnv, APP_ENV: 'development', CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' });
  assert.equal(local.accessClientId, null);
  const passwordMode = loadRunnerConfig({ ...validEnv, CF_ACCESS_CLIENT_ID: '', CF_ACCESS_CLIENT_SECRET: '' });
  assert.equal(passwordMode.accessClientId, null, 'production works without an Access service token (password mode)');
  assert.throws(() => loadRunnerConfig({ ...validEnv, COLLECTOR_API_URL: 'https://api.example.test/anything' }), /end exactly/);
});


test('MEGA check configuration is independent from Cloudflare API credentials', () => {
  const config = loadMegaConfig({ MEGA_REMOTE_ROOT: '/Private/Ero-Scrap', MEGA_COMMAND_TIMEOUT_MS: '45000' });
  assert.equal(config.megaRemoteRoot, '/Private/Ero-Scrap');
  assert.equal(config.megaCommandTimeoutMs, 45_000);
  assert.equal(config.ffmpegBinary, 'ffmpeg');
  assert.equal(config.ffprobeBinary, 'ffprobe');
  assert.equal(loadMegaConfig({ FFPROBE_BINARY: 'ffprobe-custom' }).ffprobeBinary, 'ffprobe-custom');
});

test('folder sweep budget defaults to 10, accepts 0 to disable and caps at 200', async () => {
  const { resolveFolderSweepChecks } = await import('../../../apps/runner/src/config/env.js');
  assert.equal(resolveFolderSweepChecks(undefined), 10);
  assert.equal(resolveFolderSweepChecks(''), 10);
  assert.equal(resolveFolderSweepChecks('abc'), 10);
  assert.equal(resolveFolderSweepChecks('0'), 0);
  assert.equal(resolveFolderSweepChecks('50'), 50);
  assert.equal(resolveFolderSweepChecks('999'), 200);
  assert.equal(loadRunnerConfig(validEnv).folderSweepChecks, 10);
});

test('listing depth defaults to 4 pages, accepts 1-6 and rejects anything else', async () => {
  const { resolveListingPages } = await import('../../../packages/config/src/scan-pages.js');
  assert.equal(resolveListingPages(undefined), 4);
  assert.equal(resolveListingPages(''), 4);
  assert.equal(resolveListingPages('1'), 1);
  assert.equal(resolveListingPages(' 6 '), 6);
  for (const bad of ['0', '7', '2.5', 'abc', '-1']) assert.throws(() => resolveListingPages(bad), RangeError);
  assert.equal(loadRunnerConfig(validEnv).listingPages, 4);
  assert.equal(loadRunnerConfig({ ...validEnv, SCAN_LISTING_PAGES: '3' }).listingPages, 3);
});
