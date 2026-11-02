import test from 'node:test';
import assert from 'node:assert/strict';
import { startScheduler } from '../../../apps/runner/src/scheduler.js';

const MIN_INTERVAL = 60_000;

test('scheduler runs immediately and schedules the next scan only after completion', async () => {
  let now = 0;
  let timerCallback = null;
  let timerDelay = null;
  let cleared = false;
  let resolveFirst;
  let resolveSecond;
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const controller = new AbortController();

  const schedulerReady = startScheduler({
    intervalMs: MIN_INTERVAL,
    signal: controller.signal,
    clock: () => now,
    setTimer(callback, delay) {
      timerCallback = callback;
      timerDelay = delay;
      return 1;
    },
    clearTimer() {
      cleared = true;
      timerCallback = null;
    },
    logger: { error() {} },
    async scanOnce() {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await new Promise((resolve) => {
          if (calls === 1) resolveFirst = resolve;
          else resolveSecond = resolve;
        });
      } finally {
        active -= 1;
      }
    },
  });

  assert.equal(calls, 1, 'the first scan starts immediately');
  assert.equal(timerCallback, null, 'no next timer exists while the scan is active');

  now = 65_000; // The first scan overran the 60-second boundary.
  resolveFirst();
  const stop = await schedulerReady;
  assert.equal(timerDelay, 55_000, 'the missed 60-second tick is skipped');
  assert.equal(typeof timerCallback, 'function');

  const fireSecond = timerCallback;
  timerCallback = null; // A real one-shot timer is consumed when it fires.
  const runSecond = fireSecond();
  assert.equal(calls, 2);
  assert.equal(timerCallback, null, 'the next timer is not scheduled during a scan');
  now = 125_000;
  resolveSecond();
  await runSecond;
  assert.equal(maxActive, 1, 'scheduled scans never overlap');

  stop();
  assert.equal(cleared, true, 'stop clears the pending timer');
  assert.equal(timerCallback, null);
});

test('scheduler rejects intervals below one minute', async () => {
  await assert.rejects(
    startScheduler({ scanOnce() {}, intervalMs: MIN_INTERVAL - 1 }),
    /at least one minute/u,
  );
});

test('scheduler reports failures and continues scheduling', async () => {
  let timerCallback = null;
  const errors = [];
  const controller = new AbortController();
  let calls = 0;

  const stop = await startScheduler({
    scanOnce: async () => {
      calls += 1;
      throw new Error('simulated scan failure');
    },
    intervalMs: MIN_INTERVAL,
    signal: controller.signal,
    setTimer(callback) {
      timerCallback = callback;
      return 1;
    },
    clearTimer() { timerCallback = null; },
    logger: { error: (...args) => errors.push(args) },
  });

  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.equal(typeof timerCallback, 'function');
  stop();
});
