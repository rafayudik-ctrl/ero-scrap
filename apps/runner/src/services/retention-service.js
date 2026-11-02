const SAFE_ERROR_CODE = /^[a-z0-9_-]{1,80}$/u;

/**
 * Retention worker. It claims due records through the private Worker API,
 * deletes the exact MEGA object, and only then asks the API to remove the
 * thumbnail and catalog row. Failed deletes stay queued for bounded retries.
 */
export class RetentionService {
  #repository;
  #storageProviders;
  #logger;
  #now;
  #limit;
  #maxBatches;

  constructor({ repository, storageProviders, logger = console, now = () => new Date(), limit = 10, maxBatches = 1 }) {
    if (!repository || typeof repository.claimDueDeletionJobs !== 'function') {
      throw new TypeError('A retention repository is required.');
    }
    if (!storageProviders || typeof storageProviders !== 'object') {
      throw new TypeError('Storage providers are required.');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Retention batch limit must be between 1 and 50.');
    this.#repository = repository;
    this.#storageProviders = storageProviders;
    this.#logger = logger;
    this.#now = now;
    if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 20) {
      throw new RangeError('Retention maxBatches must be between 1 and 20.');
    }
    this.#limit = limit;
    this.#maxBatches = maxBatches;
  }

  async hasDue() {
    if (typeof this.#repository.hasDueDeletionJobs !== 'function') {
      throw new TypeError('The retention repository does not support due-job checks.');
    }
    return this.#repository.hasDueDeletionJobs({ now: this.#now().toISOString() });
  }

  async runOnce() {
    const results = { claimed: 0, deleted: 0, retried: 0, dead: 0, stale: 0 };
    // Keep going only while the previous batch came back full, up to a small cap.
    // Failed jobs are rescheduled with backoff, so they are not re-claimed here.
    for (let batch = 0; batch < this.#maxBatches; batch += 1) {
      const now = this.#now().toISOString();
      const jobs = await this.#repository.claimDueDeletionJobs({ limit: this.#limit, now });
      results.claimed += jobs.length;
      await this.#processJobs(jobs, results);
      if (jobs.length < this.#limit) break;
    }
    this.#logger.info?.('[ero-scrap] retention pass completed', results);
    return results;
  }

  async #processJobs(jobs, results) {
    for (const job of jobs) {
      try {
        if (typeof job.leaseToken !== 'string' || !/^[a-f0-9]{32}$/u.test(job.leaseToken)) {
          throw Object.assign(new Error('Retention lease token is invalid.'), { code: 'retention_lease_invalid' });
        }
        const provider = this.#storageProviders[job.storageProvider];
        if (!provider || typeof provider.deleteObject !== 'function') {
          throw Object.assign(new Error('Storage provider is unavailable.'), { code: 'storage_provider_unavailable' });
        }
        if (typeof job.storageObjectId !== 'string' || !job.storageObjectId) {
          throw Object.assign(new Error('Stored object identifier is missing.'), { code: 'storage_object_missing' });
        }

        const deletion = await provider.deleteObject({ assetId: job.assetId, objectId: job.storageObjectId });
        if (deletion?.deleted !== true) {
          throw Object.assign(new Error('Storage provider did not confirm deletion.'), { code: 'storage_delete_unconfirmed' });
        }
        await this.#repository.completeDeletion({
          jobId: job.jobId,
          assetId: job.assetId,
          leaseToken: job.leaseToken,
          now: this.#now().toISOString(),
        });
        results.deleted += 1;
      } catch (error) {
        const errorCode = SAFE_ERROR_CODE.test(error?.code ?? '') ? error.code : 'storage_delete_failed';
        const outcome = await this.#repository.failDeletion({
          jobId: job.jobId,
          leaseToken: job.leaseToken,
          attempts: job.attempts,
          errorCode,
          now: this.#now().toISOString(),
        }).catch(() => ({ retry: true, dead: false, stale: false }));
        if (outcome.stale) {
          results.stale += 1;
          continue;
        }
        if (outcome.dead) results.dead += 1;
        else results.retried += 1;
        this.#logger.error?.('[ero-scrap] retention deletion failed', {
          assetId: job.assetId,
          errorCode,
          attempt: job.attempts,
          dead: Boolean(outcome.dead),
        });
      }
    }

  }
}
