import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker, { buildDispatchRequest, dispatchWorkflow, SchedulerConfigError } from '../../workers/scheduler/src/index.js';

const TOKEN = 'github_pat_' + 'x'.repeat(40);
const ENV = { GITHUB_REPO: 'maria/ero-scrap', GITHUB_TOKEN: TOKEN };
const quiet = { info() {}, error() {} };

test('dispatch request targets only the configured workflow, with mode auto by default', () => {
  const { url, init } = buildDispatchRequest(ENV);
  assert.equal(url, 'https://api.github.com/repos/maria/ero-scrap/actions/workflows/automation.yml/dispatches');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { ref: 'main', inputs: { mode: 'auto' } });
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
});

test('invalid or placeholder configuration is rejected before any request', () => {
  for (const bad of [
    { ...ENV, GITHUB_REPO: 'OWNER/REPO' }, { ...ENV, GITHUB_REPO: 'a/b/../c' }, { ...ENV, GITHUB_REPO: '' },
    { ...ENV, GITHUB_REF: 'main..x' }, { ...ENV, WORKFLOW_FILE: '../x.yml' }, { ...ENV, MODE: 'mega-check' },
    { ...ENV, GITHUB_TOKEN: '' }, { GITHUB_REPO: ENV.GITHUB_REPO },
  ]) assert.throws(() => buildDispatchRequest(bad), SchedulerConfigError);
});

test('204 succeeds on the first attempt without waiting', async () => {
  let calls = 0;
  const result = await dispatchWorkflow(ENV, { fetchImpl: async () => { calls += 1; return new Response(null, { status: 204 }); }, wait: async () => assert.fail('no wait'), logger: quiet });
  assert.deepEqual(result, { dispatched: true, attempt: 1 });
  assert.equal(calls, 1);
});

test('a 5xx or network error is retried once; a 4xx is not', async () => {
  const seq = [new Response('busy', { status: 503 }), new Response(null, { status: 204 })];
  let waits = 0;
  assert.deepEqual(await dispatchWorkflow(ENV, { fetchImpl: async () => seq.shift(), wait: async () => { waits += 1; }, logger: quiet }), { dispatched: true, attempt: 2 });
  assert.equal(waits, 1);

  let net = 0;
  await assert.rejects(dispatchWorkflow(ENV, { fetchImpl: async () => { net += 1; throw new TypeError('offline'); }, wait: async () => {}, logger: quiet }), /status 0/u);
  assert.equal(net, 2);

  let denied = 0;
  await assert.rejects(dispatchWorkflow(ENV, { fetchImpl: async () => { denied += 1; return new Response('{"message":"Bad credentials"}', { status: 401 }); }, wait: async () => {}, logger: quiet }), /status 401/u);
  assert.equal(denied, 1);
});

test('the token never reaches the logs', async () => {
  const lines = [];
  const logger = { info: (...v) => lines.push(JSON.stringify(v)), error: (...v) => lines.push(JSON.stringify(v)) };
  await assert.rejects(dispatchWorkflow(ENV, { fetchImpl: async () => new Response('nope', { status: 403 }), wait: async () => {}, logger }));
  await dispatchWorkflow(ENV, { fetchImpl: async () => new Response(null, { status: 204 }), logger });
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((line) => !line.includes(TOKEN)));
});

test('the Worker exposes no public surface and the cron is exact and every 15 minutes', async () => {
  assert.equal((await worker.fetch()).status, 404);
  const config = await readFile('workers/scheduler/wrangler.jsonc', 'utf8');
  assert.match(config, /"crons": \["3,18,33,48 \* \* \* \*"\]/u);
  assert.match(config, /"workers_dev": false/u);
  assert.doesNotMatch(config, /github_pat_|ghp_/u);
});

test('GitHub schedule is skipped in both jobs only when EXTERNAL_SCHEDULER is true', async () => {
  const wf = await readFile('.github/workflows/automation.yml', 'utf8');
  const matches = wf.match(/github\.event_name != 'schedule' \|\| vars\.EXTERNAL_SCHEDULER != 'true'/gu) ?? [];
  assert.equal(matches.length, 2);
  assert.match(wf, /cron: '7,22,37,52 \* \* \* \*'/u, 'GitHub schedule remains as an option');
});
