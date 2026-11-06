/** Central product rules. Keep operational limits in one place. */
export const APP_CONFIG = Object.freeze({
  stage: 3,
  stageName: 'private-catalog-and-retention',
  scan: Object.freeze({
    intervalMinutes: 20,
    maxListingPages: 2,
    maxPostsPerPage: 80,
    maxPostInspectionsPerRun: 160,
    minimumRequestDelayMs: 1_500,
    requestTimeoutMs: 15_000,
    maxHtmlBytes: 2_500_000,
  }),
  media: Object.freeze({
    maxDurationMs: 10 * 60 * 1000,
    maxFileBytes: 4 * 1024 * 1024 * 1024,
    thumbnailWidth: 320,
    thumbnailFormat: 'webp',
    thumbnailMaxBytes: 256 * 1024,
    durationMatchToleranceMs: 2_000,
    // Videos handled per workflow run, one at a time. No new video is started
    // after 20 minutes so the 35-minute step limit is never the normal exit.
    maxVideosPerRun: 4,
    startBudgetMs: 20 * 60 * 1000,
  }),
  retention: Object.freeze({
    unopenedDays: 7,
    afterFirstClickHours: 24,
    sweepIntervalMinutes: 10,
    batchSize: 2,
    // A sweep keeps draining while batches come back full (bounded), so a burst
    // of expiries is cleared in one pass instead of 2 items every 5 minutes.
    maxBatchesPerSweep: 5,
  }),
  maintenance: Object.freeze({
    intervalHours: 24,
    // Hourly cron ticks inside this UTC hour run the housekeeping pass; every
    // other tick skips it, so D1 is not touched 144 times a day for nothing.
    utcHour: 3,
    // Rows of videos that will never be copied (ignored, too long...) go after 3 days;
    // rows still in the pipeline (eligible, queued...) keep the longer window.
    discardedMetadataDays: 3,
    staleMetadataDays: 14,
    finishedJobDays: 7,
    batchSize: 500,
    // Deleting costs row writes too (rows + indexes). 3 x 500 keeps a pass far below D1's 100,000/day.
    maxBatchesPerRun: 3,
  }),
  catalog: Object.freeze({
    defaultPageSize: 24,
    maxPageSize: 48,
    maxSearchLength: 120,
  }),
});
