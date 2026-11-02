import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

function resolve(mode) {
  return spawnSync(process.execPath, ['scripts/resolve-mode.mjs'], {
    env: { ...process.env, REQUESTED_MODE: mode }, encoding: 'utf8',
  });
}

test('with COPY_AUTHORIZED=false, auto resolves to metadata and full is refused', async () => {
  const source = await readFile('packages/config/src/security.js', 'utf8');
  assert.match(source, /COPY_AUTHORIZED = false;/u, 'this test documents the shipped (closed) gate');
  const auto = resolve('auto');
  assert.equal(auto.status, 0);
  assert.match(auto.stdout, /^mode=metadata$/mu);
  assert.match(auto.stdout, /^copy_authorized=false$/mu);
  const full = resolve('full');
  assert.notEqual(full.status, 0);
  assert.match(full.stderr, /COPY_AUTHORIZED is false/u);
  assert.notEqual(resolve('bogus').status, 0);
  assert.match(resolve('cleanup').stdout, /^mode=cleanup$/mu);
});

test('workflows keep secrets out of CI and the keepalive only needs actions:write', async () => {
  const ci = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.doesNotMatch(ci, /secrets\.(?!GITHUB_TOKEN)/u);
  const keepalive = await readFile('.github/workflows/keepalive.yml', 'utf8');
  assert.match(keepalive, /actions: write/u);
  assert.doesNotMatch(keepalive, /secrets\./u);
  const automation = await readFile('.github/workflows/automation.yml', 'utf8');
  assert.doesNotMatch(automation, /npm (ci|install)/u, 'the runner has no third-party dependencies');
});
