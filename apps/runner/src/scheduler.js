import { performance } from 'node:perf_hooks';

/**
 * Fixed-cadence scheduler with a non-overlap guarantee. Runs immediately,
 * then aligns subsequent scan starts to the configured interval. If a scan
 * overruns one or more intervals, missed ticks are skipped instead of queued.
 * Timer and clock dependencies are injectable so scheduling can be tested
 * deterministically without waiting for real ten-minute intervals.
 */
export async function startScheduler({
  scanOnce,
  intervalMs = 600_000,
  logger = console,
  signal,
  clock = () => performance.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  if (typeof scanOnce !== 'function') throw new TypeError('scanOnce must be a function.');
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) {
    throw new RangeError('The scan interval must be at least one minute.');
  }
  if (typeof clock !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function') {
    throw new TypeError('A clock and timer implementation are required.');
  }

  let stopped = Boolean(signal?.aborted);
  let timer = null;
  let nextStartAt = clock();

  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  signal?.addEventListener('abort', stop, { once: true });

  const scheduleNext = () => {
    if (stopped) return;
    const now = clock();
    do {
      nextStartAt += intervalMs;
    } while (nextStartAt <= now);

    timer = setTimer(() => {
      timer = null;
      return runOnce();
    }, Math.max(0, nextStartAt - clock()));
  };

  const runOnce = async () => {
    if (stopped) return;
    try {
      await scanOnce();
    } catch (error) {
      logger.error?.('[ero-scrap] scheduled scan failed:', error?.message ?? 'unknown error');
    }
    scheduleNext();
  };

  await runOnce();
  return stop;
}
