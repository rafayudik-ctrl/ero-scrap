import { APP_CONFIG } from '../../../../packages/config/src/app.js';

/**
 * Daily housekeeping. Asks the Worker to prune stale metadata in small
 * batches and stops as soon as a batch comes back partially filled.
 */
export class MaintenanceService {
  #repository;
  #logger;
  #now;
  #maxBatches;
  #batchSize;
  #unopenedDays;

  constructor({
    repository,
    logger = console,
    now = () => new Date(),
    maxBatches = APP_CONFIG.maintenance.maxBatchesPerRun,
    batchSize = APP_CONFIG.maintenance.batchSize,
    unopenedDays = APP_CONFIG.retention.unopenedDays,
  }) {
    this.#unopenedDays = unopenedDays;
    if (!repository || typeof repository.pruneStale !== 'function') {
      throw new TypeError('A maintenance repository is required.');
    }
    this.#repository = repository;
    this.#logger = logger;
    this.#now = now;
    this.#maxBatches = maxBatches;
    this.#batchSize = batchSize;
  }

  /** True during the single UTC hour reserved for daily housekeeping. */
  isDue(date = this.#now()) {
    return date.getUTCHours() === APP_CONFIG.maintenance.utcHour;
  }

  async runIfDue() {
    if (!this.isDue()) return null;
    return this.runOnce();
  }

  async runOnce() {
    const totals = { videos: 0, posts: 0, scans: 0, jobs: 0, batches: 0 };
    for (let batch = 0; batch < this.#maxBatches; batch += 1) {
      const result = await this.#repository.pruneStale({ now: this.#now().toISOString(), continuation: batch > 0, unopenedDays: this.#unopenedDays });
      totals.batches += 1;
      let full = false;
      for (const key of ['videos', 'posts', 'scans', 'jobs']) {
        const count = Number(result?.[key] ?? 0);
        totals[key] += count;
        if (count >= this.#batchSize) full = true;
      }
      if (!full) break;
    }
    this.#logger.info?.('[ero-scrap] maintenance pass completed', totals);
    return totals;
  }
}
