import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadRunnerConfig, loadMegaConfig } from './config/env.js';
import { CollectorApiClient } from './clients/collector-api-client.js';
import { ScanService } from './services/scan-service.js';
import { EromeClient } from '../../../packages/source-erome/src/index.js';
import { startScheduler } from './scheduler.js';
import { RetentionService } from './services/retention-service.js';
import { MaintenanceService } from './services/maintenance-service.js';
import { AuthorizedLocalMediaService } from './services/authorized-local-media-service.js';
import { MegaCmdStorageProvider } from '../../../packages/storage-mega/src/index.js';
import { FfprobeMediaInspector, FfmpegThumbnailGenerator } from '../../../packages/media-tools/src/index.js';
import { EromeMediaDownloader } from '../../../packages/source-erome/src/media-downloader.js';
import { EromeMediaProcessingService } from './services/erome-media-processing-service.js';
import { isCopyAuthorized } from '../../../packages/config/src/security.js';
import { sanitizeDiagnostic, describeError } from '../../../packages/config/src/diagnostics.js';

export function createRunner({ env = process.env, fetchImpl = globalThis.fetch, logger = console } = {}) {
  const config = loadRunnerConfig(env);
  const repository = new CollectorApiClient({
    endpoint: config.collectorApiUrl,
    token: config.collectorApiToken,
    accessClientId: config.accessClientId,
    accessClientSecret: config.accessClientSecret,
    timeoutMs: config.collectorApiTimeoutMs,
    fetchImpl,
  });
  const sourceClient = new EromeClient({ fetchImpl });
  const megaStorage = new MegaCmdStorageProvider({ remoteRoot: config.megaRemoteRoot, timeoutMs: config.megaCommandTimeoutMs });
  const thumbnailGenerator = new FfmpegThumbnailGenerator({ binary: config.ffmpegBinary });
  const mediaInspector = new FfprobeMediaInspector({ binary: config.ffprobeBinary });
  const mediaDownloader = new EromeMediaDownloader();
  const authorizedLocalMediaService = new AuthorizedLocalMediaService({
    storage: megaStorage,
    repository: {
      registerStoredMedia: (record) => repository.registerStoredMedia(record),
      uploadThumbnail: (assetId, bytes) => repository.uploadThumbnail(assetId, bytes),
    },
    thumbnailGenerator,
    mediaInspector,
    logger,
    unopenedDays: config.unopenedRetentionDays,
  });
  const retentionService = new RetentionService({
    repository,
    storageProviders: { mega: megaStorage },
    logger,
    limit: config.retentionBatchSize,
    maxBatches: config.retentionMaxBatches,
  });
  const maintenanceService = new MaintenanceService({ repository, logger, unopenedDays: config.unopenedRetentionDays });
  const mediaProcessingService = new EromeMediaProcessingService({
    repository,
    sourceClient,
    downloader: mediaDownloader,
    mediaInspector,
    thumbnailGenerator,
    storage: megaStorage,
    keywordFilePath: config.keywordFilePath,
    logger,
    maxJobs: 1,
    unopenedDays: config.unopenedRetentionDays,
  });
  const scanService = new ScanService({
    sourceClient,
    repository,
    keywordFilePath: config.keywordFilePath,
    maxInspections: config.maxPostInspectionsPerRun,
    logger,
  });

  return {
    config, repository, sourceClient, scanService, megaStorage,
    retentionService, maintenanceService, authorizedLocalMediaService, mediaProcessingService,
  };
}

async function main() {
  if (process.argv.includes('--mega-check')) {
    const config = loadMegaConfig();
    const storage = new MegaCmdStorageProvider({ remoteRoot: config.megaRemoteRoot, timeoutMs: config.megaCommandTimeoutMs });
    await storage.checkConnection();
    console.info('[ero-scrap] MEGAcmd connection is ready. No files were uploaded or changed.');
    return;
  }

  const runner = createRunner();

  if (process.argv.includes('--work-check')) {
    const now = new Date().toISOString();
    const [mediaDue, retentionDue] = await Promise.all([
      isCopyAuthorized() ? runner.repository.hasDueProcessVideoJobs({ now }) : false,
      runner.retentionService.hasDue(),
    ]);
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `media_due=${mediaDue}
retention_due=${retentionDue}
`, {
        encoding: 'utf8', mode: 0o600,
      });
    }
    console.info('[ero-scrap] pending work check', { mediaDue, retentionDue, copyAuthorized: isCopyAuthorized() });
    return;
  }

  if (process.argv.includes('--process-once')) {
    if (!isCopyAuthorized()) throw new Error('Video processing is blocked while COPY_AUTHORIZED is false.');
    await runner.mediaProcessingService.runBatch();
    await runner.retentionService.runOnce();
    await runner.maintenanceService.runIfDue();
    return;
  }

  if (process.argv.includes('--cleanup-check')) {
    const due = await runner.retentionService.hasDue();
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, `retention_due=${due}
`, { encoding: 'utf8', mode: 0o600 });
    }
    console.info(`[ero-scrap] retention work due: ${due}`);
    return;
  }

  if (process.argv.includes('--cleanup-once')) {
    await runner.retentionService.runOnce();
    await runner.maintenanceService.runIfDue();
    return;
  }

  if (process.argv.includes('--maintenance-once')) {
    await runner.maintenanceService.runOnce();
    return;
  }

  if (process.argv.includes('--scan-only')) {
    await runner.scanService.runOnce();
    await runner.maintenanceService.runIfDue();
    return;
  }

  const storeArgIndex = process.argv.indexOf('--store-local');
  if (storeArgIndex >= 0) {
    const [assetId, localPath] = process.argv.slice(storeArgIndex + 1, storeArgIndex + 3);
    if (!assetId || !localPath) {
      throw new Error('Usage: --store-local <asset-id-32-hex> <local-file-path>.');
    }
    const result = await runner.authorizedLocalMediaService.storeLocalVideo({ assetId, localPath });
    console.info('[ero-scrap] authorized local file stored', { assetId: result.assetId, expiresAt: result.expiresAt, thumbnailStored: result.thumbnailStored });
    return;
  }

  const mode = process.argv.includes('--watch') ? 'watch' : 'once';
  if (mode === 'once') {
    await runner.scanService.runOnce();
    if (isCopyAuthorized()) await runner.mediaProcessingService.runOnce();
    await runner.retentionService.runOnce();
    await runner.maintenanceService.runOnce();
    return;
  }

  const controller = new AbortController();
  const shutdown = () => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  await Promise.all([
    startScheduler({
      scanOnce: () => runner.scanService.runOnce(),
      intervalMs: runner.config.scanIntervalMs,
      signal: controller.signal,
    }),
    startScheduler({
      scanOnce: async () => {
        if (isCopyAuthorized()) await runner.mediaProcessingService.runOnce();
        await runner.retentionService.runOnce();
      },
      intervalMs: runner.config.retentionIntervalMs,
      logger: console,
      signal: controller.signal,
    }),
    startScheduler({
      scanOnce: () => runner.maintenanceService.runOnce(),
      intervalMs: runner.config.maintenanceIntervalMs,
      logger: console,
      signal: controller.signal,
    }),
  ]);
}

/**
 * Prints everything needed to fix a failed run, once, in the GitHub log: the
 * failing operation, HTTP status, server-side cause, a hint and a short stack.
 * Text is sanitized (no URLs, tokens or long opaque strings) because public
 * repositories have public logs.
 */
function reportFatalError(error) {
  const lines = [`[ero-scrap] runner stopped: ${sanitizeDiagnostic(error?.message ?? 'unknown error')}`];
  const facts = [];
  if (error?.operation) facts.push(`operation=${error.operation}`);
  if (error?.status) facts.push(`http_status=${error.status}`);
  if (error?.code) facts.push(`code=${sanitizeDiagnostic(error.code, 60)}`);
  if (facts.length) lines.push(`  ${facts.join(' ')}`);
  if (error?.detail) lines.push(`  detail: ${sanitizeDiagnostic(error.detail, 700)}`);
  if (error?.hint) lines.push(`  hint: ${sanitizeDiagnostic(error.hint, 240)}`);
  for (const item of describeError(error?.cause).slice(0, 2)) {
    lines.push(`  cause: ${item.name}${item.code ? `(${item.code})` : ''}: ${item.message}`);
  }
  const stack = String(error?.stack ?? '').split('\n').slice(1, 7).map((line) => sanitizeDiagnostic(line.replace(process.cwd(), '.'), 160)).filter(Boolean);
  if (stack.length) lines.push(`  stack: ${stack.join(' | ')}`);
  console.error(lines.join('\n'));
  // Shows the headline on the workflow summary page without opening the log.
  if (process.env.GITHUB_ACTIONS === 'true') console.error(`::error title=Ero-Scrap runner stopped::${lines.slice(0, 3).join(' ').replace(/[\r\n]/gu, ' ')}`);
}

const isDirectExecution = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectExecution) {
  main().catch((error) => {
    reportFatalError(error);
    process.exitCode = 1;
  });
}
